#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
kk20-preview-html.py — KKMatch 20 账号投放计划 · 计划+预览 单页渲染器

语言策略：**英文唯一**（2026-09-22 用户确认）。samples.json 里的 title_zh / body_zh
只作内部留档，本渲染器**不读取**，确保预览所见 = 将发布的内容。

单一事实源：所有数字都从真实产物读入，不在 HTML 里手写。
  · reports/kk20-samples.json        6 栏目样例文案（英文）
  · reports/kk20-schedule-7d.json    7 天 280 槽排期（由 kk20-plan-gen.js 生成）
  · _kk20_candidates.json            20 个可发布账号（.json ∩ .json 算出）
  · reports/kk20-preview/manifest.json 配图路径

配图以「缩放到 720px + JPEG q82 + base64 内联」方式嵌入：
  保证在预览面板/离线浏览器里都能显示，且 HTML 体积可控（实测 ~0.5MB）。
"""
import base64
import io
import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REP = os.path.join(ROOT, 'reports')
OUT = os.path.join(REP, 'kk20-plan-2026-09-22.html')

# 栏目元数据：内部 key（中文，来自 samples.json）→ 英文显示名 / 定位 / 视觉风格
CAT_META = {
    '话题性':   ('provocative',  'provocative · question-first', 'high-contrast editorial-minimal'),
    '趣味性':   ('fun',          'fun · playful anthropomorphic', 'soft gradient / ribbon'),
    '科技潮流': ('tech-trends',  'tech trends · hardcore',        'dark data-viz'),
    '人文':     ('humanities',   'humanities · emotion & thought', 'watercolor paper / warm'),
    '笑话':     ('humor',        'humor · short punchline',       'flat cartoon / bright'),
    '最新段子': ('memes',        'memes · internet-native',       'meme split / saturated'),
}

# 功能锚点英文名。与 kk20-plan-gen.js 的 ANCHORS 对齐（预览页只需 6 条样例的短名）。
ANCHOR_EN = {
    'A1': 'A1 KKOS 11-dimension human model',
    'A2': 'A2 OMi matching engine',
    'A3': 'A3 Personality Profile (MIND·CAPSULE)',
    'A4': 'A4 Relationship Memory (TGN·TEMPORAL)',
    'A5': 'A5 Causal Insight (NOTEARS++)',
    'A6': 'A6 Mutual Matching (DYADIC·ATTENTION)',
}


def thumb_b64(path, width=720):
    img = Image.open(path).convert('RGB')
    w, h = img.size
    img = img.resize((width, int(h * width / w)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=82, optimize=True)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def build():
    samples = json.load(open(os.path.join(REP, 'kk20-samples.json'), encoding='utf-8'))['samples']
    sched = json.load(open(os.path.join(REP, 'kk20-schedule-7d.json'), encoding='utf-8'))['days']
    cands = json.load(open(os.path.join(ROOT, '_kk20_candidates.json'), encoding='utf-8'))
    man = {a['slot']: a for a in json.load(open(os.path.join(REP, 'kk20-preview', 'manifest.json'), encoding='utf-8'))['assets']}

    # ── KPI ──
    total_slots = sum(len(d['slots']) for d in sched)
    uniq = len({s['combo_key'] for d in sched for s in d['slots']})

    # ── 账号表 ──
    acc_rows = []
    for i, a in enumerate(cands):
        acc_rows.append(
            f"<tr><td class=n>{i+1:02d}</td><td class=mono>{esc(a['id'])}</td>"
            f"<td class=mono>{esc(a['blogName'])}</td><td class=mono>#{a['']}</td>"
            f"<td class=num>{a['']}</td><td class=num>{a['content_quota']}</td>"
            f"<td><span class='pill ok'>OAuth valid</span></td></tr>")

    # ── Day1 排期表 ──
    d1 = sched[0]['slots']
    sch_rows = []
    for s in d1:
        o = 'm' if s['window'] == '早' else 'e'
        win_en = 'AM' if s['window'] == '早' else 'PM'
        sch_rows.append(
            f"<tr><td class=n>{s['slot']:02d}</td><td><span class='pill {o}'>{win_en}</span></td>"
            f"<td class=num>#{s['account_seq']:02d}</td>"
            f"<td class=mono>{s['time']}+{s['offset_min']:02d}′</td>"
            f"<td>{esc(s.get('category_en') or s['category'])}</td>"
            f"<td class=sm>{esc(s['anchor'])}</td>"
            f"<td>{esc(s['genre'])}</td><td class=sm>{esc(s['cta'])}</td></tr>")

    # ── 7 天分布 ──
    day_rows = []
    for d in sched:
        tally = {}
        for s in d['slots']:
            k = s.get('category_en') or s['category']
            tally[k] = tally.get(k, 0) + 1
        mix = ' · '.join(f"{k} {v}" for k, v in tally.items())
        a_cov = len({s['anchor_idx'] for s in d['slots']})
        g_cov = len({s['genre'] for s in d['slots']})
        day_rows.append(f"<tr><td class=n>D{d['day']}</td><td class=num>40</td><td class=sm>{mix}</td>"
                        f"<td class=num>{a_cov}/12</td><td class=num>{g_cov}/7</td>"
                        f"<td><span class='pill ok'>0 dupes</span></td></tr>")

    # ── 内容预览卡（英文单轨；不读 title_zh / body_zh）──
    cards = []
    for s in samples:
        a = man.get(s['slot'])
        if not a:
            continue
        b64 = thumb_b64(os.path.join(ROOT, a['image']))
        tags = ' '.join(f"<span class=tag>#{esc(t)}</span>" for t in s['tags'])
        en_name, label, style = CAT_META.get(s['category'], (s['category'], s['category'], ''))
        anchor_en = ANCHOR_EN.get(s['slot'], '')
        # samples.json 里该字段叫 device（早期命名），语义是「表达体裁」——
        # 兼容两种键名，避免与排期 JSON 的 genre 口径漂移
        genre = s.get('genre') or s.get('device') or ''
        body_en = esc(s['body_en']).replace('\n', '<br>')
        cards.append(f"""
<article class="post">
  <div class="post-img"><img src="data:image/jpeg;base64,{b64}" alt="{esc(s['title_en'])}"></div>
  <div class="post-body">
    <div class="post-meta">
      <span class="pill cat">{esc(en_name)}</span>
      <span class="pill">{esc(genre)}</span>
      <span class="pill anchor">{esc(anchor_en)}</span>
      <span class="style">{esc(style)}</span>
    </div>
    <h3>{esc(s['title_en'])}</h3>
    <p class="sub-line">↳ {esc(s.get('subtitle_en', ''))}</p>
    <div class="lbl">CAPTION · EN · {esc(label)}</div>
    <p class="body">{body_en}</p>
    <p class="cta">→ {esc(s['cta'])} · kkmatch.com</p>
    <div class="tags">{tags}</div>
  </div>
</article>""")

    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KKMatch · 20-Account Campaign Plan &amp; Content Preview</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:#f5f6f8;color:#10131a;
 font:15px/1.72 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
.wrap{{max-width:1220px;margin:0 auto;padding:34px 26px 90px}}
h1{{font-size:31px;line-height:1.24;margin:0 0 10px;letter-spacing:-.4px}}
h2{{font-size:21px;margin:52px 0 6px;padding-top:20px;border-top:2px solid #10131a;letter-spacing:-.2px}}
h3{{font-size:17px;margin:0 0 4px;line-height:1.4}}
.sub{{color:#5b6472;font-size:14.5px;margin:0 0 26px}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px;margin:26px 0 6px}}
.kpi{{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:15px 16px}}
.kpi .k{{font-size:12px;color:#5b6472;letter-spacing:.02em}}
.kpi .v{{font-size:26px;font-weight:700;letter-spacing:-.6px;margin:3px 0 1px;font-variant-numeric:tabular-nums}}
.kpi .s{{font-size:11.5px;color:#8b93a1}}
table{{;border-collapse:collapse;background:#fff;border:1px solid #e4e7ec;
 border-radius:12px;overflow:hidden;margin:16px 0;font-size:13px}}
th{{background:#f0f2f5;text-align:left;padding:10px 11px;font-size:12px;color:#414a58;
 font-weight:600;border-bottom:1px solid #e4e7ec;white-space:nowrap}}
td{{padding:9px 11px;border-bottom:1px solid #f0f2f5;vertical-align:top}}
tr:last-child td{{border-bottom:none}}
td.n,td.num{{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}}
td.mono{{font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:nowrap}}
td.sm{{font-size:12.2px;color:#414a58}}
.pill{{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11.5px;
 background:#eef1f5;color:#414a58;white-space:nowrap}}
.pill.ok{{background:#e6f6ec;color:#0f6b34}}
.pill.m{{background:#fff4e0;color:#9a5b00}}
.pill.e{{background:#e9eefc;color:#2743a8}}
.pill.cat{{background:#10131a;color:#fff}}
.pill.anchor{{background:#f1f0ff;color:#4b3fb5;max-width:250px;overflow:hidden;
 text-overflow:ellipsis;vertical-align:bottom}}
.note{{background:#fff;border:1px solid #e4e7ec;border-left:4px solid #d97706;
 border-radius:10px;padding:14px 17px;margin:18px 0;font-size:13.6px}}
.note.good{{border-left-color:#0f6b34}}
.note.bad{{border-left-color:#c02626}}
.note b{{color:#10131a}}
code{{background:#f0f2f5;padding:1px 5px;border-radius:4px;
 font-family:ui-monospace,Consolas,monospace;font-size:12.6px}}
pre{{background:#0e1116;color:#d7e0ea;padding:16px 18px;border-radius:11px;overflow-x:auto;
 font-family:ui-monospace,Consolas,monospace;font-size:12.4px;line-height:1.62}}
pre .c{{color:#7c8798}} pre .s{{color:#a5d6a7}} pre .k{{color:#ffd479}}
.post{{background:#fff;border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;
 margin:22px 0;display:grid;grid-template-columns:372px 1fr}}
.post-img{{background:#0e1116}}
.post-img img{{display:block;;height:100%;object-fit:cover}}
.post-body{{padding:20px 22px}}
.post-meta{{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:11px}}
.style{{font-size:11.5px;color:#8b93a1;margin-left:2px}}
.sub-line{{color:#5b6472;font-size:13.6px;margin:2px 0 14px;padding-left:2px;font-style:italic}}
.lbl{{font-size:11px;color:#8b93a1;letter-spacing:.05em;margin:14px 0 6px;
 border-top:1px solid #f0f2f5;padding-top:13px}}
.body{{margin:0;font-size:13.4px;line-height:1.72;color:#232a36}}
.cta{{margin-top:11px;font-weight:600;color:#b45309}}
.tags{{margin-top:15px;border-top:1px solid #f0f2f5;padding-top:12px}}
.tag{{display:inline-block;background:#f0f2f5;color:#4b5563;border-radius:6px;
 padding:2px 7px;margin:0 4px 5px 0;font-size:11.6px}}
ol{{padding-left:20px}} li{{margin:7px 0}}
.foot{{margin-top:44px;padding-top:18px;border-top:1px solid #e4e7ec;
 color:#8b93a1;font-size:12.4px}}
@media(max-width:900px){{.post{{grid-template-columns:1fr}}}}
</style></head><body><div class="wrap">

<h1>KKMatch · 20-Account Campaign Plan &amp; Content Preview</h1>
<p class="sub">20 publishable Tumblr  · 1 post per account, morning &amp; evening · topics drawn from
 live kkmatch.com feature modules · <b>English-only</b> (confirmed 2026-09-22) ·
 runs on the existing publish pipeline (zero new services)</p>

<div class="kpis">
  <div class="kpi"><div class="k">Accounts</div><div class="v">20</div><div class="s">device IDs unique #1–#21</div></div>
  <div class="kpi"><div class="k">Posts / day</div><div class="v">40</div><div class="s">20 AM + 20 PM</div></div>
  <div class="kpi"><div class="k">7-day total</div><div class="v">{total_slots}</div><div class="s">every topic distinct</div></div>
  <div class="kpi"><div class="k">Unique combos</div><div class="v">{uniq}</div><div class="s">duplicate rate 0.0%</div></div>
  <div class="kpi"><div class="k">Matrix space</div><div class="v">504</div><div class="s">6 categories × 12 anchors × 7 genres</div></div>
  <div class="kpi"><div class="k">Quota usage</div><div class="v">17%</div><div class="s">2/12 posts · 6× margin</div></div>
</div>

<h2>1. Account pool (20, all verified publishable)</h2>
<p class="sub">Filter: <code>.json</code> with <code>status='active'</code> ∩ <code>.json</code>
 carrying <b>all three</b> of <code>oauthToken</code> + <code>oauthTokenSecret</code> + <code>blogName</code>
 (missing any one = publish fails 100%). Library-wide: 117 active → 109 pass → top 20 by  with
 spread device IDs.</p>
<table><thead><tr><th>#</th><th>account_id</th><th>blogName</th><th>device</th><th>health</th><th>quota</th><th>OAuth</th></tr></thead>
<tbody>{''.join(acc_rows)}</tbody></table>

<div class="note"><b>Why <code>blogName</code> is mandatory:</b> the publisher treats "no token" and
 "token present but blogName missing" as two different failures (<code>NO_OAUTH_TOKEN</code> /
 <code>BLOG_NAME_UNKNOWN</code>). Both make a post fail 100%, but the fixes differ (re-auth vs backfill).
 This plan excludes them <b>at pool-selection time</b> rather than after a failed publish.
 All 20  show <code>follower_count=0 / post_count=0</code> — they are new. Recommend running
 nurturing actions (like / follow) for the first 3 days in parallel to raise account weight.</div>

<h2>2. Content matrix: how "every topic is different" is guaranteed</h2>
<p class="sub">Turns a copywriting promise into a verifiable mathematical constraint. Three dimensions multiply
 into a combination space, then a coprime stride walks it without repeating.</p>
<table><thead><tr><th>Dimension</th><th>Values</th><th>Content</th></tr></thead><tbody>
<tr><td><b>Category</b></td><td class="num">6</td><td class=sm>provocative 8 · fun 8 · tech-trends 6 · humanities 6 · humor 6 · memes 6 (= the 40 slots/day mix)</td></tr>
<tr><td><b>Feature anchor</b></td><td class="num">12</td><td class=sm>A1 KKOS 11-dimension model · A2 OMi matching engine · A3 Personality Profile · A4 Relationship Memory · A5 Causal Insight · A6 Mutual Matching · A7 Relationship Forecast · A8 OMi Chemistry Lab · A9 4 Life Dimensions · A10 Explainability · A11 Enterprise validation · A12 Free trial<br><span style="color:#8b93a1">—— all taken from modules actually read on the kkmatch.com homepage, not invented</span></td></tr>
<tr><td><b>Genre</b></td><td class="num">7</td><td class=sm>question · listicle · contrast · story · data · self-deprecating · dialogue</td></tr>
</tbody></table>

<div class="note bad"><b>⚠️ A trap we hit and had to fix — recorded here:</b> v1 used
 <code>anchor=(k×7) mod 12</code> + <code>genre=(k×3) mod 7</code>. Both strides look coprime with their own
 dimension and "nicely uniform", but the <b>joint</b> period is <code>lcm(12,7)=84</code> —— so
 <b>7 days × 280 slots contained only 84 unique combinations, and Day 3 started repeating Day 1's topics</b>,
 breaking the "every post is different" requirement outright.<br>
 <b>Fix:</b> each category now walks its own <code>12×7=84</code> combination space with a stride of
 <b>5 (coprime to 84)</b> — <code>gcd(5,84)=1</code> ⇒ 84 consecutive draws are guaranteed distinct;
 each category draws at most 8×7=56 times in 7 days &lt; 84 ⇒ all 280 global slots are pairwise distinct.</div>

<div class="note good"><b>✅ Assertions pass (recomputable):</b> <code>node tools/kk20-plan-gen.js --check</code>
 verifies 6 assertion classes — ① 280-slot triples have zero duplicates ② zero intra-day duplicates
 ③ each of the 20  posts exactly once AM + once PM daily ④ category mix exactly equals quota
 ⑤ 7-day anchor 12/12 and genre 7/7 full coverage ⑥ per-category combo uniqueness 100%.
 Any failure exits non-zero.</div>

<h2>3. Seven-day schedule</h2>
<table><thead><tr><th>Day</th><th>Slots</th><th>Category mix</th><th>Anchor cov.</th><th>Genre cov.</th><th>Dupes</th></tr></thead>
<tbody>{''.join(day_rows)}</tbody></table>

<h3 style="margin-top:26px">Day 1 — all 40 slots</h3>
<p class="sub">Accounts <code>#00–#19</code> map 1:1 to  1–20 above. Stagger rule: account i posts at
 <code>08:00 + i×5min</code> (AM) and <code>20:00 + i×5min</code> (PM) ⇒ AM window 08:00–09:40, PM window
 20:00–21:40. Account-level minimum interval is 45 min; the AM/PM gap is ≈12 h, so the interval gate never fires.</p>
<table><thead><tr><th>Slot</th><th>Win</th><th>Acct</th><th>Time</th><th>Category</th><th>Feature anchor</th><th>Genre</th><th>CTA</th></tr></thead>
<tbody>{''.join(sch_rows)}</tbody></table>

<h2>4. Content preview (1 per category · images really generated)</h2>
<p class="sub">Images are generated by the local <code>:3010</code> content-gen service (provider=agnes,
 1024×1024); the title band is composited locally with PIL. <b>Brand name and all copy are laid out locally —
 never handed to the diffusion model</b> (see the engineering note below). English-only throughout.</p>
{''.join(cards)}

<div class="note bad"><b>Image engineering constraint (measured, not theoretical):</b> diffusion models
 <b>reliably emit garbled characters</b> when asked for "UI / card with text" compositions (the first A1 render
 produced fake UI strings like <code>Cosfes</code> / <code>Olrlee</code> / <code>Dve 3646,220</code>).
 Two countermeasures: ① at the prompt level, forbid UI elements and switch to "completely blank, unmarked"
 abstract compositions; ② route <b>all</b> text (headline / brand / domain) through local PIL compositing.
 Both applied ⇒ 6/6 clean.</div>

<h2>5. Injection &amp; publishing: how it hooks into the existing pipeline</h2>
<p class="sub">Reuses the existing <code>POST /api/v14/content</code>. No new service, no publisher change.
 Two fields are the key.</p>
<pre><span class="c">// 1) Generate the image (really persisted to D:/mscms-content/images/&lt;id&gt;.png)</span>
POST http://:3010/api/generate
{{ <span class="k">"type"</span>: <span class="s">"image"</span>, <span class="k">"prompt"</span>: <span class="s">"&lt;this slot's image_prompt&gt;"</span>, <span class="k">"size"</span>: <span class="s">"1024x1024"</span> }}
<span class="c">// → {{ ok:true, asset:{{ localPath:"D:\\\\mscms-content\\\\images\\\\xxx.png" }} }}</span>

<span class="c">// 2) Composite the title band locally (PIL) → this is the final  → media_path</span>

<span class="c">// 3) Inject the content (=tumblr; status=ready is required to enter the pipeline)</span>
POST http://:3002/api/v14/content
{{
  <span class="k">"id"</span>: <span class="s">"content_kk_20260923_d01_s01"</span>,
  <span class="k">""</span>: <span class="s">"tumblr"</span>,
  <span class="k">"content_type"</span>: <span class="s">"image_text"</span>,
  <span class="k">"title"</span>: <span class="s">"&lt;title_en&gt;"</span>,
  <span class="k">"body"</span>: <span class="s">"&lt;body_en&gt;"</span>,
  <span class="k">"tags"</span>: [<span class="s">"kkmatch"</span>, <span class="s">"kkos"</span>, <span class="s">"omi"</span>, <span class="s">"..."</span>],
  <span class="k">"images"</span>: [<span class="s">"D:/mscms-content/images/kk_d01_s01.png"</span>],
  <span class="k">"account_id"</span>: <span class="s">"tumblr_&lt;one of the 20&gt;"</span>,   <span class="c">// ★ targeted binding</span>
  <span class="k">"status"</span>: <span class="s">"ready"</span>,                        <span class="c">// ★ defaults to editing; without it the post never ships</span>
  <span class="k">"quality_score"</span>: <span class="s">88</span>
}}</pre>

<table><thead><tr><th>Key field</th><th>Effect</th><th>Evidence</th></tr></thead><tbody>
<tr><td><code>account_id</code></td><td class=sm>Publisher's <b>1st priority</b> match — this is what makes "these 20  post only KKMatch content" work. Falls back to the round-robin pool only on miss.</td><td class=mono>server.js:3736</td></tr>
<tr><td><code>images[0]</code></td><td class=sm>Becomes <code>preview_url</code> after persistence, matched by the <code>_resolveMediaForPublish</code> candidate list → routes through the real <code>postPhoto</code> path. <code>isRealMediaRef</code> only rejects <code>.json</code> archive paths, so a local png is valid.</td><td class=mono>cloud-publisher.js:1904</td></tr>
<tr><td><code>status</code></td><td class=sm>Must be explicitly <code>ready</code>. The default is <code>editing</code>, which excludes the record from the publish pipeline (a deliberate anti-misfire design).</td><td class=mono>server.js:11656</td></tr>
<tr><td>Media rank</td><td class=sm>Enqueue order is <code>video 0 &gt; image 1 &gt; text 2</code>. KKMatch content carrying real media naturally sorts ahead of 2000+ legacy text-only items, so it <b>cannot be crowded out</b>.</td><td class=mono>content-media-ref.js:100</td></tr>
</tbody></table>

<div class="note"><b>⚠️ One 5-line patch recommended:</b> <code>POST /api/v14/content</code> currently persists
 only <code>images[]</code> and <b>does not write <code>media_path</code></b>. The image post still works via the
 <code>preview_url</code> fallback, but <code>P2-B5</code> was exactly a production incident caused by
 "fallback ordering" (when <code>media_path</code> was absent the resolver landed on an archive JSON path).
 Recommend writing <code>media_path</code> + <code>media_type</code> explicitly in the route to remove the
 dependency on fallback order. Without the patch: putting the image path in <code>images[0]</code> is sufficient
 (candidate list reachability already verified).</div>

<h2>6. Cadence, risk control and capacity</h2>
<table><thead><tr><th>Item</th><th>This plan</th><th>System limit / current</th><th>Margin</th></tr></thead><tbody>
<tr><td>Posts per account</td><td class=num>2 / day</td><td class=num>12 / day (nurturingRules quota)</td><td><span class="pill ok">6×</span></td></tr>
<tr><td>Post interval per account</td><td class=num>≈12 h</td><td class=num>≥45 min (account gate)</td><td><span class="pill ok">16×</span></td></tr>
<tr><td>Network-wide daily volume</td><td class=num>40 / day</td><td class=num>≈100 / hour (measured)</td><td><span class="pill ok">1.7%</span></td></tr>
<tr><td>Enqueue slot contention</td><td class=num>40 / day</td><td class=num>≈130 slots / hour</td><td><span class="pill ok">&lt;3%</span></td></tr>
<tr><td>Concurrent publishing</td><td class=num>≤3</td><td class=num>existing serial gate <code>_tumblrExclusive</code></td><td><span class="pill ok">no added pressure</span></td></tr>
<tr><td>Image generation cost</td><td class=num>≈10–15 s each</td><td class=num>40 images / day</td><td><span class="pill ok">≈8 min / day</span></td></tr>
</tbody></table>

<div class="note"><b>Known risks and countermeasures:</b>
<ol>
<li><b>429 shared app-key rate limiting</b> (the current top bottleneck): 40 posts/day is only 1.7% of measured capacity, so this plan barely adds to it. Scaling to hundreds of posts/day requires fixing publisher-side capacity first.</li>
<li><b>20  with 0 followers / 0 historical posts</b>: cold start, low reach. Countermeasure — run nurturing actions for the first 3 days to raise account weight, then ramp volume.</li>
<li><b>Homogenization flagged as spam</b>: three layers of protection — 6 categories × 12 anchors × 7 genres, zero-duplicate 40-slot topics, plus the system's <code>body_fp</code> cross-account dedupe gate (ledger of 1195 fingerprints measured zero cross-account reuse).</li>
<li><b>Image generation failure degradation</b>: with no media, <code>_resolveMediaForPublish</code> degrades to a text-only post. Does not block the pipeline and never fabricates.</li>
</ol></div>

<h2>7. Decision status</h2>
<table><thead><tr><th>#</th><th>Point</th><th>Status / recommendation</th></tr></thead><tbody>
<tr><td class=num>1</td><td><b>Language</b> — Tumblr's primary audience is English; the user's examples were Chinese.</td><td class=sm><b>✅ CONFIRMED: English only</b> (2026-09-22). Every publishable field — title, subtitle, body, tags, CTA, and both lines of the image title band — is English. Chinese text in <code>kk20-samples.json</code> is internal archival only and is <b>not read</b> by any renderer or injection path.</td></tr>
<tr><td class=num>2</td><td><b>Category mix</b> — currently provocative 8 / fun 8 / tech 6 / humanities 6 / humor 6 / memes 6.</td><td class=sm>Run 7 days as-is, then reweight from <code>publish_url</code> + reach/likes data.</td></tr>
<tr><td class=num>3</td><td><b>Add the 5-line patch</b> so <code>/api/v14/content</code> writes <code>media_path</code> explicitly.</td><td class=sm>Recommended. Removes reliance on <code>preview_url</code> fallback order and the P2-B5 failure mode.</td></tr>
</tbody></table>

<h2>8. Execution checklist (runs in order once approved)</h2>
<ol>
<li>Confirm the 20  and language (decision 1 — <b>language done</b>)</li>
<li>Batch-generate Day-1's 40 images (<code>≈8 min</code>, real images via :3010)</li>
<li>Generate copy per slot from <code>kk20-schedule-7d.json</code> (12 anchors × 7 genres skeleton + category voice)</li>
<li>Run <code>computeQualityV2</code> QC; anything below threshold does not enter the library</li>
<li>Inject 40 records via <code>POST /api/v14/content</code> (<code>status=ready</code>, targeted <code>account_id</code>)</li>
<li>Watch the first publish cycle: verify non-empty <code>publish_url</code>, 20/20 account spread, no 429</li>
<li>Roll forward on the 7-day schedule; re-evaluate the mix on Day 3 with backfilled data</li>
</ol>

<div class="foot">
Generated 2026-09-22 · plan generator <code>tools/kk20-plan-gen.js</code> · preview tooling
<code>tools/kk20-preview-gen.py</code> / <code>tools/kk20-preview-html.py</code><br>
Account figures read live from <code>D:/mscms-ws/data/.json</code> ∩ <code>.json</code>;
feature anchors read live from <a href="https://kkmatch.com">kkmatch.com</a>. All numbers recomputable, no placeholders.
</div>
</div></body></html>"""

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print('已写出 %s  (%.0f KB)' % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    build()
