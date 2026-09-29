// 从真 index.html 派生探针页：在**最后一个</body>**前插入探针脚本。
//
// 两个必须记住的坑：
// 1) index.html 里 mapping/pipeline/app 三段代码是**内联**在 <script> 里的，
//    完整 DOM + 完整应用代码天然具备，无需外链替换。
// 2) index.html 的 app.js 源码里**字面包含 "</body>"**（快照生成代码的模板字符串），
//    所以 replace(/<\/body>/i, ...) 会命中那一处、把探针注入到 JS 字符串内部 →
//    脚本永不执行、window.__DONE__ 未定义。**必须用 lastIndexOf 取最后一个 </body>。**
//
// 另：手写精简 DOM 会因 app.js 顶层 `$("#x").onclick = ...` 取到 null 抛错，
//     整个 IIFE 中断 → window.AppCore 未挂载。必须用真模板的完整 DOM。
const fs = require("fs");
const path = require("path");

const R = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8");

const probeFile = process.env.PROBE || "_snap_probe.js";
const probeSrc = fs.readFileSync(path.join(__dirname, probeFile), "utf8").trim();

const inject =
  "\n<script>\nwindow.__DONE__=false;\n" +
  probeSrc +
  "\n.then(function(s){window.__RESULT__=s;window.__DONE__=true;}," +
  "function(e){window.__RESULT__='ERR: '+(e&&e.stack||e);window.__DONE__=true;});\n" +
  "</script>\n";

const at = html.lastIndexOf("</body>");
if (at < 0) throw new Error("index.html 中找不到 </body>");
const out = html.slice(0, at) + inject + html.slice(at);

const outFile = path.join(__dirname, "_probe_page.html");
fs.writeFileSync(outFile, out);
console.log(
  "探针页已生成: " + outFile + " (" + out.length + " 字节, 探针 " + probeFile +
  ", 注入位置 " + at + " / " + html.length + ")"
);
