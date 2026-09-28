// 诊断：患者唯一键口径 —— 重名是否被误合并成一个患者
//
// 背景：app.js 现有取键规则是「有电话就用电话，没电话退回只用姓名」
//        const keyOf = r => phoneDigits(r.phone) || (r.patient_name || "未知");
//        → 电话为空的记录里，同名的不同人会被折叠成一个患者。
//
// 本脚本在真实销售明细上量化两个方向的误差：
//   A) 误合并（over-merge）：同一个键下出现了多个不同的 (姓名, 电话) 组合
//      —— 这正是「重名被错误识别为单个患者」。
//   B) 误合并（同电话不同名）：同一电话被不同姓名共用（家人共用号码 / 录错姓名），
//      现有口径会合并，改成「姓名+电话」后会拆开。
//
// 用法：
//   node tests/_diag_patient_key.js
//   set SAMPLE_DIR=D:\data
//   set SALES_FILE=销售明细查询报表 (16).xlsx
const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(os.homedir(), 'Downloads');

// ---------- 最小 DOM stub ----------
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

const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
const norm = s => String(s == null ? '' : s).trim();
// 现有口径：电话优先，无电话退回姓名
const keyNow = r => digits(r.phone) || (norm(r.patient_name) || '未知');
// 拟改口径：姓名 + 电话（两者都参与）
const keyNew = r => (norm(r.patient_name) || '未知') + '\u0000' + digits(r.phone);

// ---- 多文件扫描模式：node tests/_diag_patient_key.js --all ----
async function scanAll() {
  const files = fs.readdirSync(SAMPLE_DIR)
    .filter(f => /^销售明细查询报表.*\.xlsx?$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SAMPLE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  console.log('=== 多文件扫描：患者唯一键误差 ===');
  console.log('目录:', SAMPLE_DIR, '  文件数:', files.length);
  console.log('');
  console.log('文件'.padEnd(34) + '记录   人数  电话空  同名异话  同话异名  误合并组');
  console.log('-'.repeat(88));
  for (const { f } of files) {
    try {
      const sheets = await P.loadWorkbook(fileObj(path.join(SAMPLE_DIR, f)));
      const sh = sheets.find(s => s.ttype === 'sales');
      if (!sh) { console.log(f.slice(0, 32).padEnd(34) + '（未识别出销售表）'); continue; }
      const recs = P.normalizeSheet('sales', sh.rows, sh.cols, sh.source_file || '', sh.sheet_name || '')
        .filter(r => r.sales_time && r.product);
      const noPhone = recs.filter(r => !digits(r.phone)).length;
      const byNow = {};
      for (const r of recs) {
        const k = keyNow(r);
        (byNow[k] = byNow[k] || new Map()).set(norm(r.patient_name) + '\u0000' + digits(r.phone), 1);
      }
      const merged = Object.keys(byNow).filter(k => byNow[k].size > 1).length;
      // 同名异电话：同一姓名对应多个电话
      const byName = {};
      for (const r of recs) { const n = norm(r.patient_name); if (n) (byName[n] = byName[n] || new Set()).add(digits(r.phone)); }
      const sameNameDiffPhone = Object.keys(byName).filter(n => byName[n].size > 1).length;
      // 同电话异名
      const byPh = {};
      for (const r of recs) { const p = digits(r.phone); if (p) (byPh[p] = byPh[p] || new Set()).add(norm(r.patient_name)); }
      const samePhoneDiffName = Object.keys(byPh).filter(p => byPh[p].size > 1).length;
      console.log(f.slice(0, 32).padEnd(34) +
        String(recs.length).padStart(6) +
        String(Object.keys(byNow).length).padStart(6) +
        String(noPhone).padStart(8) +
        String(sameNameDiffPhone).padStart(10) +
        String(samePhoneDiffName).padStart(10) +
        String(merged).padStart(10));
    } catch (e) {
      console.log(f.slice(0, 32).padEnd(34) + '读取失败: ' + e.message);
    }
  }
}

(async () => {
  if (process.argv.includes('--all')) { await scanAll(); return; }
  const salesPath = pickSalesFile();
  console.log('=== 患者唯一键口径诊断 ===');
  console.log('样例文件:', path.basename(salesPath));

  const sheets = await P.loadWorkbook(fileObj(salesPath));
  const sh = sheets.find(s => s.ttype === 'sales');
  if (!sh) { console.log('未识别出销售表！', sheets.map(s => s.ttype)); process.exit(1); }
  const recs = P.normalizeSheet('sales', sh.rows, sh.cols, sh.source_file || '', sh.sheet_name || '')
    .filter(r => r.sales_time && r.product);

  console.log('\n[1] 基础情况：有效销售记录', recs.length, '条');
  const noPhone = recs.filter(r => !digits(r.phone));
  const noName  = recs.filter(r => !norm(r.patient_name));
  const noBoth  = recs.filter(r => !digits(r.phone) && !norm(r.patient_name));
  const pct = n => (recs.length ? (n * 100 / recs.length).toFixed(1) : '0.0') + '%';
  console.log('   电话为空 :', noPhone.length, '(' + pct(noPhone.length) + ')   ← 现有口径下这些记录退化为「仅姓名」键');
  console.log('   姓名为空 :', noName.length, '(' + pct(noName.length) + ')');
  console.log('   两者都空 :', noBoth.length);

  console.log('\n[2] 误差 A：现有键下「一个键 → 多个不同(姓名,电话)」= 误合并');
  const byNow = {};
  for (const r of recs) {
    const k = keyNow(r);
    (byNow[k] = byNow[k] || new Map()).set(norm(r.patient_name) + '\u0000' + digits(r.phone), r);
  }
  const merged = Object.keys(byNow).filter(k => byNow[k].size > 1);
  let mergedPairs = 0;
  for (const k of merged) mergedPairs += byNow[k].size - 1;
  console.log('   受影响的键数 :', merged.length);
  console.log('   被吞掉的患者数:', mergedPairs);
  console.log('   样例（前 12 组）：');
  merged.slice(0, 12).forEach(k => {
    const pairs = [...byNow[k].keys()].map(s => {
      const [n, p] = s.split('\u0000');
      return (n || '(空名)') + ' / ' + (p || '(无电话)');
    });
    console.log('    键「' + k + '」 → ' + pairs.join('   ‖   '));
  });

  console.log('\n[3] 误差 B：同一电话被多个姓名共用 → 现有口径合并，改成姓名+电话后会拆开');
  const byPhone = {};
  for (const r of recs) {
    const p = digits(r.phone);
    if (!p) continue;
    (byPhone[p] = byPhone[p] || new Set()).add(norm(r.patient_name));
  }
  const sharedPhone = Object.keys(byPhone).filter(p => byPhone[p].size > 1);
  console.log('   共用一个电话的姓名组数:', sharedPhone.length);
  sharedPhone.slice(0, 12).forEach(p => {
    console.log('    电话「' + p + '」 → ' + [...byPhone[p]].map(n => n || '(空名)').join('   ‖   '));
  });

  console.log('\n[4] 患者数对比');
  const nNow = Object.keys(byNow).length;
  const nNew = new Set(recs.map(keyNew)).size;
  console.log('   现有口径（电话优先/退化姓名）患者数:', nNow);
  console.log('   拟改口径（姓名 + 电话）      患者数:', nNew);
  console.log('   差量:', nNew - nNow, nNew > nNow ? '（拟改口径把被误合并的拆开了）' : '（无变化）');

  console.log('\n[5] 改动后可能被拆开的患者（同电话不同名 / 同名异电话）——逐个列出供人工判定');
  // 只列「现有口径下是一个患者，拟改口径下会变成多个」的情形
  const groups = {};
  for (const r of recs) {
    const oldK = keyNow(r), newK = keyNew(r);
    (groups[oldK] = groups[oldK] || new Set()).add(newK);
  }
  const affected = Object.keys(groups).filter(k => groups[k].size > 1);
  console.log('   受影响的患者数:', affected.length);
  affected.slice(0, 20).forEach(k => {
    const recsOf = recs.filter(r => groups[keyNow(r)] === groups[k] && keyNow(r) === k);
    const detail = {};
    recsOf.forEach(r => {
      const nk = keyNew(r);
      (detail[nk] = detail[nk] || []).push(r);
    });
    console.log('    现有患者「' + k + '」将被拆为 ' + Object.keys(detail).length + ' 人：');
    Object.keys(detail).forEach(nk => {
      const rs = detail[nk];
      const [n, p] = nk.split('\u0000');
      const dates = rs.map(x => x.sales_time).sort();
      const prods = [...new Set(rs.map(x => x.product))];
      console.log('       · ' + (n || '(空名)') + ' / ' + (p || '(无电话)') +
        '   ' + rs.length + ' 条  品种[' + prods.join(',') + ']  ' + dates[0] + '~' + dates[dates.length - 1]);
    });
  });

  console.log('\n[5b] 只看「电话为空」导致的误合并（最可能是你说的那种）');
  const emptyPhoneMerged = merged.filter(k => !/^\d+$/.test(k));
  console.log('   键本身不是纯数字（即走的是姓名退化键）:', emptyPhoneMerged.length, '组');
  emptyPhoneMerged.slice(0, 20).forEach(k => {
    const pairs = [...byNow[k].keys()].map(s => { const [n, p] = s.split('\u0000'); return (n || '(空名)') + '/' + (p || '(无电话)'); });
    console.log('    键「' + k + '」 → ' + pairs.join('   ‖   '));
  });
})();
