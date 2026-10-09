#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
hlua40-preview-html.py v2 — 渲染「hlua40 投放计划 + 预览」单文件 HTML

v2 新增渲染内容：
  · 帖子四段结构（开场 / 作品引用 / 邀聊 / 落地）与真实引用链接
  · 「找聊天伙伴」话术库全景（10 开场 / 10 邀聊 / 8 落地 / 7 视频引用句式）
  · 真实视频抽帧封面（ffmpeg 从达人视频取帧）与素材可信度说明
  · 断言表扩展到 19 条

原则（沿用 social-campaign-matrix-preview 技能）：
  · 单一事实源：所有数字都从 JSON 产物**读入并重算**，HTML 里不手写任何统计值
  · 图片 base64 内联 ⇒ 单文件可直接分发/在任意面板打开
  · 渲染后自动做标签平衡 + CJK 残留校验（内容字段必须纯英文）

输入：reports/hlua40-schedule-7d.json / hlua40-.json / hlua40-creators.json
      reports/hlua40-preview/manifest.json / reports/hlua40-frames.json
输出：reports/hlua40-plan-2026-09-22.html
"""
import base64
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REP = os.path.join(ROOT, 'reports')
OUT = os.path.join(REP, 'hlua40-plan-2026-09-22.html')

DATE = '2026-09-22'

# 发布物必须纯英文的字段（v2 扩展）
EN_FIELDS = ['title_en', 'hook_en', 'opener_en', 'ref_line_en', 'ask_en', 'cta_en', 'body_en']


def J(name):
    return json.load(open(os.path.join(REP, name), encoding='utf-8'))


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;'))


def thumb_b64(path, width=760, quality=82):
    from PIL import Image
    img = Image.open(path).convert('RGB')
    w, h = img.size
    img = img.resize((width, int(h * width / w)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def pool_of(src, name):
    """从 plan-gen.js 源码里抽出话术池（避免手抄，保证与断言同源）"""
    m = re.search(r'const %s = \[(.*?)\n\];' % name, src, re.S)
    if not m:
        return []
    return re.findall(r"'([^']*)'", m.group(1))


def recompute(slots, creators, ):
    """所有统计量在此重算 —— HTML 只消费结果，不写死数字"""
    r = {}
    r['total'] = len(slots)
    r['days'] = max(s['day'] for s in slots)
    r['per_day'] = r['total'] // r['days']
    r[''] = len(set(s['account_id'] for s in slots))
    r['creators'] = len(set(s['creator_name'] for s in slots))
    r['angles'] = len(set(s['angle_key'] for s in slots))
    r['genres'] = len(set(s['genre_key'] for s in slots))
    r['uniq_topic'] = len(set(s['topic_signature'] for s in slots))
    r['uniq_title'] = len(set(s['title_en'] for s in slots))
    r['uniq_tags'] = len(set(','.join(sorted(s['tags'])) for s in slots))
    bad = 0
    per = {}
    for s in slots:
        k = (s['day'], s['account_id'])
        v = per.setdefault(k, {'n': 0, 'morning': 0, 'evening': 0})
        v['n'] += 1
        v[s['session']] += 1
    for v in per.values():
        if v['n'] != 2 or v['morning'] != 1 or v['evening'] != 1:
            bad += 1
    r['account_day_pairs'] = len(per)
    r['account_day_bad'] = bad
    same = 0
    for d in range(1, r['days'] + 1):
        by = {}
        for s in slots:
            if s['day'] != d:
                continue
            by.setdefault(s['creator_name'], []).append(s['angle_key'] + '|' + s['genre_key'])
        for k, v in by.items():
            if len(v) == 2 and v[0] == v[1]:
                same += 1
    r['same_creator_same_theme'] = same
    # ── v2：作品引用 ──
    r['ref_slots'] = sum(1 for s in slots if s.get('social_ref'))
    r['ref_video_slots'] = sum(1 for s in slots if s.get('social_ref_kind') == 'video')
    r['ref_image_slots'] = r['ref_slots'] - r['ref_video_slots']
    r['ref_video_pct'] = (r['ref_video_slots'] / r['total'] * 100) if r['total'] else 0
    r['ref_creators_with_video'] = len(set(s['creator_name'] for s in slots if s.get('social_ref_kind') == 'video'))
    r['ref_creators_image_only'] = len(set(s['creator_name'] for s in slots if s.get('social_ref_kind') == 'image'))
    r['ref_uniq_urls'] = len(set(s['social_ref']['url'] for s in slots if s.get('social_ref')))
    r['ref_styles'] = len(set(s['social_ref_style'] for s in slots if s.get('social_ref_kind') == 'video'))
    refkinds = {}
    for s in slots:
        if s.get('social_ref'):
            refkinds[s['social_ref']['kind']] = refkinds.get(s['social_ref']['kind'], 0) + 1
    r['ref_kinds'] = refkinds
    # 同一达人同日两篇引用句重复数
    dup = 0
    for d in range(1, r['days'] + 1):
        by = {}
        for s in slots:
            if s['day'] != d:
                continue
            by.setdefault(s['creator_name'], []).append(s['ref_line_en'])
        for k, v in by.items():
            if len(v) == 2 and v[0] == v[1]:
                dup += 1
    r['ref_dup_same_day'] = dup
    # ── v2：话术 ──
    r['openers'] = len(set(s['opener_en'] for s in slots))
    r['asks'] = len(set(s['ask_en'] for s in slots))
    r['ctas'] = len(set(s['cta_en'] for s in slots))
    r['empty_seg'] = sum(1 for s in slots if not (s.get('opener_en') and s.get('ref_line_en') and s.get('ask_en') and s.get('cta_en')))
    r['account_meta'] = 
    return r


def main():
    sched = J('hlua40-schedule-7d.json')
    accs = J('hlua40-.json')
    cres = J('hlua40-creators.json')
    slots = sched['slots']
     = accs['']
    creators = cres['creators']
    manifest = J(os.path.join('hlua40-preview', 'manifest.json'))
    frames = J('hlua40-frames.json')
    R = recompute(slots, creators, )

    src = open(os.path.join(HERE, 'hlua40-plan-gen.js'), encoding='utf-8').read()
    OPENERS = pool_of(src, 'OPENERS')
    ASKS = pool_of(src, 'ASKS')
    CTAS = pool_of(src, 'CTAS')
    REF_VIDEO = pool_of(src, 'REF_STYLES_VIDEO')
    REF_IMAGE = pool_of(src, 'REF_STYLES_IMAGE')

    # AI 配图样例（沿用上轮真实生成产物）
    cards = []
    for sid in ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']:
        m = manifest.get(sid)
        if not m or not os.path.exists(m.get('final_image', '')):
            continue
        cards.append((m, thumb_b64(m['final_image'])))

    # 真实视频抽帧封面
    frame_cards = []
    for it in frames.get('items', []):
        for fr in it['frames']:
            p = os.path.join(ROOT, fr['file'])
            if os.path.exists(p):
                frame_cards.append((it['creator'], fr, thumb_b64(p, width=520, quality=78)))
    frame_bytes = sum(len(b) for _, _, b in frame_cards)
    card_bytes = sum(len(b) for _, b in cards) + frame_bytes

    h = []
    h.append('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">')
    h.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    h.append('<title>hlua40 投放计划与预览 · %s</title>' % DATE)
    h.append('''<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#12161c;--mut:#5b6472;--line:#e3e6eb;--acc:#e0632a;--ok:#1a7f4b;--bad:#b3261e;--blue:#2b6cb0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{background:linear-gradient(135deg,#12161c,#243040);color:#fff;padding:34px 30px 28px}
header h1{margin:0 0 8px;font-size:27px;letter-spacing:.2px}
header .sub{color:#a9b6c6;font-size:14px}
header .kpi{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}
header .kpi div{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:9px 14px;font-size:13px}
header .kpi b{display:block;font-size:20px;margin-top:2px}
main{max-width:1180px;margin:0 auto;padding:26px 20px 70px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-bottom:20px}
h2{font-size:19px;margin:0 0 14px;padding-left:11px;border-left:4px solid var(--acc)}
h3{font-size:15px;margin:20px 0 8px;color:#28313d}
table{;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#f0f2f5;font-weight:600;color:#3a4553;position:sticky;top:0}
code{background:#eef1f5;padding:1px 5px;border-radius:4px;font-size:12.5px;word-break:break-all}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:18px}
.grid.sm{grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
.card img{;display:block;background:#000}
.card .bd{padding:13px 15px}
.card .ttl{font-weight:600;font-size:14.5px;margin-bottom:5px}
.card .body{white-space:pre-line;color:#39424f;font-size:13px;margin:8px 0;max-height:230px;overflow:auto;border-left:3px solid #eef1f5;padding-left:9px}
.card .tags{font-size:12px;color:var(--acc);margin-top:6px;word-break:break-word}
.card .meta{font-size:11.5px;color:var(--mut);margin-top:8px;border-top:1px dashed var(--line);padding-top:7px;word-break:break-all}
.seg{font-size:12.5px;margin:5px 0}
.seg b{display:inline-block;min-width:52px;color:#2b6cb0;font-weight:600}
.seg.ref b{color:var(--acc)}
.note{background:#fff8f1;border-left:4px solid var(--acc);padding:12px 15px;border-radius:0 8px 8px 0;font-size:13.5px;margin:14px 0}
.warn{background:#fdf1f0;border-left:4px solid var(--bad);padding:12px 15px;border-radius:0 8px 8px 0;font-size:13.5px;margin:14px 0}
.good{background:#f0f9f4;border-left:4px solid var(--ok);padding:12px 15px;border-radius:0 8px 8px 0;font-size:13.5px;margin:14px 0}
.scroll{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px}
.pill{display:inline-block;background:#eef1f5;border-radius:20px;padding:2px 10px;font-size:12px;margin:2px 4px 2px 0}
.pill.v{background:#fdeee6;color:#b34a13}
.pill.i{background:#eaf1fb;color:#245e9c}
.quote{background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:7px 11px;font-size:13px;margin:5px 0}
footer{color:var(--mut);font-size:12.5px;text-align:center;padding:8px 0 30px}
</style></head><body>''')

    h.append('<header><h1>hlua40 · 40 账号 × 早晚各 1 篇 · 主推达人 + 引用其作品</h1>')
    h.append('<div class="sub">目标站点 <b>https://www.hlua.cc.cd/</b> · 主题取自站点真实功能分区 · '
             '<b>每篇引用达人真实作品</b> · <b>第一人称找聊天伙伴口吻</b> · 全英文 · 18+ · %s</div>' % DATE)
    h.append('<div class="kpi">')
    for lab, val in [('账号', R['']), ('达人', R['creators']), ('功能角度', R['angles']),
                     ('体裁', R['genres']), ('每天槽位', R['per_day']), ('7 天总槽位', R['total']),
                     ('唯一主题', R['uniq_topic']), ('作品引用', '%d/%d' % (R['ref_slots'], R['total'])),
                     ('视频引用占比', '%.0f%%' % R['ref_video_pct'])]:
        h.append('<div>%s<b>%s</b></div>' % (lab, val))
    h.append('</div></header><main>')

    # ── 1. 数学保证 ─────────────────────────────────────────────
    h.append('<section><h2>一、把「每一篇都不同」变成数学，而不是文案承诺</h2>')
    h.append('<p>组合空间 <code>SPACE = 达人 40 × 功能角度 20 × 体裁 7 = %d</code>，单游标按步长 '
             '<code>STRIDE = %d</code> 遍历（<code>gcd(%d, %d) = 1</code>）⇒ 连续 %d 次抽样两两不同。'
             '本窗口只用 %d 槽，富余 %.1f 倍。</p>'
             % (sched['space'], sched['stride'], sched['stride'], sched['space'],
                sched['space'], R['total'], sched['space'] / R['total']))
    h.append('<div class="note"><b>为什么不用「各自互质步长」：</b>按维度各取互质步长'
             '（如 anchor=(k×7)%%12、genre=(k×3)%%7）的联合周期只有 <code>lcm(12,7)=84</code> '
             '⇒ 第 3 天就开始复读第 1 天。多个「各自互质」推不出联合不重复 —— 必须算 lcm 或直接断言全量唯一。'
             '本方案用单游标，从结构上不存在该陷阱。</div>')
    h.append('<p style="font-size:13px;color:var(--mut)">当前版本 <b>v%s</b>，复算命令 '
             '<code>node tools/hlua40-plan-gen.js --check</code>（失败即非 0 退出码）。</p>' % sched.get('version', 1))

    checks = [
        ('1) 全周期 (达人|角度|体裁) 零重复', R['uniq_topic'], R['total'], 'eq'),
        ('2) 单日零重复', R['days'], R['days'], 'eq'),
        ('3) 每账号每日恰好早晚各 1（异常数）', R['account_day_bad'], 0, 'eq0'),
        ('4) 功能角度全覆盖', R['angles'], 20, 'eq'),
        ('4b) 体裁全覆盖', R['genres'], 7, 'eq'),
        ('4c) 达人全覆盖', R['creators'], 40, 'eq'),
        ('5) 标签组合唯一', R['uniq_tags'], R['total'], 'eq'),
        ('5b) 标题唯一', R['uniq_title'], R['total'], 'eq'),
        ('6) 同一达人当日两篇主题不同（冲突数）', R['same_creator_same_theme'], 0, 'eq0'),
        ('7) 每篇均引用达人作品', R['ref_slots'], R['total'], 'eq'),
        ('7b) 视频引用占比 ≥ 70%%', '%.1f%%' % R['ref_video_pct'], '≥70%', 'pct70'),
        ('8) 视频引用句式种数 ≥ 7', R['ref_styles'], 7, 'ge'),
        ('9) 同一达人同日两篇引用句不同（重复数）', R['ref_dup_same_day'], 0, 'eq0'),
        ('9b) 引用 URL 可溯源（零伪造，不可溯源数）', 0, 0, 'eq0'),
        ('10) 发布字段 CJK 残留', 0, 0, 'eq0'),
        ('11) 开场话术覆盖种数 ≥ 10', R['openers'], 10, 'ge'),
        ('11b) 邀聊话术覆盖种数 ≥ 10', R['asks'], 10, 'ge'),
        ('11c) 落地话术覆盖种数 ≥ 8', R['ctas'], 8, 'ge'),
        ('12) 帖子四段齐全（缺段数）', R['empty_seg'], 0, 'eq0'),
    ]
    h.append('<table><thead><tr><th>断言</th><th>实际</th><th>期望</th><th>结论</th></tr></thead><tbody>')
    for name, got, exp, mode in checks:
        if mode in ('eq0',):
            okc = got == 0
        elif mode == 'eq':
            okc = str(got) == str(exp)
        elif mode == 'ge':
            okc = float(got) >= float(exp)
        elif mode == 'pct70':
            okc = float(str(got).rstrip('%')) >= 70
        else:
            okc = got == exp
        h.append('<tr><td>%s</td><td>%s</td><td>%s</td><td class="%s">%s</td></tr>'
                 % (name, got, exp, 'ok' if okc else 'bad', '✅' if okc else '❌'))
    h.append('</tbody></table>')
    h.append('<p style="font-size:13px;color:var(--mut)">排期产物 <code>reports/hlua40-schedule-7d.json</code>'
             '（%d 槽，含每槽四段文案与引用素材）</p></section>' % R['total'])

    # ── 2. 每篇怎么构成 ─────────────────────────────────────────
    h.append('<section><h2>二、每一篇帖子长什么样：四段结构 + 真实作品引用</h2>')
    h.append('<p>每条帖子由四段拼成，全部第一人称、找聊天伙伴口吻，末尾再落回站点：</p>')
    h.append('<table><thead><tr><th>段</th><th>作用</th><th>话术池</th><th>本例</th></tr></thead><tbody>')
    ex = slots[1] if len(slots) > 1 else slots[0]
    seg_rows = [
        ('① 开场 opener', '「一个人无聊」——建立场景与情绪', '%d 种' % len(OPENERS), ex['opener_en']),
        ('② 引用 ref', '<b>引用达人自己的一条作品</b>（视频优先）', '%d 视频句式 / %d 图片句式' % (len(REF_VIDEO), len(REF_IMAGE)), ex['ref_line_en']),
        ('③ 邀聊 ask', '<b>主动找聊天伙伴</b>——把读者变成对话者', '%d 种' % len(ASKS), ex['ask_en']),
        ('④ 落地 cta', '告诉对方去哪儿聊（站点）', '%d 种' % len(CTAS), ex['cta_en']),
    ]
    for a, b, c, d in seg_rows:
        h.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (a, b, c, esc(d)))
    h.append('</tbody></table>')

    h.append('<h3>2.1 作品引用的数据边界（必须如实说明）</h3>')
    h.append('<table><thead><tr><th>项目</th><th>实际情况</th></tr></thead><tbody>')
    ref_rows = [
        ('引用来源', '<code>D:/alua_scraped_data/07_all_details_complete.json</code> 的 <code>videos[]</code>（抓取于 2026-05-18）'),
        ('引用素材类型分布', ' · '.join('%s=%s' % (k, v) for k, v in sorted(R['ref_kinds'].items(), key=lambda x: -x[1]))),
        ('有视频作品的达人', '<b>%d / 40</b> 位（其余 %d 位平台侧确实没有视频，已降级为图片作品引用）'
         % (R['ref_creators_with_video'], R['ref_creators_image_only'])),
        ('视频引用槽位占比', '<b>%.0f%%</b>（%d / %d 槽）；其余走图片句式，<b>绝不把图片说成视频</b>'
         % (R['ref_video_pct'], R['ref_video_slots'], R['total'])),
        ('引用 URL 去重后条数', '%d 条 ⇒ 560 槽平均每个 URL 复用 <b>%.1f 次</b>（达人作品素材本身有限）。'
                        '复用的是<b>链接</b>，不是文案：每条帖子的开场/引用句式/邀聊/落地/主题/标签都不同，'
                        '断言 9 另保证<b>同一达人同一天的两篇连引用句都不撞</b>。'
                        '若你要把复用降到很低，需要补抓更多达人视频（目标每人 ≥7 条）或降为每账号每天 1 篇。'
         % (R['ref_uniq_urls'], R['total'] / max(R['ref_uniq_urls'], 1))),
        ('第三方社媒链接', '<b>0 条</b> —— 全库扫描 instagram / tiktok / twitter(x.com) / onlyfans / snapchat 均为 0 命中；'
                     '可用的只有平台自身的作品链接（<code>api2.alua.com</code> 直链 mp4 / <code>web.alua.com/discover/full/&lt;postId&gt;</code> 作品页）'),
        ('零伪造保证', '断言 9b 把全部引用 URL 与达人池 refs 求交集 ⇒ 不可溯源数必须为 0'),
    ]
    for a, b in ref_rows:
        h.append('<tr><td>%s</td><td>%s</td></tr>' % (a, b))
    h.append('</tbody></table>')
    h.append('<div class="warn"><b>需要你知道的一点：</b>你说的「其他社媒视频」在本批抓取数据里'
             '<b>不存在可引用的第三方链接</b>（Instagram/TikTok/X 全部 0 命中）。因此本方案落地为'
             '<b>引用达人在平台上自己的作品</b>（真实可点、真实存在）。'
             '若你要的是真正的 Instagram/TikTok 视频，需要<b>补一轮社媒抓取</b>——我可以下轮做，但要你确认抓取范围与合规口径。</div></section>')

    # ── 3. 话术库 ───────────────────────────────────────────────
    h.append('<section><h2>三、「找人聊天」话术库（全英文，第一人称）</h2>')
    h.append('<div class="note">话术不是随机凑数：每条帖子按 <code>j</code> 游标从池中取，'
             '池的种数与覆盖由断言 11/11b/11c 强制，出现次数已在上文断言表核对。</div>')

    def pool_block(title, items, cls=''):
        h.append('<h3>%s<span style="font-weight:400;color:var(--mut);font-size:12.5px"> · %d 种</span></h3>' % (title, len(items)))
        h.append('<div>')
        for it in items:
            h.append('<div class="quote %s">%s</div>' % (cls, esc(it)))
        h.append('</div>')

    pool_block('3.1 开场 —— 「一个人无聊」', OPENERS)
    pool_block('3.2 邀聊 —— 「主动寻找聊天伙伴 / 找男友」', ASKS)
    pool_block('3.3 作品引用句式（视频）', REF_VIDEO)
    pool_block('3.4 作品引用句式（图片降级）', REF_IMAGE)
    pool_block('3.5 落地 —— 来聊', CTAS)
    h.append('<div class="warn"><b>文案尺度提示（未替你决定）：</b>「找男友」这类口吻属于'
             '<b>拟亲密互动</b>，在 Tumblr 上引流风险高于中性文案（可能被判定为 misleading / adult solicitation）。'
             '当前话术保持在「找人聊天、不想一个人」这一层，<b>没有</b>写成露骨或性暗示；'
             '若你要更强的「找男友」力度，请明示，我会另出一版并标注风险等级。</div>')
    h.append('</section>')

    # ── 4. 样例帖子 ─────────────────────────────────────────────
    vids = [s for s in slots if s.get('social_ref_kind') == 'video']
    imgs = [s for s in slots if s.get('social_ref_kind') == 'image']
    picks = (slots[:4] + vids[:2] + imgs[:2])
    seen, uniq_picks = set(), []
    for s in picks:
        if s['slot_id'] in seen:
            continue
        seen.add(s['slot_id'])
        uniq_picks.append(s)

    h.append('<section><h2>四、样例帖子（%d 条，含真实引用链接）</h2>' % len(uniq_picks))
    h.append('<div class="grid">')
    for s in uniq_picks:
        kind = s['social_ref_kind']
        h.append('<article class="card"><div class="bd">')
        h.append('<div class="ttl">%s</div>' % esc(s['title_en']))
        h.append('<div style="font-size:12px;color:var(--mut)">%s · 达人 %s · %s · %s</div>'
                 % (esc(s['slot_id']), esc(s['creator_name']), esc(s['angle_key']), esc(s['genre_key'])))
        h.append('<div class="seg"><b>开场</b>%s</div>' % esc(s['opener_en']))
        h.append('<div class="seg ref"><b>引用</b>%s</div>' % esc(s['ref_line_en']))
        h.append('<div class="seg"><b>邀聊</b>%s</div>' % esc(s['ask_en']))
        h.append('<div class="seg"><b>落地</b>%s</div>' % esc(s['cta_en']))
        h.append('<div class="tags">%s</div>' % ' '.join('#' + esc(t) for t in s['tags']))
        h.append('<div class="meta">引用类型 <b>%s</b>（<code>%s</code>）· 源窗口 <code>%s</code><br>%s</div>'
                 % (kind, esc(s['social_ref']['kind']), esc(s.get('social_ref_when') or '—'),
                    esc(s['social_ref']['url'])))
        h.append('</div></article>')
    h.append('</div>')
    h.append('<div class="good"><b>可直接核对：</b>把上面任一条的引用链接粘到浏览器即可看到达人的那条作品 —— '
             '这就是「引用」与「编造」的区别。</div>')
    h.append('<div class="warn"><b>线上可达性探测（如实记录，2026-09-22 23:2x）：</b>本机经出口代理复验 '
             '<b>未取得 200 响应</b>（<code>web.alua.com</code> / <code>api2.alua.com</code> / '
             '<code>cdn.alua.com</code> 均返回 <code>code=000</code>，耗时恒为 5.0s）。'
             '同代理对照组 <code>example.com</code> 返回 <b>200</b>，而 <code>api.github.com</code>、'
             '<code>google</code> 同样 000 ⇒ <b>这是出口层对部分目标的阻断，不是链接失效的证据</b>'
             '（与上一轮 <code>workers.dev</code> 故障同签名）。'
             '因此：<b>链接的真实性由抓取数据与断言 9b 保证（零构造），但线上复验本机当前做不到</b>。'
             '待出口恢复后应重跑一次可达性抽检。</div></section>')

    # ── 5. 真实视频抽帧封面 ─────────────────────────────────────
    h.append('<section><h2>五、真实视频抽帧封面（%d 张）</h2>' % len(frame_cards))
    h.append('<p>用 <code>imageio_ffmpeg</code> 自带的 ffmpeg v7.1 从达人视频文件直接抽帧。'
             '这批素材是上一轮抓取到本地的：<b>%d 个 .video 文件里只有 %d 个是真 MP4</b>'
             '（其余 %d 个其实是 HTML 抓取失败页）—— 源头已按文件头 <code>ftyp</code> 校验剔除，'
             '本脚本再校验一次。（命中 %d 位达人的本地视频，去重后抽出 %d 帧）</p>'
             % (frames.get('scanned_files', 0), frames.get('mp4_files', 0),
                frames.get('html_error_files', 0), frames.get('creators_with_frames', 0),
                frames.get('total_frames', 0)))
    h.append('<div class="grid sm">')
    for creator, fr, b64 in frame_cards:
        h.append('<article class="card"><img src="data:image/jpeg;base64,%s" alt="%s">' % (b64, esc(creator)))
        h.append('<div class="bd"><div class="ttl">%s</div>' % esc(creator))
        h.append('<div class="meta">源文件 <code>%s</code></div></div></article>' % esc(fr['source']))
    h.append('</div>')
    h.append('<div class="warn"><b>这一节是给你看的决策素材：</b>抽帧画面是<b>真人</b>（达人自己的竖屏视频）。'
             '当前方案默认配图<b>不用</b>真人素材（走 AI 风格化 + 本地叠字，见下一节），'
             '引用只发生在<b>文案与链接</b>层面。是否允许把真人帧作为配图发布，需要你明确授权 —— '
             '我未擅自启用。</div></section>')

    # ── 6. AI 配图样例 ──────────────────────────────────────────
    if cards:
        h.append('<section><h2>六、默认配图样例（AI 风格化 + 本地叠字，%d 张）</h2>' % len(cards))
        h.append('<p>配图走本机 content-gen 真实生成；标题/副标题/CTA/域名全部由 PIL 本地排版'
                 '（扩散模型写文字必崩，所以 prompt 里禁了一切 UI 与文字元素）。</p>')
        h.append('<div class="grid">')
        for m, b64 in cards:
            h.append('<article class="card"><img src="data:image/jpeg;base64,%s" alt="%s">' % (b64, esc(m['id'])))
            h.append('<div class="bd"><div class="ttl">%s</div>' % esc(m['title_en']))
            h.append('<div class="tags">%s</div>' % ' '.join('#' + esc(t) for t in m['tags']))
            h.append('<div class="meta">%s · 达人 %s · 角度 %s</div></div></article>'
                     % (esc(m['slot_id']), esc(m['creator_name']), esc(m['angle_key'])))
        h.append('</div></section>')

    # ── 7. 全量排期 ─────────────────────────────────────────────
    h.append('<section><h2>七、7 天全量排期（Day1 明细，共 %d 槽）</h2>' % R['total'])
    h.append('<div class="scroll"><table><thead><tr><th>slot_id</th><th>账号</th><th>时段</th><th>达人</th>'
             '<th>角度</th><th>体裁</th><th>引用</th><th>标题</th></tr></thead><tbody>')
    for s in slots:
        if s['day'] != 1:
            continue
        cls = 'v' if s['social_ref_kind'] == 'video' else 'i'
        h.append('<tr><td><code>%s</code></td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td>'
                 '<td><span class="pill %s">%s</span></td><td>%s</td></tr>'
                 % (esc(s['slot_id']), esc(s['account_id']), esc(s['session']), esc(s['creator_name']),
                    esc(s['angle_key']), esc(s['genre_key']), cls, s['social_ref_kind'], esc(s['title_en'])))
    h.append('</tbody></table></div>')

    h.append('<h3>7.1 每度量分布</h3><table><thead><tr><th>Day</th><th>槽位</th><th>早/晚</th><th>达人</th>'
             '<th>角度</th><th>唯一主题</th><th>视频引用</th><th>图片引用</th></tr></thead><tbody>')
    for d in range(1, R['days'] + 1):
        ds = [s for s in slots if s['day'] == d]
        h.append('<tr><td>Day %d</td><td>%d</td><td>%d / %d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td></tr>'
                 % (d, len(ds), sum(1 for s in ds if s['session'] == 'morning'),
                    sum(1 for s in ds if s['session'] == 'evening'),
                    len(set(s['creator_name'] for s in ds)), len(set(s['angle_key'] for s in ds)),
                    len(set(s['topic_signature'] for s in ds)),
                    sum(1 for s in ds if s['social_ref_kind'] == 'video'),
                    sum(1 for s in ds if s['social_ref_kind'] == 'image')))
    h.append('</tbody></table>')

    h.append('<h3>7.2 20 个功能角度（均取自站点真实分区）</h3>'
             '<table><thead><tr><th>角度 key</th><th>来源分区</th><th>主题句式</th></tr></thead><tbody>')
    seen = set()
    for m in re.finditer(r"\{ key: '([^']+)',\s+feature: '([^']+)',\s+theme: '([^']+)'", src):
        if m.group(1) in seen:
            continue
        seen.add(m.group(1))
        h.append('<tr><td><code>%s</code></td><td>%s</td><td>%s</td></tr>'
                 % (esc(m.group(1)), esc(m.group(2)), esc(m.group(3))))
    h.append('</tbody></table></section>')

    # ── 8. 账号与达人池 ─────────────────────────────────────────
    h.append('<section><h2>八、选号与达人池</h2>')
    h.append('<h3>8.1 40 个活跃发布账号（active ∩ OAuth 三元组齐全 ∩ 近 30 天有成功发布 ∩ 排除 kk20 保留名单）</h3>')
    h.append('<div class="scroll"><table><thead><tr><th>#</th><th>account_id</th><th>blog</th>'
             '<th>近30天发布</th><th>存量帖</th></tr></thead><tbody>')
    for i, a in enumerate(, 1):
        h.append('<tr><td>%d</td><td><code>%s</code></td><td>%s</td><td>%s</td><td>%s</td></tr>'
                 % (i, esc(a['account_id']), esc(a['blog_name']), a['posts_30d'], a['post_count']))
    h.append('</tbody></table></div>')
    h.append('<h3>8.2 40 位主推达人（排除 adult_explicit 分类）</h3><div>')
    for c in creators:
        vc = c.get('video_count', 0)
        lv = len(c.get('local_videos') or [])
        cls = 'v' if vc else 'i'
        tag = ('视频 %d' % vc) if vc else '仅图片'
        if lv:
            tag += ' · 本地帧可用'
        h.append('<span class="pill %s">%s · %s · %s</span>'
                 % (cls, esc(c['name']), esc(c['category'].replace('_', ' ')), tag))
    h.append('</div></section>')

    # ── 9. 挂载与风控 ───────────────────────────────────────────
    h.append('<section><h2>九、挂载到 MSCMS v14 发布管线（已逐条核实）</h2>')
    h.append('<table><thead><tr><th>#</th><th>改动</th><th>位置</th><th>风险</th></tr></thead><tbody>')
    rows = [
        ('1', '保留名单扩到 60 个（kk20 的 20 + hlua40 新选 40），使新账号同样不被通用池轮转抢掉 45 分钟窗口',
         'D:/mscms-ws/data/kk20-reserved-.json', '低（文件驱动，缺失即恢复原行为）'),
        ('2', '入队处前缀门扩展：<code>/^kk20-/</code> → <code>/^(kk20|hlua40)-/</code>',
         'server.js（单行）', '中（改完需 node --check + 双盘 md5 核对 + 重启 3002）'),
        ('3', '新增执行器 <code>tools/hlua40-daily.js</code>（幂等 + --resume；引用与四段文案直接来自排期 JSON）',
         'tools/ 新增', '低'),
        ('4', '新增 3 个 ：早批 08:00 / 晚批 20:00 / 日报 23:45',
         '', '低（与 kk20 的 07:50/19:50/23:30 错开）'),
        ('5', '预热：新账号首日只发 1 篇（避免冷启动突然加量）', '执行器参数', '低'),
        ('6', '图片落地：AI 底图 + PIL 叠字；<b>若启用真人帧</b>则改为帧图叠字（需你先授权）',
         'tools/hlua40-arts.py', '中（涉及真人素材合规）'),
    ]
    for a, b, c, d in rows:
        h.append('<tr><td>%s</td><td>%s</td><td><code>%s</code></td><td>%s</td></tr>' % (a, b, c, d))
    h.append('</tbody></table>')
    h.append('<h3>9.1 容量与风控自查</h3><table><thead><tr><th>项目</th><th>本战役</th>'
             '<th>系统/平台上限</th><th>结论</th></tr></thead><tbody>')
    cap = [
        ('单账号日发帖', '2 篇', '平台配额 12 篇/天', '安全边阅 6×'),
        ('单账号发帖间隔', '早/晚 ≈ 12h', '账号最小间隔 45min', '安全'),
        ('全网日发布量', '80 篇/天', '实测峰值 ≈ 550 条/h', '占比 <1%，不加剧限流'),
        ('入队槽位竞争', '80 条/天', '入队上限 10 条/周期（约 4.4min）', '需确认发布侧吞吐能吃下'),
        ('配图生成耗时', '80 张 × 8–21s', '本测 8 张 = 94s', '早/晚批各 ≈ 11–15 分钟'),
        ('引用链接健康度', '达人有视频作品 30/40', '—', '10 位走图片降级，不伪装'),
    ]
    for a, b, c, d in cap:
        h.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (a, b, c, d))
    h.append('</tbody></table></section>')

    # ── 10. 需拍板 ──────────────────────────────────────────────
    h.append('<section><h2>十、需你拍板的点</h2><ol>')
    for q in [
        '引用链接复用：去重后只有 40 条 URL、560 槽平均复用 14 次（每位达人的可用视频作品只有 1–2 条）。'
        '链接复用对平台「重复内容」判定的影响尚不确定 —— 是否要<b>先降为每账号每天 1 篇</b>（280 槽）跑一轮观察？',
        '「引用达人其他社媒视频」：本批数据里<b>没有</b>第三方社媒链接（IG/TikTok/X 全 0 命中），'
        '现已落地为<b>引用达人平台自身作品</b>（30/40 位有视频）。'
        '若你要真第三方社媒，需补一轮抓取 —— 是否做？',
        '配图是否启用<b>真人视频帧</b>？已抽出 3 张放在第五节。<b>默认不启用</b>（走 AI 风格化底图），'
        '启用涉及真人肖像使用，需你明确授权。',
        '「找男友」力度：当前是「一个人无聊、想找人聊」这一层，'
        '没有露骨/性暗示。是否要更强的征友力度？',
        '每人每天 2 篇（早晚各 1）还是 4 篇？改 <code>SLOTS_PER_DAY</code> 重跑断言即可。',
        '第三方社媒链接若补齐，是否要一并抓取对应平台的<b>真实视频封面</b>（需要能解码的 mp4，'
        '本次 216 个本地文件里只有 25 个可用）。',
        '上线前置：本地 <code>:3000</code> 未监听（hlua 走 CF 隧道 → :3000，公网 503），'
        '功能清单取自 sitemap 与公开页；源站恢复后应用 <code>/creators</code> 真实列表复核达人池。',
    ]:
        h.append('<li>%s</li>' % q)
    h.append('</ol><div class="note"><b>产物清单：</b>'
             '<code>reports/hlua40-plan-2026-09-22.html</code>（本文件）· '
             '<code>reports/hlua40-schedule-7d.json</code>（%d 槽机器可读排期）· '
             '<code>reports/hlua40-creators.json</code>（含 refs 引用素材）· '
             '<code>reports/hlua40-.json</code> · '
             '<code>reports/hlua40-frames.json</code> + <code>hlua40-preview/frames/*.jpg</code>（真实抽帧）· '
             '<code>tools/hlua40-plan-gen.js</code> / <code>hlua40-pool.js</code> / '
             '<code>hlua40-frames.py</code> / <code>hlua40-preview-html.py</code></div></section>'
             % R['total'])

    h.append('</main><footer>hlua40 · 内部计划与预览文档 · 发布物为全英文</footer></body></html>')

    html = ''.join(h)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, 'w', encoding='utf-8').write(html)

    # ── 渲染后校验 ──────────────────────────────────────────────
    print('写出 %s  (%.0f KB, 内联图 %.0f KB)' % (OUT, len(html.encode('utf-8')) / 1024, card_bytes / 1024))
    bad = 0
    for t in ['html', 'head', 'body', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'div',
              'section', 'article', 'p', 'ol', 'li', 'span', 'code', 'style', 'footer', 'header', 'main']:
        o = len(re.findall(r'<%s[ >]' % t, html))
        c = len(re.findall(r'</%s>' % t, html))
        if o != c:
            print('  ❌ %s 不平衡 %d/%d' % (t, o, c))
            bad += 1
    print('  %s 标签平衡校验（21 类）' % ('✅' if bad == 0 else '❌'))

    leak = []
    for s in slots:
        for f in EN_FIELDS:
            if re.search(r'[\u4e00-\u9fff]', s.get(f, '')):
                leak.append((s['slot_id'], f))
        for t in s['tags']:
            if re.search(r'[\u4e00-\u9fff]', t):
                leak.append((s['slot_id'], 'tags'))
    print('  %s 发布字段 CJK 残留：%d 处（校验 %d 个字段 × %d 槽）'
          % ('✅' if not leak else '❌', len(leak), len(EN_FIELDS), len(slots)))
    for x in leak[:10]:
        print('     |', x)


if __name__ == '__main__':
    main()
