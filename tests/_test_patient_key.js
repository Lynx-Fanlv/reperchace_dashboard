// 验证「患者唯一键 = 姓名 + 电话」
//
// 背景：原口径是 `电话优先，无电话退回只按姓名`（phoneDigits(phone) || name），有两个方向的误判：
//   · 只按电话 → 同一号码被不同姓名共用（家人共用号码 / 前台代留）时，两个不同患者被并成一个；
//   · 只按姓名 → 重名（同名不同电话）时，两个不同患者被并成一个。
// 本套件验证新口径（Pipeline.patientKey = 姓名\u0000电话）在两条路径上都正确区分，
// 并验证「随访按姓名回退」不会把重名患者的随访串到一起。
//
// 用法：node tests/_test_patient_key.js
const fs = require('fs');
const path = require('path');

// ---------- 最小 DOM stub ----------
function makeEl(id) {
  return { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, insertBefore(){}, removeChild(){}, querySelectorAll(){ return []; },
    click(){}, remove(){},
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null };
}
global.window = global;
global.document = {
  querySelector(sel){ return makeEl(String(sel)); },
  querySelectorAll(){ return []; },
  addEventListener(){}, createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html></html>' }, body: { appendChild(){}, remove(){}, removeChild(){} },
};
global.URL = { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const P = global.Pipeline, App = global.AppCore;
const S = App.state, ST = App.STORE;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  ✅ ' + name + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + name + ' → 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? ' → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
};

const SALE = (name, phone, date, opts) => Object.assign(
  { source: 'sales', patient_name: name, phone, sales_time: date, product: '百泽安', qty: 1,
    hospital: 'H医院', pharmacy: 'A药房', physician: 'D医生', department: 'K科室' }, opts || {});
const FU = (name, phone, date, opts) => Object.assign(
  { source: 'followup', patient_name: name, phone, product: '百泽安', summary_type: '日常随访任务',
    plan_time: date, exec_time: date, task_status: '已完成', executor: '随访员', follow_note: '' }, opts || {});

function resetState() {
  S.refDate = '2026-09-24';
  S.weekSel = 'this';
  S.stdCycle = { '百泽安': 21 };
  S.qtyScale = {};
  S.cycleAlgo = 'reset';
  S.reasonTree = App.cloneReasonTree(App.DEFAULT_REASON_TREE);
  S.cats.clear(); S.reasons.clear(); S.repurParts.clear();
  S.products.clear(); S.hospitals.clear(); S.pharmacies.clear(); S.executors.clear();
  S.q = '';
  ST.cycles = {}; ST.reasonOverrides = {}; ST.notes = {}; ST.followups = []; ST.sales = [];
}

(async () => {
  console.log('\n=== 患者唯一键（姓名 + 电话）验证 ===');

  // ---------------------------------------------------------------
  console.log('\n[1] patientKey 基本语义');
  const k = P.patientKey;
  ok('存在 Pipeline.patientKey', typeof k === 'function');
  ok('同名不同电话 → 不同键（重名不会并成一人）',
    k('王秀芳', '18923094327') !== k('王秀芳', '18280805760'));
  ok('同电话不同名 → 不同键（家人共用号码不会并成一人）',
    k('甲', '13900000001') !== k('乙', '13900000001'));
  ok('同名同电话（含格式差异）→ 同一键',
    k('甲', '138-0000-0001') === k('甲', '13800000001') && k('甲', '13800000001') === k('甲', '138 0000 0001'));
  eq('姓名两侧空白被裁剪', k('  甲  ', '139'), k('甲', '139'));
  eq('两者都空 → 退化为「未知」键', k('', ''), '未知\u0000');
  eq('电话为空但姓名不同 → 仍是两个人', k('甲', '') !== k('乙', ''), true);
  eq('键内分隔符恰好 1 个（不会与真实取值碰撞）', (k('甲', '139').match(/\u0000/g) || []).length, 1);
  ok('姓名含数字不会被误当电话', k('甲1', '') !== k('甲', '1'));

  // ---------------------------------------------------------------
  console.log('\n[2] 同名不同电话（重名）→ 必须是两个患者');
  resetState();
  ST.sales = [
    SALE('王秀芳', '18923094327', '2026-09-01', { hospital: '仪陇县人民医院' }),
    SALE('王秀芳', '18280805760', '2026-08-01', { hospital: '南充市中心医院' }),
  ];
  let rows = App.buildRows();
  eq('行数', rows.length, 2);
  eq('唯一键数', new Set(rows.map(r => r._key)).size, 2);
  eq('两行姓名相同', rows[0].patient_name === rows[1].patient_name, true);
  eq('两行电话不同', rows[0].phone !== rows[1].phone, true);
  eq('两行的医院各自独立（未互相覆盖）',
    rows.map(r => r.hospital).sort(), ['仪陇县人民医院', '南充市中心医院']);

  // ---------------------------------------------------------------
  console.log('\n[3] 同电话不同名（家人共用号码）→ 必须是两个患者（旧口径会并成一人）');
  resetState();
  ST.sales = [
    SALE('甲', '13900000001', '2026-09-01'),
    SALE('乙', '13900000001', '2026-09-01'),
  ];
  rows = App.buildRows();
  eq('行数', rows.length, 2);
  eq('唯一键数', new Set(rows.map(r => r._key)).size, 2);
  // 不做顺序假设：JS 默认 sort() 按 UTF-16 码位比较，中文顺序与直觉不同
  ok('患者姓名集合 = {甲, 乙}',
    rows.length === 2 && rows.some(r => r.patient_name === '甲') && rows.some(r => r.patient_name === '乙'),
    rows.map(r => r.patient_name).join(','));

  // ---------------------------------------------------------------
  console.log('\n[4] 同一患者多条记录 → 仍聚合为一人（换行/空格/分隔符不影响）');
  resetState();
  ST.sales = [
    SALE('甲', '13800000001', '2026-09-01'),
    SALE('甲', '138-0000-0001', '2026-08-01'),
    SALE('甲', ' 13800000001 ', '2026-07-01'),
  ];
  rows = App.buildRows();
  eq('行数', rows.length, 1);
  eq('购药次数', rows[0].last_purchase, '2026-09-01');

  // ---------------------------------------------------------------
  console.log('\n[5] 电话缺失但不误合并');
  resetState();
  ST.sales = [
    SALE('甲', '', '2026-09-01'),
    SALE('乙', '', '2026-09-01'),
  ];
  rows = App.buildRows();
  eq('都无电话但姓名不同 → 两行', rows.length, 2);
  ok('两个键都带「未知」以外的姓名', rows.every(r => r._key.indexOf('未知') !== 0));

  // ---------------------------------------------------------------
  console.log('\n[6] 随访匹配：重名时不按姓名回退（否则两人会共用同一批随访）');
  resetState();
  // 随访表只有姓名、没有电话（业务常态）→ 只能靠姓名匹配
  ST.followups = [FU('王秀芳', '', '2026-09-10', { follow_note: '已联系' })];
  ST.sales = [
    SALE('王秀芳', '18900000001', '2026-09-01'),
    SALE('王秀芳', '18900000002', '2026-09-01'),
  ];
  rows = App.buildRows();
  eq('重名 → 两行', rows.length, 2);
  ok('重名患者的电话都查不到随访时，不按姓名回退（宁可不匹配，也不串到同名他人）',
    rows.every(r => !r._matched && r.fu_time === ''), rows.map(r => 'fu_time=' + JSON.stringify(r.fu_time)).join(' '));

  console.log('\n[6b] 姓名唯一时，按姓名回退仍然生效（不能把原有能力改坏）');
  resetState();
  ST.followups = [FU('独苗', '', '2026-09-10', { follow_note: '已联系' })];
  ST.sales = [SALE('独苗', '18900000009', '2026-09-01')];
  rows = App.buildRows();
  eq('行数', rows.length, 1);
  ok('姓名唯一 → 仍按姓名匹配到随访', !!rows[0]._matched && rows[0].fu_time === '2026-09-10',
    'fu_time=' + JSON.stringify(rows[0].fu_time));

  console.log('\n[6c] 重名但电话能命中随访 → 各拿自己的那份');
  resetState();
  ST.followups = [
    FU('王秀芳', '18900000001', '2026-09-10', { follow_note: '甲份随访' }),
    FU('王秀芳', '18900000002', '2026-09-11', { follow_note: '乙份随访' }),
  ];
  ST.sales = [
    SALE('王秀芳', '18900000001', '2026-09-01'),
    SALE('王秀芳', '18900000002', '2026-09-01'),
  ];
  rows = App.buildRows();
  eq('两行', rows.length, 2);
  const notes = rows.map(r => r.fu_note).sort();
  eq('两人各自匹配到自己的随访', notes, ['乙份随访', '甲份随访'].sort());

  // ---------------------------------------------------------------
  console.log('\n[7] 键一致性：回传表导入的备注 / 原因要绑到同一行');
  resetState();
  ST.sales = [SALE('甲', '13900000001', '2026-09-01')];
  rows = App.buildRows();
  const r0 = rows[0];
  ST.notes = {}; ST.reasonOverrides = {};
  const res = App.applyCallbackRecords([{
    source: 'followup', summary_type: '跟进回传', patient_name: '甲', phone: '13900000001',
    product: '百泽安', callback_note: '已电话联系',
  }]);
  eq('回填了 1 条备注', res.nNote, 1);
  eq('备注键与行键一致（_key::品种）', ST.notes[r0._key + '::' + r0.product], '已电话联系');
  ok('行键确实是「姓名\\u0000电话」格式', r0._key === P.patientKey('甲', '13900000001'), r0._key);

  // ---------------------------------------------------------------
  console.log('\n[8] 匿名记录（姓名与电话都空）的处理');
  resetState();
  ST.sales = [
    SALE('甲', '13900000001', '2026-09-01'),
    SALE('', '', '2026-09-01'),           // 匿名行：数据里没有任何可区分信息
  ];
  rows = App.buildRows();
  eq('名单仍有 2 行（匿名行归入「未知」患者，与旧行为一致）', rows.length, 2);
  const anon = rows.filter(r => r._key === '未知\u0000');
  eq('匿名行确实使用「未知」键', anon.length, 1);
  eq('有身份的行不会被匿名行污染', rows.filter(r => r._key === P.patientKey('甲', '13900000001')).length, 1);
  const stat = App.buildSummaryStats('百泽安');
  ok('小结统计可正常产出（匿名记录不参与）', !!stat, Object.keys(stat || {}).join(','));

  // ---------------------------------------------------------------
  console.log('\n[9] 构建产物防线：两个产物都已包含新键口径');
  for (const f of ['index.html', 'index.single.html']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(f + ' 含 patientKey 定义', code.includes('function patientKey('));
    ok(f + ' 含 patientKey 导出', code.includes('patientKey, fmtDateTime') || code.includes('patientKey,'));
    ok(f + ' 不再含旧写法 phoneDigits(r.phone) ||', !code.includes('phoneDigits(r.phone) ||'));
    ok(f + ' 不再含旧写法 phoneDigits(s.phone) ||', !code.includes('phoneDigits(s.phone) ||'));
    ok(f + ' 含重名保护的 isAmbiguousName', code.includes('isAmbiguousName'));
  }

  console.log('\n结果: pass=' + pass + '  fail=' + fail);
  process.exit(fail ? 1 : 0);
})();
