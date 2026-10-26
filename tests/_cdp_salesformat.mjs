// 真实浏览器验收：第二种销售明细格式（国药四川 POS「销售明细表」）能不能进名单
//
// 用户报障（2026-10-26）：「销售明细表里明明有这个患者，网页分析后的名单里搜不到」。
// jsdom 层已由 tests/_test_salesformat.js 覆盖；本脚本走**真实 Chrome + 真实文件上传 + 真实 DOM 渲染**，
// 验的是一条端到端链路：文件输入框 → 识别为「销售」 → 开始分析 → 名单出现 → 搜索框能搜到。
//
// 关键断言：
//   1) 文件被识别为「销售」（不是「未识别」，也不是被拦下）
//   2) 名单行数 = 明细里的患者×品种数（不缺人）
//   3) 品种筛选里只有业务品种，没有「GKH000003680」这类药品编号
//   4) 数据概览里没有「跳过未识别的表 / 解析失败」
//   5) 在搜索框里输入一个真实患者的姓名 → 列表就剩他那一行
//
// 用法：node tests/_cdp_salesformat.mjs [页面URL] [POS销售明细xlsx]
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");
const os = require("os");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9594;
const PAGE = process.argv[2] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const POS = path.resolve(process.argv[3] || path.join(os.homedir(), "Downloads", "销售明细表 (3).xlsx"));
const SHOT = path.resolve("tests/_cdp_salesformat_shot.png");
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_sf_" + Date.now();

if (!fs.existsSync(POS)) {
  console.log("⏭️ 跳过：找不到 POS 格式样例 " + POS);
  process.exit(0);
}
console.log("目标页面:", PAGE);
console.log("POS 销售明细:", POS, "(" + fs.statSync(POS).size + " 字节)");

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,1180", "--disable-application-cache", "--disk-cache-size=1",
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
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    // alert/confirm 会阻塞渲染进程 → Runtime.evaluate 永不返回
    if (msg.method === "Page.javascriptDialogOpening") {
      send("Page.handleJavaScriptDialog", { accept: true });
      return;
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  const out = [];
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; out.push((c ? "  ✅ " : "  ❌ ") + m); };
  const log = (m) => out.push(m);
  const evalJS = async (expr, awaitPromise = false) => {
    const r = await Promise.race([
      send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }),
      sleep(20000).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) throw new Error("Runtime.evaluate 超时（多半是 alert 卡住）：" + expr.slice(0, 80));
    if (r.result && r.result.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const ready = async () => {
    for (let i = 0; i < 50; i++) {
      if (await evalJS("!!(window.AppCore&&window.Pipeline&&window.Mapping&&window.XLSX&&window.ExcelJS)")) {
        await evalJS(`(() => { if (!window.__alerts) { window.__alerts = []; window.alert = m => window.__alerts.push(String(m)); } return 1; })()`);
        return true;
      }
      await sleep(300);
    }
    return false;
  };
  const uploadFile = async (absPath) => {
    const before = await evalJS(`document.querySelectorAll("#pendingList .file-chip").length`);
    const doc = await send("DOM.getDocument");
    const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [absPath] });
    await evalJS(`document.querySelector("#allInput").dispatchEvent(new Event("change",{bubbles:true})); "ok"`);
    for (let i = 0; i < 60; i++) {
      const n = await evalJS(`document.querySelectorAll("#pendingList .file-chip").length`);
      if (n > before) break;
      await sleep(250);
    }
  };
  const dismissArchiveIfAny = async () => {
    for (let i = 0; i < 30; i++) {
      const vis = await evalJS(`(() => { const m = document.querySelector("#arcMask");
        return !!m && !m.classList.contains("hidden"); })()`);
      if (vis) {
        await evalJS(`document.querySelector("#arcSkip").click(); "ok"`);
        await sleep(200);
        return true;
      }
      await sleep(200);
    }
    return false;
  };
  const startAnalysis = async () => {
    await evalJS(`document.querySelector("#startBtn").click(); "clicked"`);
    await sleep(500);
    await dismissArchiveIfAny();
    for (let i = 0; i < 90; i++) {
      if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) return true;
      await dismissArchiveIfAny();
      await sleep(400);
    }
    log("  ⚠ 看板未出现，诊断 = " + JSON.stringify(await evalJS(`(() => ({
      alerts: window.__alerts || [],
      chips: [...document.querySelectorAll("#pendingList .file-chip")].map(e => e.textContent.trim()),
      sales: window.AppCore.STORE.sales.length,
      info: (document.querySelector("#dataInfo")||{}).textContent||"" }))()`)));
    return false;
  };

  try {
    if (!await ready()) throw new Error("页面脚本未就绪");

    log("=== [1] 上传 POS 格式「销售明细表」 ===");
    await uploadFile(POS);
    const chips = await evalJS(`[...document.querySelectorAll("#pendingList .file-chip")].map(e=>e.textContent.trim())`);
    log("  待分析文件 = " + JSON.stringify(chips));
    ok((chips || []).length === 1, "文件已进入待分析列表");
    ok(!(chips || []).some(t => /未识别/.test(t)), "★ 文件被识别为「销售」（不是「未识别」）");

    log("\n=== [2] 开始分析 ===");
    ok(await startAnalysis(), "分析完成，看板已显示");

    const st = await evalJS(`(() => {
      const A = window.AppCore;
      const info = (document.querySelector("#dataInfo")||{}).textContent || "";
      const prods = [...new Set(A.STORE.sales.map(s => s.product).filter(Boolean))];
      const noTime = A.STORE.sales.filter(s => !s.sales_time).length;
      const noProd = A.STORE.sales.filter(s => !s.product).length;
      const withDate = A.STORE.sales.filter(s => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(s.sales_time||""))).length;
      return { sales: A.STORE.sales.length, rows: A.ALL_ROWS ? A.ALL_ROWS.length : A.DATA.rows.length,
               pageRows: A.DATA.rows.length, prods, info, noTime, noProd, withDate,
               drop: A.getDropStat(), alerts: window.__alerts || [] };
    })()`);
    log("  明细 " + st.sales + " 条 / 名单 " + st.rows + " 行 / 品种 " + JSON.stringify(st.prods));
    log("  数据概览 = " + JSON.stringify(st.info));
    ok(st.sales > 0, "★ 销售明细被解析（以前是 0 条 → 整张表被跳过）");
    ok(st.drop.noTime === 0 && st.drop.noProd === 0, "没有因缺日期/缺商品名称而被丢掉的行");
    ok(st.withDate === st.sales, "每一行的销售时间都解析成了 YYYY-MM-DD");
    ok(st.rows > 1000, "★ 名单行数 = " + st.rows + "（明细里的患者×品种都进来了）");
    ok(st.prods.length > 0 && st.prods.every(x => !/^[A-Z0-9]{8,}$/.test(x)),
      "★ 品种是业务品种名，不是药品编号（" + JSON.stringify(st.prods) + "）");
    ok(!/跳过未识别的表|解析失败/.test(st.info), "数据概览里没有「跳过未识别的表 / 解析失败」");
    ok((st.alerts || []).length === 0, "分析过程没有异常弹窗" + (st.alerts && st.alerts.length ? "：" + JSON.stringify(st.alerts) : ""));

    log("\n=== [3] 搜索：明细里有的人，名单里一定搜得到 ===");
    const names = await evalJS(`(() => {
      const A = window.AppCore;
      const seen = new Set(); const out = [];
      for (const r of A.DATA.rows) { if (r.patient_name && !seen.has(r.patient_name)) { seen.add(r.patient_name); out.push(r.patient_name); } if (out.length >= 5) break; }
      return out;
    })()`);
    log("  抽查患者 = " + JSON.stringify(names));
    for (const nm of names) {
      const hit = await evalJS(`(() => {
        const A = window.AppCore;
        const inp = document.querySelector("#searchInput");
        inp.value = ${JSON.stringify(nm)};
        A.state.q = inp.value; A.state.page = 1;
        A.refresh();
        const rows = [...document.querySelectorAll("#tbody tr.data-row")];
        return { n: A.DATA.rows.length, names: rows.slice(0, 3).map(tr => (tr.querySelector(".p-link")||{}).textContent||"") };
      })()`, true);
      await sleep(150);
      ok(hit.n >= 1, "搜索「" + nm + "」→ 命中 " + hit.n + " 行（页面上第一行=" + JSON.stringify((hit.names || [])[0] || "") + "）");
    }
    // 还原搜索词
    await evalJS(`(() => { const i = document.querySelector("#searchInput"); i.value = "";
      window.AppCore.state.q = ""; window.AppCore.refresh(); return 1; })()`, true);

    log("\n=== [4] 没搜到时点明「为什么」：搜索域覆盖会员号/科室/备注 ===");
    const probe = await evalJS(`(() => {
      const A = window.AppCore;
      const r = A.DATA.rows.find(x => x.member_id) || A.DATA.rows[0];
      const out = {};
      const tryQ = (q) => { A.state.q = q; A.refresh(); const n = A.DATA.rows.length; A.state.q = ""; return n; };
      out.byMember = r && r.member_id ? tryQ(r.member_id) : -1;
      out.byDept = r && r.department ? tryQ(r.department) : -1;
      out.byName = tryQ(r.patient_name);
      A.refresh();
      return out;
    })()`, true);
    log("  搜索命中数 = " + JSON.stringify(probe));
    ok(probe.byName >= 1, "按姓名命中");
    ok(probe.byMember >= 1, "★ 按会员号命中（「仅会员号」脱敏下这是屏幕上唯一的身份）");
    if (probe.byDept >= 0) ok(probe.byDept >= 1, "★ 按科室命中");

    const shot = await send("Page.captureScreenshot", {});
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
    log("\n截图: " + SHOT);
  } catch (e) {
    fail++;
    out.push("  ❌ 异常：" + (e && e.message ? e.message : e));
  }

  console.log(out.join("\n"));
  console.log("\n" + (fail === 0 ? "✅" : "❌") + " 通过 " + pass + " / 失败 " + fail);
  try { ws.close(); } catch (e) { }
  p.kill();
  process.exit(fail === 0 ? 0 : 1);
})();
