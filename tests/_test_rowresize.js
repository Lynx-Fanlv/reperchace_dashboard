// 行高拖拽条（替代原「行高滑块 + 恢复默认」工具条）回归测试
//
// 用户需求（2026-09-30）：
//   「行高的调整按钮太占页面位置了。改成和当前列宽一样，用户在列表中直接拖动，
//    但所有行同步扩宽。不需要"恢复默认"、"本地留档"等多余的功能」
//   → 追问确认：拖拽位置选「左侧独立拖拽条」；工具条整条删掉；
//     「本地留档」挪到「已选文件」面板的「清空选择」按钮旁边。
//
// 分两层：
//   [A] app.js 的接线与边界夹取（vm 里直接调 setRowHeight）
//   [B] 静态断言：模板里旧控件已彻底移除、新拖拽条已就位、留档按钮已挪位
//   [C] 产物防线：index.html / index.single.html 同步
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const R = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };
const eq = (a, b, m) => ok(a === b, m + "  (得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + ")");

const appSrc = fs.readFileSync(path.join(R, "app.js"), "utf8");
const tpl = fs.readFileSync(path.join(R, "index.template.html"), "utf8");

// ---------- [A] setRowHeight 边界夹取（在 vm 里跑，避免整份 app.js 依赖 DOM） ----------
console.log("===== [A] setRowHeight 边界夹取与 padding 联动 =====");
{
  // 只抽取行高相关的三个函数 + 常量，连同最小 DOM stub 一起跑
  const iConst = appSrc.indexOf("const DEFAULT_ROW_H");
  const iEnd = appSrc.indexOf("function renderTable()");
  ok(iConst > 0 && iEnd > iConst, "能从 app.js 定位行高相关代码块");
  const block = appSrc.slice(iConst, iEnd);

  const vars = new Map();
  const ctx = {
    console,
    document: {
      documentElement: {
        style: { setProperty: (k, v) => vars.set(k, v) },
      },
    },
    getComputedStyle: () => ({
      getPropertyValue: (k) => vars.get(k) || "",
    }),
    $: () => null,          // #rowHVal 已不存在，$ 返回 null 必须不报错
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext("const MIN_ROW_H_=0;" + block, ctx);

  const S = ctx.setRowHeight;
  ok(typeof S === "function", "setRowHeight 可调用");

  eq(S(34), 34, "默认 34px 原样返回");
  eq(vars.get("--row-h"), "34px", "--row-h 写进 CSS 变量");
  eq(vars.get("--row-pad"), "6.5px", "34px → 上下 padding 6.5px（联动压缩）");

  eq(S(28), 28, "下限 28px 保留");
  eq(S(10), 28, "★ 小于下限时夹到 28px");
  eq(S(-100), 28, "★ 负数夹到 28px");

  // 天花板从 72 提到 160：改成拖拽后 72 太早到顶，手感像"坏了"
  eq(S(160), 160, "★ 上限 160px 可达到（原滑块上限仅 72）");
  eq(S(999), 160, "★ 超过上限夹到 160px");

  eq(S(28), 28, "回到 28px");
  ok(parseFloat(vars.get("--row-pad")) >= 2, "28px 时 padding 仍 >= 2px（不会压成 0 导致边框贴字）");

  eq(S(72.6), 73, "小数四舍五入到整数 px");

  // resetColWidthsOnly 必须存在，且**不再**动行高
  ok(/function resetColWidthsOnly\s*\(/.test(appSrc), "★ 存在 resetColWidthsOnly");
  ok(!/function resetView\s*\(/.test(appSrc), "★ 旧的 resetView 已移除（不再需要「恢复默认」）");
  const iR = appSrc.indexOf("function resetColWidthsOnly");
  const body = appSrc.slice(iR, iR + 320);
  ok(/clearColWidths\(\)/.test(body), "resetColWidthsOnly 仍清列宽");
  ok(!/setRowHeight/.test(body), "★ resetColWidthsOnly 不再重置行高（行高只能靠拖）");
}

// ---------- [B] 模板静态断言 ----------
console.log("\n===== [B] 模板：旧控件移除 / 新拖拽条就位 / 留档按钮挪位 =====");
{
  // 旧工具条彻底移除
  for (const k of ["viewBar", "vb-range", "vb-btn", "vb-hint", "vb-grp", "rowHVal", 'id="rowH"', "resetViewBtn"]) {
    ok(!tpl.includes(k), "★ 模板已移除旧控件「" + k + "」");
  }
  ok(!/<input[^>]*type=["']range["']/.test(tpl), "★ 模板里再无 range 滑块");

  // 新拖拽条
  ok(/id="rowResizer"/.test(tpl), "★ 新增左侧行高拖拽条 #rowResizer");
  ok(/class="row-resizer"/.test(tpl), "行高拖拽条带 .row-resizer 类");
  ok(/class="tbl-outer"/.test(tpl), "★ 表格外层包了 .tbl-outer（拖拽条不随表格横向滚动）");
  ok(/cursor:row-resize/.test(tpl), "★ 拖拽条光标 = row-resize（与列宽 col-resize 对称）");
  ok(/body\.row-resizing/.test(tpl), "拖动中给 body 加 .row-resizing（统一光标、禁选中）");
  // 拖拽条在面板内
  const iOuter = tpl.indexOf('class="tbl-outer"');
  const iRes = tpl.indexOf('id="rowResizer"');
  const iWrap = tpl.indexOf('class="tbl-wrap"');
  ok(iOuter > 0 && iRes > iOuter && iWrap > iRes,
    "★ DOM 顺序：tbl-outer → rowResizer → tbl-wrap（拖拽条在表格左侧）");

  // 留档按钮已挪到 pending-panel 的 pp-actions 里，紧邻 clearPendingBtn
  ok(/id="archiveMgrBtn"/.test(tpl), "模板仍有 #archiveMgrBtn（只是挪了位置）");
  const iPP = tpl.indexOf('class="pp-actions"');
  const iClear = tpl.indexOf('id="clearPendingBtn"');
  const iArc = tpl.indexOf('id="archiveMgrBtn"');
  ok(iPP > 0 && iClear > iPP && iArc > iClear,
    "★ ★archiveMgrBtn 位于 pp-actions 内、且在 clearPendingBtn 之后");
  // 挪位后不能还留在原工具条位置
  ok(iArc < tpl.indexOf('id="dataTable"'),
    "archiveMgrBtn 在上传区（表格之前），不在表格后的工具条里");
}

// ---------- [B2] app.js 接线 ----------
console.log("\n===== [B2] app.js 接线 =====");
{
  ok(/function bindRowResizer\s*\(/.test(appSrc), "★ 新增 bindRowResizer()");
  ok(/bindRowResizer\(\)/.test(appSrc), "★ bindRowResizer 被调用");
  ok(/ROW_DRAG/.test(appSrc), "★ 有 ROW_DRAG 拖动会话标记（防多指并发）");
  // 与列宽同一套事件流：pointerdown 在把手，move/up 在 document
  const iB = appSrc.indexOf("function bindRowResizer");
  const b = appSrc.slice(iB, iB + 1800);
  ok(/addEventListener\("pointerdown"/.test(b), "拖拽条上绑 pointerdown");
  ok(/document\.addEventListener\("pointermove"/.test(b), "pointermove 挂 document（不吃指针捕获）");
  ok(/document\.addEventListener\("pointerup"/.test(b), "pointerup 挂 document");
  ok(/document\.addEventListener\("pointercancel"/.test(b), "pointercancel 也解绑（触屏中断兜底）");
  ok(/removeEventListener\("pointermove"/.test(b), "拖动结束后解绑，避免重复叠加监听");
  ok(/getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--row-h"\)/.test(b),
    "★ 起始行高读 CSS 变量（不量 DOM，空表也能拖）");
  ok(/setRowHeight\(h\)/.test(b), "★ 拖动中调 setRowHeight（写变量 → 所有行同步）");
  // 不得再用 setPointerCapture（renderTable 重建会变游离节点，历史踩坑）
  ok(!/setPointerCapture/.test(b), "★ 未使用 setPointerCapture（沿用列宽拖拽的既有结论）");

  // 行高写变量而非逐行改 DOM（千行性能）
  const iS = appSrc.indexOf("function setRowHeight");
  const sb = appSrc.slice(iS, iS + 700);
  ok(/setProperty\("--row-h"/.test(sb), "★ 行高写 CSS 变量 --row-h");
  ok(!/querySelectorAll\("tbody tr"\).*style\.height/s.test(sb), "★ 未逐行写 style.height（避免卡顿）");

  // 导出面
  ok(/setRowHeight,\s*resetColWidthsOnly/.test(appSrc), "★ AppCore 导出改为 resetColWidthsOnly");
  ok(!/setRowHeight,\s*resetView\b/.test(appSrc), "AppCore 不再导出 resetView");

  // 快照下隐藏拖拽条
  ok(/#rowResizer"\);\s*if \(rowRes\) rowRes\.classList\.add\("hidden"\)/.test(appSrc),
    "★ 快照模式隐藏行高拖拽条（快照是冻结报告）");
}

// ---------- [C] 产物防线 ----------
console.log("\n===== [C] 产物防线 =====");
{
  for (const f of ["index.html", "index.single.html"]) {
    const h = fs.readFileSync(path.join(R, f), "utf8");
    ok(/rowResizer/.test(h), f + " 含行高拖拽条");
    ok(/row-resizing/.test(h), f + " 含拖动中样式");
    ok(/cursor:row-resize/.test(h), f + " 含 row-resize 光标");
    ok(/tbl-outer/.test(h), f + " 含 .tbl-outer 包裹层");
    ok(/bindRowResizer/.test(h), f + " 含 bindRowResizer（已 inline）");
    ok(!/vb-range/.test(h), f + " ★ 旧滑块样式已从产物中消失");
    ok(!/id="rowH"/.test(h), f + " ★ 旧 #rowH 节点已从产物中消失");
    ok(!/resetViewBtn/.test(h), f + " ★ 旧「恢复默认」按钮已从产物中消失");
  }
}

console.log("\n通过 " + pass + " / " + (pass + fail));
if (fail) process.exit(1);
