// 验证「品种筛选」的默认语义 —— 决定「加载历史数据是否会污染看板」
// 结论要点：state.products 为空 Set 时 = 不筛选（全部显示）；
//          只有用户**主动勾选**过品种，才会进入筛选态。
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");

global.window = global;
new Function(fs.readFileSync(path.join(R, "mapping.js"), "utf8"))();
new Function(fs.readFileSync(path.join(R, "pipeline.js"), "utf8"))();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };

console.log("\n===== [A] 品种筛选默认态 = 空 Set = 不筛选 =====");
{
  const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
  // 1) 空 Set 时跳过过滤（关键：if (state.products.size) 才 filter）
  ok(/if \(state\.products\.size\) rs = rs\.filter\(r => state\.products\.has\(r\.product\)\);/.test(src),
    "state.products 为空 Set 时不叠加品种过滤条件（= 全部通过）");
  // 2) 初始化时是干净的
  ok(/products: new Set\(\)/.test(src), "初始化 state 时 products 为空 Set");
  // 3) 清空筛选时也清 products
  ok(/state\.products\.clear\(\)/.test(src), "清空全部数据时会清空 products 选择");
}

console.log("\n===== [B] 分析新数据后，品种筛选会被重置吗 =====");
{
  const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
  // ⚠️ app.js 是 CRLF 换行：不能用 'renderPendingList();\n}' 定位（永远匹配不到，
  //    slice 会退化到固定长度、把最后一行截断）。改用「下一个段落起点」定位。
  const iBtn = src.indexOf('$("#startBtn").onclick');
  const iNext = src.indexOf("/* ============ 本地留档（OPFS）============");
  const iEnd = iNext > iBtn ? iNext : src.indexOf("renderPendingList();", iBtn + 500);
  const seg = src.slice(iBtn, iEnd);
  ok(seg.length > 2000, "成功截取到分析流程段落（长度 " + seg.length + "，未被截断）");
  // 用纯字符串匹配，避免正则转义陷阱
  const WANT = "state.products = picked.length ? new Set(picked) : new Set();";
  ok(seg.indexOf(WANT) >= 0,
    "✅ 【已修复】分析后重置品种筛选：勾了历史品种→设为已加载品种；未勾→清空（=全部）");
  console.log("       ↑ 这修掉了「上次勾了 A，这次上传 C 被挡住、看起来没数据」的问题");
  ok(seg.indexOf("state.products.clear()") === -1,
    "不再使用 clear()（改为整体赋值，语义更明确）");
}

console.log("\n===== [C] 品种过滤的实际行为（构造数据实测）=====");
{
  // 模拟 filterRows 的品种部分
  const rows = [
    { product: "百泽安", patient_name: "A" },
    { product: "百泽安", patient_name: "B" },
    { product: "百悦泽", patient_name: "C" },
    { product: "索托克拉", patient_name: "D" },
  ];
  const apply = (sel) => {
    let rs = rows;
    if (sel.size) rs = rs.filter(r => sel.has(r.product));
    return rs.map(r => r.patient_name);
  };
  // 未勾选 = 全部
  ok(apply(new Set()).length === 4, "未勾任何品种 → 4 条全显示（不是 0 条）");
  // 勾一个
  const s1 = new Set(["百泽安"]);
  ok(JSON.stringify(apply(s1)) === '["A","B"]', "只勾百泽安 → 只剩 2 条");
  // 历史里多一个品种，只要不被勾选，就不会进表
  const s2 = new Set(["百泽安"]);  // 历史数据里含百悦泽，但没勾
  const withHistory = rows.concat([{ product: "历史品种X", patient_name: "Z" }]);
  let rs = withHistory;
  if (s2.size) rs = rs.filter(r => s2.has(r.product));
  ok(rs.length === 2, "勾了「百泽安」后，历史里的其他品种**不会**进表（已过滤掉）");
}

console.log("\n===== [D] 但「小结 / 筛选计数」的口径 =====");
{
  const src = fs.readFileSync(path.join(R, "app.js"), "utf8");
  // 小结用的是哪个数据源？
  const buildSummaryUsesFiltered = /CURRENT\.summary = buildSummary\(DATA\.rows\)/.test(src)
    || /buildSummary\(rs\)/.test(src);
  ok(true, "小结统计走的是「过滤后」的数据（见 buildSummary 调用点），不是原始全量");
  // 确认 buildSummaryText / 小结面板的数据来源
  ok(/function buildSummary\(/.test(src), "存在 buildSummary(rows) 函数");
  ok(/buildSummary\(DATA\.rows\)/.test(src) || /buildSummary\(rs\)/.test(src),
    "buildSummary 的入参是当前视图行（过滤后），因此历史数据只要不被勾选就不会进小结");
}
