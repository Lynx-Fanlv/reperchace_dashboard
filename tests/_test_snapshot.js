// 静态验证 index.html 快照剥离与注入逻辑（含 exceljs 外链剥离）
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// 1. 三脚本已内联
console.log('mapping内联:', html.includes('window.Mapping'));
console.log('pipeline内联:', html.includes('window.Pipeline'));
console.log('app内联:', html.includes('window.AppCore'));
console.log('xlsx外链存在:', html.includes('vendor/xlsx.full.min.js'));
console.log('exceljs外链存在:', html.includes('vendor/exceljs.min.js'));

// 2. 模拟 doSnapshot 的剥离逻辑（与 app.js 中一致：xlsx + exceljs 都剥离）
let stripped = html;
for (const lib of ['xlsx.full.min.js', 'exceljs.min.js']) {
  const srcTag = '<' + 'script src="vendor/' + lib + '"></sc' + 'ript>';
  const before = (stripped.match(new RegExp('<script src="vendor/' + lib.replace('.', '\\.') + '"></script>', 'g')) || []).length;
  stripped = stripped.replace(srcTag, '');
  console.log(`剥离 ${lib}: 命中=${before > 0} | 剥离后完整标签数=${(stripped.match(new RegExp('<script src="vendor/' + lib.replace('.', '\\.') + '"></script>', 'g')) || []).length}(应为0)`);
}

// 3. 真实 </body> 位置（快照注入用 lastIndexOf，不能命中脚本源码里的字符串）
const bodyIdx = html.lastIndexOf('</body>');
console.log('body标签数:', (html.match(/<\/body>/g) || []).length, '(2=模板末尾1个+app.js源码字符串1个)');
console.log('lastIndexOf 取的是最大索引(文档末尾):', bodyIdx === html.length - '</body>'.length - 10 + 10 || bodyIdx >= html.length - 40);

// 4. 注入数据脚本后形成合法闭合
const dataScript = '<script>window.__SNAP__={}</script>';
const finalHtml = html.slice(0, bodyIdx) + dataScript + '\n' + html.slice(bodyIdx);
console.log('注入后字节:', finalHtml.length, '| 结尾合法:', finalHtml.trim().endsWith('</html>'));
