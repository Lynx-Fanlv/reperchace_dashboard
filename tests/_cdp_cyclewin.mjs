// 标准周期窗口「换批次」真实链路验收
//   node tests/_cdp_cyclewin.mjs "<A.xlsx>" "<B.xlsx>" [页面URL] [截图路径]
// A / B 必须是**不含相同品种**的两个销售明细（A 里有的品种，B 里不能有）。
// 本机现成的一对：_fixture_sales_query.xlsx（百悦泽） + _fixture_sales_other.xlsx（奥布替尼片）。
//
// 为什么必须有一层「真实上传链路」的验收：
//   「只补不清」这个 bug 只在**同一会话换批次**时暴露 —— 先传含百泽安/百悦泽的数据，再（移除已选文件后）
//   传别的品种，周期窗口里会同时挂着两批品种，用户看到的就是「我根本没上传这两个品，怎么还在这儿」。
//   合成数据那层的探针直接调 syncStdCycles()，验不出「上传链路有没有走到 prune」。
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9583;
const FILE_A = process.argv[2];
const FILE_B = process.argv[3];
if (!FILE_A || !FILE_B) {
  console.log('用法: node tests/_cdp_cyclewin.mjs "<A.xlsx>" "<B.xlsx>" [页面URL] [截图路径]');
  process.exit(1);
}
const PAGE = process.argv[4] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SHOT = process.argv[5] || "tests/_cyclewin_shot.png";
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_cyclewin_" + Date.now();
console.log("目标页面:", PAGE);
console.log("A =", FILE_A, "\nB =", FILE_B);

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,1180",
  "--disable-application-cache", "--disk-cache-size=1",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + UDD, PAGE], { stdio: "ignore" });

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = [];
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; out.push((c ? "  ✅ " : "  ❌ ") + m); };
const log = (m) => out.push(m);

(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const j = JSON.parse(await get("http://127.0.0.1:" + PORT + "/json"));
      const pg = j.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch (e) { }
    await sleep(400);
  }
  if (!wsUrl) { console.log("未能连接 CDP"); p.kill(); process.exit(1); }

  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  const send = (m, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: params || {} })); });
  ws.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  await new Promise(r => ws.on("open", r));
  await send("Runtime.enable"); await send("DOM.enable"); await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });

  const evalJS = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  // 单文件版 ~2MB，解析慢 —— 必须轮询等三个全局对象都挂上
  for (let i = 0; i < 100; i++) {
    if (await evalJS("!!(window.AppCore&&window.Pipeline&&window.Mapping&&window.XLSX)") === true) break;
    await sleep(400);
  }
  await evalJS(`window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));};
                window.confirm=function(){return true;}; "ok"`);

  // 周期窗口里当前挂着的品种（被测对象）
  const winFams = () => evalJS(`[...document.querySelectorAll("#cycleInputs .cycle-item")].map(e=>e.dataset.fam).sort()`);
  const winText = () => evalJS(`((document.querySelector("#cycleInputs")||{}).innerText||"").replace(/\\n/g," ")`);
  // 独立口径（不依赖被测 DOM）：本次 STORE.sales 里真实出现过的品种
  const dataFams = () => evalJS(`[...new Set(AppCore.STORE.sales.map(s=>s.product).filter(Boolean))].sort()`);
  const stdKeys = () => evalJS(`Object.keys(AppCore.state.stdCycle).sort()`);
  const qtyKeys = () => evalJS(`Object.keys(AppCore.state.qtyScale).sort()`);

  // 上传一个文件并跑完分析
  async function uploadAndAnalyze(file) {
    const doc = await send("DOM.getDocument", { depth: -1 });
    const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [path.resolve(file)] });
    await evalJS(`document.querySelector("#allInput").dispatchEvent(new Event("change",{bubbles:true})); "sent"`);
    for (let i = 0; i < 90; i++) {
      await sleep(400);
      const t = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent||""`);
      if (t && t.includes("共")) break;
    }
    await evalJS(`document.querySelector("#startBtn").click(); "clicked"`);
    for (let i = 0; i < 90; i++) {
      await sleep(400);
      if (await evalJS(`window.__alerts.length`)) break;
      if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) break;
    }
    const al = await evalJS(`window.__alerts`);
    if (al && al.length) { log("  ⚠ 页面弹窗: " + JSON.stringify(al)); await evalJS(`window.__alerts=[]; "c"`); }
    await sleep(300);
  }

  log("=== [1] 上传前：窗口应是空态提示 ===");
  const t0 = await winText();
  ok(/自动生成/.test(String(t0)), "窗口显示未开始分析的提示（" + String(t0).slice(0, 40) + "）");
  ok((await winFams()).length === 0, "窗口里没有任何品种");
  ok((await stdKeys()).length === 0, "stdCycle 为空（不预填内置商品）");

  log("\n=== [2] 上传 A 并分析 ===");
  await uploadAndAnalyze(FILE_A);
  const famA = await dataFams();          // 独立口径
  const winA = await winFams();
  log("  A 数据里的品种 = " + JSON.stringify(famA));
  log("  周期窗口显示   = " + JSON.stringify(winA));
  ok(famA.length > 0, "A 已解析出品种（" + famA.length + " 个）");
  ok(JSON.stringify(winA) === JSON.stringify(famA), "★ 窗口品种 == 本次数据品种");
  ok((await stdKeys()).length === famA.length, "stdCycle 也只有这些品种");

  log("\n=== [3] 换批次：移除已选文件 → 上传 B（不含 A 的品种）===");
  const firstA = famA[0];
  // 清空待分析清单（真实用户动作），这样本次分析只含 B
  await evalJS(`document.querySelector("#clearPendingBtn").click(); "cleared"`);
  await sleep(300);
  await uploadAndAnalyze(FILE_B);
  const famB = await dataFams();
  const winB = await winFams();
  log("  B 数据里的品种 = " + JSON.stringify(famB));
  log("  周期窗口显示   = " + JSON.stringify(winB));
  log("  stdCycle 键    = " + JSON.stringify(await stdKeys()));
  ok(famB.length > 0, "B 已解析出品种（" + famB.length + " 个）");
  ok(!famB.includes(firstA), "B 里确实没有 A 的品种「" + firstA + "」（前提成立）");
  ok(JSON.stringify(winB) === JSON.stringify(famB), "★ 窗口品种 == 本次数据品种");
  ok(!winB.includes(firstA), "★★ 上一批的「" + firstA + "」已从窗口消失（不在本次数据里）");
  ok(!(await stdKeys()).includes(firstA), "★ stdCycle 里也没有残留");
  ok(!(await qtyKeys()).includes(firstA), "★ qtyScale 里也没有残留");

  log("\n=== [4] 点「清空全部」→ 窗口回到空态 ===");
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (shot.result && shot.result.data) fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
  await evalJS(`document.querySelector("#clearAllBtn").click(); "cleared"`);
  await sleep(400);
  const t4 = await winText();
  ok(/自动生成/.test(String(t4)), "★ 窗口回到提示文案（" + String(t4).slice(0, 40) + "）");
  ok((await winFams()).length === 0, "★ 窗口里没有任何品种");
  ok((await stdKeys()).length === 0 && (await qtyKeys()).length === 0,
    "★ stdCycle / qtyScale 均已清零");
  ok(await evalJS(`document.querySelector("#board").classList.contains("hidden")`), "看板已隐藏（清空全部生效）");

  log("\n通过 " + pass + " / " + (pass + fail));
  console.log(out.join("\n"));

  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log(out.join("\n"));
  console.log("\n异常:", e && e.message ? e.message : e);
  p.kill(); process.exit(1);
});
