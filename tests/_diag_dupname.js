// 诊断：重名（同名异电话）与随访/周期表的姓名索引串味
//
// 回答三个问题：
//  (a) 「同名不同电话」的每组是不同人还是同一人换号？→ 看日期区间是否重叠、医院/药房是否互斥
//  (b) 「姓名或电话为空」的记录长什么样、会塌缩成什么键
//  (c) 随访匹配 fuIndex 在电话查不到时会退回「只按姓名」→ 重名患者会共用同一批随访记录
//  (d) 周期表 STORE.cycles 是按姓名索引的 → 重名患者共用同一个自定义周期
//
// 用法：
//   node tests/_diag_dupname.js
//   set SALES_FILE=销售明细查询报表 (8).xlsx
//   set FU_FILE=xxx.xlsx        # 可选，指定随访文件；默认自动挑「随访*.xlsx」
const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(os.homedir(), 'Downloads');

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

const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
const norm = s => String(s == null ? '' : s).trim();
const keyNow = r => digits(r.phone) || (norm(r.patient_name) || '未知');

function pick(prefix, extRe) {
  if (process.env.SALES_FILE && prefix === '销售明细查询报表') return path.join(SAMPLE_DIR, process.env.SALES_FILE);
  if (process.env.FU_FILE && prefix !== '销售明细查询报表') return path.join(SAMPLE_DIR, process.env.FU_FILE);
  const cands = fs.readdirSync(SAMPLE_DIR)
    .filter(f => f.startsWith(prefix) && extRe.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SAMPLE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return cands.length ? path.join(SAMPLE_DIR, cands[0].f) : null;
}
const fileObj = p => {
  const buf = fs.readFileSync(p);
  return { name: path.basename(p), size: buf.length,
    async arrayBuffer(){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } };
};

(async () => {
  const salesPath = pick('销售明细查询报表', /\.xlsx?$/i);
  if (!salesPath) { console.log('没找到销售明细文件'); process.exit(1); }
  console.log('=== 重名 / 空值 / 姓名索引串味 诊断 ===');
  console.log('销售明细:', path.basename(salesPath));

  const sheets = await P.loadWorkbook(fileObj(salesPath));
  const sh = sheets.find(s => s.ttype === 'sales');
  const recs = P.normalizeSheet('sales', sh.rows, sh.cols, sh.source_file || '', sh.sheet_name || '')
    .filter(r => r.sales_time && r.product);

  // ---------- (a) 同名不同电话：是不同人还是同一人换号？ ----------
  console.log('\n[1] 「同名不同电话」逐组明细（判据：日期区间是否重叠 / 医院是否互斥）');
  const byName = {};
  for (const r of recs) {
    const n = norm(r.patient_name);
    if (!n) continue;
    (byName[n] = byName[n] || {})[digits(r.phone)] = byName[n][digits(r.phone)] || [];
    byName[n][digits(r.phone)].push(r);
  }
  const dupNames = Object.keys(byName).filter(n => Object.keys(byName[n]).length > 1);
  console.log('  重名组数:', dupNames.length);
  dupNames.forEach(n => {
    console.log('  ── 姓名「' + n + '」');
    const phones = Object.keys(byName[n]);
    const info = phones.map(p => {
      const rs = byName[n][p];
      const ds = rs.map(x => x.sales_time).sort();
      const hs = [...new Set(rs.map(x => norm(x.hospital) || '(空)'))];
      return { p, rs, first: ds[0], last: ds[ds.length - 1], hs };
    });
    info.forEach(i => {
      console.log('     电话 ' + (i.p || '(无电话)').padEnd(13) +
        i.rs.length.toString().padStart(3) + ' 条  ' + i.first + ' ~ ' + i.last +
        '   医院: ' + i.hs.join(' / '));
    });
    // 两两判断日期是否重叠
    for (let i = 0; i < info.length; i++) {
      for (let j = i + 1; j < info.length; j++) {
        const A = info[i], B = info[j];
        const overlap = !(A.last < B.first || B.last < A.first);
        const t1 = overlap ? '日期区间【重叠】→ 更像同期的两个人' : '日期区间不重叠 → 可能同一人换号（先后关系）';
        console.log('       ↳ ' + (A.p || '(无电话)') + ' vs ' + (B.p || '(无电话)') + ': ' + t1);
      }
    }
  });

  // ---------- (b) 姓名 / 电话为空 ----------
  console.log('\n[2] 姓名或电话为空的记录');
  const empties = recs.filter(r => !norm(r.patient_name) || !digits(r.phone));
  console.log('  条数:', empties.length, '/', recs.length);
  const bucket = {};
  empties.forEach(r => {
    const k = (!norm(r.patient_name) ? '无姓名' : '有姓名') + '+' + (!digits(r.phone) ? '无电话' : '有电话');
    (bucket[k] = bucket[k] || []).push(r);
  });
  Object.keys(bucket).forEach(k => {
    const rs = bucket[k];
    const keys = [...new Set(rs.map(keyNow))];
    console.log('  ' + k + ': ' + rs.length + ' 条  →  塌缩成 ' + keys.length + ' 个键' +
      (keys.length < rs.length ? '  ⚠ 误合并' : ''));
    console.log('     键: ' + keys.slice(0, 5).map(x => '「' + x + '」').join(' ') +
      '   样例品种: ' + [...new Set(rs.map(x => x.product))].slice(0, 5).join(','));
    rs.slice(0, 4).forEach(x => console.log('       · ' + x.sales_time + '  ' + (norm(x.patient_name) || '(空名)') +
      '  ' + (norm(x.phone) || '(空话)') + '  ' + x.product + '  医院:' + (norm(x.hospital) || '(空)')));
  });

  // ---------- (c) 随访按姓名回退导致的重名串味 ----------
  console.log('\n[3] 随访匹配：电话查不到时退回「只按姓名」→ 重名患者可能共用随访记录');
  const fuPath = pick('随访', /\.xlsx?$/i);
  let followups = [];
  if (fuPath) {
    const fs2 = await P.loadWorkbook(fileObj(fuPath));
    const shf = fs2.find(s => s.ttype === 'followup');
    if (shf) followups = P.normalizeSheet('followup', shf.rows, shf.cols, shf.source_file || '', shf.sheet_name || '');
    console.log('  随访文件:', path.basename(fuPath), ' 记录数:', followups.length);
  } else {
    console.log('  （没找到随访文件，跳过）');
  }
  if (followups.length) {
    // 重建 app.js 的 fuByKey / fuByName 索引
    const fuByKey = {}, fuByName = {};
    for (const fu of followups) {
      const k = digits(fu.phone);
      const nm = norm(fu.patient_name);
      if (k) (fuByKey[k] = fuByKey[k] || []).push(fu);
      if (nm) (fuByName[nm] = fuByName[nm] || []).push(fu);
    }
    // 随访表里同名但不同电话
    const fuNamePhones = {};
    for (const fu of followups) {
      const n = norm(fu.patient_name);
      if (n) (fuNamePhones[n] = fuNamePhones[n] || new Set()).add(digits(fu.phone));
    }
    const fuDupNames = Object.keys(fuNamePhones).filter(n => fuNamePhones[n].size > 1);
    console.log('  随访表中「同名多电话」组数:', fuDupNames.length);
    fuDupNames.slice(0, 15).forEach(n => {
      const phones = [...fuNamePhones[n]];
      console.log('     「' + n + '」 电话: ' + phones.map(p => p || '(无)').join(', ') +
        '  记录数: ' + phones.map(p => ((fuByKey[p] || fuByName[n] || []).length)).join(' / '));
      // 模拟：销售侧该姓名下每个电话取随访会拿到什么
    });
    // 关键的串味检测：销售侧两个不同电话的重名患者，是否都回退到同一份随访（因为按电话查不到）
    console.log('\n  串味检测（销售侧重名患者，其电话在随访表中不存在 → 会退回按姓名取同一份随访）:');
    let collide = 0;
    dupNames.forEach(n => {
      const phones = Object.keys(byName[n]);
      const owners = phones.map(p => {
        const byPhone = p && fuByKey[p] ? fuByKey[p] : null;
        const byNameHit = fuByName[n] || [];
        return { p, usedKey: byPhone ? '电话' : (byNameHit.length ? '姓名(回退)' : '无'), list: byPhone || byNameHit };
      });
      const fellBack = owners.filter(o => o.usedKey === '姓名(回退)');
      if (fellBack.length >= 2) {
        collide++;
        console.log('    ⚠ 「' + n + '」 有 ' + fellBack.length + ' 个电话都回退到同一份随访（' +
          fellBack[0].list.length + ' 条）: 电话 ' + fellBack.map(o => o.p).map(x => x || '(无)').join(', '));
      } else if (fellBack.length === 1) {
        console.log('    · 「' + n + '」 1 个电话回退按姓名取随访: 电话 ' + fellBack[0].p +
          '（可能拿到另一个同名患者的随访）');
      }
    });
    console.log('  严重串味（2 个以上同名患者共用同一份随访）组数:', collide);
  }

  // ---------- (d) 周期表按姓名索引 ----------
  console.log('\n[4] 周期表 STORE.cycles 按「姓名」索引 → 重名患者共用同一个自定义周期');
  const cyPath = pick('周期', /\.xlsx?$/i);
  if (cyPath) {
    const fs3 = await P.loadWorkbook(fileObj(cyPath));
    const shc = fs3.find(s => s.ttype === 'cycle');
    if (shc) {
      const cyRecs = P.normalizeSheet('cycle', shc.rows, shc.cols, shc.source_file || '', shc.sheet_name || '');
      console.log('  周期表:', path.basename(cyPath), ' 记录数:', cyRecs.length);
      console.log('  周期表列:', shc.cols.join(' | '));
      const cyNames = {};
      cyRecs.forEach(r => { const n = norm(r.patient_name); if (n) (cyNames[n] = cyNames[n] || []).push(r); });
      const cyDup = Object.keys(cyNames).filter(n => cyNames[n].length > 1);
      console.log('  周期表内同名多条:', cyDup.length);
      cyDup.slice(0, 10).forEach(n => console.log('    「' + n + '」 ' +
        cyNames[n].map(r => norm(r.phone) || '(无电话)').join(', ')));
      // 与销售侧重名交集
      const hit = Object.keys(cyNames).filter(n => dupNames.includes(n));
      console.log('  与销售侧重名交集（周期会串味）:', hit.length, hit.slice(0, 10).join(', '));
    } else {
      console.log('  未识别出周期表');
    }
  } else {
    console.log('  （没找到周期表文件，跳过）');
  }

  // ---------- (e) 名单核对：重名患者在列表里占几行 ----------
  console.log('\n[5] 名单核对：重名患者在列表里是几行');
  const S = App.state, ST = App.STORE;
  S.refDate = '2026-09-24'; S.weekSel = 'this'; S.stdCycle = {}; S.qtyScale = {};
  S.cycleAlgo = 'reset'; S.reasonTree = App.cloneReasonTree(App.DEFAULT_REASON_TREE);
  S.cats.clear(); S.reasons.clear(); S.repurParts.clear();
  S.products.clear(); S.hospitals.clear(); S.pharmacies.clear(); S.executors.clear();
  S.q = '';
  ST.cycles = {}; ST.reasonOverrides = {}; ST.notes = {}; ST.followups = followups;
  ST.sales = recs.slice();
  const rows = App.buildRows();
  console.log('  名单行数（患者×品种）:', rows.length, '  唯一 _key 数:', new Set(rows.map(r => r._key)).size);
  dupNames.forEach(n => {
    const rs = rows.filter(r => norm(r.patient_name) === n);
    const keys = [...new Set(rs.map(r => r._key))];
    console.log('  「' + n + '」占 ' + rs.length + ' 行，_key 有 ' + keys.length + ' 个  → ' +
      (keys.length > 1 ? '已被拆成 ' + keys.length + ' 个患者（未合并）' : '⚠ 合并成了 1 个患者'));
    rs.forEach(r => console.log('      · key=' + r._key.padEnd(13) + ' 品种=' + r.product +
      '  最近购药=' + (r.last_buy || '-') + '  医院=' + (r.hospital || '-')));
  });

  // ---------- (f) 随访匹配来源：电话命中 vs 姓名回退 ----------
  console.log('\n[6] 随访匹配来源（姓名回退是重名串味的真正入口）');
  const fuK = {}, fuN = {};
  for (const fu of followups) {
    const k = digits(fu.phone), nm = norm(fu.patient_name);
    if (k) (fuK[k] = fuK[k] || []).push(fu);
    if (nm) (fuN[nm] = fuN[nm] || []).push(fu);
  }
  const salesNamePhones = {};
  recs.forEach(r => {
    const n = norm(r.patient_name);
    if (n) (salesNamePhones[n] = salesNamePhones[n] || new Set()).add(digits(r.phone));
  });
  let viaPhone = 0, viaName = 0, viaNameRisky = 0;
  const risk = [];
  rows.forEach(r => {
    const k = digits(r.phone);
    if (k && fuK[k]) { viaPhone++; return; }
    if (r.patient_name && fuN[r.patient_name]) {
      viaName++;
      const ps = salesNamePhones[norm(r.patient_name)];
      if (ps && ps.size > 1) { viaNameRisky++; risk.push(r); }
    }
  });
  console.log('  电话命中                        :', viaPhone, '行');
  console.log('  姓名回退命中（电话查不到）      :', viaName, '行');
  console.log('  其中该姓名在销售侧不唯一 ⚠      :', viaNameRisky, '行  ← 这些会拿到同名他人的随访');
  risk.slice(0, 20).forEach(r => console.log('      ⚠ ' + r.patient_name + ' (' + r.phone + ')  品种=' + r.product));
})();
