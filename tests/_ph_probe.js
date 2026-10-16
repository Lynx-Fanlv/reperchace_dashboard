/* 购药记录浮窗：真实浏览器里的几何 / 布局 / 交互验收（由 _cdp_purchhist.mjs 注入执行）
   关注点（这些是 jsdom 量不出来的）：
     · 浮窗是否被夹在视口内、是否贴在所点单元格正下方
     · 下方空间不足时是否翻到上方
     · 内容超长时的 max-height 与内部滚动、列表头是否吸顶
     · 三列是否对齐、长药房名是否被省略而不是把浮窗撑破
   返回报告字符串（含 ❌ 即为失败）。 */
(async () => {
  const out = [];
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; out.push((c ? "  ✅ " : "  ❌ ") + m); };
  const log = m => out.push(m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const A = window.AppCore;

  /* ---------- 造场景：一位患者 3 个品种、跨 3 个药房、36 条记录（足以撑出滚动） ---------- */
  const NAME = "诸葛长风", PHONE = "13800007777", MEMBER = "M777";
  const FAM = ["百泽安", "百悦泽", "索托克拉"];
  // 第三个药房名故意超长（远超浮窗 max-width 600 能给它的宽度）→ 必须走省略号截断，
  // 不能把浮窗撑破，也不能换行把行高翻倍
  const PH = ["成都西三段药房（连锁）", "华西医院门诊药房",
    "成都医学院第一附属医院（原中国人民解放军第四十七医院）门诊西药房第二窗口（含冷链药品专区）"];
  const sales = [];
  for (let i = 0; i < 36; i++) {
    const f = FAM[i % 3];
    const mm = String(9 - Math.floor(i / 12)).padStart(2, "0");
    const dd = String(28 - (i % 12)).padStart(2, "0");
    sales.push({
      source: "sales", _row_id: "ph::" + i, sales_time: "2026-" + mm + "-" + dd,
      product: f, product_raw: f, qty: String((i % 3) + 1), pharmacy: PH[i % 3],
      patient_name: NAME, phone: PHONE, member_id: MEMBER, order_status: "已完成",
      hospital: "H1", physician: "王医生", department: "肿瘤科", amount: "1000",
    });
  }
  // 再放一位正常患者，便于验「换人后内容不残留」
  sales.push({ source: "sales", _row_id: "ph::other", sales_time: "2026-08-08", product: "百泽安",
    product_raw: "百泽安", qty: "1", pharmacy: "A药房", patient_name: "欧阳小白", phone: "13900008888",
    member_id: "M888", order_status: "已完成", hospital: "H2", physician: "李医生", department: "肿瘤科", amount: "900" });

  A.STORE.sales = sales;
  A.STORE.followups = []; A.STORE.cycles = {};
  A.state.pharmacies = new Set(); A.state.hospitals = new Set(); A.state.executors = new Set();
  A.state.products = new Set(); A.state.cats = new Set(); A.state.reasons = new Set(); A.state.repurParts = new Set();
  A.state.q = ""; A.state.page = 1; A.state.pageSize = 50;
  A.state.refDate = "2026-10-01"; A.state.weekSel = "this"; A.state.weekEnd = 0;
  A.state.stdCycle = { 百泽安: 21, 百悦泽: 28, 索托克拉: 28 };
  A.state.plainName = false; A.state.plainPhone = false; A.state.maskMode = "edge";
  await A.refresh();
  await sleep(300);

  // ⚠ 必须显式取消隐藏：#board 的显示是在「上传完成」回调里做的（$("#board").classList.remove("hidden")），
  //   refresh() 自身不管显隐。不取消的话整块 board 还是 display:none —— 所有 getBoundingClientRect 全是 0，
  //   几何断言会「全部通过」却什么都没验到（踩过这个坑）。
  document.getElementById("board").classList.remove("hidden");
  // 把表格滚进视口（页面上方还有上传区等；不滚的话锚点落在视口外，定位断言没意义）
  const wrap = document.querySelector(".tbl-wrap");
  window.scrollTo(0, window.scrollY + wrap.getBoundingClientRect().top - 120);
  await sleep(250);

  const pop = document.getElementById("phPop");
  const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const links = [...document.querySelectorAll("#tbody tr.data-row .p-link")];
  const pick = (masked) => [...document.querySelectorAll("#tbody tr.data-row .p-link")]
    .find(l => l.textContent === masked);
  const VW = window.innerWidth, VH = window.innerHeight;
  const wrapR = rect(wrap);

  log("=== [0] 场景就绪 ===");
  ok(links.length > 0, "列表渲染出可点的患者名 / 电话（" + links.length + " 个链接）");
  ok(pop && pop.classList.contains("hidden"), "浮窗初始隐藏");
  ok(getComputedStyle(pop).position === "fixed", "浮窗是 fixed 定位（不参与页面布局、不撑高页面）");
  ok(getComputedStyle(links[0]).cursor === "pointer", "★ .p-link 光标为手型（可点提示）");
  log("  视口 " + VW + " × " + VH + "，表格区 top=" + Math.round(wrapR.t) + " / 高 " + Math.round(wrapR.h));

  /* ---------- [1] 定位：贴上不贴下、夹在视口内 ---------- */
  log("\n=== [1] 浮窗定位 ===");
  const first = pick("诸**风");
  ok(!!first, "★ 找到多品种患者（诸葛长风）的可点患者名");
  if (!first) { log("\n通过 " + pass + " / " + (pass + fail)); return out.join("\n"); }
  const a0 = rect(first);
  ok(a0.h > 8, "锚点有真实高度（" + Math.round(a0.h) + "px，说明 board 已可见）");
  first.click();
  await sleep(200);
  ok(!pop.classList.contains("hidden"), "点击患者名后浮窗打开");
  let pr = rect(pop);
  log("  锚点 bottom=" + Math.round(a0.b) + " → 浮窗 top=" + Math.round(pr.t) +
      " / 高 " + Math.round(pr.h) + " / 宽 " + Math.round(pr.w));
  // 贴下还是翻上取决于锚点下方剩多少空间 —— 浮窗高 420px，锚点在表中部时必然翻上去（这是对的行为）
  const roomBelow0 = VH - 8 - (a0.b + 6);
  if (pr.h <= roomBelow0) {
    ok(Math.abs(pr.t - (a0.b + 6)) <= 2, "★ 下方空间充足 → 贴在所点单元格正下方（top = 锚点 bottom + 6）");
  } else {
    ok(Math.abs(pr.b - (a0.t - 6)) <= 2, "★ 下方仅 " + Math.round(roomBelow0) + "px 放不下 " + Math.round(pr.h) +
      "px → 翻到锚点上方（浮窗 bottom = 锚点 top - 6），且不遮住所点的行");
  }
  ok(pr.t >= -1 && pr.b <= VH + 1, "★ 纵向完全落在视口内");
  ok(pr.l >= -1 && pr.r <= VW + 1, "★ 横向完全落在视口内");
  ok(pr.h <= VH * 0.6, "★ 高度受 max-height 约束：" + Math.round(pr.h) + "px");
  // 上限收到 480px：超长药房名只能把浮窗撑到 480，而不是之前那样撑到 600 后右侧留一大片空白
  ok(pr.w >= 300 && pr.w <= 482, "宽度受 min-width 300 / max-width 480 约束：" + Math.round(pr.w) + "px");
  ok(!(pr.t < a0.b && pr.b > a0.t), "★ 浮窗不压住所点的患者单元格（始终贴在其上/下侧）");

  /* ---------- [2] 内容结构：分组 / 三列对齐 / 内部滚动 / 表头吸顶 ---------- */
  log("\n=== [2] 内容结构与内部滚动 ===");
  const heads = [...pop.querySelectorAll(".ph-grp-h")].map(e => e.firstElementChild.textContent.trim());
  ok(heads.length === 3, "3 个品种分组： " + heads.join(" / "));
  ok(pop.textContent.includes("共 36 次购药"), "抬头统计「共 36 次购药」");
  ok(pop.textContent.includes("3 个品种"), "抬头统计「3 个品种」");
  ok(!!pop.querySelector(".ph-cols"), "有列表头（购药时间 / 数量 / 药房）");
  const body = pop.querySelector(".ph-body");
  ok(body.scrollHeight > body.clientHeight + 4,
    "★ 明细超长时在浮窗内滚动（scrollH " + body.scrollHeight + " > clientH " + body.clientHeight + "）");
  const row0 = pop.querySelector(".ph-row");
  const cs = [...row0.children].map(rect);
  ok(Math.abs(cs[0].t - cs[2].t) <= 3, "★ 同一行「时间 / 数量 / 药房」基线对齐");
  ok(cs[1].r <= cs[2].l + 1, "数量列在药房列左侧，未重叠");
  const longPh = [...pop.querySelectorAll(".ph-ph")].find(e => e.textContent.length > 12);
  ok(!!longPh, "存在超长药房名用于验证截断");
  ok(!!longPh && longPh.scrollWidth > longPh.clientWidth,
    "★ 超长药房名被省略号截断（scrollW " + (longPh ? longPh.scrollWidth : 0) + " > clientW " + (longPh ? longPh.clientWidth : 0) + "），未撑破浮窗");
  body.scrollTop = 140;
  await sleep(120);
  const cb = rect(pop.querySelector(".ph-cols")), bb = rect(body);
  ok(Math.abs(cb.t - bb.t) <= 2, "★ 列表头吸顶（滚动 140px 后仍贴在内容区顶部）");
  ok(body.scrollTop > 0, "内容区确实滚动了（scrollTop " + Math.round(body.scrollTop) + "）");
  body.scrollTop = 0;

  /* ---------- [3] 贴底单元格 → 浮窗翻到上方 ---------- */
  log("\n=== [3] 贴底锚点 → 浮窗翻到上方 ===");
  A.closePurchPop();
  wrap.scrollTop = wrap.scrollHeight;   // 让最后一个数据行落到表格可视区底部
  await sleep(250);
  const lastLink = [...document.querySelectorAll("#tbody tr.data-row .p-link")].pop();
  const aL = rect(lastLink);
  ok(aL.h > 8, "贴底锚点有真实高度（" + Math.round(aL.h) + "px）");
  const room = VH - 8 - (aL.b + 6);
  lastLink.click();
  await sleep(200);
  pr = rect(pop);
  log("  末行锚点 bottom=" + Math.round(aL.b) + "，下方可用 " + Math.round(room) +
      "px，浮窗高 " + Math.round(pr.h) + "px → top=" + Math.round(pr.t));
  if (pr.h > room) {
    ok(pr.t < aL.t, "★ 下方空间不足 → 翻到锚点上方（top " + Math.round(pr.t) + " < 锚点 top " + Math.round(aL.t) + "）");
    ok(pr.b <= aL.t + 1, "★ 翻上去后底边不压住所点的行（popup bottom " + Math.round(pr.b) + " ≤ 锚点 top " + Math.round(aL.t) + "）");
  } else {
    ok(Math.abs(pr.t - (aL.b + 6)) <= 2, "下方空间充足 → 仍贴在下方");
  }
  ok(pr.t >= -1 && pr.b <= VH + 1, "★ 翻上去后仍未溢出视口");

  /* ---------- [4] 关闭时机 ---------- */
  log("\n=== [4] 关闭时机 ===");
  ok(!pop.classList.contains("hidden"), "准备关闭前浮窗是打开的");
  wrap.scrollTop = 0;
  wrap.dispatchEvent(new Event("scroll"));   // scroll 不冒泡 → 应用侧监听在捕获阶段
  await sleep(120);
  ok(pop.classList.contains("hidden"), "★ 表格滚动 → 浮窗收起（锚点滚走，留着会错位）");

  lastLink.click();
  await sleep(150);
  ok(!pop.classList.contains("hidden"), "重新打开浮窗");
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await sleep(100);
  ok(pop.classList.contains("hidden"), "★ 点击浮窗外部 → 收起");

  lastLink.click();
  await sleep(150);
  pop.querySelector(".ph-row").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await sleep(100);
  ok(!pop.classList.contains("hidden"), "★ 点击浮窗内部 → 不收起（可正常滚动查看明细）");

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(100);
  ok(pop.classList.contains("hidden"), "Esc → 收起");

  /* ---------- [5] 换人 / 同格切换 ---------- */
  log("\n=== [5] 换人与切换 ===");
  const first2 = pick("诸**风");
  const other = pick("欧**白");
  ok(!!other, "找到另一位患者「欧**白」的可点元素");
  first2.click();
  await sleep(150);
  ok(pop.textContent.includes("共 36 次购药"), "点甲 → 36 条");
  other.click();
  await sleep(150);
  ok(pop.textContent.includes("共 1 次购药") && !pop.textContent.includes("共 36 次购药"),
    "★ 点乙 → 浮窗换成乙的 1 条，甲的数据不残留");
  other.click();
  await sleep(150);
  ok(pop.classList.contains("hidden"), "★ 再次点同一格 → 关闭（切换）");

  /* ---------- [6] 与行展开互不干扰 ---------- */
  log("\n=== [6] 与「行展开」互不干扰 ===");
  first2.click();
  await sleep(150);
  ok(document.querySelectorAll("#tbody tr.expand-row").length === 0,
    "★ 点患者名不会顺带展开整行（stopPropagation 生效）");
  ok(!pop.classList.contains("hidden"), "浮窗保持打开");
  A.closePurchPop();
  const prodTd = document.querySelectorAll("#tbody tr.data-row td")[4]; // 品种列
  prodTd.click();
  await sleep(150);
  ok(pop.classList.contains("hidden"), "点非患者列不会打开浮窗");
  ok(document.querySelectorAll("#tbody tr.expand-row").length === 1, "点其它列仍正常展开行（原行为未破坏）");

  /* ---------- [7] 锚点在视口外时，浮窗仍须完整可见 ---------- */
  // 真实场景：自动化点击、窗口很矮、或点击后页面又滚了 —— 此时「贴下」和「翻上」都会落到视口外。
  // 必须有一道「夹进视口」的兜底，否则浮窗虽然打开了却看不见（实测跑到 y=3264）。
  log("\n=== [7] 锚点在视口外 → 浮窗仍夹进视口 ===");
  A.closePurchPop();
  window.scrollTo(0, 0);                 // 回到页顶，把表格滚出视口
  await sleep(300);
  const offLink = pick("诸**风");
  const offR = rect(offLink);
  log("  锚点 top=" + Math.round(offR.t) + "，视口高 " + VH);
  ok(offR.t > VH, "锚点确实已在视口下方（top " + Math.round(offR.t) + " > " + VH + "）");
  offLink.click();
  await sleep(250);
  pr = rect(pop);
  log("  浮窗 top=" + Math.round(pr.t) + " / bottom=" + Math.round(pr.b) + " / 高 " + Math.round(pr.h));
  ok(pr.t >= -1 && pr.b <= VH + 1, "★ 浮窗被夹进视口，用户仍看得到（未被甩到视口外）");
  ok(!pop.classList.contains("hidden"), "浮窗确实是打开状态（不是靠没渲染来蒙混）");
  A.closePurchPop();

  /* ---------- [8] 截图 ---------- */
  log("\n=== [8] 截图 ===");
  document.querySelectorAll("#tbody tr.expand-row").forEach(e => e.remove());
  // 先把页面滚回表格区（滚动会收起浮窗），再点开 —— 否则截到的是页顶
  window.scrollTo(0, window.scrollY + wrap.getBoundingClientRect().top - 120);
  await sleep(300);
  pick("诸**风").click();
  await sleep(300);
  ok(!pop.classList.contains("hidden"), "浮窗已打开，准备截图");

  log("\n通过 " + pass + " / " + (pass + fail));
  return out.join("\n");
})()
