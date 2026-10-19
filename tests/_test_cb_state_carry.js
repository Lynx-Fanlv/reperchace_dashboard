// 回传表「与随访表同规则」回归测试（用户 2026-10-19 定）
//
// 口径：**点「导出回传表」＝记录导出当天的一次随访**。所以回传表不是另一类数据，
// 回传后它就是一条普通随访记录，与随访表走同一套匹配与判定 —— 不特殊加权、也不特殊降权。
// 回传表只装它当场真正知道的东西（身份/日期/结论/备注），**不复制**随访模板的状态问答列；
// 缺失的「随访信号」由它自带的「未购药原因」分类在 M.followupSignal 里归一化反推。
//
// 本测试锁定五件事：
//   [1] 基准：真实随访 → 行字段
//   [2] 只上传「销售 + 回传表」→ 原因/信号与真实随访等价；随访类型/时间＝这条记录自己的
//   [3] 回传表没写原因（未标）→ 信号推不出，如实保留（不伪造）
//   [3b] 历史 17 列回传表（带状态列）仍按普通随访字段读取（向后兼容）
//   [4] 同一套日期规则：新随访比回传表晚 → 新随访胜出；回传表比真实随访晚 → 回传表胜出
//       （★ 这一条锁住「回传表不会把上一轮结论钉死在页面上」）
//   [5] 人工点选的未购药原因优先于记录自身判定
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------- 最小 DOM stub（app.js 加载期会绑一堆 onclick） ----------
function makeEl(id) {
  return { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, insertBefore(){},
    removeChild(){}, querySelectorAll(){ return []; }, click(){}, remove(){},
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null };
}
global.window = global;
global.document = {
  querySelector(sel){ return makeEl(String(sel)); }, querySelectorAll(){ return []; },
  addEventListener(){}, createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html></html>' }, body: { appendChild(){}, remove(){}, removeChild(){} },
};
global.URL = { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(ROOT, f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const App = global.AppCore;
const S = App.state, ST = App.STORE;

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const c = JSON.stringify(got) === JSON.stringify(want);
  c ? pass++ : fail++;
  console.log((c ? '  ✅ ' : '  ❌ ') + n + ' → ' + JSON.stringify(got) + (c ? '' : '，期望 ' + JSON.stringify(want)));
};
const ok = (n, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  ✅ ' : '  ❌ ') + n + (extra ? ' → ' + extra : '')); };

const NAME = '甲患者', PHONE = '13900000001', FAM = '百泽安';
const SALE = (d) => ({ sales_time: d, product: FAM, patient_name: NAME, phone: PHONE, qty: '1',
  pharmacy: '南充药房', hospital: '川北医学院附属医院', physician: '刘洋', member_id: 'M1' });

S.refDate = '2026-10-20'; S.weekSel = 'this';
S.stdCycle = { 百泽安: 21 };

// 真实随访：原因写在信号列（停药的原因），随访小结是通用文案
const REAL_FU = {
  product: FAM, patient_name: NAME, phone: PHONE,
  summary_type: '常规随访', task_status: '已完成',
  exec_time: '2026-09-01 09:00:00', plan_time: '2026-09-01 09:00:00', executor: '刘倩',
  follow_note: '已电话随访，患者接听',
  usage_status: '已停药', purchased_on_time: '已停药', is_dropout: '是',
  stop_reason: '经济困难，负担不起', delay_reason: null, dropout_reason: null,
  still_using: null, near_usage: null, dosage: null,
};

console.log('=== [1] 基准：真实随访 → 行的随访字段 ===');
ST.sales = [SALE('2026-08-01')];
ST.followups = [REAL_FU];
let row = App.buildRows()[0];
ok('取到患者行', !!row);
eq('随访类型', row.fu_type, '常规随访');
eq('随访时间', row.fu_time, '2026-09-01');
eq('随访信号类别', row.fu_signal_kind, 'dropout');
eq('随访信号文字', row.fu_signal, '用药状态:已停药');
eq('自动判定未购药原因', row.reason, 'dropout_econ');
const BASE = { fu_signal: row.fu_signal, fu_signal_kind: row.fu_signal_kind, reason: row.reason };

console.log('\n=== [2] 只上传「销售 + 回传表」→ 原因/信号与真实随访等价 ===');
// 这就是 doExportCallback 现在导出的那一行的 fu 侧内容：
// 只有身份 / 日期 / 当次结论（未购药原因）/ 备注，没有任何随访模板状态列
const CB_NEW = {
  product: FAM, patient_name: NAME, phone: PHONE,
  summary_type: '跟进回传', task_status: '已完成',
  exec_time: '2026-10-16',                    // 导出当天＝这条随访记录的时间
  executor: '刘倩', follow_note: '已电话随访，患者接听',
  callback_note: '上一轮备注',
  reason_label: '脱落·经济',                   // 该行当时的结论（自动判定/人工点选都长这样）
  usage_status: null, purchased_on_time: null, is_dropout: null,
  stop_reason: null, delay_reason: null, dropout_reason: null, still_using: null,
};
ST.sales = [SALE('2026-08-01')];
ST.followups = [CB_NEW];
row = App.buildRows()[0];
eq('随访类型＝这条记录自己的（跟进回传）', row.fu_type, '跟进回传');
eq('随访时间＝导出当天', row.fu_time, '2026-10-16');
eq('★ 未购药原因还原（不是未标）', row.reason, BASE.reason);
eq('★ 随访信号类别由「未购药原因」归一化还原', row.fu_signal_kind, BASE.fu_signal_kind);
eq('★ 信号文字取自记录自身分类（不再复制用药状态列）', row.fu_signal, '未购药原因:脱落·经济');
eq('随访人还原', row.executor, '刘倩');

console.log('\n=== [3] 回传表没写原因（未标）→ 信号推不出，如实保留 ===');
const CB_NOLABEL = Object.assign({}, CB_NEW, { reason_label: '' });
ST.sales = [SALE('2026-08-01')];
ST.followups = [CB_NOLABEL];
row = App.buildRows()[0];
eq('仍是这条记录（不是空）', row.fu_type, '跟进回传');
eq('未购药原因为空（导出时就是未标）', row.reason, '');
eq('随访信号也推不出 → unknown', row.fu_signal_kind, 'unknown');
ok('★ 对照：只要写了原因就能还原', BASE.reason === 'dropout_econ');

console.log('\n=== [3b] 历史 17 列回传表（带状态列）仍按普通随访字段读取 ===');
const CB_17 = Object.assign({}, CB_NEW, {
  usage_status: '已停药', purchased_on_time: '已停药', is_dropout: '是',
  stop_reason: '经济困难，负担不起', reason_label: '',
});
ST.sales = [SALE('2026-08-01')];
ST.followups = [CB_17];
row = App.buildRows()[0];
eq('旧 17 列格式-原因仍可推出', row.reason, BASE.reason);
eq('旧 17 列格式-信号仍为 dropout', row.fu_signal_kind, 'dropout');

console.log('\n=== [4] 同一套日期规则：谁更近谁说话 ===');
// 应购药日 10-22（10-01 购药 + 21 天），两条记录都早于应购日 → 取最近的一条
const dueBase = [SALE('2026-10-01')];
const REAL_NEW = Object.assign({}, REAL_FU, {
  exec_time: '2026-10-17 09:00:00', plan_time: '2026-10-17 09:00:00',
  usage_status: '正在用药', purchased_on_time: '否', is_dropout: '否',
  stop_reason: null, delay_reason: '医生调整了给药方案，要求推迟两周',
});
// 4a 新随访（10-17）晚于回传表（10-12）→ 新随访胜出
ST.sales = dueBase;
ST.followups = [Object.assign({}, CB_NEW, { exec_time: '2026-10-12' }), REAL_NEW];
row = App.buildRows()[0];
eq('★ 新随访更近 → 用新随访（类型）', row.fu_type, '常规随访');
eq('★ 新随访更近 → 用新随访（时间）', row.fu_time, '2026-10-17');
eq('★ 原因跟随新随访（推迟），不被旧回传表钉成脱落', row.reason, 'delay');

// 4b 回传表（10-18）晚于真实随访（09-01）→ 回传表胜出（它就是更近的那条随访）
ST.sales = dueBase;
ST.followups = [REAL_FU, Object.assign({}, CB_NEW, { exec_time: '2026-10-18' })];
row = App.buildRows()[0];
eq('回传表更近 → 用回传表（类型）', row.fu_type, '跟进回传');
eq('回传表更近 → 用回传表（时间）', row.fu_time, '2026-10-18');
eq('原因跟随回传表记录', row.reason, 'dropout_econ');

console.log('\n=== [5] 人工点选的未购药原因优先于记录自身判定 ===');
ST.sales = [SALE('2026-08-01')];
ST.followups = [CB_NEW];
ST.notes = {}; ST.reasonOverrides = {};
row = App.buildRows()[0];
ST.reasonOverrides[row._key + '::' + FAM] = 'delay';
row = App.buildRows()[0];
eq('人工点选压过自动判定', row.reason, 'delay');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
