// 需求2/3 回归测试：
//  需求2 —— 列表内可修改某患者的用药周期（粒度=患者×品种），优先级 人工设置 > 周期表 > 标准周期 > 30
//  需求3 —— 长文本（药品英文名/长诊断）不再撑开表格：品种/医院/医生等列走单行截断 + 悬停全文
const fs = require('fs');
const path = require('path');
const elStore = {};
function makeEl(id) {
  return {
    id, _html: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    scrollTop: 0, title: '',
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
global.scrollTo = () => {};
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
const App = global.AppCore;
const P = global.Pipeline;

function assert(cond, msg) {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('  ✅ ' + msg);
}

// 构造一名患者（姓名+电话）的销售记录：2026-08-01 首购、2026-09-01 末购
const NAME = '测试患者', PHONE = '13800001111';
function saleRec(date, product) {
  return { source: 'sales', _row_id: 'f::sales::s::' + date, sales_time: date, order_status: '已完成',
    product_raw: product, product, qty: '1', amount: '1000', member_id: 'M1',
    patient_name: NAME, phone: PHONE, hospital: '测试医院', pharmacy: '测试药房',
    physician: '张医生', department: '肿瘤科', indication: '肺癌', age: '60', gender: '男' };
}

(async () => {
  App.STORE.sales = [saleRec('2026-08-01', '百泽安'), saleRec('2026-09-01', '百泽安')];
  App.STORE.followups = [];
  App.STORE.cycles = {};
  App.STORE.notes = {};
  App.STORE.reasonOverrides = {};
  App.STORE.cycleOverrides = {};
  App.state.stdCycle = { '百泽安': 21 };
  App.state.cycleAlgo = 'reset';
  App.state.refDate = '2026-09-20';
  App.state.weekSel = 'this';

  const key = P.patientKey(NAME, PHONE);
  const ovKey = key + '::' + '百泽安';

  console.log('===== 需求2：周期取值优先级 =====');
  let rows = App.buildRows();
  assert(rows.length === 1, '构造出 1 行（患者 × 品种）');
  let r = rows[0];
  assert(r.cycle_days === 21, '默认取标准周期 21 天');
  assert(r.cycle_source === 'default', '来源标记 = default（未人工覆盖）');
  assert(r.cycle_base === 21, 'cycle_base = 21（未覆盖时会采用的值）');

  // ① 周期表优先于标准周期
  App.STORE.cycles[NAME] = 28;
  rows = App.buildRows(); r = rows[0];
  assert(r.cycle_days === 28, '周期表(28) 优先于标准周期(21)');
  App.STORE.cycles[NAME] = 21;

  // ② 人工设置优先于周期表
  App.STORE.cycles[NAME] = 28;
  App.STORE.cycleOverrides[ovKey] = 35;
  rows = App.buildRows(); r = rows[0];
  assert(r.cycle_days === 35, '人工设置(35) 优先于周期表(28)');
  assert(r.cycle_source === 'override', '来源标记 = override');
  assert(r.cycle_base === 28, 'cycle_base 保留周期表值 28（供「清空即恢复」提示）');

  console.log('\n===== 需求2：周期改变会真实影响应购日期 =====');
  // 末购 2026-09-01，重置式 → 应购日 = 09-01 + 周期
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n);
    const p = x => String(x).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()); };
  assert(r.due_date === addDays('2026-09-01', 35), `周期35 → 应购日 = 09-01+35 = ${addDays('2026-09-01', 35)}`);
  App.STORE.cycleOverrides[ovKey] = 10;
  rows = App.buildRows(); r = rows[0];
  assert(r.due_date === addDays('2026-09-01', 10), `周期改为10 → 应购日同步变为 ${addDays('2026-09-01', 10)}`);

  // ③ 清空 = 恢复默认
  delete App.STORE.cycleOverrides[ovKey];
  App.STORE.cycles = {};
  rows = App.buildRows(); r = rows[0];
  assert(r.cycle_days === 21 && r.cycle_source === 'default', '清空人工设置后恢复标准周期 21');

  console.log('\n===== 需求2：粒度是「患者 × 品种」而非仅患者 =====');
  App.STORE.sales = [saleRec('2026-08-01', '百泽安'), saleRec('2026-09-01', '百泽安'),
                     saleRec('2026-08-01', '百悦泽'), saleRec('2026-09-01', '百悦泽')];
  App.state.stdCycle = { '百泽安': 21, '百悦泽': 28 };
  App.STORE.cycleOverrides = {};
  App.STORE.cycleOverrides[key + '::百泽安'] = 14;
  rows = App.buildRows();
  const rBz = rows.find(x => x.product === '百泽安');
  const rBy = rows.find(x => x.product === '百悦泽');
  assert(rows.length === 2, '同一患者两个品种 → 2 行');
  assert(rBz.cycle_days === 14, '百泽安 行取人工设置 14');
  assert(rBy.cycle_days === 28, '百悦泽 行不受影响，仍为标准周期 28');
  assert(rBy.cycle_source === 'default', '百悦泽 来源 = default（未被误改）');

  console.log('\n===== 需求2：两行渲染出可点击的周期单元格 =====');
  App.DATA.rows = rows;
  App.state.page = 1; App.state.pageSize = 50;
  App.renderTable();
  const tb = elStore['tbody'].innerHTML;
  assert(tb.includes('class="cycle-edit over"'), '已人工设置的行：周期单元格带 over 样式（实心标识）');
  // 周期单元格刻意不挂 data-key：patientKey 含 \u0000，在 HTML 属性里会被替换成 U+FFFD 导致键失配；
  // 键改由 renderTable 用行索引回查 DATA.rows 现算（浏览器端由 _geom_probe 验证）
  assert(!/class="cycle-edit[^"]*"\s+data-key=/.test(tb), '周期单元格不通过 DOM 传键（规避 \\u0000 被属性解析污染）');
  assert((tb.match(/class="cycle-edit/g) || []).length === 2, '两行都渲染出可编辑周期单元格');
  assert((tb.match(/ce-dot/g) || []).length === 1, '仅被改动的那一行显示「已单独设置」圆点');

  console.log('\n===== 需求3：长文本不再撑开表格 =====');
  // 构造超长英文药品名（无空格，无法自然断行）与长诊断
  const LONG_PROD = '无菌笔式注射针INSUPENSterilePenNeedleVeryLongNameForTest';
  App.STORE.sales = [saleRec('2026-08-01', '百泽安'), saleRec('2026-09-01', '百泽安')];
  App.STORE.cycles = {}; App.STORE.cycleOverrides = {};
  App.state.stdCycle = { '百泽安': 21 };
  rows = App.buildRows();
  rows[0].product = LONG_PROD;
  rows[0].hospital = '成都医学院第一附属医院(原:中国人民解放军第47医院)';
  rows[0].indication = '卵巢恶性肿瘤术后复发多处转移TxNxM1IV期结肠继发恶性肿瘤直肠继发恶性肿瘤';
  App.DATA.rows = rows;
  App.renderTable();
  const tb2 = elStore['tbody'].innerHTML;

  assert(tb2.includes('class="tag-prod"') && tb2.includes('title="' + LONG_PROD + '"'),
    '品种列使用 .tag-prod 并带 title 悬停全文（CSS 已限宽省略）');
  assert(tb2.includes('title="' + LONG_PROD + '（点击展开全文）"') === false,
    '品种列不重复挂展开提示（由 .tag-prod 自带省略）');
  assert(tb2.includes('class="clip1 clip-x"'), '长文本列渲染为 .clip1（单行截断）+ .clip-x（可点击展开）');
  assert(tb2.includes('（点击展开全文）'), '截断单元格带「点击展开全文」悬停提示');
  assert(tb2.includes('clip2'), '随访类型/信号列使用两行截断 .clip2');

  // 校验样式表确实定义了限宽与断行
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'index.template.html'), 'utf8');
  assert(/\.tag-prod\{[^}]*max-width:100%/.test(tpl), '样式：.tag-prod 有 max-width:100% 限宽');
  assert(/\.tag-prod\{[^}]*text-overflow:ellipsis/.test(tpl), '样式：.tag-prod 有 ellipsis 省略');
  assert(/table\{[^}]*table-layout:fixed/.test(tpl), '样式：table-layout:fixed（列宽不再被内容撑开）');
  assert(/th,td\{[^}]*overflow-wrap:anywhere/.test(tpl), '样式：单元格 overflow-wrap:anywhere（超长串可断行）');
  assert(!/th\{[^}]*white-space:nowrap/.test(tpl), '样式：已移除 th 的 white-space:nowrap（长表头不再撑列）');
  assert(/\.clip1\{[^}]*text-overflow:ellipsis/.test(tpl), '样式：.clip1 单行省略已定义');
  assert(/\.clip2\{[^}]*-webkit-line-clamp:2/.test(tpl), '样式：.clip2 两行截断已定义');

  console.log('\n✅ 需求2/3 回归测试全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
