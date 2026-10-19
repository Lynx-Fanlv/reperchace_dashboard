// 「跟进备注」列在任何状态下都必须可见、可编辑 —— 回归测试
//
// 用户报障（2026-09-30）：「导出的随访回传表，传回网页后并没有自动识别到患者状态和随访跟进并填入网页」，
// 选定症状为「备注/原因没回到列表」。实测其中一条成因：
//   备注单元格早先只在 status ∈ {应回购, 已逾期} 时渲染 <input>，其余状态整格返回「—」。
//   于是「上一轮填过、经回传表接续回来」的备注，若本轮状态变成「未到期」，会整条消失 ——
//   数据其实一直在 STORE.notes 里，只是不渲染，用户以为丢了。
// 用户决定（2026-09-30）：**任何状态都能编辑**（不再按状态卡备注列）。
//
// 本测试用真实 DOM（jsdom 载入构建产物 index.html）渲染三种状态的行，断言备注框都在、且回填了内容。
// 顺带做产物哨兵：确认 index.html / index.single.html 里都是新写法。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(resolveJsdom());

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
  console.error('找不到 jsdom。已尝试：\n  ' + tried.join('\n  '));
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? ' → ' + extra : ''));
};
const eq = (name, got, want) => {
  const c = JSON.stringify(got) === JSON.stringify(want);
  ok(name, c, c ? JSON.stringify(got) : '实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
};

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  w.alert = () => {};
  await new Promise(r => setTimeout(r, 60));
  const App = w.AppCore;
  ok('页面脚本已加载（window.AppCore 存在）', !!App);
  if (!App) { console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }

  // 三种状态各一行；都预先存了备注
  const mk = (name, status, repurPart, note) => {
    const phone = '1380000000' + (Math.floor(Math.random() * 9) + 1);
    const _key = name + '\u0000' + phone;
    const r = {
      _key, product: '百泽安', patient_name: name, phone, physician: '李大夫',
      hospital: 'H1', pharmacy: 'P1', member_id: 'M' + phone,
      status, repur_part: repurPart, reason: '', days_to_due: 2, due_in_week: false,
      qty: 1, last_purchase: '2026-08-01', cycle_days: 21, due_date: '2026-09-24',
      fu_signal: '', fu_signal_kind: 'unknown', executor: '', fu_type: '', fu_time: '', fu_note: '',
    };
    App.STORE.notes[_key + '::' + r.product] = note;
    return r;
  };
  const rows = [
    mk('甲应回购', '应回购', '应回未回', '甲：本周五来'),
    mk('乙已逾期', '已逾期', '', '乙：电话未接通'),
    mk('丙未到期', '未到期', '', '丙：上轮填过的备注，本轮未到期也要看得见'),
  ];
  // 另有一行「没有任何备注」，用于确认空备注行照样可输入
  const blank = mk('丁空备注', '未到期', '', '');
  blank._key = '丁空备注\u0000' + '13800000009';
  delete App.STORE.notes[blank._key + '::' + blank.product];
  rows.push(blank);

  // 直接铺 DATA.rows 并渲染（不经过 buildRows，避免依赖销售数据）
  App.STORE.sales = []; App.STORE.followups = [];
  App.DATA.rows = rows;
  App.state.page = 1; App.state.pageSize = 100;
  App.renderTable();

  const trs = [...w.document.querySelectorAll('#tbody tr.data-row')];
  eq('渲染出 4 行', trs.length, 4);

  const info = trs.map(tr => {
    const idx = Number(tr.dataset.idx);
    const r = rows[idx];
    const inp = tr.querySelector('input.note-input');
    return { name: r.patient_name, status: r.status, hasInput: !!inp,
             disabled: inp ? !!inp.disabled : null, value: inp ? inp.value : null };
  });
  console.log('  渲染结果 = ' + JSON.stringify(info));

  for (const it of info) {
    ok('「' + it.name + '」（' + it.status + '）有跟进备注输入框', it.hasInput);
  }
  eq('未到期行的备注已回填', info.find(x => x.name === '丙未到期').value,
    '丙：上轮填过的备注，本轮未到期也要看得见');
  eq('已逾期行的备注已回填', info.find(x => x.name === '乙已逾期').value, '乙：电话未接通');
  eq('无备注的行是空输入框（可新填）', info.find(x => x.name === '丁空备注').value, '');
  ok('输入框均未禁用（可编辑）', info.every(x => x.disabled === false));

  // 编辑一下：未到期行也能写进 STORE.notes（键经 rowByTr 回查）
  const trc = trs.find(tr => rows[Number(tr.dataset.idx)].patient_name === '丙未到期');
  const inpc = trc.querySelector('input.note-input');
  inpc.value = '丙：改了';
  inpc.dispatchEvent(new w.Event('input', { bubbles: true }));
  eq('未到期行改备注能写回 STORE.notes', App.STORE.notes['丙未到期\u0000' + rows.find(r => r.patient_name === '丙未到期').phone + '::百泽安'], '丙：改了');

  // ---- 产物哨兵 ----
  console.log('\n=== 产物哨兵：新写法已进两个构建产物 ===');
  for (const f of ['index.html', 'index.single.html']) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(f + ' 含「任何状态都渲染备注框」的实现', /input class="note-input"/.test(code));
    ok(f + ' 不再有「!canNote → 返回 —」的旧写法', !/\$\{SNAP_MODE \? "disabled" : ""\}>`\};?\s*\n?\s*if \(!canNote\)/.test(code) && !/if \(!canNote\) return/.test(code));
    ok(f + ' 含随访状态快照列 CB_FU_STATE_COLS', code.includes('CB_FU_STATE_COLS'));
    ok(f + ' 含原随访类型/时间取值 origFuType/origFuTime', code.includes('origFuType') && code.includes('origFuTime'));
    ok(f + ' 含原随访类型列名', code.includes('原随访类型'));
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
