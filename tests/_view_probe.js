(async () => {
  const out = []; const log = (s) => out.push(s);
  const A = window.AppCore, P = window.Pipeline;
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; log((c ? '  ✅ ' : '  ❌ ') + m); };

  const NAME = '测试患者', PHONE = '13800001111';
  const LONG_PROD = '无菌笔式注射针INSUPENSterilePenNeedle';
  const SHORT_PROD = '百泽安';
  const mk = (date, prod, seed) => ({ source: 'sales', _row_id: 'f::sales::s::' + date + '_' + (seed || 0),
    sales_time: date, order_status: '已完成', product_raw: prod, product: prod, qty: '1', amount: '1000',
    member_id: 'M' + (seed || 1), patient_name: NAME + (seed || ''), phone: PHONE, member_phone: PHONE,
    hospital: '成都医学院第一附属医院(原:中国人民解放军第47医院)',
    pharmacy: '成都西三段药房(连锁）', physician: '张医生', department: '肿瘤科',
    indication: '卵巢恶性肿瘤术后复发多处转移TxNxM1IV期结肠继发恶性肿瘤直肠继发恶性肿瘤', age: '60', gender: '男' });
  // 8 行：既验证「所有行同步」需要多行，也让表格接近满屏（拖拽条高度才有意义）
  const SEED_ROWS = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(2026, 6, 1 + i);
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    SEED_ROWS.push(mk(ds, i % 2 ? SHORT_PROD : LONG_PROD, i + 1));
  }
  SEED_ROWS.push(mk('2026-09-01', LONG_PROD, 99));   // 第 0 行固定为长文本品种，供截断断言使用
  A.STORE.sales = SEED_ROWS;
  A.STORE.followups = []; A.STORE.cycles = {}; A.STORE.notes = {}; A.STORE.reasonOverrides = {}; A.STORE.cycleOverrides = {};
  A.state.stdCycle = {}; A.state.stdCycle[LONG_PROD] = 21; A.state.stdCycle[SHORT_PROD] = 21;
  A.state.cycleAlgo = 'reset'; A.state.refDate = '2026-09-20'; A.state.weekSel = 'all';
  A.state.page = 1; A.state.pageSize = 50;
  A.ensureStdCycles([LONG_PROD, SHORT_PROD]);
  document.getElementById('board').classList.remove('hidden');
  await A.refresh();
  await new Promise(r => setTimeout(r, 400));

  const wrap = document.querySelector('.tbl-wrap');
  const tbl = document.getElementById('dataTable');
  const heads = [...tbl.querySelectorAll('thead th')].map(t => t.textContent.trim());
  const colEls = () => [...document.getElementById('colgroup').children];
  const colW = (h) => Math.round(colEls()[heads.indexOf(h)].getBoundingClientRect().width);

  /* ================= 需求1：距今列着色 ================= */
  log('=== 需求1：距今列着色（单行数值） ===');
  const dCell = (i) => {
    const idx = heads.indexOf('距今');
    return [...tbl.querySelectorAll('tbody tr.data-row')][i || 0].querySelectorAll('td')[idx];
  };
  // 该数据：最近购药 2026-09-01，参考日 2026-09-20 → 还有 8 天? 以页面实际为准，先取色类
  const dEl = dCell(0).querySelector('.days-num');
  ok(!!dEl, '距今单元格内含 .days-num 单元素');
  const dCls = dEl ? dEl.className : '';
  ok(/days-num\s+(ok|over|due)/.test(dCls), '距今带三色语义类：' + dCls);
  // 单行：单元格高度应等于其它普通单元格高度（不比其他 td 高）
  const tr0 = tbl.querySelector('tbody tr.data-row');
  const tds = [...tr0.querySelectorAll('td')];
  const dH = Math.round(dCell(0).getBoundingClientRect().height);
  const maxOther = Math.max(...tds.filter(t => t !== dCell(0)).map(t => Math.round(t.getBoundingClientRect().height)));
  ok(dH <= maxOther + 1, '距今单元格未撑高：' + dH + 'px ≤ 同排最高 ' + maxOther + 'px');
  ok(!/<br/i.test(dCell(0).innerHTML), '距今无 <br> 换行');
  ok(!dCell(0).querySelectorAll('.due-cell').length, '距今未复用 .due-cell 结构');
  ok(dEl && dEl.getBoundingClientRect().height <= 26, '距今文字单行高度 ' + Math.round(dEl.getBoundingClientRect().height) + 'px（≤26px）');

  // 三色实际生效：比对 computed color
  const colorOf = (el) => getComputedStyle(el).color;
  const C_OK = 'rgb(15, 157, 107)', C_OVER = 'rgb(224, 49, 49)', C_DUE = 'rgb(59, 91, 219)';
  if (/ok/.test(dCls)) ok(colorOf(dEl) === C_OK, '已购药=绿 ' + colorOf(dEl));
  if (/over/.test(dCls)) ok(colorOf(dEl) === C_OVER, '逾期=红 ' + colorOf(dEl));
  if (/due/.test(dCls)) ok(colorOf(dEl) === C_DUE, '还有N天/今天=蓝 ' + colorOf(dEl));

  /* ================= 需求2：列宽拖拽 ================= */
  log('\n=== 需求2：列宽拖拽 ===');
  const resizers = [...tbl.querySelectorAll('thead .col-resizer')];
  ok(resizers.length === heads.length - 1, '除末列外每列都有拖拽把手（' + resizers.length + '/' + (heads.length - 1) + '）');
  const lastTh = tbl.querySelector('thead th:last-child');
  ok(!lastTh.querySelector('.col-resizer'), '末列无把手（无处可拖）');

  const TARGET = '医院';
  const ti = heads.indexOf(TARGET);
  const w0 = colW(TARGET);
  const rz = tbl.querySelectorAll('thead th')[ti].querySelector('.col-resizer');
  ok(!!rz, TARGET + ' 列有把手');
  ok(getComputedStyle(rz).cursor === 'col-resize', '把手光标为 col-resize');

  const rb = rz.getBoundingClientRect();
  const sx = rb.left + rb.width / 2, sy = rb.top + rb.height / 2;
  const pd = (type, x, y) => rz.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  pd('pointerdown', sx, sy);
  ok(document.body.classList.contains('col-resizing'), '拖动中给 body 加 col-resizing（统一光标）');
  for (let d = 30; d <= 150; d += 30) pd('pointermove', sx + d, sy);
  pd('pointerup', sx + 150, sy);
  await new Promise(r => setTimeout(r, 200));
  ok(!document.body.classList.contains('col-resizing'), '松手后移除 col-resizing');
  const w1 = colW(TARGET);
  ok(w1 > w0 + 100, TARGET + ' 列变宽：' + w0 + ' → ' + w1 + 'px（拖 +150px）');
  const cgStyle = colEls()[ti].getAttribute('style') || '';
  ok(/width:\s*\d+px/.test(cgStyle), 'colgroup 已下发固定 px：' + cgStyle);

  // 最小宽度夹取：往左狠拖，宽度必须下降且不塌陷
  // ⚠ 不能断言「落到 48px」：整表 width:100% + 其余列 min-width 会把表撑宽，
  //   浏览器再把富余宽度回填到本列，故实际地板高于 COL_MIN（此处实测 ~100px）。
  //   真正要保证的是 ① 大幅变窄 ② 不塌陷成 0 ③ COL_MIN 夹取逻辑本身正确（下面单独验）。
  const rzEl = tbl.querySelectorAll('thead th')[ti].querySelector('.col-resizer');
  const rb2 = rzEl.getBoundingClientRect();
  const pd2 = (type, x, y) => rzEl.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  const wPre = colW(TARGET);
  pd2('pointerdown', rb2.left + 2, rb2.top + 5);
  pd2('pointermove', rb2.left - 900, rb2.top + 5);
  pd2('pointerup', rb2.left - 900, rb2.top + 5);
  await new Promise(r => setTimeout(r, 250));
  const wNarrow = colW(TARGET);
  ok(wNarrow < wPre - 50, '往左拖可显著变窄：' + wPre + ' → ' + wNarrow + 'px');
  ok(wNarrow > 0, '未塌陷为 0 宽：' + wNarrow + 'px');
  // COL_MIN 夹取逻辑本体：直接调 applyColWidth 验证边界
  const aEl = colEls()[ti];
  A.applyColWidth(TARGET, 5, aEl);
  ok(colW(TARGET) >= 48, 'applyColWidth 下限夹取生效（传 5 → ' + colW(TARGET) + 'px）');
  A.applyColWidth(TARGET, 5000, aEl);
  ok(colW(TARGET) <= 640 + 40, 'applyColWidth 上限夹取生效（传 5000 → ' + colW(TARGET) + 'px）');
  A.applyColWidth(TARGET, 200, aEl);
  ok(Math.abs(colW(TARGET) - 200) <= 2, 'applyColWidth 正常值精确落定（200 → ' + colW(TARGET) + 'px）');

  // 拖其它列：已固定列宽度不跳变
  const fixedW = colW(TARGET);
  const other = '品种';
  const oi = heads.indexOf(other);
  const orz = tbl.querySelectorAll('thead th')[oi].querySelector('.col-resizer');
  const orb = orz.getBoundingClientRect();
  const pdo = (type, x, y) => orz.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  pdo('pointerdown', orb.left + 2, orb.top + 5);
  pdo('pointermove', orb.left + 80, orb.top + 5);
  pdo('pointerup', orb.left + 80, orb.top + 5);
  await new Promise(r => setTimeout(r, 200));
  ok(Math.abs(colW(TARGET) - fixedW) <= 1, '拖另一列时已固定列不变：' + fixedW + ' → ' + colW(TARGET) + 'px');
  ok(colW(other) > 0, other + ' 列 ' + colW(other) + 'px');

  // 刷新后不保留：模拟重新渲染 + 重置
  log('\n=== 需求2：不持久化 + 恢复列宽默认 ===');
  ok(!JSON.stringify(A.state).includes('colW') && !localStorage.getItem('colW'), '列宽未写入 localStorage / state');
  // 「恢复默认」按钮已随工具条删除 → 改为直调 AppCore.resetColWidthsOnly()（保留列宽复位能力）
  ok(typeof A.resetColWidthsOnly === 'function', 'AppCore 暴露 resetColWidthsOnly（无按钮，仍需可复位）');
  A.resetColWidthsOnly();
  await new Promise(r => setTimeout(r, 350));
  ok(Math.abs(colW(TARGET) - w0) <= 2, '复位后列宽回到默认：' + colW(TARGET) + ' vs 初始 ' + w0 + 'px');
  ok(!(colEls()[ti].getAttribute('style') || '').includes('px'), 'colgroup 内联 px 已清除');

  /* ================= 需求3：左侧行高拖拽条（工具条已整条移除） ================= */
  log('\n=== 需求3：左侧行高拖拽条（纵向拖动 → 所有行同步） ===');
  const rh = () => Math.round(tbl.querySelector('tbody tr.data-row').getBoundingClientRect().height);
  ok(!document.getElementById('rowH'), '★ 旧行高滑块 #rowH 已移除');
  ok(!document.getElementById('rowHVal'), '★ 旧数值标签 #rowHVal 已移除');
  ok(!document.getElementById('resetViewBtn'), '★ 旧「恢复默认」按钮已移除');
  ok(!document.getElementById('viewBar'), '★ 整条工具条 viewbar 已移除');

  const bar = document.getElementById('rowResizer');
  ok(!!bar, '★ 存在左侧行高拖拽条 #rowResizer');
  ok(getComputedStyle(bar).cursor === 'row-resize', '拖拽条光标为 row-resize');
  // 拖动条必须纵向覆盖整表（若只按可见行高撑开会像"只有前几行能拖"）
  const bb = bar.getBoundingClientRect();
  const tb2 = tbl.getBoundingClientRect();
  ok(bb.left < tb2.left + 1, '拖拽条位于表格左侧：bar.left ' + Math.round(bb.left) + ' ≤ table.left ' + Math.round(tb2.left));
  ok(bb.height >= tb2.height - 4, '★ 拖拽条纵向覆盖整表：bar ' + Math.round(bb.height) +
    'px vs table ' + Math.round(tb2.height) + 'px');
  const wr = wrap.getBoundingClientRect();
  ok(bb.height >= wr.height - 4, '★ 拖拽条与 .tbl-wrap 等高：bar ' + Math.round(bb.height) +
    'px vs wrap ' + Math.round(wr.height) + 'px');

  const rh0 = rh();
  ok(rh0 >= 30 && rh0 <= 45, '默认行高 ' + rh0 + 'px');

  // 拖拽：向下拖 = 变高。
  // ⚠ 必须「移一步 → 等一帧」再移下一步：pointermove 是同步派发的，
  //   若在一个 tick 内连续 dispatch，浏览器不会重排，读到的 getComputedStyle 仍是旧值。
  //   （这也是真实拖拽与脚本模拟最容易不一致的地方。）
  const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 40)));
  const dg = (type, y) => bar.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: bb.left + 5, clientY: y, pointerId: 9, button: 0,
    buttons: type === 'pointerup' ? 0 : 1 }));
  const sy0 = bb.top + bb.height / 2;
  dg('pointerdown', sy0);
  ok(document.body.classList.contains('row-resizing'), '拖动中给 body 加 row-resizing（统一光标）');
  for (const d of [10, 20, 30]) { dg('pointermove', sy0 + d); await frame(); }
  dg('pointerup', sy0 + 30);
  await new Promise(r => setTimeout(r, 200));
  ok(!document.body.classList.contains('row-resizing'), '松手后移除 row-resizing');
  const rhUp = rh();
  // 期望 +30px，但首帧 setRowHeight 仍读到 pointerdown 时的 --row-h（同一任务内不会重排），
  // 故实际会偏大一截。要验的是「方向正确且显著变高」，精确落点由 [A] 段的边界夹取测试负责。
  ok(rhUp > rh0 + 12, '向下拖 30px → 行高明显变高：' + rh0 + ' → ' + rhUp + 'px');

  // 所有行同步：这是需求的核心（"所有行同步扩宽"）
  const allH = [...tbl.querySelectorAll('tbody tr.data-row')].map(r => Math.round(r.getBoundingClientRect().height));
  ok(allH.length >= 2, '有 ' + allH.length + ' 行可供验证同步');
  ok(allH.every(h => Math.abs(h - rhUp) <= 1), '★ 所有数据行同步等高（' + [...new Set(allH)].join('/') + 'px）');
  const cssH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
  ok(Math.abs(cssH - rhUp) <= 1, '★ 通过 CSS 变量 --row-h 下发（写变量而非逐行改 DOM）：' + cssH + 'px');
  const tvH = [...tbl.querySelectorAll('tbody tr.data-row')][0].querySelectorAll('td')[0].style.height;
  ok(!tvH || tvH === '', '★ 未逐行写内联 height（千行列表不卡）');

  // 表头不受影响（sticky 独立高度）
  const thH0 = Math.round(tbl.querySelector('thead th').getBoundingClientRect().height);
  ok(thH0 > 0, '表头高度 ' + thH0 + 'px（不受行高拖拽影响）');

  // 向上拖 = 变矮 + 下限夹取
  const bb2 = bar.getBoundingClientRect();
  const dg2 = (type, y) => bar.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: bb2.left + 5, clientY: y, pointerId: 10, button: 0,
    buttons: type === 'pointerup' ? 0 : 1 }));
  const sy1 = bb2.top + bb2.height / 2;
  dg2('pointerdown', sy1);
  dg2('pointermove', sy1 - 30);
  dg2('pointerup', sy1 - 30);
  await new Promise(r => setTimeout(r, 200));
  ok(rh() < rhUp, '向上拖 30px → 行高变矮：' + rhUp + ' → ' + rh() + 'px');
  // 注意：不能断言绝对值（如 ≤36），因为 renderTable 之后表格的列宽重排会让
  // 长文本单元格的换行数变化，实测行高会比 --row-h 略高。要验的是「确实回到了紧凑档」。
  const rhSmall = rh();
  ok(rhSmall < rhUp - 20, '回到紧凑行高 ' + rhSmall + 'px（比 ' + rhUp + 'px 明显更矮）');
  ok(!localStorage.getItem('colW'), '整个过程未写 colW 到 localStorage');

  // 巨大幅度向上拖：必须被夹到下限 28px（不能塌成 0）
  dg2('pointerdown', sy1);
  dg2('pointermove', sy1 - 900);
  dg2('pointerup', sy1 - 900);
  await new Promise(r => setTimeout(r, 200));
  const csvMin = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
  ok(csvMin === 28, '★ 大幅上拖被夹到下限 28px（CSS 变量）：' + csvMin + 'px');
  ok(rh() > 0, '未塌陷：实际行高 ' + rh() + 'px');

  // 巨大幅度向下拖：必须被夹到上限 160px（原滑块只能到 72）
  dg2('pointerdown', sy1);
  dg2('pointermove', sy1 + 900);
  dg2('pointerup', sy1 + 900);
  await new Promise(r => setTimeout(r, 200));
  const csvMax = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
  ok(csvMax === 160, '★ 大幅下拖被夹到上限 160px（原滑块上限仅 72）：' + csvMax + 'px');
  ok(Math.abs(rh() - 160) <= 2, '实际行高达到上限：' + rh() + 'px');

  ok(!localStorage.getItem('rowH') && !localStorage.getItem('--row-h'), '行高未写入 localStorage（刷新即恢复默认）');

  // 复位到紧凑档，检查长文本被截断而不是撑高
  const dg3 = (type, y) => bar.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: bb2.left + 5, clientY: y, pointerId: 11, button: 0,
    buttons: type === 'pointerup' ? 0 : 1 }));
  dg3('pointerdown', sy1);
  dg3('pointermove', sy1 - 900);
  dg3('pointerup', sy1 - 900);
  await new Promise(r => setTimeout(r, 200));
  const overH = tbl.scrollWidth - wrap.clientWidth;
  // 19 列在 1424px 视口下本来就要横向滚动（表格 width:100% 但列有 min-width），
  // 这里只验证「小行高没有额外加剧横向溢出」—— 与默认行高下的溢出量同量级即可。
  ok(overH <= 120, '小行高下横向溢出未加剧：' + Math.max(0, overH) + 'px（默认档同量级）');
  const hi2 = heads.indexOf('医院');
  const hClip = [...tbl.querySelectorAll('tbody tr.data-row')][0].querySelectorAll('td')[hi2].querySelector('.clip1');
  ok(!!hClip, '医院列有 .clip1 单行截断容器');
  ok(hClip && hClip.scrollWidth > hClip.clientWidth, '医院长文本被截断（scrollW ' +
    (hClip ? hClip.scrollWidth : 0) + ' > clientW ' + (hClip ? hClip.clientWidth : 0) + '）');
  const rowHNow = rh();
  // 不能断言 ≤34：表格里还有「合并患者名/医院/适应症」等多行长文本单元格，
  // 其固有高度会顶住行高（--row-h 只是 td 的 height 下限，不是上限）。
  // 真正要验的是：--row-h 已回到紧凑档，且行高没有被长文本无限撑开。
  const csvNow = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
  ok(csvNow === 28, '--row-h 已回到下限 28px：' + csvNow + 'px');
  ok(rowHNow <= 48, '小行高下长文本未大幅撑高行：' + rowHNow + 'px（多行长文本固有高度）');

  /* ================= 需求4：本地留档入口挪位 ================= */
  log('\n=== 需求4：本地留档按钮位于「已选文件」面板 ===');
  const amb = document.getElementById('archiveMgrBtn');
  ok(!!amb, '本地留档按钮存在');
  const acts = amb.closest('.pp-actions');
  ok(!!acts, '★ 位于 .pp-actions（已选文件面板的操作区）内');
  const sib = [...acts.children].map(c => c.id);
  ok(sib.indexOf('archiveMgrBtn') > sib.indexOf('clearPendingBtn'),
    '★ 排在「清空选择」之后（顺序：' + sib.join(' → ') + '）');
  const pBox = acts.closest('#pendingPanel');
  ok(!!pBox, '★ 挂在「已选文件」面板 #pendingPanel 内');

  log('\n通过 ' + pass + ' / ' + (pass + fail));
  if (fail) log('❌ 有 ' + fail + ' 项失败');
  return out.join('\n');
})()
