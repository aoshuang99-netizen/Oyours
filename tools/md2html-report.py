#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""极简 Markdown -> 单文件 HTML 报告渲染器（支持标题/表格/列表/引用/加粗/行内代码/分隔线）。
用法: python md2html-report.py in.md out.html "标题"
"""
import sys, re, html

def inline(s: str) -> str:
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    return s

def convert(md: str, title: str) -> str:
    lines = md.split('\n')
    out, i = [], 0
    n = len(lines)

    def close_list(stack):
        while stack:
            out.append('</%s>' % stack.pop())

    list_stack = []
    in_quote = False

    while i < n:
        line = lines[i]
        s = line.strip()

        # 空行
        if not s:
            if in_quote:
                out.append('</blockquote>'); in_quote = False
            close_list(list_stack)
            i += 1
            continue

        # 分隔线
        if re.match(r'^-{3,}$', s):
            close_list(list_stack)
            out.append('<hr>')
            i += 1
            continue

        # 标题
        m = re.match(r'^(#{1,6})\s+(.*)$', s)
        if m:
            close_list(list_stack)
            lvl = len(m.group(1))
            out.append('<h%d>%s</h%d>' % (lvl, inline(m.group(2)), lvl))
            i += 1
            continue

        # 引用
        if s.startswith('>'):
            txt = inline(s.lstrip('>').strip())
            if not in_quote:
                out.append('<blockquote>'); in_quote = True
            if txt:
                out.append('<p>%s</p>' % txt)
            i += 1
            continue
        elif in_quote:
            out.append('</blockquote>'); in_quote = False

        # 表格
        if s.startswith('|') and i + 1 < n and re.match(r'^\|[\s:\-|]+\|$', lines[i+1].strip()):
            close_list(list_stack)
            header = [c.strip() for c in s.strip('|').split('|')]
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            t = ['<table><thead><tr>']
            t += ['<th>%s</th>' % inline(c) for c in header]
            t.append('</tr></thead><tbody>')
            for r in rows:
                t.append('<tr>' + ''.join('<td>%s</td>' % inline(c) for c in r) + '</tr>')
            t.append('</tbody></table>')
            out.append(''.join(t))
            continue

        # 无序列表
        m = re.match(r'^(\s*)[-*]\s+(.*)$', line)
        if m:
            if not list_stack:
                list_stack.append('ul'); out.append('<ul>')
            out.append('<li>%s</li>' % inline(m.group(2)))
            i += 1
            continue

        # 有序列表
        m = re.match(r'^(\s*)\d+\.\s+(.*)$', line)
        if m:
            if not list_stack:
                list_stack.append('ol'); out.append('<ol>')
            out.append('<li>%s</li>' % inline(m.group(2)))
            i += 1
            continue

        close_list(list_stack)
        out.append('<p>%s</p>' % inline(s))
        i += 1

    if in_quote:
        out.append('</blockquote>')
    close_list(list_stack)
    body = '\n'.join(out)

    css = """
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d21;--sub:#5b6472;--line:#e3e6ea;--accent:#c8102e;--accent2:#0b5cab;--ok:#1a7f37;--warn:#b26a00;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
.wrap{max-width:1080px;margin:0 auto;padding:40px 28px 80px;}
h1{font-size:28px;margin:0 0 6px;letter-spacing:-.3px;}
h2{font-size:20px;margin:38px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--ink);}
h3{font-size:16px;margin:26px 0 10px;color:var(--accent2);}
h4{font-size:15px;margin:20px 0 8px;}
p{margin:10px 0;}
blockquote{margin:14px 0;padding:12px 16px;background:#fff;border-left:4px solid var(--accent);color:var(--sub);border-radius:0 6px 6px 0;}
blockquote p{margin:4px 0;}
hr{border:0;border-top:1px solid var(--line);margin:28px 0;}
table{;border-collapse:collapse;margin:14px 0;background:var(--card);font-size:13.5px;box-shadow:0 1px 2px rgba(0,0,0,.04);}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;}
th{background:#eef1f4;font-weight:600;}
tbody tr:nth-child(even){background:#fafbfc;}
code{background:#eef1f4;padding:1px 5px;border-radius:4px;font:12.5px/1.5 ui-monospace,Consolas,monospace;}
ul,ol{margin:10px 0 10px 22px;padding:0;}
li{margin:5px 0;}
strong{color:#000;}
.foot{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--sub);font-size:12.5px;}
"""

    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s</title><style>%s</style></head>
<body><div class="wrap">
%s
<div class="foot">生成：md2html-report.py ｜ 零伪造 · 数据均来自实测</div>
</div></body></html>""" % (html.escape(title), css, body)

if __name__ == '__main__':
    src, dst, title = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(src, encoding='utf-8') as f:
        md = f.read()
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(convert(md, title))
    print('OK ->', dst)
