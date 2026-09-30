/* 留档覆盖语义诊断：验证「上传部分数据也能覆盖品种留档」的行为 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ctx = { window: {}, console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, isFinite, parseInt, parseFloat, Set, Map, RegExp, Error };
ctx.global = ctx;
ctx.window = ctx;
vm.createContext(ctx);

for (const f of ["vendor/xlsx.full.min.js", "mapping.js", "pipeline.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}
const P = ctx.Pipeline;

console.log("=== 留档覆盖语义诊断 ===");

// 模拟 saveArchiveByProduct 的语义（app.js 里的实现）：按品种整覆盖
function saveByProduct(archive, records) {
  const byProd = new Map();
  for (const r of records) {
    if (!r || !r.product) continue;
    if (!byProd.has(r.product)) byProd.set(r.product, []);
    byProd.get(r.product).push(r);
  }
  for (const [prod, list] of byProd) archive[prod] = list; // 整品种覆盖
  return archive;
}

const mk = (day, prod, ticket, qty) => ({
  source: "sales", _row_id: `f1::sales::S::${day}-${ticket}`,
  sales_time: `2026-${day}`, product: prod, product_raw: prod,
  ticket_no: ticket, qty: String(qty), pharmacy: "某药房",
  patient_name: "张三", phone: "13800001111", member_id: "M1",
});

const archive = {};

// 第一轮：上传 8 月全量 10 条
const aug = [];
for (let d = 1; d <= 10; d++) aug.push(mk("08-" + String(d).padStart(2, "0"), "百泽安", "T" + d, 1));
saveByProduct(archive, aug);
console.log("第一轮（8月 10 条）后留档:", Object.keys(archive).map(k => k + "=" + archive[k].length).join(", "));

// 第二轮：只上传 9 月的 1 条（新品种的部分数据）
const sep = [mk("09-05", "百泽安", "T99", 1)];
saveByProduct(archive, sep);
console.log("第二轮（仅9月 1 条）后留档:", Object.keys(archive).map(k => k + "=" + archive[k].length).join(", "));
console.log("  → 8 月的 10 条历史是否还在？", archive["百泽安"].length === 10 ? "在" : "❌ 已被覆盖丢失！");

// 关键：即使用户走了「加载历史」流程，也只是「读到历史→合并→写回」，若不加载就写回则必然丢
console.log("");
console.log("=== 结论 ===");
console.log("问题2 根因：saveArchiveByProduct 是「整品种覆盖」，写的是「本次合并结果」。");
console.log("  若本次上传只是该品种的一部分（如只传了 9 月），留档就被这份部分数据覆盖成小集合。");
console.log("  即使用户没勾「加载历史」，写回依然发生 → 历史被静默丢弃。");

// 顺带验证问题1：同文件重复上传，键是否命中
console.log("");
console.log("=== 问题1：相同文件重复上传的去重键 ===");
const f = [mk("08-01", "百泽安", "T1", 1), mk("08-02", "百泽安", "T2", 1)];
const twice = f.concat(f.map(r => ({ ...r, _row_id: r._row_id + "_copy" })));
const dd = P.dedupSales(twice);
console.log("  同一文件上传两次 →", twice.length, "行，去重后", dd.records.length, "行，移除", dd.removedRows);
console.log("  → 同内容不同文件名时键一致，能被正确去重 ✓");

// 但若数量列有小差异（例如一个导出写 "1"，另一个写 "1.0"）
const f2 = f.concat(f.map(r => ({ ...r, qty: r.qty + ".0", _row_id: r._row_id + "_v2" })));
const dd2 = P.dedupSales(f2);
console.log("");
console.log("  数量列字符串形式不同（1 vs 1.0）→", f2.length, "行，去重后", dd2.records.length, "行");
console.log("  → ❌ 键含 qty 的字符串形式，'1' vs '1.0' 视为不同 → 未去重");

// 药房名有细微差异
const f3 = f.concat(f.map(r => ({ ...r, pharmacy: r.pharmacy + " ", _row_id: r._row_id + "_s" })));
const dd3 = P.dedupSales(f3);
console.log("  药房名尾部有空格 →", f3.length, "行，去重后", dd3.records.length, "行");
console.log("  → 键含 pharmacy 原值，未 trim → 视为不同 → 未去重");
