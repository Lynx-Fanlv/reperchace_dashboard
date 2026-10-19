// 校验：回传表能被导入侧按预期映射回一条普通随访记录。
// 当前格式 = 10 列（HEAD_10）；同时兼容 2026-10-19 曾短暂导出过的 17 列版本（HEAD_17，
// 多出的 7 列是随访模板状态列，现在按普通随访字段吸进来即可，不影响判定）。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'mapping.js'), 'utf8'))();
const M = global.Mapping;
global.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
new Function(fs.readFileSync(path.join(ROOT, 'pipeline.js'), 'utf8'))();
const P = global.Pipeline;

const HEAD_10 = ["任务状态", "服务摘要", "患者姓名", "联系电话", "产品", "执行时间", "执行人",
  "未购药原因", "跟进备注", "随访小结"];
// 历史 17 列版本：在 10 列后追加随访模板状态列（已不再导出，但旧文件要能读）
const HEAD_17 = HEAD_10.concat(["患者目前的用药状态是？",
  "是否已按时购药", "是否判定患者属于易脱落（失访/停药）高风险", "判断为易脱落的原因",
  "还在按照处方继续使用", "推迟用药的原因", "停药的原因是什么"]);

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
    "推迟购药", "备注内容A", "小结内容B", "已停药", "否", "是",
    "经济困难", "是", "医生建议推迟一周", "负担不起"];
  const buf = sheetOf(HEAD_17, [dataRow]);

  const res = await P.processFiles([{ name: "随访回传_2026-09-30.xlsx", arrayBuffer: async () => buf }]);
  console.log('识别结果：销售 ' + res.sales.length + ' 条 / 随访 ' + res.followups.length + ' 条 / 周期 '
    + Object.keys(res.cycles).length + ' 个品种');
  eq('识别为随访表（未误判为销售/周期）', res.followups.length, 1);
  const f = res.followups[0] || {};
  eq('服务摘要=跟进回传（识别标记未被原随访类型抢走）', f.summary_type, '跟进回传');
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
  eq('执行时间＝导出当天（这就是这条随访记录的时间）', String(f.exec_time), '2026-09-30');
  eq('执行人', f.executor, '刘倩');

  // 旧 17 列回传表：多出的 7 列按普通随访字段吸进来（不再导出，但历史文件要能读）
  const oldRow = dataRow.slice(0, 10);
  const buf2 = sheetOf(HEAD_10, [oldRow]);
  const res2 = await P.processFiles([{ name: "随访回传_当格式.xlsx", arrayBuffer: async () => buf2 }]);
  eq('10 列回传表仍识别为随访', res2.followups.length, 1);
  const g = res2.followups[0] || {};
  eq('10 列-服务摘要', g.summary_type, '跟进回传');
  eq('10 列-备注', g.callback_note, '备注内容A');
  eq('10 列-未购药原因标签', g.reason_label, '推迟购药');
  eq('10 列-用药状态为空（本格式没有这一列）', g.usage_status, null);
  eq('10 列-停药原因为空', g.stop_reason, null);
  eq('10 列-信号仍由未购药原因归一化', M.followupSignal(g).signal, 'nonstd');

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
