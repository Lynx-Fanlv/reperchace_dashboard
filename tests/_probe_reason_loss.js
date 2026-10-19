// 机制验证：回传表只带「随访小结」一列文本，随访信号字段（用药状态/停药原因/推迟原因…）全部不带
// → 新一轮若不上传原始随访表，自动判定的「未购药原因」会丢失/降级。
const fs = require('fs');
global.window = global;
new Function(fs.readFileSync('mapping.js', 'utf8'))();
const M = global.Mapping;

const keyOf = c => c ? (c.key === 'dropout'
  ? 'dropout_' + (c.detail === '换药' ? 'switch' : c.detail === '经济' ? 'econ' : c.detail === '去世' ? 'death' : 'other')
  : c.key) : '';

// 现场 1：原因写在随访信号列，随访小结是通用文案
const real = { product: '百悦泽', summary_type: '常规随访', task_status: '已完成',
  exec_time: '2027-01-05 09:00:00', follow_note: '已电话随访，患者接听',
  usage_status: '已停药', purchased_on_time: '已停药', is_dropout: '是',
  stop_reason: '经济困难，负担不起', delay_reason: null, dropout_reason: null,
  still_using: null, near_usage: null, dosage: null };
// 回传表记录：服务摘要=跟进回传，只带 随访小结
const cb = { product: '百悦泽', summary_type: '跟进回传', task_status: '已完成',
  exec_time: '2027-01-13', follow_note: '已电话随访，患者接听',
  usage_status: null, purchased_on_time: null, is_dropout: null,
  stop_reason: null, delay_reason: null, dropout_reason: null,
  still_using: null, near_usage: null, dosage: null };

console.log('现场1：原因只写在随访信号列（小结为通用文案）');
console.log('  真实随访   → 信号 ' + JSON.stringify(M.followupSignal(real)) + ' | 原因key ' + JSON.stringify(keyOf(M.classifyFuReason(real))));
console.log('  回传表记录 → 信号 ' + JSON.stringify(M.followupSignal(cb)) + ' | 原因key ' + JSON.stringify(keyOf(M.classifyFuReason(cb))));

// 现场 2：小结文本里恰好含「停药 / 经济」关键词
const real2 = Object.assign({}, real, { follow_note: '患者自述经济压力大，已停药' });
const cb2 = Object.assign({}, cb, { follow_note: '患者自述经济压力大，已停药' });
console.log('现场2：小结文本里恰好含关键词（运气好）');
console.log('  真实随访   → 原因key ' + JSON.stringify(keyOf(M.classifyFuReason(real2))));
console.log('  回传表记录 → 原因key ' + JSON.stringify(keyOf(M.classifyFuReason(cb2))));

// 现场 3：原因=推迟用药的原因
const real3 = Object.assign({}, real, { usage_status: '规范用药', stop_reason: null, is_dropout: '否',
  delay_reason: '医生建议推迟一周', follow_note: '已联系' });
const cb3 = { product: '百悦泽', summary_type: '跟进回传', follow_note: '已联系',
  usage_status: null, purchased_on_time: null, is_dropout: null, stop_reason: null,
  delay_reason: null, dropout_reason: null, still_using: null };
console.log('现场3：原因=推迟用药的原因');
console.log('  真实随访   → 原因key ' + JSON.stringify(keyOf(M.classifyFuReason(real3))));
console.log('  回传表记录 → 原因key ' + JSON.stringify(keyOf(M.classifyFuReason(cb3))));

// 现场 4：随访类型与随访时间（回传表带不回原值）
console.log('现场4：随访识别字段');
console.log('  真实随访   → 随访类型=' + JSON.stringify(real.summary_type) + ' 随访时间=' + JSON.stringify(real.exec_time.slice(0, 10)));
console.log('  回传表记录 → 随访类型=' + JSON.stringify(cb.summary_type) + ' 随访时间=' + JSON.stringify(cb.exec_time));
