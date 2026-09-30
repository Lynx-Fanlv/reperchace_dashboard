/* 「距今」列着色回归：
 * 1) 单行数值 —— 不得换行（不出现 <br>、不含 .due-cell 结构）
 * 2) 三色语义 —— 已购药=ok(绿) / 逾期=over(红) / 还有N天·今天=due(蓝)
 * 3) 导出字体 exportDaysFont 与列表同色语义
 * 4) CSS 必须存在 .days-num 三色定义且带 white-space:nowrap
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const TPL = fs.readFileSync(path.join(ROOT, "index.template.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); fail++; }
}

console.log("== 距今列着色 ==");

// ---- 1. 从 app.js 中抽取真实渲染分支并执行（不复制粘贴逻辑，避免与源文件脱钩）----
const startMark = 'if (key === "days_to_due") {';
const si = APP.indexOf(startMark);
assert(si >= 0, "app.js 中找不到 days_to_due 渲染分支");
// 找到与 startMark 匹配的右花括号
let depth = 0, ei = -1;
for (let i = si + startMark.length - 1; i < APP.length; i++) {
  if (APP[i] === "{") depth++;
  else if (APP[i] === "}") { depth--; if (depth === 0) { ei = i + 1; break; } }
}
assert(ei > si, "渲染分支抽取失败");
const branchSrc = APP.slice(si, ei);

// esc 的最小等价实现（与 app.js 一致：转义 & < > " '）
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const renderDays = new Function("key", "r", "days", "isRepur", "esc",
  branchSrc.replace(/^if \(key === "days_to_due"\) \{/, "{").replace(/\}$/, "}"));

const R = (o) => Object.assign({
  repur_part: "", days_to_due: 0, purchase_days_ago: null,
}, o);

// ---- 2. 已购药：绿色 .days-num.ok，文案 N天前已购药 ----
t("已购药 → 绿色 ok 类 + 「N天前已购药」", () => {
  const h = renderDays("days_to_due", R({ repur_part: "应回已回", purchase_days_ago: 7 }), -3, true, esc);
  assert.ok(/class="days-num ok"/.test(h), "缺少 ok 类：" + h);
  assert.ok(h.includes("7天前已购药"), "文案错误：" + h);
});

t("已购药但无最近购药记录 → — 且不着色", () => {
  const h = renderDays("days_to_due", R({ repur_part: "应回已回", purchase_days_ago: null }), -3, true, esc);
  assert.ok(h.includes("—"), "应显示破折号：" + h);
  assert.ok(!/ok|over|due/.test(h.replace("days-num", "")), "空值不应着色：" + h);
});

// ---- 3. 逾期：红色 .days-num.over ----
t("逾期 → 红色 over 类 + 负数值", () => {
  const h = renderDays("days_to_due", R({ days_to_due: -12 }), -12, false, esc);
  assert.ok(/class="days-num over"/.test(h), "缺少 over 类：" + h);
  assert.ok(h.includes("-12"), "应显示原始负数：" + h);
});

// ---- 4. 还有N天 / 今天：蓝色 .days-num.due ----
t("还有N天 → 蓝色 due 类 + 「+N」", () => {
  const h = renderDays("days_to_due", R({ days_to_due: 5 }), 5, false, esc);
  assert.ok(/class="days-num due"/.test(h), "缺少 due 类：" + h);
  assert.ok(h.includes("+5"), "应显示 +5：" + h);
});

t("今天 → 蓝色 due 类 + 「今天」", () => {
  const h = renderDays("days_to_due", R({ days_to_due: 0 }), 0, false, esc);
  assert.ok(/class="days-num due"/.test(h), "缺少 due 类：" + h);
  assert.ok(h.includes("今天"), "应显示今天：" + h);
});

// ---- 5. 单行保证：不得出现换行结构 ----
t("三态均单行（无 <br> / 无 .due-cell）", () => {
  const cases = [
    R({ repur_part: "应回已回", purchase_days_ago: 7 }), R({ days_to_due: -12 }),
    R({ days_to_due: 5 }), R({ days_to_due: 0 }),
  ];
  for (const r of cases) {
    const h = renderDays("days_to_due", r, r.days_to_due, r.repur_part === "应回已回", esc);
    assert.ok(!/<br\s*\/?>/i.test(h), "出现 <br>：" + h);
    assert.ok(!h.includes("due-cell"), "出现 .due-cell 结构：" + h);
    assert.strictEqual((h.match(/<span/g) || []).length, 1, "应为单一 span：" + h);
  }
});

// ---- 6. CSS：.days-num 三色 + nowrap ----
t("CSS 含 .days-num 三色定义", () => {
  for (const cls of ["ok", "over", "due"]) {
    const re = new RegExp("\\.days-num\\." + cls + "\\s*\\{[^}]*color:var\\(--" +
      (cls === "ok" ? "good" : cls === "over" ? "bad" : "blue") + "\\)");
    assert.ok(re.test(TPL), "缺少 .days-num." + cls + " 的对应色变量");
  }
});

t("CSS .days-num 带 white-space:nowrap（防折行撑高行）", () => {
  const m = TPL.match(/\.days-num\{[^}]*\}/);
  assert.ok(m, "找不到 .days-num 基础规则");
  assert.ok(/white-space\s*:\s*nowrap/.test(m[0]), "缺少 nowrap：" + m[0]);
});

// ---- 7. 导出字体函数与列表同色 ----
t("导出 exportDaysFont 与列表同色语义", () => {
  const fi = APP.indexOf("function exportDaysFont(r) {");
  assert(fi >= 0, "找不到 exportDaysFont");
  let d = 0, fe = -1;
  for (let i = fi; i < APP.length; i++) {
    if (APP[i] === "{") d++;
    else if (APP[i] === "}") { d--; if (d === 0) { fe = i + 1; break; } }
  }
  const src = APP.slice(fi, fe);
  const fn = new Function("EXPORT_DAYS_OK", "EXPORT_DAYS_OVER", "EXPORT_DAYS_DUE",
    "r", "{ " + src + " return exportDaysFont(r); }");
  const fnR = (r) => fn("FF0F9D6B", "FFE03131", "FF3B5BDB", r);
  assert.deepStrictEqual(fnR(R({ repur_part: "应回已回", purchase_days_ago: 7 })),
    { bold: true, color: { argb: "FF0F9D6B" } }, "已购药应为绿");
  assert.deepStrictEqual(fnR(R({ days_to_due: -12 })),
    { bold: true, color: { argb: "FFE03131" } }, "逾期应为红");
  assert.deepStrictEqual(fnR(R({ days_to_due: 5 })),
    { color: { argb: "FF3B5BDB" } }, "还有N天应为蓝");
  assert.deepStrictEqual(fnR(R({ days_to_due: 0 })),
    { color: { argb: "FF3B5BDB" } }, "今天应为蓝");
  assert.strictEqual(fnR(R({ repur_part: "应回已回", purchase_days_ago: null })), null, "空值应为 null");
  assert.strictEqual(fnR(R({ days_to_due: null })), null, "非数值应为 null");
});

t("导出分支已不再只处理逾期（旧断言应失效）", () => {
  assert.ok(!/r\.days_to_due < 0\)\s*\{\s*row\.getCell\(idxDays \+ 1\)\.font = \{ bold: true, color: \{ argb: "FFE03131" \} \};/.test(APP),
    "旧的「仅逾期标红」分支仍存在");
  assert.ok(/const dFont = exportDaysFont\(r\);/.test(APP), "未接入 exportDaysFont");
});

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
