// 回传表「未购药原因」取值口径回归测试（用户 2026-10-19 定）
//
// 用户原话：
//   「如果用户只填写了跟进备注，没填或没改停药原因，导出的时候就导出该行当时的用药状态。
//     即无论是自动抓取到的原因，还是用户填的，还是空白的，都原样导出。」
//
// 因此本测试锁定四件事：
//   [1] 导出值 = 该行当前的结果（人工点选 > 自动判定 > 空），不是「只导出人工点选过的」
//   [2] 状态列取该行当前匹配到的随访原样（无匹配 → 留空）
//   [3] 导入时只接续备注，不写「人工点选」（原因改由记录自身字段参与判定）
//   [4] 记录写明的「未购药原因」优先于文本推导 → 人工改过的分类能原样回来
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ExcelJS = require(path.join(ROOT, 'vendor', 'exceljs.min.js'));

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
let captured = null;
global.URL = { createObjectURL(b){ captured = b; return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
global.ExcelJS = ExcelJS;
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(ROOT, f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const App = global.AppCore, P = global.Pipeline;
const S = App.state, ST = App.STORE;

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const c = JSON.stringify(got) === JSON.stringify(want);
  c ? pass++ : fail++;
  console.log((c ? '  ✅ ' : '  ❌ ') + n + ' → ' + JSON.stringify(got) + (c ? '' : '，期望 ' + JSON.stringify(want)));
};
const ok = (n, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  ✅ ' : '  ❌ ') + n + (extra ? ' → ' + extra : '')); };

// ---------- 5 种典型行 ----------
const FU_WITH_STOP = {
  summary_type: '常规随访', exec_time: '2026-09-01 09:00:00', plan_time: '2026-09-01 09:00:00',
  usage_status: '已停药', purchased_on_time: '已停药', is_dropout: '是', dropout_reason: null,
  still_using: null, delay_reason: null, stop_reason: '经济困难，负担不起', follow_note: '已电话随访',
};
const mk = (name, phone, fam, extra) => Object.assign({
  _key: P.patientKey(name, phone), product: fam, patient_name: name, phone, executor: '刘倩',
  fu_note: '', reason: '', _matched: null,
}, extra || {});

const rowNoteOnly = mk('甲一', '13800000001', '百泽安');
const rowAuto = mk('乙二', '13800000002', '百泽安', { reason: 'dropout_econ', _matched: FU_WITH_STOP,
  fu_note: '已电话随访' });
const rowManual = mk('丙三', '13800000003', '百泽安', { reason: 'dropout_econ', _matched: FU_WITH_STOP,
  fu_note: '已电话随访' });
const rowBlankPick = mk('丁四', '13800000004', '百泽安', { reason: 'dropout_econ', _matched: FU_WITH_STOP,
  fu_note: '已电话随访' });
const rowNoFu = mk('戊五', '13800000005', '百悦泽');

App.DATA.rows = [rowNoteOnly, rowAuto, rowManual, rowBlankPick, rowNoFu];
// 用户在看板里的填写：全部只填了跟进备注；原因分别是「没动 / 自动 / 人工改 / 人工选未标」
S.plainName = true; S.plainPhone = true;
ST.notes[rowNoteOnly._key + '::百泽安'] = '已联系，本周五来买';
ST.notes[rowAuto._key + '::百泽安'] = '已联系，家属代买';
ST.notes[rowManual._key + '::百泽安'] = '已联系，改为下周';
ST.notes[rowBlankPick._key + '::百泽安'] = '已联系，情况不明';
ST.notes[rowNoFu._key + '::百悦泽'] = '已联系';
ST.reasonOverrides[rowManual._key + '::百泽安'] = 'delay';
ST.reasonOverrides[rowBlankPick._key + '::百泽安'] = '';   // 显式点选「未标」= 空串

(async () => {
  console.log('\n[1] 导出：未购药原因 = 该行当前结果（自动/人工/空 都原样）');
  eq('待回传行数（有备注的行）', App.callbackRows().length, 5);
  captured = null;
  await App.doExportCallback();
  ok('已产出文件', !!captured);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await captured.arrayBuffer());
  const ws = wb.worksheets[0];
  const head = ws.getRow(1).values.filter(Boolean);
  const idx = {}; head.forEach((h, i) => idx[h] = i + 1);
  const byName = {};
  for (let r = 2; r <= ws.rowCount; r++) {
    const v = ws.getRow(r).values;
    byName[v[idx['患者姓名']]] = v;
  }
  eq('甲一：没有原因 → 留空', byName['甲一'][idx['未购药原因']] || '', '');
  eq('★ 乙二：自动判定的原因照样导出', byName['乙二'][idx['未购药原因']], '脱落·经济');
  eq('★ 丙三：人工改过的原因优先', byName['丙三'][idx['未购药原因']], '推迟购药');
  eq('★ 丁四：人工点选「未标」= 空，不被自动原因顶回', byName['丁四'][idx['未购药原因']] || '', '');
  eq('戊五：无匹配随访 → 留空', byName['戊五'][idx['未购药原因']] || '', '');

  console.log('\n[2] 导出：不复制随访模板状态列（列数固定 10，信号靠「未购药原因」归一化）');
  eq('★ 表头只有 10 列', head.length, 10);
  ok('★ 不含任何随访状态列',
    !head.some(h => /患者目前的用药状态|是否已按时购药|停药的原因|推迟用药的原因|易脱落|还在按照处方继续使用/.test(h)));

  console.log('\n[3] 导入：只接续备注，原因交给记录自身字段（不再写「人工点选」）');
  const cb = [
    { summary_type: '跟进回传', patient_name: '乙二', phone: '13800000002', product: '百泽安',
      callback_note: '已联系，家属代买', reason_label: '脱落·经济', stop_reason: '经济困难，负担不起',
      usage_status: '已停药' },
    { summary_type: '跟进回传', patient_name: '丙三', phone: '13800000003', product: '百泽安',
      callback_note: '已联系，改为下周', reason_label: '推迟购药', stop_reason: '经济困难，负担不起',
      usage_status: '已停药' },
    { summary_type: '跟进回传', patient_name: '戊五', phone: '13800000005', product: '百悦泽',
      callback_note: '已联系', reason_label: '推迟购药' },
  ];
  ST.notes = {}; ST.reasonOverrides = {};
  const res = App.applyCallbackRecords(cb);
  eq('接续备注数', res.nNote, 3);
  eq('★ 不写入任何「人工点选」', Object.keys(ST.reasonOverrides).length, 0);
  eq('原因留在记录上（乙二）', cb[0].reason_label, '脱落·经济');

  console.log('\n[4] 导入后重新计算：原因仍然回到列表上（不是「未标」）');
  // 用真实销售 + 回传记录跑一遍判定
  ST.sales = [
    { sales_time: '2026-08-01', product: '百泽安', patient_name: '乙二', phone: '13800000002', qty: '1',
      pharmacy: '南充药房', hospital: '川北医学院附属医院', physician: '刘洋' },
  ];
  ST.followups = cb.filter(f => f.patient_name === '乙二').map(f => Object.assign({
    task_status: '已完成', exec_time: '2026-10-19 09:00:00', plan_time: '2026-10-19 09:00:00',
    follow_note: '', product: '百泽安',
  }, f));
  ST.cycles = {};
  S.refDate = '2026-10-20'; S.weekSel = 'this'; S.stdCycle = { 百泽安: 21 };
  ST.reasonOverrides = {};                       // 模拟「新一轮没有人工点选」
  App.applyCallbackRecords(ST.followups);
  const row = App.buildRows().find(r => r.patient_name === '乙二');
  ok('取到乙二的行', !!row);
  eq('★ 回传后原因仍为「脱落·经济」', row.reason, 'dropout_econ');
  eq('★ 回传后随访信号类别仍为 dropout', row.fu_signal_kind, 'dropout');

  console.log('\n[5] 记录自带的「未购药原因」优先于文本推导（人工改过的分类能原样回来）');
  // 丙三：停药原因写「经济困难」，但该行当时被人工改判为「推迟购药」
  ST.sales = [
    { sales_time: '2026-08-01', product: '百泽安', patient_name: '丙三', phone: '13800000003', qty: '1',
      pharmacy: '南充药房', hospital: '川北医学院附属医院', physician: '刘洋' },
  ];
  ST.followups = cb.filter(f => f.patient_name === '丙三').map(f => Object.assign({
    task_status: '已完成', exec_time: '2026-10-19 09:00:00', plan_time: '2026-10-19 09:00:00',
    follow_note: '', product: '百泽安',
  }, f));
  ST.reasonOverrides = {};
  const rowC = App.buildRows().find(r => r.patient_name === '丙三');
  ok('取到丙三的行', !!rowC);
  eq('★ 记录写明的分类胜出（推迟购药）', rowC.reason, 'delay');

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})();
