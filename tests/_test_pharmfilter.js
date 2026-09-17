// 「药房筛选 = 从数据源头过滤」验证
// 覆盖：跨药房患者能否进入名单、是否只按本药房记录计算、跨药房提示、
//       转渠道原因预填及其优先级、多选、药房计数口径、导出文本、未筛选时行为不变
const fs = require('fs');
const path = require('path');
const ExcelJS = require(path.join(__dirname, '..', 'vendor', 'exceljs.min.js'));

const nodes = {};
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
  querySelector(sel){ const k = String(sel); return (nodes[k] = nodes[k] || makeEl(k)); },
  querySelectorAll(){ return []; },
  addEventListener(){}, createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html></html>' }, body: { appendChild(){}, remove(){}, removeChild(){} },
};
let captured = null;
global.URL = { createObjectURL(b){ captured = b; return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.ExcelJS = ExcelJS;
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const App = global.AppCore;
const S = App.state, ST = App.STORE;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  ✅ ' + name + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + name + ' → 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } };
const sale = (name, phone, date, pharmacy, qty) => ({
  source: 'sales', patient_name: name, phone, sales_time: date, product: '百泽安',
  qty, hospital: 'H1', pharmacy, physician: '张医生',
});
const clearSel = () => { S.pharmacies.clear(); S.hospitals.clear(); };

(async () => {
  S.refDate = '2026-09-17';
  S.weekSel = 'this';
  S.stdCycle = { '百泽安': 21 };
  S.qtyScale = {};        // 「按数量计算」默认关闭，保持每周期 21 天
  S.cycleAlgo = 'reset';
  S.reasonTree = App.cloneReasonTree(App.DEFAULT_REASON_TREE);
  clearSel();
  S.products.clear(); S.cats.clear(); S.reasons.clear(); S.repurParts.clear(); S.executors.clear(); S.q = '';

  // 患者甲：6/10 在 A 药房、9/10 在 B 药房（周期 21 天）
  // 患者乙：8/1 在 A 药房（仅用于核对药房计数）
  const baseSales = [
    sale('甲', '13900000001', '2026-06-10', 'A药房', 1),
    sale('甲', '13900000001', '2026-09-10', 'B药房', 1),
    sale('乙', '13900000002', '2026-08-01', 'A药房', 1),
  ];
  ST.sales = baseSales.slice();
  ST.followups = []; ST.cycles = {}; ST.reasonOverrides = {}; ST.notes = {};

  console.log('\n[1] 未筛选药房 → 行为与改动前完全一致');
  let rows = App.buildRows();
  eq('两名患者各 1 行', rows.length, 2);
  let jia = rows.find(r => r.patient_name === '甲');
  eq('药房=全量末次购药药房', jia.pharmacy, 'B药房');
  eq('最近购药=全量末次', jia.last_purchase, '2026-09-10');
  eq('无跨药房提示', jia.pharmacy_note, '');
  eq('状态=未到期', jia.status, '未到期');
  eq('乙 应购药日期按全量记录', rows.find(r => r.patient_name === '乙').due_date, '2026-08-22');

  console.log('\n[2] 单选 A 药房 → 已转渠道的患者进入名单，且只按 A 药房记录计算');
  S.pharmacies.add('A药房');
  rows = App.buildRows();
  eq('跨药房患者仍在名单中（不再被过滤掉）', rows.length, 2);
  jia = rows.find(r => r.patient_name === '甲');
  eq('药房列=本药房', jia.pharmacy, 'A药房');
  eq('最近购药只按本药房记录', jia.last_purchase, '2026-06-10');
  eq('下次应购日只按本药房记录（6/10 + 21）', jia.due_date, '2026-07-01');
  eq('状态=已逾期（本药房视角下已断药）', jia.status, '已逾期');
  eq('跨药房提示=末次实际购药药房与日期', jia.pharmacy_note, '末次在 B药房 09-10');
  eq('本药房常客不受影响', rows.find(r => r.patient_name === '乙').due_date, '2026-08-22');

  console.log('\n[3] filterRows 不再误杀跨药房患者');
  const fr = App.filterRows(rows);
  eq('筛选后仍有 2 行', fr.length, 2);
  ok('含跨药房患者「甲」', fr.some(r => r.patient_name === '甲'));

  console.log('\n[4] 单选 B 药房 → 只看到 B 药房记录，无跨药房提示');
  S.pharmacies.clear(); S.pharmacies.add('B药房');
  rows = App.buildRows();
  eq('仅甲 1 行（乙未在 B 药房购药）', rows.length, 1);
  eq('最近购药=B 药房记录', rows[0].last_purchase, '2026-09-10');
  eq('无跨药房提示', rows[0].pharmacy_note, '');
  eq('状态=未到期', rows[0].status, '未到期');

  console.log('\n[5] 多选 A+B → 合并两家记录，选中集合内不算跨药房');
  S.pharmacies.add('A药房');
  rows = App.buildRows();
  eq('仍是 2 行', rows.length, 2);
  jia = rows.find(r => r.patient_name === '甲');
  eq('最近购药=选中药房中的最晚一次', jia.last_purchase, '2026-09-10');
  eq('无跨药房提示（B 也在选中集合内）', jia.pharmacy_note, '');

  console.log('\n[6] 转渠道原因预填与优先级');
  clearSel(); S.pharmacies.add('A药房');
  rows = App.buildRows();
  eq('无随访 → 按跨药房事实预填「转渠道」', rows.find(r => r.patient_name === '甲').reason, 'channel');
  eq('本药房常客无原因可填 → 空', rows.find(r => r.patient_name === '乙').reason, '');

  ST.followups = [{ source: 'followup', patient_name: '甲', phone: '13900000001', product: '百泽安',
    task_status: '已完成', exec_time: '2026-06-25', summary_type: '日常随访任务',
    delay_reason: '患者要求推迟', follow_note: '' }];
  rows = App.buildRows();
  eq('随访文本判得出原因 → 以随访为准（不覆盖成转渠道）', rows.find(r => r.patient_name === '甲').reason, 'delay');

  ST.reasonOverrides['13900000001::百泽安'] = 'dropout_econ';
  rows = App.buildRows();
  eq('人工点选优先级最高', rows.find(r => r.patient_name === '甲').reason, 'dropout_econ');
  ST.reasonOverrides = {}; ST.followups = [];

  console.log('\n[7] 药房多选列表计数 = 在该药房购过药的行数（基于全量明细）');
  await App.refresh();
  const html = nodes['#pharmMsList'].innerHTML;
  ok('选中 A 药房后，B 药房仍在下拉里（不会消失）', html.includes('B药房'));
  ok('A 药房计数=2（甲、乙各一行）', /value="A药房"[\s\S]*?ms-cnt">2</.test(html));
  ok('B 药房计数=1（甲一行）', /value="B药房"[\s\S]*?ms-cnt">1</.test(html));
  S.pharmacies.clear(); await App.refresh();
  const html2 = nodes['#pharmMsList'].innerHTML;
  ok('未筛选时计数口径同样为历史购药', /value="A药房"[\s\S]*?ms-cnt">2</.test(html2));

  console.log('\n[8] 导出：药房列带跨药房提示（与界面一致）');
  S.pharmacies.add('A药房'); await App.refresh();
  await App.doExport();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await captured.arrayBuffer());
  const ws = wb.worksheets[0];
  const head = ws.getRow(1).values.filter(Boolean);
  const iP = head.indexOf('药房');
  eq('药房列文本', ws.getRow(2).values[iP + 1], 'A药房（末次在 B药房 09-10）');
  eq('导出列数未变（未新增列）', head.length, App.LIST_COLS.length + 1);

  console.log('\n[9] 未筛选药房导出 → 药房列不带提示（无副作用）');
  S.pharmacies.clear(); await App.refresh();
  await App.doExport();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(await captured.arrayBuffer());
  const ws2 = wb2.worksheets[0];
  const head2 = ws2.getRow(1).values.filter(Boolean);
  const iP2 = head2.indexOf('药房');
  // 未筛选：乙(应购 8/22) 排在甲(应购 10/1) 之前
  eq('第 1 行数据=纯药房名（乙 / A药房）', ws2.getRow(2).values[iP2 + 1], 'A药房');
  eq('第 2 行数据=纯药房名（甲 / 末次 B药房，无提示）', ws2.getRow(3).values[iP2 + 1], 'B药房');

  console.log('\n[10] 医院筛选不受影响（仍按末次购药医院）');
  clearSel(); S.hospitals.add('H1');
  rows = App.buildRows();
  eq('医院筛选后仍 2 行', rows.length, 2);
  S.hospitals.clear();
  ST.sales = baseSales.slice();

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e && e.stack || e); process.exit(1); });
