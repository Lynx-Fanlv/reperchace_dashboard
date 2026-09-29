// 销售明细跨文件自动去重（需求 1②）回归测试
// 口径：小票号 + 销售时间 + 商品名称 + 门店(药房名称) + 销售数量 全部相同 → 重复
// 纯逻辑测试：加载 mapping.js + pipeline.js（两者无 DOM 依赖）
const fs = require("fs");
const path = require("path");

const R = path.join(__dirname, "..");
global.window = global;
new Function(fs.readFileSync(path.join(R, "mapping.js"), "utf8"))();
new Function(fs.readFileSync(path.join(R, "pipeline.js"), "utf8"))();

const M = global.Mapping, P = global.Pipeline;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };
const eq = (a, b, m) => ok(a === b, m + "  (得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + ")");

// 构造一条销售记录
const mk = (over) => Object.assign({
  source: "sales",
  _row_id: "f1.xlsx::sales::Sheet1::" + Math.random().toString(36).slice(2, 8),
  sales_time: "2026-07-01",
  ticket_no: "T001",
  product_raw: "泽布替尼胶囊(百悦泽)",
  product: "百悦泽",
  qty: "2",
  amount: "3000",
  member_id: "M001",
  patient_name: "张三",
  phone: "13800000001",
  hospital: "某医院",
  pharmacy: "南充药房",
  physician: "张医生",
  department: "肿瘤科",
  indication: "肺癌",
  age: "60",
  gender: "男",
}, over || {});

console.log("===== [1] 键构造：分隔符与空值处理 =====");
{
  const a = mk(), b = mk({ _row_id: "other" });
  eq(P.salesDedupKey(a), P.salesDedupKey(b), "同业务内容的键相同（_row_id 不参与）");
  ok(P.salesDedupKey(a).includes("\u0001"), "键用 \\u0001 作分隔符（不与 patientKey 的 \\u0000 混淆）");
  ok(!P.salesDedupKey(a).includes("\u0000"), "键中不含 \\u0000");

  eq(P.salesDedupKey(mk({ ticket_no: null })), null, "无小票号 → 键为 null（不参与去重）");
  eq(P.salesDedupKey(mk({ ticket_no: "   " })), null, "小票号只有空白 → 键为 null");
  ok(P.salesDedupKey(mk({ sales_time: null })) !== null, "销售时间为空仍可构造键（用空串占位）");
  ok(P.salesDedupKey(mk({ pharmacy: null })) !== null, "药房为空仍可构造键");
}

console.log("\n===== [2] 基本去重：完全相同的两行只留一条 =====");
{
  const r = P.dedupSales([mk({ _row_id: "A" }), mk({ _row_id: "B" })]);
  eq(r.records.length, 1, "2 条完全相同 → 保留 1 条");
  eq(r.removedRows, 1, "移除 1 条");
  eq(r.groups, 1, "1 个重复组");
  eq(r.total, 2, "total 记录总行数");
  eq(r.keptNoTicket, 0, "keptNoTicket = 0");
}

console.log("\n===== [3] 五要素任一不同 → 都不算重复（不可误删）=====");
{
  const base = mk();
  const variants = [
    ["小票号", mk({ ticket_no: "T002" })],
    ["销售时间", mk({ sales_time: "2026-07-02" })],
    ["商品名称", mk({ product_raw: "替雷利珠单抗注射液(百泽安)" })],
    ["药房(门店)", mk({ pharmacy: "南部药房" })],
    ["销售数量", mk({ qty: "3" })],
  ];
  for (const [name, v] of variants) {
    const r = P.dedupSales([base, v]);
    eq(r.records.length, 2, name + " 不同 → 两行都保留");
    eq(r.removedRows, 0, name + " 不同 → 不删任何行");
  }
}

console.log("\n===== [4] 关键保护：同一小票同商品的多计价批次不能被误删 =====");
{
  // 真实场景：同一张小票下 达雷妥尤单抗 数量 2 与 3 分两行 —— 都是真实数据
  const a = mk({ ticket_no: "T100", product_raw: "达雷妥尤单抗(兆珂)", qty: "2" });
  const b = mk({ ticket_no: "T100", product_raw: "达雷妥尤单抗(兆珂)", qty: "3" });
  const r = P.dedupSales([a, b]);
  eq(r.records.length, 2, "同小票+同商品但数量不同 → 两行都保留（不误删真实行）");
  eq(r.removedRows, 0, "移除 0 条");
}

console.log("\n===== [5] 无小票号的行一律保留 =====");
{
  const r = P.dedupSales([
    mk({ ticket_no: null, _row_id: "N1" }),
    mk({ ticket_no: null, _row_id: "N2" }),
    mk({ ticket_no: "", _row_id: "N3" }),
  ]);
  eq(r.records.length, 3, "3 条无小票号 → 全部保留");
  eq(r.keptNoTicket, 3, "keptNoTicket = 3");
  eq(r.removedRows, 0, "移除 0 条");
}

console.log("\n===== [6] 混合场景：有票去重、无票全留 =====");
{
  const r = P.dedupSales([
    mk({ ticket_no: "T1", _row_id: "A" }),
    mk({ ticket_no: null, _row_id: "N" }),
    mk({ ticket_no: "T1", _row_id: "B" }),
  ]);
  eq(r.records.length, 2, "去重后 2 条（T1 一条 + 无票一条）");
  eq(r.removedRows, 1, "移除 1 条");
  eq(r.keptNoTicket, 1, "无票 1 条");
}

console.log("\n===== [7] 保留优先：非空字段更多者胜出 =====");
{
  const sparse = mk({ _row_id: "S", phone: null, member_id: null, hospital: null, physician: null });
  const full = mk({ _row_id: "F" });
  // 让 sparse 排在前面，验证仍会保留 full
  const r = P.dedupSales([sparse, full]);
  eq(r.records.length, 1, "合并为 1 条");
  eq(r.records[0]._row_id, "F", "保留信息更全的那条（非空字段更多）");
}

console.log("\n===== [8] 保留优先：有会员号 > 无会员号 =====");
{
  const noMid = mk({ _row_id: "A", member_id: null });
  const withMid = mk({ _row_id: "B" });
  // 二者非空字段数相同（都是 1 个 null），用会员号决胜
  const r = P.dedupSales([noMid, withMid]);
  eq(r.records[0]._row_id, "B", "保留有会员号的那条");
}

console.log("\n===== [9] 结果与上传顺序无关（可复现）=====");
{
  const a = mk({ _row_id: "f1::sales::S::1" });
  const b = mk({ _row_id: "f2::sales::S::9" });
  const c = mk({ _row_id: "f3::sales::S::5" });
  const r1 = P.dedupSales([a, b, c]);
  const r2 = P.dedupSales([c, a, b]);
  const r3 = P.dedupSales([b, c, a]);
  eq(r1.records[0]._row_id, r2.records[0]._row_id, "顺序 1 vs 2 保留同一条");
  eq(r1.records[0]._row_id, r3.records[0]._row_id, "顺序 1 vs 3 保留同一条");
  eq(r1.records[0]._row_id, "f1::sales::S::1", "按 _row_id 字典序取最早");
}

console.log("\n===== [10] 输出顺序：保留行停在原位置 =====");
{
  const keep1 = mk({ ticket_no: "K1", _row_id: "a1" });
  const dup1 = mk({ ticket_no: "K1", _row_id: "a2" });
  const solo = mk({ ticket_no: "K9", _row_id: "b1", sales_time: "2026-08-01" });
  const r = P.dedupSales([keep1, dup1, solo]);
  eq(r.records.length, 2, "结果 2 条");
  eq(r.records[0].ticket_no, "K1", "第 1 条仍为 K1（位置未乱）");
  eq(r.records[1].ticket_no, "K9", "第 2 条为 K9");
}

console.log("\n===== [11] 三行及以上同键 =====");
{
  const r = P.dedupSales([mk({ _row_id: "1" }), mk({ _row_id: "2" }), mk({ _row_id: "3" }), mk({ _row_id: "4" })]);
  eq(r.records.length, 1, "4 条同键 → 1 条");
  eq(r.removedRows, 3, "移除 3 条");
  eq(r.groups, 1, "仍只算 1 个重复组");
}

console.log("\n===== [12] 空输入 / 单行 / 非数组 =====");
{
  eq(P.dedupSales([]).records.length, 0, "空数组 → 空结果");
  eq(P.dedupSales(null).records.length, 0, "null → 空结果（不抛错）");
  eq(P.dedupSales(undefined).records.length, 0, "undefined → 空结果");
  eq(P.dedupSales([mk()]).records.length, 1, "单行 → 原样返回");
  eq(P.dedupSales([mk()]).removedRows, 0, "单行 → 无移除");
}

console.log("\n===== [13] 移除数组内容正确（供详情展示）=====");
{
  const a = mk({ _row_id: "keep", pharmacy: "南充药房" });
  const b = mk({ _row_id: "drop", pharmacy: "南充药房" });
  const r = P.dedupSales([a, b]);
  eq(r.removed.length, 1, "removed 明细数组有 1 条");
  eq(r.removed[0]._row_id, "drop", "被移除的是 drop 那条");
  ok(r.removed[0].ticket_no === "T001", "被移除记录保留完整字段（可展示小票号）");
  eq(r.removedRows, 1, "removedRows 是数量（供提示条计数）");
}

console.log("\n===== [14] 字段映射：小票号关键字已注册 =====");
{
  const rules = M.KEYWORD_RULES;
  const t = rules.find(r => r[0] === "ticket_no");
  ok(!!t, "KEYWORD_RULES 含 ticket_no");
  ok(t[1].includes("小票号"), "ticket_no 关键字含「小票号」");
  const cm = P.mapColumns("sales", ["销售时间", "小票号", "商品名称", "会员姓名", "药房名称", "销售数量"]);
  eq(cm.ticket_no, 1, "mapColumns 正确映射到「小票号」列（索引 1）");
  const cm2 = P.mapColumns("sales", ["销售时间", "订单号", "商品名称", "会员姓名", "药房名称"]);
  eq(cm2.ticket_no, undefined, "只有「订单号」时不会误映射成小票号");
}

console.log("\n===== [14b] 小票号不参与业务输出（只做去重）=====");
{
  const cols = ["销售时间", "小票号", "商品名称", "会员姓名", "会员电话", "药房名称", "销售数量"];
  const rows = [["2026-07-01", "T001", "泽布替尼胶囊(百悦泽)", "张三", "13800000000", "南充药房", "1"]];
  const recs = P.normalizeSheet("sales", rows, cols, "f.xlsx", "S");
  eq(recs.length, 1, "normalizeSheet 产出 1 条销售记录");
  ok(recs[0].ticket_no === "T001", "normalizeSales 保留 ticket_no（供去重用）");
  const listKeys = JSON.stringify(M.LIST_COLS || {});
  ok(listKeys.indexOf("ticket_no") === -1, "列表列定义中不含 ticket_no（不会显示成表格列）");
  // 导出列（回调表）也不应带小票号
  const srcApp = fs.readFileSync(path.join(R, "app.js"), "utf8");
  ok(srcApp.indexOf('"小票号"') === -1, "app.js 中没有任何面向用户的「小票号」表头/标签");
}

console.log("\n===== [14c] 详情表对特殊字符做转义（防注入/防破版）=====");
{
  const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
  // detailRows 的每个单元格都必须经 esc() 包裹
  ok(/<td>\$\{esc\(tk\)\}<\/td>/.test(src), "小票号单元格经 esc() 转义");
  ok(/<td>\$\{esc\(p\)\}<\/td>/.test(src), "商品名称单元格经 esc() 转义");
  ok(/<td>\$\{esc\(ph\)\}<\/td>/.test(src), "药房单元格经 esc() 转义");
  ok(/<td>\$\{esc\(src\)\}<\/td>/.test(src), "来源文件单元格经 esc() 转义");
  // 提示条在无重复时必须是完全隐藏 + 清空（不留残留 DOM）
  ok(/if \(!d \|\| !d\.removed\) \{ box\.classList\.add\("hidden"\); box\.innerHTML = ""; return; \}/.test(src),
    "无重复时提示条隐藏并清空内容");
  // 清空全部数据时必须一并清掉去重状态与提示条
  ok(/STORE\.dedup = null;/.test(src), "clearAll 会重置 STORE.dedup");
  ok(/\$\("#dedupNotice"\); if \(dn\) \{ dn\.classList\.add\("hidden"\); dn\.innerHTML = ""; \}/.test(src),
    "clearAll 会隐藏并清空提示条");
}

console.log("\n===== [14d] 去重发生在「分析」阶段，且在品种提取之前 =====");
{
  const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
  const iDedup = src.indexOf("const dd = P.dedupSales(res.sales)");
  const iAssign = src.indexOf("STORE.sales = dd.records");
  const iProducts = src.indexOf("[...new Set(dd.records.map(s => s.product)");
  ok(iDedup > 0, "分析流程调用了 P.dedupSales");
  ok(iAssign > iDedup, "去重结果赋给 STORE.sales");
  ok(iProducts > iAssign, "品种列表从去重后的记录提取（duplicate 的品种不会被重复计入）");
  ok(src.indexOf("STORE.sales = res.sales") === -1, "旧的「未去重直接赋值」已不存在");
}

console.log("\n===== [15] 产物防线：去重逻辑已进构建产物 =====");
{
  for (const f of ["index.html", "index.single.html"]) {
    const c = fs.readFileSync(path.join(R, f), "utf8");
    ok(/function dedupSales/.test(c), f + " 含 dedupSales");
    ok(/function salesDedupKey/.test(c), f + " 含 salesDedupKey");
    ok(/ticket_no/.test(c), f + " 含 ticket_no 字段");
    ok(/id="dedupNotice"/.test(c), f + " 含去重提示条容器");
    ok(/dedupSales\(res\.sales\)/.test(c), f + " 分析流程已接入去重调用");
  }
}

console.log("\n===== [16] 样式：提示条与详情表 =====");
{
  const t = fs.readFileSync(path.join(R, "index.template.html"), "utf8");
  ok(/\.dd-notice\{/.test(t), "定义 .dd-notice");
  ok(/\.dd-notice\.hidden\{display:none\}/.test(t), ".dd-notice.hidden 隐藏");
  ok(/\.dd-detail\.hidden\{display:none\}/.test(t), ".dd-detail.hidden 隐藏");
  ok(/\.dd-tbl\{[^}]*table-layout:fixed/.test(t), ".dd-tbl 用 fixed 布局（长值不撑宽）");
  ok(/\.dd-tbl td\{[^}]*text-overflow:ellipsis/.test(t), ".dd-tbl td 单行截断");
}

console.log("\n通过 " + pass + " / " + (pass + fail));
if (fail) process.exit(1);
