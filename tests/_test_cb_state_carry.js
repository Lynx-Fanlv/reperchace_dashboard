// 回传表「随访状态快照」回归测试
//
// 背景（用户报障 2026-09-30）：「导出的随访回传表，传回网页后并没有自动识别到患者状态和随访跟进」，
// 选定症状为「备注/原因没回到列表」。
//
// 根因之一（实测 tests/_probe_reason_loss.js）：回传记录原本只带「随访小结」一列文本，
// 随访信号字段（用药状态 / 是否按时购药 / 易脱落 / 停药原因 / 推迟原因）一个都不带。于是
//   只上传「销售明细 + 回传表」时（不再传原始随访表），回传记录成为唯一随访来源：
//     · 随访类型 → 「跟进回传」、随访时间 → 导出当天（患者随访信息被导出的身份顶掉）
//     · 随访信号 → 空、自动判定的未购药原因 → 丢（变「未标」）
// 修法：回传表追加 9 列随访状态快照（CB_FU_STATE_COLS），并把「原随访类型/时间」单列带走
//       （回传记录自身的 服务摘要/执行时间 是识别标记与导出时间，不能当随访内容）。
//
// 本测试直接对比「真实随访」与「只带该快照的回传记录」渲染出的行字段是否一致。
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

// 让患者落入「已逾期」，备注/原因都算得出来
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
const BASE = { fu_type: row.fu_type, fu_time: row.fu_time, fu_signal: row.fu_signal,
  fu_signal_kind: row.fu_signal_kind, reason: row.reason };

console.log('\n=== [2] 只上传「销售 + 回传表（带状态快照）」→ 应与真实随访完全一致 ===');
// 这就是 doExportCallback 现在导出的那一行的 fu 侧内容
const CB_FULL = {
  product: FAM, patient_name: NAME, phone: PHONE,
  summary_type: '跟进回传', task_status: '已完成',
  exec_time: '2026-10-16',                    // 导出当天（不得当随访时间）
  orig_fu_type: '常规随访', orig_fu_time: '2026-09-01',
  executor: '刘倩', follow_note: '已电话随访，患者接听',
  callback_note: '上一轮备注', reason_label: '',
  usage_status: '已停药', purchased_on_time: '已停药', is_dropout: '是',
  stop_reason: '经济困难，负担不起', delay_reason: null, dropout_reason: null, still_using: null,
};
ST.sales = [SALE('2026-08-01')];
ST.followups = [CB_FULL];
row = App.buildRows()[0];
eq('★ 随访类型还原（不是「跟进回传」）', row.fu_type, BASE.fu_type);
eq('★ 随访时间还原（不是导出当天）', row.fu_time, BASE.fu_time);
eq('★ 随访信号还原（不是空）', row.fu_signal, BASE.fu_signal);
eq('★ 随访信号类别还原', row.fu_signal_kind, BASE.fu_signal_kind);
eq('★ 自动未购药原因还原（不是未标）', row.reason, BASE.reason);
eq('随访人还原', row.executor, '刘倩');

console.log('\n=== [3] 旧版回传表（无快照列）→ 不得冒充随访内容 ===');
const CB_OLD = {
  product: FAM, patient_name: NAME, phone: PHONE,
  summary_type: '跟进回传', task_status: '已完成', exec_time: '2026-10-16',
  executor: '', follow_note: '已电话随访，患者接听', callback_note: '上一轮备注',
  usage_status: null, purchased_on_time: null, is_dropout: null,
  stop_reason: null, delay_reason: null, dropout_reason: null, still_using: null,
};
ST.sales = [SALE('2026-08-01')];
ST.followups = [CB_OLD];
row = App.buildRows()[0];
eq('随访类型不再显示「跟进回传」', row.fu_type, '');
eq('随访时间不再显示导出当天', row.fu_time, '');
// 旧表的固有限制（也正是新版追加状态快照要解决的问题）：
// 只剩「随访小结」一列文本可推，本用例的小结是通用文案（无停药/经济等关键词）→ 信号与原因都推不出来
eq('随访信号推不出（小结无关键词）', row.fu_signal_kind, 'unknown');
eq('★ 自动未购药原因丢失（旧表只能到这一步）', row.reason, '');
ok('★ 对照：新版快照能把同一个原因还原', BASE.reason === 'dropout_econ');

console.log('\n=== [4] 真实随访与回传表同时上传 → 仍以真实随访为准 ===');
ST.sales = [SALE('2026-08-01')];
ST.followups = [REAL_FU, Object.assign({}, CB_FULL, { exec_time: '2026-11-01' })]; // 回传更晚，也不能抢
row = App.buildRows()[0];
eq('随访类型仍为真实随访', row.fu_type, '常规随访');
eq('随访时间仍为真实随访', row.fu_time, '2026-09-01');
eq('随访信号仍为真实随访', row.fu_signal, '用药状态:已停药');

console.log('\n=== [5] 人工点选的未购药原因优先于自动判定 ===');
ST.notes = {}; ST.reasonOverrides = {};
ST.reasonOverrides[App.buildRows()[0]._key + '::' + FAM] = 'delay';
ST.followups = [CB_FULL];
row = App.buildRows()[0];
eq('人工点选压过自动判定', row.reason, 'delay');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
