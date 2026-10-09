#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build-account-table.py — 把 _active-published-.json 渲染为 CSV / XLSX / HTML

输入：exports/_active-published-.json（由 tools/export-active-published-.js 生成）
输出：
  exports/MSCMS-活跃发布账号清单-<date>.csv    （UTF-8 BOM，Excel 直接打开）
  exports/MSCMS-活跃发布账号清单-<date>.xlsx   （格式化表格，含冻结表头/筛选/列宽）
  exports/MSCMS-活跃发布账号清单-<date>.html   （可搜索/排序/点击复制，密码默认掩码）
"""
import json
import os
import sys
import html
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORTS = os.path.join(os.path.dirname(HERE), 'exports')
SRC = os.path.join(EXPORTS, '_active-published-.json')

with open(SRC, encoding='utf-8') as f:
    data = json.load(f)

summary = data['summary']
rows = data['rows']
orphans = data['deletedOrphan']
date_tag = datetime.date.today().isoformat()
BASE = f'MSCMS-活跃发布账号清单-{date_tag}'

TUMBLR_LOGIN = 'https://www.tumblr.com/login'

def norm_url(u):
    """publish_url 里 www.tumblr.com/blog/view/<blog>/<id> 与 <blog>.tumblr.com 等价；
    这里统一给出短域名形式，便于直接打开。"""
    return u

# ─────────────────────────── CSV ───────────────────────────
COLS = [
    ('序号', lambda r, i: i + 1),
    ('账号ID', lambda r, i: r['id']),
    ('登录名', lambda r, i: r['']),
    ('密码', lambda r, i: r['']),
    ('邮箱', lambda r, i: r['email']),
    ('邮箱类型', lambda r, i: r['emailKind']),
    ('Tumblr博客', lambda r, i: r['blog']),
    ('账号状态', lambda r, i: r['status']),
    ('已发内容数', lambda r, i: r['publishedCount']),
    ('最近发布时间', lambda r, i: (r['lastPublishedAt'] or '')[:19].replace('T', ' ')),
    ('最近发布链接', lambda r, i: r['lastPublishUrl']),
    ('一键登录(Tumblr)', lambda r, i: TUMBLR_LOGIN),
    ('博客主页(一键打开)', lambda r, i: f"https://{r['blog']}.tumblr.com" if r['blog'] else ''),
]

def csv_cell(v):
    s = '' if v is None else str(v)
    if any(c in s for c in [',', '"', '\n', '\r']):
        return '"' + s.replace('"', '""') + '"'
    return s

csv_path = os.path.join(EXPORTS, BASE + '.csv')
with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
    f.write(','.join(c[0] for c in COLS) + '\r\n')
    for i, r in enumerate(rows):
        f.write(','.join(csv_cell(fn(r, i)) for _, fn in COLS) + '\r\n')
print('[CSV ] ', csv_path)

# ─────────────────────────── XLSX ──────────────────────────
xlsx_path = os.path.join(EXPORTS, BASE + '.xlsx')
try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = '活跃发布账号'

    hdr_fill = PatternFill('solid', fgColor='1F3864')
    hdr_font = Font(color='FFFFFF', bold=True, size=11)
    thin = Side(style='thin', color='D9D9D9')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for c, (name, _) in enumerate(COLS, start=1):
        cell = ws.cell(row=1, column=c, value=name)
        cell.fill = hdr_fill
        cell.font = hdr_font
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border = border

    for i, r in enumerate(rows):
        for c, (_, fn) in enumerate(COLS, start=1):
            v = fn(r, i)
            cell = ws.cell(row=i + 2, column=c, value=v)
            cell.border = border
            cell.alignment = Alignment(vertical='center')
        # 链接列做超链接
        link_col = [n for n, _ in COLS].index('最近发布链接') + 1
        if r['lastPublishUrl']:
            cc = ws.cell(row=i + 2, column=link_col)
            cc.hyperlink = r['lastPublishUrl']
            cc.font = Font(color='0563C1', underline='single')
        blog_col = [n for n, _ in COLS].index('博客主页(一键打开)') + 1
        if r['blog']:
            cc = ws.cell(row=i + 2, column=blog_col)
            cc.hyperlink = f"https://{r['blog']}.tumblr.com"
            cc.font = Font(color='0563C1', underline='single')
        login_col = [n for n, _ in COLS].index('一键登录(Tumblr)') + 1
        cc = ws.cell(row=i + 2, column=login_col)
        cc.hyperlink = TUMBLR_LOGIN
        cc.font = Font(color='0563C1', underline='single')

    widths = [6, 20, 16, 20, 30, 18, 16, 10, 12, 20, 52, 24, 34]
    for c, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = f'A1:{get_column_letter(len(COLS))}{len(rows)+1}'
    ws.row_dimensions[1].height = 30

    # Sheet 2：汇总 + 已删孤儿
    ws2 = wb.create_sheet('汇总与已删账号')
    ws2['A1'] = '导出口径与汇总'
    ws2['A1'].font = Font(bold=True, size=13, color='1F3864')
    meta = [
        ('生成时间', summary['generatedAt'][:19].replace('T', ' ')),
        ('数据目录', summary['dataDir']),
        ('筛选口径', 'status=active ∩ 有 publish_url 的成功发布记录 ∩ id 为 tumblr_* 真实形态'),
        ('账号总数（.json）', summary['Total']),
        ('发布记录总数（publish.json）', summary['publishTotal']),
        ('★ 导出的活跃发布账号数', summary['targetCount']),
        ('其中累计成功发布', summary['totalPublished']),
        ('密码解密成功', summary['Ok']),
        ('密码解密失败', summary['Failed']),
        ('缺 blogName', summary['blogMissing']),
        ('邮箱类型分布', json.dumps(summary['emailKind'], ensure_ascii=False)),
        ('已删除孤儿账号（有发布记录但账号已删）', summary['deletedOrphanCount']),
    ]
    for i, (k, v) in enumerate(meta, start=3):
        ws2.cell(row=i, column=1, value=k).font = Font(bold=True)
        ws2.cell(row=i, column=2, value=v)
    ws2.column_dimensions['A'].width = 40
    ws2.column_dimensions['B'].width = 70

    r0 = len(meta) + 5
    ws2.cell(row=r0, column=1, value='已删除账号（有历史发布记录，账号主体已删除，仅存 token 残留）').font = Font(bold=True, size=12, color='C00000')
    for c, name in enumerate(['账号ID', 'Tumblr博客', '历史发布数', '最近发布', '最近发布链接'], start=1):
        cell = ws2.cell(row=r0 + 1, column=c, value=name)
        cell.fill = hdr_fill
        cell.font = hdr_font
    for i, o in enumerate(orphans):
        ws2.cell(row=r0 + 2 + i, column=1, value=o['id'])
        ws2.cell(row=r0 + 2 + i, column=2, value=o['blog'])
        ws2.cell(row=r0 + 2 + i, column=3, value=o['publishedCount'])
        ws2.cell(row=r0 + 2 + i, column=4, value=(o['lastPublishedAt'] or '')[:19].replace('T', ' '))
        ws2.cell(row=r0 + 2 + i, column=5, value=o['lastPublishUrl'])

    wb.save(xlsx_path)
    print('[XLSX] ', xlsx_path)
except ImportError:
    print('[XLSX]  跳过（未安装 openpyxl）')
    xlsx_path = None

# ─────────────────────────── HTML ──────────────────────────
def esc(s):
    return html.escape('' if s is None else str(s))

trs = []
for i, r in enumerate(rows):
    blog_link = f"https://{r['blog']}.tumblr.com" if r['blog'] else ''
    trs.append(f"""<tr>
  <td class="num">{i+1}</td>
  <td class="mono">{esc(r['id'])}</td>
  <td><span class="user">{esc(r[''] or '—')}</span></td>
  <td class="pw" data-pw="{esc(r[''])}"><span class="mask">••••••••••</span><button class="btn-show" type="button">显示</button><button class="btn-copy" type="button">复制</button></td>
  <td class="mono small">{esc(r['email'] or '—')}</td>
  <td><span class="tag warn">{esc(r['emailKind'])}</span></td>
  <td class="mono">{esc(r['blog'] or '—')}</td>
  <td><span class="tag ok">{esc(r['status'])}</span></td>
  <td class="num strong">{r['publishedCount']}</td>
  <td class="small">{(r['lastPublishedAt'] or '')[:19].replace('T',' ')}</td>
  <td><a href="{esc(r['lastPublishUrl'])}" target="_blank" rel="noopener" class="lnk">打开内容 ↗</a></td>
  <td><a href="{TUMBLR_LOGIN}" target="_blank" rel="noopener" class="lnk primary">一键登录 ↗</a></td>
  <td>{f'<a href="{blog_link}" target="_blank" rel="noopener" class="lnk">博客主页 ↗</a>' if blog_link else '—'}</td>
</tr>""")

html_path = os.path.join(EXPORTS, BASE + '.html')
html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MSCMS 活跃发布账号清单 · {date_tag}</title>
<style>
  :root {{
    --bg:#f5f6f8; --panel:#ffffff; --ink:#1a1d21; --muted:#6b7280;
    --line:#e3e6ea; --brand:#1f3864; --ok:#0f8a4c; --warn:#b45309; --danger:#c0392b;
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif; }}
  .wrap {{ max-width:1800px; margin:0 auto; padding:24px 20px 60px; }}
  h1 {{ font-size:22px; margin:0 0 6px; letter-spacing:.2px; }}
  .sub {{ color:var(--muted); font-size:13px; margin-bottom:18px; }}
  .cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px; }}
  .card {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }}
  .card .k {{ color:var(--muted); font-size:12px; margin-bottom:6px; }}
  .card .v {{ font-size:22px; font-weight:600; letter-spacing:-.3px; }}
  .card .v.small {{ font-size:15px; font-weight:500; }}
  .notice {{ background:#fff8e6; border:1px solid #f0d9a0; border-left:4px solid var(--warn);
    border-radius:8px; padding:12px 16px; margin-bottom:18px; font-size:13px; }}
  .notice b {{ color:var(--warn); }}
  .toolbar {{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }}
  search] {{ flex:1; min-width:240px; padding:9px 12px; border:1px solid var(--line);
    border-radius:8px; font-size:14px; background:var(--panel); }}
  .tbtn {{ padding:9px 14px; border:1px solid var(--line); background:var(--panel);
    border-radius:8px; cursor:pointer; font-size:13px; }}
  .tbtn:hover {{ border-color:var(--brand); color:var(--brand); }}
  .tbtn.on {{ background:var(--brand); color:#fff; border-color:var(--brand); }}
  .tablebox {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:auto; max-height:74vh; }}
  table {{ border-collapse:separate; border-spacing:0; ; font-size:13px; }}
  th, td {{ padding:9px 11px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }}
  thead th {{ position:sticky; top:0; background:var(--brand); color:#fff; font-weight:600;
    font-size:12px; z-index:2; cursor:pointer; user-select:none; }}
  thead th:hover {{ background:#2a4a80; }}
  tbody tr:hover {{ background:#f0f4fb; }}
  .num {{ text-align:right; font-variant-numeric:tabular-nums; }}
  .strong {{ font-weight:700; color:var(--brand); }}
  .mono {{ font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; }}
  .small {{ font-size:12px; color:var(--muted); }}
  .user {{ font-weight:600; }}
  .tag {{ display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; white-space:nowrap; }}
  .tag.ok {{ background:#e6f6ee; color:var(--ok); }}
  .tag.warn {{ background:#fef3e2; color:var(--warn); }}
  .lnk {{ color:#0563c1; text-decoration:none; font-size:12px; }}
  .lnk:hover {{ text-decoration:underline; }}
  .lnk.primary {{ font-weight:600; background:#eaf1ff; padding:3px 9px; border-radius:6px; }}
  .pw {{ font-family:ui-monospace,Consolas,monospace; }}
  .pw .mask {{ color:var(--muted); letter-spacing:1px; }}
  .pw .val {{ font-weight:600; }}
  .btn-show,.btn-copy {{ margin-left:6px; font-size:11px; padding:2px 7px; border-radius:5px;
    border:1px solid var(--line); background:#fff; cursor:pointer; color:var(--muted); }}
  .btn-show:hover,.btn-copy:hover {{ border-color:var(--brand); color:var(--brand); }}
  .hint {{ color:var(--muted); font-size:12px;  }}
  .toast {{ position:fixed; bottom:26px; left:50%; transform:translateX(-50%) translateY(20px);
    background:#1a1d21; color:#fff; padding:10px 20px; border-radius:8px; font-size:13px;
    opacity:0; pointer-events:none; transition:.25s; }}
  .toast.show {{ opacity:1; transform:translateX(-50%) translateY(0); }}
</style>
</head>
<body>
<div class="wrap">
  <h1>MSCMS 活跃发布账号清单</h1>
  <div class="sub">口径：账号状态 = active ∩ 存在成功发布记录（publish_url 非空）∩ 真实账号 id · 生成于 {summary['generatedAt'][:19].replace('T',' ')}</div>

  <div class="cards">
    <div class="card"><div class="k">活跃发布账号</div><div class="v">{summary['targetCount']}</div></div>
    <div class="card"><div class="k">累计成功发布</div><div class="v">{summary['totalPublished']}</div></div>
    <div class="card"><div class="k">密码可解密</div><div class="v">{summary['Ok']}<span style="font-size:13px;color:var(--muted)">/{summary['targetCount']}</span></div></div>
    <div class="card"><div class="k">已删账号(有发布史)</div><div class="v">{summary['deletedOrphanCount']}</div></div>
    <div class="card"><div class="k">缺 blogName</div><div class="v">{summary['blogMissing']}</div></div>
    <div class="card"><div class="k">邮箱类型</div><div class="v small">程序生成占位 × {summary['emailKind'].get('程序生成占位',0)}</div></div>
  </div>

  <div class="notice">
    <b>两点必须说明：</b><br>
    1. <b>邮箱为程序生成占位</b>（形态 <code>&lt;登录名&gt;@gmail.com</code>，与登录名完全同构），
       <b>并非真实可收信的邮箱</b> —— 不能用于"忘记密码"找回，也不能作为收验证码的渠道。<br>
    2. <b>Tumblr 不支持把账号密码拼进 URL 的一键登录</b>（官方登录页只接受表单提交）。
       故「一键登录」列打开的是官方登录页，用户名/密码就在相邻列，可直接复制粘贴。
       「博客主页」列可一键打开该账号已发布内容的页面。
  </div>

  <div class="toolbar">
    <input type="search" id="q" placeholder="搜索 登录名 / 账号ID / 邮箱 / 博客名 …">
    <button class="tbtn" id="togglePw" type="button">全部显示密码</button>
    <button class="tbtn" id="exportCsv" type="button">导出 CSV</button>
    <span class="hint" id="count"></span>
  </div>

  <div class="tablebox">
    <table id="tbl">
      <thead><tr>
        <th data-t="num">#</th>
        <th data-t="str">账号ID</th>
        <th data-t="str">登录名</th>
        <th data-t="str">密码</th>
        <th data-t="str">邮箱</th>
        <th data-t="str">邮箱类型</th>
        <th data-t="str">Tumblr博客</th>
        <th data-t="str">状态</th>
        <th data-t="num">已发内容数</th>
        <th data-t="str">最近发布时间</th>
        <th>最近发布链接</th>
        <th>一键登录</th>
        <th>博客主页</th>
      </tr></thead>
      <tbody>
{''.join(trs)}
      </tbody>
    </table>
  </div>
  <div class="hint">提示：点击表头可排序；密码默认掩码，避免截图/投屏泄露，点「显示」后可用「复制」。</div>
</div>
<div class="toast" id="toast"></div>
<script>
(() {{
  var tbl = document.getElementById('tbl');
  var toast = document.getElementById('toast');
  var timer = null;
   tip(msg) {{
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(timer); timer = setTimeout((){{ toast.classList.remove('show'); }}, 1600);
  }}

  // 显示 / 复制密码
  tbl.addEventListener('click', (e) {{
    var td = e.target.closest('.pw');
    if (!td) return;
    var val = td.getAttribute('data-pw') || '';
    if (e.target.classList.contains('btn-show')) {{
      var showing = td.classList.toggle('shown');
      td.querySelector('.mask').textContent = showing ? val : '••••••••••';
      e.target.textContent = showing ? '隐藏' : '显示';
    }} else if (e.target.classList.contains('btn-copy')) {{
      navigator.clipboard.writeText(val).then((){{ tip('密码已复制'); }})
        .catch((){{ tip('复制失败，请手动选择'); }});
    }}
  }});

  var allShown = false;
  document.getElementById('togglePw').addEventListener('click', () {{
    allShown = !allShown;
    this.classList.toggle('on', allShown);
    this.textContent = allShown ? '隐藏全部密码' : '全部显示密码';
    Array.prototype.forEach.call(tbl.querySelectorAll('.pw'), (td) {{
      td.querySelector('.mask').textContent = allShown ? (td.getAttribute('data-pw') || '') : '••••••••••';
      var b = td.querySelector('.btn-show'); if (b) b.textContent = allShown ? '隐藏' : '显示';
    }});
  }});

  // 搜索
  var q = document.getElementById('q');
  var countEl = document.getElementById('count');
   applyFilter() {{
    var k = (q.value || '').trim().toLowerCase();
    var vis = 0;
    Array.prototype.forEach.call(tbl.tBodies[0].rows, (tr) {{
      var hit = !k || tr.textContent.toLowerCase().indexOf(k) !== -1;
      tr.style.display = hit ? '' : 'none';
      if (hit) vis++;
    }});
    countEl.textContent = '显示 ' + vis + ' / ' + tbl.tBodies[0].rows.length + ' 条';
  }}
  q.addEventListener('input', applyFilter);
  applyFilter();

  // 排序
  var dir = {{}};
  Array.prototype.forEach.call(tbl.tHead.rows[0].cells, (th, idx) {{
    th.addEventListener('click', () {{
      var type = th.getAttribute('data-t');
      if (!type) return;
      dir[idx] = !dir[idx];
      var rows = Array.prototype.slice.call(tbl.tBodies[0].rows);
      rows.sort((a, b) {{
        var x = a.cells[idx].getAttribute('data-pw') || a.cells[idx].textContent.trim();
        var y = b.cells[idx].getAttribute('data-pw') || b.cells[idx].textContent.trim();
        if (type === 'num') {{ return (parseFloat(x) || 0) - (parseFloat(y) || 0); }}
        return x.localeCompare(y, 'zh');
      }});
      if (!dir[idx]) rows.reverse();
      rows.forEach((r) {{ tbl.tBodies[0].appendChild(r); }});
    }});
  }});

  // 导出 CSV（跟随当前搜索过滤）
  document.getElementById('exportCsv').addEventListener('click', () {{
    var lines = [];
    var heads = [];
    Array.prototype.forEach.call(tbl.tHead.rows[0].cells, (th) {{ heads.push(th.textContent.trim()); }});
    lines.push(heads.join(','));
    Array.prototype.forEach.call(tbl.tBodies[0].rows, (tr) {{
      if (tr.style.display === 'none') return;
      var vals = [];
      Array.prototype.forEach.call(tr.cells, (td, i) {{
        var v = td.getAttribute('data-pw') || td.textContent.replace(/(显示|隐藏|复制)/g, '').trim();
        if (/[,"\\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
        vals.push(v);
      }});
      lines.push(vals.join(','));
    }});
    var blob = new Blob(['\\ufeff' + lines.join('\\r\\n')], {{ type: 'text/csv;charset=utf-8' }});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '{BASE}.csv';
    a.click();
    tip('CSV 已导出');
  }});
}})();
</script>
</body>
</html>
"""
with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html_doc)
print('[HTML] ', html_path)

print()
print('=== 汇总 ===')
print('  目标账号:', summary['targetCount'], '| 累计发布:', summary['totalPublished'])
print('  密码解密: ok=' + str(summary['Ok']) + ' failed=' + str(summary['Failed']))
print('  已删孤儿:', summary['deletedOrphanCount'])
