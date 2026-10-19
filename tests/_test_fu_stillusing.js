// 「还在按处方继续使用」列的识别回归（2026-10-19 用户指出表头写错后补的锁定测试）
//
// 背景：真实随访模板里这一列是**带品种名的问句**（「还在按照处方继续使用百悦泽吗？」
//       「是否继续使用百泽安」），从来没有一张表叫「还在按照处方继续使用」。
//       mapping.js 原来只认那个裸短语 → 真实模板这一列可能一直没被读进来。
//
// 本测试锁定：
//   [1] 多种真实写法都能映射到 still_using（品种名可任意）
//   [2] 多模板合并大表：两列并存时取该行有值的那一列
//   [3] 该列的值能参与随访信号判定（脱落/正常）
//   [4] 回传表导出不再夹带任何「还在按照处方…」表头（改用「未购药原因」列承载结论）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
new Function(fs.readFileSync(path.join(ROOT, 'mapping.js'), 'utf8'))();
const M = global.Mapping;
global.XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
new Function(fs.readFileSync(path.join(ROOT, 'pipeline.js'), 'utf8'))();
const P = global.Pipeline;

function bufOf(header, rows) {
  const ws = global.XLSX.utils.aoa_to_sheet([header].concat(rows));
  const wb = global.XLSX.utils.book_new();
  global.XLSX.utils.book_append_sheet(wb, ws, '随访');
  return global.XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const BASE = ['任务状态', '服务摘要', '患者姓名', '联系电话', '产品', '执行时间'];

(async () => {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const c = JSON.stringify(got) === JSON.stringify(want);
    c ? pass++ : fail++;
    console.log((c ? '  ✅ ' : '  ❌ ') + n + ' → ' + JSON.stringify(got) + (c ? '' : '，期望 ' + JSON.stringify(want)));
  };
  const ok = (n, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  ✅ ' : '  ❌ ') + n + (extra ? ' → ' + extra : '')); };

  const run = async (header, row) => {
    const res = await P.processFiles([{ name: '随访.xlsx', arrayBuffer: async () => bufOf(header, [row]) }]);
    return res.followups[0] || {};
  };
  const ROW = v => ['已完成', '脱落预警随访', '张三', '13800000001', '百悦泽', '2026-10-10'].concat(v);

  console.log('[1] 真实模板的多种写法都映射到 still_using');
  for (const h of ['还在按照处方继续使用百悦泽吗？', '是否继续使用百泽安', '还在按照处方继续使用', '继续使用索托克拉']) {
    const f = await run(BASE.concat([h]), ROW([h.includes('百泽安') ? '否' : '是']));
    eq('表头「' + h + '」→ still_using', f.still_using, h.includes('百泽安') ? '否' : '是');
  }

  console.log('\n[2] 多模板合并大表：两列并存，按行取有值的那一列');
  const H2 = BASE.concat(['还在按照处方继续使用百悦泽吗？', '是否继续使用百泽安']);
  let f = await run(H2, ROW(['', '是']));
  eq('只有第二列有值 → 取到「是」', f.still_using, '是');
  f = await run(H2, ROW(['否', '']));
  eq('只有第一列有值 → 取到「否」', f.still_using, '否');

  console.log('\n[3] 取值参与随访信号判定');
  f = await run(BASE.concat(['是否继续使用百悦泽']), ROW(['没有使用，已经停药']));
  eq('「没有使用/停药」→ 脱落信号', M.followupSignal(f).signal, 'dropout');
  f = await run(BASE.concat(['是否继续使用百悦泽']), ROW(['是，正在按处方服用']));
  eq('「是/正在」→ 正常信号', M.followupSignal(f).signal, 'normal');

  console.log('\n[4] 回传表不再夹带这类表头（结论改由「未购药原因」承载）');
  const mul = M.KEYWORD_RULES_MULTI.find(r => r[0] === 'still_using');
  ok('still_using 关键字池含「继续使用」共同片段（品种可增删）',
    !!mul && mul[1].some(k => k === '继续使用'), mul && JSON.stringify(mul[1]));
  for (const f2 of ['app.js', 'index.html', 'index.single.html']) {
    const p = path.join(ROOT, f2);
    if (!fs.existsSync(p)) continue;
    const code = fs.readFileSync(p, 'utf8');
    ok('产物 ' + f2 + ' 不再以「还在按照处方继续使用」作为导出表头',
      !/\["还在按照处方继续使用",\s*r\s*=>/.test(code));
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
