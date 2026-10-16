/* 购药记录浮窗 —— 回归测试
   ─────────────────────────────────────────────────────────
   需求（2026-10-16 用户原话）：
     「新增一个"购药记录"功能，即单个患者的所有购药记录。用户点击列表中的某个
      患者名字/电话/会员号后，悬浮小窗口呈现该患者所有的购药时间、品种、数量
      （分品种按时间倒序排列）」
   追问定稿三项：
     · 数据范围 → 不受筛选影响，但需呈现每次购药对应的药房
     · 同日多条 → 逐条原样列出（不做同日合并）
     · 弹窗列   → 购药时间 / 数量 / 药房
     · 快照模式 → 不支持，快照内点击不响应
   ─────────────────────────────────────────────────────────
   分层：
     [A] 聚合口径：分组 / 组内倒序 / 组间倒序 / 同日保留 / 不受筛选影响 / 缓存不串版本
     [B] 真实 DOM 点击链路：点患者名·电话·会员号 → 浮窗内容与开合
     [C] 脱敏与转义：姓名电话跟随脱敏开关；「仅会员号」模式补显会员号；药房名含引号不破属性
     [D] 快照模式：不给可点类名、点击无反应
     [E] 源码 / 产物防线
   ───────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");

// jsdom 不在本项目内，安装于隔离的 node 工作区。加载顺序：
//   1) NODE_PATH（由 tests/_run_all.py 注入）  2) 项目本地 node_modules  3) 固定兜底路径
function resolveJsdom() {
  const tried = [];
  const bases = [process.env.NODE_PATH, path.join(__dirname, "..", "node_modules"),
    "C:\\Users\\yym\\.workbuddy\\binaries\\node\\workspace\\node_modules"];
  for (const b of bases) {
    if (!b) continue;
    for (const seg of b.split(path.delimiter)) {
      if (!seg) continue;
      const p = path.join(seg, "jsdom");
      if (fs.existsSync(p)) return p;
      tried.push(p);
    }
  }
  console.error("找不到 jsdom。已尝试：\n  " + tried.join("\n  ") +
    "\n请设置 NODE_PATH 指向含 jsdom 的 node_modules 后重跑本测试。");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  m + "  (得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + ")");
const log = m => console.log(m);

const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const TPL = fs.readFileSync(path.join(ROOT, "index.template.html"), "utf8");

/* ---------- 造数据 ---------- */
// 甲：跨 2 个品种、跨 2 个药房，且 08-20 当天买了两行（用于验「逐条原样列出」）
const JIA = { name: "张测试甲", phone: "13800001111", member: "M001" };
const YI = { name: "李测试乙", phone: "13800002222", member: "M002" };
const rec = (date, fam, qty, pharm, p) => ({
  source: "sales", _row_id: `f::sales::s::${date}-${fam}-${qty}-${pharm}`,
  sales_time: date, product: fam, product_raw: fam, qty: String(qty),
  pharmacy: pharm, patient_name: p.name, phone: p.phone, member_id: p.member,
  order_status: "已完成", hospital: "H1", physician: "王医生", department: "肿瘤科", amount: "1000",
});
const SALES = [
  rec("2026-09-12", "百泽安", 1, "A药房", JIA),
  rec("2026-08-20", "百泽安", 1, "A药房", JIA),
  rec("2026-08-20", "百泽安", 2, "A药房", JIA),     // 同日第二条
  rec("2026-06-01", "百悦泽", 2, "B药房", JIA),
  rec("2026-09-20", "百泽安", 1, "B药房", YI),
].map(r => ({ ...r })); // 独立副本，避免测试间互相污染

(async () => {
  const { JSDOM } = require(resolveJsdom());
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.XLSX = require(path.join(ROOT, "vendor", "xlsx.full.min.js"));
  w.alert = () => {};
  await new Promise(r => setTimeout(r, 80));

  const App = w.AppCore, P = w.Pipeline;
  if (!App || !P) { console.error("页面脚本未加载（AppCore/Pipeline 缺失）"); process.exit(1); }
  const doc = w.document;

  // 装载数据 + 复位筛选
  function load(sales) {
    App.STORE.sales = sales.map(r => ({ ...r }));
    App.STORE.followups = []; App.STORE.cycles = {};
    App.state.pharmacies = new Set();
    App.state.hospitals = new Set(); App.state.executors = new Set();
    App.state.products = new Set(); App.state.cats = new Set();
    App.state.reasons = new Set(); App.state.repurParts = new Set();
    App.state.q = ""; App.state.page = 1; App.state.pageSize = 50;
    App.state.refDate = "2026-09-20"; App.state.weekSel = "this"; App.state.weekEnd = 0;
    App.state.stdCycle = { 百泽安: 21, 百悦泽: 28 };
    App.state.cycleAlgo = "reset"; App.state.cycleTol = 7; App.state.qtyScale = {};
    App.state.hiddenCols = new Set();
    App.state.plainName = false; App.state.plainPhone = false; App.state.plainDoctor = false;
    App.state.maskMode = "edge";
  }
  const K = (p) => P.patientKey(p.name, p.phone);
  const showTable = () => { App.DATA.rows = App.buildRows(); App.renderTable(); };
  const pop = () => doc.querySelector("#phPop");
  const popTxt = () => pop().innerHTML;
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));

  /* ================= [A] 聚合口径 ================= */
  log("===== [A] 聚合口径：分组 / 倒序 / 同日保留 / 不受筛选影响 =====");
  load(SALES);
  {
    const a = App.patientPurchases(K(JIA));
    eq(a.total, 4, "甲共 4 次购药（跨 2 品种、含同日第 2 条）");
    eq(a.groups.length, 2, "分成 2 个品种组");
    eq(a.groups.map(g => g.fam), ["百泽安", "百悦泽"], "★ 组间按「各自最近一次购药」倒序（百泽安 09-12 在前）");
    eq(a.groups[0].rows.map(r => r.sales_time), ["2026-09-12", "2026-08-20", "2026-08-20"],
      "★ 组内按购药时间倒序");
    ok(a.groups[0].rows.filter(r => r.sales_time === "2026-08-20").length === 2,
      "★ 同一天的 2 条原样保留（不做同日合并）");
    eq(a.groups[0].latest, "2026-09-12", "组上带 latest（供抬头显示「最近 …」）");
    ok(a.groups[0].rows.every(r => r.pharmacy), "★ 每条记录都带药房（用户要求呈现购药药房）");
    eq(a.groups[1].rows.map(r => r.pharmacy), ["B药房"], "乙药房记录带出（甲在 B药房买过百悦泽）");

    const b = App.patientPurchases(K(YI));
    eq(b.total, 1, "乙共 1 次购药");
    eq(b.groups[0].fam, "百泽安", "乙的品种正确");

    const none = App.patientPurchases(P.patientKey("查无此人", "13900000000"));
    eq(none.total, 0, "查不到的患者 → total 0（不抛错）");
    eq(none.groups, [], "查不到的患者 → 空分组");
    ok(typeof App.phHtml(none) === "string" && App.phHtml(none).includes("没有找到"),
      "空结果也能渲染出「没有找到该患者的购药记录」");
  }

  // 列表行里的 _key 与浮窗查询键必须完全一致（否则点了没反应 / 查出别人）
  {
    showTable();
    const row = App.DATA.rows.find(r => r.patient_name === JIA.name);
    ok(!!row, "列表里能找到甲的行");
    eq(row._key, K(JIA), "★ 行对象的 _key 与 patientPurchases 的查询键一致");
    eq(App.patientPurchases(row._key).total, 4, "用行里的 _key 能查出全部 4 条");
  }

  // 不受筛选影响：选中 A药房后，甲的行只统计 A药房（列表口径），但浮窗仍是全部 4 条
  {
    App.state.pharmacies = new Set(["A药房"]);
    showTable();
    const row = App.DATA.rows.find(r => r.patient_name === JIA.name);
    ok(!!row, "选中 A药房后甲仍在名单里");
    eq(row.last_purchase, "2026-09-12", "列表口径：最近购药只算 A药房");
    const a = App.patientPurchases(row._key);
    eq(a.total, 4, "★ 浮窗不受药房筛选影响 —— 仍是全部 4 条（含 B药房那条）");
    eq(a.groups.map(g => g.fam), ["百泽安", "百悦泽"], "★ 浮窗里 B药房买过的百悦泽没有消失");
  }

  // 缓存以数组身份为版本：换掉 STORE.sales 后必须重新建索引（否则会读到上一批数据）
  {
    App.state.pharmacies = new Set();
    load([rec("2026-05-05", "百泽安", 9, "C药房", JIA)]);
    const a = App.patientPurchases(K(JIA));
    eq(a.total, 1, "★ 换数据后重新建索引（total 从 4 变 1，未吃旧缓存）");
    eq(a.groups[0].rows[0].sales_time, "2026-05-05", "★ 读到的是新数据");
  }

  /* ================= [B] 真实 DOM 点击链路 ================= */
  log("\n===== [B] 真实点击链路：患者名 / 电话 → 浮窗 =====");
  load(SALES);
  {
    showTable();
    ok(pop().classList.contains("hidden"), "初始状态浮窗是隐藏的");

    const nameEl = doc.querySelector('#tbody tr.data-row .p-link');
    ok(!!nameEl, "★ 患者名列（第一列）渲染出可点的 .p-link");
    eq(nameEl.textContent, "张**甲", "默认脱敏下显示掩码姓名（edge：张**甲）");

    click(nameEl);
    ok(!pop().classList.contains("hidden"), "★ 点击患者名 → 浮窗打开");
    eq(doc.querySelectorAll("#tbody tr.expand-row").length, 0,
      "★ 点击患者名不触发行展开（stopPropagation 生效）");
    ok(popTxt().includes("共 <b>4</b> 次购药"), "浮窗抬头统计：共 4 次购药");
    ok(popTxt().includes("2</b> 个品种"), "浮窗抬头统计：2 个品种");
    ok(popTxt().includes("购药时间") && popTxt().includes("数量") && popTxt().includes("药房"),
      "★ 三列表头齐全：购药时间 / 数量 / 药房");

    // 内容顺序：品种组 → 组内时间倒序
    const t = popTxt();
    ok(t.indexOf("百泽安") < t.indexOf("百悦泽"), "★ 百泽安组排在百悦泽组之前（组间按最近购药倒序）");
    ok(t.indexOf("2026-09-12") < t.indexOf("2026-08-20"), "★ 组内 09-12 排在 08-20 之前（时间倒序）");
    ok(t.indexOf("A药房") > 0 && t.indexOf("B药房") > 0, "两个药房都在浮窗里出现");
    ok(/2026-08-20<\/span><span class="ph-qty">1</.test(t) && /2026-08-20<\/span><span class="ph-qty">2</.test(t),
      "★ 同日两条的数量 1 / 2 分别原样列出");

    // 再次点击同一格 = 关闭（切换）
    click(nameEl);
    ok(pop().classList.contains("hidden"), "★ 再次点击同一格 → 浮窗关闭（切换）");

    // 点电话列 → 同一位患者
    const phoneEl = [...doc.querySelectorAll('#tbody tr.data-row .p-link')]
      .find(el => /\*{4}/.test(el.textContent));
    ok(!!phoneEl, "★ 电话列也渲染成可点的 .p-link");
    click(phoneEl);
    ok(!pop().classList.contains("hidden"), "点击电话 → 浮窗打开");
    ok(popTxt().includes("共 <b>4</b> 次购药"), "电话列点开的是同一位患者的完整记录");

    // 换一位患者：浮窗内容随之切换（不是残留上一位）
    const rowYI = App.DATA.rows.findIndex(r => r.patient_name === YI.name);
    const trYI = doc.querySelectorAll("#tbody tr.data-row")[rowYI];
    ok(!!trYI, "乙的行存在");
    const linkYI = trYI.querySelector(".p-link");
    // 前一次浮窗还开着，直接点另一位患者
    click(linkYI);
    ok(popTxt().includes("共 <b>1</b> 次购药"), "★ 点另一位患者 → 浮窗内容换成他的（1 次）");
    ok(!popTxt().includes("共 <b>4</b> 次购药"), "★ 上一位患者的统计没有残留");

    // 点非患者列（如品种列）不应打开浮窗 —— 应走原有的行展开
    App.closePurchPop();
    const prodTd = trYI.querySelectorAll("td")[App.LIST_COLS.findIndex(([k]) => k === "product")];
    click(prodTd);
    ok(pop().classList.contains("hidden"), "★ 点品种列不会打开浮窗");
    ok(doc.querySelectorAll("#tbody tr.expand-row").length === 1, "点其它列仍正常展开行（原行为未被破坏）");
  }

  /* ================= [C] 脱敏与属性转义 ================= */
  log("\n===== [C] 脱敏口径 / 「仅会员号」模式 / 属性转义 =====");
  {
    load(SALES);
    App.state.plainName = true; App.state.plainPhone = true;
    showTable();
    click(doc.querySelector("#tbody tr.data-row .p-link"));
    ok(popTxt().includes(JIA.name), "姓名不脱敏时浮窗显示明文姓名");
    ok(popTxt().includes(JIA.phone), "电话不脱敏时浮窗显示明文电话");

    load(SALES);
    App.state.maskMode = "id";   // 患者列改显会员号，电话列自动隐藏
    showTable();
    const cols = [...doc.querySelectorAll("#thead th")].map(th => th.textContent.trim());
    ok(!cols.includes("电话"), "「仅会员号」模式下电话列隐藏（与列表口径一致）");
    const idLink = doc.querySelector("#tbody tr.data-row .p-link");
    eq(idLink.textContent, JIA.member, "★ 患者列此时显示的就是会员号（所以点它 = 点会员号）");
    click(idLink);
    ok(popTxt().includes(JIA.member), "★ 点会员号 → 浮窗打开且抬头补显会员号");
    ok(popTxt().includes("会员号"), "抬头有「会员号」字样");
    ok(popTxt().includes("共 <b>4</b> 次购药"), "点会员号查到的是同一位患者的 4 条记录");

    // 默认（非 id）模式下不得额外露出会员号 —— 否则等于绕过脱敏
    load(SALES);
    showTable();
    click(doc.querySelector("#tbody tr.data-row .p-link"));
    ok(!popTxt().includes(JIA.member), "★ 默认脱敏模式下浮窗不额外露出会员号（不绕过脱敏）");
    ok(!popTxt().includes(JIA.name), "★ 默认脱敏模式下不出现明文姓名");

    // 药房名带引号：title 属性必须转义，不能被截断/逃逸
    load([rec("2026-09-12", "百泽安", 1, 'A"药房<b>', JIA)]);
    showTable();
    click(doc.querySelector("#tbody tr.data-row .p-link"));
    const t = popTxt();
    ok(t.includes("&quot;"), "★ 药房名里的引号被转义为 &quot;（escAttr 生效）");
    ok(!/<b>药房/.test(t.replace(/<b>\d+<\/b>/g, "")), "★ 药房名里的 <b> 被转义，未注入 HTML");
    ok(!!doc.querySelector("#phPop .ph-ph"), "药房单元格仍正常渲染");
    eq(doc.querySelector("#phPop .ph-ph").textContent, 'A"药房<b>', "药房文本还原正确（转义只影响标记层）");
  }

  /* ================= [D] 快照模式不启用 ================= */
  log("\n===== [D] 快照模式：不给可点类名、点击无反应 =====");
  {
    load(SALES);
    const rows = App.buildRows();
    App.loadSnapshot({ rows: rows.map(r => ({ ...r })), state: {}, summary: null, buildAt: new Date().toISOString() });
    ok(doc.querySelectorAll("#tbody tr.data-row").length > 0, "快照模式下列表已渲染");
    eq(doc.querySelectorAll("#tbody .p-link").length, 0, "★ 快照里没有 .p-link（不给可点提示）");
    ok(pop().classList.contains("hidden"), "快照里浮窗保持隐藏");
    const firstTd = doc.querySelector("#tbody tr.data-row td");
    click(firstTd);
    ok(pop().classList.contains("hidden"), "★ 快照里点击患者列不弹浮窗（快照不含销售明细）");
    ok(!firstTd.querySelector("span[title]"), "快照里患者名不带「点击查看」提示");
  }

  /* ================= [E] 源码 / 产物防线 ================= */
  log("\n===== [E] 源码与产物防线 =====");
  {
    ok(/<div class="ph-pop hidden" id="phPop"/.test(TPL), "模板里有 #phPop 节点（初始隐藏）");
    ok(/\.ph-pop\{position:fixed/.test(TPL), "模板里有 .ph-pop 浮层样式（fixed 定位）");
    ok(/td \.p-link\{cursor:pointer\}/.test(TPL), "模板里有 .p-link 可点样式");

    ok(/function patientPurchases\s*\(/.test(APP), "app.js 有 patientPurchases()");
    ok(/function purchIndex\s*\(/.test(APP), "app.js 有 purchIndex() 索引（点击 O(1)）");
    ok(/P\.patientKey\(s\.patient_name, s\.phone\)/.test(APP), "索引按 Pipeline.patientKey 聚合（与列表同一识人键）");
    ok(/function escAttr\s*\(/.test(APP), "app.js 有 escAttr()（属性值转义）");
    ok(/const rows = g\.rows\.map/.test(APP), "明细逐条渲染（g.rows.map）");
    // normalizePurchases 是「同日多行数量相加」的算法辅助，浮窗链路一旦调用它，同日明细就会被吃掉
    const iPH = APP.indexOf("function patientPurchases");
    const segPH = APP.slice(iPH, APP.indexOf("function renderTable()", iPH));
    ok(iPH > 0 && !/normalizePurchases/.test(segPH),
      "★ 浮窗链路不调用 normalizePurchases（那是同日合并口径，会吃掉同日明细）");

    // 键绝不经 DOM 属性（含 \u0000 会被解析成 U+FFFD）——.p-link 上不得挂 data-*
    const iPL = APP.indexOf('class="p-link"');
    ok(iPL > 0, "找到 .p-link 模板片段");
    const seg = APP.slice(iPL - 120, iPL + 160);
    ok(!/data-/.test(seg), "★ .p-link 片段里没有 data-* 属性（键由 rowByTr 回查）");
    ok(/rowByTr\(el\)/.test(APP), "★ 点击时用 rowByTr 回查行对象现取键");

    ok(/closePurchPop\(\);\n  const cols = visibleCols\(\);/.test(APP) ||
      /表格重建会让浮窗的锚点单元格变成游离节点/.test(APP),
      "renderTable 重建前先收起浮窗（避免锚点游离）");
    ok(/document\.addEventListener\("mousedown"/.test(APP) && /closest\("#phPop"\)/.test(APP),
      "点浮窗外部会收起（浮窗内部点击不收起）");
    ok(/"scroll"/.test(APP) && /\.tbl-wrap/.test(APP), "表格滚动会收起浮窗（锚点会滚走）");

    for (const f of ["index.html", "index.single.html"]) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) { ok(false, f + " 不存在（先跑 build.py）"); continue; }
      const s = fs.readFileSync(p, "utf8");
      ok(s.includes('id="phPop"'), f + " 含 #phPop 节点");
      ok(s.includes("function patientPurchases"), f + " 含 patientPurchases 实现");
      ok(s.includes(".p-link"), f + " 含 .p-link 样式");
    }
  }

  console.log("\n通过 " + pass + " / " + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
