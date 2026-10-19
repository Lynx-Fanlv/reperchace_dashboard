// 诊断探针：把「导出的随访回传表 → 传回网页」这条路的**每一环**打印出来，
// 目的是定位用户报的「传回后备注/原因没回到列表」到底断在哪一环。
//
// 与 _cdp_callback_roundtrip.mjs 的区别：
//   · 那个脚本为了稳定断言，第 1 轮就把参考日期强行推到未来、pageSize=500；
//   · 本探针**不干预第 2 轮的时间/周选择**，完全按真实用户的默认路径走，
//     并把 键 / STORE / 行字段 / DOM 四层取值全部打出来对照。
//
// 用法：node tests/_probe_cb_reflow.mjs [页面URL] [销售明细xlsx]
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9593;
const PAGE = process.argv[2] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SALES = path.resolve(process.argv[3] || "_fixture_sales_query.xlsx");
const OUT_XLSX = path.resolve("tests/_probe_cb_export.xlsx");
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_probe_cb_" + Date.now();

console.log("目标页面:", PAGE);
console.log("销售明细:", SALES);

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,1180",
  "--disable-application-cache", "--disk-cache-size=1",
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
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  const log = (m) => console.log(m);

  const evalJS = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error("页面异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const ready = async () => {
    for (let i = 0; i < 50; i++) {
      if (await evalJS("!!(window.AppCore&&window.Pipeline&&window.Mapping&&window.XLSX&&window.ExcelJS)")) {
        await evalJS(`(() => { if (!window.__alerts) { window.__alerts = [];
          window.alert = m => window.__alerts.push(String(m)); } return 1; })()`);
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
    for (let i = 0; i < 40; i++) {
      const n = await evalJS(`document.querySelectorAll("#pendingList .file-chip").length`);
      if (n > before) break;
      await sleep(250);
    }
  };
  const dismissArchiveIfAny = async () => {
    for (let i = 0; i < 40; i++) {
      const vis = await evalJS(`(() => { const m = document.querySelector("#arcMask");
        return !!m && !m.classList.contains("hidden"); })()`);
      if (vis) {
        const t = await evalJS(`(document.querySelector("#arcTitle")||{}).textContent||""`);
        log("  ⚠ 弹出本地留档询问（" + JSON.stringify(t) + "）→ 点「不用历史」");
        await evalJS(`document.querySelector("#arcSkip").click(); "ok"`);
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  const startAnalysis = async () => {
    await evalJS(`document.querySelector("#startBtn").click(); "clicked"`);
    await sleep(500);
    await dismissArchiveIfAny();
    for (let i = 0; i < 60; i++) {
      if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) return true;
      await dismissArchiveIfAny();
      await sleep(400);
    }
    const diag = await evalJS(`(() => ({
      alerts: window.__alerts || [],
      chips: [...document.querySelectorAll("#pendingList .file-chip")].map(e => e.textContent.trim()),
    }))()`);
    log("  ⚠ 看板未出现，现场诊断 = " + JSON.stringify(diag));
    return false;
  };

  const NOTE = "探针备注：本周五去买";
  const REASON_KEY = "delay";

  try {
    /* ============ 第 1 轮 ============ */
    if (!await ready()) throw new Error("页面脚本未就绪");
    log("\n=== [1] 上传销售明细 → 按**默认**时间/周填写备注与原因 → 导出 ===");
    await uploadFile(SALES);
    log("  第一轮分析 = " + (await startAnalysis() ? "OK" : "失败"));

    // 第 1 轮：不动 refDate，看默认情况下有多少行可填备注
    const r1info = await evalJS(`(() => {
      const A = window.AppCore;
      const cnt = {};
      for (const r of A.DATA.rows) cnt[r.status] = (cnt[r.status]||0)+1;
      return { refDate: A.state.refDate, weekSel: A.state.weekSel,
               stdCycle: JSON.stringify(A.state.stdCycle),
               total: A.DATA.rows.length, byStatus: cnt,
               cols: A.LIST_COLS.map(([k])=>k) };
    })()`);
    log("  参考日期 = " + r1info.refDate + " / 周选择 = " + r1info.weekSel + " / 标准周期 = " + r1info.stdCycle);
    log("  行状态分布 = " + JSON.stringify(r1info.byStatus) + "（共 " + r1info.total + " 行）");
    log("  列 = " + JSON.stringify(r1info.cols));

    // 选 3 位「可填备注」的患者（应回购/已逾期），第 1 位填备注、第 2 位点原因、第 3 位两者都填
    const picks = await evalJS(`(() => {
      const A = window.AppCore;
      const ok = A.DATA.rows.map((r,i)=>({r,i})).filter(x => x.r.status === "应回购" || x.r.status === "已逾期");
      const take = ok.slice(0, 3);
      return take.map(x => ({ i: x.i, name: x.r.patient_name, phone: x.r.phone, product: x.r.product,
                             status: x.r.status, key: x.r._key + "::" + x.r.product }));
    })()`);
    log("  选中患者 = " + JSON.stringify(picks));
    if (picks.length < 1) throw new Error("没有可填写备注的行，无法继续");

    // 用真实 DOM 事件填
    for (let n = 0; n < picks.length; n++) {
      const t = picks[n];
      const TR = `#tbody tr.data-row[data-idx="${t.i}"]`;
      if (n === 0 || n === 2) {
        const res = await evalJS(`(() => {
          const tr = document.querySelector(${JSON.stringify(TR)});
          const inp = tr && tr.querySelector("input.note-input");
          if (!inp) return "no-input";
          inp.value = ${JSON.stringify(NOTE)} + "（${t.name}）";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          return "filled";
        })()`);
        log("  [" + t.name + "] 填备注 = " + res);
        t.note = NOTE + "（" + t.name + "）";
      }
      if (n === 1 || n === 2) {
        await evalJS(`(() => { const tr = document.querySelector(${JSON.stringify(TR)});
          const tag = tr && tr.querySelector("span.reason-tag.clickable"); if (!tag) return 0;
          window.__td = tag.parentNode; tag.dispatchEvent(new MouseEvent("click",{bubbles:true})); return 1; })()`);
        await sleep(200);
        const res = await evalJS(`(() => { const td = window.__td;
          const sel = td && td.querySelector("select.reason-sel"); if (!sel) return "no-select";
          const has = [...sel.options].some(o=>o.value === ${JSON.stringify(REASON_KEY)});
          sel.value = ${JSON.stringify(REASON_KEY)}; sel.dispatchEvent(new Event("change",{bubbles:true}));
          return has ? "set" : "option-missing"; })()`);
        log("  [" + t.name + "] 点原因 = " + res);
        t.reason = REASON_KEY;
      }
      await sleep(400);
    }

    const pre = await evalJS(`(() => {
      const A = window.AppCore;
      return { notes: Object.keys(A.STORE.notes).length, reasons: Object.keys(A.STORE.reasonOverrides).length,
               cbRows: A.callbackRows().length };
    })()`);
    log("  导出前 STORE：备注 " + pre.notes + " 条 / 原因 " + pre.reasons + " 条 / 可回传行 " + pre.cbRows);

    const b64 = await evalJS(`(async () => {
      const A = window.AppCore;
      const alerts = []; const oa = window.alert; window.alert = m => alerts.push(String(m));
      let cap = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
      URL.createObjectURL = (b) => { cap = b; return "blob:rt"; }; URL.revokeObjectURL = () => {};
      await A.doExportCallback();
      URL.createObjectURL = oc; URL.revokeObjectURL = orv; window.alert = oa;
      if (!cap) return JSON.stringify({ err: "no-file", alerts });
      const u8 = new Uint8Array(await cap.arrayBuffer());
      let s = ""; const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return JSON.stringify({ b64: btoa(s), size: u8.length, alerts });
    })()`, true);
    const capRes = JSON.parse(b64);
    if (!capRes.b64) throw new Error("导出未产出文件: " + JSON.stringify(capRes));
    fs.writeFileSync(OUT_XLSX, Buffer.from(capRes.b64, "base64"));
    log("  回传表已落盘 " + OUT_XLSX + " (" + capRes.size + " 字节)");

    /* ============ 第 2 轮：不动任何时间设置 ============ */
    log("\n=== [2] 重载页面 → 销售明细 + 回传表 一起上传（**不干预时间/周**）===");
    await send("Page.enable");
    await send("Page.navigate", { url: PAGE });
    await sleep(1200);
    if (!await ready()) throw new Error("重载后页面脚本未就绪");
    await uploadFile(SALES);
    await uploadFile(OUT_XLSX);
    log("  第二轮分析 = " + (await startAnalysis() ? "OK" : "失败"));

    const r2 = await evalJS(`(() => {
      const A = window.AppCore;
      const info = (document.querySelector("#dataInfo")||{}).textContent || "";
      const cb = A.STORE.followups.filter(f => String(f.summary_type||"").trim() === "跟进回传");
      const keys = Object.keys(A.STORE.notes);
      return { info: info, fuTotal: A.STORE.followups.length, cbCount: cb.length,
               cbSample: cb.slice(0,3).map(f=>({name:f.patient_name, phone:f.phone, product:f.product,
                 note:f.callback_note, label:f.reason_label, exec:f.exec_time, task:f.task_status})),
               noteKeys: keys, noteVals: keys.map(k=>A.STORE.notes[k]),
               reasonKeys: Object.keys(A.STORE.reasonOverrides),
               reasonVals: Object.keys(A.STORE.reasonOverrides).map(k=>A.STORE.reasonOverrides[k]),
               refDate: A.state.refDate, weekSel: A.state.weekSel,
               rowCount: A.DATA.rows.length };
    })()`);
    log("  顶部提示 = " + JSON.stringify(r2.info));
    log("  随访池 = " + r2.fuTotal + " 条，回传记录 = " + r2.cbCount + " 条");
    log("  回传记录样本 = " + JSON.stringify(r2.cbSample, null, 0));
    log("  STORE.notes 键数 = " + r2.noteKeys.length + " → " + JSON.stringify(r2.noteVals));
    log("  STORE.reasonOverrides 键数 = " + r2.reasonKeys.length + " → " + JSON.stringify(r2.reasonVals));
    log("  本轮 refDate = " + r2.refDate + " / weekSel = " + r2.weekSel);
    log("  本轮行数 = " + r2.rowCount);

    // 逐患者对照：目标键 / 期望键 / 行 / DOM
    const cmp = await evalJS(`(() => {
      const A = window.AppCore;
      const expects = ${JSON.stringify(picks.map(t => ({ name: t.name, phone: t.phone, product: t.product, key: t.key, note: t.note || "", reason: t.reason || "" })))};
      return expects.map(e => {
        const r = A.DATA.rows.find(x => x.patient_name === e.name && x.product === e.product);
        let dom = null;
        if (r) {
          const i = A.DATA.rows.indexOf(r);
          const tr = document.querySelector('#tbody tr.data-row[data-idx="' + i + '"]');
          if (tr) {
            const inp = tr.querySelector("input.note-input");
            const tag = tr.querySelector("span.reason-tag");
            dom = { noteBox: inp ? inp.value : null, hasNoteCell: !!inp,
                    tagText: tag ? tag.textContent.trim() : null };
          }
        }
        return {
          name: e.name, wantKey: e.key,
          inStoreNote: !!A.STORE.notes[e.key], storeNote: A.STORE.notes[e.key] || null,
          inStoreReason: Object.prototype.hasOwnProperty.call(A.STORE.reasonOverrides, e.key),
          storeReason: A.STORE.reasonOverrides[e.key] === undefined ? null : A.STORE.reasonOverrides[e.key],
          rowFound: !!r, status: r && r.status, repurPart: r && r.repur_part,
          rowReason: r && r.reason, canNote: r ? (r.status === "应回购" || r.status === "已逾期") : null,
          dom: dom,
        };
      });
    })()`);
    log("\n  ---- 逐患者对照 ----");
    for (const c of cmp) log("  " + JSON.stringify(c));

    // 另外：本轮 STORE 里所有备注键 vs 实际行键，找出对不上的键
    const orphans = await evalJS(`(() => {
      const A = window.AppCore;
      const rowKeys = new Set(A.DATA.rows.map(r => (r._key||"") + "::" + r.product));
      const nk = Object.keys(A.STORE.notes);
      const rk = Object.keys(A.STORE.reasonOverrides);
      return { noteOrphans: nk.filter(k => !rowKeys.has(k)).length,
               reasonOrphans: rk.filter(k => !rowKeys.has(k)).length,
               totalRowKeys: rowKeys.size,
               sampleRowKey: A.DATA.rows[0] ? (A.DATA.rows[0]._key||"") + "::" + A.DATA.rows[0].product : null,
               sampleNoteKey: nk[0] || null };
    })()`);
    log("\n  ---- 键对照 ----");
    log("  行键总数 " + orphans.totalRowKeys + "；备注键中绑不到行的 " + orphans.noteOrphans +
        " 条；原因键中绑不到行的 " + orphans.reasonOrphans + " 条");
    log("  样例行键 = " + JSON.stringify(orphans.sampleRowKey));
    log("  样例备注键 = " + JSON.stringify(orphans.sampleNoteKey));

    /* ===== [3] 若本轮这些患者不再是「应回购/已逾期」，备注还看得见吗？ ===== */
    log("\n=== [3] 把周选择推到很远的未来（患者变「未到期」）后，再看待填内容是否还看得见 ===");
    const r3 = await evalJS(`(async () => {
      const A = window.AppCore;
      A.state.weekSel = "this";
      A.state.refDate = (() => { const d = new Date(); d.setDate(d.getDate() - 200);
        return d.toISOString().slice(0,10); })();
      A.state.page = 1; A.state.pageSize = 500;
      await A.refresh();
      const expects = ${JSON.stringify(picks.map(t => ({ name: t.name, key: t.key, note: t.note || "", reason: t.reason || "" })))};
      return expects.map(e => {
        const r = A.DATA.rows.find(x => x.patient_name === e.name);
        if (!r) return { name: e.name, rowFound: false };
        const i = A.DATA.rows.indexOf(r);
        const tr = document.querySelector('#tbody tr.data-row[data-idx="' + i + '"]');
        const inp = tr && tr.querySelector("input.note-input");
        const tag = tr && tr.querySelector("span.reason-tag");
        return { name: e.name, rowFound: true, status: r.status, repurPart: r.repur_part,
                 storeNote: A.STORE.notes[e.key] || null,
                 canNote: (r.status === "应回购" || r.status === "已逾期"),
                 hasNoteCell: !!inp, noteShown: inp ? inp.value : null,
                 tagText: tag ? tag.textContent.trim() : null, rowReason: r.reason };
      });
    })()`, true);
    log("  ---- 状态变化后的可见性 ----");
    for (const c of r3) log("  " + JSON.stringify(c));

    await send("Page.captureScreenshot", {}).then(r =>
      fs.writeFileSync(path.resolve("tests/_probe_cb_shot.png"), Buffer.from(r.result.data, "base64")));

  } catch (err) {
    log("  ❌ 探针异常: " + (err && err.message ? err.message : String(err)));
  }

  ws.close(); p.kill();
  process.exit(0);
})();
