#!/usr/bin/env node
/**
 * _diskscan.js — 快速扫描 Windows 目录占用（NTFS 下比 Git Bash 的 du 快得多）
 *
 * 用法:
 *   node tools/_diskscan.js <根目录> [深度=1] [topN=25]
 *
 * 原理: 用 fs.promises.readdir({withFileTypes:true}) 递归累加文件大小;
 *       只对 depth<=指定深度 的子目录做汇总输出; 跳过 reparse point/符号链接避免环。
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const maxDepth = parseInt(process.argv[3] || '1', 10);
const topN = parseInt(process.argv[4] || '25', 10);

if (!root) {
  console.error('usage: node _diskscan.js <dir> [depth] [topN]');
  process.exit(1);
}

const SKIP = new Set(['$Recycle.Bin', 'System Volume Information', 'DumpStack.log.tmp']);

async function dirSize(dir, depth, acc) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  let total = 0;
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP.has(ent.name)) continue;
        const sub = await dirSize(full, depth + 1, acc);
        if (depth < maxDepth) {
          acc.push({ p: full, size: sub });
        }
        total += sub;
      } else if (ent.isFile()) {
        const st = await fs.promises.stat(full);
        total += st.size;
      }
    } catch (e) { /* 权限/占用跳过 */ }
  }
  return total;
}

function human(n) {
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + u[i];
}

(async () => {
  const acc = [];
  const t0 = Date.now();
  const total = await dirSize(root, 0, acc);
  acc.sort((a, b) => b.size - a.size);
  console.log(`ROOT ${root}  合计 ${human(total)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('---');
  for (const it of acc.slice(0, topN)) {
    console.log(`${human(it.size).padStart(9)}  ${it.p}`);
  }
})();
