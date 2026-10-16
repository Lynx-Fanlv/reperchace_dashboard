// 真实浏览器验收：购药记录浮窗（几何 / 布局 / 交互）
//   node tests/_cdp_purchhist.mjs                 → 验本地多文件版 index.html
//   node tests/_cdp_purchhist.mjs <线上URL>        → 验线上单文件版
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9567;
const PAGE = process.argv[2] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SHOT = process.argv[3] || "tests/_ph_shot.png";
console.log("目标页面:", PAGE);

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,900",
  // 必须禁缓存：user-data-dir 跨次复用，线上那个 2MB 单文件版一旦被缓存就验到旧内容
  "--disable-application-cache", "--disk-cache-size=1",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_ph",
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
  let id = 0; const pending = new Map();
  const send = (m, pr) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: pr || {} })); });
  ws.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  // 等脚本就绪（不用固定 sleep：单文件版 2MB 解析慢）
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "!!(window.AppCore&&window.Pipeline&&window.Mapping)",
      returnByValue: true,
    });
    if (r.result && r.result.result && r.result.result.value) break;
    await sleep(400);
  }

  const SCRIPT = fs.readFileSync(path.join(process.cwd(), "tests", "_ph_probe.js"), "utf8");
  const r = await send("Runtime.evaluate", { expression: SCRIPT, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.log("页面异常:", JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 2500));
  }
  const val = r.result && r.result.result && r.result.result.value;
  console.log(typeof val === "string" ? val : JSON.stringify(r.result, null, 2).slice(0, 3000));

  // 截图（浮窗此时是打开的）
  const ready = await send("Runtime.evaluate", { expression: "!!window.__PH_SHOT_READY__ || !!document.querySelector('#phPop:not(.hidden)')", returnByValue: true });
  if (ready.result && ready.result.result && ready.result.result.value) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
      console.log("\n截图已保存 " + SHOT);
    }
  }

  const failed = typeof val === "string" && /❌/.test(val);
  ws.close(); p.kill();
  process.exit(failed ? 1 : 0);
})();
