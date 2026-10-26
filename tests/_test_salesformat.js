// 第二种销售明细格式（国药四川 / 晟德 POS 导出「销售明细表」）的支持，与「患者不进名单」的防线验证
//
// 背景（2026-10-26 用户报障）：「销售明细表里明明有这个患者，网页分析后的名单里搜不到」。
// 根因：这种格式的列名与连锁报表完全不同（订单号/创建日期/收费日期/门店名称/商品名/患者姓名/联系方式），
// 表类型签名只认「销售时间+商品名称+会员姓名+药房名称」，于是整张表被判成 unknown 静默跳过 ——
// 里面的患者一个都进不了名单。同时还有两个连带坑：
//   ① 电话列「购药人电话」是空的，真正的号码在「联系方式」；
//   ② 品种会命中「国控药品编号」（含关键字「药品」且排在「商品名」前面），品种维度变成一串编码。
const fs = require('fs');
const path = require('path');
const os = require('os');

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
const M = global.Mapping, P = global.Pipeline, App = global.AppCore;
const S = App.state, ST = App.STORE;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  ✅ ' + name + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + name + ' → 实际 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
};
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } };

// POS 格式表头（与本机真实导出一致，注意「 门店名称」列名自带前导空格）
const POS_HEADER = ['订单号', 'POS订单号', '创建日期', '收费日期', '区域名称', '区域编码', '二级子公司',
  ' 门店名称', ' 门店编码', '国控药品编号', '药房药品编码', 'CMS订单编码', '商品名', '通用名', '规格',
  '厂家', '厂牌', '单位', '用法用量', '批号', '有效期', '销售类型', '订单类型', '配送员', '发票号',
  '送货时长(分钟)', '送货人', '配送距离', '订单创建人', '数量', '单价', '总价', '无税总价', '税率',
  '是否预约单', '订单备注', '处方备注', '患者姓名', '联系方式', '患者OneId', '地址', '身份证', '性别',
  '年龄', '患者编号', '患者会员号', '医保归属地', '处方医院', '处方科室', '处方医生', '处方诊断结果',
  '处方适应症', '是否医保', '是否新患', '商保计划', '用药开始时间', '预计用药结束时间', '是否本人购药',
  '购药人姓名', '购药人电话', '购药人身份证号', '与患者关系', '医保刷卡人', '医保类型'];
// 按列名填一行（避免手数下标），未给出的列留空
function posRow(map) {
  return POS_HEADER.map(h => {
    const k = h.trim();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
  });
}
const POS_BASE = {
  '订单号': 'A260901122356339', 'POS订单号': '16009024001260080142',
  '创建日期': '2026-09-01 07:54:43', '收费日期': '2026-09-08 10:07:45',
  '门店名称': '四川省晟德药房有限公司', '国控药品编号': 'GKH00000368000',
  '商品名': '百泽安', '通用名': '替雷利珠单抗注射液', '销售类型': '配送', '订单类型': '正常订单',
  '数量': 2, '患者姓名': '何德书', '联系方式': '13258326668', '患者会员号': '0679521',
  '处方医院': '成都市新津区中医医院', '处方科室': '肿瘤科', '处方医生': '王',
};

function resetState() {
  S.refDate = '2026-09-17'; S.weekSel = 'this';
  S.stdCycle = { '百泽安': 21, '百悦泽': 28 }; S.qtyScale = {};
  S.cycleAlgo = 'reset'; S.reasonTree = App.cloneReasonTree(App.DEFAULT_REASON_TREE);
  App.resetListFilters();
  ST.cycles = {}; ST.reasonOverrides = {}; ST.notes = {}; ST.followups = []; ST.sales = [];
}

(async () => {
  console.log('\n=== 第二种销售明细格式（国药四川 POS「销售明细表」）===');

  // ---------------------------------------------------------------
  console.log('\n[1] 表类型必须被识别为 sales（以前是 unknown → 整张表被跳过）');
  eq('POS 表头 → sales', M.detectTableType(POS_HEADER), 'sales');
  eq('连锁报表表头 → 仍为 sales（不能被新签名挤掉）',
    M.detectTableType(['序号', '销售时间', '订单状态', '小票号', '商品名称', '销售数量', '会员号',
      '会员姓名', '会员电话', '医疗单位', '处方医生', '处方科室', '药房名称']), 'sales');
  eq('随访表表头 → 仍为 followup',
    M.detectTableType(['任务状态', '患者', '联系电话', '产品', '计划执行时间', '执行时间', '随访人', '服务摘要']), 'followup');
  eq('周期表表头 → 仍为 cycle', M.detectTableType(['患者', '用药周期', '会员id']), 'cycle');

  // ---------------------------------------------------------------
  console.log('\n[2] 列映射：每个字段都要落到正确的列上');
  const cm = P.mapColumns('sales', POS_HEADER);
  const colName = f => (cm[f] == null ? null : POS_HEADER[cm[f]]);
  eq('患者姓名 → 患者姓名列', colName('patient_name').trim(), '患者姓名');
  eq('电话 → 联系方式（不是空着的「购药人电话」）', colName('phone').trim(), '联系方式');
  eq('品种 → 商品名（不是「国控药品编号」）', colName('product').trim(), '商品名');
  eq('收费日期 → sales_paid_time', colName('sales_paid_time').trim(), '收费日期');
  eq('创建日期 → sales_time（兜底）', colName('sales_time').trim(), '创建日期');
  eq('小票号 → POS订单号', colName('ticket_no').trim(), 'POS订单号');
  eq('药房 → 门店名称（列名带前导空格也要命中）', colName('pharmacy').trim(), '门店名称');
  eq('医院 → 处方医院', colName('hospital').trim(), '处方医院');
  eq('数量 → 数量', colName('qty').trim(), '数量');
  eq('会员号 → 患者会员号', colName('member_id').trim(), '患者会员号');
  eq('科室 → 处方科室', colName('department').trim(), '处方科室');
  eq('医生 → 处方医生', colName('physician').trim(), '处方医生');
  ok('品种不取自任何「编号/编码/代码」列', !/编号|编码|代码/.test(colName('product')));

  // ---------------------------------------------------------------
  console.log('\n[3] 行归一化：收费日期优先、商品名归一、电话清洗');
  const rec = P.normalizeSheet('sales', [posRow(POS_BASE)], POS_HEADER, '销售明细表.xlsx', 'Sheet0')[0];
  eq('购药日期取「收费日期」而非「创建日期」', rec.sales_time, '2026-09-08');
  eq('品种归一为家族名', rec.product, '百泽安');
  eq('电话取「联系方式」', rec.phone, '13258326668');
  eq('医院取「处方医院」', rec.hospital, '成都市新津区中医医院');
  eq('药房取「门店名称」', rec.pharmacy, '四川省晟德药房有限公司');
  eq('数量', rec.qty, '2');
  eq('科室', rec.department, '肿瘤科');
  eq('医生', rec.physician, '王');
  eq('会员号', rec.member_id, '0679521');
  eq('小票号 = POS订单号（供跨文件去重）', rec.ticket_no, '16009024001260080142');

  // 收费日期为空 → 退回创建日期，不能让整行丢掉
  const recNoPaid = P.normalizeSheet('sales',
    [posRow(Object.assign({}, POS_BASE, { '收费日期': '', '商品名': '百悦泽', 'POS订单号': 'POS2', '订单号': 'A2', '患者姓名': '张三', '联系方式': '13900000001' }))],
    POS_HEADER, '销售明细表.xlsx', 'Sheet0')[0];
  eq('收费日期为空 → 用创建日期兜底（行不会被丢弃）', recNoPaid.sales_time, '2026-09-01');
  eq('兜底行的品种归一', recNoPaid.product, '百悦泽');

  // ---------------------------------------------------------------
  console.log('\n[4] 整表进名单：Excel 解析 → 去重 → buildRows，患者一个不能少');
  const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(os.homedir(), 'Downloads');
  const posFile = path.join(SAMPLE_DIR, '销售明细表 (3).xlsx');
  if (!fs.existsSync(posFile)) {
    console.log('  ⏭️ 跳过真实样例（' + path.basename(posFile) + ' 不在 Downloads）');
  } else {
    const buf = fs.readFileSync(posFile);
    const res = await P.processFiles([{ name: path.basename(posFile), size: buf.length,
      async arrayBuffer(){ return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } }]);
    ok('真实「销售明细表」解析出销售行 > 0（以前是 0）', res.sales.length > 0);
    eq('没有被跳过 / 解析失败的表', res.issues, []);
    const dd = P.dedupSales(res.sales);
    ok('品种只剩业务品种（不含药品编号）',
      [...new Set(dd.records.map(r => r.product))].every(p => !/^[A-Z0-9]{8,}$/.test(String(p))));
    const want = new Set();
    for (const s of dd.records) if (s.sales_time && s.product) want.add(P.patientKey(s.patient_name, s.phone) + '|' + s.product);
    resetState();
    ST.sales = dd.records;
    const rows = App.buildRows();
    App.DATA.rows = rows;
    eq('名单行数 = 明细里的患者×品种数（不缺人）', rows.length, want.size);
    eq('未进名单的行数为 0', App.getDropStat(), { noTime: 0, noProd: 0 });
    const any = rows.find(r => r.patient_name);
    S.q = any.patient_name;
    ok('按姓名能搜到真实患者「' + any.patient_name + '」', App.filterRows(rows).length > 0);
    S.q = '';
  }

  // ---------------------------------------------------------------
  console.log('\n[5] 搜索覆盖面：会员号 / 科室 / 备注 / 未购药原因标签 都要能搜到');
  resetState();
  const mk = (o) => Object.assign({
    _key: 'X\u0000000', product: '百泽安', patient_name: '甲', phone: '13900000001',
    physician: '王医生', department: '肿瘤科', hospital: '某医院', pharmacy: '某药房',
    member_id: 'M000123', executor: '小李', fu_type: '周期性随访', fu_signal: '', fu_note: '',
    reason: 'dropout_econ', status: '应回购', repur_part: '应回未回',
  }, o);
  const rows5 = [mk({}), mk({ _key: 'Y\u0000222', patient_name: '乙', member_id: 'M000999', department: '血液科', reason: '' })];
  S.q = 'M000123'; eq('按会员号搜到（「仅会员号」脱敏下这是屏幕上唯一的身份）', App.filterRows(rows5).length, 1);
  S.q = '血液'; eq('按科室搜到', App.filterRows(rows5).map(r => r.patient_name), ['乙']);
  S.q = '经济'; eq('按未购药原因标签搜到（行上存的是 key，搜的是标签文字）', App.filterRows(rows5).map(r => r.patient_name), ['甲']);
  ST.notes = { 'X\u0000000::百泽安': '家属说下周来买' };
  S.q = '下周来买'; eq('按跟进备注搜到', App.filterRows(rows5).map(r => r.patient_name), ['甲']);
  S.q = '　甲 '; eq('搜索词带全角空格/首尾空白也能命中', App.filterRows(rows5).map(r => r.patient_name), ['甲']);
  S.q = '甲'; eq('（对照）正常搜索', App.filterRows(rows5).length, 1);
  S.q = ''; ST.notes = {};

  // ---------------------------------------------------------------
  console.log('\n[6] 分析后筛选清零：上一批的筛选不能挡住这一批的人');
  resetState();
  S.cats.add('应回购'); S.products.add('百泽安'); S.hospitals.add('某医院');
  S.pharmacies.add('某药房'); S.executors.add('小李'); S.reasons.add('dropout_econ');
  S.repurParts.add('应回未回'); S.q = '甲';
  App.resetListFilters();
  eq('状态筛选已清空', S.cats.size, 0);
  eq('品种筛选已清空（不再窄化成「有留档的品种」）', S.products.size, 0);
  eq('医院/药房/随访人筛选已清空', [S.hospitals.size, S.pharmacies.size, S.executors.size], [0, 0, 0]);
  eq('未购药原因/应回购细分筛选已清空', [S.reasons.size, S.repurParts.size], [0, 0]);
  eq('搜索词已清空', S.q, '');

  // ---------------------------------------------------------------
  console.log('\n[7] 有数据却没进名单的表必须留下痕迹（不再只 console.warn）');
  {
    const XLSX = global.XLSX;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['销售时间', '商品名称', '会员姓名', '会员电话', '销售数量', '药房名称'],
      ['2026-09-01', '百泽安', '甲', '13900000001', 1, '某药房'],
    ]), '销售');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['随便一列', '另一列'], ['值1', '值2'], ['值3', '值4'],
    ]), '认不出的表');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const f = { name: '混合表.xlsx', size: buf.length, async arrayBuffer(){ return buf; } };
    const res = await P.processFiles([f]);
    eq('识别出的销售行照常进入', res.sales.length, 1);
    eq('未识别的表被记进 issues（含行数）',
      res.issues.map(x => [x.kind, x.sheet, x.rows]), [['unknown', '认不出的表', 2]]);
  }

  console.log('\n' + (fail === 0 ? '✅' : '❌') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
