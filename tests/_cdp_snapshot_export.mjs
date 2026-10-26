// 真实浏览器核实：导出的快照打开后不得残留「选择快照包含的品种」弹窗
// 用户报障：不脱敏快照打开后浮着品种选择窗，取消/确定都点不动（静态 HTML 没有事件绑定）
// 做法：CDP 起真实 Chrome → 注入数据 → 点「下载不脱敏快照」→ 弹窗点确定 → 等下载落盘
//       → 用 file:// 打开下载到的快照 → 检查弹窗节点/加载遮罩/页面可用性 → 截图
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9589;
const ROOT = "C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard";
const PAGE = "file:///" + ROOT + "/index.html";
// 每次跑用一个全新目录（不删旧目录：本机 safe-delete 拦截层对递归删除会直接中断进程）
const DL = path.join(os.tmpdir(), "cdp_snap_dl_" + Date.now());
fs.mkdirSync(DL, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log("  PASS " + n + (extra ? " -> " + extra : "")); }
  else { fail++; console.log("  FAIL " + n + (extra ? " -> " + extra : "")); }
};

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,900",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=C:/Users/yym/AppData/Local/Temp/cdp_snap",
  "--allow-file-access-from-files",
  PAGE], { stdio: "ignore" });

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  setTimeout(() => { console.log("[watchdog] 60s 未完成，退出"); try { p.kill(); } catch (_) { } process.exit(2); }, 60000);
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
    // alert/confirm 会阻塞渲染进程 → Runtime.evaluate 永不返回，必须自动应答
    if (msg.method === "Page.javascriptDialogOpening") {
      console.log("  [dialog] " + String(msg.params.message || "").replace(/\s+/g, " ").slice(0, 90));
      send("Page.handleJavaScriptDialog", { accept: true });
      return;
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Page.enable");
  // 连上之前可能已经弹了 alert（阻塞渲染进程）→ 主动清一次
  const dlg = await send("Page.handleJavaScriptDialog", { accept: true });
  console.log("[step] 预清对话框 ->", JSON.stringify(dlg.error ? dlg.error.message : "ok"));
  const dbr = await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  console.log("[step] setDownloadBehavior ->", JSON.stringify(dbr.error || "ok"));
  await sleep(1500);

  const ev = async (expr) => {
    console.log("[step] evaluate...");
    const r = await Promise.race([
      send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(8000).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) { console.log("  [ev] 8s 无响应（多半被 alert 卡住）"); return "<<timeout>>"; }
    if (r.result && r.result.exceptionDetails) console.log("  页面异常:", JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    const v = r.result && r.result.result && r.result.result.value;
    console.log("[step] evaluate ok, len=" + String(v == null ? "null" : v.length));
    return v;
  };

  console.log("\n[1] 注入数据后点击「下载不脱敏快照」");
  const injected = await ev(`(() => {
    const A = window.AppCore;
    const mk = (name, phone, fam) => ({
      _key: phone, product: fam, patient_name: name, phone, physician: '李大夫',
      hospital: 'H1', pharmacy: 'P1', member_id: 'M' + phone, status: '应回购',
      repur_part: '应回未回', reason: '', days_to_due: 2, due_in_week: true, qty: 1,
      last_purchase: '2026-08-01', cycle_days: 21, due_date: '2026-09-24',
      fu_signal: '', fu_signal_kind: 'unknown',
    });
    A.DATA.rows = [mk('张小三', '13800000001', '百泽安'), mk('张小四', '13800000002', '百泽安')];
    A.renderTable();
    document.getElementById('snapshotPlainBtn').click();
    return 'clicked';
  })()`);
  ok("已触发快照生成", injected === "clicked", injected);
  await sleep(600);

  const hasMask = await ev(`!!document.querySelector('.fam-pick-mask')`);
  ok("生成时品种弹窗确实出现过（这就是被固化的元凶）", hasMask === true);
  await ev(`(() => {
    const ov = document.querySelector('.fam-pick-mask');
    if (!ov) return 'no-overlay';
    ov.querySelectorAll('.fp-item input').forEach(b => { b.checked = true; if (b.onchange) b.onchange(); });
    ov.querySelector('[data-act="ok"]').click();
    return 'ok';
  })()`);

  let file = null;
  for (let i = 0; i < 40; i++) {
    const fs2 = fs.readdirSync(DL).filter(f => f.endsWith(".html") && !f.endsWith(".crdownload"));
    if (fs2.length) { file = path.join(DL, fs2[0]); break; }
    await sleep(300);
  }
  ok("快照已下载到磁盘", !!file, file ? path.basename(file) + " (" + fs.statSync(file).size + " 字节)" : "null");
  if (!file) { ws.close(); p.kill(); process.exit(1); }

  console.log("\n[2] 打开本页：生成快照后本页应仍可继续使用");
  const live = await ev(`(() => {
    const c = s => { const e = document.querySelector(s); return e ? e.className : 'missing'; };
    return JSON.stringify({ dropAll: c('#dropAll'), exportBtn: c('#exportBtn'), snapBanner: c('#snapBanner') });
  })()`);
  const L = JSON.parse(live);
  ok("本页上传区未被隐藏", !/hidden/.test(L.dropAll), L.dropAll);
  ok("本页导出按钮未被隐藏", !/hidden/.test(L.exportBtn), L.exportBtn);
  ok("本页未亮起快照提示条", /hidden/.test(L.snapBanner), L.snapBanner);

  console.log("\n[3] 打开下载到的快照：不得有浮窗，页面可用");
  const url = "file:///" + file.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  console.log("[step] navigate -> " + url);
  await send("Page.navigate", { url });
  await sleep(2500);
  const res = await ev(`(() => {
    const d = document;
    const mask = d.querySelector('.fam-pick-mask');
    const ld = d.getElementById('loading');
    const rows = d.querySelectorAll('#dataTable tbody tr.data-row').length;
    const banner = d.getElementById('snapBanner');
    return JSON.stringify({
      maskNodes: d.querySelectorAll('.fam-pick-mask').length,
      maskVisible: mask ? getComputedStyle(mask).display : 'none-node',
      maskText: mask ? mask.textContent.replace(/\\s+/g, ' ').slice(0, 40) : '',
      loadingClass: ld ? ld.className : 'missing',
      loadingVisible: ld ? getComputedStyle(ld).display : 'none-node',
      rows,
      banner: banner ? banner.textContent.slice(0, 24) : 'missing',
      dataInfo: (d.getElementById('dataInfo') || {}).textContent || '',
      appLoaded: !!window.AppCore,
      desenBarHidden: (() => { const e = d.getElementById('desenBar'); return e ? e.classList.contains('hidden') : 'missing'; })(),
    });
  })()`);
  const R = JSON.parse(res);
  ok("快照能被打开（应用脚本已运行）", R.appLoaded === true);
  ok("快照内没有品种选择弹窗节点", R.maskNodes === 0, String(R.maskNodes));
  ok("快照内加载遮罩为隐藏态", R.loadingClass === "hidden" && R.loadingVisible === "none", R.loadingClass + " / " + R.loadingVisible);
  ok("快照内名单已渲染", R.rows > 0, R.rows + " 行");
  ok("快照提示条已显示", /快照/.test(R.banner || ""), R.banner);
  ok("快照内脱敏开关栏隐藏", R.desenBarHidden === true, String(R.desenBarHidden));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(path.join(ROOT, "tests", "_cdp_snapshot_shot.png"), Buffer.from(shot.result.data, "base64"));
    console.log("  截图已保存 tests/_cdp_snapshot_shot.png");
  }

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL", e); try { p.kill(); } catch (_) { } process.exit(1); });
