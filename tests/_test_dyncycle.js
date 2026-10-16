// 动态品种标准周期测试：标准周期只显示/允许填写「上传数据中出现品种」，不写死内置商品
const fs = require('fs');
const path = require('path');
const os = require('os');
// 样例 Excel 目录：默认取当前用户的 Downloads，可用环境变量 SAMPLE_DIR 覆盖
const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(os.homedir(), 'Downloads');
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
  // ---------- ① 初始不写死内置商品 ----------
  console.log('===== ① 初始 stdCycle 为空（不写死商品） =====');
  assert(Object.keys(App.state.stdCycle).length === 0, `初始无任何品种周期（实际 ${Object.keys(App.state.stdCycle).join(",") || "空"}）`);
  // mapping 层内置定义仍在（作为默认值来源，但不预填界面）
  assert(M.PRODUCT_FAMILIES.some(p => p.family === '百泽安' && p.stdCycle === 21), 'mapping 内置定义保留（百泽安21）');

  // ---------- ② syncStdCycles 首次：补数据出现品种，未出现的不写入 ----------
  console.log('\n===== ② syncStdCycles 首次：只补数据品种 =====');
  App.syncStdCycles(['百泽安', '索托克拉', '某新药X']);
  assert(App.state.stdCycle['百泽安'] === 21, '百泽安补内置 21');
  assert(App.state.stdCycle['索托克拉'] === 28, '索托克拉补内置 28');
  assert(App.state.stdCycle['某新药X'] === 30, '新品种默认 30');
  assert(App.state.stdCycle['百悦泽'] == null, '未出现的百悦泽 不写入');
  assert(Object.keys(App.state.stdCycle).sort().join(',') === '某新药X,百泽安,索托克拉', '仅出现品种存在');

  // ---------- ②a 换批次：先清后补（2026-10-16 用户报障的回归哨兵） ----------
  // 「只补不清」会让上一批的品种永久留在周期窗口里：传过 百泽安+百悦泽 之后再传只有 索托克拉，
  // 窗口会同时挂着三个 → 用户看到「我根本没上传这两个品，怎么还在这儿」。
  console.log('\n===== ②a 换批次：不在本次数据里的品种必须清掉 =====');
  const cycleInputsHtml = () => elStore['cycleInputs'].innerHTML;
  // 先摆出「上一批」的样子：百泽安(内置21)、百悦泽(内置28)，并把百悦泽人工改成 35
  App.syncStdCycles(['百泽安', '百悦泽']);
  App.state.stdCycle['百悦泽'] = 35;
  App.state.qtyScale['百悦泽'] = true;          // 该品种勾了「按数量」
  App.state.qtyScale['百泽安'] = true;
  assert(App.state.stdCycle['百悦泽'] === 35, '前置：人工把百悦泽改成 35');
  // 换批次：本次只有 索托克拉
  App.syncStdCycles(['索托克拉']);
  assert(App.state.stdCycle['百泽安'] == null, '★ 换批次后 百泽安 被清掉（含内置值）');
  assert(App.state.stdCycle['百悦泽'] == null, '★ 换批次后 百悦泽 被清掉（连人工改的 35 一起）');
  assert(App.state.qtyScale['百悦泽'] == null, '★ 未出现品种的「按数量」开关一起清掉');
  assert(App.state.qtyScale['百泽安'] == null, '★ 同上（百泽安）');
  assert(App.state.stdCycle['索托克拉'] === 28, '本次品种 索托克拉 正常补上 28');
  assert(Object.keys(App.state.stdCycle).join(',') === '索托克拉', '窗口集合 == 本次数据品种集合');
  App.renderCycleInputs();
  assert(!cycleInputsHtml().includes('百泽安') && !cycleInputsHtml().includes('百悦泽'),
    '★ 渲染出的周期窗口里没有未上传的品种');

  // ---------- ②b 仍在数据里的品种：人工改过的值要保留（别被重置成内置默认） ----------
  console.log('\n===== ②b 仍在数据里的品种：人工改过的值保留 =====');
  App.syncStdCycles(['索托克拉']);
  App.state.stdCycle['索托克拉'] = 42;
  App.state.qtyScale['索托克拉'] = true;
  App.syncStdCycles(['索托克拉', '新加品种Y']);
  assert(App.state.stdCycle['索托克拉'] === 42, '★ 仍在数据里 → 人工改的 42 保留（没被重置回 28）');
  assert(App.state.qtyScale['索托克拉'] === true, '★ 「按数量」开关保留');
  assert(App.state.stdCycle['新加品种Y'] === 30, '新出现的品种补默认 30');

  // ---------- ②c 清空全部：品种级设置一并清零（没有数据就没有品种） ----------
  console.log('\n===== ②c 清空全部 → 品种级设置清零 =====');
  App.syncStdCycles([]);
  assert(Object.keys(App.state.stdCycle).length === 0, '★ stdCycle 清空');
  assert(Object.keys(App.state.qtyScale).length === 0, '★ qtyScale 清空');
  App.renderCycleInputs();
  assert(cycleInputsHtml().includes('按数据中的品种自动生成'), '★ 窗口回到「开始分析后按数据中的品种自动生成」提示');

  // 复位到后续用例需要的状态
  App.state.stdCycle = {}; App.state.qtyScale = {};
  App.syncStdCycles(['百泽安', '索托克拉', '某新药X']);

  // ---------- ③ renderCycleInputs 只渲染出现品种 ----------
  console.log('\n===== ③ 渲染只含数据品种 =====');
  App.renderCycleInputs();
  const html = elStore['cycleInputs'].innerHTML;
  assert(html.includes('某新药X') && html.includes('value="30"'), '含新品种「某新药X」=30');
  assert(html.includes('索托克拉') && html.includes('value="28"'), '含索托克拉=28');
  assert(!html.includes('百悦泽'), '不含未出现的百悦泽');

  // ---------- ④ buildRows 用动态标准周期计算 ----------
  console.log('\n===== ④ buildRows 按品种使用标准周期 =====');
  function sales(patient, phone, date, product) {
    return { source: 'sales', patient_name: patient, phone, sales_time: date, product,
      hospital: '测试医院', pharmacy: '测试药房', physician: '张医生' };
  }
  App.STORE.sales = [
    sales('甲', '10000000001', '2026-07-01', '索托克拉'),
    sales('乙', '10000000002', '2026-07-01', '某新药X'),
  ];
  App.STORE.followups = []; App.STORE.cycles = {};
  App.state.weekSel = 'this'; App.state.refDate = '';
  const rows = App.buildRows();
  const byName = {};
  for (const r of rows) byName[r.patient_name] = r;
  assert(byName['甲'].cycle_days === 28, `索托克拉周期 = 28（实际 ${byName['甲'].cycle_days}）`);
  assert(byName['乙'].cycle_days === 30, `某新药X周期 = 30（实际 ${byName['乙'].cycle_days}）`);

  // ---------- ⑤ 用户修改后重算 ----------
  console.log('\n===== ⑤ 用户维护新品种周期 =====');
  App.state.stdCycle['某新药X'] = 45;
  const rows2 = App.buildRows();
  const byName2 = {};
  for (const r of rows2) byName2[r.patient_name] = r;
  assert(byName2['乙'].cycle_days === 45, `用户改为 45 后重算 = 45（实际 ${byName2['乙'].cycle_days}）`);

  // ---------- ⑥ 真实数据：只显示实际出现品种 ----------
  console.log('\n===== ⑥ 真实数据实际品种 =====');
  const realPaths = [
    path.join(SAMPLE_DIR, '销售明细查询报表 (47).xlsx'),
    path.join(SAMPLE_DIR, '随访任务导出 (5).xlsx'),
    path.join(SAMPLE_DIR, '患者用药周期表.xlsx'),
  ];
  if (!realPaths.every(p => fs.existsSync(p))) {
    console.log('  ⏭️ 跳过：样例数据文件不在 Downloads 目录（非代码问题）');
  } else {
    function fileObj(p, name) {
      const buf = fs.readFileSync(p);
      return { name: name || path.basename(p), size: buf.length,
        async arrayBuffer(){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } };
    }
    const res = await P.processFiles([
      fileObj(realPaths[0], '销售.xlsx'),
      fileObj(realPaths[1], '随访.xlsx'),
      fileObj(realPaths[2], '周期.xlsx'),
    ]);
    const realProducts = [...new Set(res.sales.map(s => s.product).filter(Boolean))];
    console.log('  [真实数据] 销售明细出现品种:', realProducts.join(' / '));
    App.STORE.sales = res.sales; App.STORE.followups = res.followups; App.STORE.cycles = res.cycles;
    App.state.stdCycle = {};
    App.syncStdCycles(realProducts);
    for (const fam of realProducts) {
      assert(App.state.stdCycle[fam] != null, `品种「${fam}」已有标准周期 ${App.state.stdCycle[fam]} 天`);
    }
    App.renderCycleInputs();
    const html2 = elStore['cycleInputs'].innerHTML;
    for (const fam of realProducts) assert(html2.includes(fam), `周期输入框包含「${fam}」`);
    const notIn = ['索托克拉', '某新药X'].filter(f => !realProducts.includes(f));
    for (const fam of notIn) assert(!html2.includes(fam), `不包含未出现品种「${fam}」`);
  }

  console.log('\n✅ 动态品种标准周期（仅数据品种）—— 全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
