/* 本地留档管理器回归：静态断言 + 真实浏览器（jsdom）DOM 行为
 * 覆盖：入口按钮、清单渲染、逐品种删除、全部清空、导出备份、空态
 * 用 jsdom + 假 OPFS 复现 navigator.storage.getDirectory()，避免依赖真实浏览器存储。
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + (e && e.message)); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + (e && e.message)); fail++; }
}

console.log("== 本地留档管理器 ==");

/* ---------- 静态断言 ---------- */
t("HTML 含管理器弹窗与入口按钮", () => {
  for (const id of ["arcMgrMask", "arcMgrTitle", "arcMgrSub", "arcMgrStat", "arcMgrList",
                    "arcMgrEmpty", "arcMgrNote", "arcMgrExport", "arcMgrClearAll",
                    "arcMgrClose", "archiveMgrBtn"]) {
    assert.ok(HTML.includes('id="' + id + '"'), "缺元素 #" + id);
  }
});

t("管理器复用 arc-mask 遮罩样式（视觉与既有弹窗一致）", () => {
  assert.ok(/class="arc-mask hidden"\s+id="arcMgrMask"/.test(HTML), "弹窗未用 .arc-mask");
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.ok(/openArchiveManager/.test(app), "app.js 缺 openArchiveManager");
  assert.ok(/\$\("#archiveMgrBtn"\)\.onclick/.test(app), "未绑定入口按钮");
  assert.ok(/exportArchiveBackup/.test(app) && /clearAllArchive/.test(app),
    "缺导出/清空实现");
});

t("取消/关闭路径完备：关闭按钮 + 遮罩空白 + Esc", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.ok(/\$\("#arcMgrClose"\)\.onclick/.test(app), "缺关闭按钮绑定");
  assert.ok(/e\.target === \$\("#arcMgrMask"\)/.test(app), "缺「点遮罩空白关闭」");
  assert.ok(/e\.key === "Escape"/.test(app), "缺 Esc 关闭");
});

t("静态断言：清空有二次确认（confirm，且大量时要求输入「清空」）", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const i = app.indexOf("async function clearAllArchive()");
  assert(i >= 0, "缺 clearAllArchive");
  let d = 0, e = -1;
  for (let k = i; k < app.length; k++) {
    if (app[k] === "{") d++;
    else if (app[k] === "}") { d--; if (d === 0) { e = k + 1; break; } }
  }
  const body = app.slice(i, e);
  assert.ok(/confirm\(/.test(body), "缺 confirm 二次确认");
  assert.ok(/prompt\(/.test(body), "缺「输入清空」的防误触确认");
  assert.ok(/removeAllArchiveSales/.test(body), "未调用 removeAllArchiveSales");
});

t("静态断言：逐品种删除有 confirm 且调用 removeArchiveSales", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const i = app.indexOf("async function renderArchiveManager()");
  assert(i >= 0, "缺 renderArchiveManager");
  let d = 0, e = -1;
  for (let k = i; k < app.length; k++) {
    if (app[k] === "{") d++;
    else if (app[k] === "}") { d--; if (d === 0) { e = k + 1; break; } }
  }
  const body = app.slice(i, e);
  assert.ok(/confirm\(/.test(body), "删除缺 confirm");
  assert.ok(/removeArchiveSales\(/.test(body), "未调用 removeArchiveSales");
});

/* ---------- jsdom 真实 DOM 行为 ---------- */
let JSDOM;
try { JSDOM = require("jsdom").JSDOM; } catch (e) {
  console.log("\n  ⚠ 未安装 jsdom，跳过 DOM 行为测试（静态断言已覆盖结构）");
  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
}

// ---- 假 OPFS：内存目录，接口与 File System Access 的 OPFS 子集一致 ----
function makeFakeOpfs() {
  const files = new Map();   // "留档/销售/<品种>/sales.json" -> string
  const dirs = new Set(["留档", "留档/销售"]);
  const dirHandle = (p) => ({
    kind: "directory",
    async getDirectoryHandle(name, opt) {
      const np = p ? p + "/" + name : name;
      if (!dirs.has(np)) {
        if (!opt || !opt.create) throw new DOMException("NotFound", "NotFoundError");
        dirs.add(np);
      }
      return dirHandle(np);
    },
    async getFileHandle(name, opt) {
      const np = (p ? p + "/" : "") + name;
      if (!files.has(np)) {
        if (!opt || !opt.create) throw new DOMException("NotFound", "NotFoundError");
        files.set(np, "");
      }
      const fh = {
        kind: "file",
        async getFile() { return { async text() { return files.get(np) || ""; } }; },
        async createWritable() {
          let buf = "";
          return { async write(s) { buf = String(s); }, async close() { files.set(np, buf); } };
        },
      };
      return fh;
    },
    async removeEntry(name, opt) {
      const np = (p ? p + "/" : "") + name;
      let hit = false;
      for (const k of [...files.keys()]) if (k === np || k.startsWith(np + "/")) { files.delete(k); hit = true; }
      for (const k of [...dirs]) if (k === np || k.startsWith(np + "/")) { dirs.delete(k); hit = true; }
      if (!hit) throw new DOMException("NotFound", "NotFoundError");
    },
    async *entries() {
      const prefix = p ? p + "/" : "";
      const seen = new Set();
      for (const k of dirs) {
        if (!k.startsWith(prefix) || k === p) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes("/")) continue;
        if (seen.has(rest)) continue;
        seen.add(rest);
        yield [rest, dirHandle(k)];
      }
    },
  });
  return { root: dirHandle(""), files, dirs };
}

function boot(html, fake) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const w = dom.window;
  // 注入假 OPFS
  Object.defineProperty(w.navigator, "storage", {
    value: { async getDirectory() { return fake.root; }, async persist() { return false; } },
    configurable: true,
  });
  // jsdom 缺 PointerEvent，补一个最小实现（app.js 顶层不依赖它，仅拖拽用）
  if (!w.PointerEvent) w.PointerEvent = w.MouseEvent;
  // 依次执行脚本
  for (const f of ["vendor/xlsx.full.min.js", "mapping.js", "pipeline.js", "app.js"]) {
    const code = fs.readFileSync(path.join(ROOT, f), "utf8");
    try { w.eval(code); } catch (e) {
      throw new Error("加载 " + f + " 失败: " + e.message);
    }
  }
  return { dom, w };
}

async function main() {
  const fake = makeFakeOpfs();
  const { w } = boot(HTML, fake);
  const A = w.AppCore, P = w.Pipeline;
  assert.ok(A && P, "AppCore/Pipeline 未挂载");
  assert.ok(A.openArchiveManager, "openArchiveManager 未导出");
  assert.ok(A.renderArchiveManager, "renderArchiveManager 未导出");

  const $ = (id) => w.document.getElementById(id);
  w.confirm = () => true;
  w.alert = () => {};
  w.prompt = () => "清空";

  // 造留档：两个品种
  const mk = (day, ticket, prod) => ({
    source: "sales", _row_id: "f::sales::S::" + day + ticket,
    sales_time: "2026-" + day, product: prod, product_raw: prod,
    ticket_no: ticket, qty: "1", pharmacy: "某药房",
    patient_name: "张三", phone: "13800001111", member_id: "M1",
  });
  await P.saveArchiveSales("百泽安", [mk("08-01", "T1", "百泽安"), mk("08-02", "T2", "百泽安")]);
  await P.saveArchiveSales("百悦泽", [mk("08-03", "T3", "百悦泽")]);

  await ta("打开管理器：列出品种与条数", async () => {
    await A.openArchiveManager();
    assert.ok(!$("arcMgrMask").classList.contains("hidden"), "弹窗未显示");
    const txt = $("arcMgrList").textContent;
    assert.ok(txt.includes("百泽安"), "缺 百泽安：" + txt);
    assert.ok(txt.includes("百悦泽"), "缺 百悦泽：" + txt);
    assert.ok(/共 2 个品种/.test($("arcMgrStat").textContent),
      "统计不对：" + $("arcMgrStat").textContent);
    assert.ok(/3 条销售记录/.test($("arcMgrStat").textContent),
      "总条数应为 3：" + $("arcMgrStat").textContent);
    assert.ok(!$("arcMgrEmpty").classList.contains("hidden") === false, "非空态不应显示空提示");
  });

  await ta("弹窗列出「无磁盘文件夹」的说明（避免用户去找文件夹）", async () => {
    const n = $("arcMgrNote").textContent;
    assert.ok(/OPFS/.test(n) || /浏览器私有/.test(n), "缺 OPFS 说明：" + n);
    assert.ok(/导出备份/.test(n), "缺「用导出备份」的指引");
  });

  await ta("逐品种删除：只删该品种，其它品种保留", async () => {
    const btns = [...$("arcMgrList").querySelectorAll("button.arc-del")];
    assert.strictEqual(btns.length, 2, "应有 2 个删除按钮");
    const target = btns.find(b => b.dataset.del === "百泽安");
    assert.ok(target, "找不到 百泽安 的删除按钮");
    target.click();
    await new Promise(r => setTimeout(r, 300));
    const left = await P.listArchiveProducts();
    assert.strictEqual(left.length, 1, "应剩 1 个品种，实际 " + left.length);
    assert.strictEqual(left[0].product, "百悦泽", "剩下的应是 百悦泽");
    assert.ok(/百泽安/.test($("arcMgrList").textContent) === false, "百泽安 应已从清单消失");
  });

  await ta("导出备份：产出含 products 与 records 的 JSON", async () => {
    let captured = null;
    const origCreate = w.URL.createObjectURL;
    w.URL.createObjectURL = (blob) => { captured = blob; return "blob:fake"; };
    // 捕获下载文件名
    let fname = null;
    const origClick = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () { fname = this.download; };
    await A.exportArchiveBackup();
    w.URL.createObjectURL = origCreate;
    w.HTMLAnchorElement.prototype.click = origClick;
    assert.ok(captured, "未创建 Blob");
    const text = await captured.text();
    const obj = JSON.parse(text);
    assert.strictEqual(obj.kind, "repurchase_dashboard_archive", "kind 不对");
    assert.ok(Array.isArray(obj.products), "缺 products");
    assert.ok(Array.isArray(obj.records), "缺 records");
    assert.strictEqual(obj.records.length, 1, "应导出剩余 1 条");
    assert.ok(/留档备份/.test(fname || ""), "文件名不对：" + fname);
  });

  await ta("全部清空：留档归零并显示空态", async () => {
    await A.clearAllArchive();
    await new Promise(r => setTimeout(r, 200));
    const left = await P.listArchiveProducts();
    assert.strictEqual(left.length, 0, "应已清空，实际剩 " + left.length);
    assert.ok(!$("arcMgrEmpty").classList.contains("hidden"), "应显示空态提示");
    assert.strictEqual($("arcMgrClearAll").disabled, true, "空态下清空按钮应禁用");
    assert.strictEqual($("arcMgrExport").disabled, true, "空态下导出按钮应禁用");
  });

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("测试异常：", e); process.exit(1); });
