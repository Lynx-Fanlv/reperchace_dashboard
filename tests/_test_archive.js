// 本地留档（OPFS）回归测试
// 口径（已与用户确认）：
//   · 只留档**销售明细**；随访与周期只用本次上传的
//   · 本次品种默认勾选；历史里其他品种可点选加入
//   · 本次品种全无历史 → 不弹窗、不读历史
//   · 读取失败/数据被回收 → 静默当「无历史」
//
// 由于 Node 无 OPFS，本测试分两层：
//   [A] 用内存假 OPFS 实测读写/列出/取集合（验证逻辑正确性）
//   [B] 静态断言检查 app.js 的接入点（验证接线正确）
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✅ " : "  ❌ ") + m); };
const eq = (a, b, m) => ok(a === b, m + "  (得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + ")");

// ---------- 假 OPFS：实现 FileSystemDirectoryHandle 的最小可用子集 ----------
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
      async removeEntry(name, opts) {
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

// ---------- 在受控全局里加载 pipeline.js（带假 OPFS）----------
function loadPipeline(fake) {
  const g = {};
  g.window = g;
  g.console = console;
  // 假 navigator.storage
  const storage = fake ? {
    async getDirectory() { return fake.wrap(fake.root); },
  } : undefined;
  g.navigator = storage ? { storage } : {};
  // pipeline 需要 Mapping 与 XLSX；这里只测留档，给最小桩
  g.Mapping = { normHeader: x => String(x == null ? "" : x).trim() };
  g.XLSX = {};
  new Function("window", "globalThis", "navigator", "console",
    fs.readFileSync(path.join(R, "pipeline.js"), "utf8"))(g, g, g.navigator, console);
  return g.Pipeline;
}

(async () => {
  console.log("\n===== [A1] 假 OPFS 下：可用性与读写往返 =====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    ok(P.archiveSupported() === true, "archiveSupported() = true（有 OPFS）");

    const recs = [
      { source: "sales", product: "百泽安", patient_name: "张三", ticket_no: "T1" },
      { source: "sales", product: "百泽安", patient_name: "李四", ticket_no: "T2" },
    ];
    eq(await P.saveArchiveSales("百泽安", recs), true, "saveArchiveSales 返回 true");
    const back = await P.loadArchiveSales("百泽安");
    ok(!!back, "loadArchiveSales 读回成功");
    eq(back.records.length, 2, "读回 2 条");
    eq(back.product, "百泽安", "读回 product 正确");
    eq(back.records[0].patient_name, "张三", "读回内容正确");
    ok(!!back.updated_at, "带 updated_at 时间戳");
    eq(back.version, 1, "带 version 字段");
  }

  console.log("\n===== [A2] 无留档时：静默返回 null（不抛错）=====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    eq(await P.loadArchiveSales("不存在的品种"), null, "未留档的品种 → null（不抛错）");
    eq((await P.listArchiveProducts()).length, 0, "listArchiveProducts 未留档时 → 空数组");
    eq((await P.loadArchiveSalesFor(["A", "B"])).records.length, 0, "loadArchiveSalesFor 无留档 → 空");
  }

  console.log("\n===== [A3] 品种名消毒（防目录名非法字符）=====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    const bad = 'a/b\\c:d*e?f"g<h>i|j';
    await P.saveArchiveSales(bad, [{ product: bad, n: 1 }]);
    const list = await P.listArchiveProducts();
    eq(list.length, 1, "含非法字符的品种仍能存下（被消毒）");
    ok(list[0].product === bad, "读回的 product 是原始名（不是消毒后的目录名）");
    // 目录名里不应出现 / \ : * ? " < > |
    const raw = fake.root._dirs.get("留档")._dirs.get("销售")._dirs;
    const dirName = Array.from(raw.keys())[0];
    ok(!/[\\/:*?"<>|]/.test(dirName), "实际目录名不含非法字符：" + dirName);
  }

  console.log("\n===== [A4] 多品种：listArchiveProducts 与按需取集合 =====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    await P.saveArchiveSales("百泽安", [{ product: "百泽安", n: 1 }, { product: "百泽安", n: 2 }]);
    await P.saveArchiveSales("百悦泽", [{ product: "百悦泽", n: 3 }]);
    await P.saveArchiveSales("索托克拉", [{ product: "索托克拉", n: 4 }]);

    const list = await P.listArchiveProducts();
    eq(list.length, 3, "列出 3 个品种");
    eq(list.find(x => x.product === "百泽安").count, 2, "百泽安 2 条");
    eq(list.find(x => x.product === "百悦泽").count, 1, "百悦泽 1 条");

    // 只取其中两个品种
    const got = await P.loadArchiveSalesFor(["百泽安", "索托克拉"]);
    eq(got.records.length, 3, "按品种取集合 → 2+1 = 3 条");
    eq(got.loaded.length, 2, "loaded 报告列出 2 个品种");
    eq(got.loaded.map(x => x.product).sort().join(","), "百泽安,索托克拉", "loaded 的品种名正确");
  }

  console.log("\n===== [A5] 关键：products 为空 → 不读任何历史（零副作用）=====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    await P.saveArchiveSales("百泽安", [{ product: "百泽安", n: 1 }]);
    const r1 = await P.loadArchiveSalesFor([]);
    eq(r1.records.length, 0, "传空数组 → 不读历史（0 条）");
    const r2 = await P.loadArchiveSalesFor(null);
    eq(r2.records.length, 0, "传 null → 不读历史（0 条）");
    const r3 = await P.loadArchiveSalesFor(["   ", ""]);
    eq(r3.records.length, 0, "传空白品种名 → 不读历史（0 条）");
  }

  console.log("\n===== [A6] 整品种覆盖：同一品种再存会替换而非追加 =====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    await P.saveArchiveSales("百泽安", [{ n: 1 }, { n: 2 }, { n: 3 }]);
    eq((await P.loadArchiveSales("百泽安")).records.length, 3, "先存 3 条");
    await P.saveArchiveSales("百泽安", [{ n: 9 }]);
    const back = await P.loadArchiveSales("百泽安");
    eq(back.records.length, 1, "整品种覆盖 → 只剩 1 条（不是 3+1=4）");
    eq(back.records[0].n, 9, "内容是新的那条");
  }

  console.log("\n===== [A7] 假 OPFS 损坏时：读取失败静默为 null =====");
  {
    // 写入非 JSON 内容模拟损坏
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    await P.saveArchiveSales("百泽安", [{ n: 1 }]);
    // 手动破坏那份文件
    const dir = fake.root._dirs.get("留档")._dirs.get("销售")._dirs.get("百泽安");
    dir._files.get("sales.json").text = "<<<不是合法 JSON>>>";
    eq(await P.loadArchiveSales("百泽安"), null, "JSON 损坏 → 返回 null（静默降级）");
    const list = await P.listArchiveProducts();
    eq(list.length, 0, "损坏的品种在 listArchiveProducts 里被跳过");
  }

  console.log("\n===== [A8] 无 OPFS 环境：全部安全降级 =====");
  {
    const P = loadPipeline(null);
    eq(P.archiveSupported(), false, "无 OPFS → archiveSupported() = false");
    eq(await P.loadArchiveSales("百泽安"), null, "无 OPFS → loadArchiveSales 返回 null");
    eq((await P.listArchiveProducts()).length, 0, "无 OPFS → listArchiveProducts 空数组");
    eq(await P.saveArchiveSales("百泽安", [{ n: 1 }]), false, "无 OPFS → saveArchiveSales 返回 false");
    eq((await P.loadArchiveSalesFor(["百泽安"])).records.length, 0, "无 OPFS → 不读历史");
  }

  console.log("\n===== [A9] removeArchiveSales =====");
  {
    const fake = makeFakeOPFS();
    const P = loadPipeline(fake);
    await P.saveArchiveSales("百泽安", [{ n: 1 }]);
    await P.saveArchiveSales("百悦泽", [{ n: 2 }]);
    eq((await P.listArchiveProducts()).length, 2, "先有 2 个品种");
    eq(await P.removeArchiveSales("百泽安"), true, "removeArchiveSales 返回 true");
    const list = await P.listArchiveProducts();
    eq(list.length, 1, "删后剩 1 个品种");
    eq(list[0].product, "百悦泽", "剩下的是百悦泽");
  }

  console.log("\n===== [B] 接入点静态断言（app.js）=====");
  {
    const src = fs.readFileSync(path.join(R, "app.js"), "utf8");

    ok(/P\.archiveSupported\(\)/.test(src), "★ 分析流程**调用**了 archiveSupported()（它是函数，不是布尔值）");
    ok(!/P\.archiveSupported\s*[)&&]/.test(src.replace(/P\.archiveSupported\(\)/g, "P.archiveSupportedX")),
      "★ 不存在 `if (P.archiveSupported)` 这种「把函数当布尔值判断」的死守卫（恒真 = 守卫失效）");
    ok(/await P\.listArchiveProducts\(\)/.test(src), "分析流程调用了 listArchiveProducts");
    ok(/nowProducts\.filter\(p => archiveNames\.has\(p\)\)/.test(src),
      "只有「本次品种在本地有历史」时才算 nowHit（决定是否弹窗）");
    ok(/if \(nowHit\.length\) picked = await askArchiveProducts\(/.test(src),
      "★ 关键：nowHit 非空才弹窗 —— 本次品种全无历史时不弹");
    ok(/await P\.loadArchiveSalesFor\(picked\)/.test(src), "按勾选品种加载历史销售明细");
    ok(/if \(picked\.length\)[\s\S]{0,120}loadArchiveSalesFor/.test(src),
      "picked 为空时不调用加载（零副作用）");

    // 合并后统一去重
    ok(/let allSales = res\.sales;[\s\S]{0,200}allSales = res\.sales\.concat\(arc\.records\)/.test(src),
      "历史记录与本次合并进 allSales");
    ok(/const dd = P\.dedupSales\(allSales\)/.test(src),
      "★ 关键：去重作用于「本次+历史」的合并结果（重叠行自动去掉）");

    // 只带销售明细：随访/周期仍来自 res
    ok(/STORE\.followups = res\.followups;/.test(src), "随访只用本次（res.followups）");
    ok(/STORE\.cycles = res\.cycles;/.test(src), "周期只用本次（res.cycles）");
    ok(!/loadArchive[\s\S]{0,80}followup/i.test(src), "不存在加载历史随访的代码");
    ok(!/loadArchive[\s\S]{0,80}cycle/i.test(src), "不存在加载历史周期的代码");

    // 回写留档：只写本次出现的品种
    ok(/await saveArchiveByProduct\(dd\.records\)/.test(src), "回写留档用去重后的记录");
    const iFn = src.indexOf("async function saveArchiveByProduct");
    const seg = src.slice(iFn, iFn + 700);
    ok(/if \(!r \|\| !r\.product\) continue;/.test(seg), "写留档时跳过无品种的记录");
    ok(/byProd\.get\(r\.product\)\.push\(r\)/.test(seg), "按品种分组后逐品种写入");
    ok(!/removeArchiveSales/.test(src), "★ 不会删除未出现在本次数据里的品种留档（用户只传 A 不该删 B）");

    // 弹窗交互
    ok(/function askArchiveProducts\(/.test(src), "存在 askArchiveProducts 弹窗函数");
    ok(/const checked = new Set\(nowHit\)/.test(src), "默认勾选 = 本次品种中有历史的那些");
    ok(/olds = archiveAll\.filter\(a => !hitSet\.has\(a\.product\)\)/.test(src),
      "下半区列的是「历史里的其他品种」（排除本次已有历史的）");
    ok(/\$\("#arcOk"\)\.onclick = \(\) => close\(Array\.from\(checked\)\)/.test(src), "确定 → 返回勾选品种");
    ok(/\$\("#arcSkip"\)\.onclick = \(\) => close\(\[\]\)/.test(src), "不用历史 → 返回空数组");
    ok(/\$\("#arcTitle"\)\.textContent = `是否加载【\$\{nowHit\.join\("、"\)\}】的历史数据？`/.test(src),
      "标题文案：是否加载【品种】的历史数据？");
    ok(/data-prod="\$\{esc\(p\)\}"/.test(src), "品种写入 data-prod 时经 esc 转义");
    ok(/querySelectorAll\("input\[type=checkbox\]\[data-prod\]"\)/.test(src), "勾选态统一绑定");

    // 筛选：勾了历史品种才设筛选，否则清空（修掉残留 bug）
    ok(/state\.products = picked\.length \? new Set\(picked\) : new Set\(\);/.test(src),
      "★ 勾选历史品种 → 筛选设为已加载品种；未勾 → 清空（修复筛选残留）");
  }

  console.log("\n===== [C] 产物防线 =====");
  {
    for (const f of ["index.html", "index.single.html"]) {
      const s = fs.readFileSync(path.join(R, f), "utf8");
      ok(s.indexOf("loadArchiveSalesFor") >= 0, f + " 含 loadArchiveSalesFor");
      ok(s.indexOf("saveArchiveSales") >= 0, f + " 含 saveArchiveSales");
      ok(s.indexOf("askArchiveProducts") >= 0, f + " 含 askArchiveProducts");
      ok(s.indexOf('id="arcMask"') >= 0, f + " 含弹窗容器 #arcMask");
      ok(s.indexOf('id="arcListNow"') >= 0, f + " 含本次品种列表 #arcListNow");
      ok(s.indexOf('id="arcListOld"') >= 0, f + " 含历史其他品种列表 #arcListOld");
      ok(s.indexOf('id="arcOk"') >= 0 && s.indexOf('id="arcSkip"') >= 0, f + " 含两个按钮");
      ok(s.indexOf(".arc-mask") >= 0, f + " 含弹窗样式 .arc-mask");
      ok(s.indexOf("留档") >= 0, f + " 含「留档」目录名");
    }
  }

  console.log("\n通过 " + pass + " / " + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
