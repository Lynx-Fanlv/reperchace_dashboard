// 发布形态哨兵测试：防止「多文件版被当成单文件版发布到 gh-pages」再次发生
//
// 背景（2026-09-30 线上故障，用户报「销售明细数据直接不能被识别分类了，无法开始分析」）：
//   gh-pages 分支**只有 index.html + README.md，没有 vendor/ 目录**。
//   而 _ghpages_sync.py 原先 FILE 写的是 index.html（多文件版），
//   导致线上 index.html 里带着
//       <script src="vendor/xlsx.full.min.js">
//       <script src="vendor/exceljs.min.js">
//   两个引用在 gh-pages 上必然 404 → XLSX 未定义 → **所有上传文件都被标「未识别」**。
//   可怕之处：页面自身看着完全正常（HTML/CSS/业务逻辑都在），只在运行期炸，排查成本极高。
//
//   本测试把「判定一个 HTML 能不能作为 gh-pages 的 index.html」这件事固化成断言，
//   任何人改 build.py / _ghpages_sync.py / 发布流程，只要破坏自包含性就会立刻红。
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };

// 与 _ghpages_sync.py 的 verify_self_contained 同一套判据
function analyze(file) {
  const t = fs.readFileSync(path.join(R, file), "utf8");
  const ext = [...t.matchAll(/<(?:script|link)[^>]*(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]);
  return {
    text: t,
    bytes: Buffer.byteLength(t, "utf8"),
    external: ext,
    relExternal: ext.filter(e => !/^(https?:|data:)/.test(e)),
    refsVendor: /<script[^>]+src=["']vendor\//.test(t),
    hasXLSX: /XLSX\s*=/.test(t),
    hasSheetJS: /SheetJS/.test(t),
  };
}

console.log("===== 单文件版 index.single.html（gh-pages 的唯一合法来源）=====");
{
  const a = analyze("index.single.html");
  ok(a.relExternal.length === 0,
    "★ 不得有任何相对路径外部引用  (" + (a.relExternal.length ? a.relExternal.join(", ") : "无") + ")");
  ok(!a.refsVendor, "★ 不得引用 vendor/（gh-pages 上没有该目录，引用即 404 → 全表未识别）");
  ok(a.hasXLSX, "★ 必须内联 SheetJS（存在 XLSX= 定义）");
  ok(a.hasSheetJS, "★ 必须内联 SheetJS（存在 SheetJS 标记）");
  ok(a.bytes > 1000000, "★ 体积 > 1MB（多文件版只有 ~250KB）  (得到 " + a.bytes + ")");
}

console.log("\n===== 多文件版 index.html（本地/开发用，形态必须相反）=====");
{
  const b = analyze("index.html");
  ok(b.refsVendor, "应当引用 vendor/xlsx.full.min.js（这是它该有的形态）");
  ok(b.bytes < 1000000, "体积应远小于单文件版  (得到 " + b.bytes + ")");
  ok(b.bytes >= 50000, "体积不应异常小  (得到 " + b.bytes + ")");
}

console.log("\n===== 两版不得混淆 =====");
{
  const a = analyze("index.single.html"), b = analyze("index.html");
  ok(a.bytes > b.bytes * 3,
    "★ 单文件版体积应显著大于多文件版（差值即内联的 vendor）  (" + a.bytes + " vs " + b.bytes + ")");
  ok(a.text.includes("detectTableType") && b.text.includes("detectTableType"),
    "两版都含业务逻辑（确认不是空产物）");
}

console.log("\n===== 同步脚本的取材与把关 =====");
{
  const s = fs.readFileSync(path.join(R, "tests", "_ghpages_sync.py"), "utf8");
  ok(/SOURCE\s*=\s*["']index\.single\.html["']/.test(s),
    "★ SOURCE 必须是 index.single.html（写成 index.html 正是本次故障根因）");
  ok(/def verify_self_contained/.test(s), "★ 必须有 verify_self_contained（发布前把关）");
  ok(/final_size\s*<\s*1_000_000/.test(s),
    "★ 必须有体积下限校验（拦掉 ~250KB 的多文件版）");
  ok(/hash-object["'],\s*["']-w["'],\s*SOURCE|hash-object.*SOURCE/.test(s),
    "★ hash-object 取的是 SOURCE 而不是硬编码的文件名");
}

console.log("\n===== 关键业务列映射未丢失 =====");
{
  const m = fs.readFileSync(path.join(R, "mapping.js"), "utf8");
  for (const k of ["销售时间", "商品名称", "会员姓名", "药房名称"]) {
    ok(m.includes(k), "mapping 含销售识别关键列「" + k + "」");
  }
  ok(/detectTableType/.test(m), "mapping 含 detectTableType");
}

console.log("\n通过 " + pass + " / " + (pass + fail));
if (fail) process.exit(1);
