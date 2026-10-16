/* 在页面内执行：验证「跟进备注 / 未购药原因」两条真实交互路径
   —— 必须走真实 DOM 事件（输入框 input、原因标签 click + select change），
   不能直接写 STORE（旧测试就是这么绕过 DOM，才漏掉了 U+0000 → U+FFFD 的键失配）。 */
(async () => {
  const out = [];
  let pass = 0, fail = 0;
  const ok = (c, m) => { out.push((c ? "  ✅ " : "  ❌ ") + m); c ? pass++ : fail++; };
  const log = (m) => out.push(m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = window.AppCore, P = window.Pipeline, M = window.Mapping;
  const S = A.state, ST = A.STORE;

  const NAME = "测试患者甲", PHONE = "13800001111";   // 有随访 → 自动判定「脱落·经济」
  const NAME2 = "测试患者乙", PHONE2 = "13800002222"; // 无随访 → 用于填备注 / 点选
  const PROD = "百泽安";
  const NOTE_TYPED = '已电话联系，患者说"本周五"去买';

  const mkSale = (date, name, phone, member) => ({
    source: "sales", _row_id: "f::sales::s::" + date + "_" + member, sales_time: date,
    order_status: "已完成", product_raw: PROD, product: PROD, qty: "1", amount: "1000",
    member_id: member, patient_name: name, phone: phone, member_phone: phone,
    hospital: "成都医学院第一附属医院", pharmacy: "成都西三段药房(连锁）",
    physician: "张医生", department: "肿瘤科", indication: "测试适应症", age: "60", gender: "男",
  });

  ST.sales = [mkSale("2026-08-01", NAME, PHONE, "M1"), mkSale("2026-08-01", NAME2, PHONE2, "M2")];
  // 随访记录（pipeline 归一化后的形状）：stop_reason 含「经济」→ classifyFuReason = 脱落·经济
  ST.followups = [{
    patient_name: NAME, phone: PHONE, product: PROD, summary_type: "随访任务",
    task_status: "已完成", exec_time: "2026-08-05 10:00:00", plan_time: "2026-08-05 10:00:00",
    follow_note: "患者表示经济压力较大", delay_reason: "", stop_reason: "经济困难",
    dropout_reason: "", is_dropout: "", executor: "刘倩",
  }];
  ST.cycles = {}; ST.notes = {}; ST.reasonOverrides = {}; ST.cycleOverrides = {};
  S.stdCycle = {}; S.stdCycle[PROD] = 21;
  S.cycleAlgo = "reset"; S.refDate = "2026-09-20"; S.weekSel = "this";
  S.page = 1; S.pageSize = 50;
  S.hiddenCols = new Set();
  A.syncStdCycles([PROD]);
  document.getElementById("board").classList.remove("hidden");
  await A.refresh();
  A.renderTable();
  await sleep(300);

  const noteKeyOf = (name) => {
    const r = A.DATA.rows.find((x) => x.patient_name === name);
    return r ? r._key + "::" + r.product : null;
  };
  const trOf = (name) => {
    const i = A.DATA.rows.findIndex((x) => x.patient_name === name);
    return i < 0 ? null : document.querySelector('#tbody tr.data-row[data-idx="' + i + '"]');
  };
  const noteInp = (name) => { const tr = trOf(name); return tr ? tr.querySelector("input.note-input") : null; };
  const reasonTag = (name) => { const tr = trOf(name); return tr ? tr.querySelector("span.reason-tag") : null; };

  try {   // 任一段异常也要把已得结论带回去，否则只看到 [object Object] 无从判断

  log("=== [0] 场景就绪：2 名患者、均为「已逾期」（可填备注）===");
  const rA = A.DATA.rows.find((r) => r.patient_name === NAME);
  const rB = A.DATA.rows.find((r) => r.patient_name === NAME2);
  ok(!!rA && !!rB, "两名患者都出现在名单上（" + A.DATA.rows.length + " 行）");
  ok(rA && rA.status === "已逾期", "患者甲状态 = " + (rA && rA.status));
  ok(!!rA && rA.reason === "dropout_econ", "患者甲自动判定出未购药原因 = " + (rA && rA.reason) + "（用于验「未标」能压过自动原因）");
  ok(!noteKeyOf(NAME).includes("\uFFFD"), "noteKey 本身不含 U+FFFD（含 " + JSON.stringify(noteKeyOf(NAME).slice(0, 12)) + "…）");

  /* ---------------- 1. 填写跟进备注 → 导出回传表 ---------------- */
  log("\n=== [1] 填写「跟进备注」后导出随访回传表（原报障：提示没有可回传的内容）===");
  const inp = noteInp(NAME2);
  ok(!!inp, "患者乙有可编辑的备注输入框");
  ok(!!inp && !inp.hasAttribute("data-key"), "★ 备注输入框已不再用 data-key 传患者键");
  if (inp) {
    inp.value = NOTE_TYPED;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await sleep(120);
  const keyB = noteKeyOf(NAME2);
  ok(ST.notes[keyB] === NOTE_TYPED, "★ 输入被记到正确的键上：" + JSON.stringify(Object.keys(ST.notes).map((k) => k.slice(0, 14))));
  ok(Object.keys(ST.notes).every((k) => !k.includes("\uFFFD")), "★ 没有产生含 U+FFFD 的脏键");
  ok(Object.keys(ST.notes).length === 1, "STORE.notes 只有 1 个键（无重复脏键）");
  const cbRows = A.callbackRows();
  ok(cbRows.length === 1, "★ callbackRows() 命中 1 行（修复前为 0 → 报「没有可回传的内容」）");

  // 拦截下载与弹窗，真实跑一次导出
  const alerts = [];
  const origAlert = window.alert;
  window.alert = (m) => alerts.push(String(m));
  let captured = null;
  URL.createObjectURL = (b) => { captured = b; return "blob:test"; };
  URL.revokeObjectURL = () => {};
  await A.doExportCallback();
  window.alert = origAlert;
  ok(!!captured, "★ 导出成功产出文件（修复前直接 return，无文件）");
  ok(!alerts.some((m) => m.includes("没有可回传的内容")), "不再弹「没有可回传的内容」");
  if (captured) {
    const ab = await captured.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(ab), { type: "array" });
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const head = grid[0], body = grid.slice(1);
    ok(body.length === 1, "回传表数据行数 = " + body.length);
    const cNote = head.indexOf("跟进备注");
    ok(body[0] && body[0][cNote] === NOTE_TYPED,
      "★ 回传表「跟进备注」列内容完整（含引号未被截断）：" + JSON.stringify(body[0] && body[0][cNote]));
    ok(head.includes("服务摘要") && body[0][head.indexOf("服务摘要")] === "跟进回传", "回传标记（服务摘要=跟进回传）就位");
    ok(M.detectTableType(head) === "followup", "回传表仍可被识别为「随访数据」");
  }

  /* ---------------- 2. 点选未购药原因 → 是否保留 ---------------- */
  log("\n=== [2] 点选「未购药原因」后是否保留（原报障：点选结果无法保留）===");
  const tagB = reasonTag(NAME2);
  ok(!!tagB, "患者乙有可点选的原因标签");
  ok(!!tagB && !tagB.hasAttribute("data-key"), "★ 原因标签已不再用 data-key 传患者键");
  if (tagB) {
    const td = tagB.parentNode;              // ⚠ 必须在 click 之前取：click 后 td.innerHTML 被换成 select，标签节点会脱离
    tagB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(80);
    const sel = td.querySelector("select.reason-sel");
    ok(!!sel, "点击后行内展开选择器");
    ok(!!sel && !sel.hasAttribute("data-key"), "★ 选择器也不再带 data-key");
    if (sel) {
      sel.value = "delay";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(400);
  }
  ok(ST.reasonOverrides[keyB] === "delay", "★ 点选结果写入正确的键 = " + JSON.stringify(ST.reasonOverrides[keyB]));
  const rB2 = A.DATA.rows.find((r) => r.patient_name === NAME2);
  ok(!!rB2 && rB2.reason === "delay", "★ 重算后该行 reason = " + (rB2 && rB2.reason) + "（修复前回弹为原值/未标）");
  const tagB2 = reasonTag(NAME2);
  ok(!!tagB2 && tagB2.textContent.includes("推迟购药"), "★ 界面上标签显示为「" + (tagB2 && tagB2.textContent) + "」→ 看得见地保留了");
  ok(Object.keys(ST.reasonOverrides).every((k) => !k.includes("\uFFFD")), "原因键也无 U+FFFD 污染");

  /* ---------------- 3. 「未标」必须能压过自动判定 ---------------- */
  log("\n=== [3] 点选「未标」清除自动判定（空串不能被 || 顶掉）===");
  const tagA = reasonTag(NAME);
  ok(!!tagA && tagA.textContent.includes("脱落"), "患者甲当前显示自动原因「" + (tagA && tagA.textContent) + "」");
  if (tagA) {
    const tdA = tagA.parentNode;             // 同上：先取父节点
    tagA.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(80);
    const selA = tdA.querySelector("select.reason-sel");
    ok(!!selA, "患者甲的原因选择器展开");
    if (selA) {
      selA.value = "";
      selA.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(400);
  }
  const keyA = noteKeyOf(NAME);
  ok(Object.prototype.hasOwnProperty.call(ST.reasonOverrides, keyA), "★ 「未标」被记录为一次显式点选（键存在，值空串）");
  const rA2 = A.DATA.rows.find((r) => r.patient_name === NAME);
  ok(!!rA2 && rA2.reason === "", "★ 重算后 reason 被清空（修复前被 autoReason 顶回 dropout_econ）");
  const tagA2 = reasonTag(NAME);
  ok(!!tagA2 && !tagA2.textContent.includes("脱落"), "界面上不再显示「脱落·经济」，现为「" + (tagA2 && tagA2.textContent) + "」");

  /* ---------------- 4. 系统性哨兵：行内 HTML 不得出现 U+FFFD ---------------- */
  log("\n=== [4] 系统性哨兵：表格 HTML 里不得有 U+FFFD（NUL 被吞的痕迹）===");
  const html = document.getElementById("tbody").innerHTML;
  ok(html.indexOf("\uFFFD") < 0, "★ tbody 渲染结果不含 U+FFFD 替换字符");
  const badAttr = [...document.querySelectorAll("#tbody input, #tbody select, #tbody span")].filter(
    (el) => [...el.attributes].some((a) => a.value.includes("\uFFFD")));
  ok(badAttr.length === 0, "★ 表格内无任何属性值含 U+FFFD（" + badAttr.length + " 个）");

  } catch (err) {
    fail++;
    out.push("  ❌ 探针异常中断：" + (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" ┃ ") : String(err)));
  }

  log("\n通过 " + pass + " / " + (pass + fail));
  return out.join("\n");
})()
