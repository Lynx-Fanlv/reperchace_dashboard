// 停药/减量根本原因分布验证：原值分组、按患者去重计数、跟随筛选、不显示占比
const fs = require('fs');
const path = require('path');

function makeEl(id) {
  const el = { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {}, children: [],
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, insertBefore(){}, removeChild(){},
    querySelectorAll(){ return []; },
    click(){}, remove(){},
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null };
  return el;
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
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  ✅ ' + name + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + name + ' → 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } };

// 构造名单行：_matched 为匹配到的随访记录，原因取自三个原值字段
const mk = (_key, name, stop, delay, drop, extra) => Object.assign({
  _key, product: '百泽安', patient_name: name, phone: _key, executor: '刘倩',
  _matched: { stop_reason: stop || null, delay_reason: delay || null, dropout_reason: drop || null,
    exec_time: '2026-09-08', plan_time: null },
}, extra || {});

const rows = [
  mk('13800000001', '甲', '经济原因', null, null),          // 停药
  mk('13800000002', '乙', '经济原因', null, null),          // 停药（同原因）
  mk('13800000003', '丙', null, '医生建议延后', null),      // 减量
  mk('13800000004', '丁', null, '医生建议延后', null),      // 减量（同原因）
  mk('13800000005', '戊', null, null, '经济原因'),          // 易脱落原因 → 与「经济原因」合并
  mk('13800000006', '己', '不良反应', '不良反应', null),     // 同一患者同原因出现两次 → 只计一次
  mk('13800000007', '庚', null, null, null),                // 无原因 → 不计
  { _key: '13800000008', product: '百泽安', patient_name: '辛', phone: '13800000008', _matched: null }, // 无随访 → 不计
];
App.DATA.rows = rows;

console.log('\n[1] 按原值分组、按患者去重计数');
let d = App.buildReasonDist();
const byLabel = Object.fromEntries(d.items.map(x => [x.label, x.n]));
eq('唯一原因数', d.items.length, 3);
eq('经济原因（停药+易脱落两字段合并）', byLabel['经济原因'], 3);
eq('医生建议延后', byLabel['医生建议延后'], 2);
eq('不良反应（同患者同时命中两字段只计一次）', byLabel['不良反应'], 1);
eq('覆盖人数（有明确原因的患者）', d.patients, 6);
ok('无原因/无随访的患者不计入', !('' in byLabel) && d.patients === 6);

console.log('\n[2] 按人数降序排列');
eq('排序', d.items.map(x => x.label), ['经济原因', '医生建议延后', '不良反应']);
eq('首位人数', d.items[0].n, 3);

console.log('\n[3] 明细里带上患者与随访人（供点击展开）');
const top = d.items.find(x => x.label === '经济原因');
eq('明细人数', top.people.length, 3);
eq('明细首位执行人', top.people[0].executor, '刘倩');
ok('明细含随访时间', /^\d{4}-\d{2}-\d{2}$/.test(top.people[0].fuTime));

console.log('\n[4] 跟随筛选区条件（缩小范围后计数随之变化）');
App.DATA.rows = rows.filter(r => r._key === '13800000001' || r._key === '13800000003');
d = App.buildReasonDist();
eq('筛选后原因数', d.items.length, 2);
eq('筛选后覆盖人数', d.patients, 2);
eq('筛选后经济原因', d.items.find(x => x.label === '经济原因').n, 1);
App.DATA.rows = rows;

console.log('\n[5] 长尾折叠：超过 12 项才折叠为「其他」');
const many = [];
for (let i = 1; i <= 20; i++) many.push(mk('1390000' + String(i).padStart(4, '0'), '患' + i, '原因' + i, null, null));
App.DATA.rows = many;
d = App.buildReasonDist();
eq('总原因项数', d.items.length, 20);
eq('展示条数（上限 12）', d.head.length, 12);
eq('折叠项数', d.tailCount, 8);
eq('折叠覆盖人数', d.tailPeople, 8);
eq('覆盖总人数', d.patients, 20);

console.log('\n[6] 少于等于 12 项时不折叠');
App.DATA.rows = many.slice(0, 12);
d = App.buildReasonDist();
eq('折叠项数', d.tailCount, 0);

console.log('\n[7] 空数据 / 全无原因时不展示');
App.DATA.rows = [];
d = App.buildReasonDist();
eq('空数据人数', d.patients, 0);
App.DATA.rows = [mk('13800000099', '无原因患者', null, null, null)];
d = App.buildReasonDist();
eq('全无原因时人数', d.patients, 0);
eq('全无原因时无条目', d.items.length, 0);

console.log('\n[8] 小结纯文本版（复制小结时附带）');
App.DATA.rows = rows;
const scoped = App.buildSummaryText('');
ok('小结含「停药/减量根本原因」行', scoped.text.includes('停药/减量根本原因'));
ok('该行含首位原因与人数', scoped.text.includes('经济原因 3 人'));
ok('该行标注跟随筛选区条件', scoped.text.includes('跟随筛选区条件'));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
