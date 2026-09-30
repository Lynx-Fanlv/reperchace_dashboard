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
  const tbl = wrap.querySelector('table');
  const heads = [...tbl.querySelectorAll('thead th')].map(t => t.textContent.trim());
  const cell = (h) => { const i = heads.indexOf(h);
    return [...tbl.querySelectorAll('tbody tr.data-row')][0].querySelectorAll('td')[i]; };

  log('=== 需求3：长文本不再撑开间距 ===');
  const tr = tbl.querySelector('tbody tr.data-row');
  const rh = Math.round(tr.getBoundingClientRect().height);
  ok(rh >= 30 && rh <= 45, '行高 ' + rh + 'px（原先 71px → 目标 30~45px）');
  const over = tbl.scrollWidth - wrap.clientWidth;
  ok(over <= 24, '横向溢出 ' + Math.max(0, over) + 'px（原先 556px；≤24px 可接受）');

  const pw = heads.indexOf('品种');
  const tag = cell('品种').querySelector('.tag-prod');
  ok(!!tag && tag.scrollWidth > tag.clientWidth, '长药品名称在列内被省略而不撑开列宽');
  ok(tag.getAttribute('title') === LONG_PROD, '悬停 title 保留完整药品名');
  ok(cell('品种').getBoundingClientRect().width <= 120, '品种列宽 ' + Math.round(cell('品种').getBoundingClientRect().width) + 'px（≤120px）');

  const clipEl = cell('医院').querySelector('.clip1');
  ok(!!clipEl && clipEl.scrollWidth > clipEl.clientWidth, '长医院名单行截断');
  const h0 = clipEl.getBoundingClientRect().height;
  clipEl.click(); await new Promise(r => setTimeout(r, 130));
  const h1 = clipEl.getBoundingClientRect().height;
  ok(h1 > h0, '点击可展开看全文（' + Math.round(h0) + '→' + Math.round(h1) + 'px）');
  clipEl.click(); await new Promise(r => setTimeout(r, 110));
  ok(clipEl.getBoundingClientRect().height <= h0 + 1, '再次点击可收起');

  log('\n=== 需求2：列表内改周期 ===');
  const key = P.patientKey(NAME, PHONE) + '::' + LONG_PROD;
  const read = () => ({
    cyc: cell('周期').textContent.trim(),
    due: cell('应购药日').textContent.trim(),
  });
  const before = read();
  ok(before.cyc === '21', '初始周期 21（标准周期）');
  ok(/逾期\d+天/.test(before.due), '初始应购日 "' + before.due + '"');

  cell('周期').querySelector('.cycle-edit').click();
  await new Promise(r => setTimeout(r, 160));
  const inp = cell('周期').querySelector('input.cycle-input');
  ok(!!inp, '点击后变数字输入框');
  ok(inp && inp.value === '21', '预填当前值 21');
  ok(!!cell('周期').querySelector('.ci-tip'), '有操作提示');

  inp.value = '35';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 700));
  const after = read();
  ok(A.STORE.cycleOverrides[key] === 35, '覆盖值写入（键 = patientKey::品种）');
  ok(Object.keys(A.STORE.cycleOverrides).every(k => k.includes('\u0000')), '键保留 \\u0000 分隔符（未被 DOM 污染）');
  ok(after.cyc === '35', '周期列显示 35');
  ok(after.due !== before.due && /还有\d+天/.test(after.due), '应购日重算："' + before.due + '" → "' + after.due + '"');
  const ce = cell('周期').querySelector('.cycle-edit');
  ok(ce.classList.contains('over') && !!cell('周期').querySelector('.ce-dot'), '已设置行有实心标识 + 圆点');

  log('\n=== 需求2：清空恢复 / Esc 取消 ===');
  ce.click(); await new Promise(r => setTimeout(r, 160));
  const inp2 = cell('周期').querySelector('input.cycle-input');
  inp2.value = '';
  inp2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 700));
  ok(!A.STORE.cycleOverrides[key], '清空后覆盖记录被删除');
  ok(read().cyc === '21' && read().due === before.due, '恢复为标准周期 21，应购日复原');

  cell('周期').querySelector('.cycle-edit').click();
  await new Promise(r => setTimeout(r, 160));
  const inp3 = tbl.querySelector('input.cycle-input');
  inp3.value = '99';
  inp3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 600));
  ok(!A.STORE.cycleOverrides[key] && read().cyc === '21', 'Esc 取消不保存（周期仍 21）');

  log('\n=== 需求2：改周期后行高不受影响 ===');
  A.STORE.cycleOverrides[key] = 35;
  await A.refresh(); await new Promise(r => setTimeout(r, 400));
  const rh2 = Math.round(tbl.querySelector('tbody tr.data-row').getBoundingClientRect().height);
  ok(rh2 <= 45, '设置周期后行高仍为 ' + rh2 + 'px');

  log('\n通过 ' + pass + ' / ' + (pass + fail));
  if (fail) log('❌ 有 ' + fail + ' 项失败');
  return out.join('\n');
})()
