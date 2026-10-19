// 布局留证：加载真实 fixture → 表格截图（默认行高）+ 关键单元格文字是否被截断。
// 用法：node tests/_probe_layout_shot.mjs 1440,1180 tests/_shot_1440.png
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9617;
const PAGE = "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SALES = path.resolve("_fixture_sales_query.xlsx");
const FU = path.resolve("_fixture_followup_synth.xlsx");
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_shot_" + Date.now();
const WIN = process.argv[2] || "1440,1180";
const OUT = process.argv[3] || "tests/_shot_layout.png";

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--window-size=" + WIN, "--disable-application-cache", "--disk-cache-size=1",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + UDD, PAGE], { stdio: "ignore" });
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
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  const send = (m, pr) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: pr || {} })); });
  ws.on("message", (m) => { const msg = JSON.parse(m.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  const evalJS = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  for (let i = 0; i < 50; i++) {
    if (await evalJS("!!(window.AppCore&&window.Pipeline&&window.Mapping&&window.XLSX&&window.ExcelJS)")) break;
    await sleep(300);
  }
  await evalJS(`(() => { window.__alerts=[]; window.alert=m=>window.__alerts.push(String(m)); return 1; })()`);
  const uploadFile = async (absPath) => {
    const before = await evalJS(`document.querySelectorAll("#pendingList .file-chip").length`);
    const doc = await send("DOM.getDocument");
    const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [absPath] });
    await evalJS(`document.querySelector("#allInput").dispatchEvent(new Event("change",{bubbles:true})); "ok"`);
    for (let i = 0; i < 40; i++) {
      if (await evalJS(`document.querySelectorAll("#pendingList .file-chip").length`) > before) break;
      await sleep(250);
    }
  };
  await uploadFile(SALES);
  await uploadFile(FU);
  await evalJS(`document.querySelector("#startBtn").click(); "c"`);
  for (let i = 0; i < 40; i++) {
    const mask = await evalJS(`(() => { const m=document.querySelector("#arcMask"); return !!m && !m.classList.contains("hidden"); })()`);
    if (mask) { await evalJS(`document.querySelector("#arcSkip").click(); "ok"`); continue; }
    if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) break;
    await sleep(400);
  }
  await sleep(700);

  // 报告：每个有「小标」的单元格是否把小标挤没了
  const info = await evalJS(`(() => {
    const ths = [...document.querySelectorAll("#thead th")];
    const rows = [...document.querySelectorAll("#tbody tr.data-row")];
    const pick = (name) => {
      const i = ths.findIndex(t => t.innerText.trim() === name);
      return rows.slice(0, 5).map(tr => {
        const td = tr.children[i];
        const d = td.querySelector(".d-date"), s = td.querySelector(".sub");
        return { txt: td.innerText.trim().replace(/\\n/g, " | "),
                 dateW: d ? Math.round(d.getBoundingClientRect().width) : null,
                 subW: s ? Math.round(s.getBoundingClientRect().width) : null,
                 subScroll: s ? s.scrollWidth : null };
      });
    };
    const box = document.querySelector(".tbl-wrap").getBoundingClientRect();
    return { due: pick("应购药日"), rowH: Math.round(rows[0].getBoundingClientRect().height),
             doc: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
                    innerW: innerWidth, wrapW: Math.round(document.querySelector(".tbl-wrap").clientWidth) },
             box: { x: box.x + scrollX, y: box.y + scrollY, w: box.width, h: Math.min(box.height, 460) } };
  })()`);
  console.log(JSON.stringify(info, null, 1));

  const shot = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: { x: info.box.x, y: info.box.y, width: info.box.w, height: info.box.h, scale: 1 },
  });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log("截图已保存", OUT);
  ws.close(); p.kill();
})();
