// CDP 端到端验证：真实上传两份含重叠数据的销售明细，确认去重提示条出现且数字正确
//
// 用法：node tests/_cdp_dedup.mjs <文件A> <文件B>
//
// 做法：用 CDP 的 DOM.setFileInputFiles 把本地真实 xlsx 直接塞进 <input type=file>，
//       然后触发分析，读取 #dedupNotice 的文本与 STORE.dedup 的数字。
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9455;
const ROOT = "C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard";
const URL_ = "file:///" + ROOT + "/index.html";

const fileA = process.argv[2];
const fileB = process.argv[3];
if (!fileA || !fileB) { console.log("用法: node tests/_cdp_dedup.mjs <A.xlsx> <B.xlsx>"); process.exit(1); }

const p = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_dedup",
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
  const pending = new Map(), events = [];
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  await new Promise((r) => ws.on("open", r));

  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Page.enable");
  await sleep(2500);

  const evalJS = async (expr, awaitPromise = true) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // 1) 确认页面脚本已就绪
  const ready = await evalJS(`!!(window.AppCore && window.Pipeline && window.Mapping)`);
  console.log("脚本就绪:", ready);
  if (!ready) { console.log("AppCore/Pipeline/Mapping 未挂载"); ws.close(); p.kill(); process.exit(1); }

  // 2) 把两个真实文件塞进 file input（真实页面里 input id 是 #allInput）
  const doc = await send("DOM.getDocument", { depth: -1 });
  const rootId = doc.result.root.nodeId;
  const q = await send("DOM.querySelector", { nodeId: rootId, selector: "#allInput" });
  const nodeId = q.result.nodeId;
  if (!nodeId) { console.log("找不到 #allInput"); ws.close(); p.kill(); process.exit(1); }
  await send("DOM.setFileInputFiles", { nodeId, files: [fileA, fileB] });

  // 3) 手动触发 change（headless 下 setFileInputFiles 不一定派发 change）
  await evalJS(`(function(){ const el=document.querySelector("#allInput"); el.dispatchEvent(new Event("change",{bubbles:true})); return el.files.length; })()`, false);

  // 4) 等两个文件都被识别进 pendingFiles
  let nFiles = 0, chips = "";
  for (let i = 0; i < 90; i++) {
    chips = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent || ""`).catch(() => "");
    const m = /共 (\d+) 个文件/.exec(chips);
    nFiles = m ? +m[1] : 0;
    if (nFiles >= 2) break;
    await sleep(500);
  }
  console.log("已识别文件:", chips || "(空)");

  // 5) 触发分析
  const btnState = await evalJS(`(function(){ const b=document.querySelector("#startBtn"); if(!b) return "noBtn"; b.click(); return "clicked, disabled="+b.disabled; })()`, false);
  console.log("开始分析按钮:", btnState);

  // 6) 等分析结束（STORE.dedup 被填上）
  let dd = null;
  for (let i = 0; i < 360; i++) {
    dd = await evalJS(`(function(){ try{ const d=window.AppCore.STORE && window.AppCore.STORE.dedup; return d?JSON.stringify({total:d.total,kept:d.kept,removed:d.removed,groups:d.groups,keptNoTicket:d.keptNoTicket}):null; }catch(e){ return "ERR:"+e.message; } })()`).catch((e) => "THROW:" + e.message);
    if (dd && dd !== "null") break;
    await sleep(500);
  }

  console.log("\n===== 去重统计（STORE.dedup）=====");
  console.log(dd || "(STORE.dedup 仍为 null —— 未走到去重分支)");

  const box = await evalJS(`(function(){ const b=document.querySelector("#dedupNotice"); if(!b) return "noBox"; return JSON.stringify({hidden:b.classList.contains("hidden"), text:(b.innerText||"").slice(0,500)}); })()`);
  console.log("\n===== 提示条 #dedupNotice =====");
  console.log(box);

  const info = await evalJS(`(document.querySelector("#dataInfo")||{}).textContent || ""`);
  console.log("\n===== #dataInfo =====");
  console.log(info);

  // 展开详情表，验证行数与列数
  const detail = await evalJS(`(function(){
    const tg=document.querySelector("#ddToggle"); if(!tg) return "noToggle";
    tg.click();
    const d=document.querySelector("#ddDetail");
    const rows=d?d.querySelectorAll("tbody tr").length:0;
    const cols=d&&d.querySelector("tbody tr")?d.querySelector("tbody tr").children.length:0;
    const more=(d&&d.querySelector(".dd-more")||{}).textContent||"";
    return JSON.stringify({detailHidden:d?d.classList.contains("hidden"):null, rows, cols, more, toggleText:tg.textContent});
  })()`);
  console.log("\n===== 详情表 =====");
  console.log(detail);

  const errs = events.filter(e => e.method === "Runtime.exceptionThrown");
  if (errs.length) {
    console.log("\n===== 页面 JS 异常 =====");
    errs.slice(0, 5).forEach(e => console.log(JSON.stringify(e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text)));
  }

  ws.close(); p.kill();
  process.exit(0);
})();
