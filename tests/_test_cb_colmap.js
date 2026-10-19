// 校验：新回传表（19 列）能否被导入侧按预期映射回 fu 字段，且旧回传表（10 列）仍兼容。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'mapping.js'), 'utf8'))();
const M = global.Mapping;
global.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
new Function(fs.readFileSync(path.join(ROOT, 'pipeline.js'), 'utf8'))();
const P = global.Pipeline;

const NEW_HEAD = ["任务状态", "服务摘要", "患者姓名", "联系电话", "产品", "执行时间", "执行人",
  "未购药原因", "跟进备注", "随访小结", "原随访类型", "原随访时间", "患者目前的用药状态是？",
  "是否已按时购药", "是否判定患者属于易脱落（失访/停药）高风险", "判断为易脱落的原因",
  "还在按照处方继续使用", "推迟用药的原因", "停药的原因是什么"];
const OLD_HEAD = NEW_HEAD.slice(0, 10);

// pipeline 没导出 mapColumns，用 normalizeSheet 走一遍真实路径更保险 → 用 loadWorkbook 不可用（需 File）
// 这里直接构造 aoa 走 normalizeSheet 的等价流程：XLSX 写内存 → 读回 → 同 loadWorkbook 逻辑
const XLSX = global.XLSX;
function sheetOf(header, rows) {
  const aoa = [header].concat(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "随访回传");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return buf;
}

(async () => {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const okv = JSON.stringify(got) === JSON.stringify(want);
    okv ? pass++ : fail++;
    console.log((okv ? '  ✅ ' : '  ❌ ') + n + ' → ' + JSON.stringify(got) + (okv ? '' : '，期望 ' + JSON.stringify(want)));
  };

  const dataRow = ["已完成", "跟进回传", "甘斌元", "18980336951", "百悦泽", "2026-09-30", "刘倩",
    "推迟购药", "备注内容A", "小结内容B", "常规随访", "2027-01-05", "已停药", "否", "是",
    "经济困难", "是", "医生建议推迟一周", "负担不起"];
  const buf = sheetOf(NEW_HEAD, [dataRow]);

  const res = await P.processFiles([{ name: "随访回传_2026-09-30.xlsx", arrayBuffer: async () => buf }]);
  console.log('识别结果：销售 ' + res.sales.length + ' 条 / 随访 ' + res.followups.length + ' 条 / 周期 '
    + Object.keys(res.cycles).length + ' 个品种');
  eq('识别为随访表（未误判为销售/周期）', res.followups.length, 1);
  const f = res.followups[0] || {};
  eq('服务摘要=跟进回传（识别标记未被原随访类型抢走）', f.summary_type, '跟进回传');
  eq('原随访类型', f.orig_fu_type, '常规随访');
  eq('原随访时间', f.orig_fu_time, '2027-01-05');
  eq('患者姓名', f.patient_name, '甘斌元');
  eq('联系电话', f.phone, '18980336951');
  eq('产品', f.product, '百悦泽');
  eq('跟进备注', f.callback_note, '备注内容A');
  eq('未购药原因标签', f.reason_label, '推迟购药');
  eq('随访小结（未被备注污染）', f.follow_note, '小结内容B');
  eq('用药状态', f.usage_status, '已停药');
  eq('是否按时购药', f.purchased_on_time, '否');
  eq('易脱落判定', f.is_dropout, '是');
  eq('易脱落原因', f.dropout_reason, '经济困难');
  eq('仍在按处方使用', f.still_using, '是');
  eq('推迟原因', f.delay_reason, '医生建议推迟一周');
  eq('停药原因', f.stop_reason, '负担不起');
  eq('执行时间（导出当天，不作随访时间用）', String(f.exec_time), '2026-09-30');
  eq('执行人', f.executor, '刘倩');

  // 旧 10 列回传表仍要能被识别，且新字段为空
  const oldRow = dataRow.slice(0, 10);
  const buf2 = sheetOf(OLD_HEAD, [oldRow]);
  const res2 = await P.processFiles([{ name: "随访回传_旧.xlsx", arrayBuffer: async () => buf2 }]);
  eq('旧回传表仍识别为随访', res2.followups.length, 1);
  const g = res2.followups[0] || {};
  eq('旧表-服务摘要', g.summary_type, '跟进回传');
  eq('旧表-备注', g.callback_note, '备注内容A');
  eq('旧表-原随访类型为空', g.orig_fu_type, null);
  eq('旧表-用药状态为空', g.usage_status, null);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
