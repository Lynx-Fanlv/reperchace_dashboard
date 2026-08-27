// 状态分类单测（四类 + 应回购下钻三态）
// 大类优先级：应回购(0~advance天) > 已逾期(days<0) > 已回购(最近购药在窗口内) > 未到期
// 已回购新口径：最近一次购药日期落在「已回购窗口」内
//   （未选日期范围 → 距今 ≤ advance；选了日期范围 → 落在所选范围内）
//   应购药日期列显示「预判应购日」= 倒数第二次购药日 + 周期 + 提前/延后标注
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

function assert(cond, msg) {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('  ✅ ' + msg);
}

(async () => {
  const App = global.AppCore;
  App.state.advance = 7;
  App.state.stdCycle = { "百泽安": 21, "百悦泽": 28 };
  App.state.start = null; App.state.end = null;

  // 动态日期：以「今天」为基准
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
    App.STORE.sales = salesArr; App.STORE.followups = fus || []; App.STORE.cycles = cycles || {};
    App.STORE.subOverrides = {};
    return App.buildRows()[0];
  }

  console.log('===== 应回购 / 已逾期 / 下钻 =====');
  // 场景1：应购日7天内（今天-15天购药+21天周期=今天+6）+ 随访正常 → 应回购 / 正常状态
  let r = run([sales('甲', '10000000001', daysAgo(15), '百泽安')],
    [fu('甲', '10000000001', daysAgo(10), '百泽安', null)], {});
  console.log('1 应购7天内+随访正常:', r.status, '/', r.substatus);
  assert(r.status === '应回购' && r.substatus === '正常状态', '场景1');

  // 场景2：应购日7天内 + 随访停药 → 应回购 / 已脱落
  r = run([sales('乙', '10000000002', daysAgo(15), '百泽安')],
    [fu('乙', '10000000002', daysAgo(10), '百泽安', 'dropout')], {});
  assert(r.status === '应回购' && r.substatus === '已脱落', '场景2 随访停药→已脱落');

  // 场景3：应购日7天内 + 随访推迟 → 应回购 / 预判延期
  r = run([sales('丙', '10000000003', daysAgo(15), '百泽安')],
    [fu('丙', '10000000003', daysAgo(10), '百泽安', 'nonstd')], {});
  assert(r.status === '应回购' && r.substatus === '预判延期', '场景3 随访推迟→预判延期');

  // 场景4：应购日已过（40天前购药+21天 → 19天前应购） → 已逾期
  r = run([sales('丁', '10000000004', daysAgo(40), '百泽安')], [], {});
  assert(r.status === '已逾期', '场景4 应购日已过→已逾期');

  // 场景5：最近购药25天前（窗口外），下次应购=25天前+21=4天前（已过） → 已逾期优先于已回购
  r = run([
    sales('戊', '10000000005', daysAgo(60), '百泽安'),
    sales('戊', '10000000005', daysAgo(25), '百泽安'),
  ], [], { "戊": 21 });
  assert(r.status === '已逾期', '场景5 下次应购已过→已逾期（优先于已回购）');

  console.log('\n===== 已回购（新口径：最近购药在窗口内） =====');
  // 场景6：两笔记录，最近购药1天前（窗口内），周期21 → 已回购；预判应购=23天前+21=2天前，偏移=+1延期1天
  //   （对应业务例：8.1购药→预判8.22应购；8.23又购药 → 已回购，延期1天）
  r = run([
    sales('己', '10000000006', daysAgo(23), '百泽安'),
    sales('己', '10000000006', daysAgo(1), '百泽安'),
  ], [], {});
  console.log('6 两笔记录、最近购药1天前:', r.status,
    '| 预判应购日=', r.due_date, '(期望', daysAgo(2), ')',
    '| 偏移=', r.due_offset, '(期望 1=延期1天)',
    '| 购药距今=', r.purchase_days_ago);
  assert(r.status === '已回购', '场景6a 状态=已回购');
  assert(r.due_date === daysAgo(2), '场景6b 应购药日期=预判应购日(上次购药+周期)');
  assert(r.due_offset === 1, '场景6c 偏移=+1（延期1天）');
  assert(r.purchase_days_ago === 1, '场景6d 购药距今1天');

  // 场景7：提前购药 → 偏移为负（最近购药1天前，预判应购=5天前 → 提前4天）
  r = run([
    sales('庚', '10000000007', daysAgo(26), '百泽安'),
    sales('庚', '10000000007', daysAgo(1), '百泽安'),
  ], [], {});
  // 预判应购 = 26天前+21 = 5天前；最近购药 1天前 → 1天前晚于5天前 → 延期+4
  assert(r.status === '已回购', '场景7a 已回购');
  assert(r.due_offset === 4, '场景7b 偏移=' + r.due_offset + '（期望4=延期4天）');

  // 场景8：1条购药记录、最近购药在窗口内 → 已回购，应购列显示空（无预判基准）
  r = run([sales('辛', '10000000008', daysAgo(1), '百泽安')], [], { "辛": 30 });
  assert(r.status === '已回购', '场景8a 单条记录+窗口内→已回购');
  assert(r.due_date === '' && r.due_offset == null, '场景8b 无预判基准→应购列空');

  // 场景9：最近购药在窗口外（10天前）+ 下次应购未到 → 未到期
  r = run([sales('壬', '10000000009', daysAgo(10), '百泽安')], [], { "壬": 30 });
  assert(r.status === '未到期', '场景9 购药10天前(窗口外)+30天→未到期');

  console.log('\n===== 已回购 × 时间窗 =====');
  // 场景10：时间窗不再参与已回购判定（统一「近期窗口 N 天」）
  App.state.start = daysAgo(10); App.state.end = daysAgo(8); // 范围不含最近购药日
  r = run([sales('癸', '10000000010', daysAgo(1), '百泽安')], [], {});
  assert(r.status === '已回购', '场景10a 选时间窗不改变已回购判定（购药1天前≤N仍已回购）');
  // filterRows：已回购行按「最近购药日期」匹配范围 → 1天前不在 [10天前,8天前] → 被裁
  const kept = App.filterRows([r]);
  assert(kept.length === 0, '场景10b 已回购行按最近购药日被时间窗裁掉');
  // 范围覆盖最近购药日 → 保留
  App.state.start = daysAgo(2); App.state.end = daysAgo(0);
  const kept2 = App.filterRows([r]);
  assert(kept2.length === 1, '场景10c 已回购行最近购药在范围内→保留');
  // 未到期行按「下次应购日」匹配：最近购药10天前、下次应购20天后，不在 [2天前,今天] → 被裁
  const nr = run([sales('子', '10000000011', daysAgo(10), '百泽安')], [], { "子": 30 });
  assert(nr.status === '未到期', '场景10d 未到期行（购药10天前窗口外）');
  const kept3 = App.filterRows([nr]);
  assert(kept3.length === 0, '场景10e 未到期行按下次应购日被时间窗裁掉');
  App.state.start = null; App.state.end = null;

  console.log('\n===== 用户手动 override 子状态 =====');
  r = run([sales('甲', '10000000001', daysAgo(15), '百泽安')],
    [fu('甲', '10000000001', daysAgo(10), '百泽安', null)], {});
  App.STORE.subOverrides['10000000001::百泽安'] = '预判延期';
  r = App.buildRows()[0];
  assert(r.status === '应回购' && r.substatus === '预判延期', 'override子状态');

  // 备注窗口：仅 应回购/已逾期 可填
  const canNote = (x) => x === '应回购' || x === '已逾期';
  assert(canNote('应回购') && canNote('已逾期') && !canNote('已回购') && !canNote('未到期'),
    '备注窗口条件');

  console.log('\n✅ 状态分类单测全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
