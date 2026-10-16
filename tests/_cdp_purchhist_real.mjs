// 购药记录浮窗：**走真实上传链路**的端到端核验
//   node tests/_cdp_purchhist_real.mjs "<销售明细.xlsx>"                  → 验本地 index.html
//   node tests/_cdp_purchhist_real.mjs "<销售明细.xlsx>" "<线上URL>"        → 验线上
// 与 _cdp_purchhist.mjs 的区别：那个直接往 STORE.sales 灌数据，这个必须先真的上传文件，
// 经过「识别 → 去重 → 建行」，确认浮窗在真实数据链路上同样取得到、且取到的是对的。
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9569;
const FILE = process.argv[2];
if (!FILE) { console.log("用法: node tests/_cdp_purchhist_real.mjs <销售明细.xlsx> [线上URL]"); process.exit(1); }
const PAGE = process.argv[3] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SHOT = process.argv[4] || "tests/_ph_real_shot.png";
console.log("目标页面:", PAGE);
console.log("上传文件:", FILE);

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,980",
  "--disable-application-cache", "--disk-cache-size=1",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_phr",
  PAGE], { stdio: "ignore" });

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let id = 0; const pending = new Map(); const logs = [];
  const send = (m, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: params || {} })); });
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails || {};
      logs.push("[EXCEPTION] " + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
  });
  await new Promise(r => ws.on("open", r));
  await send("Runtime.enable"); await send("DOM.enable"); await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", { expression: "!!(window.AppCore&&window.Pipeline&&window.Mapping&&window.XLSX)", returnByValue: true });
    if (r.result && r.result.result && r.result.result.value) break;
    await sleep(400);
  }
  const evalJS = async (e, aw = true) => {
    const r = await send("Runtime.evaluate", { expression: e, awaitPromise: aw, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await evalJS(`window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));}; "ok"`);
  console.log("脚本就绪:", await evalJS(`!!(window.AppCore && window.Pipeline && window.Mapping)`));

  // ---- 真实上传 ----
  const doc = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [path.resolve(FILE)] });
  await evalJS(`document.querySelector("#allInput").dispatchEvent(new Event("change",{bubbles:true})); "sent"`);
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const t = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent||""`);
    if (t && t.includes("共")) break;
  }
  console.log("识别:", await evalJS(`(document.querySelector("#pendingList")||{}).innerText`));
  await evalJS(`document.querySelector("#startBtn").click(); "clicked"`);
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if (await evalJS(`window.__alerts.length`)) break;
    if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) break;
  }
  const al = await evalJS(`window.__alerts`);
  if (al && al.length) console.log("⚠ 页面弹窗:", JSON.stringify(al));

  // ---- 注入探针 ----
  const SCRIPT = fs.readFileSync(path.join(process.cwd(), "tests", "_ph_real_probe.js"), "utf8");
  const r = await send("Runtime.evaluate", { expression: SCRIPT, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.log("页面异常:", JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 2000));
  }
  const val = r.result && r.result.result && r.result.result.value;
  console.log(typeof val === "string" ? val : JSON.stringify(r.result, null, 2).slice(0, 3000));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已保存 " + SHOT);
  }
  if (logs.length) { console.log("\n=== 页面异常 ==="); for (const l of logs) console.log(l.slice(0, 400)); }

  const failed = typeof val === "string" && /❌/.test(val);
  ws.close(); p.kill();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log("异常:", e); p.kill(); process.exit(1); });
