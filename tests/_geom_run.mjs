// 真实浏览器几何核实：长文本是否真的不再撑开表格 + 周期编辑交互是否可用
// 用 CDP 打开构建产物，注入数据，量测列宽与行高
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9555;
const PAGE = "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,900",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_geom",
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
  await sleep(1500);

  const SCRIPT = fs.readFileSync(path.join(process.cwd(), "tests", "_geom_probe.js"), "utf8");
  const r = await send("Runtime.evaluate", { expression: SCRIPT, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.log("页面异常:", JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 2000));
  }
  const val = r.result && r.result.result && r.result.result.value;
  console.log(typeof val === "string" ? val : JSON.stringify(r.result, null, 2).slice(0, 3000));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    fs.writeFileSync("tests/_geom_shot.png", Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已保存 tests/_geom_shot.png");
  }
  ws.close(); p.kill(); process.exit(0);
})();
