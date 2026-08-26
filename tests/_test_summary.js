// 整体小结测试：应购/实购/未购统计、未购药原因细分、下周预计、人工修正、周期切换
const fs = require('fs');
const path = require('path');
const elStore = {};
function makeEl(id) {
  return {
    id, _html: '', textContent: '', value: '', disabled: false, style: {}, dataset: {}, scrollTop: 0,
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
const App = global.AppCore, M = global.Mapping;

function assert(cond, msg) {
  if (!cond) throw new Error('❌ ' + msg);
  console.log('  ✅ ' + msg);
}
const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };
const daysLater = n => { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };
function sales(patient, phone, date) {
  return { source: 'sales', patient_name: patient, phone, sales_time: date, product: '百泽安',
    hospital: 'H', pharmacy: 'P', physician: '张' };
}
function fu(patient, phone, exec, extra) {
  return Object.assign({ source: 'followup', patient_name: patient, phone, exec_time: exec, plan_time: exec,
    product: '百泽安', task_status: '已完成', summary_type: '日常随访任务', executor: '李' }, extra || {});
}

(async () => {
  console.log('===== 准备：构造 10 名患者（周期21天） =====');
  // A 应购(25天前购药→应购4天前) 未购 随访延迟用药
  // B 应购 未购 随访停药·效果不佳 → 脱落(效果不佳)
  // C 应购(25天前) 但 2天前已购 → 实际购药
  // D 应购 未购 随访小结含"转渠道"
  // E 应购 未购 随访任务状态"执行失败"
  // F 应购 未购 随访小结含"医嘱延长"
  // G 应购 未购 随访小结含"换药"
  // H 30天前购药→应购9天前（不在7天窗口）→ 不计
  // J 16天前购药→应购5天后（下周）随访推迟(出差)
  // K 16天前购药→应购5天后（下周）随访正常
  const S = [
    sales('甲', '10000000001', daysAgo(25)),
    sales('乙', '10000000002', daysAgo(25)),
    sales('丙', '10000000003', daysAgo(25)),
    sales('丙', '10000000003', daysAgo(2)),
    sales('丁', '10000000004', daysAgo(25)),
    sales('戊', '10000000005', daysAgo(25)),
    sales('己', '10000000006', daysAgo(25)),
    sales('庚', '10000000007', daysAgo(25)),
    sales('辛', '10000000008', daysAgo(30)),
    sales('壬', '10000000009', daysAgo(16)),
    sales('癸', '10000000010', daysAgo(16)),
  ];
  const F = [
    fu('甲', '10000000001', daysAgo(6), { delay_reason: '经济压力，推迟购药' }),
    fu('乙', '10000000002', daysAgo(6), { stop_reason: '效果不佳，停药' }),
    fu('丁', '10000000004', daysAgo(6), { follow_note: '患者转渠道去外地药房购药' }),
    fu('戊', '10000000005', daysAgo(6), { task_status: '执行失败', follow_note: '' }),
    fu('己', '10000000006', daysAgo(6), { follow_note: '医生建议医嘱延长用药疗程' }),
    fu('庚', '10000000007', daysAgo(6), { follow_note: '患者换药改用其他品种' }),
    fu('壬', '10000000009', daysAgo(6), { delay_reason: '出差在外，推迟购药' }),
    fu('癸', '10000000010', daysAgo(6), { follow_note: '患者规范用药' }),
  ];
  App.STORE.sales = S; App.STORE.followups = F; App.STORE.cycles = {};
  App.state.stdCycle = { 百泽安: 21 };
  App.state.periodType = '7d'; App.state.periodStart = ''; App.state.periodEnd = '';
  App.state.selFam = '百泽安'; App.state.fuAdj = {};
  await App.refresh(); // 触发 buildRows → 模块级 ALL_ROWS 就绪（小结统计依赖）

  console.log('\n===== ① 近7天统计 =====');
  const st = App.buildSummaryStats('百泽安');
  assert(st.due === 7, `本周应购药 7 人（实际 ${st.due}）`);
  assert(st.bought === 1, `实际购药 1 人（丙）（实际 ${st.bought}）`);
  assert(st.notBought === 6, `未购药 6 人（实际 ${st.notBought}）`);
  assert(st.cnt.delay === 1 && st.cnt.dropout_effect === 1 && st.cnt.channel === 1 &&
    st.cnt.fuFail === 1 && st.cnt.prolong === 1 && st.cnt.switch === 1, '原因细分 各1人');
  assert(st.dTotal === 1, '脱落合计 1 人');
  assert(st.normal === 1 && st.postpone === 1, `下周预计 正常1/推迟1（实际 正常${st.normal}/推迟${st.postpone}）`);

  console.log('\n===== ② 文案格式 =====');
  const { text } = App.buildSummaryText('百泽安');
  console.log(text.split('\n').map(l => '  | ' + l).join('\n'));
  assert(text.includes('本周小结（百泽安）：'), '标题按品种');
  assert(text.includes('1. 本周老患者应购药 7 人，实际购药 1 人，未购药 6 人；'), '第1行数字正确');
  assert(text.includes('①延迟用药1人、②脱落1人（效果不佳1/自觉好转0/不良反应0/经济0/其他0）、③转渠道1人、④随访失败未探寻原因1人、⑤医嘱延长1人、⑥换药1人'), '第2行原因正确');
  assert(text.includes('4. 下周预计复购 2 人，预计正常回购 1 人，推迟 1 人') && text.includes('出差'), '第4行下周预计+推迟原因');

  console.log('\n===== ③ 人工修正 =====');
  App.state.fuAdj['百泽安'] = { delay: 3 };
  const text2 = App.buildSummaryText('百泽安').text;
  assert(text2.includes('①延迟用药3人'), `人工修正后延迟用药 3 人`);
  App.state.fuAdj['百泽安'] = {};

  console.log('\n===== ④ 周期切换（自定义近 20 天） =====');
  App.state.periodType = 'custom'; App.state.periodStart = daysAgo(20); App.state.periodEnd = daysAgo(0);
  const st2 = App.buildSummaryStats('百泽安');
  // 20天窗口 [8/6,今天]：应购=8（含辛8/11）；实购=3（丙8/24、壬8/10、癸8/10）；未购=7
  assert(st2.due === 8, `自定义20天 应购 8 人（实际 ${st2.due}）`);
  assert(st2.bought === 3 && st2.notBought === 7, `实购3/未购7（实际 ${st2.bought}/${st2.notBought}）`);
  App.state.periodType = '7d';

  console.log('\n✅ 整体小结测试全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
