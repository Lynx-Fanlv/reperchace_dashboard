(async () => {
  const out = []; const log = (s) => out.push(s);
  const A = window.AppCore, P = window.Pipeline;
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; log((c ? '  ✅ ' : '  ❌ ') + m); };

  const NAME = '测试患者', PHONE = '13800001111';
  const LONG_PROD = '无菌笔式注射针INSUPENSterilePenNeedle';
  const mk = (date, prod) => ({ source: 'sales', _row_id: 'f::sales::s::' + date, sales_time: date,
    order_status: '已完成', product_raw: prod, product: prod, qty: '1', amount: '1000', member_id: 'M1',
    patient_name: NAME, phone: PHONE, hospital: '成都医学院第一附属医院(原:中国人民解放军第47医院)',
    pharmacy: '成都西三段药房(连锁）', physician: '张医生', department: '肿瘤科',
    indication: '卵巢恶性肿瘤术后复发多处转移TxNxM1IV期结肠继发恶性肿瘤直肠继发恶性肿瘤', age: '60', gender: '男' });
  A.STORE.sales = [mk('2026-08-01', LONG_PROD), mk('2026-09-01', LONG_PROD)];
  A.STORE.followups = []; A.STORE.cycles = {}; A.STORE.notes = {}; A.STORE.reasonOverrides = {}; A.STORE.cycleOverrides = {};
  A.state.stdCycle = {}; A.state.stdCycle[LONG_PROD] = 21;
  A.state.cycleAlgo = 'reset'; A.state.refDate = '2026-09-20'; A.state.weekSel = 'this';
  A.state.page = 1; A.state.pageSize = 50;
  A.ensureStdCycles([LONG_PROD]);
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
  log('\n=== 需求2：不持久化 + 恢复默认 ===');
  ok(!JSON.stringify(A.state).includes('colW') && !localStorage.getItem('colW'), '列宽未写入 localStorage / state');
  document.getElementById('resetViewBtn').click();
  await new Promise(r => setTimeout(r, 350));
  ok(Math.abs(colW(TARGET) - w0) <= 2, '「恢复默认」后列宽回到默认：' + colW(TARGET) + ' vs 初始 ' + w0 + 'px');
  ok(!(colEls()[ti].getAttribute('style') || '').includes('px'), 'colgroup 内联 px 已清除');

  /* ================= 需求3：行高滑块 ================= */
  log('\n=== 需求3：全局行高滑块 ===');
  const rh = () => Math.round(tbl.querySelector('tbody tr.data-row').getBoundingClientRect().height);
  const slider = document.getElementById('rowH');
  ok(!!slider, '存在行高滑块');
  ok(slider.min === '28' && slider.max === '72', '滑块范围 28~72px');
  const rh0 = rh();
  ok(rh0 >= 30 && rh0 <= 45, '默认行高 ' + rh0 + 'px');
  const setH = async (v) => {
    slider.value = String(v);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
  };
  await setH(60);
  const rh60 = rh();
  ok(rh60 > rh0 + 10, '调高到 60px 生效：' + rh0 + ' → ' + rh60 + 'px');
  ok(document.getElementById('rowHVal').textContent === '60px', '右侧数值标签同步为 60px');
  const allH = [...tbl.querySelectorAll('tbody tr.data-row')].map(r => Math.round(r.getBoundingClientRect().height));
  ok(allH.every(h => Math.abs(h - rh60) <= 1), '所有数据行等高（' + allH.length + ' 行，' + [...new Set(allH)].join('/') + 'px）');
  // 表头不应被滑块改变（表头是 sticky 独立高度）
  const thH0 = Math.round(tbl.querySelector('thead th').getBoundingClientRect().height);
  await setH(30);
  const thH1 = Math.round(tbl.querySelector('thead th').getBoundingClientRect().height);
  ok(Math.abs(thH1 - thH0) <= 1, '表头高度不受行高滑块影响（' + thH0 + ' → ' + thH1 + 'px）');
  ok(rh() < rh60, '调低到 30px 生效：' + rh60 + ' → ' + rh() + 'px');
  const overH = tbl.scrollWidth - wrap.clientWidth;
  ok(overH <= 24, '小行高下无横向溢出：' + Math.max(0, overH) + 'px');
  ok(!localStorage.getItem('rowH'), '行高未写入 localStorage');

  // 长文本在小行高下被截断而不是撑高：取明确过长的列（医院 = 31 字符）
  await setH(30);
  const hi2 = heads.indexOf('医院');
  const hClip = [...tbl.querySelectorAll('tbody tr.data-row')][0].querySelectorAll('td')[hi2].querySelector('.clip1');
  ok(!!hClip, '医院列有 .clip1 单行截断容器');
  ok(hClip && hClip.scrollWidth > hClip.clientWidth, '医院长文本被截断（scrollW ' +
    (hClip ? hClip.scrollWidth : 0) + ' > clientW ' + (hClip ? hClip.clientWidth : 0) + '）');
  const rowHNow = rh();
  ok(rowHNow <= 34, '小行高下长文本未撑高行：' + rowHNow + 'px');

  log('\n通过 ' + pass + ' / ' + (pass + fail));
  if (fail) log('❌ 有 ' + fail + ' 项失败');
  return out.join('\n');
})()
