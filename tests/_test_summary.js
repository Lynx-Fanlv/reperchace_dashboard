// 整体小结测试（固定按「本周」统计，口径与周维度状态机一致）
//   本周 = 参考日期所在自然周（周一~周日完整周）
//   应购药 = 下次应购日（最近购药+周期）∈ 本周；实际购药 = 当周有购药记录（含提前购药）
//   未购药 = 应购日∈本周 且 当周未购；下周预计 = 下次应购日∈下周，按随访信号分正常/推迟
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

(async () => {
  // 固定参考日期 2026-08-28（周五）→ 本周 = 08-24(周一) ~ 08-30(周日)；下周 = 08-31 ~ 09-06
  App.state.refDate = '2026-08-28';
  App.state.weekSel = 'this';
  App.state.stdCycle = { 百泽安: 21 };
  App.state.selFam = '百泽安'; App.state.fuAdj = {};

  console.log('===== 准备：构造 10 名患者（周期21天，本周=08-24~08-30） =====');
  // 甲 购药08-03 → 下次应购08-24(本周一) 未购 随访延迟用药
  // 乙 购药08-03 → 下次应购08-24 未购 随访停药·效果不佳 → 脱落(效果不佳)
  // 丙 购药08-03、08-25 → 下次应购09-15(不在本周) 但 08-25 当周购药 → 实际购药（已回购）
  // 丁 购药08-03 → 应购08-24 未购 随访小结含"转渠道"
  // 戊 购药08-03 → 应购08-24 未购 随访任务状态"执行失败"
  // 己 购药08-03 → 应购08-24 未购 随访小结含"医嘱延长"
  // 庚 购药08-03 → 应购08-24 未购 随访小结含"换药"
  // 辛 购药07-30 → 下次应购08-20(<本周一) → 已逾期（不计应购/未购）
  // 壬 购药08-11 → 下次应购09-01(下周) 随访推迟(出差) → 下周预计推迟1
  // 癸 购药08-11 → 下次应购09-01(下周) 随访正常 → 下周预计正常1
  const S = [
    sales('甲', '10000000001', '2026-08-03'),
    sales('乙', '10000000002', '2026-08-03'),
    sales('丙', '10000000003', '2026-08-03'),
    sales('丙', '10000000003', '2026-08-25'),
    sales('丁', '10000000004', '2026-08-03'),
    sales('戊', '10000000005', '2026-08-03'),
    sales('己', '10000000006', '2026-08-03'),
    sales('庚', '10000000007', '2026-08-03'),
    sales('辛', '10000000008', '2026-07-30'),
    sales('壬', '10000000009', '2026-08-11'),
    sales('癸', '10000000010', '2026-08-11'),
  ];
  const F = [
    fu('甲', '10000000001', '2026-08-10', { delay_reason: '经济压力，推迟购药' }),
    fu('乙', '10000000002', '2026-08-10', { stop_reason: '效果不佳，停药' }),
    fu('丁', '10000000004', '2026-08-10', { follow_note: '患者转渠道去外地药房购药' }),
    fu('戊', '10000000005', '2026-08-10', { task_status: '执行失败', follow_note: '' }),
    fu('己', '10000000006', '2026-08-10', { follow_note: '医生建议医嘱延长用药疗程' }),
    fu('庚', '10000000007', '2026-08-10', { follow_note: '患者换药改用其他品种' }),
    fu('壬', '10000000009', '2026-08-15', { delay_reason: '出差在外，推迟购药' }),
    fu('癸', '10000000010', '2026-08-15', { follow_note: '患者规范用药' }),
  ];
  function sales(patient, phone, date) {
    return { source: 'sales', patient_name: patient, phone, sales_time: date, product: '百泽安',
      hospital: 'H', pharmacy: 'P', physician: '张' };
  }
  function fu(patient, phone, exec, extra) {
    return Object.assign({ source: 'followup', patient_name: patient, phone, exec_time: exec, plan_time: exec,
      product: '百泽安', task_status: '已完成', summary_type: '日常随访任务', executor: '李' }, extra || {});
  }
  App.STORE.sales = S; App.STORE.followups = F; App.STORE.cycles = {};
  await App.refresh(); // 触发 buildRows → 模块级 ALL_ROWS 就绪（小结原因判定依赖）

  console.log('\n===== ① 固定本周统计（口径与状态机一致） =====');
  const st = App.buildSummaryStats('百泽安');
  console.log('  本周范围:', st.start, '~', st.end);
  assert(st.start === '2026-08-24' && st.end === '2026-08-30', '本周=周一~周日完整周（与状态机一致）');
  assert(st.due === 6, `应购药 6 人（甲/乙/丁/戊/己/庚）（实际 ${st.due}）`);
  assert(st.bought === 1, `实际购药 1 人（丙，当周购药）（实际 ${st.bought}）`);
  assert(st.notBought === 6, `未购药 6 人（实际 ${st.notBought}）`);
  assert(st.cnt.delay === 1 && st.cnt.dropout_effect === 1 && st.cnt.channel === 1 &&
    st.cnt.fuFail === 1 && st.cnt.prolong === 1 && st.cnt.switch === 1, '原因细分 各1人');
  assert(st.dTotal === 1, '脱落合计 1 人');
  assert(st.normal === 1 && st.postpone === 1, `下周预计 正常1/推迟1（实际 正常${st.normal}/推迟${st.postpone}）`);
  assert(st.nextTotal === 2, `下周预计合计 2 人（壬/癸）（实际 ${st.nextTotal}）`);

  console.log('\n===== ② 与状态机一致性核对 =====');
  // 小结「未购药」应等于状态机本周「应回购」；「实际购药」应等于「已回购」
  const rows = App.buildRows();
  const ying = rows.filter(r => r.status === '应回购').length;
  const repur = rows.filter(r => r.status === '已回购').length;
  assert(st.notBought === ying, `未购药 ${st.notBought} = 状态机应回购 ${ying}`);
  assert(st.bought === repur, `实际购药 ${st.bought} = 状态机已回购 ${repur}`);
  assert(st.due >= st.notBought, '应购药 ≥ 未购药');

  console.log('\n===== ③ 文案格式 =====');
  const { text } = App.buildSummaryText('百泽安');
  console.log(text.split('\n').map(l => '  | ' + l).join('\n'));
  assert(text.includes('本周小结（百泽安）：'), '标题按品种');
  assert(text.includes('1. 本周老患者应购药 6 人，实际购药 1 人，未购药 6 人；'), '第1行数字正确');
  assert(text.includes('①延迟用药1人、②脱落1人（效果不佳1/自觉好转0/不良反应0/经济0/其他0）、③转渠道1人、④随访失败未探寻原因1人、⑤医嘱延长1人、⑥换药1人'), '第2行原因正确');
  assert(text.includes('4. 下周预计复购 2 人，预计正常回购 1 人，推迟 1 人') && text.includes('出差'), '第4行下周预计+推迟原因');

  console.log('\n===== ④ 人工修正 =====');
  App.state.fuAdj['百泽安'] = { delay: 3 };
  const text2 = App.buildSummaryText('百泽安').text;
  assert(text2.includes('①延迟用药3人'), `人工修正后延迟用药 3 人`);
  App.state.fuAdj['百泽安'] = {};

  console.log('\n===== ⑤ 固定本周：不受周期控件影响 =====');
  // 用户确认：小结固定按「本周」，不随近7天/自定义选项变化
  App.state.periodType = '7d';
  const stA = App.buildSummaryStats('百泽安');
  App.state.periodType = 'custom'; App.state.periodStart = '2026-01-01'; App.state.periodEnd = '2026-12-31';
  const stB = App.buildSummaryStats('百泽安');
  assert(stA.due === 6 && stB.due === 6 && stA.bought === stB.bought, '近7天/自定义选项均不影响统计（固定本周）');
  App.state.periodType = '7d';

  console.log('\n===== ⑥ 周视图切换不影响小结（小结固定本周） =====');
  App.state.weekSel = 'last'; await App.refresh();
  const stC = App.buildSummaryStats('百泽安');
  assert(stC.start === '2026-08-24' && stC.due === 6, `切上周视图，小结仍统计本周（实际 ${stC.start} 应购${stC.due}）`);
  App.state.weekSel = 'this'; await App.refresh();

  console.log('\n✅ 整体小结测试全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
