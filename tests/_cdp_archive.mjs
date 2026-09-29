// CDP 端到端验证：本地留档（OPFS）在真实浏览器中的读写往返 + 二次上传弹窗
//
// 用法：node tests/_cdp_archive.mjs <销售A.xlsx> <销售B.xlsx>
//        要求 A 与 B 的品种**不相交**（如 A=百泽安、B=百悦泽），才能分别验证
//        「本次品种有历史 → 弹窗」与「本次品种无历史 → 不弹」两条口径。
//
// 验证链路（全程真实 Chrome，真实 OPFS，真实 xlsx 解析）：
//   第 1 轮：上传 A → 本地无历史 → **不弹窗** → 应写出留档（记录条数）
//   第 2 轮：重载（模拟"下次打开"）→ 上传 **A**（百泽安在留档里）
//             → **必须弹窗**；本次品种默认勾选；历史其他品种默认不勾
//             → 点「加载所选」→ 合并去重
//   第 3 轮：重载 → 上传 **A** → 点「不用历史」→ 只算本次 → 条数 == 仅 A
//   第 4 轮：重载 → 上传 **B**（B 的品种不在留档里）→ **不弹窗**（口径：本次品种全无历史）
//   第 5 轮：只上传 B 不应删掉 A 的留档
//
// 注：file:// 下每个 origin 的 OPFS 是独立存储，需固定 --user-data-dir 才能跨轮保留。
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9466;
const ROOT = "C:/Users/yym/WorkBuddy/2026-07-23-09-46-32/repurchase_dashboard";
const URL_ = "file:///" + ROOT + "/index.html";
const PROFILE = "C:/Users/yym/AppData/Local/Temp/cdp_archive";

const fileA = process.argv[2];
const fileB = process.argv[3];
if (!fileA || !fileB) { console.log("用法: node tests/_cdp_archive.mjs <A.xlsx> <B.xlsx>"); process.exit(1); }

// 每轮都从干净的 profile 开始，保证"第 1 轮无历史"的前提成立
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

let ws, send, evalJS, events;
let id = 0;

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
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const r = await evalJS(`!!(window.AppCore && window.Pipeline && window.Mapping)`).catch(() => false);
    if (r) return true;
    await sleep(400);
  }
  return false;
}

// 把文件塞进 #allInput 并触发 change，等 pendingFiles 收全
async function upload(files) {
  const doc = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#allInput" });
  if (!q.result.nodeId) throw new Error("找不到 #allInput");
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files });
  await evalJS(`(function(){ const el=document.querySelector("#allInput"); el.dispatchEvent(new Event("change",{bubbles:true})); return el.files.length; })()`, false);
  let n = 0;
  for (let i = 0; i < 90; i++) {
    const t = await evalJS(`(document.querySelector("#pendingTotalCount")||{}).textContent || ""`).catch(() => "");
    const m = /共 (\d+) 个文件/.exec(t);
    n = m ? +m[1] : 0;
    if (n >= files.length) break;
    await sleep(500);
  }
  return n;
}

// 点分析，等 dedup 出现，同时捕捉弹窗状态
// ⚠️ 关键：STORE.dedup 是在 `await saveArchiveByProduct(...)` **之前**赋值的，
//    所以「看到 STORE.dedup」≠「留档已写盘」。调用方必须再用 waitArchive() 等写盘落定，
//    否则紧接着 reload 会把还在飞的 createWritable 掐断（导致留档丢失）。
async function analyze({ expectDialog }) {
  await evalJS(`(function(){ const b=document.querySelector("#startBtn"); b.click(); return 1; })()`, false);
  let dd = null, dialogSeen = false, snap = null;
  for (let i = 0; i < 400; i++) {
    const st = await evalJS(`(function(){
      try{
        const m=document.querySelector("#arcMask");
        const open = m && !m.classList.contains("hidden");
        const d=window.AppCore.STORE && window.AppCore.STORE.dedup;
        return JSON.stringify({
          open: !!open,
          dd: d?{total:d.total,kept:d.kept,removed:d.removed,groups:d.groups,archive:d.archive}:null
        });
      }catch(e){ return "ERR:"+e.message; }
    })()`).catch((e) => "THROW:" + e.message);
    if (typeof st === "string" && st.startsWith("{")) {
      const o = JSON.parse(st);
      if (o.open) {
        dialogSeen = true;
        snap = await evalJS(`(function(){
          const g=(s)=>{const e=document.querySelector(s);return e?e.innerText.trim():null;};
          const items=[];
          document.querySelectorAll("#arcListNow .arc-item, #arcListOld .arc-item").forEach(el=>{
            const cb=el.querySelector("input[type=checkbox]");
            items.push({prod: cb?cb.getAttribute("data-prod"):null, checked: cb?cb.checked:null,
                        sec: el.closest("#arcListNow")?"now":"old"});
          });
          return JSON.stringify({title:g("#arcTitle"), sub:g("#arcSub"),
            secNow:g("#arcSecNow"), secOld:g("#arcSecOld"), items,
            hasOk: !!document.querySelector("#arcOk"), hasSkip: !!document.querySelector("#arcSkip")});
        })()`);
        if (expectDialog) break;             // 需要弹窗 → 命中即停，交给调用方点按钮
      } else if (o.dd) { dd = o.dd; break; } // 无弹窗 → 等分析完成
    }
    await sleep(400);
  }
  return { dd, dialogSeen, snap: snap ? JSON.parse(snap) : null };
}

// 轮询等待留档写入落盘（写盘是分析流程末尾的 await，需给一点时间）
async function waitArchive(minProducts, tries = 40) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = JSON.parse(await readArchive());
    if (Array.isArray(last.products) && last.products.length >= minProducts) return last;
    await sleep(400);
  }
  return last;
}

async function readArchive() {
  // ⚠️ 结构是 <root>/留档/销售/<品种>/sales.json —— 「销售」下挂的是**目录**（品种），
  //    不是文件。之前误用 `h.kind !== "file" → continue` 把每个品种目录都跳过了，
  //    导致明明写盘成功却读出空数组。这里改为进入子目录读 sales.json。
  return await evalJS(`(async function(){
    try{
      const root = await navigator.storage.getDirectory();
      const out = [];
      try{
        const base = await root.getDirectoryHandle("留档");
        const sales = await base.getDirectoryHandle("销售");
        for await (const [name, h] of sales.entries()){
          if (h.kind !== "directory") continue;
          try{
            const fh = await h.getFileHandle("sales.json");
            const j = JSON.parse(await (await fh.getFile()).text());
            out.push({product:name, count:(j.records||[]).length, ver:j.version, ts:j.updated_at});
          }catch(e){
            out.push({product:name, count:-1, err:e.name});
          }
        }
      }catch(e){ return JSON.stringify({err:"no-dir:"+e.name}); }
      return JSON.stringify({products:out.sort((a,b)=>a.product<b.product?-1:1)});
    }catch(e){ return JSON.stringify({err:e.message}); }
  })()`);
}

// 触发一次重载，模拟"下次打开这个页面"。
// 先等分析流程彻底跑完（#dataInfo 有内容 = 已越过 await 写盘那一行），避免掐断写盘。
async function reload() {
  for (let i = 0; i < 60; i++) {
    const info = await evalJS(`(document.querySelector("#dataInfo")||{}).textContent||""`).catch(() => "");
    if (info && info.trim()) break;
    await sleep(300);
  }
  await sleep(800); // 再给 createWritable 一点 flush 时间
  await send("Page.reload", { ignoreCache: false });
  await sleep(1500);
  if (!(await waitReady())) throw new Error("重载后脚本未就绪");
}

(async () => {
  try {
    await connect();
    if (!(await waitReady())) { console.log("脚本未就绪"); chrome.kill(); process.exit(1); }

    console.log("===== [0] 能力探测 =====");
    const cap = await evalJS(`(async function(){
      const s = navigator.storage;
      let q = null; try { q = await s.estimate(); } catch(e){}
      let persisted = null; try { persisted = await s.persisted(); } catch(e){}
      // ⚠️ archiveSupported 是**函数**（不是布尔值），必须调用
      let sup = null; try { sup = window.Pipeline.archiveSupported(); } catch(e){ sup = "ERR:"+e.message; }
      return JSON.stringify({hasGetDirectory: typeof s.getDirectory === "function",
        supported: sup, supportedType: typeof window.Pipeline.archiveSupported,
        quota: q && q.quota, usage: q && q.usage, persisted});
    })()`);
    const capO = JSON.parse(cap);
    console.log("  " + cap);
    ok(capO.hasGetDirectory === true, "浏览器支持 OPFS（getDirectory 可用）");
    ok(capO.supportedType === "function", "Pipeline.archiveSupported 是函数（非布尔值）");
    ok(capO.supported === true, "Pipeline.archiveSupported() = true");

    console.log("\n===== [1] 第 1 轮：首次上传（本地应无历史，不弹窗）=====");
    const a0 = await readArchive();
    console.log("  上传前留档: " + a0);
    ok(JSON.parse(a0).err && /no-dir/.test(JSON.parse(a0).err), "干净 profile 下留档目录尚不存在（无历史）");
    const nA = await upload([fileA]);
    ok(nA >= 1, "文件 A 已被识别", "共 " + nA + " 个文件");
    const r1 = await analyze({ expectDialog: false });
    ok(r1.dialogSeen === false, "首次上传不弹窗（本次品种在本地无历史）");
    ok(!!r1.dd, "分析完成并产出去重统计");
    if (r1.dd) console.log("  STORE.dedup = " + JSON.stringify(r1.dd));
    const a1 = await waitArchive(1);
    console.log("  上传后留档: " + JSON.stringify(a1));
    ok(Array.isArray(a1.products) && a1.products.length > 0, "留档已写盘（按品种分目录）");
    ok(a1.products && a1.products.every(p => p.count > 0 && p.ver === 1), "每个品种目录下 sales.json 结构正确（version=1, 有记录）");
    const archA = a1.products ? a1.products.reduce((s, p) => s + p.count, 0) : 0;
    ok(archA > 0, "留档总条数 > 0", archA + " 条");
    const prodsA = (a1.products || []).map(p => p.product);
    console.log("  留档品种: " + prodsA.join(" / "));

    console.log("\n===== [2] 第 2 轮：重载后**再传 A**（A 的品种在留档里 → 必须弹窗）=====");
    await reload();
    const a2 = JSON.parse(await readArchive());
    ok(a2.products && a2.products.length === prodsA.length, "重载后留档仍在（OPFS 持久）", a2.products ? a2.products.length + " 个品种" : "无");
    const nA2 = await upload([fileA]);
    ok(nA2 >= 1, "文件 A 已被识别", "共 " + nA2 + " 个文件");
    const r2 = await analyze({ expectDialog: true });
    ok(r2.dialogSeen === true, "★ 弹窗出现（本次品种在留档里有历史）");
    if (r2.snap) {
      console.log("  标题: " + r2.snap.title);
      console.log("  副标题: " + r2.snap.sub);
      console.log("  分区: now='" + r2.snap.secNow + "' old='" + r2.snap.secOld + "'");
      console.log("  条目: " + JSON.stringify(r2.snap.items));
      ok(/^是否加载【.+】的历史数据？$/.test(r2.snap.title || ""), "标题格式正确（是否加载【品种】的历史数据？）");
      ok((r2.snap.items || []).some(i => i.sec === "now" && i.checked === true), "本次上传的品种已默认勾选");
      if ((r2.snap.items || []).some(i => i.sec === "old")) {
        ok((r2.snap.items || []).every(i => i.sec !== "old" || i.checked === false), "历史里的其他品种默认不勾选");
      } else {
        console.log("  （本次无「历史其他品种」，跳过该断言）");
      }
      ok(r2.snap.hasOk && r2.snap.hasSkip, "弹窗有「加载所选」与「不用历史」两个按钮");
      ok(!/提示|注意|建议|可能不完整|遗漏/.test(r2.snap.sub || ""), "副标题不含额外提醒文案（用户明确要求不加）");
    }
    // 点「加载所选」（默认只勾本次品种）
    const arcPicked = (r2.snap && r2.snap.items ? r2.snap.items.filter(i => i.checked).map(i => i.prod) : []);
    const dd2 = await (async () => {
      await evalJS(`(function(){ document.querySelector("#arcOk").click(); return 1; })()`, false);
      let d = null;
      for (let i = 0; i < 400; i++) {
        const st = await evalJS(`(function(){ const d=window.AppCore.STORE&&window.AppCore.STORE.dedup; return d?JSON.stringify({total:d.total,kept:d.kept,removed:d.removed,archive:d.archive}):null; })()`).catch(() => null);
        if (st && st !== "null") { d = JSON.parse(st); break; }
        await sleep(400);
      }
      return d;
    })();
    ok(!!dd2, "点「加载所选」后分析完成");
    if (dd2) {
      console.log("  STORE.dedup = " + JSON.stringify(dd2));
      ok(Array.isArray(dd2.archive) && dd2.archive.length === arcPicked.length, "STORE.dedup.archive 记录了实际并入的品种", JSON.stringify(dd2.archive));
      const info = await evalJS(`(document.querySelector("#dataInfo")||{}).textContent||""`);
      console.log("  #dataInfo = " + info);
      ok(/已并入 \d+ 个品种历史/.test(info), "页面上如实标出「已并入 N 个品种历史」");
    }

    console.log("\n===== [3] 第 3 轮：重载后再传 A，点「不用历史」→ 只算本次 =====");
    await reload();
    await upload([fileA]);
    const r3 = await analyze({ expectDialog: true });
    ok(r3.dialogSeen === true, "再次弹窗（历史仍在，口径稳定可复现）");
    await evalJS(`(function(){ document.querySelector("#arcSkip").click(); return 1; })()`, false);
    let dd3 = null;
    for (let i = 0; i < 400; i++) {
      const st = await evalJS(`(function(){ const d=window.AppCore.STORE&&window.AppCore.STORE.dedup; return d?JSON.stringify({total:d.total,kept:d.kept,removed:d.removed,archive:d.archive}):null; })()`).catch(() => null);
      if (st && st !== "null") { dd3 = JSON.parse(st); break; }
      await sleep(400);
    }
    ok(!!dd3, "点「不用历史」后分析完成");
    if (dd3) {
      console.log("  STORE.dedup = " + JSON.stringify(dd3));
      ok(Array.isArray(dd3.archive) && dd3.archive.length === 0, "archive 为空（未并入任何历史）");
      const info = await evalJS(`(document.querySelector("#dataInfo")||{}).textContent||""`);
      console.log("  #dataInfo = " + info);
      ok(!/已并入/.test(info), "页面不显示「已并入历史」");
      if (r1.dd) ok(dd3.kept === r1.dd.kept,
        "不加载历史时条数 == 首次上传同文件的条数（历史确实没并进来）",
        dd3.kept + " == " + r1.dd.kept);
    }

    console.log("\n===== [4] 第 4 轮：重载后传 B（B 的品种不在留档里）→ 不弹窗 =====");
    await reload();
    const nB = await upload([fileB]);
    ok(nB >= 1, "文件 B 已被识别", "共 " + nB + " 个文件");
    const r4 = await analyze({ expectDialog: false });
    ok(r4.dialogSeen === false, "★ 不弹窗（本次品种在留档里全无历史 → 直接只算本次）");
    ok(!!r4.dd, "分析正常完成（无历史也能算）");
    if (r4.dd) console.log("  STORE.dedup = " + JSON.stringify(r4.dd));
    await waitArchive(2); // B 的留档也应补写进去（留档是全量累积，不区分先后）
    const a4 = JSON.parse(await readArchive());
    const prods4 = (a4.products || []).map(p => p.product);
    console.log("  当前留档品种: " + prods4.join(" / "));
    ok(prodsA.length > 0, "前置条件成立（第 1 轮确实写入了留档品种）", prodsA.join("、"));
    ok(prodsA.every(p => prods4.includes(p)), "★ A 的留档未被误删（只上传 B 不该清掉 A）");
    ok(prods4.length >= prodsA.length, "留档品种数未减少（" + prodsA.length + " → " + prods4.length + "）");

    const errs = events.filter(e => e.method === "Runtime.exceptionThrown");
    console.log("\n===== [5] 页面 JS 异常 =====");
    if (errs.length) errs.slice(0, 5).forEach(e => console.log("  " + (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text)));
    ok(errs.length === 0, "全程无未捕获 JS 异常", errs.length + " 个");

    console.log("\n通过 " + pass + " / " + (pass + fail));
    ws.close(); chrome.kill();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log("执行出错: " + (e && e.message ? e.message : e));
    try { ws && ws.close(); } catch (_) { }
    chrome.kill();
    process.exit(1);
  }
})();
