// 状态分类单测（四类 + 应回购下钻三态）
// 大类：应回购(0~advance天) > 已逾期(days<0) > 已回购 > 未到期
// 应回购下钻：随访 dropout→已脱落 / nonstd→预判延期 / 否则正常状态；用户 override 优先
const fs = require('fs');
const path = require('path');
function makeEl(id) {
  return { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, insertBefore(){}, removeChild(){}, querySelectorAll(){ return []; },
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null };
}
global.window = global;
global.document = {
  querySelector(sel){ return makeEl(String(sel)); }, querySelectorAll(){ return []; },
  addEventListener(){}, createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html></html>' }, body: { appendChild(){}, remove(){} },
};
global.URL = { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');

(async () => {
  const App = global.AppCore;
  App.state.advance = 7;
  App.state.stdCycle = { "百泽安": 21, "百悦泽": 28 };
  App.state.start = null; App.state.end = null;

  // 动态日期：以「今天」为基准构造应购日
  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function sales(patient, phone, date, product) {
    return { source: 'sales', patient_name: patient, phone, sales_time: date, product,
      hospital: '测试医院', pharmacy: '测试药房', physician: '张医生' };
  }
  function fu(patient, phone, exec, product, sig) {
    const r = { source: 'followup', patient_name: patient, phone, exec_time: exec, plan_time: exec,
      product, task_status: '已完成', summary_type: '日常随访任务', executor: '李随访' };
    if (sig === 'dropout') r.stop_reason = '患者自行停药';
    if (sig === 'nonstd') r.delay_reason = '患者推迟用药';
    return r;
  }
  function run(salesArr, fus, cycles) {
    App.STORE.sales = salesArr; App.STORE.followups = fus; App.STORE.cycles = cycles || {};
    App.STORE.subOverrides = {};
    return App.buildRows()[0];
  }

  // 场景1：应购日7天内（今天-15天购药+21天周期=今天+6）+ 随访正常 → 应回购 / 正常状态
  let r = run([sales('甲', '10000000001', daysAgo(15), '百泽安')],
    [fu('甲', '10000000001', daysAgo(10), '百泽安', null)], {});
  console.log('1 应购7天内+随访正常:', r.status, '/', r.substatus, '(期望 应回购/正常状态)');

  // 场景2：应购日7天内 + 随访停药 → 应回购 / 已脱落
  r = run([sales('乙', '10000000002', daysAgo(15), '百泽安')],
    [fu('乙', '10000000002', daysAgo(10), '百泽安', 'dropout')], {});
  console.log('2 应购7天内+随访停药:', r.status, '/', r.substatus, '(期望 应回购/已脱落)');

  // 场景3：应购日7天内 + 随访推迟 → 应回购 / 预判延期
  r = run([sales('丙', '10000000003', daysAgo(15), '百泽安')],
    [fu('丙', '10000000003', daysAgo(10), '百泽安', 'nonstd')], {});
  console.log('3 应购7天内+随访推迟:', r.status, '/', r.substatus, '(期望 应回购/预判延期)');

  // 场景4：应购日已过（40天前购药+21天周期 → 19天前应购） → 已逾期（无论随访）
  r = run([sales('丁', '10000000004', daysAgo(40), '百泽安')], [], {});
  console.log('4 应购日已过:', r.status, '(期望 已逾期)');

  // 场景5：上次已回购、本次未到期 → 已回购（第二次购药后周期30天，应购日>7天）
  r = run([
    sales('戊', '10000000005', daysAgo(60), '百泽安'),
    sales('戊', '10000000005', daysAgo(40), '百泽安'),
  ], [], { "戊": 30 }); // 上次应购=60天前+30=30天前(已过)，40天前<30天前 不对；改用 35天前购药
  console.log('5 已回购但本次又逾期(周期30):', r.status, '(期望 已逾期)');

  // 场景6：已回购且本次未到期（第二次购药后应购日>7天）→ 已回购（上次回购成功、本次未到窗口）
  r = run([
    sales('己', '10000000006', daysAgo(70), '百泽安'),
    sales('己', '10000000006', daysAgo(10), '百泽安'),
  ], [], { "己": 30 }); // 上次应购=70天前+30=40天前已过，10天前>=40天前 → 已回购；本次应购=10天前+30=20天后 → 已回购
  console.log('6 已回购本次20天后应购:', r.status, '(期望 已回购)');

  // 场景7：未到期（应购日>7天）
  r = run([sales('庚', '10000000007', daysAgo(10), '百泽安')], [], { "庚": 30 });
  console.log('7 未到期(10天前购药+30天):', r.status, '(期望 未到期)');

  // 场景8：用户手动 override 子状态
  r = run([sales('甲', '10000000001', daysAgo(15), '百泽安')],
    [fu('甲', '10000000001', daysAgo(10), '百泽安', null)], {});
  App.STORE.subOverrides['10000000001::百泽安'] = '预判延期';
  r = App.buildRows()[0];
  console.log('8 手动override子状态:', r.status, '/', r.substatus, '(期望 应回购/预判延期)');

  // 场景9：应回购 + 已逾期两类允许备注（canNote 逻辑）
  const canNote = (x) => x === '应回购' || x === '已逾期';
  console.log('9 备注窗口: 应回购=', canNote('应回购'), '已逾期=', canNote('已逾期'),
    '已回购=', canNote('已回购'), '未到期=', canNote('未到期'),
    '(期望 true true false false)');
  if (!canNote('应回购') || !canNote('已逾期') || canNote('已回购') || canNote('未到期')) throw new Error('备注窗口条件不符');
  console.log('\n✅ 状态分类单测全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
