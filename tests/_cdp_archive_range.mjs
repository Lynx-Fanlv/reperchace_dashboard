// CDP 端到端验证：留档「品种名 + 销售时间起止」显示名 与「按时间段勾选加载」
//
// 用真实 Chrome + 真实 OPFS + 真实 xlsx 解析，验证两条需求：
//   需求1：留档在管理器/弹窗里显示成「品种名 · 起止」（如 百悦泽 · 26.7.1-26.9.16）
//   需求3：弹窗勾选品种后，可展开「选择时间段」，只加载部分月份
//
// 数据前提（脚本自检）：传入的 xlsx 必须有 ≥2 个不同销售月份，否则「按时间段」无从验证。
//
// 用法：node tests/_cdp_archive_range.mjs <含多月销售数据的.xlsx>
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9471;
const ROOT = "C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard";
const URL_ = "file:///" + ROOT + "/index.html";
const PROFILE = "C:/Users/yym/AppData/Local/Temp/cdp_archive_range";

const xlsxPath = process.argv[2];
if (!xlsxPath) { console.log("用法: node tests/_cdp_archive_range.mjs <xlsx>"); process.exit(1); }
const absXlsx = xlsxPath.replace(/\\/g, "/");

fs.rmSync(PROFILE, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✅ " + m + (extra !== undefined ? "  (" + extra + ")" : "")); } else { fail++; console.log("  ❌ " + m + (extra !== undefined ? "  (" + extra + ")" : "")); } };

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + PROFILE,
  "--allow-file-access-from-files",
  URL_,
], { stdio: "ignore" });

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, send, evalJS, events, id = 0;

async function connect(retries = 40) {
  let wsUrl = null;
  for (let i = 0; i < retries; i++) {
    try {
      const j = JSON.parse(await get("http://127.0.0.1:" + PORT + "/json"));
      const pg = j.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch (e) { }
    await sleep(400);
  }
  if (!wsUrl) throw new Error("未能连接 CDP");
  ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  const pending = new Map();
  events = [];
  send = (method, params) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable"); await send("DOM.enable"); await send("Page.enable");
  evalJS = async (expr, awaitPromise = true) => {
    const r = await send("Runtime.evaluate", {
      expression: expr, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    if (r.result && r.result.result && r.result.result.value !== undefined) return r.result.result.value;
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return undefined;
  };
  const reload = async () => { await send("Page.reload", { ignoreCache: false }); await sleep(2200); };
  return { reload };
}

// 等页面脚本就绪
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const r = await evalJS(`!!(window.AppCore && window.Pipeline && window.Mapping)`).catch(() => false);
    if (r) return true;
    await sleep(400);
  }
  return false;
}

// 用 CDP 原生 setFileInputFiles 塞文件（file:// 下 fetch 读不了本地文件）
async function upload(paths) {
  const doc = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
  if (!q.result.nodeId) throw new Error("找不到 #allInput");
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: paths });
  await evalJS(`(function(){ const el=document.querySelector("#allInput"); el.dispatchEvent(new Event("change",{bubbles:true})); return el.files.length; })()`, false);
  let n = 0;
  for (let i = 0; i < 90; i++) {
    const t = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent || ""`).catch(() => "");
    const m = /共 (\d+) 个文件/.exec(t);
    n = m ? +m[1] : 0;
    if (n >= paths.length) break;
    await sleep(500);
  }
  return n;
}

const clickStart = () => evalJS(`(function(){ document.querySelector("#startBtn").click(); return 1; })()`, false);
const isMaskOpen = (sel) => evalJS(`!document.querySelector("${sel}").classList.contains("hidden")`);

// 等留档真正落盘（createWritable 完成）—— 否则紧接着 reload 会掐断写入
async function waitArchive(minCount = 1) {
  for (let i = 0; i < 60; i++) {
    const m = await evalJS(`(async () => {
      const a = await Pipeline.listArchiveProducts();
      return a.reduce((s, x) => s + x.count, 0);
    })()`).catch(() => 0);
    if (m >= minCount) return m;
    await sleep(400);
  }
  return -1;
}

(async () => {
  let reload;
  try {
    ({ reload } = await connect());
  } catch (e) { console.log("连接失败:", e.message); process.exit(1); }
  const ready = await waitReady();
  ok(ready, "页面脚本就绪（AppCore/Pipeline/Mapping）");

  console.log("\n===== 第 1 轮：首次上传（本地无历史）→ 应写留档、不弹窗 =====");
  {
    const n = await upload([absXlsx]);
    ok(n === 1, "文件已加入待上传清单", n);
    await clickStart();
    // 等留档落盘（同时说明分析已完成）
    const cnt = await waitArchive(1);
    const maskOpen = await isMaskOpen("#arcMask");
    ok(maskOpen === false, "★ 本地无历史 → 不弹窗");
    const info = await evalJS(`document.querySelector("#dataInfo").textContent`);
    ok(/销售明细 \d+ 条/.test(info || ""), "分析完成，dataInfo 有内容", JSON.stringify(info));
    const arc = await evalJS(`(async () => {
      const m = await Pipeline.listArchiveProducts();
      return m.map(x => ({ p: x.product, c: x.count, rl: x.rangeLabel, dn: x.displayName }));
    })()`);
    ok(Array.isArray(arc) && arc.length > 0, "★ 留档已写入", JSON.stringify(arc));
    ok(cnt > 0, "★ 留档记录数 > 0", cnt);
    if (arc && arc.length) {
      const a = arc[0];
      ok(!!a.rl, "★ 留档带 rangeLabel（销售时间起止）", a.rl);
      ok(!!a.dn && a.dn.includes("·"), "★ displayName 形如「品种名 · 起止」", a.dn);
      // 数月才谈得上「按时间段」
      const segs = await evalJS(`(async () => {
        const o = await Pipeline.loadArchiveSales(${JSON.stringify(a.p)});
        return Pipeline.groupRecordsByMonth(o.records).map(s => ({ m: s.month, l: s.label, c: s.count }));
      })()`);
      console.log("   分段:", JSON.stringify(segs));
      ok(segs.length >= 2, "★ 该数据有 ≥2 个月份段（可验证按时间段勾选）", segs.length + " 段");
    }
  }

  console.log("\n===== 第 2 轮：重载后再上传 → 应弹窗，且能展开时间段并按段勾选 =====");
  {
    await reload();
    await waitReady();
    const n = await upload([absXlsx]);
    ok(n === 1, "重载后文件已加入待上传清单", n);
    await clickStart();
    // 等弹窗出现
    let open = false;
    for (let i = 0; i < 40; i++) {
      open = await isMaskOpen("#arcMask").catch(() => false);
      if (open) break;
      await sleep(400);
    }
    ok(open === true, "★ 本次品种本地有历史 → 弹窗");

    // 品种行里应显示「品种名 · 起止」——分隔点来自 CSS ::before，
    // 故不能只看 textContent（伪元素不在其中），要一起看 ::before 的 content。
    const rowText = await evalJS(`Array.from(document.querySelectorAll('#arcListNow .arc-name')).map(e => e.textContent)`);
    ok(Array.isArray(rowText) && rowText.some(t => /\d{2}\.\d+\.\d+/.test(t)),
      "★ 弹窗品种行含「品种名 + 起止日期」", JSON.stringify(rowText));
    const rangeTag = await evalJS(`Array.from(document.querySelectorAll('#arcListNow .arc-range')).map(e => e.textContent.trim())`);
    ok(Array.isArray(rangeTag) && rangeTag.length >= 1 && /^\d{2}\.\d+\.\d+-/.test(rangeTag[0]),
      "★ 存在 .arc-range 时间段标签（形如「26.7.1-26.9.16」）", JSON.stringify(rangeTag));
    // ★ 关键视觉断言：把品种名与 ::before 的「· 」拼起来，必须得到「百悦泽 · 26.7.1-...」的形态
    const composed = await evalJS(`(() => {
      const el = document.querySelector('#arcListNow .arc-name');
      if (!el) return null;
      const sep = getComputedStyle(el.querySelector('.arc-range'), '::before').content.replace(/^"|"$/g, '');
      const prod = el.childNodes[0].textContent;
      const rng = el.querySelector('.arc-range').textContent;
      return prod + sep + rng;
    })()`);
    ok(typeof composed === "string" && /^百悦泽\s·\s?26\.7\.1/.test(composed),
      "★ ★ 视觉上拼出「品种名 · 起止」（分隔点由 CSS 提供，不贴字）", JSON.stringify(composed));

    // 有「选择时间段」按钮
    const segBtns = await evalJS(`document.querySelectorAll('button.arc-seg-open').length`);
    ok(segBtns >= 1, "★ 每个品种行有「选择时间段」按钮", segBtns);

    // 点开第一个
    const opened = await evalJS(`(async () => {
      document.querySelector('button.arc-seg-open').click();
      await new Promise(r => setTimeout(r, 900));
      const box = document.querySelector('.arc-seg-box');
      return {
        hidden: box.classList.contains('hidden'),
        n: box.querySelectorAll('input[data-seg]').length,
        checked: box.querySelectorAll('input[data-seg]:checked').length,
        hasAll: !!box.querySelector('button[data-act="all"]'),
        hasNone: !!box.querySelector('button[data-act="none"]'),
        sum: (box.querySelector('.arc-seg-sum') || {}).textContent || '',
      };
    })()`);
    ok(opened.hidden === false, "★ 点开后时间段面板展开");
    ok(opened.n >= 2, "★ 面板里列出 ≥2 个月份段", opened.n);
    ok(opened.checked === opened.n, "★ 默认全选（展开即全勾）", opened.checked + "/" + opened.n);
    ok(opened.hasAll && opened.hasNone, "★ 有「全选 / 全不选」按钮");
    ok(/已选全部/.test(opened.sum), "★ 摘要显示「已选全部 N 条」", opened.sum);

    // 点「全不选」→ 摘要应变 0
    const noneSel = await evalJS(`(async () => {
      const box = document.querySelector('.arc-seg-box');
      box.querySelector('button[data-act="none"]').click();
      await new Promise(r => setTimeout(r, 300));
      return { checked: box.querySelectorAll('input[data-seg]:checked').length,
               sum: (box.querySelector('.arc-seg-sum') || {}).textContent || '' };
    })()`);
    ok(noneSel.checked === 0, "★ 「全不选」→ 勾选数归零", noneSel.checked);
    ok(/已选 0 \//.test(noneSel.sum), "★ 摘要显示「已选 0 / N 条」", noneSel.sum);

    // 只勾第一个（最新的）月份段 → 记录应少于全量
    const partialInfo = await evalJS(`(async () => {
      const box = document.querySelector('.arc-seg-box');
      box.querySelector('button[data-act="none"]').click();
      await new Promise(r => setTimeout(r, 200));
      const first = box.querySelector('input[data-seg]');
      first.click();
      await new Promise(r => setTimeout(r, 200));
      return { month: first.dataset.month, sum: (box.querySelector('.arc-seg-sum') || {}).textContent || '' };
    })()`);
    ok(/已选 \d+ \//.test(partialInfo.sum), "★ 只勾一段后摘要显示「已选 N / M 条」", partialInfo.sum);
    ok(!/已选 0 /.test(partialInfo.sum), "★ 勾了一段后被选数 > 0", partialInfo.sum);

    // 点确定 → 应只并入所勾的那一段
    const loaded = await evalJS(`(async () => {
      document.querySelector('#arcOk').click();
      await new Promise(r => setTimeout(r, 4000));
      return document.querySelector('#dataInfo').textContent;
    })()`);
    console.log("   dataInfo:", JSON.stringify(loaded));
    ok(/已并入历史/.test(loaded || ""), "★ dataInfo 显示「已并入历史」");
    ok(/\/\d+条/.test(loaded || ""), "★ 回显「N/M条」形式（说明是部分并入）", loaded);
  }

  console.log("\n===== 第 3 轮：管理器显示「品种名 · 时间段」+ 整体跨度 =====");
  {
    await reload();
    const mgr = await evalJS(`(async () => {
      document.querySelector('#archiveMgrBtn').click();
      await new Promise(r => setTimeout(r, 1600));
      const mask = document.querySelector('#arcMgrMask');
      return {
        open: !mask.classList.contains('hidden'),
        stat: (document.querySelector('#arcMgrStat') || {}).textContent || '',
        names: Array.from(document.querySelectorAll('#arcMgrList .arc-name')).map(e => e.textContent),
        tags: Array.from(document.querySelectorAll('#arcMgrList .arc-range')).map(e => e.textContent),
      };
    })()`);
    ok(mgr.open === true, "★ 管理器弹窗能打开");
    ok(/共 \d+ 个品种 · \d+ 条销售记录/.test(mgr.stat), "★ 管理器统计行正常", mgr.stat);
    ok(/销售时间/.test(mgr.stat), "★ ★ 统计行含整体「销售时间」跨度（需求1）", mgr.stat);
    ok(mgr.names.some(t => /\d{2}\.\d+\.\d+/.test(t)), "★ ★ 管理器中品种名带起止日期（需求1）", JSON.stringify(mgr.names));
    ok(mgr.tags.length >= 1 && /^\d{2}\.\d+\.\d+-/.test(mgr.tags[0]),
      "★ 时间段标签形如「26.7.1-26.9.16」", JSON.stringify(mgr.tags));
    // 同样把 ::before 的分隔点拼上，核实视觉形态
    const mgrComposed = await evalJS(`(() => {
      const el = document.querySelector('#arcMgrList .arc-name');
      if (!el) return null;
      const sep = getComputedStyle(el.querySelector('.arc-range'), '::before').content.replace(/^"|"$/g, '');
      return el.childNodes[0].textContent + sep + el.querySelector('.arc-range').textContent;
    })()`);
    ok(typeof mgrComposed === "string" && /^百悦泽\s·\s?26\.7\.1/.test(mgrComposed),
      "★ ★ 管理器视觉上也是「品种名 · 起止」", JSON.stringify(mgrComposed));
  }

  console.log("\n===== 第 4 轮：截图留证（弹窗时间段面板 + 管理器）=====");
  {
    await reload();
    await waitReady();
    await upload([absXlsx]);
    await clickStart();
    for (let i = 0; i < 40; i++) {
      if (await isMaskOpen("#arcMask").catch(() => false)) break;
      await sleep(400);
    }
    // 展开时间段面板并只勾最新一段，截「正在挑选」的状态
    await evalJS(`(async () => {
      document.querySelector('button.arc-seg-open').click();
      await new Promise(r => setTimeout(r, 900));
      const box = document.querySelector('.arc-seg-box');
      box.querySelector('button[data-act="none"]').click();
      await new Promise(r => setTimeout(r, 200));
      box.querySelectorAll('input[data-seg]')[0].click();
      await new Promise(r => setTimeout(r, 300));
      return 1;
    })()`);
    let shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(ROOT + "/tests/_arc_range_dialog.png", Buffer.from(shot.result.data, "base64"));
      ok(true, "弹窗截图已保存", "tests/_arc_range_dialog.png");
    } else { ok(false, "弹窗截图失败"); }
    await evalJS(`document.querySelector('#arcSkip').click(); true`);
    await sleep(500);
    // 管理器截图
    await evalJS(`(async () => {
      document.querySelector('#archiveMgrBtn').click();
      await new Promise(r => setTimeout(r, 1600));
      return 1;
    })()`);
    shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(ROOT + "/tests/_arc_range_mgr.png", Buffer.from(shot.result.data, "base64"));
      ok(true, "管理器截图已保存", "tests/_arc_range_mgr.png");
    } else { ok(false, "管理器截图失败"); }
  }

  console.log("\n通过 " + pass + " / " + (pass + fail));
  ws.close();
  chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log("\n脚本异常:", e && e.message);
  try { ws && ws.close(); } catch (_) { }
  try { chrome.kill(); } catch (_) { }
  process.exit(1);
});
