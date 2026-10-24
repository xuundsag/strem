// One-off cleanup pass: remove decorative banner comments and emoji from source.
// antislop R-02 bans em dashes in text, and the code skill bans box-drawing
// banners and emoji in comments. This rewrites the banner fences into plain
// lines and deletes comment emoji.
import fs from 'node:fs';
import path from 'node:path';

const roots = ['shared/src', 'player/src', 'streamer/src', 'controller/src', 'player/web', 'test'];
const fence = /^(\s*)(\/\/|<!--)\s*-{5,}\s*(-->)?\s*$/;
let changed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|html|md)$/.test(entry.name)) fix(full);
  }
}

function fix(file) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before.split('\n').filter((line) => !fence.test(line)).join('\n');
  // Drop emoji from comment lines only, leaving string literals alone.
  after = after
    .split('\n')
    .map((line) => {
      const isComment = /^\s*(\/\/|\*|\/\*|<!--)/.test(line);
      if (!isComment) return line;
      return line.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '').replace(/\s{2,}$/, '');
    })
    .join('\n');
  // Em dashes in prose become a colon or a comma.
  after = after.replace(/\s\u2014\s/g, ': ').replace(/\u2014/g, ',');
  // Collapse the blank line the removed fences leave behind.
  after = after.replace(/\n{3,}/g, '\n\n');
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
    console.log('cleaned', file);
  }
}

for (const r of roots) if (fs.existsSync(r)) walk(r);
console.log(`done, ${changed} files changed`);
