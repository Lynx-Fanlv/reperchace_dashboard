// 随访回传「全保真回环」验收：真实浏览器 + 真实文件落盘 + 真实重新上传
//
// 为什么要单独有一个：既有的两条测试都**没走完回环的后半段** ——
//   · tests/_test_callback.js   —— stub DOM，直接写裸键 ST.notes[key]，只验「列结构/口径」
//   · tests/_cdp_callback.mjs   —— 真实 DOM 填写与导出，但**导出后没有再把文件传回去**
//   于是「导出的表能不能被下一轮认出来并真的填回网页」这条最关键的路，一直没人验。
//
// 本脚本做的事（全程真实链路，不直接写 STORE）：
//   第 1 轮：上传销售明细 → 填「跟进备注」+ 点选「未购药原因」 → 点导出，拦下真实文件字节 → 落盘为 .xlsx
//   第 2 轮：**重载页面**（模拟新一天/新一轮，STORE 全清）→ 把 销售明细 + 那份回传表 一起传上去 → 开始分析
//   断言：随访池里有回传记录、顶部提示「已接续回传」、STORE 里备注/原因回来了、
//         并且**界面上看得见**（跟进备注输入框、未购药原因标签、随访类型列）
//
// 用法：node tests/_cdp_callback_roundtrip.mjs [页面URL] [销售明细xlsx]
import fs from "fs";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9591;
const PAGE = process.argv[2] ||
  "file:///C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard/index.html";
const SALES = path.resolve(process.argv[3] || "_fixture_sales_query.xlsx");
const OUT_XLSX = path.resolve("tests/_cb_roundtrip_export.xlsx");
const FU_PATH = path.resolve("_fixture_followup_synth.xlsx");
const SHOT = path.resolve("tests/_cb_roundtrip_shot.png");
const UDD = "C:/Users/yym/AppData/Local/Temp/cdp_cb_rt_" + Date.now();

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

  const out = [];
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; out.push((c ? "  ✅ " : "  ❌ ") + m); };
  const log = (m) => out.push(m);

  const evalJS = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error("页面异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const ready = async () => {
    for (let i = 0; i < 50; i++) {
      if (await evalJS("!!(window.AppCore&&window.Pipeline&&window.Mapping&&window.XLSX&&window.ExcelJS)")) return true;
      await sleep(300);
    }
    return false;
  };
  // 走真实文件输入框（模拟用户把文件拖进来；一次一个，与用户实际操作一致）
  const uploadFile = async (absPath) => {
    const doc = await send("DOM.getDocument");
    const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
    await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [absPath] });
    await evalJS(`document.querySelector("#allInput").dispatchEvent(new Event("change",{bubbles:true})); "ok"`);
    await sleep(600);
  };
  const startAnalysis = async () => {
    await evalJS(`document.querySelector("#startBtn").click(); "clicked"`);
    for (let i = 0; i < 60; i++) {
      if (await evalJS(`!document.querySelector("#board").classList.contains("hidden")`)) return true;
      await sleep(400);
    }
    return false;
  };

  const NOTE = '回环验收：患者说"本周五"去买（含引号）';
  const REASON_KEY = "delay";
  // 必须与 tests/_mk_fixtures.mjs followup 生成的随访表里的患者一致
  const TARGET_NAME = "甘斌元";

  try {
    /* ================= 第 1 轮 ================= */
    if (!await ready()) throw new Error("页面脚本未就绪");
    log("=== [1] 第一轮：上传销售明细 → 填备注/点选原因 → 导出回传表 ===");
    await uploadFile(SALES);
    const pend = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent||""`);
    log("  待分析文件数提示 = " + JSON.stringify(pend));
    ok(await startAnalysis(), "第一轮分析完成，看板已显示");

    // 让所有行都变成「已逾期」→ 跟进备注可填写
    const seeded = await evalJS(`(() => {
      const A = window.AppCore;
      const dates = A.STORE.sales.map(s => s.sales_time).filter(Boolean).sort();
      if (!dates.length) return null;
      const last = dates[dates.length - 1];
      const d = new Date(last + "T00:00:00"); d.setDate(d.getDate() + 120);
      const ref = d.toISOString().slice(0, 10);
      A.state.refDate = ref; A.state.weekSel = "this"; A.state.page = 1;
      A.state.pageSize = 500;   // 让目标患者一定在当前页，便于按 data-idx 精确定位
      return { last, ref, sales: A.STORE.sales.length };
    })()`, false);
    log("  销售明细 " + (seeded && seeded.sales) + " 条，末次购药 " + (seeded && seeded.last) + "，参考日期设为 " + (seeded && seeded.ref) + "（令各行落入「已逾期」）");
    await evalJS(`window.AppCore.refresh()`, true);
    await sleep(500);

    const nRows = await evalJS(`document.querySelectorAll("#tbody tr.data-row").length`);
    log("  名单行数 = " + nRows);
    ok(nRows > 0, "名单有行可操作");
    // ⚠ 目标患者必须与随访表 fixture 里的患者是同一位（否则回传表与真实随访不构成竞争，
    //   「回传表会不会顶掉真实随访」这条就验不到 —— 第一版就是这样假通过的）。
    log("  目标患者 = " + TARGET_NAME + "（与 _mk_fixtures.mjs followup 生成的随访表同一位）");

    // 在目标行上：填备注 + 点选原因（全部真实 DOM 事件）
    const target = await evalJS(`(() => {
      const A = window.AppCore;
      const i = A.DATA.rows.findIndex(r => r.patient_name === ${JSON.stringify(TARGET_NAME)});
      if (i < 0) return { err: "target-not-found", sample: A.DATA.rows.slice(0, 5).map(r => r.patient_name) };
      const r = A.DATA.rows[i];
      return { i, name: r.patient_name, phone: r.phone, product: r.product,
               key: r._key + "::" + r.product, status: r.status, reason: r.reason };
    })()`);
    ok(target && !target.err, "取到目标行" + (target && target.err ? " / " + JSON.stringify(target) : ""));
    log("  目标行 = " + JSON.stringify(target));
    const TR = `#tbody tr.data-row[data-idx="${target.i}"]`;

    const noteOk = await evalJS(`(() => {
      const tr = document.querySelector(${JSON.stringify(TR)});
      const inp = tr && tr.querySelector("input.note-input");
      if (!inp) return "no-input";
      inp.value = ${JSON.stringify(NOTE)};
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return "filled";
    })()`);
    ok(noteOk === "filled", "第 1 轮：备注输入框已填写（" + noteOk + "）");

    const reasonOk = await evalJS(`(() => {
      const tr = document.querySelector(${JSON.stringify(TR)});
      const tag = tr && tr.querySelector("span.reason-tag.clickable");
      if (!tag) return "no-tag";
      window.__td = tag.parentNode;
      tag.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return "clicked";
    })()`);
    ok(reasonOk === "clicked", "第 1 轮：原因标签可点击（" + reasonOk + "）");
    await sleep(200);
    const setReason = await evalJS(`(() => {
      const td = window.__td;
      const sel = td && td.querySelector("select.reason-sel");
      if (!sel) return "no-select";
      const has = [...sel.options].some(o => o.value === ${JSON.stringify(REASON_KEY)});
      sel.value = ${JSON.stringify(REASON_KEY)};
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return has ? "set" : "option-missing:" + [...sel.options].map(o => o.value).join(",");
    })()`);
    ok(setReason === "set", "第 1 轮：点选未购药原因 = " + REASON_KEY + "（" + setReason + "）");
    await sleep(600);

    const preExport = await evalJS(`(() => {
      const A = window.AppCore;
      const k = ${JSON.stringify(target ? target.key : "")};
      return { note: A.STORE.notes[k] || null, reason: A.STORE.reasonOverrides[k] || null, rows: A.callbackRows().length };
    })()`);
    log("  导出前 STORE = " + JSON.stringify(preExport));
    ok(preExport.note === NOTE, "第 1 轮：备注已记到正确的键上");
    ok(preExport.reason === REASON_KEY, "第 1 轮：原因已记到正确的键上");
    ok(preExport.rows >= 1, "第 1 轮：有可回传的行（" + preExport.rows + "）");

    // 拦截下载，拿到真实文件字节
    const b64 = await evalJS(`(async () => {
      const A = window.AppCore;
      const alerts = [];
      const oa = window.alert; window.alert = m => alerts.push(String(m));
      let cap = null;
      const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
      URL.createObjectURL = (b) => { cap = b; return "blob:rt"; };
      URL.revokeObjectURL = () => {};
      await A.doExportCallback();
      URL.createObjectURL = oc; URL.revokeObjectURL = orv; window.alert = oa;
      if (!cap) return JSON.stringify({ err: "no-file", alerts });
      const ab = await cap.arrayBuffer();
      const u8 = new Uint8Array(ab);
      let s = ""; const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return JSON.stringify({ b64: btoa(s), size: u8.length, alerts });
    })()`, true);
    const capRes = JSON.parse(b64);
    ok(!!capRes.b64, "第 1 轮：导出产出真实文件（" + (capRes.size || 0) + " 字节）" + (capRes.err ? " / " + capRes.err : ""));
    if (capRes.alerts && capRes.alerts.length) log("  导出弹窗: " + JSON.stringify(capRes.alerts).slice(0, 300));
    if (!capRes.b64) throw new Error("导出未产出文件，回环无法继续");
    fs.writeFileSync(OUT_XLSX, Buffer.from(capRes.b64, "base64"));
    log("  回传表已落盘: " + OUT_XLSX + " (" + fs.statSync(OUT_XLSX).size + " 字节)");

    await send("Page.captureScreenshot", {}).then(r =>
      fs.writeFileSync(SHOT.replace(".png", "_round1.png"), Buffer.from(r.result.data, "base64")));

    /* ================= 第 2 轮：重载页面 ================= */
    log("\n=== [2] 第二轮：重载页面（STORE 全清）→ 销售明细 + 回传表 一起上传 ===");
    await send("Page.enable");
    await send("Page.navigate", { url: PAGE });
    await sleep(1200);
    if (!await ready()) throw new Error("重载后页面脚本未就绪");
    const cleared = await evalJS(`(() => {
      const A = window.AppCore;
      return { notes: Object.keys(A.STORE.notes).length, sales: A.STORE.sales.length, fus: A.STORE.followups.length };
    })()`);
    log("  重载后 STORE = " + JSON.stringify(cleared) + "（应全为 0，确认是干净的新一轮）");
    ok(cleared.notes === 0 && cleared.sales === 0 && cleared.fus === 0, "重载后 STORE 已清空（真实的新一轮）");

    await uploadFile(SALES);
    await uploadFile(OUT_XLSX);
    const pendingChips = await evalJS(`[...document.querySelectorAll("#pendingList .file-chip")].map(e=>e.textContent.trim())`);
    log("  待分析文件 = " + JSON.stringify(pendingChips));
    ok((pendingChips || []).some(t => t.includes("随访")), "回传表被识别为「随访」类（未落入未知/需移除）");
    ok(!(pendingChips || []).some(t => t.includes("k-unknown")), "没有文件被标为「未识别」");

    const started2 = await startAnalysis();
    ok(started2, "第二轮分析完成，看板已显示");

    const r2 = await evalJS(`(() => {
      const A = window.AppCore;
      const cbFus = A.STORE.followups.filter(f => String(f.summary_type||"").trim() === "跟进回传");
      const k = ${JSON.stringify(target ? target.key : "")};
      const info = (document.querySelector("#dataInfo")||{}).textContent || "";
      return {
        fuTotal: A.STORE.followups.length,
        cbCount: cbFus.length,
        cbSample: cbFus[0] ? { name: cbFus[0].patient_name, phone: cbFus[0].phone, product: cbFus[0].product,
                                note: cbFus[0].callback_note, label: cbFus[0].reason_label,
                                summary: cbFus[0].summary_type, exec: cbFus[0].exec_time } : null,
        info: info,
        note: A.STORE.notes[k] || null,
        reason: A.STORE.reasonOverrides[k] || null,
        rowCount: A.DATA.rows.length,
      };
    })()`);

    log("  第二轮随访池 = " + r2.fuTotal + " 条，其中回传记录 " + r2.cbCount + " 条");
    log("  回传记录样本 = " + JSON.stringify(r2.cbSample));
    log("  顶部提示 = " + JSON.stringify(r2.info).slice(0, 300));
    log("  STORE 备注 = " + JSON.stringify(r2.note) + " / 原因 = " + JSON.stringify(r2.reason));

    ok(r2.cbCount >= 1, "★ 回传记录进入随访池并被识别为「跟进回传」");
    ok(/已接续回传/.test(r2.info), "★ 顶部出现「已接续回传」提示");
    ok(r2.note === NOTE, "★ 备注已回填到 STORE（键 = " + JSON.stringify((target ? target.key : "").slice(0, 16)) + "…）");
    ok(r2.reason === REASON_KEY, "★ 未购药原因已等同人工点选回填");

    // 界面上看得见吗（用户视角）
    await evalJS(`(() => { const A = window.AppCore; A.state.refDate = ${JSON.stringify(seeded && seeded.ref || "")}; A.state.page = 1; A.state.pageSize = 500; return A.refresh(); })()`, true);
    await sleep(700);
    const dom = await evalJS(`(() => {
      const A = window.AppCore;
      const i = A.DATA.rows.findIndex(r => r._key + "::" + r.product === ${JSON.stringify(target ? target.key : "")});
      if (i < 0) return { err: "row-not-found-after-round2", rows: A.DATA.rows.length };
      const tr = document.querySelector('#tbody tr.data-row[data-idx="' + i + '"]');
      if (!tr) return { err: "tr-not-found", i };
      const cols = A.LIST_COLS.filter(([k]) => !(A.state.maskMode === "id" && k === "phone") && !A.state.hiddenCols.has(k)).map(([k]) => k);
      const cell = (key) => { const j = cols.indexOf(key); return j < 0 ? null : (tr.children[j] ? tr.children[j].innerText.trim() : null); };
      const inp = tr.querySelector("input.note-input");
      const tag = tr.querySelector("span.reason-tag");
      return { i, cols, noteBox: inp ? inp.value : null, tagText: tag ? tag.textContent.trim() : null,
               fuType: cell("fu_type"), fuTime: cell("fu_time"), fuSignal: cell("fu_signal"), reasonCell: cell("reason") };
    })()`);
    log("  界面取值 = " + JSON.stringify(dom));
    ok(dom && dom.noteBox === NOTE, "★ 界面上「跟进备注」框里看得见回填内容");
    ok(dom && !!dom.tagText && dom.tagText.includes("推迟购药"), "★ 界面上「未购药原因」标签显示为「" + (dom && dom.tagText) + "」");
    ok(dom && dom.fuType === "跟进回传", "界面上「随访类型」列 = " + (dom && dom.fuType));

    // 「随访信号」列：回传表不带信号字段，记下实际值供判断（不硬断言）
    log("  （观察项）「随访信号」列 = " + JSON.stringify(dom && dom.fuSignal) + "，「随访时间」列 = " + JSON.stringify(dom && dom.fuTime));

    await send("Page.captureScreenshot", {}).then(r =>
      fs.writeFileSync(SHOT.replace(".png", "_round2.png"), Buffer.from(r.result.data, "base64")));

    /* ===== 第 3 轮：回传表会不会把「真实随访」顶掉（复核项）===== */
    log("\n=== [3] 第三轮：销售 + 真实随访表 + 回传表 一起上传 ===");
    log("    目的：回传表不是真实随访任务，只是承载备注/原因的载体。");
    log("    若它参与「匹配随访」竞争并胜出，界面会变成 随访类型=跟进回传、随访信号=空 —— 真实随访状态被冲掉。");
    const FU_FIXTURE = FU_PATH;
    if (!fs.existsSync(FU_FIXTURE)) {
      log("  （跳过）随访表 fixture 不存在: " + FU_FIXTURE + "，先跑 `node tests/_mk_fixtures.mjs followup`");
    } else {
      await send("Page.navigate", { url: PAGE });
      await sleep(1200);
      if (!await ready()) throw new Error("第三轮重载后页面脚本未就绪");
      await uploadFile(SALES);
      await uploadFile(FU_FIXTURE);
      await uploadFile(OUT_XLSX);
      const chips3 = await evalJS(`[...document.querySelectorAll("#pendingList .file-chip")].map(e=>e.textContent.trim())`);
      log("  待分析文件 = " + JSON.stringify(chips3));
      ok(await startAnalysis(), "第三轮分析完成，看板已显示");

      // 让周期足够长，使「随访日期」落在应购药日之前 —— 匹配规则会取「应购药日前最近一次」，
      // 回传表的日期（导出日）比真实随访晚，于是它会以「最近一次」的身份胜出。
      const r3 = await evalJS(`(() => {
        const A = window.AppCore;
        for (const k in A.state.stdCycle) A.state.stdCycle[k] = 400;
        A.state.refDate = ${JSON.stringify(seeded && seeded.ref || "")};
        A.state.page = 1;
        return A.refresh().then(() => {
          const cbFus = A.STORE.followups.filter(f => String(f.summary_type||"").trim() === "跟进回传").length;
          const realFus = A.STORE.followups.length - cbFus;
          const r = A.DATA.rows.find(x => x.patient_name === ${JSON.stringify(TARGET_NAME)});
          const k = ${JSON.stringify(target ? target.key : "")};
          return { fuTotal: A.STORE.followups.length, cbFus, realFus,
                   name: r && r.patient_name, fuType: r && r.fu_type, fuSignal: r && r.fu_signal,
                   sigKind: r && r.fu_signal_kind,
                   fuTime: r && r.fu_time, matchedSummary: r && r._matched && r._matched.summary_type,
                   cycle: r && r.cycle_days, due: r && r.due_date,
                   stdCycle: JSON.stringify(A.state.stdCycle),
                   note: A.STORE.notes[k] || null, reason: A.STORE.reasonOverrides[k] || null };
        });
      })()`, true);
      log("  随访池 = " + r3.fuTotal + " 条（回传 " + r3.cbFus + " / 真实 " + r3.realFus + "）");
      log("  甘斌元行 = " + JSON.stringify({ fuType: r3.fuType, fuSignal: r3.fuSignal, sigKind: r3.sigKind, fuTime: r3.fuTime, matched: r3.matchedSummary, cycle: r3.cycle, due: r3.due }));
      log("  周期设置 = " + r3.stdCycle);
      log("  STORE 备注 = " + JSON.stringify(r3.note) + " / 原因 = " + JSON.stringify(r3.reason));

      ok(r3.matchedSummary !== "跟进回传", "★ 匹配到的随访是真实随访（不是回传表）—— 实际 = " + JSON.stringify(r3.matchedSummary));
      ok(r3.sigKind === "dropout", "★ 「随访信号」保留了真实的脱落判定（kind=dropout）—— 实际 = " + JSON.stringify(r3.sigKind) + " / " + JSON.stringify(r3.fuSignal));
      ok(r3.fuType === "常规随访", "★ 「随访类型」仍是真实随访类型 —— 实际 = " + JSON.stringify(r3.fuType));
      ok(r3.note === NOTE && r3.reason === REASON_KEY, "★ 备注/原因仍然接续（回传表被排除在匹配之外，不影响回流）");
    }

  } catch (err) {
    fail++;
    out.push("  ❌ 探针异常中断: " + (err && err.message ? err.message : String(err)));
  }

  log("\n通过 " + pass + " / " + (pass + fail));
  console.log(out.join("\n"));
  ws.close(); p.kill();
  process.exit(fail ? 1 : 0);
})();
