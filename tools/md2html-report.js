#!/usr/bin/env node
/**
 * 轻量 Markdown → HTML 报告转换器（本项目无 marked/markdown-it 依赖，故自带）
 *
 * 支持：h1~h4、表格、围栏代码块、有序/无序列表、引用、水平线、粗体、行内代码、链接。
 * 主题：浅色主调，并内置 prefers-color-scheme: dark 适配。
 *
 * 用法：node tools/md2html-report.js <in.md> <out.html> ["页面标题"]
 */
const fs = require('fs');
const path = require('path');

const [inFile, outFile, pageTitle] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('用法: node tools/md2html-report.js <in.md> <out.html> ["标题"]');
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

 function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

 function convert(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  let inCode = false, codeBuf = [], listType = null, inQuote = false;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^```/.test(line)) {
      if (!inCode) { closeList(); closeQuote(); inCode = true; codeBuf = []; }
      else { out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); inCode = false; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList(); closeQuote();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<div class="tw"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); closeQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    // 水平线
    if (/^\s*---+\s*$/.test(line)) { closeList(); closeQuote(); out.push('<hr>'); i++; continue; }

    // 引用
    if (/^>\s?/.test(line)) {
      closeList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${inline(line.replace(/^>\s?/, ''))}</p>`);
      i++; continue;
    }
    closeQuote();

    // 列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++; continue;
    }
    closeList();

    // 空行 / 段落
    if (!line.trim()) { i++; continue; }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  closeList(); closeQuote();
  return out.join('\n');
}

const md = fs.readFileSync(inFile, 'utf8');
const title = pageTitle || (md.match(/^#\s+(.+)$/m) || [, '报告'])[1];
const body = convert(md);

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#ffffff;--fg:#1a1d21;--muted:#5c6570;--line:#e3e7ec;--card:#f7f9fb;--accent:#0b5fff;--code-bg:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#9aa4ae;--line:#2a3037;--card:#1b1f24;--accent:#6aa4ff;--code-bg:#1f242a}}
*{box-sizing:border-box}
body{margin:0;padding:48px 24px 96px;background:var(--bg);color:var(--fg);
 font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:960px;margin:0 auto}
h1{font-size:28px;line-height:1.35;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:20px;margin:44px 0 14px;padding-bottom:8px;border-bottom:2px solid var(--line);letter-spacing:-.01em}
h3{font-size:16.5px;margin:30px 0 10px}
h4{font-size:15px;margin:22px 0 8px;color:var(--muted)}
p{margin:10px 0}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
a:hover{border-bottom-color:var(--accent)}
code{background:var(--code-bg);padding:2px 6px;border-radius:4px;font-size:.88em;
 font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:14px 0}
pre code{background:none;padding:0;font-size:12.5px;line-height:1.6}
blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid var(--accent);
 background:var(--card);border-radius:0 6px 6px 0}
blockquote p{margin:4px 0;color:var(--muted);font-size:14px}
hr{border:none;border-top:1px solid var(--line);margin:34px 0}
ul,ol{margin:10px 0;padding-left:24px}
li{margin:5px 0}
.tw{overflow-x:auto;margin:16px 0}
table{border-collapse:collapse;;font-size:13.5px}
th,td{border:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600;white-space:nowrap}
tbody tr:nth-child(even){background:color-mix(in srgb,var(--card) 55%,transparent)}
.foot{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
</style></head>
<body><main>
${body}
<div class="foot">由 tools/md2html-report.js 于 ${new Date().toLocaleString('zh-CN')} 生成 · 源文件 ${esc(path.basename(inFile))}</div>
</main></body></html>`;

fs.writeFileSync(outFile, html, 'utf8');
console.log(`✅ ${outFile} (${Buffer.byteLength(html)} bytes)`);
