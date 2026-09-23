// 验证「患者列表」中 医院 / 科室 / 医生 三个字段的数据来源
// 覆盖：随访表结构上是否可能提供这三个字段、列表取值是否只认销售明细、
//       随访记录里硬塞同名字段是否会造成泄漏、多次购药时的取值口径、
//       药房源头筛选下的取值、以及 XLSX 全流程验证
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
  querySelector(sel){ const k = String(sel); return makeEl(k); },
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
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } };

// 销售明细记录构造器
const SALE = (name, phone, date, pharmacy, hospital, physician, department) => ({
  source: 'sales', patient_name: name, phone, sales_time: date, product: '百泽安', qty: 1,
  hospital, pharmacy, physician, department,
});

function resetState() {
  S.refDate = '2026-09-17';
  S.weekSel = 'this';
  S.stdCycle = { '百泽安': 21 };
  S.qtyScale = {};
  S.cycleAlgo = 'reset';
  S.reasonTree = App.cloneReasonTree(App.DEFAULT_REASON_TREE);
  S.cats.clear(); S.reasons.clear(); S.repurParts.clear();
  S.products.clear(); S.hospitals.clear(); S.pharmacies.clear(); S.executors.clear();
  S.q = '';
  ST.cycles = {}; ST.reasonOverrides = {}; ST.notes = {}; ST.followups = [];
}

(async () => {
  console.log('\n=== 医院 / 科室 / 医生 字段来源验证 ===');

  // ---------------------------------------------------------------
  console.log('\n[1] 结构面：随访表归一化后是否包含这三个字段');
  // 注意：pipeline 内部的行对象按「列下标」建键（rowToObj），不是按列名
  const fuCols = ['任务状态', '患者', '联系电话', '产品', '适应症', '计划执行时间', '执行时间',
    '随访人', '服务摘要', '医院', '科室', '医生'];
  const fuVals = ['已完成', '甲', '13900000001', '百泽安', '', '2026-08-20', '2026-08-20',
    '小王', '日常随访任务', '随访表医院X', '随访表科室X', '随访表医生X'];
  const fuRowObj = {};
  fuVals.forEach((v, i) => { fuRowObj[i] = v; });
  const fuRec = P.normalizeSheet('followup', [fuRowObj], fuCols, '随访任务导出.xlsx', '随访任务')[0];
  eq('（前置）随访表解析确实读到了「医院/科室/医生」列之外的字段', fuRec.patient_name, '甲');
  ok('随访表里确有「医院/科室/医生」列时，归一化结果仍不含 hospital', !('hospital' in fuRec));
  ok('随访表里确有「医院/科室/医生」列时，归一化结果仍不含 department', !('department' in fuRec));
  ok('随访表里确有「医院/科室/医生」列时，归一化结果仍不含 physician', !('physician' in fuRec));
  eq('随访记录的字段清单', Object.keys(fuRec).filter(k => /hospital|department|physician|doctor/i.test(k)), []);
  ok('随访记录本身不被这三个列污染（值只落在销售明细侧）', fuRec.patient_name === '甲');

  // ---------------------------------------------------------------
  console.log('\n[2] 列表取值：三个字段只认销售明细');
  resetState();
  ST.sales = [SALE('甲', '13900000001', '2026-08-01', 'A药房', '销售医院', '销售医生', '销售科室')];
  let rows = App.buildRows();
  eq('医院来自销售明细', rows[0].hospital, '销售医院');
  eq('科室来自销售明细', rows[0].department, '销售科室');
  eq('医生来自销售明细', rows[0].physician, '销售医生');

  // ---------------------------------------------------------------
  console.log('\n[3] 泄漏测试：随访记录里硬塞同名字段（模拟脏数据/历史遗留列）');
  ST.followups = [{
    source: 'followup', patient_name: '甲', phone: '13900000001', product: '百泽安',
    task_status: '已完成', exec_time: '2026-08-20', summary_type: '日常随访任务', follow_note: '',
    hospital: '随访医院', department: '随访科室', physician: '随访医生',
  }];
  rows = App.buildRows();
  eq('随访携带 hospital 也不覆盖列表医院', rows[0].hospital, '销售医院');
  eq('随访携带 department 也不覆盖列表科室', rows[0].department, '销售科室');
  eq('随访携带 physician 也不覆盖列表医生', rows[0].physician, '销售医生');
  ok('随访确实被匹配上了（说明不是「没匹配才没覆盖」）', rows[0].fu_time === '2026-08-20');

  // ---------------------------------------------------------------
  console.log('\n[4] 同一患者多次购药 → 取「销售时间最近一次」的记录（不受文件行序影响）');
  resetState();
  // 文件顺序：晚的在前、早的在后（非按销售时间升序，真实导出很常见）
  const DESC = [
    SALE('乙', '13900000002', '2026-09-01', 'A药房', '新医院', '新医生', '新科室'),
    SALE('乙', '13900000002', '2026-07-01', 'A药房', '旧医院', '旧医生', '旧科室'),
  ];
  const ASC = [DESC[1], DESC[0]];
  for (const [label, data] of [['降序文件', DESC], ['升序文件', ASC]]) {
    ST.sales = data.slice();
    rows = App.buildRows();
    eq(label + '：最近购药日期取到 09-01', rows[0].last_purchase, '2026-09-01');
    eq(label + '：医院取销售时间最新的一条', rows[0].hospital, '新医院');
    eq(label + '：科室取销售时间最新的一条', rows[0].department, '新科室');
    eq(label + '：医生取销售时间最新的一条', rows[0].physician, '新医生');
  }

  console.log('\n[4b] 最新一条里某字段为空 → 该字段沿用更早的非空值');
  ST.sales = [
    SALE('己', '13900000006', '2026-09-01', 'A药房', '新医院', '新医生', ''), // 科室缺失
    SALE('己', '13900000006', '2026-07-01', 'A药房', '旧医院', '旧医生', '旧科室'),
  ];
  rows = App.buildRows();
  eq('医院仍取最新的非空值', rows[0].hospital, '新医院');
  eq('科室沿用更早的非空值（不回退为空）', rows[0].department, '旧科室');

  console.log('\n[4c] 药房字段同样按日期取最新（保证与实际末次购药药房一致）');
  ST.sales = [
    SALE('庚', '13900000007', '2026-09-01', 'B药房', 'B医院', 'B医生', 'B科室'),
    SALE('庚', '13900000007', '2026-07-01', 'A药房', 'A医院', 'A医生', 'A科室'),
  ];
  rows = App.buildRows();
  eq('药房=销售时间最新的 B药房', rows[0].pharmacy, 'B药房');
  eq('医院与药房来自同一条记录（不会错位）', rows[0].hospital, 'B医院');

  // ---------------------------------------------------------------
  console.log('\n[5] 药房源头筛选下，三个字段跟随该药房的销售记录');
  resetState();
  ST.sales = [
    SALE('丙', '13900000003', '2026-06-10', 'A药房', 'A医院', 'A医生', 'A科室'),
    SALE('丙', '13900000003', '2026-09-10', 'B药房', 'B医院', 'B医生', 'B科室'),
  ];
  S.pharmacies.clear(); S.pharmacies.add('A药房');
  rows = App.buildRows();
  eq('选 A 药房 → 医院取该药房记录', rows[0].hospital, 'A医院');
  eq('选 A 药房 → 科室取该药房记录', rows[0].department, 'A科室');
  eq('选 A 药房 → 医生取该药房记录', rows[0].physician, 'A医生');
  S.pharmacies.clear(); S.pharmacies.add('B药房');
  rows = App.buildRows();
  eq('选 B 药房 → 医院取该药房记录', rows[0].hospital, 'B医院');
  eq('选 B 药房 → 科室取该药房记录', rows[0].department, 'B科室');
  eq('选 B 药房 → 医生取该药房记录', rows[0].physician, 'B医生');
  S.pharmacies.clear();

  // ---------------------------------------------------------------
  console.log('\n[6] XLSX 全流程：随访表带「医院/科室/医生」列，销售明细另给一套值');
  const wb = XLSX.utils.book_new();
  const salesAoa = [
    ['销售时间', '会员姓名', '会员电话', '商品名称', '销售数量', '医疗单位', '药房名称', '处方医生', '处方科室'],
    ['2026-08-01', '戊', '13900000005', '百泽安', 1, '销售医院S', 'A药房', '销售医生S', '销售科室S'],
  ];
  const fuAoa = [
    ['任务状态', '患者', '联系电话', '产品', '计划执行时间', '执行时间', '服务摘要', '随访人',
      '医院', '科室', '医生'],
    ['已完成', '戊', '13900000005', '百泽安', '2026-08-20', '2026-08-20', '日常随访任务', '小王',
      '随访医院F', '随访科室F', '随访医生F'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(salesAoa), '销售明细');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fuAoa), '随访任务');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const file = {
    name: '合并导出.xlsx', size: buf.byteLength,
    async arrayBuffer(){ return buf; },
  };
  const res = await P.processFiles([file]);
  eq('销售明细解析条数', res.sales.length, 1);
  eq('随访任务解析条数', res.followups.length, 1);
  eq('解析出的销售记录带销售侧医院', res.sales[0].hospital, '销售医院S');
  eq('解析出的销售记录带销售侧科室', res.sales[0].department, '销售科室S');
  eq('解析出的销售记录带销售侧医生', res.sales[0].physician, '销售医生S');
  ok('解析出的随访记录上不存在 hospital 字段', !('hospital' in res.followups[0]));

  resetState();
  ST.sales = res.sales; ST.followups = res.followups;
  rows = App.buildRows();
  eq('全流程：列表医院=销售明细值', rows[0].hospital, '销售医院S');
  eq('全流程：列表科室=销售明细值', rows[0].department, '销售科室S');
  eq('全流程：列表医生=销售明细值', rows[0].physician, '销售医生S');
  ok('全流程：随访侧值未出现在三个字段中',
    !['随访医院F', '随访科室F', '随访医生F'].includes(rows[0].hospital) &&
    !['随访医院F', '随访科室F', '随访医生F'].includes(rows[0].department) &&
    !['随访医院F', '随访科室F', '随访医生F'].includes(rows[0].physician));

  console.log('\n' + (fail === 0 ? '✅' : '❌') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
