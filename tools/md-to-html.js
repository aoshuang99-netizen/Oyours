#!/usr/bin/env node
/**
 * tools/md-to-html.js — 极简 Markdown → 自包含 HTML（无第三方依赖）
 * 支持：标题 / 表格 / 围栏代码 / 有序无序列表 / 引用 / 粗体 / 行内代码 / 水平线
 * 用法：node tools/md-to-html.js <input.md> <output.html> "<页面标题>"
 */
'use strict';
const fs = require('fs');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

function convert(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  let listOpen = null; // 'ul' | 'ol'
  const closeList = () => { if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; } };

  while (i < lines.length) {
    const L = lines[i];

    // 围栏代码
    if (/^```/.test(L)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 表格
    if (/^\|/.test(L) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      closeList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(L);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      out.push('<div class="tw"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // 标题
    const h = L.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    // 水平线
    if (/^\s*---+\s*$/.test(L)) { closeList(); out.push('<hr>'); i++; continue; }

    // 引用
    if (/^>\s?/.test(L)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 列表
    const ul = L.match(/^\s*[-*]\s+(.*)$/);
    const ol = L.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listOpen !== want) { closeList(); out.push(`<${want}>`); listOpen = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++;
      continue;
    }

    // 空行 / 段落
    if (!L.trim()) { closeList(); i++; continue; }
    closeList();
    out.push(`<p>${inline(L)}</p>`);
    i++;
  }
  closeList();
  return out.join('\n');
}

const [inFile, outFile, title] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('用法: node tools/md-to-html.js <in.md> <out.html> [title]'); process.exit(2); }
const md = fs.readFileSync(inFile, 'utf8');
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || inFile)}</title>
<style>
:root{--bg:#ffffff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--accent:#0f172a;--code:#f6f7f9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:48px 28px 96px}
h1{font-size:26px;line-height:1.35;margin:0 0 8px;border-bottom:2px solid var(--accent);padding-bottom:12px}
h2{font-size:20px;margin:40px 0 12px;padding-left:10px;border-left:4px solid var(--accent)}
h3{font-size:16.5px;margin:28px 0 10px}
h4{font-size:15px;margin:20px 0 8px;color:var(--muted)}
p{margin:10px 0}
code{background:var(--code);padding:1px 5px;border-radius:4px;font:13px/1.6 ui-monospace,Consolas,monospace;color:#b91c1c;word-break:break-all}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto}
pre code{background:none;padding:0;color:#111827;white-space:pre;word-break:normal;font-size:12.5px}
.tw{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-weight:600;white-space:nowrap}
tbody tr:nth-child(even){background:#fafafa}
blockquote{margin:14px 0;padding:10px 14px;background:#fffbeb;border-left:4px solid #f59e0b;color:#78350f}
blockquote p{margin:0}
hr{border:0;border-top:1px solid var(--line);margin:34px 0}
ul,ol{margin:10px 0;padding-left:24px}
li{margin:4px 0}
a{color:#1d4ed8}
strong{font-weight:600}
</style></head><body><div class="wrap">
${convert(md)}
</div></body></html>`;
fs.writeFileSync(outFile, html, 'utf8');
console.log(`✅ ${outFile}  (${(html.length / 1024).toFixed(1)} KB)`);
