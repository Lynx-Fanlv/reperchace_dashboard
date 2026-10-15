/* 患者键（含 U+0000）不得经 HTML 属性往返 —— 回归测试
   ─────────────────────────────────────────────────────────
   背景：Pipeline.patientKey = 姓名 + "\u0000" + 电话（35f6d1a 起，用于重名/同号去重）。
   HTML 解析器会把**属性值**里的 U+0000 替换成 U+FFFD，于是写进 data-key 再读回就失配。
   症状（用户报障原文）：
     · 填了「跟进备注」→ 点「导出随访回传表」→ 弹「当前筛选内没有可回传的内容」
     · 点选「未购药原因」→ 点选结果无法保留
   修法：DOM 只带行号（<tr data-idx>），事件里回查 DATA.rows 现算键（rowByTr）。
   ───────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");
const R = path.resolve(__dirname, "..");

let pass = 0, fail = 0, skip = 0;
const ok = (c, m) => { console.log((c ? "  ✅ " : "  ❌ ") + m); c ? pass++ : fail++; };
const log = (m) => console.log(m);
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");

/* ================= [A] 机制：属性往返 NUL → U+FFFD ================= */
log("=== [A] 机制：HTML 属性里的 U+0000 会被替换为 U+FFFD ===");
let JSDOM = null;
try { JSDOM = require("jsdom").JSDOM; } catch (e) { /* 见下方降级 */ }
if (JSDOM) {
  const dom = new JSDOM("<!doctype html><div id=host></div>");
  const doc = dom.window.document;
  const NAME = "张三", PHONE = "13800001111", PROD = "百泽安";
  const _key = NAME + "\u0000" + PHONE;      // 模拟 Pipeline.patientKey
  const nk = _key + "::" + PROD;              // 模拟 noteKey(r)
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  doc.getElementById("host").innerHTML =
    `<input class="note-input" data-key="${esc(nk)}" value=""><span class="reason-tag" data-key="${esc(nk)}"></span>`;
  const got = doc.querySelector("input.note-input").dataset.key;
  ok(nk.includes("\u0000"), "noteKey 确实含 U+0000（来自 patientKey 的分隔符）");
  ok(got !== nk, "★ 属性往返后键不相等（U+0000 → U+FFFD，码点 " + nk.charCodeAt(2) + " → " + got.charCodeAt(2) + "）");
  ok(got.indexOf("\uFFFD") >= 0, "读回值里出现替换字符 U+FFFD");
} else {
  skip += 3;
  log("  ⏭ 跳过（本机无 jsdom，行为已由真实浏览器验收 tests/_cdp_callback.mjs 覆盖）");
}

/* ================= [B] 源码哨兵：患者级键不得进 HTML 属性 ================= */
log("\n=== [B] 源码哨兵：患者级键不得出现在 HTML 属性表达式里 ===");
const APP = read("app.js");
// 属性上下文：data-*="…" / value="…" / href="…"，其中插值引用了患者级键
// 说明：data-key 本身不是禁忌 —— 原因分类树编辑器用 data-key="${esc(n.key)}" 传的是
// genReasonKey() 生成的「r+base36」（不含 NUL，安全）。真正的禁忌是**患者级键**：
// noteKey() / cycleOverrideKey() / patientKey() 的结果（都含 \u0000）。
const FORBIDDEN = ["noteKey", "cycleOverrideKey", "patientKey", "_key"];
const attrRe = /(?:data-[a-z-]+|value|href)="\$\{([^}"']*)\}"/g;
const hits = [];
APP.split("\n").forEach((line, i) => {
  if (/^\s*(\/\/|\*)/.test(line)) return;                       // 注释行跳过（说明性文字）
  let m;
  attrRe.lastIndex = 0;
  while ((m = attrRe.exec(line)) !== null) {
    const expr = m[1];
    const bad = FORBIDDEN.find((f) => new RegExp("\\b" + f + "\\b").test(expr));
    if (bad) hits.push("    第 " + (i + 1) + " 行：" + line.trim().slice(0, 110) + "   ← 命中 " + bad);
  }
});
ok(hits.length === 0, "★ app.js 无「患者级键写进 HTML 属性」的写法" +
  (hits.length ? "\n" + hits.join("\n") : ""));

/* ================= [C] 接线哨兵：改走行索引回查 ================= */
log("\n=== [C] 接线哨兵：键改由行索引回查（rowByTr）===");
ok(/function rowByTr\s*\(/.test(APP), "★ 存在 rowByTr(el)：由 <tr data-idx> 回查 DATA.rows");
ok(/closest\("tr\.data-row"\)/.test(APP), "rowByTr 用 tr.data-row 作为回查锚点");
// dataset.key 只允许出现在「原因分类树编辑器」里（那里的 key 由 genReasonKey() 生成，无 NUL）。
// 它永远不该出现在行级单元（备注 / 原因 / 周期）的绑定里。
const dkLines = APP.split("\n").map((l, i) => [i + 1, l])
  .filter(([, l]) => /dataset\.key/.test(l) && !/^\s*(\/\/|\*)/.test(l));
const dkBad = dkLines.filter(([, l]) => !/dataset\.act/.test(l));
ok(dkBad.length === 0, "★ dataset.key 仅用于原因分类树编辑器（data-act/data-key 成对出现）" +
  (dkBad.length ? "\n" + dkBad.map(([n, l]) => "    第 " + n + " 行：" + l.trim().slice(0, 110)).join("\n") : ""));
// 三处行级单元（备注 / 原因 / 周期）：一律不得带 data-key
for (const [label, probe] of [
  ["备注输入框", /class="note-input"[^`]*/],
  ["原因标签", /class="tag reason-tag\$\{clickable\}"[^`]*/],
  ["周期单元格", /class="cycle-edit[^`]*/],
]) {
  const tpl = (APP.match(probe) || [""])[0];
  ok(!!tpl && !/data-key/.test(tpl), "★ " + label + "模板不含 data-key" + (tpl ? "" : "（未找到模板，需人工确认）"));
}
// 备注输入框另有一条：不得用 value 属性传初值（备注内容可能含引号，走属性会被截断）
const noteTpl = (APP.match(/class="note-input"[^`]*/) || [""])[0];
ok(noteTpl && !/\bvalue=/.test(noteTpl), "★ 备注输入框不再用 value 属性传初值（改用 property 赋值）");
ok(/inp\.value\s*=\s*STORE\.notes\[noteKey\(r\)\]/.test(APP), "初值改用 property 赋值：inp.value = STORE.notes[noteKey(r)]");
ok(/STORE\.reasonOverrides\[key\]\s*=\s*sel\.value/.test(APP), "点选值按闭包里的 key 落库（该 key 由 rowByTr 现算）");
// 原因标签：连 data-reason 也不带（cur 改从行对象现算）
const tagTpl = (APP.match(/class="tag reason-tag\$\{clickable\}"[^`]*/) || [""])[0];
ok(tagTpl && !/data-reason/.test(tagTpl), "★ 原因标签也不再带 data-reason（cur 改由 row.reason 现算）");

/* ================= [D] 语义哨兵：「未标」空串必须能压过自动判定 ================= */
log("\n=== [D] 语义哨兵：显式「未标」（空串）不被自动判定顶掉 ===");
ok(/Object\.prototype\.hasOwnProperty\.call\(STORE\.reasonOverrides,\s*subKey\)/.test(APP),
  "★ 行内 reason 解析用 hasOwnProperty 判「有没有被人工点选过」（原 `|| autoReason` 会把空串顶掉）");
ok(/Object\.prototype\.hasOwnProperty\.call\(STORE\.reasonOverrides,\s*nk\)/.test(APP),
  "回传表接续时同样用 hasOwnProperty（用户点过的「未标」也算已有编辑）");
const falsyBug = /const reason\s*=\s*STORE\.reasonOverrides\[subKey\]\s*\|\|/.test(APP);
ok(!falsyBug, "已无 `STORE.reasonOverrides[subKey] || autoReason` 的真值判断写法");

/* ================= [E] 产物哨兵：构建产物同步 ================= */
log("\n=== [E] 产物哨兵：index.html / index.single.html 已同步修复 ===");
for (const f of ["index.html", "index.single.html"]) {
  let t = "";
  try { t = read(f); } catch (e) { log("  ⏭ " + f + " 不存在，跳过"); continue; }
  ok(!/data-key="\$\{esc\(noteKey\(r\)\)\}"/.test(t), f + " 无旧写法 data-key=esc(noteKey(r))");
  ok(!t.includes("STORE.notes[inp.dataset.key]"), f + " 无旧写法 STORE.notes[inp.dataset.key]");
  ok(t.includes("function rowByTr(") || f === "index.single.html", f + " 含 rowByTr 新实现");
}

log("\n通过 " + pass + " / " + (pass + fail) + (skip ? "（另有 " + skip + " 项因环境跳过）" : ""));
process.exit(fail ? 1 : 0);
