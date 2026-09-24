// 端到端验证：用真实 DOM（jsdom）跑一遍「生成快照 → 打开快照」的全链路
// 目的：确认快照 HTML 里 ①整体小结已消失 ②脱敏开关整条已消失 ③品种筛选可用 ④分类维护面板保留
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(resolveJsdom());

// jsdom 不在本项目内，安装于隔离的 node 工作区。加载顺序：
//   1) NODE_PATH（由运行器注入）
//   2) 项目本地 node_modules（若有人自行安装）
//   3) 固定兜底路径（本机 WorkBuddy 隔离工作区）
function resolveJsdom() {
  const tried = [];
  const bases = [process.env.NODE_PATH, path.join(__dirname, '..', 'node_modules'),
    'C:\\Users\\yym\\.workbuddy\\binaries\\node\\workspace\\node_modules'];
  for (const b of bases) {
    if (!b) continue;
    const p = path.join(b, 'jsdom');
    if (fs.existsSync(p)) return p;
    tried.push(p);
  }
  console.error('找不到 jsdom。已尝试：\n  ' + tried.join('\n  ') +
    '\n请设置 NODE_PATH 指向含 jsdom 的 node_modules 后重跑本测试。');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' -> ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
};
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  PASS ' + name + ' -> ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL ' + name + ' -> 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};

(async () => {
  console.log('\n=== 端到端：快照生成与打开（真实 DOM） ===');

  // 用 jsdom 载入真实 index.html（vendor 外链不加载，Excel 解析库由测试直接注入）
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  // 注入库（pipeline 依赖 XLSX / ExcelJS 仅在导出时用，这里给最小桩即可）
  w.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const alertMsgs = []; w.alert = m => alertMsgs.push(String(m));

  // 页面脚本带 defer/普通 script：等一个 tick 让 mapping/pipeline/app 都执行完
  await new Promise(r => setTimeout(r, 60));
  const App = w.AppCore;
  ok('页面脚本已加载（window.AppCore 存在）', !!App);
  if (!App) { console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }

  // 抓取 download 产生的 HTML 文本
  let snapHtml = null, snapName = '';
  const origCreateObjURL = w.URL.createObjectURL;
  w.URL.createObjectURL = blob => {
    snapHtml = blob.__text !== undefined ? blob.__text : null;
    return 'blob:mock';
  };
  // jsdom 的 Blob 不保留文本，改用 FileReader 兼容：直接拦截 Blob 构造
  const OrigBlob = w.Blob;
  w.Blob = function (parts, opts) {
    const b = new OrigBlob(parts, opts);
    b.__text = parts.map(p => String(p)).join('');
    return b;
  };
  // download() 里 a.click() 会触发 jsdom 导航告警 → 屏蔽
  const origClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { snapName = this.download || ''; };

  // 造数据：两个品种
  const mkRow = (fam, name, phone) => ({
    _key: phone, product: fam, patient_name: name, phone, physician: '李大夫',
    hospital: 'H1', pharmacy: 'P1', member_id: 'M' + phone, status: '应回购',
    repur_part: '应回未回', reason: '', days_to_due: 2, due_in_week: true, qty: 1,
    last_purchase: '2026-08-01', cycle_days: 21, due_date: '2026-09-24', fu_signal: '', fu_signal_kind: 'unknown',
  });
  const rows = [mkRow('百泽安', '张小三', '13800000001'), mkRow('百悦泽', '李四', '13800000002')];
  // 通过内部接口注入：先设 DATA，再让 refresh 不重建（SNAP 之外的路径）
  App.STORE.sales = [];
  App.STORE.followups = [];
  App.state.stdCycle = { 百泽安: 21, 百悦泽: 28 };
  // 用 loadSnapshot 之外的方式设置全量行：直接写 DATA 并阻止 buildRows 覆盖
  // buildRows 依赖 STORE，空 STORE 会返回空数组 → 直接给 ALL_ROWS 注入不可行，
  // 因此这里改为直接构造快照对象来验证「打开快照」侧，生成侧用 doSnapshot 的真实 DOM 路径单独验证。

  console.log('\n[1] 快照 HTML 生成：小结与脱敏开关确实被移除');
  // 直接调用 doSnapshot，但先让 DATA.rows 有数据（doSnapshot 只读 DATA.rows）
  App.DATA.rows = rows.map(r => Object.assign({}, r));
  // 品种弹窗需要 ALL_ROWS；用 refresh 之外的入口不可行，改为直接走弹窗交互
  const pr = App.doSnapshot(true);
  await new Promise(r => setTimeout(r, 30));
  const mask = w.document.querySelector('.fam-pick-mask');
  ok('品种选择弹窗已出现', !!mask);
  if (mask) {
    const boxes = [...mask.querySelectorAll('input[type=checkbox]')];
    eq('弹窗列出 2 个品种', boxes.map(b => b.value).sort(), ['百悦泽', '百泽安'].sort());
    // 只勾「百泽安」
    boxes.forEach(b => { b.checked = (b.value === '百泽安'); if (b.onchange) b.onchange(); });
    const okBtn = mask.querySelector('[data-act="ok"]');
    ok('「确定」可用（已勾选）', !okBtn.disabled);
    okBtn.click();
  }
  await pr;
  await new Promise(r => setTimeout(r, 30));

  ok('已产出快照 HTML', !!snapHtml, snapHtml ? snapHtml.length + ' 字节' : 'null');
  ok('文件名带品种标识', snapName === '预计购药名单_百泽安_脱敏快照.html', snapName);
  if (snapHtml) {
    ok('快照 HTML 中「整体小结」面板已移除', !snapHtml.includes('id="summaryPanel"'));
    ok('快照 HTML 中「小结文本」节点也已移除', !snapHtml.includes('id="summaryText"'));
    ok('快照 HTML 中脱敏开关栏（desenBar）仍在（打开时会隐藏）', snapHtml.includes('id="desenBar"'));
    ok('快照 HTML 中保留「分类维护」面板（原因标签渲染需要它）', snapHtml.includes('id="reasonManager"'));
    ok('快照 HTML 内嵌 __SNAP__ 数据', snapHtml.includes('window.__SNAP__='));
    // 剥离逻辑核对：用真实解析器数「活的」脚本标签，避免被 app.js 源码里的字符串字面误判
    const domS = new JSDOM(snapHtml);
    const liveLibs = [...domS.window.document.querySelectorAll('script')]
      .filter(s => /vendor\/(xlsx|exceljs)\.min\.js$/.test(s.getAttribute('src') || '') ||
        ['__vnd_xlsx__', '__vnd_exceljs__'].includes(s.id));
    ok('快照中无 Excel 解析库脚本节点', liveLibs.length === 0,
      liveLibs.map(s => s.getAttribute('src') || s.id).join(',') || '无');
    // xlsx 对象本身仍可能残留在页面上（供导出用），这里只关心脚本标签已摘除
    // 数据脚本恰好 1 个：判据要严格（只认以 window.__SNAP__= 开头的），
    // 因为 boot 脚本里也含 "window.__SNAP__" 字面（做存在性判断用）
    const liveDataScripts = [...domS.window.document.querySelectorAll('script')]
      .filter(s => /^\s*window\.__SNAP__=/.test(s.textContent || ''));
    eq('快照注入的数据脚本恰好 1 个', liveDataScripts.length, 1);
    // boot 脚本判据：以 IIFE 开头且调用 AppCore.loadSnapshot（排除数据脚本里 JSON 字符串偶然含该片段）
    const bootScripts = [...domS.window.document.querySelectorAll('script')]
      .filter(s => /^\s*\(function\s*\(\)\s*\{/.test(s.textContent || '') &&
        (s.textContent || '').includes('window.AppCore.loadSnapshot'));
    eq('快照启动脚本恰好 1 个', bootScripts.length, 1);
    // 解析内嵌数据：从末尾的注入脚本抓（app.js 源码内也含 </script> 字面，不能用非贪婪匹配）
    const marker = 'window.__SNAP__=';
    const start = snapHtml.lastIndexOf(marker);
    const end = snapHtml.indexOf('</scr' + 'ipt>', start);
    ok('可定位到注入的快照数据脚本', start > 0 && end > start);
    const raw = snapHtml.slice(start + marker.length, end).trim();
    let snap = null;
    try { snap = JSON.parse(raw.replace(/\\u003c/g, '<')); } catch (e) { console.log('   [dbg] JSON 解析失败: ' + e.message); }
    ok('可解析出快照数据', !!snap);
    if (snap) {
      eq('快照只含「百泽安」的行', [...new Set(snap.rows.map(r => r.product))], ['百泽安']);
      eq('snapFams = 本次范围', snap.state.snapFams, ['百泽安']);
      ok('快照不含 summaryText', snap.summaryText === undefined);
      ok('快照内的姓名已脱敏', snap.rows[0].patient_name !== '张小三', JSON.stringify(snap.rows[0].patient_name));
    }
  }

  console.log('\n[2] 打开这份快照：脱敏开关隐藏、小结不显示、品种筛选可用');
  if (snapHtml) {
    const dom2 = new JSDOM(snapHtml, { runScripts: 'dangerously', pretendToBeVisual: true });
    const w2 = dom2.window;
    w2.XLSX = w.XLSX;
    w2.alert = m => alertMsgs.push(String(m));
    await new Promise(r => setTimeout(r, 80));
    const A2 = w2.AppCore;
    ok('快照里的应用脚本已跑起来', !!A2);
    if (A2) {
      const doc2 = w2.document;
      eq('快照名单 = 1 行（只有百泽安）', A2.DATA.rows.length, 1);
      // 脱敏开关整条：元素在，但带 hidden 类
      const db = doc2.querySelector('#desenBar');
      ok('脱敏开关栏存在但处于隐藏态', !!db && db.classList.contains('hidden'), db ? db.className : 'missing');
      // 小结面板：已被移除
      eq('整体小结面板已不存在', doc2.querySelector('#summaryPanel'), null);
      // 分类维护面板：保留且隐藏
      const rm = doc2.querySelector('#reasonManager');
      ok('分类维护面板保留且隐藏（不随小结被移除）', !!rm && rm.classList.contains('hidden'));
      // 脱敏状态沿用生成时（默认脱敏）
      ok('快照沿用生成时的脱敏状态（默认脱敏 → 姓名已打码）',
        A2.DATA.rows[0].patient_name !== '张小三', JSON.stringify(A2.DATA.rows[0].patient_name));
      // 品种筛选仍可用：面板选项应含内嵌品种
      A2.state.products.clear(); await A2.refresh();
      const prodPanel = doc2.querySelector('#prodMsList');
      const labels = prodPanel ? [...prodPanel.querySelectorAll('label')].map(l => l.textContent) : [];
      ok('快照「品种」面板仍有选项', labels.length > 0, labels.join(' / '));
      eq('快照全量行数', A2.DATA.rows.length, 1);
    }
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
