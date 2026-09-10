// 「本周」时间范围可配置（周起始日）回归验证
// 覆盖：自然周（周一）/ 上周六~本周五（周六）/ 周日~周六（周日）、边界日、上周下周平移、默认值
const fs = require('fs');
const path = require('path');

function makeEl(id) {
  return { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, insertBefore(){}, removeChild(){}, querySelectorAll(){ return []; },
    click(){}, remove(){},
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null };
}
global.window = global;
global.document = {
  querySelector(sel){ return makeEl(String(sel)); }, querySelectorAll(){ return []; },
  addEventListener(){}, createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html></html>' }, body: { appendChild(){}, remove(){}, removeChild(){} },
};
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.ExcelJS = require(path.join(__dirname, '..', 'vendor', 'exceljs.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const App = global.AppCore;
const S = App.state;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('  ✅ ' + name + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + name + ' → 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const wdOf = d => WD[new Date(d + "T00:00:00").getDay()];
const rng = sel => { const w = App.getWeekRange(sel); return w.start + "~" + w.end; };

// 2026-09-10 是周四
S.refDate = '2026-09-10';

console.log('\n[1] 默认值 = 周一（自然周），保持既有行为');
eq('state.weekStart 默认', S.weekStart, 1);
S.weekStart = 1;
eq('本周（周一~周日）', rng('this'), '2026-09-07~2026-09-13');
eq('上周', rng('last'), '2026-08-31~2026-09-06');
eq('下周', rng('next'), '2026-09-14~2026-09-20');

console.log('\n[2] 周六起始 = 上周六~这周五（用户举例）');
S.weekStart = 6;
eq('本周（上周六~本周五）', rng('this'), '2026-09-05~2026-09-11');
eq('上周', rng('last'), '2026-08-29~2026-09-04');
eq('下周', rng('next'), '2026-09-12~2026-09-18');
eq('起始日星期核对', wdOf(App.getWeekRange('this').start), '周六');
eq('结束日星期核对', wdOf(App.getWeekRange('this').end), '周五');

console.log('\n[3] 周日起始 = 周日~周六');
S.weekStart = 0;
eq('本周（周日~周六）', rng('this'), '2026-09-06~2026-09-12');
eq('起始日星期核对', wdOf(App.getWeekRange('this').start), '周日');

console.log('\n[4] 边界：参考日恰好是起始日 / 是结束日');
S.weekStart = 6;
S.refDate = '2026-09-05';               // 周六 = 起始日当天
eq('参考日=周六（起始日当天）', rng('this'), '2026-09-05~2026-09-11');
S.refDate = '2026-09-11';               // 周五 = 结束日当天
eq('参考日=周五（结束日当天，仍属同一窗口）', rng('this'), '2026-09-05~2026-09-11');
S.refDate = '2026-09-12';               // 下一天周六 → 进入下一个窗口
eq('参考日=次周周六 → 窗口滚动', rng('this'), '2026-09-12~2026-09-18');

console.log('\n[5] 每周起始日都自洽（窗口 7 天 / 含参考日 / 上周下周各平移 7 天）');
S.refDate = '2026-09-10';
let allOk = true, detail = '';
for (let d = 0; d < 7; d++) {
  S.weekStart = d;
  const w = App.getWeekRange('this');
  const last = App.getWeekRange('last'), next = App.getWeekRange('next');
  const dayMs = 86400000;
  const span = (new Date(w.end) - new Date(w.start)) / dayMs;
  const shiftL = (new Date(w.start) - new Date(last.start)) / dayMs;
  const shiftN = (new Date(next.start) - new Date(w.start)) / dayMs;
  const contains = S.refDate >= w.start && S.refDate <= w.end;
  const ok = wdOf(w.start) === WD[d] && span === 6 && shiftL === 7 && shiftN === 7 && contains;
  if (!ok) { allOk = false; detail += ` [${WD[d]}: span=${span} L=${shiftL} N=${shiftN} 含参考日=${contains}]`; }
}
eq('7 种起始日全部自洽', allOk ? 'OK' : 'FAIL' + detail, 'OK');

console.log('\n[6] 小结「下周预计」窗口 = 所选周之后紧邻 7 天');
S.weekStart = 1;
const W = App.getWeekRange('this');
const nS = new Date(W.end); nS.setDate(nS.getDate() + 1);
const nE = new Date(W.end); nE.setDate(nE.getDate() + 7);
const iso = d => d.toISOString().slice(0, 10);
eq('自然周下，下周窗口', iso(nS) + "~" + iso(nE), '2026-09-14~2026-09-20');
S.weekStart = 6;
const W6 = App.getWeekRange('this');
const mS = new Date(W6.end); mS.setDate(mS.getDate() + 1);
const mE = new Date(W6.end); mE.setDate(mE.getDate() + 7);
eq('周六起时，下周窗口随之平移', iso(mS) + "~" + iso(mE), '2026-09-12~2026-09-18');

S.weekStart = 1; S.refDate = '';
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
