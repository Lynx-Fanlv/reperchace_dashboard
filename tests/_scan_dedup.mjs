// 去重口径勘察：用真实销售明细量化「小票号+销售时间+商品名称+药房名称+销售数量」的效果
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire("file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/");
const XLSX = require("./vendor/xlsx.full.min.js");

const base = "C:/Users/yym/Downloads";
const files = fs.readdirSync(base).filter(f => /销售明细/.test(f) && /\.(xlsx|xls)$/i.test(f) && !f.startsWith("~"));
const rows = [];
const cell = v => {
  if (v == null) return "";
  const s = String(v).trim();
  return (s === "nan" || s === "None") ? "" : s;
};

for (const f of files) {
  let wb;
  try { wb = XLSX.read(fs.readFileSync(path.join(base, f)), { type: "buffer" }); } catch (e) { continue; }
  for (const sn of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, blankrows: false });
    if (!aoa.length) continue;
    let hi = -1, hdr = null;
    for (let i = 0; i < Math.min(15, aoa.length); i++) {
      const cells = (aoa[i] || []).map(c => String(c == null ? "" : c).trim());
      if (cells.some(c => c.includes("销售时间")) && cells.some(c => c.includes("会员姓名"))) { hi = i; hdr = cells; break; }
    }
    if (hi < 0) continue;
    const idx = n => hdr.findIndex(x => String(x == null ? "" : x).includes(n));
    const I = { ticket: idx("小票号"), order: idx("订单号"), time: idx("销售时间"),
                prod: idx("商品名称"), store: idx("药房名称"), qty: idx("销售数量") };
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      rows.push({ f, ticket: cell(r[I.ticket]), order: cell(r[I.order]), time: cell(r[I.time]),
                  prod: cell(r[I.prod]), store: cell(r[I.store]), qty: cell(r[I.qty]) });
    }
  }
}

console.log("总行数:", rows.length);
const withTicket = rows.filter(r => r.ticket !== "");
console.log("有小票号:", withTicket.length, "(" + (withTicket.length / rows.length * 100).toFixed(1) + "%)");
console.log("无小票号:", rows.length - withTicket.length, "（按口径不参与去重）");
console.log("有小票号的行里，小票号为空字符串:", withTicket.filter(r => r.ticket === "").length);

const K = r => [r.ticket, r.time, r.prod, r.store, r.qty].join("\u0001");
const byKey = new Map();
for (const r of withTicket) {
  const k = K(r);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}
let dupGroups = 0, dupRows = 0;
for (const g of byKey.values()) if (g.length > 1) { dupGroups++; dupRows += g.length - 1; }

console.log("");
console.log("=== 口径：小票号 + 销售时间 + 商品名称 + 药房名称 + 销售数量 ===");
console.log("唯一键:", byKey.size);
console.log("重复组:", dupGroups);
console.log("可删行数:", dupRows,
  "（占全部 " + (dupRows / rows.length * 100).toFixed(2) + "%，占有小票号的 " + (dupRows / withTicket.length * 100).toFixed(2) + "%）");

// 跨文件 vs 同文件内重复
let crossFile = 0, sameFile = 0;
for (const g of byKey.values()) {
  if (g.length < 2) continue;
  const fs_ = new Set(g.map(x => x.f));
  if (fs_.size > 1) crossFile++; else sameFile++;
}
console.log("");
console.log("重复组中：跨文件的", crossFile, "组，同一文件内的", sameFile, "组");

console.log("");
console.log("=== 重复组抽样（前 5 组）===");
let c = 0;
for (const [k, g] of byKey) {
  if (g.length > 1 && c < 5) {
    c++;
    console.log("组 " + c + "（" + g.length + " 行）: " + k.split("\u0001").join(" | "));
    g.slice(0, 3).forEach(x => console.log("     文件: " + x.f));
  }
}

// 每行去重后是否还保留原始来源（去重只删冗余，不丢信息）
console.log("");
const filesInWithTicket = new Set(withTicket.map(r => r.f));
const filesInRows = new Set(rows.map(r => r.f));
console.log("涉及文件数:", filesInRows.size, " / 有小票号的:", filesInWithTicket.size);
