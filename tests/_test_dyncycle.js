// 动态品种标准周期测试：品种按数据灵活提取，不再写死百泽安/百悦泽
const fs = require('fs');
const path = require('path');
const elStore = {};
function makeEl(id) {
  return {
    id, _html: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, insertBefore(){}, removeChild(){},
    querySelectorAll(){ return []; },
    querySelector(){ return makeEl(id + '>child'); },
    parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null,
    get innerHTML(){ return this._html; },
    set innerHTML(v){ this._html = String(v); },
  };
}
global.window = global;
global.document = {
  querySelector(sel){
    const key = String(sel).replace(/^#/, '');
    if (!elStore[key]) elStore[key] = makeEl(key);
    return elStore[key];
  },
  querySelectorAll(){ return []; },
  addEventListener(){},
  createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html><body></body></html>' },
  body: { appendChild(){}, remove(){} },
};
global.URL = { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const P = global.Pipeline, App = global.AppCore, M = global.Mapping;

const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function assert(cond, msg) {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('  ✅ ' + msg);
}

(async () => {
  // ---------- ① 内置品种族默认值 ----------
  console.log('===== ① 内置品种族默认值（来自 mapping） =====');
  assert(App.state.stdCycle['百泽安'] === 21, `百泽安默认 21（实际 ${App.state.stdCycle['百泽安']}）`);
  assert(App.state.stdCycle['百悦泽'] === 28, `百悦泽默认 28（实际 ${App.state.stdCycle['百悦泽']}）`);
  assert(App.state.stdCycle['索托克拉'] === 28, `索托克拉默认 28（实际 ${App.state.stdCycle['索托克拉']}）`);

  // ---------- ② ensureStdCycles：新品种默认 30，内置值不覆盖 ----------
  console.log('\n===== ② ensureStdCycles 动态补全 =====');
  App.ensureStdCycles(['百泽安', '索托克拉', '某新药X', '某新药Y']);
  assert(App.state.stdCycle['百泽安'] === 21, '百泽安保持内置 21（不被覆盖）');
  assert(App.state.stdCycle['索托克拉'] === 28, '索托克拉保持内置 28');
  assert(App.state.stdCycle['某新药X'] === 30, `新品种默认 30（实际 ${App.state.stdCycle['某新药X']}）`);
  assert(App.state.stdCycle['某新药Y'] === 30, '第二个新品种也默认 30');

  // ---------- ③ renderCycleInputs 动态渲染 ----------
  console.log('\n===== ③ renderCycleInputs 动态渲染 =====');
  App.renderCycleInputs();
  const html = elStore['cycleInputs'].innerHTML;
  assert(html.includes('某新药X'), '渲染包含新品种「某新药X」');
  assert(html.includes('value="30"'), '新品种输入框值为 30');
  assert(html.includes('索托克拉') && html.includes('value="28"'), '索托克拉输入框值为 28');

  // ---------- ④ buildRows 用动态标准周期计算 ----------
  console.log('\n===== ④ buildRows 按品种使用标准周期 =====');
  const today = fmt(new Date());
  function sales(patient, phone, date, product, hospital) {
    return { source: 'sales', patient_name: patient, phone, sales_time: date, product,
      hospital: hospital || '测试医院', pharmacy: '测试药房', physician: '张医生' };
  }
  // 索托克拉：不在周期表，应使用 stdCycle[索托克拉]=28
  // 某新药X：不在周期表，应使用 stdCycle[某新药X]=30
  App.STORE.sales = [
    sales('甲', '10000000001', '2026-07-01', '索托克拉'),
    sales('乙', '10000000002', '2026-07-01', '某新药X'),
  ];
  App.STORE.followups = []; App.STORE.cycles = {};
  App.state.start = null; App.state.end = null; App.state.advance = 7;
  const rows = App.buildRows();
  const byName = {};
  for (const r of rows) byName[r.patient_name] = r;
  assert(byName['甲'].cycle_days === 28, `索托克拉周期 = 28（实际 ${byName['甲'].cycle_days}）`);
  assert(byName['乙'].cycle_days === 30, `某新药X周期 = 30（实际 ${byName['乙'].cycle_days}）`);

  // ---------- ⑤ 用户修改新品种周期后重算 ----------
  console.log('\n===== ⑤ 用户维护新品种周期 =====');
  App.state.stdCycle['某新药X'] = 45;
  const rows2 = App.buildRows();
  const byName2 = {};
  for (const r of rows2) byName2[r.patient_name] = r;
  assert(byName2['乙'].cycle_days === 45, `用户改为 45 后重算 = 45（实际 ${byName2['乙'].cycle_days}）`);

  // ---------- ⑥ 真实数据验证：实际出现品种 ----------
  console.log('\n===== ⑥ 真实数据实际品种 =====');
  function fileObj(p, name) {
    const buf = fs.readFileSync(p);
    return { name: name || path.basename(p), size: buf.length,
      async arrayBuffer(){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } };
  }
  const res = await P.processFiles([
    fileObj('C:/Users/yym/Downloads/销售明细查询报表 (47).xlsx', '销售.xlsx'),
    fileObj('C:/Users/yym/Downloads/随访任务导出 (5).xlsx', '随访.xlsx'),
    fileObj('C:/Users/yym/Downloads/患者用药周期表.xlsx', '周期.xlsx'),
  ]);
  const realProducts = [...new Set(res.sales.map(s => s.product).filter(Boolean))];
  console.log('  [真实数据] 销售明细出现品种:', realProducts.join(' / '));
  App.STORE.sales = res.sales; App.STORE.followups = res.followups; App.STORE.cycles = res.cycles;
  const fresh = Object.fromEntries(M.PRODUCT_FAMILIES.map(p => [p.family, p.stdCycle]));
  App.state.stdCycle = fresh;
  App.ensureStdCycles(realProducts);
  for (const fam of realProducts) {
    assert(App.state.stdCycle[fam] != null, `品种「${fam}」已有标准周期 ${App.state.stdCycle[fam]} 天`);
  }
  App.renderCycleInputs();
  const html2 = elStore['cycleInputs'].innerHTML;
  for (const fam of realProducts) assert(html2.includes(fam), `周期输入框包含「${fam}」`);

  console.log('\n✅ 动态品种标准周期 —— 全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
