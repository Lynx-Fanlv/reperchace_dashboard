/* 购药记录浮窗：**走真实上传链路**的端到端核验（由 _cdp_purchhist_real.mjs 注入执行）
   前面的 _ph_probe.js 是直接往 STORE.sales 灌数据；这里必须先经过「上传 → 识别 → 去重 → 建行」，
   确认浮窗在真实数据链路上同样取得到、取得到的是对的。 */
(async () => {
  const out = [];
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; out.push((c ? "  ✅ " : "  ❌ ") + m); };
  const log = m => out.push(m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const A = window.AppCore;
  const pop = document.getElementById("phPop");

  log("=== [0] 真实上传链路的结果 ===");
  ok(!document.getElementById("board").classList.contains("hidden"), "board 已显示（分析已完成）");
  log("  dataInfo: " + (document.getElementById("dataInfo") || {}).textContent);
  log("  STORE.sales = " + A.STORE.sales.length + " 条");
  ok(A.STORE.sales.length > 0, "STORE.sales 有数据");
  ok(A.DATA.rows.length > 0, "名单行已生成（" + A.DATA.rows.length + " 行）");

  document.getElementById("board").classList.remove("hidden");

  /* ---------- 挑一位购药次数最多的患者 ---------- */
  const seen = new Map();
  for (const r of A.DATA.rows) if (!seen.has(r._key)) seen.set(r._key, r);
  let best = null, bestN = -1;
  for (const [k, r] of seen) {
    const n = A.patientPurchases(k).total;
    if (n > bestN) { bestN = n; best = r; }
  }
  log("\n=== [1] 挑一位购药最多的患者 ===");
  ok(!!best && bestN > 1, "找到购药 " + bestN + " 次的患者（名单共 " + seen.size + " 位患者）");
  if (!best) { log("\n通过 " + pass + " / " + (pass + fail)); return out.join("\n"); }
  const info = A.patientPurchases(best._key);
  log("  患者 " + best.patient_name + " / " + best.phone + "：共 " + info.total +
      " 次 · " + info.groups.length + " 个品种（" + info.groups.map(g => g.fam).join("/") + "）");

  /* ---------- 翻到该行所在页，点它的患者名 ---------- */
  const idx = A.DATA.rows.indexOf(best);
  const page = Math.floor(idx / A.state.pageSize) + 1;
  A.state.page = page;
  A.renderTable();
  await sleep(200);
  const tr = document.querySelector('#tbody tr.data-row[data-idx="' + idx + '"]');
  ok(!!tr, "目标行在第 " + page + " 页渲染出来了（idx=" + idx + "）");
  const link = tr && tr.querySelector(".p-link");
  ok(!!link, "★ 该行的患者名是可点元素（真实数据链路）");
  if (!link) { log("\n通过 " + pass + " / " + (pass + fail)); return out.join("\n"); }

  const a = link.getBoundingClientRect();
  link.click();
  await sleep(300);
  ok(!pop.classList.contains("hidden"), "★ 点击后浮窗打开");

  /* ---------- [2] 内容与 AppCore 口径逐条比对 ---------- */
  log("\n=== [2] 浮窗内容 vs patientPurchases 逐条比对 ===");
  ok(pop.textContent.includes("共 " + info.total + " 次购药"),
    "★ 抬头统计一致：共 " + info.total + " 次购药");
  const grpHeads = [...pop.querySelectorAll(".ph-grp-h")].map(e => e.firstElementChild.textContent.trim());
  ok(grpHeads.length === info.groups.length,
    "★ 分组数一致：" + grpHeads.length + " vs " + info.groups.length + "（" + grpHeads.join("/") + "）");

  const rendered = [...pop.querySelectorAll(".ph-grp")].map(g => ({
    fam: g.querySelector(".ph-grp-h").firstElementChild.textContent.trim(),
    dates: [...g.querySelectorAll(".ph-row")].map(r => r.children[0].textContent.trim()),
    qtys: [...g.querySelectorAll(".ph-row")].map(r => r.children[1].textContent.trim()),
    phs: [...g.querySelectorAll(".ph-row")].map(r => r.children[2].textContent.trim()),
  }));
  const expect = info.groups.map(g => ({
    fam: g.fam,
    dates: g.rows.map(r => String(r.sales_time || "")),
    qtys: g.rows.map(r => String(r.qty == null ? "" : r.qty).trim() || "—"),
    phs: g.rows.map(r => String(r.pharmacy || "未知")),
  }));
  ok(JSON.stringify(rendered) === JSON.stringify(expect),
    "★ 浮窗渲染的「时间 / 数量 / 药房」与 patientPurchases 完全一致");
  if (JSON.stringify(rendered) !== JSON.stringify(expect)) {
    log("   渲染: " + JSON.stringify(rendered, null, 0).slice(0, 700));
    log("   期望: " + JSON.stringify(expect, null, 0).slice(0, 700));
  }
  // 每组内时间必须严格不升（倒序），且组头「最近」= 组内第一条
  let orderOk = true, latestOk = true;
  rendered.forEach((g, i) => {
    for (let j = 1; j < g.dates.length; j++) if (g.dates[j] > g.dates[j - 1]) orderOk = false;
    const meta = pop.querySelectorAll(".ph-grp-h")[i].querySelector(".ph-grp-meta").textContent;
    if (!meta.includes(g.dates[0])) latestOk = false;
  });
  ok(orderOk, "★ 每个品种组内按购药时间倒序");
  ok(latestOk, "★ 组头「最近 …」与组内第一条日期一致");
  // 组间按各自最近一次购药倒序
  const latests = rendered.map(g => g.dates[0]);
  const sorted = latests.slice().sort((x, y) => y.localeCompare(x));
  ok(JSON.stringify(latests) === JSON.stringify(sorted), "★ 品种组之间按最近购药时间倒序（" + latests.join(" > ") + "）");

  /* ---------- [3] 几何：不遮住锚点、在视口内 ---------- */
  log("\n=== [3] 几何 ===");
  const pr = pop.getBoundingClientRect(), VH = window.innerHeight, VW = window.innerWidth;
  log("  锚点 bottom=" + Math.round(a.bottom) + "，浮窗 top=" + Math.round(pr.top) +
      " / bottom=" + Math.round(pr.bottom) + " / 高 " + Math.round(pr.height) + " / 宽 " + Math.round(pr.width));
  ok(pr.top >= -1 && pr.bottom <= VH + 1, "★ 纵向在视口内");
  ok(pr.left >= -1 && pr.right <= VW + 1, "★ 横向在视口内");
  ok(!(pr.top < a.bottom && pr.bottom > a.top), "★ 浮窗未压住所点的患者单元格");
  ok(pr.height <= VH * 0.6 + 1, "高度受 max-height 约束：" + Math.round(pr.height) + "px");

  /* ---------- [4] 与已知的其他患者交叉验证：不得串人 ---------- */
  log("\n=== [4] 不串人 ===");
  const others = [...seen.values()].filter(r => r._key !== best._key).slice(0, 3);
  for (const o of others) {
    const oi = A.DATA.rows.indexOf(o);
    const op = Math.floor(oi / A.state.pageSize) + 1;
    if (op !== A.state.page) { A.state.page = op; A.renderTable(); await sleep(150); }
    const otr = document.querySelector('#tbody tr.data-row[data-idx="' + oi + '"]');
    const ol = otr && otr.querySelector(".p-link");
    if (!ol) continue;
    ol.click();
    await sleep(220);
    const oi2 = A.patientPurchases(o._key);
    ok(pop.textContent.includes("共 " + oi2.total + " 次购药") && !pop.textContent.includes("共 " + info.total + " 次购药"),
      "★ 点「" + o.patient_name + "」→ 显示他自己的 " + oi2.total + " 次（未残留上一位的 " + info.total + " 次）");
    break;
  }

  /* ---------- [5] 截图 ---------- */
  log("\n=== [5] 截图 ===");
  A.state.page = page; A.renderTable();
  await sleep(200);
  // 先把页面滚到表格区（scroll 会收起浮窗），再点开 —— 否则截图时浮窗已被滚动事件收掉
  const wrap = document.querySelector(".tbl-wrap");
  window.scrollTo(0, window.scrollY + wrap.getBoundingClientRect().top - 150);
  await sleep(300);
  const tr2 = document.querySelector('#tbody tr.data-row[data-idx="' + idx + '"]');
  const l2 = tr2 && tr2.querySelector(".p-link");
  if (l2) l2.click();
  await sleep(350);
  ok(!pop.classList.contains("hidden"), "浮窗已打开，准备截图");

  log("\n通过 " + pass + " / " + (pass + fail));
  return out.join("\n");
})()
