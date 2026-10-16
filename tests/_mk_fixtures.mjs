// 生成 / 查看回环测试用的 fixture（销售明细 + 随访任务表）
//   node tests/_mk_fixtures.mjs dump   -> 打印 _fixture_sales_query.xlsx 的表头与若干行
//   node tests/_mk_fixtures.mjs followup -> 按销售明细里的患者生成 _fixture_followup_synth.xlsx
//
// 为什么需要合成随访表：要验「回传表会不会把真实随访顶掉」，必须同时存在
//   · 一条**真实的随访任务**（带「停药的原因是什么」→ 能判定出脱落信号）
//   · 一份回传表（回传表不带任何信号字段）
// 只有销售明细的话，患者本来就没有随访，验不出「被顶掉」。
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const XLSX = require(path.join(ROOT, "vendor", "xlsx.full.min.js"));

// ⚠ 本机 fs shim 会拦 XLSX.readFile / XLSX.writeFile（报 "Cannot access file"），
//   必须自己读成 Buffer 再交给 XLSX.read / 用 XLSX.write 拿 buffer 再 fs.writeFileSync。
function readSales() {
  const buf = fs.readFileSync(path.join(ROOT, "_fixture_sales_query.xlsx"));
  const wb = XLSX.read(buf, { type: "buffer" });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const head = aoa[0].map(c => String(c == null ? "" : c).trim());
  const idx = {};
  head.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const rows = aoa.slice(1).map(r => {
    const o = {};
    for (const h in idx) o[h] = r[idx[h]];
    return o;
  });
  return { head, rows };
}

const mode = process.argv[2] || "dump";
const { head, rows } = readSales();

if (mode === "dump") {
  console.log("表头:", JSON.stringify(head));
  console.log("行数:", rows.length);
  rows.slice(0, 5).forEach((r, i) => console.log(" R" + i + ":", JSON.stringify(r)));
  const nameKey = head.find(h => /会员姓名|患者姓名|客户姓名/.test(h));
  const phoneKey = head.find(h => /会员电话|联系电话|手机号/.test(h));
  const prodKey = head.find(h => /商品名称|产品名称|药品名称/.test(h));
  const seen = new Set();
  console.log("--- 前 8 位不同患者（" + nameKey + " / " + phoneKey + " / " + prodKey + "）");
  for (const r of rows) {
    const k = r[nameKey] + "|" + r[phoneKey];
    if (seen.has(k)) continue;
    seen.add(k);
    console.log("   ", JSON.stringify(r[nameKey]), JSON.stringify(r[phoneKey]), JSON.stringify(r[prodKey]));
    if (seen.size >= 8) break;
  }
} else if (mode === "followup") {
  const nameKey = head.find(h => /会员姓名|患者姓名|客户姓名/.test(h));
  const phoneKey = head.find(h => /会员电话|联系电话|手机号/.test(h));
  const prodKey = head.find(h => /商品名称|产品名称|药品名称/.test(h));
  // 取第一位患者；随访执行时间设在销售之后，确保能被匹配上
  const first = rows[0];
  const name = first[nameKey], phone = String(first[phoneKey] == null ? "" : first[phoneKey]);
  const prod = first[prodKey];
  const aoa = [
    ["任务状态", "服务摘要", "患者姓名", "联系电话", "产品", "计划执行时间", "执行时间", "执行人",
      "随访小结", "停药的原因是什么", "患者目前的用药状态是？", "是否已按时购药", "是否判定患者属于易脱落（失访/停药）高风险"],
    ["已完成", "常规随访", name, phone, prod, "2027-01-05 09:00:00", "2027-01-05 09:00:00", "刘倩",
      "患者自述经济压力大，已停药", "经济困难，负担不起", "已停药", "否", "是"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "随访任务");
  const dst = path.join(ROOT, "_fixture_followup_synth.xlsx");
  fs.writeFileSync(dst, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  console.log("已生成", dst, fs.statSync(dst).size, "字节；患者 =", name, phone, prod);
} else {
  console.log("用法: node tests/_mk_fixtures.mjs [dump|followup]");
  process.exit(1);
}
