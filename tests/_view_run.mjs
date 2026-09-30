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
const PORT = 9557;
const PAGE = "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,900",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_view",
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

  const SCRIPT = fs.readFileSync(path.join(process.cwd(), "tests", "_view_probe.js"), "utf8");
  const r = await send("Runtime.evaluate", { expression: SCRIPT, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.log("页面异常:", JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 2000));
  }
  const val = r.result && r.result.result && r.result.result.value;
  console.log(typeof val === "string" ? val : JSON.stringify(r.result, null, 2).slice(0, 3000));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    fs.writeFileSync("tests/_view_shot.png", Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已保存 tests/_view_shot.png");
  }
  // 追加：额外把所有数据行各复制若干份，把表格撑长，再截一张用于看行高与拖拽条
  await send("Runtime.evaluate", { expression: `(() => {
    const A = window.AppCore, P = window.Pipeline;
    const NAME='测试患者2', PHONE='13800002222';
    const P1='百泽安', P2='百悦泽', P3='索托克拉', P4='无菌笔式注射针INSUPENSterilePenNeedle';
    const prods=[P1,P2,P3,P4];
    const mk=(date,prod,seed)=>({source:'sales',_row_id:'f::sales::s::'+date+'_'+seed,sales_time:date,
      order_status:'已完成',product_raw:prod,product:prod,qty:'1',amount:'1000',
      member_id:'M'+seed,patient_name:NAME+seed,phone:PHONE,member_phone:PHONE,
      hospital:'成都医学院第一附属医院(原:中国人民解放军第47军医院)',pharmacy:'成都西三段药房(连锁）',
      physician:'张医生',department:'肿瘤科',
      indication:'卵巢恶性肿瘤术后复发多处转移TxNxM1IV期结肠继发恶性肿瘤直肠继发恶性肿瘤',
      age:'60',gender:'男'});
    const rows=[];
    for(let i=0;i<24;i++){
      const d=new Date(2026,7,1+ (i%20));
      const ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      rows.push(mk(ds, prods[i%4], i+1));
    }
    A.STORE.sales = rows;
    A.STORE.followups=[]; A.STORE.cycles={}; A.STORE.notes={}; A.STORE.reasonOverrides={}; A.STORE.cycleOverrides={};
    A.state.stdCycle={}; prods.forEach(p=>A.state.stdCycle[p]=21);
    A.state.cycleAlgo='reset'; A.state.refDate='2026-09-20'; A.state.weekSel='all';
    A.state.page=1; A.state.pageSize=50;
    A.ensureStdCycles(prods);
    A.refresh();
    window.scrollTo(0, 700);
    const t=t=document.getElementById('dataTable');
    const r=document.getElementById('rowResizer');
    return JSON.stringify({rowResizer: !!r, barH: r?Math.round(r.getBoundingClientRect().height):0,
      rows: t.querySelectorAll('tbody tr.data-row').length,
      firstRowH: t.querySelector('tbody tr.data-row')?Math.round(t.querySelector('tbody tr.data-row').getBoundingClientRect().height):0});
  })()`, awaitPromise: true, returnByValue: true });
  await sleep(1200);
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  if (shot2.result && shot2.result.data) {
    fs.writeFileSync("tests/_view_shot2.png", Buffer.from(shot2.result.data, "base64"));
    console.log("截图已保存 tests/_view_shot2.png（多行表格）");
  }
  ws.close(); p.kill(); process.exit(0);
})();
