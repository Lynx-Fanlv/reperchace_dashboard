// 诊断探针：量出「未购药原因 / 随访信号」等列的真实可用宽度、文字溢出与行高分布。
// 只读不改，用于给「换行 vs 省略」的取舍提供数据。
// 用法：node tests/_probe_table_layout.mjs
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9611;
const PAGE = "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SALES = path.resolve("_fixture_sales_query.xlsx");
const FU = path.resolve("_fixture_followup_synth.xlsx");
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_layout_" + Date.now();
const WIN = process.argv[2] || "1440,1180";

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
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
  if (!wsUrl) { console.log("未能连接 CDP"); p.kill(); process.exit(1); }
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
    if (await evalJS(`(() => { const m=document.querySelector("#arcMask"); return !!m && !m.classList.contains("hidden"); })()`)) {
      await evalJS(`document.querySelector("#arcSkip").click(); "ok"`);
      continue;
    }
    if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) break;
    await sleep(400);
  }
  await sleep(600);

  const data = await evalJS(`(() => {
    const wrap = document.querySelector("#tblWrap");
    const tbl = document.querySelector("#dataTable");
    const ths = [...document.querySelectorAll("#thead th")];
    const rows = [...document.querySelectorAll("#tbody tr.data-row")];
    const cols = ths.map((th, ci) => {
      const cs = getComputedStyle(th);
      const w = th.getBoundingClientRect().width;
      const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
      const inner = w - padL - padR;
      const texts = [];
      let over = 0, maxH = 0, filled = 0, clipped = 0, lines2 = 0;
      for (const tr of rows) {
        const td = tr.children[ci];
        if (!td) continue;
        const tdRect = td.getBoundingClientRect();
        const t = (td.innerText || "").trim();
        maxH = Math.max(maxH, tdRect.height);
        if (!t) continue;
        filled++;
        texts.push(t.length);
        // 真正的「溢出到右邻列」：单元格内某个元素的实际右边界超过 td 的内容右边界
        let worst = 0;
        td.querySelectorAll("*").forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > 0) worst = Math.max(worst, r.right - (tdRect.right - padR));
        });
        if (worst > 0.5) over++;
        // 被截断：内容高度 / 行数超过可见区域（scrollHeight 明显大于 clientHeight）
        const holder = td.querySelector(".clip1,.clipn") || td;
        if (holder.scrollHeight > holder.clientHeight + 1) clipped++;
        if (tdRect.height > 40) lines2++;
      }
      texts.sort((a, b) => a - b);
      const p50 = texts.length ? texts[Math.floor(texts.length * 0.5)] : 0;
      const p90 = texts.length ? texts[Math.floor(texts.length * 0.9)] : 0;
      const mx = texts.length ? texts[texts.length - 1] : 0;
      return { col: th.innerText.replace(/\\s+/g, " ").trim(), w: Math.round(w), inner: Math.round(inner),
               p50, p90, max: mx, spillCells: over, clippedCells: clipped,
               tallRows: lines2, maxCellH: Math.round(maxH), rows: filled };
    });
    const hs = rows.map(tr => tr.getBoundingClientRect().height);
    const dist = {};
    hs.forEach(h => { const k = Math.round(h); dist[k] = (dist[k] || 0) + 1; });
    hs.sort((a, b) => a - b);
    return {
      winW: innerWidth, wrapW: Math.round(wrap.getBoundingClientRect().width),
      tableW: Math.round(tbl.getBoundingClientRect().width),
      nCols: ths.length, nRows: rows.length,
      rowH: { min: Math.round(hs[0]), p50: Math.round(hs[Math.floor(hs.length/2)]), max: Math.round(hs[hs.length-1]), dist },
      cols,
      tblScrollW: tbl.scrollWidth, wrapClientW: wrap.clientWidth,
    };
  })()`);
  console.log(JSON.stringify(data, null, 1));
  ws.close(); p.kill();
})();
