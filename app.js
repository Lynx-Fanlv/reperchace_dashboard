// 预计购药分析看板：前端编排层
// 全部计算在浏览器内完成：三表解析(pipeline.js) → 归一化 → 合并计算 → 渲染。
// 无后端、无网络请求；数据从不离开本机。

(function () {
const M = window.Mapping;
const P = window.Pipeline;
const CATEGORIES = M.CATEGORIES;    // 应回购 / 已回购 / 未到期 / 已逾期
const SUBSTATUS = M.SUBSTATUS;      // 正常状态 / 预判延期 / 已脱落（应回购下钻）

const CAT_COLOR = {
  "应回购": "#e03131",   // 进入应购窗口，需要跟进
  "已回购": "#0f9d6b",   // 上次已按时回购，本次未到期
  "未到期": "#3b5bdb",   // 尚未进入窗口
  "已逾期": "#f08c00",   // 应购药日已过
};
const SUB_COLOR = {
  "正常状态": "#0f9d6b", // 随访正常，预计按时回购
  "预判延期": "#f08c00", // 随访显示减量/延迟/未按时
  "已脱落": "#868e96",   // 随访明确停药/脱落
};

// 名单表列（note = 用户手动填写的跟进备注列，随快照保存）
const LIST_COLS = [
  ["patient_name", "患者"],
  ["phone", "电话"],
  ["physician", "医生"],
  ["product", "品种"],
  ["hospital", "医院"],
  ["pharmacy", "药房"],
  ["last_purchase", "最近购药"],
  ["cycle_days", "周期(天)"],
  ["due_date", "应购药日期"],
  ["days_to_due", "距今天数"],
  ["fu_time", "匹配随访时间"],
  ["fu_type", "随访类型"],
  ["executor", "随访人"],
  ["status", "状态"],
  ["substatus", "下钻"],
  ["fu_signal", "随访信号"],
  ["note", "跟进备注"],
];

const STORE = { sales: [], followups: [], cycles: {}, files: [], seq: 0, notes: {}, subOverrides: {} };
let SNAP_MODE = false;
let SNAP_BASE = null; // 快照全量行基准（不可变，供快照模式筛选；避免 DATA.rows 被覆盖后累积丢失）

// 界面状态
const state = {
  cats: new Set(), subs: new Set(), products: new Set(), hospitals: new Set(), executors: new Set(),
  start: null, end: null, q: "",
  advance: 7,      // 应回购 = 应购药日前 advance 天内
  stdCycle: Object.fromEntries(M.PRODUCT_FAMILIES.map(p => [p.family, p.stdCycle])),
  plainName: false, plainPhone: false, plainDoctor: false,  // false=脱敏显示
  maskMode: "edge",   // 姓名/医生脱敏方式：edge=首尾保留、first=首字保留、all=全部隐藏
  hiddenCols: new Set(),
  page: 1, pageSize: 50,
  // 整体小结：周期（7d=近7天/week=本周/custom=自定义）+ 选中品种 + 未购药原因人工修正
  periodType: "7d", periodStart: "", periodEnd: "",
  selFam: "",
  fuAdj: {},   // { [fam]: { delay: n, dropout_effect: n, dropout_recover: n, dropout_adr: n, dropout_econ: n, dropout_other: n, channel: n, fuFail: n, prolong: n, switch: n } } 仅存用户改过的值
};
let SUMMARY = { text: "" }; // 当前整体小结文本（快照保存用）
let ALL_ROWS = [];          // 全量计算行（小结统计用，不随筛选变化）
let DATA = { rows: [] };
let CURRENT = { summary: null };

const $ = s => document.querySelector(s);

/* ============ 工具 ============ */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
function showLoading(txt) { $("#loadingTxt").textContent = txt || "正在处理…"; $("#loading").classList.remove("hidden"); }
function hideLoading() { $("#loading").classList.add("hidden"); }
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function diffDays(a, b) { // a - b（天）
  return Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);
}
function phoneDigits(v) { return P.phoneDigits(v); }

// 脱敏规则（展示层按 state 开关实时切换；导出/快照与所选脱敏方式保持一致）
// maskMode（state.maskMode）：edge=首尾保留（张*三/欧**德）、first=首字保留（张**/欧***）、all=全部隐藏（***）
// 替换几个字符就有几个 *
function maskPersonName(v, mode) {
  if (!v) return "";
  const s = String(v).trim();
  if (s.length <= 1) return "*";
  if (mode === "all") return "*".repeat(s.length);
  if (mode === "first") return s[0] + "*".repeat(s.length - 1);
  // edge（默认）：保留首尾
  if (s.length === 2) return s[0] + "*";
  return s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
}
function maskName(v) { return maskPersonName(v, state.maskMode); }
function maskPhone(v) {
  if (!v) return "";
  const d = String(v).replace(/\D/g, "");
  return d.length >= 7 ? d.slice(0, 3) + "****" + d.slice(-4) : String(v).replace(/\d/g, "*");
}
function maskDoctor(v) { return maskPersonName(v, state.maskMode); }
// 按当前脱敏开关取展示值
function disp(r, key) {
  if (key === "patient_name") return state.plainName ? (r.patient_name || "") : maskName(r.patient_name);
  if (key === "phone") return state.plainPhone ? (r.phone || "") : maskPhone(r.phone);
  if (key === "physician") return state.plainDoctor ? (r.physician || "") : maskDoctor(r.physician);
  return r[key] == null ? "" : r[key];
}
// 手动备注的存储键（患者 × 品种）
function noteKey(r) { return (r._key || "") + "::" + r.product; }

/* ============ 合并计算（核心） ============ */
// 1) 按患者（电话/姓名）聚合销售记录 → 每患者每品种的购药时间序列
// 2) 应购药日期 = 最近购药日 + 周期（周期表优先，否则标准周期）
// 3) 匹配随访：应购药日前最近一次（同品种优先；无则其他品种；再无则之后最早一条）
// 4) 状态判定（优先级从高到低）：
//    随访异常(停药/减量/延迟/未按时) → 延期/脱落
//    应购日距今 0~advance 天 → 即将回购
//    应购日已过（任何逾期天数） → 延期/脱落
//    上一次应购已完成且已购药 → 已回购
//    其余 → 未到期
function buildRows() {
  const sales = STORE.sales;
  const followups = STORE.followups;
  const cycles = STORE.cycles;

  // ---- 销售按患者聚合 ----
  const patMap = {}; // key: phoneDigits || name
  const keyOf = r => phoneDigits(r.phone) || (r.patient_name || "未知");
  for (const s of sales) {
    if (!s.sales_time || !s.product) continue;
    const k = keyOf(s);
    const p = (patMap[k] = patMap[k] || { name: s.patient_name || "未知", phone: s.phone || "", byProduct: {} });
    if (s.patient_name) p.name = s.patient_name;
    if (s.phone) p.phone = s.phone;
    const fam = s.product;
    const bp = (p.byProduct[fam] = p.byProduct[fam] || { dates: [], hospital: s.hospital || "", pharmacy: s.pharmacy || "", physician: s.physician || "" });
    bp.dates.push(s.sales_time);
    if (s.hospital) bp.hospital = s.hospital;
    if (s.pharmacy) bp.pharmacy = s.pharmacy;
    if (s.physician) bp.physician = s.physician;
  }

  // ---- 随访按患者索引 ----
  const fuByKey = {}; // key -> [fu]
  const fuByName = {};
  for (const fu of followups) {
    const k = phoneDigits(fu.phone);
    const nm = (fu.patient_name || "").trim();
    if (k) (fuByKey[k] = fuByKey[k] || []).push(fu);
    if (nm) (fuByName[nm] = fuByName[nm] || []).push(fu);
  }
  const fuIndex = (name, phone) => {
    const k = phoneDigits(phone);
    const list = (k && fuByKey[k]) || fuByName[name] || [];
    return list;
  };
  const fuDate = fu => P.datePart(fu.exec_time) || P.datePart(fu.plan_time) || null;

  // ---- 逐患者×品种计算 ----
  const rows = [];
  const today = todayStr();
  for (const k in patMap) {
    const p = patMap[k];
    const fus = fuIndex(p.name, p.phone);
    for (const fam in p.byProduct) {
      const bp = p.byProduct[fam];
      if (!bp.dates.length) continue;
      bp.dates.sort();
      const lastPurchase = bp.dates[bp.dates.length - 1];
      const cycle = cycles[p.name] || state.stdCycle[fam] || 30;
      // 已回购判定（统一「近期窗口 N 天」）：最近一次购药日期距今 ≤ N 天
      // N = state.advance，与「应回购 = 应购日前 N 天内」共用同一近期标尺；
      // 不再受应购药日期筛选范围影响（筛选范围仅负责按日期裁剪名单）
      // 应购药日期列显示「预判应购日」= 倒数第二次购药日 + 周期（≥2条记录时），
      // 用于对比实际购药是提前还是延后（需求：已回购行不呈现下次应购时间）
      const inRepurchaseWindow = lastPurchase >= addDays(today, -state.advance) && lastPurchase <= today;
      let expectedDue = null, dueOffset = null;
      if (bp.dates.length >= 2) {
        expectedDue = addDays(bp.dates[bp.dates.length - 2], cycle);
        dueOffset = diffDays(lastPurchase, expectedDue); // 正=延期，负=提前，0=按时
      }
      const dueDate = addDays(lastPurchase, cycle);

      // 匹配随访：优先应购药日前最近一次（同品种；优先「已完成/有执行时间」的真实随访）
      let matched = null;
      if (fus.length) {
        const sameFam = fus.filter(f => f.product === fam);
        let pool = sameFam.length ? sameFam : fus;
        // 优先已执行的随访（有执行时间或任务已完成），避免未执行任务污染匹配
        const executed = pool.filter(f => f.exec_time || (f.task_status && f.task_status.includes("已完成")));
        if (executed.length) pool = executed;
        const withDate = pool.map(f => ({ f, d: fuDate(f) })).filter(x => x.d);
        if (withDate.length) {
          const before = withDate.filter(x => x.d <= dueDate);
          if (before.length) {
            before.sort((a, b) => b.d.localeCompare(a.d)); // 最近一次在前
            matched = before[0].f;
          } else {
            withDate.sort((a, b) => a.d.localeCompare(b.d)); // 之后最早
            matched = withDate[0].f;
          }
        }
      }

      // 状态判定（大类）：
      //  应回购：应购日距今 0~advance 天（优先于「已回购」）
      //  已逾期：应购日已过（任何逾期天数）
      //  已回购：最近购药日期落在「已回购窗口」内（默认距今≤advance，或落在所选日期范围）
      //  未到期：其余情况
      // 应回购患者再按下钻子状态标注：正常状态 / 预判延期 / 已脱落（依据随访内容，用户可点选手动修正）
      const sig = matched ? M.followupSignal(matched) : { signal: "unknown", reason: "" };
      const days = diffDays(dueDate, today); // 正=未来，负=逾期
      let category, substatus = "";
      if (days >= 0 && days <= state.advance) {
        category = "应回购";
        const auto = sig.signal === "dropout" ? "已脱落"
                   : sig.signal === "nonstd" ? "预判延期" : "正常状态";
        const key = k + "::" + fam;
        substatus = STORE.subOverrides[key] || auto; // 用户点选修正优先
      } else if (days < 0) {
        category = "已逾期";
      } else if (inRepurchaseWindow) {
        category = "已回购";
      } else {
        category = "未到期";
      }

      const isRepur = category === "已回购";
      rows.push({
        _key: k, product: fam,
        patient_name: p.name, phone: p.phone, physician: bp.physician,
        hospital: bp.hospital, pharmacy: bp.pharmacy,
        last_purchase: lastPurchase, cycle_days: cycle,
        // 已回购行：due_date 显示「预判应购日」（不呈现下次应购时间）；无预判基准显示空（渲染为 —）
        due_date: isRepur ? (expectedDue || "") : dueDate,
        expected_due: expectedDue || "",
        due_offset: isRepur ? dueOffset : null,   // 已回购行：正=延期/负=提前/0=按时
        purchase_days_ago: isRepur ? Math.max(0, diffDays(today, lastPurchase)) : null, // 最近购药距今
        days_to_due: days,
        repurchased: inRepurchaseWindow,
        fu_time: matched ? (P.datePart(matched.exec_time) || P.datePart(matched.plan_time) || "") : "",
        fu_type: matched ? (matched.summary_type || "") : "",
        executor: matched ? (matched.executor || "") : "",
        fu_note: matched ? (matched.follow_note || "") : "",
        fu_signal: sig.signal === "unknown" ? "" : sig.reason,
        status: category, substatus,
        _matched: matched,
      });
    }
  }

  // 排序：应购药日期落入 [state.start, state.end] 范围的最前（按应购日期升序），
  // 范围外的随后；同一组内应购日期越早越靠前。
  // 已回购行：范围按「最近购药日期」判断，日期取「预判应购日」（无预判基准的空值排最后）。
  const rangeDate = r => (r.status === "已回购" ? (r.last_purchase || "") : r.due_date);
  const inRange = r => {
    if (!state.start && !state.end) return true;
    const d = rangeDate(r);
    if (!d) return false;
    if (state.start && d < state.start) return false;
    if (state.end && d > state.end) return false;
    return true;
  };
  rows.sort((a, b) => {
    const ia = inRange(a) ? 0 : 1, ib = inRange(b) ? 0 : 1;
    if (ia !== ib) return ia - ib;
    const da = a.due_date || "9999-12-31", db = b.due_date || "9999-12-31";
    return da.localeCompare(db);
  });
  return rows;
}

/* ============ 筛选 ============ */
function filterRows(rows) {
  let rs = rows;
  if (state.cats.size) rs = rs.filter(r => state.cats.has(r.status));
  if (state.subs.size) rs = rs.filter(r => r.substatus && state.subs.has(r.substatus));
  if (state.products.size) rs = rs.filter(r => state.products.has(r.product));
  if (state.hospitals.size) rs = rs.filter(r => state.hospitals.has(r.hospital || "未知"));
  if (state.executors.size) rs = rs.filter(r => state.executors.has(r.executor || "未知"));
  // 应购药日期范围：裁剪名单（start/end 有值即生效）。
  // 「已逾期」不受时间窗影响（逾期患者始终保留，便于跟进）；
  // 「已回购」行按「最近购药日期」匹配（其应购药日期列显示预判应购日，不参与范围匹配）；
  // 其余状态按应购药日期（下次应购日）匹配。
  if (state.start || state.end) {
    rs = rs.filter(r => {
      if (r.status === "已逾期") return true;
      const d = r.status === "已回购" ? (r.last_purchase || "") : r.due_date;
      if (!d) return false;
      if (state.start && d < state.start) return false;
      if (state.end && d > state.end) return false;
      return true;
    });
  }
  if (state.q) {
    const ql = state.q.trim().toLowerCase();
    rs = rs.filter(r => {
      for (const f of ["patient_name", "phone", "physician", "hospital", "pharmacy", "product", "executor"]) {
        if (r[f] && String(r[f]).toLowerCase().includes(ql)) return true;
      }
      return false;
    });
  }
  return rs;
}

function buildSummary(rows) {
  const by_status = {}, by_substatus = {}, by_product = {}, by_hospital = {}, by_executor = {}, by_fu_type = {};
  for (const r of rows) {
    by_status[r.status] = (by_status[r.status] || 0) + 1;
    if (r.substatus) by_substatus[r.substatus] = (by_substatus[r.substatus] || 0) + 1;
    by_product[r.product || "未知"] = (by_product[r.product || "未知"] || 0) + 1;
    by_hospital[r.hospital || "未知"] = (by_hospital[r.hospital || "未知"] || 0) + 1;
    by_executor[r.executor || "未知"] = (by_executor[r.executor || "未知"] || 0) + 1;
    by_fu_type[r.fu_type || "无随访"] = (by_fu_type[r.fu_type || "无随访"] || 0) + 1;
  }
  return { total: rows.length, by_status, by_substatus, by_product, by_hospital, by_executor, by_fu_type };
}

/* ============ 渲染 ============ */
function renderSummary(d) {
  let html = `<div class="total"><div class="n">${d.total}</div><div class="l">名单总数</div></div>`;
  for (const s of CATEGORIES) {
    const n = (d.by_status && d.by_status[s]) || 0;
    const active = state.cats.has(s) ? "active" : "";
    const color = CAT_COLOR[s] || "#868e96";
    html += `<div class="card ${active}" data-status="${s}" title="点击筛选「${s}」，再次点击取消" style="border-left:4px solid ${color}">
      <span class="dot" style="background:${color}"></span><div class="n" style="color:${color}">${n}</div><div class="l">${s}</div><span class="cue">点选</span></div>`;
  }
  $("#summary").innerHTML = html;
  document.querySelectorAll("#summary .card").forEach(c => {
    c.onclick = () => {
      const s = c.dataset.status;
      if (state.cats.has(s)) state.cats.delete(s); else state.cats.add(s);
      state.page = 1;
      refresh();
    };
  });
  // 应回购下钻子状态（chips 点选筛选）
  const subBar = $("#substatusBar");
  if ((d.by_substatus && Object.keys(d.by_substatus).length)) {
    subBar.classList.remove("hidden");
    subBar.innerHTML = '<span class="lbl">应回购下钻</span>' + SUBSTATUS.map(k => {
      const n = d.by_substatus[k] || 0;
      if (!n) return "";
      const act = state.subs.has(k) ? "active" : "";
      return `<span class="chip ${act}" data-sub="${k}" style="border-color:${SUB_COLOR[k]}">${k} (${n})</span>`;
    }).join("");
    subBar.querySelectorAll(".chip").forEach(c => c.onclick = () => {
      const k = c.dataset.sub;
      if (state.subs.has(k)) state.subs.delete(k); else state.subs.add(k);
      state.page = 1;
      refresh();
    });
  } else {
    subBar.classList.add("hidden");
  }
  buildMs("prodMs", d.by_product, state.products, "品种");
  buildMs("hospMs", d.by_hospital, state.hospitals, "医院");
  buildMs("execMs", d.by_executor, state.executors, "随访人");
  updateFilterInfo();
}

function buildMs(msId, data, stateSet, label) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const list = $("#" + msId + "List");
  list.innerHTML = entries.map(([k, v]) =>
    `<label><input type="checkbox" value="${esc(k)}" ${stateSet.has(k) ? "checked" : ""}><span>${esc(k)}</span><span class="ms-cnt">${v}</span></label>`).join("");
  list.querySelectorAll("input").forEach(cb => {
    cb.onchange = () => { if (cb.checked) stateSet.add(cb.value); else stateSet.delete(cb.value); state.page = 1; refresh(); };
  });
  const panel = $("#" + msId + "Panel");
  let search = panel.querySelector(".ms-search");
  if (!search) {
    search = document.createElement("input");
    search.className = "ms-search";
    search.placeholder = "输入关键字检索…";
    list.parentNode.insertBefore(search, list);
  }
  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    list.querySelectorAll("label").forEach(lb => {
      const k = lb.querySelector("input").value;
      const hit = !q || k.toLowerCase().includes(q) || stateSet.has(k);
      lb.style.display = hit ? "" : "none";
    });
  };
  search.oninput = applyFilter;
  applyFilter();
  panel.querySelectorAll(".ms-act").forEach(a => a.onclick = () => {
    if (a.dataset.act === "all") entries.forEach(([k]) => stateSet.add(k)); else stateSet.clear();
    state.page = 1; refresh();
  });
  const n = stateSet.size, tot = entries.length;
  const txt = (n === 0 || n === tot) ? "全部" : (n + "项");
  $("#" + msId + "Btn").innerHTML = `${label}：${txt} <span class="ms-caret">▾</span>`;
  $("#" + msId + "Btn").classList.toggle("has-sel", n > 0 && n < tot);
  $("#" + msId + "Count").textContent = n === 0 ? "未选（=全部）" : ("已选 " + n + "/" + tot);
}

function updateFilterInfo() {
  const parts = [];
  if (state.q) parts.push("搜索=" + state.q);
  if (state.cats.size) parts.push("状态=" + [...state.cats].join("/"));
  if (state.subs.size) parts.push("下钻=" + [...state.subs].join("/"));
  if (state.products.size) parts.push("品种=" + state.products.size + "项");
  if (state.hospitals.size) parts.push("医院=" + state.hospitals.size + "项");
  if (state.executors.size) parts.push("随访人=" + state.executors.size + "项");
  if (state.start || state.end) parts.push("应购日期=" + ((state.start || "…") + "~" + (state.end || "…")));
  const plain = [];
  if (state.plainName) plain.push("姓名明文");
  if (state.plainPhone) plain.push("电话明文");
  if (state.plainDoctor) plain.push("医生明文");
  if (plain.length) parts.push("展示:" + plain.join("/"));
  $("#filterInfo").textContent = parts.length ? ("筛选：" + parts.join(" · ")) : "";
}

const visibleCols = () => LIST_COLS.filter(([key]) => !state.hiddenCols.has(key));

function renderTable() {
  const cols = visibleCols();
  const total = DATA.rows.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const rows = DATA.rows.slice(start, start + state.pageSize);
  const inRange = r => {
    if (!state.start && !state.end) return true;
    if (state.start && r.due_date < state.start) return false;
    if (state.end && r.due_date > state.end) return false;
    return true;
  };
  $("#thead").innerHTML = cols.map(([, label]) => `<th>${label}</th>`).join("");
  const tb = $("#tbody");
  if (!total) { tb.innerHTML = ""; $("#empty").classList.remove("hidden"); }
  else {
    $("#empty").classList.add("hidden");
    tb.innerHTML = rows.map((r, i) => rowHtml(r, start + i, inRange(r), cols)).join("");
  }
  // 手动备注列：输入即保存到 STORE.notes（快照时一并保存）
  tb.querySelectorAll("input.note-input").forEach(inp => {
    inp.addEventListener("input", () => { STORE.notes[inp.dataset.key] = inp.value; });
    inp.addEventListener("click", e => e.stopPropagation()); // 不触发行展开
  });
  // 应回购下钻子状态：点击循环切换（正常状态 → 预判延期 → 已脱落 → 正常状态）
  tb.querySelectorAll("span.sub-tag.clickable").forEach(tag => {
    tag.addEventListener("click", e => {
      e.stopPropagation();
      const key = tag.dataset.key;
      const cur = tag.dataset.sub;
      const seq = SUBSTATUS;
      const next = seq[(seq.indexOf(cur) + 1) % seq.length];
      STORE.subOverrides[key] = next;
      state.page = 1;
      refresh();
    });
  });
  tb.querySelectorAll("tr.data-row").forEach(tr => {
    tr.onclick = () => {
      const r = DATA.rows[+tr.dataset.idx];
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("expand-row")) { next.remove(); return; }
      tb.querySelectorAll("tr.expand-row").forEach(x => x.remove());
      tr.insertAdjacentHTML("afterend", expandHtml(r, cols.length));
    };
  });
  renderPagination(total);
  // 表格滚动条回到顶端（不滚动页面，避免用户被带回顶部上传区）
  const tblWrap = document.querySelector(".tbl-wrap");
  if (tblWrap) tblWrap.scrollTop = 0;
}

function rowHtml(r, idx, inRng, cols) {
  const days = r.days_to_due;
  const isRepur = r.status === "已回购";
  // 已回购行：应购药日期列显示「预判应购日」+ 提前/延后标注（无预判基准显示 —）
  let dueTxt = r.due_date || "";
  if (isRepur) {
    if (r.due_offset == null) dueTxt = "<span class=\"muted\">—</span>";
    else if (r.due_offset > 0) dueTxt += `<span class="sub over">延期${r.due_offset}天</span>`;
    else if (r.due_offset < 0) dueTxt += `<span class="sub due">提前${-r.due_offset}天</span>`;
    else dueTxt += `<span class="sub due">按时</span>`;
  } else if (days > 0) dueTxt += `<span class="sub due">还有${days}天</span>`;
  else if (days === 0) dueTxt += `<span class="sub due today">今天</span>`;
  else if (days < 0) dueTxt += `<span class="sub over">逾期${-days}天</span>`;
  // 跟进备注：仅「应回购 / 已逾期」显示填写窗口，其余大类显示 —
  const canNote = r.status === "应回购" || r.status === "已逾期";
  const cells = cols.map(([key]) => {
    if (key === "due_date") return `<td>${dueTxt}</td>`;
    if (key === "days_to_due") {
      if (isRepur) return `<td>${esc(r.purchase_days_ago != null ? "购药" + r.purchase_days_ago + "天前" : "—")}</td>`;
      return `<td>${esc(days === 0 ? "今天" : (days > 0 ? "+" + days : String(days)))}</td>`;
    }
    if (key === "status") {
      const color = CAT_COLOR[r.status] || "#868e96";
      return `<td><span class="tag" style="background:${color}">${esc(r.status)}</span></td>`;
    }
    if (key === "substatus") {
      if (!r.substatus) return `<td><span class="muted">—</span></td>`;
      const color = SUB_COLOR[r.substatus] || "#868e96";
      const note = SNAP_MODE ? "" : "title=\"点击切换下钻状态\"";
      return `<td><span class="tag sub-tag ${note ? "clickable" : ""}" data-key="${esc(noteKey(r))}" data-sub="${esc(r.substatus)}" style="background:${color};cursor:${SNAP_MODE ? "default" : "pointer"}" ${note}>${esc(r.substatus)}</span></td>`;
    }
    if (key === "product") return `<td><span class="tag-prod">${esc(disp(r, key))}</span></td>`;
    if (key === "note") {
      if (!canNote) return `<td><span class="muted">—</span></td>`;
      const k = noteKey(r);
      const v = STORE.notes[k] || "";
      return `<td><input class="note-input" data-key="${esc(k)}" value="${esc(v)}" placeholder="填写跟进备注" ${SNAP_MODE ? "disabled" : ""}></td>`;
    }
    if (key === "fu_type" || key === "fu_signal") return `<td><div class="cell-clip">${esc(disp(r, key))}</div></td>`;
    return `<td>${esc(disp(r, key))}</td>`;
  }).join("");
  return `<tr class="data-row ${inRng ? "in-range" : ""}" data-idx="${idx}">${cells}</tr>`;
}

function expandHtml(r, colspan) {
  const sec = (lbl, val) => val ? `<div class="eb-row"><span class="eb-lbl">${lbl}：</span><span class="eb-val">${esc(val)}</span></div>` : "";
  const fu = r._matched;
  let fuDetail = "";
  if (fu) {
    const rows = [
      ["随访时间", P.datePart(fu.exec_time) || P.datePart(fu.plan_time) || ""],
      ["任务状态", fu.task_status],
      ["服务摘要", fu.summary_type],
      ["执行人", fu.executor],
      ["用药状态", fu.usage_status],
      ["是否按时购药", fu.purchased_on_time],
      ["是否易脱落", fu.is_dropout],
      ["易脱落原因", fu.dropout_reason],
      ["推迟/延迟原因", fu.delay_reason],
      ["停药原因", fu.stop_reason],
      ["用法用量", fu.dosage],
      ["随访小结", fu.follow_note],
    ];
    fuDetail = rows.map(([l, v]) => sec(l, v)).join("");
  }
  // 展开卡：仅随访信息 + 跟进备注（医院/药房/医生/购药等业务字段已在主表展示，不再重复）
  return `<tr class="expand-row"><td colspan="${colspan}"><div class="expand-box">
    ${sec("跟进备注", STORE.notes[noteKey(r)] || "")}
    ${fuDetail || '<div class="eb-row"><span class="eb-lbl">无匹配随访记录</span></div>'}
  </div></td></tr>`;
}

function renderPagination(total) {
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const opts = [50, 100, 200].map(n =>
    `<option value="${n}" ${state.pageSize === n ? "selected" : ""}>${n}</option>`).join("");
  $("#pagination").innerHTML = `
    <span class="pg-info">共 ${total} 条 · 第 ${state.page}/${pages} 页</span>
    <span class="pg-right">
      <span class="pg-size-lbl">每页</span>
      <select id="pageSizeSel" ${SNAP_MODE ? "disabled" : ""}>${opts}</select>
      <span class="pg-size-lbl">条</span>
      <span class="pg-btns">
        <button class="btn ghost sm" id="prevPg" ${state.page <= 1 || SNAP_MODE ? "disabled" : ""}>‹ 上一页</button>
        <button class="btn ghost sm" id="nextPg" ${state.page >= pages || SNAP_MODE ? "disabled" : ""}>下一页 ›</button>
      </span>
    </span>`;
  $("#pageSizeSel").onchange = e => {
    state.pageSize = Math.max(1, parseInt(e.target.value, 10) || 50);
    state.page = 1;
    renderTable();
  };
  // 翻页只滚动表格容器回顶（不 window.scrollTo，避免整页被带回顶部上传区）
  $("#prevPg").onclick = () => { if (state.page > 1) { state.page--; renderTable(); } };
  $("#nextPg").onclick = () => { if (state.page < pages) { state.page++; renderTable(); } };
}

/* ============ 整体小结（按品种分别总结；周期可配置） ============ */
// 当前周期范围（7d=滚动近7天 / week=本周一至今 / custom=自定义）
function getPeriodRange() {
  const today = todayStr();
  if (state.periodType === "custom" && state.periodStart && state.periodEnd) {
    return { start: state.periodStart, end: state.periodEnd };
  }
  if (state.periodType === "week") {
    const dow = (new Date().getDay() + 6) % 7; // 周一=0
    return { start: addDays(today, -dow), end: today };
  }
  return { start: addDays(today, -7), end: today }; // 近7天（滚动）
}

const REASON_KEYS = ["delay", "dropout_effect", "dropout_recover", "dropout_adr", "dropout_econ", "dropout_other", "channel", "fuFail", "prolong", "switch"];
const REASON_LABEL = {
  delay: "延迟用药", dropout_effect: "脱落·效果不佳", dropout_recover: "脱落·自觉好转",
  dropout_adr: "脱落·不良反应", dropout_econ: "脱落·经济", dropout_other: "脱落·其他",
  channel: "转渠道", fuFail: "随访失败未探寻原因", prolong: "医嘱延长", switch: "换药",
};

// 计算某品种在所选周期的小结统计
// 口径：应购药 = 任一次购药记录 + 周期 的应购日落在周期内（含已购药完成的轮次）；
//       实际购药 = 周期内有购药记录的患者；未购药 = 应购药中周期内未购药者。
//       下周预计 = 全量行的下次应购日落在下一周期（按随访信号分正常/推迟）。
function buildSummaryStats(fam) {
  const { start, end } = getPeriodRange();
  const nStart = addDays(end, 1), nEnd = addDays(end, 7); // 下周 = 结束次日 + 7 天
  const inP = (d, s, e) => d && d >= s && d <= e;
  // 按患者×品种聚合购药日期（从销售明细，不依赖行 due_date 的顺延）
  const pat = {}; // key -> { name, phone, dates: [] }
  for (const s of STORE.sales) {
    if (s.product !== fam || !s.sales_time) continue;
    const k = phoneDigits(s.phone) || s.patient_name || "";
    if (!k) continue;
    (pat[k] = pat[k] || { name: s.patient_name || "", phone: s.phone || "", dates: [] }).dates.push(s.sales_time);
  }
  const cycleOf = p => STORE.cycles[p.name || p.phone] || state.stdCycle[fam] || 30;
  const dueKeys = new Set();    // 本周应购患者
  const boughtKeys = new Set(); // 本周实际购药患者
  const notBoughtKeys = [];     // 应购未购
  for (const k in pat) {
    const p = pat[k];
    p.dates.sort();
    const cyc = cycleOf(p);
    const boughtThisWeek = p.dates.some(d => inP(d, start, end));
    if (boughtThisWeek) boughtKeys.add(k);
    const dueThisWeek = p.dates.some(d => inP(addDays(d, cyc), start, end));
    if (dueThisWeek) {
      dueKeys.add(k);
      if (!boughtThisWeek) notBoughtKeys.push(k);
    }
  }
  // 未购药原因：用全量行的最近随访自动判定
  const rowMap = {};
  for (const r of ALL_ROWS) rowMap[r._key + "|" + r.product] = r;
  const cnt = Object.fromEntries(REASON_KEYS.map(k => [k, 0]));
  for (const k of notBoughtKeys) {
    const r = rowMap[k + "|" + fam];
    const c = M.classifyFuReason(r && r._matched);
    if (c && c.key === "dropout") cnt["dropout_" + (c.detail === "效果不佳" ? "effect" : c.detail === "自觉好转" ? "recover" : c.detail === "不良反应" ? "adr" : c.detail === "经济" ? "econ" : "other")]++;
    else if (c && cnt[c.key] != null) cnt[c.key]++;
  }
  // 下周预计复购：应购日落在下周的患者，按随访信号分正常/推迟（脱落不计入复购）
  const nextRows = ALL_ROWS.filter(r => r.product === fam && r.status !== "已回购" && inP(r.due_date, nStart, nEnd));
  let normal = 0, postpone = 0;
  const postponeReasons = new Set();
  for (const r of nextRows) {
    const sig = r._matched ? M.followupSignal(r._matched) : { signal: "unknown", reason: "" };
    if (sig.signal === "nonstd") {
      postpone++;
      const dr = (r._matched && r._matched.delay_reason) || "";
      if (dr) postponeReasons.add(String(dr).slice(0, 30));
    } else if (sig.signal !== "dropout") {
      normal++;
    }
  }
  const dTotal = cnt.dropout_effect + cnt.dropout_recover + cnt.dropout_adr + cnt.dropout_econ + cnt.dropout_other;
  return { start, end, nStart, nEnd, due: dueKeys.size, bought: boughtKeys.size, notBought: notBoughtKeys.length,
    cnt, dTotal, nextTotal: nextRows.length, normal, postpone, postponeReasons: [...postponeReasons] };
}

// 生成小结文案（原因人数优先取用户人工修正值）
function buildSummaryText(fam) {
  const st = buildSummaryStats(fam);
  const adj = state.fuAdj[fam] || {};
  const v = (k, auto) => (adj[k] != null ? adj[k] : auto);
  const dEff = v("dropout_effect", st.cnt.dropout_effect);
  const dRec = v("dropout_recover", st.cnt.dropout_recover);
  const dAdr = v("dropout_adr", st.cnt.dropout_adr);
  const dEco = v("dropout_econ", st.cnt.dropout_econ);
  const dOth = v("dropout_other", st.cnt.dropout_other);
  const dTot = dEff + dRec + dAdr + dEco + dOth;
  const lines = [];
  lines.push(`本周小结（${fam}）：`);
  lines.push(`1. 本周老患者应购药 ${st.due} 人，实际购药 ${st.bought} 人，未购药 ${st.notBought} 人；`);
  lines.push(`2. 未购药原因：①延迟用药${v("delay", st.cnt.delay)}人、②脱落${dTot}人（效果不佳${dEff}/自觉好转${dRec}/不良反应${dAdr}/经济${dEco}/其他${dOth}）、③转渠道${v("channel", st.cnt.channel)}人、④随访失败未探寻原因${v("fuFail", st.cnt.fuFail)}人、⑤医嘱延长${v("prolong", st.cnt.prolong)}人、⑥换药${v("switch", st.cnt.switch)}人；`);
  const pReasons = st.postponeReasons.length ? `（${st.postponeReasons.slice(0, 5).join("、")}）` : "";
  lines.push(`4. 下周预计复购 ${st.normal + st.postpone} 人，预计正常回购 ${st.normal} 人，推迟 ${st.postpone} 人${pReasons}`);
  SUMMARY.text = lines.join("\n");
  return { text: SUMMARY.text, st };
}

// 渲染整体小结面板（周期/品种/文案/原因修正/复制）
function renderSummaryPanel() {
  const panel = $("#summaryPanel");
  if (!panel) return;
  // 快照模式：只读展示保存的小结文本（快照行不含随访对象，不重算）
  if (SNAP_MODE) {
    panel.classList.remove("hidden");
    $("#summaryText").textContent = SUMMARY.text || "（快照未包含小结文本）";
    $("#summaryFamChips").innerHTML = "";
    $("#summaryAdjust").innerHTML = "";
    ["#periodTypeSel", "#periodStart", "#periodEnd"].forEach(id => $(id).disabled = true);
    $("#copySummaryBtn").classList.add("hidden");
    return;
  }
  const fams = [...new Set(ALL_ROWS.map(r => r.product).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh"));
  if (!fams.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  if (!fams.includes(state.selFam)) state.selFam = fams[0];
  // 品种 chips
  $("#summaryFamChips").innerHTML = fams.map(f =>
    `<span class="chip ${f === state.selFam ? "active" : ""}" data-fam="${esc(f)}">${esc(f)}</span>`).join("");
  document.querySelectorAll("#summaryFamChips .chip").forEach(ch => {
    ch.onclick = () => { state.selFam = ch.dataset.fam; renderSummaryPanel(); };
  });
  // 周期控件状态
  $("#periodTypeSel").value = state.periodType;
  const isCustom = state.periodType === "custom";
  $("#periodStart").classList.toggle("hidden", !isCustom);
  $("#periodSep").classList.toggle("hidden", !isCustom);
  $("#periodEnd").classList.toggle("hidden", !isCustom);
  if (state.periodType !== "custom") {
    const { start, end } = getPeriodRange();
    $("#periodStart").value = start; $("#periodEnd").value = end;
  } else {
    $("#periodStart").value = state.periodStart; $("#periodEnd").value = state.periodEnd;
  }
  // 文案 + 原因修正输入
  const { text, st } = buildSummaryText(state.selFam);
  $("#summaryText").textContent = text;
  const adj = state.fuAdj[state.selFam] || {};
  const v = (k, auto) => (adj[k] != null ? adj[k] : auto);
  $("#summaryAdjust").innerHTML =
    `<span class="sa-lbl">未购药原因（自动判定，可修改）：</span>` +
    REASON_KEYS.map(k =>
      `<span class="sa-item" data-k="${k}"><span class="sa-name">${REASON_LABEL[k]}</span>` +
      `<input type="number" class="sa-num" min="0" value="${v(k, st.cnt[k] || 0)}"></span>`).join("");
  document.querySelectorAll("#summaryAdjust .sa-num").forEach(inp => {
    inp.addEventListener("change", () => {
      const item = inp.closest(".sa-item");
      if (!item) return;
      const k = item.dataset.k;
      const n = Math.max(0, parseInt(inp.value, 10) || 0);
      (state.fuAdj[state.selFam] = state.fuAdj[state.selFam] || {})[k] = n;
      renderSummaryPanel();
    });
    if (SNAP_MODE) inp.disabled = true;
  });
  $("#summaryAdjust").classList.toggle("hidden", SNAP_MODE);
  // 复制
  const copyBtn = $("#copySummaryBtn");
  if (SNAP_MODE) copyBtn.classList.add("hidden");
  else copyBtn.classList.remove("hidden");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(SUMMARY.text);
      copyBtn.textContent = "已复制 ✓";
      setTimeout(() => { copyBtn.textContent = "复制小结"; }, 1500);
    } catch (e) {
      prompt("复制失败，请手动复制以下内容：", SUMMARY.text);
    }
  };
  // 周期控件绑定
  $("#periodTypeSel").onchange = e => {
    state.periodType = e.target.value;
    if (state.periodType === "custom" && !state.periodStart) {
      const { start, end } = getPeriodRange();
      state.periodStart = start; state.periodEnd = end;
    }
    renderSummaryPanel();
  };
  $("#periodStart").onchange = e => { state.periodStart = e.target.value; renderSummaryPanel(); };
  $("#periodEnd").onchange = e => { state.periodEnd = e.target.value; renderSummaryPanel(); };
  ["#periodTypeSel", "#periodStart", "#periodEnd"].forEach(id => { if (SNAP_MODE) $(id).disabled = true; });
}

async function refresh() {
  // 快照模式：数据已内嵌在快照行中（STORE 为空），基于不可变的 SNAP_BASE 筛选，不重建、不累积丢失
  const all = SNAP_MODE ? (SNAP_BASE || DATA.rows) : buildRows();
  ALL_ROWS = all;
  CURRENT.summary = buildSummary(all);
  DATA.rows = filterRows(all);
  // 多选面板用「全量」计数（不随筛选遮蔽）
  const full = buildSummary(all);
  $("#summary").innerHTML = "";
  renderSummary(Object.assign({}, CURRENT.summary, {
    by_product: full.by_product, by_hospital: full.by_hospital, by_executor: full.by_executor,
  }));
  renderTable();
  renderSummaryPanel();
}

/* ============ 上传 / 分析（统一上传 → 列表确认/删除 → 开始分析后保留） ============ */
const KIND_LABEL = { sales: "销售", followup: "随访", cycle: "周期", unknown: "未识别" };
// 待分析文件列表：每项 { file, kind }
let pendingFiles = [];

function addPendingFiles(files, kind) {
  let added = 0;
  for (const f of files) {
    if (!pendingFiles.some(p => p.file.name === f.name && p.file.size === f.size)) {
      pendingFiles.push({ file: f, kind });
      added++;
    }
  }
  if (added) renderPendingList();
  return added;
}
function renderPendingList() {
  const list = $("#pendingList");
  if (!pendingFiles.length) {
    list.innerHTML = '<span class="empty-tip">尚未选择文件 —— 点击上方「选择文件」或拖入表格</span>';
  } else {
    list.innerHTML = pendingFiles.map((p, i) =>
      `<span class="file-chip ${p.kind === "unknown" ? "k-unknown" : ""}">${esc(p.file.name)} (${fmtSize(p.file.size)})` +
      `<span class="k-type">${KIND_LABEL[p.kind] || "未识别"}</span>` +
      `<span class="fx" data-idx="${i}" title="移除">×</span></span>`).join("");
  }
  const unknown = pendingFiles.filter(p => p.kind === "unknown").length;
  $("#pendingTotalCount").textContent = pendingFiles.length
    ? `共 ${pendingFiles.length} 个文件${unknown ? ` · ${unknown} 个未识别` : ""}`
    : "";
  $("#startBtn").disabled = pendingFiles.length === 0;
}

// 统一上传：一次选多个文件 → 逐个识别类型 → 加入列表（识别失败标「未识别」）
async function classifyFiles(files) {
  const fileList = Array.from(files || []);
  if (!fileList.length) return;
  showLoading("正在识别文件类型…");
  for (const f of fileList) {
    let kind = "unknown";
    try {
      kind = await P.detectFileType(f);
    } catch (e) {
      console.warn("识别失败", f.name, e);
      kind = "unknown";
    }
    addPendingFiles([f], kind);
  }
  hideLoading();
}

// 绑定统一上传区：整条可点击选择文件（无独立按钮），拖拽亦可
const dropAll = $("#dropAll");
dropAll.onclick = () => $("#allInput").click();
$("#allInput").onchange = e => { if (e.target.files.length) { classifyFiles(e.target.files); e.target.value = ""; } };
["dragover", "dragenter"].forEach(ev => dropAll.addEventListener(ev, e => { e.preventDefault(); dropAll.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => dropAll.addEventListener(ev, e => { e.preventDefault(); dropAll.classList.remove("drag"); }));
dropAll.addEventListener("drop", e => { const f = e.dataTransfer.files; if (f.length) classifyFiles(f); });

// 列表项移除（事件委托）
document.addEventListener("click", e => {
  const fx = e.target.closest ? e.target.closest("#pendingList .fx") : null;
  if (!fx) return;
  pendingFiles.splice(+fx.dataset.idx, 1);
  renderPendingList();
});

$("#clearPendingBtn").onclick = () => {
  pendingFiles = [];
  renderPendingList();
};

// 开始分析：用当前列表全量解析；分析后保留列表与上传窗口，可增删后再次分析
$("#startBtn").onclick = async () => {
  const unknown = pendingFiles.filter(p => p.kind === "unknown");
  if (unknown.length) {
    alert("以下文件未能识别为三类数据（销售/随访/周期），请移除后重试：\n" +
      unknown.map(p => p.file.name).join("\n"));
    return;
  }
  const files = pendingFiles.map(p => p.file);
  if (!files.length) return;
  showLoading("正在解析三张表并归一化计算…");
  $("#startBtn").disabled = true;
  try {
    const res = await P.processFiles(files);
    if (!res.sales.length) { alert("未识别到销售明细数据：请确认上传了含「销售时间/商品名称/会员姓名」列的销售报表。"); return; }
    STORE.sales = res.sales;
    STORE.followups = res.followups;
    STORE.cycles = res.cycles;
    $("#board").classList.remove("hidden");
    $("#dataInfo").textContent =
      `销售明细 ${res.sales.length} 条 · 随访任务 ${res.followups.length} 条 · 用药周期 ${Object.keys(res.cycles).length} 人`;
    // 按数据实际出现的品种动态维护标准周期（内置值优先，新品种默认 30 天）
    const products = [...new Set(res.sales.map(s => s.product).filter(Boolean))];
    ensureStdCycles(products);
    renderCycleInputs();
    // 默认不设应购日期范围（=全部显示）；用户选择范围后表单按范围裁剪
    state.page = 1;
    await refresh();
  } catch (err) {
    alert("分析失败：" + (err && err.message ? err.message : err));
  } finally {
    hideLoading();
    renderPendingList();
  }
};
renderPendingList();

$("#clearAllBtn").onclick = () => {
  if (!confirm("确定清空全部已加载数据？")) return;
  STORE.sales = []; STORE.followups = []; STORE.cycles = {}; STORE.files = []; STORE.notes = {}; STORE.subOverrides = {};
  CURRENT = { summary: null }; DATA = { rows: [] };
  $("#board").classList.add("hidden");
};

/* ============ 筛选交互 ============ */
$("#clearBtn").onclick = () => {
  state.cats.clear(); state.subs.clear(); state.products.clear(); state.hospitals.clear(); state.executors.clear();
  state.start = null; state.end = null;
  state.q = "";
  $("#searchInput").value = ""; $("#startDate").value = ""; $("#endDate").value = "";
  state.page = 1; refresh();
};
$("#startDate").onchange = e => { state.start = e.target.value || null; state.page = 1; refresh(); };
$("#endDate").onchange = e => { state.end = e.target.value || null; state.page = 1; refresh(); };
$("#advanceNum").onchange = e => { state.advance = Math.max(0, parseInt(e.target.value, 10) || 7); refresh(); };
// 标准周期维护（周期表未覆盖患者时使用）
// 标准周期按「数据中出现品种」动态维护：
// 确保每个出现品种都有标准周期 —— 内置品种族用内置值，新品种默认 30 天（用户可在界面修改）
function ensureStdCycles(products) {
  for (const p of M.PRODUCT_FAMILIES) {
    if (state.stdCycle[p.family] == null) state.stdCycle[p.family] = p.stdCycle;
  }
  for (const fam of products) {
    if (state.stdCycle[fam] == null) state.stdCycle[fam] = 30;
  }
}
// 按 state.stdCycle 动态渲染每个品种的周期输入框（可单独修改，即时重算）
function renderCycleInputs() {
  const box = $("#cycleInputs");
  const fams = Object.keys(state.stdCycle).sort((a, b) => a.localeCompare(b, "zh"));
  if (!fams.length) {
    box.innerHTML = '<span class="hint">开始分析后按数据中的品种自动生成</span>';
    return;
  }
  box.innerHTML = fams.map(fam =>
    `<span class="cycle-item" data-fam="${esc(fam)}"><span class="ci-name">${esc(fam)}</span>` +
    `<input type="number" class="ci-num" min="1" max="365" value="${state.stdCycle[fam]}">` +
    `<span class="ci-unit">天</span></span>`).join("");
  box.querySelectorAll(".ci-num").forEach(inp => {
    inp.addEventListener("change", () => {
      const item = inp.closest ? inp.closest(".cycle-item") : null;
      if (!item) return;
      const fam = item.dataset.fam;
      state.stdCycle[fam] = Math.max(1, parseInt(inp.value, 10) || 30);
      refresh();
    });
  });
}
renderCycleInputs();
let searchTimer = null;
$("#searchInput").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; refresh(); }, 350);
});

function closeAllPopovers() {
  document.querySelectorAll(".ms-panel:not(.hidden)").forEach(p => p.classList.add("hidden"));
  $("#colPanel").classList.add("hidden");
}
function togglePanel(panel) {
  const open = !panel.classList.contains("hidden");
  closeAllPopovers();
  if (!open) panel.classList.remove("hidden");
}
$("#prodMsBtn").onclick = e => { e.stopPropagation(); togglePanel($("#prodMsPanel")); };
$("#hospMsBtn").onclick = e => { e.stopPropagation(); togglePanel($("#hospMsPanel")); };
$("#execMsBtn").onclick = e => { e.stopPropagation(); togglePanel($("#execMsPanel")); };
$("#colBtn").onclick = e => {
  e.stopPropagation();
  const p = $("#colPanel");
  const open = !p.classList.contains("hidden");
  closeAllPopovers();
  if (open) return;
  p.innerHTML = LIST_COLS.map(([key, label]) =>
    `<label><input type="checkbox" data-col="${key}" ${state.hiddenCols.has(key) ? "" : "checked"}> ${label}</label>`).join("");
  p.querySelectorAll("input").forEach(cb => cb.onchange = () => {
    if (cb.checked) state.hiddenCols.delete(cb.dataset.col); else state.hiddenCols.add(cb.dataset.col);
    renderTable();
  });
  p.classList.remove("hidden");
};
document.addEventListener("click", e => {
  if (e.target.closest(".ms") || e.target.closest("#colPanel") || e.target.closest("#colBtn")) return;
  closeAllPopovers();
});

// 脱敏开关：姓名 / 电话 / 医生（脱敏=默认，不脱敏=明文）
function bindDesenToggle() {
  document.querySelectorAll(".dt-btn").forEach(b => b.onclick = () => {
    const field = b.dataset.field, mode = b.dataset.mode;
    const plain = (mode === "plain");
    if (field === "name") state.plainName = plain;
    else if (field === "phone") state.plainPhone = plain;
    else if (field === "doctor") state.plainDoctor = plain;
    b.parentElement.querySelectorAll(".dt-btn").forEach(x => x.classList.toggle("active", x === b));
    state.page = 1;
    refresh();
  });
}
bindDesenToggle();
function syncDesenBtns() {
  const map = { name: state.plainName, phone: state.plainPhone, doctor: state.plainDoctor };
  document.querySelectorAll(".dt-btn").forEach(b => {
    const active = (b.dataset.mode === "plain") === !!map[b.dataset.field];
    b.classList.toggle("active", active);
  });
}

// 脱敏方式选择：edge=首尾保留 / first=首字保留 / all=全部隐藏（展示层/导出/快照共用）
function bindMaskMode() {
  document.querySelectorAll(".mm-btn").forEach(b => b.onclick = () => {
    state.maskMode = b.dataset.mm || "edge";
    syncMaskModeBtns();
    state.page = 1;
    refresh();
  });
}
bindMaskMode();
function syncMaskModeBtns() {
  document.querySelectorAll(".mm-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mm === state.maskMode));
}

/* ============ 导出 Excel（当前筛选，带样式：表头加粗、状态/下钻浅色着色、逾期标红） ============ */
// 浅色系导出配色：浅底 + 深字
const EXPORT_CAT_STYLE = {
  "应回购": { fill: "FFFCEBEB", font: "FF791F1F" },
  "已回购": { fill: "FFEAF3DE", font: "FF27500A" },
  "未到期": { fill: "FFE6F1FB", font: "FF0C447C" },
  "已逾期": { fill: "FFFAEEDA", font: "FF633806" },
};
const EXPORT_SUB_STYLE = {
  "正常状态": { fill: "FFEAF3DE", font: "FF27500A" },
  "预判延期": { fill: "FFFAEEDA", font: "FF633806" },
  "已脱落": { fill: "FFF1EFE8", font: "FF444441" },
};

async function doExport(desen) {
  const rows = DATA.rows;
  if (!rows.length) { alert("当前筛选无数据可导出"); return; }
  const header = LIST_COLS.map(([, l]) => l).concat(["随访小结"]);
  // 列索引（用于着色）：状态=status、下钻=substatus、距今天数=days_to_due
  const idxStatus = LIST_COLS.findIndex(([k]) => k === "status");
  const idxSub = LIST_COLS.findIndex(([k]) => k === "substatus");
  const idxDays = LIST_COLS.findIndex(([k]) => k === "days_to_due");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("预计购药名单");
  // 表头：浅蓝底 + 深蓝加粗字
  const hRow = ws.addRow(header);
  hRow.eachCell(c => {
    c.font = { bold: true, color: { argb: "FF0C447C" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F1FB" } };
    c.alignment = { vertical: "middle", horizontal: "center" };
    c.border = { bottom: { style: "thin", color: { argb: "FFB5D4F4" } } };
  });
  // 数据行
  for (const r of rows) {
    const vals = LIST_COLS.map(([k]) => {
      if (k === "note") return STORE.notes[noteKey(r)] || "";
      if (k === "patient_name") return desen ? maskName(r.patient_name) : (r.patient_name || "");
      if (k === "phone") return desen ? maskPhone(r.phone) : (r.phone || "");
      if (k === "physician") return desen ? maskDoctor(r.physician) : (r.physician || "");
      // 已回购行：距今天数列导出「购药N天前」（与展示一致），应购药日期列已是预判应购日
      if (k === "days_to_due" && r.status === "已回购") {
        return r.purchase_days_ago != null ? "购药" + r.purchase_days_ago + "天前" : "";
      }
      return r[k] == null ? "" : r[k];
    });
    vals.push(r.fu_note || "");
    const row = ws.addRow(vals);
    // 状态列：浅色填充 + 深色字
    const st = EXPORT_CAT_STYLE[r.status];
    if (idxStatus >= 0 && st) {
      row.getCell(idxStatus + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: st.fill } };
      row.getCell(idxStatus + 1).font = { bold: true, color: { argb: st.font } };
    }
    // 下钻列：浅色填充 + 深色字（仅应回购有值）
    const sb = r.substatus ? EXPORT_SUB_STYLE[r.substatus] : null;
    if (idxSub >= 0 && sb) {
      row.getCell(idxSub + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: sb.fill } };
      row.getCell(idxSub + 1).font = { color: { argb: sb.font } };
    }
    // 距今天数：逾期标红加粗
    if (idxDays >= 0 && typeof r.days_to_due === "number" && r.days_to_due < 0) {
      row.getCell(idxDays + 1).font = { bold: true, color: { argb: "FFE03131" } };
    }
  }
  // 列宽（17 个 LIST_COLS 列 + 随访小结）
  const widths = [10, 14, 10, 10, 22, 18, 12, 10, 12, 10, 14, 18, 10, 10, 10, 24, 22, 40];
  ws.columns.forEach((c, i) => { c.width = widths[i] || 12; });
  // 冻结首行
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    desen ? "预计购药名单_脱敏.xlsx" : "预计购药名单_未脱敏.xlsx");
}
$("#exportDesenBtn").onclick = () => doExport(true);
$("#exportPlainBtn").onclick = () => {
  const ok = confirm(
    "⚠️ 隐私风险提示\n\n「未脱敏导出」包含明文姓名、电话、医生等个人敏感信息。\n仅可分享给可信的团队成员，切勿通过外部渠道转发。\n\n确定导出？"
  );
  if (ok) doExport(false);
};

/* ============ 快照生成（自包含 HTML） ============ */
async function doSnapshot(desen) {
  if (!DATA.rows.length) { alert("当前筛选无数据可生成快照"); return; }
  showLoading(desen ? "正在生成脱敏快照…" : "正在生成不脱敏快照…");
  try {
    const rows = DATA.rows.map(r => {
      const c = Object.assign({}, r);
      delete c._matched; delete c._row_id;
      if (desen) {
        c.patient_name = maskName(c.patient_name);
        c.phone = maskPhone(c.phone);
        c.physician = maskDoctor(c.physician);
      }
      return c;
    });
    const snap = {
      desen, rows, notes: STORE.notes, subOverrides: STORE.subOverrides,
      summary: CURRENT.summary, state: {
        advance: state.advance, stdCycle: state.stdCycle, pageSize: state.pageSize,
        start: state.start, end: state.end, q: state.q,
        cats: [...state.cats], subs: [...state.subs],
        products: [...state.products],
        hospitals: [...state.hospitals], executors: [...state.executors],
        plainName: state.plainName, plainPhone: state.plainPhone, plainDoctor: state.plainDoctor,
        maskMode: state.maskMode,
        hiddenCols: [...state.hiddenCols],
        periodType: state.periodType, periodStart: state.periodStart, periodEnd: state.periodEnd,
        selFam: state.selFam, fuAdj: state.fuAdj,
      },
      summaryText: SUMMARY.text,
      buildAt: new Date().toISOString(),
      note: "预计购药分析快照",
    };
    const dataJson = JSON.stringify(snap).replace(/</g, "\\u003c");
    const dataScript = `<\script>window.__SNAP__=${dataJson};<\/script>`;
    const bootstrap = `<\script>(function(){
      if(window.__SNAP__&&window.AppCore){window.AppCore.loadSnapshot(window.__SNAP__);}
      else{var ld=document.getElementById('loading');if(ld){ld.querySelector('.txt').textContent='快照加载失败：脚本未内联。请用 index.html 生成快照。';ld.classList.remove('hidden');}}
    })();<\/script>`;
    let html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
    // 快照为只读视图，剥离库代码（兼容两种形态：外链 src 标签 / 单文件版内联 id 标记块），
    // 避免 file:// 下加载失败或快照体积膨胀
    html = html.replace(/<script[^>]*src="vendor\/xlsx\.full\.min\.js"[^>]*><\/script>/gi, "");
    html = html.replace(/<script[^>]*src="vendor\/exceljs\.min\.js"[^>]*><\/script>/gi, "");
    html = html.replace(/<script id="__vnd_xlsx__"[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<script id="__vnd_exceljs__"[\s\S]*?<\/script>/gi, "");
    const bodyIdx = html.lastIndexOf("</body>");
    html = html.slice(0, bodyIdx) + dataScript + bootstrap + "\n" + html.slice(bodyIdx);
    download(new Blob([html], { type: "text/html" }),
      desen ? "预计购药名单_脱敏快照.html" : "预计购药名单_不脱敏快照.html");
  } catch (err) {
    alert("快照生成失败：" + (err && err.message ? err.message : err));
  } finally {
    hideLoading();
  }
}
$("#snapshotDesenBtn").onclick = () => doSnapshot(true);
$("#snapshotPlainBtn").onclick = () => {
  const ok = confirm(
    "⚠️ 隐私风险提示\n\n「未脱敏快照」包含明文姓名、电话、医生等个人敏感信息。\n仅可分享给可信的团队成员，切勿通过外部渠道转发。\n\n如仅需对外分享，请改用「脱敏快照」。\n\n确定生成未脱敏快照吗？"
  );
  if (ok) doSnapshot(false);
};

/* ============ 快照打开模式 ============ */
function loadSnapshot(snap) {
  hideLoading();
  SNAP_MODE = true;
  SNAP_BASE = (snap.rows || []).map(r => Object.assign({}, r));
  DATA.rows = SNAP_BASE.slice();
  CURRENT.summary = snap.summary || buildSummary(DATA.rows);
  STORE.notes = snap.notes || {};
  STORE.subOverrides = snap.subOverrides || {};
  const s = snap.state || {};
  state.advance = s.advance != null ? s.advance : 7;
  state.pageSize = s.pageSize || 50;
  state.page = 1;
  if (s.stdCycle) state.stdCycle = s.stdCycle;
  renderCycleInputs();
  state.start = s.start || null; state.end = s.end || null;
  state.q = s.q || "";
  state.cats = new Set(s.cats || []);
  state.subs = new Set(s.subs || []);
  state.products = new Set(s.products || []);
  state.hospitals = new Set(s.hospitals || []);
  state.executors = new Set(s.executors || []);
  state.plainName = !!s.plainName; state.plainPhone = !!s.plainPhone; state.plainDoctor = !!s.plainDoctor;
  state.maskMode = s.maskMode || "edge";
  if (s.hiddenCols) state.hiddenCols = new Set(s.hiddenCols);
  // 整体小结状态恢复（快照中只读展示保存的小结文本）
  state.periodType = s.periodType || "7d";
  state.periodStart = s.periodStart || ""; state.periodEnd = s.periodEnd || "";
  state.selFam = s.selFam || "";
  state.fuAdj = s.fuAdj || {};
  SUMMARY.text = snap.summaryText || "";
  // 上传区隐藏
  ["#dropAll", "#pendingPanel"].forEach(id => $(id).classList.add("hidden"));
  $("#snapBanner").classList.remove("hidden");
  $("#snapBanner").textContent = snap.desen
    ? "📄 这是一份脱敏快照：姓名、电话、医生已按所选方式脱敏，文件中不含任何明文个人信息，可安全分享。"
    : "⚠️ 这是一份「不脱敏」快照：包含明文姓名、电话、医生等个人信息，仅可分享给可信接收方。";
  const fb = document.querySelector(".filebar"); if (fb) fb.classList.add("hidden");
  ["#exportDesenBtn", "#exportPlainBtn", "#snapshotDesenBtn", "#snapshotPlainBtn", "#clearAllBtn"].forEach(sl => $(sl).classList.add("hidden"));
  ["#advanceNum", "#startDate", "#endDate", "#clearBtn"].forEach(id => $(id).disabled = true);
  document.querySelectorAll("#cycleInputs .ci-num").forEach(inp => inp.disabled = true);
  document.querySelectorAll(".mm-btn").forEach(b => b.disabled = true);
  $("#dataInfo").textContent = `快照 · 生成于 ${new Date(snap.buildAt).toLocaleString("zh-CN")}`;
  $("#board").classList.remove("hidden");
  syncDesenBtns();
  syncMaskModeBtns();
  const full = buildSummary(DATA.rows);
  renderSummary(Object.assign({}, CURRENT.summary, {
    by_product: full.by_product, by_hospital: full.by_hospital, by_executor: full.by_executor,
  }));
  renderTable();
  // 快照模式：小结只读展示保存的文本（渲染面板会自动隐藏控制/修正区）
  renderSummaryPanel();
}

window.AppCore = { loadSnapshot, buildRows, filterRows, buildSummary, doExport, STORE, state, DATA, refresh, ensureStdCycles, renderCycleInputs, renderTable, renderPagination, getPeriodRange, buildSummaryStats, buildSummaryText, renderSummaryPanel, classifyFuReason: M.classifyFuReason };
})();
