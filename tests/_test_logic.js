// 状态分类单测（周维度状态机）
// 时间基准：参考日期 refDate（默认今天）所在自然周（周一~周日）为「本周」，
//           上周/下周 前后推 7 天；weekSel ∈ {last, this, next} 单选。
// 状态判定（购药事实优先）：
//   当周 [周首, 周末] 内有购药记录 → 已回购（最优先）
//   应购日 < 周首 → 已逾期；应购日 ∈ 所选周 → 应回购；应购日 > 周末 → 未到期
// 已回购行：应购药日期列显示「预判应购日」= 倒数第二次购药日 + 周期 + 提前/延后标注
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
  App.state.stdCycle = { "百泽安": 21, "百悦泽": 28 };
  // 固定参考日期（2026-08-28 周五）→ 本周 = 08-24(周一) ~ 08-30(周日)
  //  上周 = 08-17 ~ 08-23；下周 = 08-31 ~ 09-06
  App.state.refDate = '2026-08-28';
  App.state.weekSel = 'this';

  function sales(patient, phone, date, product) {
    return { source: 'sales', patient_name: patient, phone, sales_time: date, product: product || '百泽安',
      hospital: '测试医院', pharmacy: '测试药房', physician: '张医生' };
  }
  function fu(patient, phone, exec, product, sig) {
    const r = { source: 'followup', patient_name: patient, phone, exec_time: exec, plan_time: exec,
      product: product || '百泽安', task_status: '已完成', summary_type: '日常随访任务', executor: '李随访' };
    if (sig === 'dropout') r.stop_reason = '患者自行停药';
    if (sig === 'nonstd') r.delay_reason = '患者推迟用药';
    return r;
  }
  function run(salesArr, fus, cycles) {
    App.STORE.sales = salesArr; App.STORE.followups = fus || []; App.STORE.cycles = cycles || {};
    App.STORE.subOverrides = {};
    return App.buildRows()[0];
  }

  console.log('===== 应回购（应购日落在所选周内）/ 已逾期 / 下钻 =====');
  // 场景1：应购 08-24（本周一，∈本周）→ 应回购 / 随访正常 → 正常状态
  let r = run([sales('甲', '10000000001', '2026-08-03', '百泽安')],
    [fu('甲', '10000000001', '2026-08-10', '百泽安', null)], {});
  console.log('1 应购本周一:', r.status, '/', r.substatus, '| 应购日', r.due_date);
  assert(r.status === '应回购' && r.substatus === '正常状态', '场景1 应购日∈本周→应回购/正常状态');

  // 场景2：应购日∈本周 + 随访停药 → 应回购 / 已脱落
  r = run([sales('乙', '10000000002', '2026-08-03', '百泽安')],
    [fu('乙', '10000000002', '2026-08-10', '百泽安', 'dropout')], {});
  assert(r.status === '应回购' && r.substatus === '已脱落', '场景2 应购日∈本周+停药→已脱落');

  // 场景3：应购日∈本周 + 随访推迟 → 应回购 / 预判延期
  r = run([sales('丙', '10000000003', '2026-08-03', '百泽安')],
    [fu('丙', '10000000003', '2026-08-10', '百泽安', 'nonstd')], {});
  assert(r.status === '应回购' && r.substatus === '预判延期', '场景3 应购日∈本周+推迟→预判延期');

  // 场景4：应购日 < 周首（本周无购药）→ 已逾期
  r = run([sales('丁', '10000000004', '2026-07-20', '百泽安')], [], {});
  console.log('4 应购 08-10(<本周一):', r.status);
  assert(r.status === '已逾期', '场景4 应购日<周首→已逾期');

  // 场景5：两笔购药但本周无购药、应购日<周首 → 已逾期（不构成已回购）
  r = run([
    sales('戊', '10000000005', '2026-06-01', '百泽安'),
    sales('戊', '10000000005', '2026-07-20', '百泽安'),
  ], [], { "戊": 21 });
  assert(r.status === '已逾期', '场景5 本周无购药+应购日<周首→已逾期');

  console.log('\n===== 已回购（当周内有购药记录，购药事实最优先） =====');
  // 场景6：两笔记录，08-25 购药（本周）→ 已回购；预判应购=08-01+21=08-22，偏移=+3（延期3天）
  r = run([
    sales('己', '10000000006', '2026-08-01', '百泽安'),
    sales('己', '10000000006', '2026-08-25', '百泽安'),
  ], [], {});
  console.log('6 本周购药:', r.status, '| 预判应购=', r.due_date, '| 偏移=', r.due_offset);
  assert(r.status === '已回购', '场景6a 当周购药→已回购');
  assert(r.due_date === '2026-08-22', '场景6b 应购药日期=预判应购日(上次购药+周期)');
  assert(r.due_offset === 3, '场景6c 偏移=+3（延期3天）');

  // 场景7：提前购药 → 偏移为负（08-05+28=09-02 预判；08-26 购药 → 提前7天）
  r = run([
    sales('庚', '10000000007', '2026-08-05', '百悦泽'),
    sales('庚', '10000000007', '2026-08-26', '百悦泽'),
  ], [], {});
  assert(r.status === '已回购', '场景7a 当周购药→已回购');
  assert(r.due_offset === -7, '场景7b 偏移=' + r.due_offset + '（期望 -7=提前7天）');

  // 场景8：单条购药记录、日期在本周 → 已回购，应购列空（无预判基准）
  r = run([sales('辛', '10000000008', '2026-08-25', '百泽安')], [], { "辛": 30 });
  assert(r.status === '已回购', '场景8a 单条记录+当周购药→已回购');
  assert(r.due_date === '' && r.due_offset == null, '场景8b 无预判基准→应购列空');

  // 场景13：应购日>周末（本会未到期），但当周购药 → 已回购（购药事实优先）
  r = run([
    sales('癸', '10000000013', '2026-08-01', '百泽安'),
    sales('癸', '10000000013', '2026-08-26', '百泽安'),
  ], [], {});
  assert(r.status === '已回购', '场景13 应购日>周末但当周购药→已回购（购药事实优先）');

  console.log('\n===== 未到期（应购日>周末） =====');
  // 场景9：本周无购药、应购 09-02（>周末）→ 未到期
  r = run([sales('壬', '10000000009', '2026-08-03', '百泽安')], [], { "壬": 30 });
  console.log('9 应购 09-02(>本周日):', r.status);
  assert(r.status === '未到期', '场景9 应购日>周末→未到期');

  console.log('\n===== 周切换（同一数据不同周 → 状态重算） =====');
  // 场景10：应购 08-23（上周日）：上周→应回购；本周→已逾期
  r = run([sales('子', '10000000010', '2026-08-02', '百泽安')], [], { "子": 21 });
  App.state.weekSel = 'last';
  r = App.buildRows()[0];
  console.log('10 应购08-23 | 上周视角:', r.status);
  assert(r.status === '应回购', '场景10a 应购日∈上周→上周应回购');
  App.state.weekSel = 'this';
  r = App.buildRows()[0];
  assert(r.status === '已逾期', '场景10b 同一数据切本周→应购日<周首→已逾期');

  // 场景11：应购 09-02：下周→应回购；本周→未到期
  r = run([sales('癸', '10000000011', '2026-08-03', '百泽安')], [], { "癸": 30 }); // 应购 09-02
  App.state.weekSel = 'next';
  r = App.buildRows()[0];
  console.log('11 应购09-02 | 下周视角:', r.status);
  assert(r.status === '应回购', '场景11a 应购日∈下周→下周应回购');
  App.state.weekSel = 'this';
  r = App.buildRows()[0];
  assert(r.status === '未到期', '场景11b 同一数据切本周→未到期');

  // 场景12：08-19 购药（上周）：上周→已回购；本周→未到期
  App.state.weekSel = 'last';
  r = run([sales('丑', '10000000012', '2026-08-19', '百泽安')], [], { "丑": 21 });
  assert(r.status === '已回购', '场景12a 上周购药→上周已回购');
  App.state.weekSel = 'this';
  r = App.buildRows()[0];
  assert(r.status === '未到期', '场景12b 同一数据切本周→本周无购药+应购09-09→未到期');

  console.log('\n===== 参考日期（回看历史周） =====');
  // 场景14：refDate=2026-08-10(周一) → 本周=08-10~08-16；应购 08-10（本周一）→ 应回购
  //         同一数据 refDate=空(真实今天) → 08-10 < 本周一(08-24) → 已逾期
  App.state.weekSel = 'this'; App.state.refDate = '2026-08-10';
  r = run([sales('寅', '10000000014', '2026-07-20', '百泽安')], [], { "寅": 21 });
  console.log('14 refDate=08-10(周一):', r.status, '| 应购日', r.due_date);
  assert(r.status === '应回购', '场景14a 参考日期所在周含应购日→应回购');
  App.state.refDate = '';
  r = App.buildRows()[0];
  assert(r.status === '已逾期', '场景14b 参考日期恢复今天→应购日<本周一→已逾期');

  console.log('\n===== 用户手动 override 子状态 =====');
  App.state.refDate = '2026-08-28';
  r = run([sales('甲', '10000000001', '2026-08-03', '百泽安')],
    [fu('甲', '10000000001', '2026-08-10', '百泽安', null)], {});
  App.STORE.subOverrides['10000000001::百泽安'] = '预判延期';
  r = App.buildRows()[0];
  assert(r.status === '应回购' && r.substatus === '预判延期', 'override子状态');

  // 备注窗口：仅 应回购/已逾期 可填
  const canNote = (x) => x === '应回购' || x === '已逾期';
  assert(canNote('应回购') && canNote('已逾期') && !canNote('已回购') && !canNote('未到期'),
    '备注窗口条件');

  console.log('\n===== 下钻扩展到所有状态 =====');
  // 已逾期 + 停药信号 → 下钻「已脱落」
  r = run([sales('卯', '10000000015', '2026-07-01', '百泽安')],
    [fu('卯', '10000000015', '2026-07-10', '百泽安', 'dropout')], {});
  assert(r.status === '已逾期' && r.substatus === '已脱落', `已逾期+停药 → 已脱落（实际 ${r.status}/${r.substatus}）`);
  // 未到期 + 推迟信号 → 下钻「预判延期」
  r = run([sales('辰', '10000000016', '2026-08-03', '百泽安')],
    [fu('辰', '10000000016', '2026-08-06', '百泽安', 'nonstd')], { "辰": 30 });
  assert(r.status === '未到期' && r.substatus === '预判延期', `未到期+推迟 → 预判延期（实际 ${r.status}/${r.substatus}）`);
  // 已回购 + 正常信号 → 下钻「正常状态」
  r = run([sales('巳', '10000000017', '2026-08-25', '百泽安')],
    [fu('巳', '10000000017', '2026-08-25', '百泽安', null)], {});
  assert(r.status === '已回购' && r.substatus === '正常状态', `已回购+正常 → 正常状态（实际 ${r.status}/${r.substatus}）`);
  // 无随访（unknown）→ 默认「正常状态」
  r = run([sales('午', '10000000018', '2026-08-25', '百泽安')], [], {});
  assert(r.status === '已回购' && r.substatus === '正常状态', `无随访 → 默认正常状态（实际 ${r.status}/${r.substatus}）`);

  console.log('\n✅ 状态分类单测全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
