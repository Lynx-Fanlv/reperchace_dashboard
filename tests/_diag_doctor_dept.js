// 诊断：列表里「医院 / 科室 / 医生」的取值是否等于「该患者该品种销售时间最末次那条记录」的值
//
// 用途：定位「末次记录明明有值，界面却显示别的值」这类问题。
// 分别算出三种口径并对比 buildRows() 的实际结果：
//   strictLast    = 销售时间最大那条记录的值（可能为空）
//   lastNonEmpty  = 销售时间最大的、该字段非空的那条记录的值
//   实际(界面)     = App.buildRows() 的 rows[i][field]
//
// 用法：
//   node tests/_diag_doctor_dept.js
//   set SAMPLE_DIR=D:\data            # 指定样例目录（默认当前用户 Downloads）
//   set SALES_FILE=销售明细查询报表 (16).xlsx   # 指定文件名（默认自动挑最新的「销售明细查询报表*.xlsx」）
const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(os.homedir(), 'Downloads');

// ---------- 最小 DOM stub（与其它测试一致） ----------
function makeEl(id) {
  return { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, insertBefore(){}, removeChild(){}, querySelectorAll(){ return []; },
    click(){}, remove(){},
    querySelector(){ return makeEl(id + '>child'); }, parentNode: { insertBefore(){} },
    nextElementSibling: null, onclick: null, onchange: null, oninput: null };
}
global.window = global;
global.document = {
  querySelector(sel){ return makeEl(String(sel)); },
  querySelectorAll(){ return []; },
  addEventListener(){}, createElement(){ return makeEl('created'); },
  documentElement: { outerHTML: '<html></html>' }, body: { appendChild(){}, remove(){}, removeChild(){} },
};
global.URL = { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} };
global.XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));
global.alert = () => {}; global.confirm = () => true;
const load = f => (new Function(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')))();
load('mapping.js'); load('pipeline.js'); load('app.js');
const P = global.Pipeline, App = global.AppCore;
const S = App.state, ST = App.STORE;

// 挑样例文件：优先 SALES_FILE，否则选最新的「销售明细查询报表*.xlsx」
function pickSalesFile() {
  if (process.env.SALES_FILE) return path.join(SAMPLE_DIR, process.env.SALES_FILE);
  const cands = fs.readdirSync(SAMPLE_DIR)
    .filter(f => /^销售明细查询报表.*\.xlsx?$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SAMPLE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!cands.length) throw new Error('在 ' + SAMPLE_DIR + ' 下没找到「销售明细查询报表*.xlsx」');
  return path.join(SAMPLE_DIR, cands[0].f);
}
const fileObj = p => {
  const buf = fs.readFileSync(p);
  return { name: path.basename(p), size: buf.length,
    async arrayBuffer(){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } };
};
// 与 app.js 内一致的取键规则（优先电话，无电话退回姓名）
const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
const keyOf = r => digits(r.phone) || (r.patient_name || '未知');

(async () => {
  const salesPath = pickSalesFile();
  console.log('=== 医生 / 科室 / 医院 取值诊断 ===');
  console.log('样例文件:', path.basename(salesPath));

  // ---------- 1. 列映射：到底选中了哪一列 ----------
  const sheets = await P.loadWorkbook(fileObj(salesPath));
  const sh = sheets.find(s => s.ttype === 'sales');
  if (!sh) { console.log('未识别出销售表！sheets =', sheets.map(s => s.ttype)); process.exit(1); }

  // 注意：sh.cols 是「表头名字数组」，映射结果要用 mapColumns 现算
  console.log('\n[1] 销售表列映射');
  const colmap = P.mapColumns('sales', sh.cols); // {field: idx | [idx...]}
  const fieldOf = {};
  Object.keys(colmap).forEach(f => {
    const cs = colmap[f];
    (Array.isArray(cs) ? cs : [cs]).forEach(c => { fieldOf[c] = f; });
  });
  for (const f of ['hospital', 'physician', 'department', 'pharmacy']) {
    const cs = colmap[f];
    const idxs = cs == null ? [] : (Array.isArray(cs) ? cs : [cs]);
    console.log('  ' + f.padEnd(11), '→',
      idxs.length ? idxs.map(i => '[' + i + '] ' + sh.cols[i]).join('  ,  ') : '✗ 未命中');
  }
  console.log('  —— 所有标题含「医生 / 科室」的列及其归属（检查是否有该用却没用上的列）：');
  sh.cols.forEach((h, i) => {
    if (/医生|科室/.test(String(h).replace(/\s+/g, ''))) {
      console.log('    [' + String(i).padStart(2) + '] ' + String(h).slice(0, 20).padEnd(22), '→', fieldOf[i] || '✗ 未命中');
    }
  });

  // ---------- 2. 归一化销售记录 ----------
  const recs = P.normalizeSheet('sales', sh.rows, sh.cols, sh.source_file || '', sh.sheet_name || '');
  console.log('\n[2] 归一化销售记录数:', recs.length);
  const filled = k => recs.filter(r => r[k] && String(r[k]).trim()).length;
  for (const k of ['sales_time', 'patient_name', 'phone', 'product', 'hospital', 'pharmacy', 'physician', 'department']) {
    console.log('  ', k.padEnd(12), '有值:', filled(k), '/', recs.length);
  }

  // ---------- 3. buildRows ----------
  S.refDate = '2026-09-24';
  S.weekSel = 'this';
  S.stdCycle = {};
  S.qtyScale = {};
  S.cycleAlgo = 'reset';
  S.reasonTree = App.cloneReasonTree(App.DEFAULT_REASON_TREE);
  S.cats.clear(); S.reasons.clear(); S.repurParts.clear();
  S.products.clear(); S.hospitals.clear(); S.pharmacies.clear(); S.executors.clear();
  S.q = '';
  ST.cycles = {}; ST.reasonOverrides = {}; ST.notes = {}; ST.followups = [];
  ST.sales = recs.slice();
  const rows = App.buildRows();
  console.log('\n[3] buildRows 产出行数:', rows.length);

  // 同一患者同品种是否被拆成多行（电话键与姓名键不一致时会拆开，看起来就像「取错了值」）
  const byNameProd = {};
  rows.forEach(r => {
    const k = (r.patient_name || '') + '\u0000' + r.product;
    (byNameProd[k] = byNameProd[k] || new Set()).add(r._key);
  });
  const split = Object.keys(byNameProd).filter(k => byNameProd[k].size > 1);
  console.log('  同一患者同品种被拆成多行（键不一致）:', split.length);
  split.slice(0, 8).forEach(k => {
    console.log('    ', k.replace('\u0000', ' / '), '→ 键:', [...byNameProd[k]].join('  ,  '));
  });

  // ---------- 4. 独立复算三种口径并对比 ----------
  const grp = {};
  for (const r of recs) {
    if (!r.sales_time || !r.product) continue;
    const k = keyOf(r) + '\u0000' + r.product;
    (grp[k] = grp[k] || []).push(r);
  }
  const FIELDS = ['hospital', 'department', 'physician'];
  const bad = [];
  let multi = 0;
  for (const row of rows) {
    const k = (row._key || '') + '\u0000' + row.product;
    const list = grp[k];
    if (!list || !list.length) continue;
    if (list.length < 2) continue;   // 只看多次购药，单次无争议
    multi++;
    // 按销售时间排序（升序），末位即最末次；时间相同时以文件后出现者为末
    const sorted = list.map((r, i) => ({ r, i })).sort((a, b) =>
      a.r.sales_time < b.r.sales_time ? -1 : a.r.sales_time > b.r.sales_time ? 1 : a.i - b.i);
    const last = sorted[sorted.length - 1].r;
    for (const f of FIELDS) {
      const strictLast = last[f] || '';
      let lastNonEmpty = '';
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].r[f]) { lastNonEmpty = sorted[i].r[f]; break; }
      }
      const actual = row[f] || '';
      // 现行口径：界面值必须严格等于「销售时间最末次那条记录」的值（该条为空则为空）
      if (actual !== strictLast) {
        bad.push({ row, f, actual, strictLast, lastNonEmpty, sorted, patient: row.patient_name, product: row.product,
          lastDate: last.sales_time });
      }
    }
  }
  console.log('多次购药的患者×品种行数:', multi);

  if (!bad.length) {
    console.log('\n✅ 所有多次购药的行：医院/科室/医生 都严格等于「销售时间最末次那条记录」的值');
    console.log('   （口径：末次记录该字段为空时，界面即为空 —— 不再回退到更早的非空值）');
  } else {
    console.log('\n⚠️ 发现 ' + bad.length + ' 处不一致：\n');
    // 按患者聚合输出，避免刷屏
    const byPat = {};
    for (const b of bad) {
      const k = b.patient + ' / ' + b.product;
      (byPat[k] = byPat[k] || []).push(b);
    }
    let shown = 0;
    for (const k in byPat) {
      if (shown++ >= 8) { console.log('…（其余略）'); break; }
      const b0 = byPat[k][0];
      console.log('— 患者: ' + k);
      console.log('  该患者该品种的销售记录（按销售时间升序）:');
      for (const { r } of b0.sorted) {
        console.log('    ' + String(r.sales_time).padEnd(12) +
          ' 医院=' + String(r.hospital || '∅').padEnd(14) +
          ' 科室=' + String(r.department || '∅').padEnd(12) +
          ' 医生=' + String(r.physician || '∅'));
      }
      for (const b of byPat[k]) {
        console.log('  字段 ' + b.f + '：界面=' + JSON.stringify(b.actual) +
          ' | 末次记录=' + JSON.stringify(b.strictLast) +
          ' | 末次非空=' + JSON.stringify(b.lastNonEmpty) +
          '  (末次日期 ' + b.lastDate + ')');
      }
      console.log('');
    }
  }

  // ---------- 5. 关键对照：行内值 vs「患者整体最末次购药记录」（不限品种） ----------
  // 列表是「患者 × 品种」一行，医生/科室取自【该品种】的末次购药；
  // 若患者不同品种的最近购药时间不同，就会与「患者整体末次」不一致。
  console.log('\n[5] 对照「患者整体最末次购药记录（不限品种）」');
  const patLast = {};
  for (const r of recs) {
    if (!r.sales_time) continue;
    const k = keyOf(r);
    const cur = patLast[k];
    if (!cur || r.sales_time > cur.sales_time) patLast[k] = r;
  }
  const diffRows = [];
  for (const row of rows) {
    const pl = patLast[row._key];
    if (!pl) continue;
    if (pl.product === row.product) continue; // 同品种已由 [4] 覆盖
    const diffs = [];
    for (const f of FIELDS) {
      const a = row[f] || '', b = pl[f] || '';
      if (a !== b) diffs.push(f + '：行内=' + JSON.stringify(a) +
        ' ，患者整体末次=' + JSON.stringify(b));
    }
    if (diffs.length) diffRows.push({ row, pl, diffs });
  }
  console.log('  「行内值 ≠ 患者整体末次记录值」的行数:', diffRows.length, '/ 总行数', rows.length);
  diffRows.slice(0, 6).forEach(d => {
    console.log('  — ' + d.row.patient_name + ' / ' + d.row.product);
    console.log('     该行(该品种末次): 日期=' + d.row.last_purchase +
      ' 医院=' + (d.row.hospital || '∅') + ' 科室=' + (d.row.department || '∅') +
      ' 医生=' + (d.row.physician || '∅'));
    console.log('     患者整体末次    : 日期=' + d.pl.sales_time + ' 品种=' + d.pl.product +
      ' 医院=' + (d.pl.hospital || '∅') + ' 科室=' + (d.pl.department || '∅') +
      ' 医生=' + (d.pl.physician || '∅'));
    d.diffs.forEach(x => console.log('       · ' + x));
  });
})().catch(e => { console.error('FAIL', e); process.exit(1); });
