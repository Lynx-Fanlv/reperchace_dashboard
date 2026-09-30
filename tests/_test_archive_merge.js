/* 留档「只增不删」并入语义回归
 * 覆盖：部分数据不再丢历史 / 同键择优替换 / 无小票号不参与 / base 内重复自净 / 顺序稳定
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const ctx = {
  window: {}, console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array,
  String, Number, isFinite, parseInt, parseFloat, Set, Map, RegExp, Error,
};
ctx.global = ctx; ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["vendor/xlsx.full.min.js", "mapping.js", "pipeline.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}
const P = ctx.Pipeline;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); fail++; }
}
// vm 上下文里创建的数组/对象原型与本文件不同，assert.deepStrictEqual 会因原型不等而报错。
// 一律先 JSON 归一化再比。
const J = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b, m) => assert.strictEqual(JSON.stringify(J(a)), JSON.stringify(J(b)), m);

const mk = (day, ticket, prod, extra) => Object.assign({
  source: "sales", _row_id: `f1::sales::S::${day}-${ticket}`,
  sales_time: `2026-${day}`, product: prod || "百泽安", product_raw: prod || "百泽安",
  ticket_no: ticket, qty: "1", pharmacy: "某药房",
  patient_name: "张三", phone: "13800001111", member_id: "M1",
}, extra || {});

console.log("== 留档只增不删并入 ==");

t("静态断言：saveArchiveSales 不再是无条件覆盖", () => {
  const src = fs.readFileSync(path.join(ROOT, "pipeline.js"), "utf8");
  const i = src.indexOf("async function saveArchiveSales");
  assert(i >= 0, "找不到 saveArchiveSales");
  let d = 0, e = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) { e = k + 1; break; } }
  }
  const body = src.slice(i, e);
  assert(/mergeArchiveRecords\(/.test(body), "未调用 mergeArchiveRecords：仍是覆盖语义");
  assert(/loadArchiveSales\(product\)/.test(body), "未读取现有留档作为并入基底");
});

t("核心回归：只传部分数据不再丢历史（旧逻辑 10→1）", () => {
  const aug = [];
  for (let d = 1; d <= 10; d++) aug.push(mk("08-" + String(d).padStart(2, "0"), "T" + d));
  const afterAug = P.mergeArchiveRecords([], aug);
  assert.strictEqual(afterAug.length, 10, "首轮应存 10 条");
  // 第二轮只传 9 月的 1 条
  const sep = [mk("09-05", "T99")];
  const afterSep = P.mergeArchiveRecords(afterAug, sep);
  assert.strictEqual(afterSep.length, 11, "应为 10+1=11 条（旧逻辑会变成 1 条）");
  assert.ok(afterSep.some(r => r.ticket_no === "T1"), "8 月的历史必须还在");
  assert.ok(afterSep.some(r => r.ticket_no === "T99"), "9 月的新数据也要在");
});

t("同键不新增，且更优者替换（不出现重复行）", () => {
  const base = [mk("08-01", "T1")];
  // 同键、但 member_id 缺失（信息更少）→ 不应顶替
  const worse = [mk("08-01", "T1", "百泽安", { member_id: null })];
  const m1 = P.mergeArchiveRecords(base, worse);
  assert.strictEqual(m1.length, 1, "同键不应新增行");
  assert.strictEqual(m1[0].member_id, "M1", "更差的行不应顶替");

  // 同键、信息更全 → 应顶替
  const richer = [mk("08-01", "T1", "百泽安", { member_id: "M1", indication: "补充诊断" })];
  const m2 = P.mergeArchiveRecords(base, richer);
  assert.strictEqual(m2.length, 1, "同键仍只有 1 行");
  assert.strictEqual(m2[0].indication, "补充诊断", "更全的行应顶替旧行");
});

t("无小票号的行一律追加，不参与合并", () => {
  const base = [mk("08-01", ""), mk("08-02", "")];
  const inc = [mk("08-01", ""), mk("08-03", "")];
  const m = P.mergeArchiveRecords(base, inc);
  assert.strictEqual(m.length, 4, "无小票号应全部保留（不复用旧行为会误合并风险）");
});

t("base 内部已有重复时自净（旧版本遗留数据）", () => {
  const dup = [mk("08-01", "T1"), mk("08-01", "T1"), mk("08-02", "T2")];
  const m = P.mergeArchiveRecords(dup, []);
  assert.strictEqual(m.length, 2, "base 内部同键应收敛为 1 条，共 2 条");
});

t("顺序稳定：base 顺序保留，新键追加在后", () => {
  const base = [mk("08-01", "T1"), mk("08-02", "T2")];
  const inc = [mk("08-03", "T3")];
  const m = P.mergeArchiveRecords(base, inc);
  eq(m.map(r => r.ticket_no), ["T1", "T2", "T3"]);
});

t("空/异常入参不抛错", () => {
  eq(P.mergeArchiveRecords(null, null), []);
  eq(P.mergeArchiveRecords(undefined, [null, undefined]), []);
  assert.strictEqual(P.mergeArchiveRecords([mk("08-01", "T1")], null).length, 1);
});

t("幂等：同一批数据并入两次结果一致", () => {
  const batch = [mk("08-01", "T1"), mk("08-02", "T2")];
  const once = P.mergeArchiveRecords([], batch);
  const twice = P.mergeArchiveRecords(once, batch);
  assert.strictEqual(twice.length, once.length, "重复并入同批数据不应增长");
});

t("导出面：新增 removeAllArchiveSales / loadAllArchiveRecords / mergeArchiveRecords", () => {
  assert.strictEqual(typeof P.removeAllArchiveSales, "function", "缺 removeAllArchiveSales");
  assert.strictEqual(typeof P.loadAllArchiveRecords, "function", "缺 loadAllArchiveRecords");
  assert.strictEqual(typeof P.mergeArchiveRecords, "function", "缺 mergeArchiveRecords");
});

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
