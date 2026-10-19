// 三表解析与归一化 pipeline（浏览器端）
// 用 SheetJS 解析 Excel，按表类型（销售明细/随访任务/患者用药周期）归一化。
// 无 DOM 依赖（XLSX 为全局变量）。

(function () {
const M = (typeof window !== "undefined" ? window : globalThis).Mapping;
const XLSX = (typeof window !== "undefined" ? window : globalThis).XLSX;

function normHeader(h) { return M.normHeader(h); }

function asList(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtDateTime(d) {
  const Y = d.getFullYear(), Mo = pad2(d.getMonth() + 1), D = pad2(d.getDate());
  const h = pad2(d.getHours()), mi = pad2(d.getMinutes()), s = pad2(d.getSeconds());
  const date = `${Y}-${Mo}-${D}`;
  return (h === "00" && mi === "00" && s === "00") ? date : `${date} ${h}:${mi}:${s}`;
}

// 单元格 → 字符串（Date 保留时分；Excel 日期序列号 → 日期字符串）
function cellStr(v) {
  if (v == null) return null;
  if (v instanceof Date) return fmtDateTime(v);
  if (typeof v === "number") {
    // Excel 序列号（1900 日期系统，基准 1899-12-30）≈ 20000~80000
    if (v > 20000 && v < 80000) {
      const ms = Math.round((v - 25569) * 86400000); // 25569 = 1970-01-01 的序列号
      return fmtDateTime(new Date(ms));
    }
    if (Number.isNaN(v)) return null;
  }
  const s = String(v).trim();
  if (s === "" || s === "nan" || s === "NaN" || s === "None") return null;
  return s;
}
function cellStrSafe(v) { return cellStr(v) == null ? "" : cellStr(v); }

// 日期字段统一取 YYYY-MM-DD
function datePart(v) {
  const s = cellStr(v);
  if (!s) return null;
  const m = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
}

// 单值字段关键字映射（只取本表相关字段）
function mapColumns(tableType, rawCols) {
  const rules = M.KEYWORD_RULES;
  const assigned = {};
  const used = new Set();
  // 各表生效的字段前缀
  const FOLLOWUP_FIELDS = ["task_status", "summary_type", "executor", "follow_note", "cancel_reason",
    "create_time", "plan_time", "exec_time", "task_no", "patient_id", "is_key", "reason_label", "callback_note"];
  let prefix;
  if (tableType === "sales") prefix = f => !f.startsWith("f_") && !f.startsWith("c_");
  else if (tableType === "followup") prefix = f => f.startsWith("f_") || FOLLOWUP_FIELDS.includes(f);
  else prefix = f => f === "c_patient_name" || f === "cycle_days";

  const candList = rawCols.map((rc, idx) => [idx, normHeader(rc)]);
  // 命中计数：精确字段（EXACT_ONLY_FIELDS，如 hospital）要求列名完全相等，
  // 其余字段沿用宽松子串包含
  const hitsOf = (field, nc) => {
    let h = 0;
    for (const kw of rules.find(r => r[0] === field)[1]) if (M.kwHit(field, nc, kw)) h++;
    return h;
  };
  for (const [field, kws] of rules) {
    if (!prefix(field)) continue;
    if (field === "exec_time") {
      // 执行时间 vs 计划执行时间：排除含「计划」的列
      // 注意：candList 的 key 是 idx，这里需要重新按 idx 过滤
      const cand = candList.filter(([idx]) => !used.has(idx) && !normHeader(rawCols[idx]).includes("计划") && normHeader(rawCols[idx]).includes("执行时间"));
      let best = null, bestHits = 0;
      for (const [idx, nc] of cand) {
        const hits = hitsOf(field, nc);
        if (hits > 0 && hits > bestHits) { bestHits = hits; best = idx; }
      }
      if (best !== null) { assigned[field] = best; used.add(best); }
      continue;
    }
    let best = null, bestHits = 0;
    for (const [idx, nc] of candList) {
      if (used.has(idx)) continue;
      const hits = hitsOf(field, nc);
      if (hits > 0 && hits > bestHits) { bestHits = hits; best = idx; }
    }
    if (best !== null) { assigned[field] = best; used.add(best); }
  }
  // 多值字段（仅随访表）：收集所有命中列
  if (tableType === "followup") {
    for (const [field, kws] of M.KEYWORD_RULES_MULTI) {
      const cols = [];
      candList.forEach(([idx, nc]) => {
        if (!used.has(idx) && kws.some(kw => nc.includes(kw))) cols.push(idx);
      });
      if (cols.length) { assigned[field] = cols; cols.forEach(i => used.add(i)); }
    }
  }
  return assigned;
}

// 在原始数组的前 maxScan 行中找最像表头的一行
function detectHeaderRow(aoaStr, maxScan = 15) {
  if (!aoaStr || !aoaStr.length) return 0;
  const kwPools = [];
  for (const [, kws] of M.KEYWORD_RULES) kwPools.push(...kws);
  for (const [, kws] of M.KEYWORD_RULES_MULTI) kwPools.push(...kws);
  const kwLower = kwPools.map(k => k.toLowerCase());
  let bestRow = 0, bestScore = -1;
  const scan = Math.min(maxScan, aoaStr.length);
  for (let i = 0; i < scan; i++) {
    const row = aoaStr[i];
    const cells = row.map(c => String(c == null ? "" : c).trim())
      .filter(c => c !== "" && c !== "nan" && c !== "None");
    if (!cells.length) continue;
    let hit = 0;
    for (const c of cells) {
      const cl = c.toLowerCase();
      if (kwLower.some(kw => cl.includes(kw))) hit++;
    }
    const ratio = cells.length / Math.max(1, row.length);
    const score = hit * 3 + ratio * 2;
    if (score > bestScore) { bestScore = score; bestRow = i; }
  }
  return bestRow;
}

function rowToObj(cols, r) {
  const o = {};
  for (let i = 0; i < r.length; i++) o[i] = cellStr(r[i]);
  return o;
}

function _gtext(row, colmap, field) {
  const c = colmap[field];
  if (c == null) return "";
  const idxs = Array.isArray(c) ? c : [c];
  const vals = [], seen = new Set();
  for (const i of idxs) {
    const v = row[i];
    if (v && !seen.has(v)) { seen.add(v); vals.push(v); }
  }
  return vals.join("\n") || "";
}

// ---------- 销售明细归一化 ----------
function normalizeSales(row, colmap, sourceFile, sheetName, i) {
  const rec = {
    source: "sales", _row_id: `${sourceFile}::sales::${sheetName}::${i}`,
    sales_time: datePart(_gtext(row, colmap, "sales_time")) || _gtext(row, colmap, "sales_time"),
    // 小票号：仅用于跨文件自动去重（dedupSales），不参与任何业务计算、不进列表、不进导出。
    ticket_no: _gtext(row, colmap, "ticket_no") || null,
    order_status: _gtext(row, colmap, "order_status") || null,
    product_raw: _gtext(row, colmap, "product") || null,
    product: M.normalizeProduct(_gtext(row, colmap, "product")) || null,
    qty: _gtext(row, colmap, "qty") || null,
    amount: _gtext(row, colmap, "amount") || null,
    member_id: _gtext(row, colmap, "member_id") || null,
    patient_name: _gtext(row, colmap, "patient_name") || null,
    phone: _gtext(row, colmap, "phone") || null,
    hospital: _gtext(row, colmap, "hospital") || null,
    pharmacy: _gtext(row, colmap, "pharmacy") || null,
    physician: _gtext(row, colmap, "physician") || null,
    department: _gtext(row, colmap, "department") || null,
    indication: _gtext(row, colmap, "indication") || null,
    age: _gtext(row, colmap, "age") || null,
    gender: _gtext(row, colmap, "gender") || null,
  };
  return rec;
}

// ---------- 随访任务归一化 ----------
function normalizeFollowup(row, colmap, sourceFile, sheetName, i) {
  const multi = f => _gtext(row, colmap, f) || null;
  const rec = {
    source: "followup", _row_id: `${sourceFile}::followup::${sheetName}::${i}`,
    task_status: _gtext(row, colmap, "task_status") || null,
    patient_name: _gtext(row, colmap, "f_patient_name") || null,
    is_key: _gtext(row, colmap, "is_key") || null,
    patient_id: _gtext(row, colmap, "patient_id") || null,
    phone: _gtext(row, colmap, "f_phone") || null,
    plan_time: _gtext(row, colmap, "plan_time") || null,
    exec_time: _gtext(row, colmap, "exec_time") || null,
    product_raw: _gtext(row, colmap, "f_product") || null,
    product: M.normalizeProduct(_gtext(row, colmap, "f_product")) || null,
    indication: _gtext(row, colmap, "f_indication") || null,
    task_no: _gtext(row, colmap, "task_no") || null,
    summary_type: _gtext(row, colmap, "summary_type") || null,
    create_time: _gtext(row, colmap, "create_time") || null,
    executor: _gtext(row, colmap, "executor") || null,
    cancel_reason: _gtext(row, colmap, "cancel_reason") || null,
    follow_note: _gtext(row, colmap, "follow_note") || null,
    reason_label: _gtext(row, colmap, "reason_label") || null, // 回传表专用：人工选定的未购药原因分类标签
    callback_note: _gtext(row, colmap, "callback_note") || null, // 回传表专用：用户在「跟进备注」列填写的内容
    usage_status: multi("usage_status"),
    purchased_on_time: multi("purchased_on_time"),
    is_dropout: multi("is_dropout"),
    dropout_reason: multi("dropout_reason"),
    still_using: multi("still_using"),
    near_usage: multi("near_usage"),
    delay_reason: multi("delay_reason"),
    stop_reason: multi("stop_reason"),
    dosage: multi("dosage"),
  };
  return rec;
}

// ---------- 用药周期表归一化 ----------
function normalizeCycle(row, colmap, sourceFile, sheetName, i) {
  const name = (_gtext(row, colmap, "c_patient_name") || "").trim();
  const days = (_gtext(row, colmap, "cycle_days") || "").trim();
  const n = parseInt(days, 10);
  return {
    source: "cycle", _row_id: `${sourceFile}::cycle::${sheetName}::${i}`,
    patient_name: name || null,
    cycle_days: (Number.isFinite(n) && n > 0) ? n : null,
    cycle_raw: days || null,
  };
}

function normalizeSheet(tableType, rows, cols, sourceFile, sheetName) {
  const colmap = mapColumns(tableType, cols);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (tableType === "sales") out.push(normalizeSales(row, colmap, sourceFile, sheetName, i));
    else if (tableType === "followup") out.push(normalizeFollowup(row, colmap, sourceFile, sheetName, i));
    else out.push(normalizeCycle(row, colmap, sourceFile, sheetName, i));
  }
  return out;
}

async function loadWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
  const out = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, cellDates: true });
    const aoaStr = aoa.map(r => r.map(cellStrSafe));
    const hr = detectHeaderRow(aoaStr);
    let cols, rows;
    if (hr === 0) {
      cols = aoa[0].map((c, i) => String(c == null ? "" : c).trim() || `col_${i}`);
      rows = aoa.slice(1).map(r => rowToObj(cols, r));
    } else {
      cols = aoa[hr].map((c, i) => String(c == null ? "" : c).trim() || `col_${i}`);
      rows = aoa.slice(hr + 1).map(r => rowToObj(cols, r));
    }
    // 跳过全空行
    rows = rows.filter(r => Object.values(r).some(v => v != null && String(v).trim() !== ""));
    const ttype = M.detectTableType(cols);
    out.push({ source_file: file.name, sheet_name: name, ttype, cols, rows });
  }
  return out;
}

async function processFiles(files) {
  const result = { sales: [], followups: [], cycles: {} };
  for (const f of files) {
    try {
      const sheets = await loadWorkbook(f);
      for (const sh of sheets) {
        if (sh.ttype === "unknown") {
          console.warn("无法识别表类型:", sh.source_file, sh.sheet_name, sh.cols.slice(0, 10));
          continue;
        }
        if (sh.ttype === "cycle") {
          // 周期表：合并成 {患者名: 周期天数}
          for (const rec of normalizeSheet("cycle", sh.rows, sh.cols, sh.source_file, sh.sheet_name)) {
            if (rec.patient_name && rec.cycle_days) result.cycles[rec.patient_name] = rec.cycle_days;
          }
        } else {
          const recs = normalizeSheet(sh.ttype, sh.rows, sh.cols, sh.source_file, sh.sheet_name);
          if (sh.ttype === "sales") result.sales.push(...recs);
          else result.followups.push(...recs);
        }
      }
    } catch (e) {
      console.warn("处理文件失败", f.name, e);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 销售明细跨文件自动去重
// ---------------------------------------------------------------------------
// 场景：用户反复上传同一批（或有重叠的）销售明细，同一个业务事实被记了多遍。
// 实测本机 33 份真实销售明细、73,483 行：重复组 21,472 个，其中 **96.5% 是跨文件重复**，
// 可删 26,189 行（35.64%）—— 正是「同一批数据被多次上传」的典型形态。
//
// 去重键 = 小票号 + 销售时间 + 商品名称 + 门店 + 销售数量（已与用户确认的口径）
//   · 小票号是主凭据：同一张小票下同一商品可以有多个计价批次（如数量 2 与 3 分两行），
//     这些是**真实的多行**而非重复 —— 只按「小票号+时间+商品+门店」去重会误删它们，
//     故必须并入「销售数量」。
//   · 门店取自现有的 pharmacy（药房名称）字段，与列表「药房」列同源，不新增独立列——
//     真实数据里没有独立的「门店」列，新增映射会一直取空、等于不参与去重。
//
// 保留优先（同一键保留哪一行）：信息更全 > 归属更明确 > 文件中位置更早。
//   · 信息更全 = 非空字段更多（同一交易在不同导出里可能有的列有值、有的空）；
//   · 归属更明确 = 有会员号 > 只有姓名，因为患者身份键是「姓名+电话」，会员号在导出里更稳定；
//   · 最后用 _row_id 兜底排序，保证**结果与上传顺序无关**（同一批文件任意顺序上传，去重结果一致）。
//
// 无小票号的行一律保留（宁可不删也不错删）—— 但实测真实数据小票号行级填充率是 100%。
function salesDedupKey(r) {
  const ticket = (r.ticket_no == null ? "" : String(r.ticket_no)).trim();
  if (!ticket) return null; // 无小票号 → 不参与去重
  return [
    ticket,
    r.sales_time == null ? "" : String(r.sales_time),
    r.product_raw == null ? "" : String(r.product_raw),
    r.pharmacy == null ? "" : String(r.pharmacy),
    r.qty == null ? "" : String(r.qty),
  ].join("\u0001"); // 分隔符用 \u0001 而非 \u0000：\u0000 在本项目里已是 patientKey 的分隔符，避免混淆
}

function _nonEmptyCount(rec) {
  let n = 0;
  for (const k of Object.keys(rec)) {
    if (k === "source" || k === "_row_id") continue;
    const v = rec[k];
    if (v != null && String(v).trim() !== "") n++;
  }
  return n;
}

// 返回 { records, removed, groups, removedRows, total, keptNoTicket }
//   records    —— 去重后的记录，**保持原顺序**（被保留的行停在它原本的位置上）
//   removed    —— 被移除的记录数组（供界面展示详情）
//   groups     —— 重复组数
//   removedRows—— 被移除的行数（= removed.length）
//   total      —— 传入的总行数
//   keptNoTicket —— 因无小票号而未参与去重的行数
function dedupSales(records) {
  const rows = Array.isArray(records) ? records : [];
  const groups = new Map();
  const slots = []; // 与 rows 等长；重复组只在组内**第一次出现**的位置放 holder，其余位置为 null
  let keptNoTicket = 0;

  for (const r of rows) {
    const k = salesDedupKey(r);
    if (k == null) { slots.push(null); keptNoTicket++; continue; } // 无小票号 → 不参与去重
    const g = groups.get(k);
    if (!g) {
      groups.set(k, { key: k, best: r, count: 1 });
      slots.push(r);              // 该键第一次出现 → 原位保留
    } else {
      g.count++;
      if (_betterSalesRow(r, g.best)) g.best = r;
      slots.push(null);           // 重复出现 → 该位置空出
    }
  }

  const records2 = [], removed = [];
  let dupGroupCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (slots[i] === null) {
      // 无小票号的行 slots[i] 也是 null，但那些行必须保留 —— 用 groups 是否含其键来区分
      const k = salesDedupKey(r);
      if (k == null) records2.push(r);          // 无小票号：保留
      else removed.push(r);                      // 有键且非首次出现：移除
      continue;
    }
    // 该键首次出现的位置：若组内有多行，用 best 顶替（可能不是本行本身）
    const k = salesDedupKey(r);
    const g = groups.get(k);
    records2.push(g.best);
    if (g.count > 1) dupGroupCount++;
  }

  return {
    records: records2,
    removed,
    groups: dupGroupCount,
    removedRows: removed.length,
    total: rows.length,
    keptNoTicket,
  };
}

// 同一去重键的多行里，判断 a 是否比 b 更该保留
function _betterSalesRow(a, b) {
  // 1) 非空字段更多者优先（信息更全）
  const na = _nonEmptyCount(a), nb = _nonEmptyCount(b);
  if (na !== nb) return na > nb;
  // 2) 有会员号者优先（患者身份键依赖会员号/电话，导出更稳定）
  const ma = a.member_id ? 1 : 0, mb = b.member_id ? 1 : 0;
  if (ma !== mb) return ma > mb;
  // 3) 有电话者优先
  const pa = a.phone ? 1 : 0, pb = b.phone ? 1 : 0;
  if (pa !== pb) return pa > pb;
  // 4) _row_id 字典序兜底 —— 保证与上传顺序无关（结果可复现）
  return String(a._row_id || "") < String(b._row_id || "");
}

// 快速识别单个 Excel 文件的表类型（销售/随访/周期）。
// 用 sheetRows 只读前 20 行做表头判定，避免全量解析大文件。
async function detectFileType(file) {
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true, sheetRows: 20 });
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, cellDates: true });
      const aoaStr = aoa.map(r => r.map(cellStrSafe));
      const hr = detectHeaderRow(aoaStr);
      const cols = (aoa[hr] || []).map((c, i) => String(c == null ? "" : c).trim() || `col_${i}`);
      const ttype = M.detectTableType(cols);
      if (ttype !== "unknown") return ttype;
    }
    return "unknown";
  } catch (e) {
    console.warn("识别文件类型失败", file.name, e);
    return "unknown";
  }
}

// 电话归一化：仅数字（跨表匹配用）
function phoneDigits(v) {
  if (!v) return "";
  return String(v).replace(/\D/g, "");
}

// 患者唯一键：**姓名 + 电话**（两者都参与，缺一不可）
// 为什么不能只用一个字段：
//   · 只用电话 → 同一号码被不同姓名共用（家人共用号码 / 前台代留）时，两个不同患者会被合并成一个；
//   · 只用姓名 → 重名（同名不同电话）时，两个不同患者会被合并成一个。
// 两者都空时退化为「未知\u0000」——此时数据里确实没有可区分的信息，只能当作同一条记录。
// 分隔符用 \u0000：姓名与电话归一化后都不可能含它，不会与真实取值碰撞。
function patientKey(name, phone) {
  const n = String(name == null ? "" : name).trim() || "未知";
  return n + "\u0000" + phoneDigits(phone);
}

// 脱敏姓名 / 电话 / 医生
// 姓名/医生脱敏方式 maskMode：edge=首尾保留（张*三/欧**德）、first=首字保留（张**/欧***）、all=全部隐藏（***）
// 替换几个字符就有几个 *
function maskPersonName(v, mode) {
  if (!v) return "";
  const s = String(v).trim();
  if (s.length <= 1) return "*";
  if (mode === "all") return "*".repeat(s.length);
  if (mode === "first") return s[0] + "*".repeat(s.length - 1);
  if (s.length === 2) return s[0] + "*";
  return s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
}
function desensitize(rec, namePlain = false, phonePlain = false, doctorPlain = false, maskMode = "edge") {
  const out = Object.assign({}, rec);
  const name = out.patient_name;
  if (name && !namePlain) {
    out.patient_name = maskPersonName(name, maskMode);
  }
  const phone = out.phone;
  if (phone && !phonePlain) {
    const s = String(phone);
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 7) out.phone = digits.slice(0, 3) + "****" + digits.slice(-4);
    else out.phone = s.replace(/\d/g, "*");
  }
  const doctor = out.physician;
  if (doctor && !doctorPlain) {
    out.physician = maskPersonName(doctor, maskMode);
  }
  return out;
}

/* ============================================================
 * 本地留档（OPFS）—— 「下次不用重新上传」
 * ============================================================
 * 存什么：**只存销售明细**（按品种分目录）。
 *   - 随访 / 周期是「患者维度、非品种维度」，且带有时效性（本次结论优先），故不留档、只用本次上传的。
 *   - 销售明细是「品种维度」，按品种切分天然对齐；且回购预测最依赖完整购药史，留档价值最高。
 *
 * 目录结构：<root>/留档/销售/<品种>/sales.json
 *   每个文件 = { version, product, updated_at, records: [...] }
 *
 * 为什么用 OPFS 而不是让用户选真实文件夹：
 *   - OPFS 读写零授权弹窗，用户体验最省事；实测建目录/写/读回均可用，配额约 10 GB。
 *   - 我们不要求「拿到原始 Excel 文件」（留档目的只是免重传），因此不需要真实磁盘路径。
 *   - 患者数据落在浏览器沙箱内，比散落到磁盘明文目录更合规。
 *
 * ⚠️ 数据可能被浏览器回收：实测本环境 storage.persist() 返回 false，
 *    意味着这些数据属 best-effort，磁盘紧张时浏览器有权清理。
 *    → 因此所有读取操作在失败/缺失时**一律静默降级为「无历史」**（返回空），绝不抛错吓用户。
 *
 * ⚠️ 存储按「源(origin)」隔离：file:// 打开与 https:// 打开是两套独立存储，互不连通。
 */

const OPFS_AVAILABLE = (() => {
  try {
    return typeof navigator !== "undefined" && !!navigator.storage
      && typeof navigator.storage.getDirectory === "function";
  } catch (e) { return false; }
})();

// 品种名做目录名需要消毒（Windows/POSIX 都不许的字符 + 控制字符）
function _safeDirName(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return "_未命名";
  return t.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "_未命名";
}

async function _opfsSalesDir(product, create) {
  if (!OPFS_AVAILABLE) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle("留档", { create: !!create });
    const sales = await base.getDirectoryHandle("销售", { create: !!create });
    return await sales.getDirectoryHandle(_safeDirName(product), { create: !!create });
  } catch (e) { return null; }
}

// 本地留档是否可用（供 UI 决定要不要显示相关入口）
function archiveSupported() { return OPFS_AVAILABLE; }

// 读取某品种的留档销售记录；无留档 / 读取失败 → 返回 null（调用方当「无历史」处理）
async function loadArchiveSales(product) {
  const dir = await _opfsSalesDir(product, false);
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle("sales.json");
    const text = await (await fh.getFile()).text();
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.records)) return null;
    return obj; // { version, product, updated_at, records }
  } catch (e) {
    return null; // 文件不存在 / JSON 损坏 / 权限被回收 —— 一律当无历史
  }
}

// 写入某品种的留档（**只增不删并入**）
//
// ⚠ 历史教训：这里曾是「整品种覆盖」——写的是「历史 + 本次去重后」的全集。
//   该设计隐含假设「本次上传 = 该品种的全量」，但假设不成立：
//   用户只上传某品种的一个月数据时，写回会把留档从「8月10条 + 9月1条」覆盖成「只有9月的1条」，
//   历史被**静默丢弃**（实测复现 10 条 → 1 条）。故改为并入语义，永不自动删历史。
//
// 并入规则（按 salesDedupKey 比对，与跨文件去重同一把尺子）：
//   · 键相同 → 用 _betterSalesRow 选出更优的那行**替换**（新数据可能补全了旧数据缺的字段）
//   · 键不同 → **追加**
//   · 无小票号（键为 null）→ 一律追加，不做任何匹配（宁可不合并也不错合并）
//
// 代价（须知晓）：若去重键抓不住某类差异（如数量写成 "1" vs "1.0"），这些行会**逐轮累加**，
// 而旧的覆盖语义至少会把留档重置回本轮集合。因此本函数必须与「本地留档管理器」配套：
// 用户可随时查看条数、导出备份、或手动清理。见 app.js 的 openArchiveManager。
async function saveArchiveSales(product, records) {
  const dir = await _opfsSalesDir(product, true);
  if (!dir) return false;
  try {
    // 读出现有留档作为并入基底（读不到当作空，不影响写入）
    const old = await loadArchiveSales(product);
    const base = (old && Array.isArray(old.records)) ? old.records : [];
    const merged = mergeArchiveRecords(base, records);

    const fh = await dir.getFileHandle("sales.json", { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify({
      version: 1,
      product: product,
      updated_at: fmtDateTime(new Date()),
      records: merged,
    }));
    await w.close();
    return true;
  } catch (e) { return false; }
}

// 留档并入：base（已有历史）+ incoming（本次）→ 新集合。保留 base 的顺序，新键追加在后。
// 抽成独立函数是为了能单测（saveArchiveSales 依赖 OPFS，无法在 Node 里直连）。
function mergeArchiveRecords(base, incoming) {
  const out = [];
  const index = new Map(); // dedupKey -> 在 out 里的下标（仅含有键的行）
  for (const r of (Array.isArray(base) ? base : [])) {
    if (!r) continue;
    const k = salesDedupKey(r);
    if (k == null) { out.push(r); continue; }   // 无小票号：直接留，不参与合并
    // base 内部若已有同键（旧版本可能写进过重复），后者更优则顶替
    if (index.has(k)) {
      const at = index.get(k);
      if (_betterSalesRow(r, out[at])) out[at] = r;
    } else {
      index.set(k, out.length);
      out.push(r);
    }
  }
  for (const r of (Array.isArray(incoming) ? incoming : [])) {
    if (!r) continue;
    const k = salesDedupKey(r);
    if (k == null) { out.push(r); continue; }
    if (index.has(k)) {
      const at = index.get(k);
      if (_betterSalesRow(r, out[at])) out[at] = r;   // 同键：择优替换，不新增
    } else {
      index.set(k, out.length);
      out.push(r);                                     // 新键：追加
    }
  }
  return out;
}

// ---------- 留档的「日期跨度」与「按月分段」 ----------
//
// 为什么要它：留档目录名必须稳定（一旦改名，用户已有的留档就读不到了），
// 所以「品种名 + 销售时间起止」不能当目录名用，只能当**显示名**。
// 这里从记录的 sales_time 里算出 [min, max] 与按月分段，供 UI 展示与按段筛选。

// 把 "YYYY-MM-DD" 压缩成显示用的 "YY.M.D"（如 2025-01-01 → 25.1.1）
function _shortDate(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[1].slice(2)}.${+m[2]}.${+m[3]}`;
}

// 记录集合的销售时间范围 → { from, to, label }
//   from/to 为 "YYYY-MM-DD"；label 形如 "25.1.1-26.3.4"（单日则只显示一个日期）
//   无任何可解析日期 → { from:"", to:"", label:"" }（调用方原样退回品种名）
function salesDateRange(records) {
  let mn = "", mx = "";
  for (const r of (Array.isArray(records) ? records : [])) {
    const d = datePart(r && r.sales_time);
    if (!d) continue;
    if (!mn || d < mn) mn = d;
    if (!mx || d > mx) mx = d;
  }
  if (!mn) return { from: "", to: "", label: "" };
  const a = _shortDate(mn), b = _shortDate(mx);
  return { from: mn, to: mx, label: a === b ? a : `${a}-${b}` };
}

// 「品种名 · 日期跨度」显示名。无日期时退化为品种名本身。
function archiveDisplayName(product, records) {
  const rg = salesDateRange(records);
  return rg.label ? `${product} · ${rg.label}` : String(product == null ? "" : product);
}

// 把记录按「销售时间所属月份」分段 → [{ month:"2025-01", label:"2025年1月", count, records }]
// 月份降序（新的在前）；无法解析日期的记录归到 month="" 的「未知日期」段，排在最后。
function groupRecordsByMonth(records) {
  const buckets = new Map();
  let unknown = 0;
  for (const r of (Array.isArray(records) ? records : [])) {
    const d = datePart(r && r.sales_time);
    if (!d) { unknown++; continue; }
    const mk = d.slice(0, 7); // YYYY-MM
    if (!buckets.has(mk)) buckets.set(mk, []);
    buckets.get(mk).push(r);
  }
  const out = Array.from(buckets.keys()).sort().reverse().map(mk => ({
    month: mk,
    label: `${mk.slice(0, 4)}年${+mk.slice(5, 7)}月`,
    count: buckets.get(mk).length,
    records: buckets.get(mk),
  }));
  if (unknown) out.push({ month: "", label: "未知销售时间", count: unknown, records: [] });
  return out;
}

// 按「月份段」取历史记录。
//   months == null            → 返回全部（= 不筛选，向后兼容旧调用）
//   months == []              → 返回**空**（用户「全不选」的明确表达）
//   months == ["2025-01", ...] → 只返回所属月份命中集合的记录
//
// ⚠ 空数组必须表示「一条都不要」而不是「不筛」——否则用户点「全不选」会得到全部历史，
//   与界面上的勾选状态直接矛盾（那是会让人误判数据的 bug）。
//   想表达「不筛」请传 null。
// ⚠ 未知日期段的 key 是空串，用 "" 传进来表示「要未知日期那一段」；
//   因此这里用 `months == null` 判定「没传」，而不是 `!months.length`。
function filterRecordsByMonths(records, months) {
  const list = Array.isArray(records) ? records : [];
  if (months == null) return list;
  const set = new Set(Array.isArray(months) ? months : [months]);
  if (!set.size) return []; // 空数组 = 全不选 → 一条都不取
  const out = [];
  for (const r of list) {
    const d = datePart(r && r.sales_time);
    const mk = d ? d.slice(0, 7) : "";
    if (set.has(mk)) out.push(r);
  }
  return out;
}

// 列出本地留档里所有品种（含各自的记录条数、更新时间、销售时间跨度），按品种名排序。
// 读取顺序：遍历「销售」目录下的子目录，逐个尝试读 sales.json。
// 返回项：{ product, count, updated_at, from, to, rangeLabel, displayName }
//   from/to     —— "YYYY-MM-DD"，该品种留档记录的销售时间最小/最大值（无日期则空串）
//   rangeLabel  —— "25.1.1-26.3.4"（供「品种名 · 时间段」展示）
//   displayName —— "百泽安 · 25.1.1-26.3.4"（无日期时就是品种名）
async function listArchiveProducts() {
  if (!OPFS_AVAILABLE) return [];
  const out = [];
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle("留档", { create: false });
    const sales = await base.getDirectoryHandle("销售", { create: false });
    for await (const [name, handle] of sales.entries()) {
      if (!handle || handle.kind !== "directory") continue;
      let meta = null;
      try {
        const fh = await handle.getFileHandle("sales.json");
        const obj = JSON.parse(await (await fh.getFile()).text());
        if (obj && Array.isArray(obj.records)) {
          const product = obj.product || name;
          const rg = salesDateRange(obj.records);
          meta = {
            product, count: obj.records.length, updated_at: obj.updated_at || "",
            from: rg.from, to: rg.to, rangeLabel: rg.label,
            displayName: rg.label ? `${product} · ${rg.label}` : product,
          };
        }
      } catch (e) { /* 该子目录没有可读留档 → 跳过 */ }
      if (meta) out.push(meta);
    }
  } catch (e) {
    return []; // 「留档」目录还不存在 = 从未留档过，属正常
  }
  return out.sort((a, b) => String(a.product).localeCompare(String(b.product), "zh"));
}

// 删除某品种的留档
async function removeArchiveSales(product) {
  if (!OPFS_AVAILABLE) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle("留档");
    const sales = await base.getDirectoryHandle("销售");
    await sales.removeEntry(_safeDirName(product), { recursive: true });
    return true;
  } catch (e) { return false; }
}

// 清空整个留档（删除「销售」目录下所有品种）。供「本地留档管理器」的「全部清空」使用。
// 返回 { ok, removed } —— removed 是实际删掉的品种数，供界面回显。
async function removeAllArchiveSales() {
  if (!OPFS_AVAILABLE) return { ok: false, removed: 0 };
  let removed = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle("留档", { create: false });
    const sales = await base.getDirectoryHandle("销售", { create: false });
    // 先收集名字再删：直接在 entries() 迭代中删会打乱迭代器
    const names = [];
    for await (const [name, handle] of sales.entries()) {
      if (handle && handle.kind === "directory") names.push(name);
    }
    for (const name of names) {
      try { await sales.removeEntry(name, { recursive: true }); removed++; } catch (e) { /* 单个失败不中断 */ }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: true, removed }; // 「留档」目录本就不存在 = 已是空，视为成功
  }
}

// 读出全部留档记录（供「导出留档备份」）。返回 { records, products:[{product,count,updated_at}] }
async function loadAllArchiveRecords() {
  const meta = await listArchiveProducts();
  const records = [];
  for (const m of meta) {
    const obj = await loadArchiveSales(m.product);
    if (obj && Array.isArray(obj.records)) records.push(...obj.records);
  }
  return { records, products: meta };
}

// 取出指定品种集合的历史销售记录，拼成一个数组（供与本次数据合并后去重）。
//
// 两种入参写法都支持（向后兼容旧的「只传品种名数组」）：
//   · ["百泽安", "百悦泽"]                    → 这两个品种的**全部**历史
//   · [{product:"百泽安", months:["2025-01"]}] → 只取该品种 2025年1月 的历史
//     months 为 null/undefined → 该品种全部；months 为 [] → 该品种一条都不取。
//
// 空集合 → 返回空数组，**不读任何历史**（保证「本次品种无历史」时零副作用）。
async function loadArchiveSalesFor(products) {
  const raw = Array.isArray(products) ? products : [];
  const picks = raw.map(x => {
    if (x == null) return null;
    if (typeof x === "string") return { product: x, months: null };
    return { product: x.product, months: x.months === undefined ? null : x.months };
  }).filter(x => x && String(x.product || "").trim());
  const out = [];
  const loaded = [];
  for (const pick of picks) {
    const obj = await loadArchiveSales(pick.product);
    if (!obj || !Array.isArray(obj.records) || !obj.records.length) continue;
    const rng = salesDateRange(obj.records);
    const total = obj.records.length;
    // months === null → 全取；否则按月份筛（空数组 = 一条不取）
    const recs = pick.months === null
      ? obj.records
      : filterRecordsByMonths(obj.records, pick.months);
    if (!recs.length) continue;
    for (const r of recs) out.push(r);
    loaded.push({
      product: pick.product, count: recs.length, total, updated_at: obj.updated_at || "",
      months: pick.months, from: rng.from, to: rng.to,
      rangeLabel: rng.label, displayName: rng.label ? `${pick.product} · ${rng.label}` : pick.product,
    });
  }
  return { records: out, loaded };
}

if (typeof window !== "undefined") {
  window.Pipeline = { cellStr, datePart, mapColumns, detectHeaderRow, normalizeSheet,
    loadWorkbook, processFiles, detectFileType, desensitize, phoneDigits, patientKey, fmtDateTime,
    dedupSales, salesDedupKey,
    archiveSupported, loadArchiveSales, saveArchiveSales, listArchiveProducts,
    removeArchiveSales, loadArchiveSalesFor, mergeArchiveRecords,
    removeAllArchiveSales, loadAllArchiveRecords,
    // 留档「品种名 + 销售时间起止」显示名 / 按月分段（供 UI 展示与按段筛选）
    salesDateRange, archiveDisplayName, groupRecordsByMonth, filterRecordsByMonths };
}
})();
