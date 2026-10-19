// 真实浏览器回归：回传表「传回网页」后，患者的 **随访类型/时间/信号/未购药原因** 有没有丢？
//
// 场景设计（对齐真实用法）：
//   第 1 轮：销售明细 + **真实随访表**（甘斌元：已停药·经济困难 → 自动原因应为「脱落·经济」）
//           → 看板自动判定出 随访信号/随访类型/未购药原因 → 填跟进备注 → 导出回传表
//   第 2A 轮：重载 → 销售 + 真实随访表 + 回传表（App 提示的用法：三张表一起传）
//   第 2B 轮：重载 → 销售 + 回传表（**只传回传表**，不上传原始随访表）
//
// 断言：2A / 2B 的「随访信号类别 / 未购药原因 / 患者状态」必须与第 1 轮一致
//       （回传表不复制模板状态列，靠「未购药原因」归一化反推）。
//       随访类型/时间在 2B 会显示「跟进回传 / 导出当天」—— 那是正确结果，不是退化。
//
// 用法：node tests/_cdp_cb_state_carry.mjs [页面URL]
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9594;
const PAGE = process.argv[2] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SALES = path.resolve("_fixture_sales_query.xlsx");
const FU = path.resolve("_fixture_followup_synth.xlsx");
const OUT_XLSX = path.resolve("tests/_cb_statecarry_export.xlsx");
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_cb_sc_" + Date.now();

const p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1440,1180", "--disable-application-cache", "--disk-cache-size=1",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + UDD, PAGE], { stdio: "ignore" });

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAME = "甘斌元";
const NOTE = "回传验收：已电话联系，患者说下周来";

let pass = 0, fail = 0;
const out = [];
const ok = (cond, msg) => { cond ? pass++ : fail++; out.push((cond ? "  ✅ " : "  ❌ ") + msg); };

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
    for (let i = 0; i < 40; i++) {
      if (await evalJS(`document.querySelectorAll("#pendingList .file-chip").length`) > before) break;
      await sleep(250);
    }
  };
  const dismissArch = async () => {
    for (let i = 0; i < 40; i++) {
      if (await evalJS(`(() => { const m = document.querySelector("#arcMask"); return !!m && !m.classList.contains("hidden"); })()`)) {
        const t = await evalJS(`(document.querySelector("#arcTitle")||{}).textContent||""`);
        log("  ⚠ 本地留档询问：" + JSON.stringify(t) + " → 点「不用历史」");
        await evalJS(`document.querySelector("#arcSkip").click(); "ok"`);
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  const startAnalysis = async () => {
    await evalJS(`document.querySelector("#startBtn").click(); "c"`);
    await sleep(500); await dismissArch();
    for (let i = 0; i < 60; i++) {
      if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) return true;
      await dismissArch(); await sleep(400);
    }
    log("  ⚠ 看板未出现: " + JSON.stringify(await evalJS(`({alerts:window.__alerts||[]})`)));
    return false;
  };
  // 统一快照：抓某位患者在本轮的关键字段
  const snap = async (label) => {
    const r = await evalJS(`(async () => {
      const A = window.AppCore;
      A.state.refDate = A.state.refDate || "";
      await A.refresh();
      const i = A.DATA.rows.findIndex(x => x.patient_name === ${JSON.stringify(NAME)});
      if (i < 0) return { label: ${JSON.stringify(label)}, err: "row-not-found" };
      const row = A.DATA.rows[i];
      const tr = document.querySelector('#tbody tr.data-row[data-idx="' + i + '"]');
      const inp = tr && tr.querySelector("input.note-input");
      const tag = tr && tr.querySelector("span.reason-tag");
      const k = (row._key||"") + "::" + row.product;
      return { label: ${JSON.stringify(label)},
        key: k, status: row.status, repurPart: row.repur_part,
        fuType: row.fu_type || null, fuSignal: row.fu_signal || null, sigKind: row.fu_signal_kind || null,
        fuTime: row.fu_time || null,
        matchedSummary: row._matched ? row._matched.summary_type : null,
        matchedNote: row._matched ? (row._matched.follow_note||"").slice(0,40) : null,
        reason: row.reason || null, reasonText: tag ? tag.textContent.trim() : null,
        storeNote: A.STORE.notes[k] || null, noteShown: inp ? inp.value : "(无输入框)",
        info: (document.querySelector("#dataInfo")||{}).textContent||"" };
    })()`, true);
    log("  " + JSON.stringify(r));
    return r;
  };

  try {
    /* ---------- 第 1 轮 ---------- */
    if (!await ready()) throw new Error("页面脚本未就绪");
    log("=== [1] 销售 + 真实随访表（甘斌元：已停药·经济困难）===");
    await uploadFile(SALES); await uploadFile(FU);
    log("  分析 = " + (await startAnalysis() ? "OK" : "失败"));
    // 让甘斌元落入「应回购/已逾期」：参考日期推到全部逾期（与既有一致）
    await evalJS(`(() => { const A = window.AppCore;
      const ds = A.STORE.sales.map(s=>s.sales_time).filter(Boolean).sort();
      const d = new Date(ds[ds.length-1]+"T00:00:00"); d.setDate(d.getDate()+120);
      A.state.refDate = d.toISOString().slice(0,10); A.state.weekSel="this"; A.state.page=1; A.state.pageSize=500;
      return 1; })()`);
    const R1 = await snap("第1轮");
    if (R1.err) throw new Error("第 1 轮找不到患者 " + NAME);

    // 填备注
    await evalJS(`(() => { const A = window.AppCore;
      const i = A.DATA.rows.findIndex(x=>x.patient_name===${JSON.stringify(NAME)});
      const tr = document.querySelector('#tbody tr.data-row[data-idx="'+i+'"]');
      const inp = tr && tr.querySelector("input.note-input"); if (!inp) return "no-input";
      inp.value = ${JSON.stringify(NOTE)}; inp.dispatchEvent(new Event("input",{bubbles:true})); return "filled"; })()`);
    await sleep(300);

    const b64 = await evalJS(`(async () => {
      const A = window.AppCore; const alerts=[]; const oa=window.alert; window.alert=m=>alerts.push(String(m));
      let cap=null; const oc=URL.createObjectURL, orv=URL.revokeObjectURL;
      URL.createObjectURL=b=>{cap=b;return "blob:x";}; URL.revokeObjectURL=()=>{};
      await A.doExportCallback();
      URL.createObjectURL=oc; URL.revokeObjectURL=orv; window.alert=oa;
      if(!cap) return JSON.stringify({err:"no-file",alerts});
      const u8=new Uint8Array(await cap.arrayBuffer()); let s=""; const CH=0x8000;
      for(let i=0;i<u8.length;i+=CH) s+=String.fromCharCode.apply(null,u8.subarray(i,i+CH));
      return JSON.stringify({b64:btoa(s),size:u8.length}); })()`, true);
    const capRes = JSON.parse(b64);
    if (!capRes.b64) throw new Error("导出失败: " + JSON.stringify(capRes));
    fs.writeFileSync(OUT_XLSX, Buffer.from(capRes.b64, "base64"));
    log("  回传表落盘 (" + capRes.size + " 字节)");

    /* ---------- 第 2A 轮：销售 + 随访 + 回传 ---------- */
    log("\n=== [2A] 销售 + **真实随访表** + 回传表（App 提示的用法）===");
    await send("Page.enable"); await send("Page.navigate", { url: PAGE }); await sleep(1200);
    if (!await ready()) throw new Error("重载失败");
    await uploadFile(SALES); await uploadFile(FU); await uploadFile(OUT_XLSX);
    log("  分析 = " + (await startAnalysis() ? "OK" : "失败"));
    await evalJS(`(() => { const A=window.AppCore; A.state.refDate=${JSON.stringify(R1.refDate || "")};
      A.state.page=1; A.state.pageSize=500; return 1; })()`);
    const R2A = await snap("第2A轮");

    /* ---------- 第 2B 轮：销售 + 回传（不带原始随访表）---------- */
    log("\n=== [2B] 销售 + 回传表（**不上传原始随访表**）===");
    await send("Page.navigate", { url: PAGE }); await sleep(1200);
    if (!await ready()) throw new Error("重载失败");
    await uploadFile(SALES); await uploadFile(OUT_XLSX);
    log("  分析 = " + (await startAnalysis() ? "OK" : "失败"));
    await evalJS(`(() => { const A=window.AppCore; A.state.refDate=${JSON.stringify(R1.refDate || "")};
      A.state.page=1; A.state.pageSize=500; return 1; })()`);
    const R2B = await snap("第2B轮");

    /* ---------- 差异汇总 + 断言 ---------- */
    log("\n=== 差异汇总（甘斌元）===");
    const keys = ["status","repurPart","fuType","fuSignal","sigKind","fuTime","matchedSummary","reason","reasonText","storeNote","noteShown"];
    const w = (v) => v === undefined ? "-" : JSON.stringify(v);
    log("  字段".padEnd(18) + "第1轮".padEnd(26) + "第2A轮".padEnd(26) + "第2B轮");
    for (const k of keys) {
      const a = w(R1[k]), b = w(R2A[k]), c = w(R2B[k]);
      const diff = (a !== b || a !== c) ? "  ← 变化" : "";
      log("  " + k.padEnd(16) + a.padEnd(26) + b.padEnd(26) + c + diff);
    }

    // 关键断言：状态类字段（信号类别 / 原因 / 患者状态）三轮必须一致 —— 回传表不再复制随访模板的
    // 状态列，它把当天的结论写在「未购药原因」里，由归一化层反推出同一个信号类别与原因。
    // ⚠ 随访类型 / 时间不再要求等于第 1 轮：用户 2026-10-19 定「导出回传表＝记录导出当天的一次随访」，
    //   2B 只有它这一条记录，页面显示「跟进回传 / 导出当天」才是正确结果（不是退化）。
    // ⚠ 「随访信号」这一列的**文字**在 2B 会变（不再来自「用药状态」列，而来自这条记录自己的
    //   小结/原因，如「患者自述经济压力大，已停药」），但只要类别相同就是同一判定，故只断言非空。
    const VISIBLE = [["sigKind","随访信号类别"],["reason","未购药原因"],
                     ["reasonText","未购药原因(显示)"],["status","患者状态"]];
    log("\n=== 断言：状态与原因不得因「传回回传表」而退化 ===");
    for (const [k, label] of VISIBLE) {
      ok(R2A[k] === R1[k], "2A（销售+随访+回传）" + label + " = 第1轮 → " + w(R2A[k]));
      ok(R2B[k] === R1[k], "2B（销售+回传，不传随访表）" + label + " = 第1轮 → " + w(R2B[k]));
    }
    ok(R2A.fuSignal === R1.fuSignal, "2A（销售+随访+回传）随访信号文字 = 第1轮 → " + w(R2A.fuSignal));
    ok(!!R2B.fuSignal, "2B 随访信号文字非空（取自回传记录自身的小结/原因）→ " + w(R2B.fuSignal));
    ok(R2A.storeNote === NOTE && R2B.storeNote === NOTE, "备注在 2A/2B 都已接续回来");
    ok(R2A.noteShown === NOTE && R2B.noteShown === NOTE, "备注在界面上看得见（2A/2B）");
    ok(R2B.fuType === "跟进回传", "2B 随访类型＝这条回传记录自己（它就是导出当天那条随访）→ " + w(R2B.fuType));
    ok(/^\d{4}-\d{2}-\d{2}$/.test(String(R2B.fuTime)), "2B 随访时间＝导出当天 → " + w(R2B.fuTime));
    ok(R2A.fuType === R1.fuType || R2A.fuType === "跟进回传",
      "2A 用真实随访或更近的回传记录（同一套日期规则）→ " + w(R2A.fuType));

  } catch (err) {
    fail++;
    out.push("  ❌ 测试异常中断: " + (err && err.message ? err.message : String(err)));
  }
  console.log(out.join("\n"));
  log("\n通过 " + pass + " / " + (pass + fail));
  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})();
