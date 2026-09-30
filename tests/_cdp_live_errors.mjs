// 抓线上页面的加载期错误（脚本解析/执行失败）
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9469;
const LIVE = "https://lynx-fanlv.github.io/reperchace_dashboard/";

const p = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_live2",
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
  let id = 0; const pending = new Map(); const evts = [];
  const send = (m, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: params || {} })); });
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) evts.push(msg);
  });
  await new Promise(r => ws.on("open", r));
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable"); await send("Network.enable");
  await sleep(5000);

  console.log("=== 加载期事件 ===");
  for (const e of evts) {
    if (e.method === "Runtime.exceptionThrown") {
      const d = e.params.exceptionDetails || {};
      console.log("[EXCEPTION]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
      if (d.url) console.log("   at", d.url, "line", d.lineNumber, "col", d.columnNumber);
    } else if (e.method === "Runtime.consoleAPICalled") {
      console.log("[" + e.params.type + "]", (e.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(" ").slice(0, 400));
    } else if (e.method === "Log.entryAdded") {
      const en = e.params.entry || {};
      console.log("[LOG/" + en.level + "]", en.text, en.url ? (" @ " + en.url) : "");
    } else if (e.method === "Network.loadingFailed") {
      console.log("[NET FAIL]", e.params.type, e.params.errorText, e.params.requestId);
    } else if (e.method === "Network.responseReceived") {
      const r = e.params.response || {};
      if (r.status >= 400) console.log("[HTTP " + r.status + "]", r.url);
    }
  }

  const evalJS = async (e, aw = true) => {
    const r = await send("Runtime.evaluate", { expression: e, awaitPromise: aw, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  console.log("\n=== 全局状态 ===");
  console.log("XLSX:", await evalJS(`typeof XLSX`));
  console.log("Mapping:", await evalJS(`typeof window.Mapping`));
  console.log("Pipeline:", await evalJS(`typeof window.Pipeline`));
  console.log("AppCore:", await evalJS(`typeof window.AppCore`));
  console.log("脚本标签数:", await evalJS(`document.querySelectorAll("script").length`));
  console.log("脚本 src 列表:", await evalJS(`JSON.stringify(Array.from(document.querySelectorAll("script")).map(s=>s.src||"(inline "+(s.textContent||"").length+" chars)"))`));

  ws.close(); p.kill(); process.exit(0);
})().catch(e => { console.log("异常:", e); p.kill(); process.exit(1); });
