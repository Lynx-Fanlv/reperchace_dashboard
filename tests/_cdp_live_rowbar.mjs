// 线上核验「行高拖拽条 + 工具条移除 + 留档按钮挪位」是否已生效
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9561;
const URL = "https://lynx-fanlv.github.io/reperchace_dashboard/";

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,900",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_live_row",
  URL], { stdio: "ignore" });

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

  // 2MB 单文件版解析要时间：轮询等脚本就绪，不能用固定 sleep
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", {
      expression: "!!(window.AppCore && window.Pipeline && window.Mapping)", returnByValue: true });
    if (r.result && r.result.result && r.result.result.value) { ready = true; break; }
  }
  console.log("脚本就绪:", ready);

  const SCRIPT = `(() => {
    const out = []; const ok = (c, m) => out.push((c ? '  ✅ ' : '  ❌ ') + m);
    out.push('=== 线上核验：新版 UI 形态 ===');
    ok(typeof XLSX === 'object', 'XLSX 已定义：' + typeof XLSX + (typeof XLSX==='object' ? ' (v'+XLSX.version+')' : ''));
    ok(!!window.AppCore, 'AppCore 已挂载');
    ok(!!window.Pipeline, 'Pipeline 已挂载');
    ok(!!window.Mapping, 'Mapping 已挂载');

    out.push('');
    out.push('--- 旧控件必须已移除 ---');
    ok(!document.getElementById('rowH'), '旧行高滑块 #rowH 已移除');
    ok(!document.getElementById('rowHVal'), '旧数值标签 #rowHVal 已移除');
    ok(!document.getElementById('resetViewBtn'), '旧「恢复默认」按钮已移除');
    ok(!document.getElementById('viewBar'), '整条 viewbar 已移除');
    ok(!document.querySelector('.vb-range'), '旧 .vb-range 样式节点已移除');
    ok(!document.querySelector('.vb-btn'), '旧 .vb-btn 样式节点已移除');

    out.push('');
    out.push('--- 新拖拽条 ---');
    const bar = document.getElementById('rowResizer');
    ok(!!bar, '左侧行高拖拽条 #rowResizer 存在');
    if (bar) {
      ok(getComputedStyle(bar).cursor === 'row-resize', '光标 row-resize');
      ok(!!bar.closest('.tbl-outer'), '位于 .tbl-outer 内');
      out.push('    拖拽条宽度 ' + Math.round(bar.getBoundingClientRect().width) + 'px');
    }

    out.push('');
    out.push('--- 留档按钮挪位 ---');
    const amb = document.getElementById('archiveMgrBtn');
    ok(!!amb, '本地留档按钮存在');
    if (amb) {
      const acts = amb.closest('.pp-actions');
      ok(!!acts, '位于 .pp-actions 内');
      ok(!!amb.closest('#pendingPanel'), '位于「已选文件」面板 #pendingPanel 内');
      if (acts) {
        const ids = [...acts.children].map(c => c.id);
        ok(ids.indexOf('archiveMgrBtn') > ids.indexOf('clearPendingBtn'),
           '排在「清空选择」之后：' + ids.join(' → '));
      }
    }

    out.push('');
    out.push('--- 拖拽条可用性（临时灌数据后量高度）---');
    const A = window.AppCore;
    const mk = (d, s) => ({ source:'sales', _row_id:'live::'+d+'_'+s, sales_time:d, order_status:'已完成',
      product_raw:'百泽安', product:'百泽安', qty:'1', amount:'1000', member_id:'M'+s,
      patient_name:'线上测试'+s, phone:'13800009999', member_phone:'13800009999',
      hospital:'成都医学院第一附属医院', pharmacy:'成都西三段药房', physician:'张医生',
      department:'肿瘤科', indication:'测试适应症', age:'60', gender:'男' });
    const rows = [];
    for (let i = 0; i < 12; i++) {
      const dd = new Date(2026, 7, 1 + i);
      const ds = dd.getFullYear()+'-'+String(dd.getMonth()+1).padStart(2,'0')+'-'+String(dd.getDate()).padStart(2,'0');
      rows.push(mk(ds, i+1));
    }
    A.STORE.sales = rows; A.STORE.followups = [];
    A.state.stdCycle = { '百泽安': 21 };
    A.state.cycleAlgo = 'reset'; A.state.refDate = '2026-09-20'; A.state.weekSel = 'all';
    A.state.page = 1; A.state.pageSize = 50;
    A.ensureStdCycles(['百泽安']);
    document.getElementById('board').classList.remove('hidden');
    return A.refresh().then(() => new Promise(r => setTimeout(r, 800))).then(() => {
      const t = document.getElementById('dataTable');
      const wrap = document.querySelector('.tbl-wrap');
      const b = document.getElementById('rowResizer');
      const trs = [...t.querySelectorAll('tbody tr.data-row')];
      ok(trs.length >= 10, '表格已渲染 ' + trs.length + ' 行');
      const bb = b.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
      out.push('    表格高 ' + Math.round(t.getBoundingClientRect().height) +
               'px / wrap 高 ' + Math.round(wb.height) +
               'px / 拖拽条高 ' + Math.round(bb.height) + 'px');
      // 注意：数据多时表格比 .tbl-wrap 更高（表格在 wrap 内滚动），
      //   拖拽条应当与 **wrap** 等高（= 可视区高度），而不是与表格等高。
      //   若与表格等高反而说明它被撑长了，会多出一段拖不到东西的空白。
      ok(bb.height >= Math.min(wb.height, t.getBoundingClientRect().height) - 4,
         '★ 拖拽条纵向覆盖可视区（线上）：' + Math.round(bb.height) + 'px');
      ok(Math.abs(bb.height - wb.height) <= 4,
         '★ 拖拽条与 .tbl-wrap 等高：' + Math.round(bb.height) + ' vs ' + Math.round(wb.height) + 'px');
      ok(bb.left < t.getBoundingClientRect().left + 1, '拖拽条在表格左侧');

      // 真实拖拽：逐帧派发
      const h0 = Math.round(trs[0].getBoundingClientRect().height);
      const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 40)));
      const dg = (type, y) => b.dispatchEvent(new PointerEvent(type, {
        bubbles:true, cancelable:true, clientX:bb.left+5, clientY:y, pointerId:7, button:0,
        buttons: type==='pointerup'?0:1 }));
      const sy = bb.top + bb.height/2;
      dg('pointerdown', sy);
      return (async () => {
        for (const d of [15, 30, 45]) { dg('pointermove', sy+d); await frame(); }
        dg('pointerup', sy+45);
        await new Promise(r => setTimeout(r, 250));
        const h1 = Math.round(trs[0].getBoundingClientRect().height);
        ok(h1 > h0 + 20, '拖动行高条生效：' + h0 + ' → ' + h1 + 'px');
        const all = trs.map(r => Math.round(r.getBoundingClientRect().height));
        ok(all.every(x => Math.abs(x - h1) <= 1), '★ 所有行同步：' + [...new Set(all)].join('/') + 'px');
        const cv = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
        ok(Math.abs(cv - h1) <= 1, '--row-h 下发 ' + cv + 'px');
        return out.join('\\n');
      })();
    });
  })()`;

  const r = await send("Runtime.evaluate", { expression: SCRIPT, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    console.log("页面异常:", JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 2500));
  }
  const val = r.result && r.result.result && r.result.result.value;
  console.log(typeof val === "string" ? val : JSON.stringify(r.result, null, 2).slice(0, 3000));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    fs.writeFileSync("tests/_live_row_shot.png", Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已保存 tests/_live_row_shot.png");
  }
  ws.close(); p.kill(); process.exit(0);
})();
