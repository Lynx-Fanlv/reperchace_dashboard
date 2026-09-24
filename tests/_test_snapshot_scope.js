// 快照「品种范围 + 去小结 + 隐藏脱敏开关」回归验证
// 覆盖：
//   [1] snapshotFileName 文件名带品种标识
//   [2] askSnapshotFams 品种选择弹窗（默认勾选当前筛选项 / 全选 / 清空 / 取消 / 确定 / 确定禁用）
//   [3] doSnapshot 只内嵌所选品种的行 + snapFams 记录内嵌品种全集
//   [4] 快照 HTML 中整体小结面板已移除、脱敏开关整条已隐藏、分类维护面板仍保留
//   [5] 快照内仍可按品种筛选（含取消勾选后能勾回来）
//   [6] 打开快照后沿用生成时的脱敏状态
const fs = require('fs');
const path = require('path');

// ---------- 简化 DOM stub（本次新增逻辑只依赖极少数接口） ----------
function makeEl(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: id || '',
    _html: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, children: [], className: '',
    classList: { _s: new Set(),
      add(...c) { c.forEach(x => { this._s.add(x); el.className = [...this._s].join(' '); }); },
      remove(...c) { c.forEach(x => { this._s.delete(x); el.className = [...this._s].join(' '); }); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { on ? this._s.add(c) : this._s.delete(c); } el.className = [...this._s].join(' '); },
      contains(c) { return this._s.has(c) || String(el.className).split(/\s+/).includes(c); } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); if (c) c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      // 按 HTML 建出子节点（够本次新增逻辑用）
      this.children = [];
      const inp = /<input[^>]*>/g; let m;
      while ((m = inp.exec(this._html))) {
        const vm = /value="([^"]*)"/.exec(m[0]);
        const b = makeEl('input'); b.value = vm ? vm[1] : ''; b.checked = /\schecked/.test(m[0]);
        b.parentNode = this; this.children.push(b);
      }
      const btnRe = /<(button|a)[^>]*data-act="([^"]*)"[^>]*>/g;
      while ((m = btnRe.exec(this._html))) {
        const b = makeEl(m[1]); b.dataset = { act: m[2] }; b.onclick = null;
        this._byAct = this._byAct || {}; this._byAct[m[2]] = b;
        b.parentNode = this; this.children.push(b);
      }
    },
    querySelectorAll(sel) {
      const s = String(sel || '');
      // .fp-item input → 品种勾选框；.fp-tools a → 全选/清空
      if (s.includes('.fp-tools')) return this.children.filter(c => c.tagName === 'A' && c.dataset && c.dataset.act);
      if (s.includes('input') || s.includes('.fp-item')) return this.children.filter(c => c.tagName === 'INPUT');
      return [];
    },
    querySelector(sel) {
      const m = /\[data-act="([^"]*)"\]/.exec(String(sel || ''));
      if (m) {
        if (this._byAct && this._byAct[m[1]]) return this._byAct[m[1]];
        const hit = this.children.find(c => c.dataset && c.dataset.act === m[1]);
        if (hit) return hit;
      }
      const idm = /^#(.+)$/.exec(String(sel || ''));
      if (idm) return makeEl('div', idm[1]);
      return makeEl('div', (id || '') + '>child');
    },
    parentNode: null, nextSibling: null, nextElementSibling: null,
    onclick: null, onchange: null, oninput: null, onmousedown: null,
  };
  return el;
}

// 记录被移除/放回哪个父节点（验证「移除小结 → 再放回」不影响其它节点）
const elStore = {};
function regEl(id) { if (!elStore[id]) elStore[id] = makeEl('div', id); return elStore[id]; }

// body 需要真实的 appendChild/removeChild（弹窗挂这里）
const bodyEl = makeEl('body', 'body');
// 快照生成时按真实 DOM 走：documentElement.outerHTML 由被移除后的树序列化出来
// 这里用一个可序列化的假树模拟：docRoot 只含 #summaryPanel 与 #desenBar 等关键节点
const docRoot = makeEl('html', 'html');

global.window = global;
global.document = {
  querySelector(sel) { return regEl(String(sel).replace(/^#/, '')); },
  querySelectorAll(sel) {
    const s = String(sel);
    // doSnapshot 的需要：script 列表（无库可剥离 → 空数组即可）
    if (s === 'script') return [];
    return [];
  },
  getElementById(id) { return regEl(id); },
  addEventListener() {}, removeEventListener() {},
  createElement(tag) { return makeEl(tag); },
  documentElement: docRoot,
  body: bodyEl,
};
let captured = null, captureName = '';
global.URL = { createObjectURL(b) { captured = b; return 'blob:x'; }, revokeObjectURL() {} };
global.Blob = function (parts, opts) { this.parts = parts; this.opts = opts; };
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.alert = () => {};
global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const App = global.AppCore;
const S = App.state;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  PASS ' + name + ' -> ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL ' + name + ' -> 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' -> ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
};

// 三品种测试行
const mkRow = (fam, name, phone) => ({
  _key: phone, product: fam, patient_name: name, phone, physician: '李大夫',
  hospital: 'H1', pharmacy: 'P1', member_id: 'M' + phone, status: '应回购',
  repur_part: '应回未回', reason: '', days_to_due: 2, due_in_week: true, qty: 1,
});
const ROWS = [
  mkRow('百泽安', '张小三', '13800000001'),
  mkRow('百泽安', '张小四', '13800000002'),
  mkRow('百悦泽', '李四', '13800000003'),
  mkRow('索托克拉', '王五', '13800000004'),
];

(async () => {
  console.log('\n=== 快照品种范围 / 去小结 / 隐藏脱敏开关 ===');

  // ---------------------------------------------------------------
  console.log('\n[1] snapshotFileName 文件名带品种标识');
  eq('单品种', App.snapshotFileName(true, ['百泽安']), '预计购药名单_百泽安_脱敏快照.html');
  eq('两品种', App.snapshotFileName(true, ['百泽安', '百悦泽']), '预计购药名单_百泽安+百悦泽_脱敏快照.html');
  eq('三品种', App.snapshotFileName(false, ['A', 'B', 'C']), '预计购药名单_A+B+C_不脱敏快照.html');
  eq('四品种→多品种', App.snapshotFileName(true, ['A', 'B', 'C', 'D']), '预计购药名单_多品种_脱敏快照.html');
  eq('空范围→不带品种', App.snapshotFileName(true, []), '预计购药名单_脱敏快照.html');
  eq('非法字符被清理', App.snapshotFileName(true, ['A/B:C']), '预计购药名单_ABC_脱敏快照.html');

  // ---------------------------------------------------------------
  console.log('\n[2] askSnapshotFams 弹窗行为');
  App.DATA.rows = ROWS.slice();
  App.state.products = new Set();       // 未筛品种 → 默认全选
  let p = App.askSnapshotFams();
  await Promise.resolve();
  let overlay = bodyEl.children[bodyEl.children.length - 1];
  // 注意：overlay.classList 是 stub 的 Set 语义，askSnapshotFams 用 `overlay.className = "..."`
  // 直接赋值（非 classList.add），故这里同时接受两种判定方式
  ok('弹窗已挂到 body 且带 fam-pick-mask 类',
    !!overlay && (overlay.className === 'fam-pick-mask' || overlay.classList.contains('fam-pick-mask')),
    overlay && String(overlay._html).length + ' 字节');
  let boxes = realBoxes(overlay);
  eq('品种清单 = 全部 3 个品种（去重升序）', boxes.map(b => b.value), ['百悦泽', '百泽安', '索托克拉'].sort((a, b) => a.localeCompare(b, 'zh')));
  ok('未筛品种 → 默认全选', boxes.every(b => b.checked));
  // 取消
  overlay.querySelector('[data-act="cancel"]').onclick();
  eq('点「取消」→ 返回 null', await p, null);

  // 已筛品种 → 默认只勾这些
  App.state.products = new Set(['百泽安']);
  p = App.askSnapshotFams();
  await Promise.resolve();
  overlay = bodyEl.children[bodyEl.children.length - 1];
  boxes = realBoxes(overlay);
  eq('已筛「百泽安」→ 默认只勾该品种', boxes.filter(b => b.checked).map(b => b.value), ['百泽安']);
  // 全选 / 清空
  overlay.querySelector('[data-act="all"]').onclick();
  ok('点「全选」→ 全勾', boxes.every(b => b.checked));
  overlay.querySelector('[data-act="none"]').onclick();
  ok('点「清空」→ 全不勾', boxes.every(b => !b.checked));
  syncByInput(overlay, boxes);   // stub 需手抄 checked → syncNum 的读数
  ok('未选任何品种时「确定」被禁用', overlay.querySelector('[data-act="ok"]').disabled === true);
  // 勾两个再确定
  boxes.find(b => b.value === '百泽安').checked = true;
  boxes.find(b => b.value === '百悦泽').checked = true;
  syncByInput(overlay, boxes);
  const okBtn = overlay.querySelector('[data-act="ok"]');
  ok('已勾选后「确定」可用', okBtn.disabled === false);
  okBtn.onclick();
  eq('确定 → 返回勾选的品种', (await p).sort(), ['百悦泽', '百泽安'].sort());
  App.state.products = new Set();
  App.DATA.rows = ROWS.slice();

  // ---------------------------------------------------------------
  console.log('\n[3] doSnapshot 只内嵌所选品种 + snapFams 记录范围');
  // 拦截 document.createElement('script') 的 textContent 写入，从中取回 __SNAP__ 对象
  let snapObj = null;
  const origCreate = document.createElement;
  document.createElement = tag => {
    const el = makeEl(tag);
    if (tag === 'script') {
      Object.defineProperty(el, 'textContent', {
        configurable: true,
        get() { return this._tc || ''; },
        set(v) {
          this._tc = v;
          const m = /^window\.__SNAP__=([\s\S]*)$/.exec(String(v));
          if (m) { try { snapObj = JSON.parse(m[1].replace(/\\u003c/g, '<')); } catch (e) {} }
        },
      });
    }
    return el;
  };
  // 驱动一次完整的「生成快照」：启动 → 弹窗里勾品种 → 确定 → 取回快照对象
  const doSnapWith = async (fams, desen) => {
    snapObj = null; captured = null;
    const pr = App.doSnapshot(desen !== false);
    await Promise.resolve();                       // 让 askSnapshotFams 先把弹窗建出来
    const ov = bodyEl.children[bodyEl.children.length - 1];
    const bs = realBoxes(ov);
    bs.forEach(b => { b.checked = fams.includes(b.value); if (b.onchange) b.onchange(); });
    ov.querySelector('[data-act="ok"]').onclick();
    await pr;
    return snapObj;
  };

  let snap = await doSnapWith(['百泽安']);
  ok('单品种快照：只含百泽安的行', snap && snap.rows.every(r => r.product === '百泽安'), snap ? snap.rows.length + ' 行' : 'null');
  eq('单品种快照行数 = 2', snap.rows.length, 2);
  eq('snapFams = 内嵌品种全集', snap.state.snapFams, ['百泽安']);
  eq('初始品种筛选 = 本次范围', snap.state.products, ['百泽安']);

  snap = await doSnapWith(['百泽安', '百悦泽']);
  eq('双品种快照行数 = 3', snap.rows.length, 3);
  eq('双品种 snapFams', snap.state.snapFams, ['百悦泽', '百泽安'].sort((a, b) => a.localeCompare(b, 'zh')));
  ok('不再内嵌「索托克拉」的行', !snap.rows.some(r => r.product === '索托克拉'));

  // ---------------------------------------------------------------
  console.log('\n[4] 快照对象结构：不含小结文本，但保留原因分类树');
  ok('未保存 summaryText（小结已取消）', snap.summaryText === undefined);
  ok('保留了 reasonTree（否则原因列只显示 key）', !!snap.state.reasonTree);
  ok('保留了 summary 统计（卡片计数随筛选）', !!snap.summary && typeof snap.summary.total === 'number');

  // ---------------------------------------------------------------
  console.log('\n[5] 快照内仍可按品种筛选（取消勾选后能勾回来）');
  // 构造快照：只含 百泽安/百悦泽，但 snapFams 记录两者
  const rows2 = ROWS.filter(r => r.product !== '索托克拉').map(r => Object.assign({}, r));
  App.loadSnapshot({
    desen: true, rows: rows2, notes: {}, reasonOverrides: {},
    summary: App.buildSummary(rows2), buildAt: new Date().toISOString(),
    state: { weekSel: 'this', refDate: '', snapFams: ['百悦泽', '百泽安'], products: ['百悦泽', '百泽安'], maskMode: 'edge' },
  });
  eq('打开快照 → 行数 = 3', App.DATA.rows.length, 3);
  eq('snapFams 已恢复', S.snapFams, ['百悦泽', '百泽安']);
  // 只筛「百泽安」
  S.products.clear(); S.products.add('百泽安'); await App.refresh();
  eq('快照内筛「百泽安」→ 2 行', App.DATA.rows.length, 2);
  // 取消勾选 → 回到全量（关键：选项清单不含被筛掉的品种，但取消后必须能回来）
  S.products.clear(); await App.refresh();
  eq('清空品种筛选 → 恢复快照全量 3 行', App.DATA.rows.length, 3);
  // 只筛「百悦泽」
  S.products.add('百悦泽'); await App.refresh();
  eq('快照内筛「百悦泽」→ 1 行', App.DATA.rows.length, 1);

  // ---------------------------------------------------------------
  console.log('\n[6] 打开快照沿用生成时的脱敏状态');
  App.loadSnapshot({
    desen: true, rows: rows2.map(r => Object.assign({}, r)), notes: {}, reasonOverrides: {},
    summary: App.buildSummary(rows2), buildAt: new Date().toISOString(),
    state: { weekSel: 'this', refDate: '', snapFams: ['百泽安'], products: ['百泽安'],
      plainName: true, plainDoctor: false, plainPhone: true, maskMode: 'first' },
  });
  eq('plainName 沿用生成时', S.plainName, true);
  eq('plainDoctor 沿用生成时', S.plainDoctor, false);
  eq('plainPhone 沿用生成时', S.plainPhone, true);
  eq('maskMode 沿用生成时', S.maskMode, 'first');
  const r0 = App.DATA.rows[0];
  eq('姓名按「不脱敏」呈明文', App.disp(r0, 'patient_name'), r0.patient_name);
  eq('医生按「脱敏 + 保留首字」呈掩码', App.disp(r0, 'physician'), '李**');

  // ---------------------------------------------------------------
  console.log('\n[7] 构建产物中的静态保证（产物必须与源码一致）');
  for (const f of ['index.html', 'index.single.html']) {
    const pth = path.join(__dirname, '..', f);
    if (!fs.existsSync(pth)) { console.log('  ⏭️  ' + f + ' 不存在，跳过'); continue; }
    const code = fs.readFileSync(pth, 'utf8');
    ok(f + '：含 askSnapshotFams（品种弹窗）', code.includes('askSnapshotFams'));
    ok(f + '：含 snapshotFileName（文件名带品种）', code.includes('snapshotFileName'));
    ok(f + '：含 snapFams（快照内品种选项清单）', code.includes('snapFams'));
    ok(f + '：含小结面板移除逻辑', code.includes('summaryPanel') && code.includes('sumParent'));
    ok(f + '：含脱敏开关整条隐藏', code.includes('desenBar'));
    ok(f + '：脱敏开关栏带 id="desenBar"', code.includes('id="desenBar"'));
    ok(f + '：品种弹窗样式已内联', code.includes('.fam-pick-mask'));
    // 旧行为必须已消失
    ok(f + '：旧的 summaryText 保存逻辑已移除', !code.includes('summaryText: SUMMARY.text'));
    ok(f + '：旧文件名写法已移除', !code.includes('"预计购药名单_脱敏快照.html"'));
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

// 从弹窗的 label 列表里取出品种 checkbox
function realBoxes(overlay) {
  return overlay.children.filter(c => c.tagName === 'INPUT' && String(c.value) !== '');
}
// stub 里 checkbox 的 onchange 不会自动触发，需手抄 checked 状态给 syncNum
function syncByInput(overlay, boxes) {
  boxes.forEach(b => { if (typeof b.onchange === 'function') b.onchange(); });
}
