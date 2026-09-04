// 复现：模拟从 index.single.html / index.html 页面点“导出快照”，生成快照文件供无头浏览器验证
const fs = require('fs');
const path = require('path');
const which = process.argv[2] || 'single'; // single | multi
const PAGE = path.join(__dirname, '..', which === 'single' ? 'index.single.html' : 'index.html');
const OUT = path.join(__dirname, `..', '_snap_test_${which}.html`.replace("'", ''));

const elStore = {};
function makeEl(id) {
  return { id, _html: '', textContent: '', value: '', disabled: false, style: {}, dataset: {}, scrollTop: 0,
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, insertBefore(){}, removeChild(){}, querySelectorAll(){ return []; },
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null,
    get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } };
}
global.window = global;
let captured = null;
global.URL = { createObjectURL(b){ captured = b; return 'blob:x'; }, revokeObjectURL(){} };
global.document = {
  querySelector(sel){ const k = String(sel).replace(/^#/, ''); if (!elStore[k]) elStore[k] = makeEl(k); return elStore[k]; },
  querySelectorAll(){ return []; }, addEventListener(){}, createElement(){ return makeEl('c'); },
  documentElement: { outerHTML: fs.readFileSync(PAGE, 'utf8') }, body: { appendChild(){}, remove(){} },
};
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const P = global.Pipeline, App = global.AppCore;

(async () => {
  // 真实数据塞入
  const D = 'C:/Users/yym/Downloads/';
  function fileObj(p, name) {
    const buf = fs.readFileSync(p);
    return { name: name || path.basename(p), size: buf.length,
      async arrayBuffer(){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } };
  }
  const salesF = fs.readdirSync(D).filter(f => /^销售明细查询报表 \(\d+\)\.xlsx$/.test(f)).sort().pop();
  const fuF = fs.readdirSync(D).filter(f => /^随访任务导出 \(\d+\)\.xlsx$/.test(f)).sort().pop();
  console.log('用文件:', salesF, '/', fuF);
  const res = await P.processFiles([fileObj(D + salesF, 's.xlsx'), fileObj(D + fuF, 'f.xlsx')]);
  App.STORE.sales = res.sales; App.STORE.followups = res.followups; App.STORE.cycles = {};
  App.state.stdCycle = {};
  App.ensureStdCycles([...new Set(res.sales.map(s => s.product))]);
  App.state.refDate = ''; App.state.weekSel = 'this';
  await App.refresh();
  // 触发导出快照按钮（desen）
  const btn = document.querySelector('#snapshotDesenBtn');
  if (!btn || typeof btn.onclick !== 'function') { console.error('快照按钮未绑定'); process.exit(1); }
  await btn.onclick();
  if (!captured) { console.error('未捕获快照 Blob'); process.exit(1); }
  const text = Buffer.from(await captured.arrayBuffer()).toString('utf8');
  fs.writeFileSync(OUT, text);
  console.log('快照已生成:', OUT, text.length, '字节');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
