// 留档「品种名 + 销售时间起止」显示名 与「按时间段勾选加载」回归测试
//
// 背景（用户需求）：
//   1. 留档自动命名成「品种名 + 所含销售时间的起止」，如「百泽安25.1.1-26.3.4」
//   3. 弹窗勾选品种后，还能进一步选择「加载哪些历史（哪些时间段）」
//
// 关键设计约束（已与用户确认）：
//   · 留档**目录名保持按品种**（改名会让已有留档读不到）→ 日期只作为**显示名**
//   · 时间段选择落在「月份」粒度上（不需要重构存储结构就有「选部分历史」的能力）
//
// 分两层：
//   [A] pipeline 的纯函数（日期跨度 / 按月分段 / 按段筛选 / 按段加载）
//   [B] 静态断言（app.js 的接线 + index.html 的样式产物）
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");
const vm = require("vm");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };
const eq = (a, b, m) => ok(a === b, m + "  (得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + ")");
// ⚠ vm 上下文里造的对象原型与本文件不同，deepStrictEqual 会误报 → 一律先归一化
const J = (v) => JSON.parse(JSON.stringify(v));
const eqj = (a, b, m) => ok(JSON.stringify(J(a)) === JSON.stringify(J(b)),
  m + "  (得到 " + JSON.stringify(J(a)) + "，期望 " + JSON.stringify(J(b)) + ")");

// ---------- 假 OPFS（与 _test_archive.js 同一套最小实现） ----------
function makeFakeOPFS() {
  const newDir = () => ({ kind: "directory", _dirs: new Map(), _files: new Map() });
  const root = newDir();
  const err = (name) => { const e = new Error(name); e.name = name; return e; };
  function wrap(node) {
    return {
      kind: "directory",
      async getDirectoryHandle(name, opts) {
        if (!node._dirs.has(name)) {
          if (!(opts && opts.create)) throw err("NotFoundError");
          node._dirs.set(name, newDir());
        }
        return wrap(node._dirs.get(name));
      },
      async getFileHandle(name, opts) {
        if (!node._files.has(name)) {
          if (!(opts && opts.create)) throw err("NotFoundError");
          node._files.set(name, { text: "" });
        }
        const f = node._files.get(name);
        return {
          kind: "file",
          async getFile() { return { async text() { return f.text; } }; },
          async createWritable() {
            let buf = "";
            return { async write(d) { buf = String(d); }, async close() { f.text = buf; } };
          },
        };
      },
      async removeEntry(name) {
        if (node._files.has(name)) { node._files.delete(name); return; }
        if (node._dirs.has(name)) { node._dirs.delete(name); return; }
        throw err("NotFoundError");
      },
      async *entries() {
        for (const [n, v] of node._dirs) yield [n, wrap(v)];
        for (const [n] of node._files) yield [n, { kind: "file" }];
      },
    };
  }
  return { root, wrap };
}

function loadPipeline(fake) {
  const g = {};
  g.window = g;
  g.console = console;
  g.navigator = fake ? { storage: { async getDirectory() { return fake.wrap(fake.root); } } } : {};
  g.Mapping = { normHeader: x => String(x == null ? "" : x).trim() };
  g.XLSX = {};
  new Function("window", "globalThis", "navigator", "console",
    fs.readFileSync(path.join(R, "pipeline.js"), "utf8"))(g, g, g.navigator, console);
  return g.Pipeline;
}

// 造记录：sales_time 用 YYYY-MM-DD（与 pipeline 归一化后的形态一致）
const rec = (ymd, n, ticket) => ({ sales_time: ymd, n, ticket_no: ticket == null ? null : String(ticket) });

(async () => {
  const fake = makeFakeOPFS();
  const P = loadPipeline(fake);

  console.log("\n===== [A1] salesDateRange：销售时间起止与短日期 label =====");
  {
    const rs = [rec("2025-01-01", 1), rec("2025-03-15", 2), rec("2026-03-04", 3)];
    const rg = P.salesDateRange(rs);
    eq(rg.from, "2025-01-01", "from = 最早销售日");
    eq(rg.to, "2026-03-04", "to = 最晚销售日");
    eq(rg.label, "25.1.1-26.3.4", "★ label = 用户要的格式「25.1.1-26.3.4」");

    // 乱序输入也应得到同样结果（不依赖输入顺序）
    const rg2 = P.salesDateRange([rs[2], rs[0], rs[1]]);
    eq(rg2.label, "25.1.1-26.3.4", "★ 乱序输入 label 不变");

    // 单日：只显示一个日期，不出现 "a-a"
    eq(P.salesDateRange([rec("2025-01-01", 1)]).label, "25.1.1", "单日 → 只显示一个日期");

    // 无日期 / 空输入
    eq(P.salesDateRange([{ n: 1 }]).label, "", "无 sales_time → label 空串");
    eq(P.salesDateRange([]).label, "", "空数组 → label 空串");
    eq(P.salesDateRange(null).label, "", "传 null → 不抛错，label 空串");
    eq(P.salesDateRange([{ sales_time: "不是日期" }]).label, "", "非法日期 → 忽略，label 空串");

    // 带时分秒的时间戳也应被 datePart 取到日期部分
    eq(P.salesDateRange([{ sales_time: "2025-01-01 09:30:00" }]).from, "2025-01-01",
      "「YYYY-MM-DD HH:mm:ss」也能取到日期");
  }

  console.log("\n===== [A2] archiveDisplayName：品种名 · 时间段 =====");
  {
    eq(P.archiveDisplayName("百泽安", [rec("2025-01-01", 1), rec("2026-03-04", 2)]),
      "百泽安 · 25.1.1-26.3.4", "★ 显示名 = 「品种名 · 起止」（用户示例的形态）");
    eq(P.archiveDisplayName("百泽安", [{ n: 1 }]), "百泽安", "无日期 → 退化为品种名（不留孤立的 ·）");
    eq(P.archiveDisplayName("", []), "", "空品种名 → 空串");
  }

  console.log("\n===== [A3] groupRecordsByMonth：按月分段（新的在前）=====");
  {
    const rs = [
      rec("2025-01-05", 1), rec("2025-01-20", 2),
      rec("2025-03-01", 3),
      rec("2026-02-10", 4), rec("2026-02-28", 5), rec("2026-02-28", 6),
    ];
    const segs = P.groupRecordsByMonth(rs);
    eq(segs.length, 3, "分出 3 个月份段");
    eqj(segs.map(s => s.month), ["2026-02", "2025-03", "2025-01"], "★ 月份降序（新的在前）");
    eqj(segs.map(s => s.count), [3, 1, 2], "各段条数正确");
    eq(segs[2].label, "2025年1月", "★ 中文月份 label（去前导零）");
    eq(segs[0].label, "2026年2月", "中文月份 label 正确");

    // 无法解析日期的记录归到「未知销售时间」段，且排在最后
    const segs2 = P.groupRecordsByMonth([rec("2025-01-05", 1), { n: 9 }, { sales_time: "??", n: 8 }]);
    eq(segs2.length, 2, "有效月份 + 未知段 = 2 段");
    eq(segs2[segs2.length - 1].month, "", "未知段的 month 是空串");
    eq(segs2[segs2.length - 1].label, "未知销售时间", "未知段的 label");
    eq(segs2[segs2.length - 1].count, 2, "未知段条数 = 2");

    eq(P.groupRecordsByMonth([]).length, 0, "空输入 → 0 段");
    eq(P.groupRecordsByMonth(null).length, 0, "传 null → 0 段不抛错");
  }

  console.log("\n===== [A4] filterRecordsByMonths：按段筛选 =====");
  {
    const rs = [
      rec("2025-01-05", 1), rec("2025-03-01", 2), rec("2026-02-10", 3), { n: 4 },
    ];
    eq(P.filterRecordsByMonths(rs, null).length, 4, "★ months=null → 全取（不筛）");
    eq(P.filterRecordsByMonths(rs, undefined).length, 4, "months=undefined → 全取");
    eq(P.filterRecordsByMonths(rs, []).length, 0,
      "★ months=[] → 0 条（「全不选」是明确表达，绝不能被当成「不筛」而放行全部）");
    eq(P.filterRecordsByMonths(rs, ["2025-01"]).length, 1, "只取 2025-01 → 1 条");
    eq(P.filterRecordsByMonths(rs, ["2025-01", "2026-02"]).length, 2, "取 2 个段 → 2 条");
    eq(P.filterRecordsByMonths(rs, [""]).length, 1, "★ 用 \"\" 取「未知日期」那一段 → 1 条");
    eq(P.filterRecordsByMonths(rs, ["1999-01"]).length, 0, "不存在的月份 → 0 条");
    eqj(J(P.filterRecordsByMonths(rs, ["2025-03"])).map(r => r.n), [2], "筛出的确实是对应月份的记录");
  }

  console.log("\n===== [A5] listArchiveProducts：带 from/to/rangeLabel/displayName =====");
  {
    const f2 = makeFakeOPFS();
    const Q = loadPipeline(f2);
    await Q.saveArchiveSales("百泽安", [
      { product: "百泽安", sales_time: "2025-01-01", ticket_no: "T1" },
      { product: "百泽安", sales_time: "2026-03-04", ticket_no: "T2" },
    ]);
    await Q.saveArchiveSales("无日期品种", [{ product: "无日期品种", n: 1 }]);

    const list = await Q.listArchiveProducts();
    const bz = list.find(x => x.product === "百泽安");
    const nd = list.find(x => x.product === "无日期品种");
    eq(bz.from, "2025-01-01", "百泽安 from 正确");
    eq(bz.to, "2026-03-04", "百泽安 to 正确");
    eq(bz.rangeLabel, "25.1.1-26.3.4", "★ 百泽安 rangeLabel = 「25.1.1-26.3.4」");
    eq(bz.displayName, "百泽安 · 25.1.1-26.3.4", "★ displayName 形如用户要求的「品种名+起止」");
    eq(nd.rangeLabel, "", "无日期品种 rangeLabel 空串");
    eq(nd.displayName, "无日期品种", "无日期品种 displayName 退化为品种名");

    // 目录名不受影响（仍是品种名）—— 这是「旧留档无损」的关键
    const dirs = Array.from(f2.root._dirs.get("留档")._dirs.get("销售")._dirs.keys());
    eqj(dirs.sort(), ["无日期品种", "百泽安"], "★ 目录名仍是品种名（未被日期污染，旧留档可读）");
  }

  console.log("\n===== [A6] loadArchiveSalesFor：按段加载（需求3 核心）=====");
  {
    const f3 = makeFakeOPFS();
    const Q = loadPipeline(f3);
    // 百泽安：2025-01 两条、2025-03 一条、2026-02 一条
    await Q.saveArchiveSales("百泽安", [
      { product: "百泽安", sales_time: "2025-01-05", ticket_no: "A1", n: 1 },
      { product: "百泽安", sales_time: "2025-01-20", ticket_no: "A2", n: 2 },
      { product: "百泽安", sales_time: "2025-03-01", ticket_no: "A3", n: 3 },
      { product: "百泽安", sales_time: "2026-02-10", ticket_no: "A4", n: 4 },
    ]);
    await Q.saveArchiveSales("百悦泽", [
      { product: "百悦泽", sales_time: "2025-01-07", ticket_no: "B1", n: 5 },
    ]);

    // 旧写法（纯字符串数组）→ 全取，向后兼容
    const all = await Q.loadArchiveSalesFor(["百泽安"]);
    eq(all.records.length, 4, "★ 传字符串数组（旧写法）→ 全取 4 条（向后兼容）");
    eq(all.loaded[0].months, null, "loaded.months = null 表示全取");

    // 新写法：只取 2025-01 段
    const seg1 = await Q.loadArchiveSalesFor([{ product: "百泽安", months: ["2025-01"] }]);
    eq(seg1.records.length, 2, "★ 只勾 2025-01 → 2 条");
    eq(seg1.loaded[0].count, 2, "loaded.count = 2");
    eq(seg1.loaded[0].total, 4, "★ loaded.total = 4（保留「2/4」这种回显所需的全量）");
    eqj(J(seg1.records).map(r => r.n).sort(), [1, 2], "筛出的确实是 2025-01 那两条");

    // 多段
    const seg2 = await Q.loadArchiveSalesFor([{ product: "百泽安", months: ["2025-01", "2026-02"] }]);
    eq(seg2.records.length, 3, "勾 2 个段 → 3 条");

    // months=[] → 该品种一条不取（且不出现在 loaded 里，便于调用方知道「没并入」）
    const none = await Q.loadArchiveSalesFor([{ product: "百泽安", months: [] }]);
    eq(none.records.length, 0, "★ months=[]（全不勾）→ 0 条");
    eq(none.loaded.length, 0, "months=[] 的品种不出现在 loaded（无实际并入）");

    // 多品种各自独立筛选
    const mix = await Q.loadArchiveSalesFor([
      { product: "百泽安", months: ["2025-03"] },
      { product: "百悦泽", months: null },
    ]);
    eq(mix.records.length, 2, "★ 百泽安只取 2025-03（1）+ 百悦泽全取（1）= 2 条");
    eq(mix.loaded.length, 2, "loaded 列出 2 个品种");
    eq(mix.loaded.find(x => x.product === "百泽安").months.join(","), "2025-03", "百泽安的 months 被带上");
    eq(mix.loaded.find(x => x.product === "百悦泽").months, null, "百悦泽 months = null（全取）");

    // 边界：坏入参不抛错
    eq((await Q.loadArchiveSalesFor([{ product: "", months: null }, null])).records.length, 0,
      "空品种名 / null 项被过滤");
    eq((await Q.loadArchiveSalesFor(null)).records.length, 0, "传 null → 0 条不抛错");
    eq((await Q.loadArchiveSalesFor([{ product: "未留档品种" }])).records.length, 0,
      "未留档品种 → 0 条");
  }

  console.log("\n===== [A7] 端到端：只并入所选段 → 去重后条数正确 =====");
  {
    const f4 = makeFakeOPFS();
    const Q = loadPipeline(f4);
    // 留档：2025-01 两条 + 2025-03 一条
    await Q.saveArchiveSales("百泽安", [
      { product: "百泽安", sales_time: "2025-01-05", ticket_no: "A1", qty: 1 },
      { product: "百泽安", sales_time: "2025-01-20", ticket_no: "A2", qty: 1 },
      { product: "百泽安", sales_time: "2025-03-01", ticket_no: "A3", qty: 1 },
    ]);
    // 本次上传：2025-01-05 那条是重叠的（同小票号+同日期+同品种+同药房+同数量）
    const incoming = [
      { product: "百泽安", sales_time: "2025-01-05", ticket_no: "A1", qty: 1, sales_time_x: 1 },
      { product: "百泽安", sales_time: "2026-05-05", ticket_no: "A9", qty: 1 },
    ];
    // 用户只勾 2025-01 段
    const arc = await Q.loadArchiveSalesFor([{ product: "百泽安", months: ["2025-01"] }]);
    const dd = Q.dedupSales(incoming.concat(arc.records));
    // 本次 2 + 历史 2 = 4，其中 A1 重叠 → 去重后 3
    eq(dd.total, 4, "合并总数 = 本次 2 + 选中历史 2 = 4");
    eq(dd.records.length, 3, "★ 去重后 3 条（重叠的 A1 被去掉）");
    eq(dd.removedRows, 1, "去掉 1 条");

    // 若改成勾「2025-01 + 2025-03」→ 历史 3 条，A1 仍重叠 → 4 条
    const arc2 = await Q.loadArchiveSalesFor([{ product: "百泽安", months: ["2025-01", "2025-03"] }]);
    const dd2 = Q.dedupSales(incoming.concat(arc2.records));
    eq(dd2.records.length, 4, "★ 勾两个段 → 去重后 4 条");
  }

  console.log("\n===== [B] 静态断言：app.js 接线 =====");
  {
    const src = fs.readFileSync(path.join(R, "app.js"), "utf8");

    // 需求1：管理器展示「品种名 · 时间段」
    ok(/a\.displayName \|\| a\.product/.test(src), "★ 管理器用 displayName 展示「品种名 · 起止」");
    ok(/<span class="arc-range">\$\{esc\(a\.rangeLabel\)\}<\/span>/.test(src),
      "★ 管理器把时间段渲染成独立小标签（分隔点交给 CSS，避免空白折叠贴字）");
    ok(/const span = a\.rangeLabel/.test(src), "rangeLabel 存在时才渲染时间段标签");
    // 需求1：管理器顶部显示整体跨度
    ok(/P\.salesDateRange\(\[\{ sales_time: froms\[0\] \}/.test(src), "★ 管理器顶部显示留档整体销售时间跨度");
    // 需求1：导出文件名带时间段
    ok(/本地留档备份\$\{span\}_/.test(src), "★ 导出备份文件名带销售时间跨度");

    // 需求3：弹窗内时间段选择
    ok(/const segChoice = new Map\(\)/.test(src), "★ 弹窗维护「品种 → 所选月份」的 segChoice");
    ok(/const segSet = \(prod\) =>/.test(src) && /const segMonthsOf = \(prod\) =>/.test(src),
      "★ 有 segSet（物化全选）与 segMonthsOf（导出所选段）两个helper");
    ok(/async function renderSeg\(prod, box\)/.test(src), "★ 有时间段面板渲染函数 renderSeg");
    ok(/segLoaded\.set\(prod, P\.groupRecordsByMonth\(recs\)\)/.test(src),
      "★ 展开时读该品种留档并按月分段（结果缓存，不重复读）");
    ok(/if \(!segLoaded\.has\(prod\)\)/.test(src), "★ 分段结果按品种缓存（重复展开不重读）");
    ok(/data-act="all"/.test(src) && /data-act="none"/.test(src), "★ 面板含「全选/全不选」");
    ok(/segChoice\.set\(prod, null\)/.test(src), "★ 「全选」回到 null（=全取，与「显式全勾」等价但更省）");
    ok(/segChoice\.set\(prod, new Set\(\)\)/.test(src), "「全不选」置空集合");
    ok(/box\.querySelectorAll\("input\[data-seg\]"\)/.test(src), "★ 时间段勾选态统一绑定");
    ok(/choose\("收起时间段"\)|"收起时间段"/.test(src), "★ 展开按钮文案会切到「收起时间段」");
    ok(/CSS\.escape\(prod\)/.test(src), "★ 品种名进选择器时经 CSS.escape（防特殊字符炸选择器）");

    // 需求3：确定后把 segments 传给加载
    ok(/pickedSeg = ans\.segments/.test(src), "★ 弹窗返回的 segments 接到 pickedSeg");
    ok(/months: \(pickedSeg && pickedSeg\.has\(p\)\) \? pickedSeg\.get\(p\) : null/.test(src),
      "★ 每个品种按 pickedSeg 取自己的 months（没设 → null 全取）");
    // dataInfo 回显「N/M 条」
    ok(/x\.months === null \? `全部\$\{x\.total\}条` : `\$\{x\.count\}\/\$\{x\.total\}条`/.test(src),
      "★ dataInfo 回显「全部N条」或「N/M条」");

    // 需求1 的关键约束：目录名没被改成「品种+日期」
    const pipeSrc = fs.readFileSync(path.join(R, "pipeline.js"), "utf8");
    const iSafe = pipeSrc.indexOf("function _safeDirName");
    const safeFn = iSafe === -1 ? "" : pipeSrc.slice(iSafe, iSafe + 500);
    ok(!!safeFn, "找到 _safeDirName");
    ok(/replace\(\/\[[^\]]*\]\/g, "_"\)\.slice\(0, 80\)/.test(safeFn),
      "★ 目录名仍是「消毒后的品种名」+80 字符截断（未掺入日期 → 旧留档无损）");
    ok(!/salesDateRange|datePart|rangeLabel/.test(safeFn),
      "★ _safeDirName 里没有任何日期逻辑（目录名与显示名彻底分离）");
    // 留档写入路径也只写品种名目录
    const iSave = pipeSrc.indexOf("async function saveArchiveSales");
    const saveFn = iSave === -1 ? "" : pipeSrc.slice(iSave, pipeSrc.indexOf("function mergeArchiveRecords"));
    ok(/await _opfsSalesDir\(product, true\)/.test(saveFn),
      "★ saveArchiveSales 仍按品种名建目录（没写「品种+日期」目录）");
  }

  console.log("\n===== [C] 产物防线：index.html / index.single.html =====");
  {
    for (const f of ["index.html", "index.single.html"]) {
      const h = fs.readFileSync(path.join(R, f), "utf8");
      ok(/arc-seg-open/.test(h), f + " 含时间段展开按钮样式");
      ok(/arc-seg-box/.test(h), f + " 含时间段面板样式");
      ok(/arc-seg-bar/.test(h) || /arc-seg-btn/.test(h), f + " 含全选/全不选按钮样式");
      ok(/arc-range/.test(h), f + " 含「品种名 · 时间段」小标签样式");
      ok(/arc-main/.test(h), f + " 含两段式行的勾选区样式");
      ok(/groupRecordsByMonth/.test(h), f + " 含 groupRecordsByMonth（已 inline）");
      ok(/salesDateRange/.test(h), f + " 含 salesDateRange（已 inline）");
    }

    // ---- 发布形态防线（2026-09-30 线上故障后新增）----
    // 故障回顾：gh-pages 分支只有 index.html + README.md，**没有 vendor/ 目录**。
    // 某次发布把「多文件版 index.html」当成了单文件版写进 gh-pages，其中
    //   <script src="vendor/xlsx.full.min.js">
    // 在线上 404 → XLSX 未定义 → **所有上传文件都被标「未识别」**、点分析毫无反应。
    // 丑的是页面本身看起来完全正常（HTML/CSS/逻辑都在），只在运行期炸，极难排查。
    // 下面这几条断言就是那次故障的哨兵。
    const single = fs.readFileSync(path.join(R, "index.single.html"), "utf8");

    ok(!/<script[^>]+src=["\']vendor\//.test(single),
      "★ index.single.html 不得引用 vendor/（gh-pages 上没有该目录，引用即 404）");
    ok(!/<script[^>]+src=["\'](?!https?:|data:)(?!#)/.test(single),
      "★ index.single.html 不得有任何相对路径的外部脚本引用");
    ok(/XLSX\s*=/.test(single) && /SheetJS/.test(single),
      "★ index.single.html 必须内联 SheetJS（XLSX= / SheetJS 标记存在）");
    ok(single.length > 1_000_000,
      "★ index.single.html 体积必须 > 1MB（多文件版只有 ~250KB）  (得到 " + single.length + ")");

    // 多文件版 index.html 反过来**应当**引用 vendor/（两者形态不能搞混）
    const multi = fs.readFileSync(path.join(R, "index.html"), "utf8");
    ok(/<script[^>]+src=["\']vendor\/xlsx\.full\.min\.js["\']/.test(multi),
      "index.html（多文件版）应当引用 vendor/xlsx.full.min.js");
    ok(multi.length < 1_000_000,
      "index.html（多文件版）体积应远小于单文件版  (得到 " + multi.length + ")");

    // 同步脚本必须从单文件版取内容（SOURCE 写错正是本次故障的根因）
    const syncSrc = fs.readFileSync(path.join(R, "tests", "_ghpages_sync.py"), "utf8");
    ok(/SOURCE\s*=\s*["\']index\.single\.html["\']/.test(syncSrc),
      "★ _ghpages_sync.py 的 SOURCE 必须是 index.single.html");
    ok(/def verify_self_contained/.test(syncSrc),
      "★ _ghpages_sync.py 必须有自包含校验（发布前把关）");
  }

  console.log("\n===== [D] 真实销售明细：识别 + 行数（防「未识别」回归）=====");
  {
    // 直接用真实导出文件跑一遍「表头行定位 → 表类型识别」，
    // 覆盖 [C] 那种「产物结构对但运行期炸」的盲区。
    const fx = path.join(R, "_fixture_sales_query.xlsx");
    if (fs.existsSync(fx)) {
      const ctx2 = { console };
      ctx2.window = ctx2; ctx2.globalThis = ctx2;
      vm.createContext(ctx2);
      vm.runInContext(fs.readFileSync(path.join(R, "vendor", "xlsx.full.min.js"), "utf8"), ctx2);
      vm.runInContext(fs.readFileSync(path.join(R, "mapping.js"), "utf8"), ctx2);
      vm.runInContext(fs.readFileSync(path.join(R, "pipeline.js"), "utf8"), ctx2);
      const XLSX2 = ctx2.XLSX || ctx2.window.XLSX;
      const M2 = ctx2.window.Mapping;

      const wb = XLSX2.read(fs.readFileSync(fx), { type: "buffer", cellDates: true });
      const aoa = XLSX2.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
        { header: 1, raw: true, defval: null, cellDates: true });
      const cols = aoa[0].map((c, i) => String(c == null ? "" : c).trim() || ("col_" + i));
      const ttype = M2.detectTableType(cols);

      eq(ttype, "sales", "★ 真实「销售明细查询报表」被识别为 sales（不是 unknown）");
      const need = ["销售时间", "商品名称", "会员姓名", "药房名称"];
      for (const k of need) {
        ok(cols.some(c => c.includes(k)), "  表头含关键列「" + k + "」");
      }
      ok(aoa.length > 100, "  数据行数 > 100  (得到 " + (aoa.length - 1) + ")");
    } else {
      console.log("  (跳过：未找到 _fixture_sales_query.xlsx)");
    }
  }

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (fail) process.exit(1);
})();
