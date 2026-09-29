import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9444;
const URL_ = process.argv[2] || "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/tests/_quota_probe.html";
const EXPR = process.argv[3] || null;

const p = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_probe",
  "--allow-file-access-from-files",
  URL_,
], { stdio: "ignore" });

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

  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.on("open", r));

  await send("Runtime.enable");
  await sleep(2500);

  const code = EXPR || `(async()=>{
    const out={};
    if(navigator.storage&&navigator.storage.estimate){
      const e=await navigator.storage.estimate();
      out.quotaGB=+(e.quota/1024/1024/1024).toFixed(2);
      out.usageMB=+(e.usage/1024/1024).toFixed(2);
      out.usageDetails=e.usageDetails||{};
    }
    out.persistedBefore = navigator.storage.persisted? await navigator.storage.persisted() : null;
    out.persistGranted = navigator.storage.persist? await navigator.storage.persist() : null;
    if(navigator.storage&&navigator.storage.estimate){
      const e2=await navigator.storage.estimate();
      out.quotaAfterGB=+(e2.quota/1024/1024/1024).toFixed(2);
    }
    out.opfs = !!(await navigator.storage.getDirectory().catch(()=>null));
    out.ua = navigator.userAgent;
    return JSON.stringify(out);
  })()`;

  const r = await send("Runtime.evaluate", { expression: code, awaitPromise: true, returnByValue: true });
  const val = r.result && r.result.result && r.result.result.value;
  console.log(val || JSON.stringify(r.result, null, 2));

  ws.close(); p.kill();
  process.exit(0);
})();
