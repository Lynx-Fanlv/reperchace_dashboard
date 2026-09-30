// 线上验收：打开 GitHub Pages 真实页面，上传真实销售明细，确认识别为「销售」且能分析
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9468;
const ROOT = "C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard";
const LIVE = "https://lynx-fanlv.github.io/reperchace_dashboard/";
const files = process.argv.slice(2).map(f => path.resolve(f));

const p = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_live",
  LIVE,
], { stdio: "ignore" });

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let wsUrl = null;
  for (let i = 0; i < 50; i++) {
    try {
      const j = JSON.parse(await get("http://127.0.0.1:" + PORT + "/json"));
      const pg = j.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch (e) { }
    await sleep(400);
  }
  if (!wsUrl) { console.log("未能连接 CDP"); p.kill(); process.exit(1); }

  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0; const pending = new Map(); const logs = [];
  const send = (m, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: params || {} })); });
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === "Runtime.consoleAPICalled") {
      logs.push("[" + msg.params.type + "] " + (msg.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails || {};
      logs.push("[EXCEPTION] " + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
  });
  await new Promise(r => ws.on("open", r));
  await send("Runtime.enable"); await send("DOM.enable"); await send("Page.enable");
  // 线上单文件版约 2MB，解析需要时间 —— 轮询等脚本挂载完成，别用固定 sleep
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", { expression: "!!(window.AppCore&&window.Pipeline&&window.Mapping)", returnByValue: true });
    if (r.result && r.result.result && r.result.result.value) break;
  }

  const evalJS = async (e, aw = true) => {
    const r = await send("Runtime.evaluate", { expression: e, awaitPromise: aw, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  console.log("页面 URL:", await evalJS(`location.href`));
  console.log("XLSX 是否已定义(线上):", await evalJS(`typeof XLSX`));
  console.log("脚本就绪:", await evalJS(`!!(window.AppCore && window.Pipeline && window.Mapping)`));
  console.log("SheetJS 版本:", await evalJS(`(typeof XLSX!=="undefined" && XLSX.version) || "(未定义)"`));

  await evalJS(`window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));}; "ok"`);

  const doc = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files });
  await evalJS(`document.querySelector("#allInput").dispatchEvent(new Event("change",{bubbles:true})); "sent"`);

  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const n = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent||""`);
    if (n && n.includes("共")) break;
  }

  console.log("\n=== 识别结果（这是关键）===");
  console.log("pendingTotalCount:", await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent`));
  console.log("pendingList:", JSON.stringify(await evalJS(`(document.querySelector("#pendingList")||{}).innerText`)));
  console.log("startBtn.disabled:", await evalJS(`(document.querySelector("#startBtn")||{}).disabled`));

  console.log("\n=== 点击开始分析 ===");
  await evalJS(`document.querySelector("#startBtn").click(); "clicked"`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await evalJS(`window.__alerts.length`)) break;
    if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) break;
  }
  console.log("board 显示:", await evalJS(`!document.querySelector("#board").classList.contains("hidden")`));
  console.log("dataInfo:", await evalJS(`(document.querySelector("#dataInfo")||{}).textContent`));
  console.log("alerts:", JSON.stringify(await evalJS(`window.__alerts`)));
  console.log("STORE.sales:", await evalJS(`(window.AppCore&&window.AppCore.STORE&&window.AppCore.STORE.sales||[]).length`));

  // 表格是否真的渲染出分类列
  console.log("表格行数:", await evalJS(`document.querySelectorAll("#tableBody tr, tbody tr").length`));
  console.log("cat-chip 数:", await evalJS(`document.querySelectorAll(".cat-chip, [class*=cat]").length`));

  if (logs.length) { console.log("\n=== console ==="); for (const l of logs) console.log(l.slice(0, 300)); }

  ws.close(); p.kill(); process.exit(0);
})().catch(e => { console.log("异常:", e); p.kill(); process.exit(1); });
