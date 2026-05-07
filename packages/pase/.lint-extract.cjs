const fs = require('fs');
const data = JSON.parse(fs.readFileSync('lint.json', 'utf8'));
const want = process.argv[2] || '@typescript-eslint/no-unused-vars';
const items = [];
for (const f of data) {
  for (const m of f.messages) {
    if (m.ruleId === want) {
      items.push({
        file: f.filePath.replace(/.*packages.pase./, '').split('\\').join('/'),
        line: m.line,
        col: m.column,
        msg: (m.message || '').split('\n')[0],
      });
    }
  }
}
console.log('total', want, ':', items.length);
const byFile = {};
for (const u of items) {
  if (!byFile[u.file]) byFile[u.file] = [];
  byFile[u.file].push(u.line + ':' + u.col + ' ' + u.msg);
}
for (const [f, list] of Object.entries(byFile)) {
  console.log('---', f, '(' + list.length + ')---');
}
