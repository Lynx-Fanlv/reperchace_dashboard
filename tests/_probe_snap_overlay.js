// 诊断：快照 HTML 里是否被固化了「操作期浮层」（品种选择弹窗 / 加载遮罩）
// 现象：导出的快照打开后浮着「选择快照包含的品种」，且取消/确定都无法关闭
//       （快照是静态 HTML，弹窗的事件绑定在序列化前就已丢失，节点却留在了 DOM 里）
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(resolveJsdom());
function resolveJsdom() {
  const bases = [process.env.NODE_PATH, path.join(__dirname, '..', 'node_modules'),
    'C:\\Users\\yym\\.workbuddy\\binaries\\node\\workspace\\node_modules'];
  for (const b of bases) { if (!b) continue; const p = path.join(b, 'jsdom'); if (fs.existsSync(p)) return p; }
  console.error('找不到 jsdom'); process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  w.alert = () => {};
  await new Promise(r => setTimeout(r, 60));
  const App = w.AppCore;

  let snapHtml = null, snapName = '';
  const OrigBlob = w.Blob;
  w.Blob = function (parts, opts) {
    const b = new OrigBlob(parts, opts);
    b.__text = parts.map(p => String(p)).join('');
    return b;
  };
  w.URL.createObjectURL = blob => { snapHtml = blob.__text !== undefined ? blob.__text : null; return 'blob:mock'; };
  w.HTMLAnchorElement.prototype.click = function () { snapName = this.download || ''; };

  const mkRow = (fam, name, phone) => ({
    _key: phone, product: fam, patient_name: name, phone, physician: '李大夫',
    hospital: 'H1', pharmacy: 'P1', member_id: 'M' + phone, status: '应回购',
    repur_part: '应回未回', reason: '', days_to_due: 2, due_in_week: true, qty: 1,
    last_purchase: '2026-08-01', cycle_days: 21, due_date: '2026-09-24', fu_signal: '', fu_signal_kind: 'unknown',
  });
  App.DATA.rows = [mkRow('百泽安', '张小三', '13800000001'), mkRow('百悦泽', '李四', '13800000002')];

  const pr = App.doSnapshot(false);
  await new Promise(r => setTimeout(r, 30));
  const mask = w.document.querySelector('.fam-pick-mask');
  console.log('生成时页面上有弹窗：', !!mask);
  if (mask) {
    [...mask.querySelectorAll('input[type=checkbox]')].forEach(b => { b.checked = true; if (b.onchange) b.onchange(); });
    mask.querySelector('[data-act="ok"]').click();
  }
  await pr;
  await new Promise(r => setTimeout(r, 30));

  console.log('产出快照：', snapName, snapHtml ? snapHtml.length + ' 字节' : 'null');
  if (!snapHtml) process.exit(1);

  const d2 = new JSDOM(snapHtml);
  const doc = d2.window.document;
  const staleMask = doc.querySelector('.fam-pick-mask');
  const loading = doc.getElementById('loading');
  console.log('---- 快照内固化的浮层 ----');
  console.log('  品种弹窗 .fam-pick-mask :', staleMask ? '存在（会被静态显示，且无事件绑定 → 关不掉）' : '不存在');
  if (staleMask) console.log('    内容首行：', staleMask.textContent.replace(/\s+/g, ' ').slice(0, 60));
  console.log('  加载遮罩 #loading.class :', loading ? JSON.stringify(loading.className) : '不存在');
  console.log('  加载遮罩文案            :', loading ? JSON.stringify(loading.textContent.trim()) : '-');
  const stale = (staleMask ? 1 : 0) + (loading && !/(^|\s)hidden(\s|$)/.test(loading.className) ? 1 : 0);
  console.log('\n结论：' + (stale ? '❌ 固化了 ' + stale + ' 个操作期浮层' : '✅ 干净'));
  process.exit(stale ? 2 : 0);
})().catch(e => { console.error(e); process.exit(1); });
