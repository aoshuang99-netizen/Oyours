#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
kk20-preview-gen.py — KKMatch 20 账号投放计划的「预览素材」生成器

做两件事（都走真实通道，零伪造）：
  1) 调本机 :3010 content-gen 微服务的 /api/generate 真实生成配图
     （provider=agnes，落盘 D:/mscms-content/images/<id>.png）
  2) 用 PIL 在图上叠加「标题带」——英文主标题 + 英文副标题 + 品牌域名 + CTA
     ⚠️ 关键工程决定：品牌名与一切文字一律**本地排版**，绝不交给扩散模型生成。
        AI 生成的字形必然是乱码（实测），叠加层才是可控的。

语言策略（2026-09-22 用户确认）：**全英文**。
  · 主标题 title_en   · 第二行 subtitle_en（英文钩子）· CTA 英文 · 域名固定

输出：reports/kk20-preview/img/<id>.png  + manifest.json

用法：
  python kk20-preview-gen.py            # 全部 6 条
  python kk20-preview-gen.py A1 A3      # 只做指定 slot
  python kk20-preview-gen.py --reuse    # 复用上轮原图，只重跑叠字层（省生图配额）
"""
import json
import os
import re
import sys
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SAMPLES = os.path.join(ROOT, 'reports', 'kk20-samples.json')
OUTDIR = os.path.join(ROOT, 'reports', 'kk20-preview')
IMGDIR = os.path.join(OUTDIR, 'img')
API = 'http://127.0.0.1:3010/api/generate'

FONT_EN = 'C:/Windows/Fonts/seguisb.ttf'
FONT_MONO = 'C:/Windows/Fonts/segoeui.ttf'
# 保留中文字体：万一将来需要中文轨，PIL 叠字是唯一可控通道
FONT_ZH = 'C:/Windows/Fonts/msyhbd.ttc'

CJK = re.compile(r'[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]')


def pick_font(path, size, fallback='C:/Windows/Fonts/arial.ttf'):
    for p in (path, fallback):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def gen_image(prompt, negative):
    """真实调用 content-gen 微服务生图。返回本地绝对路径。"""
    payload = json.dumps({'type': 'image', 'prompt': prompt, 'size': '1024x1024'}).encode('utf-8')
    req = urllib.request.Request(API, data=payload, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=240) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    if not data.get('ok'):
        raise RuntimeError('生图失败: %s' % json.dumps(data)[:300])
    return data['asset']['localPath']


def wrap(text, font, max_w, draw):
    """按像素宽度折行；CJK 逐字断行，拉丁按词断行。

    ⚠️ 入口必须先压平空白：PIL 的 `ImageDraw.textlength()` 遇到含 `\\n` 的字符串会抛
    `can't measure length of multiline text`，表现为**整张图配图失败**。
    实测由模型在 title/subtitle 里夹带换行触发（20 条里挂 2 条，均为笑话栏目）。
    """
    text = ' '.join(str(text or '').split())
    lines, cur = [], ''
    for ch in text:
        trial = cur + ch
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
            continue
        if CJK.match(ch):
            lines.append(cur)
            cur = ch
        else:
            cut = cur.rfind(' ')
            if cut > 0:
                lines.append(cur[:cut])
                cur = cur[cut + 1:] + ch
            else:
                lines.append(cur)
                cur = ch
    if cur.strip():
        lines.append(cur)
    return lines


def overlay(path, title_en, subtitle_en, cta, url='kkmatch.com', outdir=None):
    """在图上叠加标题带：底部渐变压暗 + 英文主标题 + 英文副标题 + CTA + 域名。

    排版原则（实测教训固化）：
      · 遮罩必须「前 30% 带高内升到满值」，否则标题顶端永远落在半透明区；
      · 自底向上排版 + 可用高度预算 + 自动缩字号，**不用固定偏移 + 行数上限**
        （A6 曾因英文占满 3 行把第二行推到 CTA 上重叠）。
    """
    img = Image.open(path).convert('RGB')
    W, H = img.size

    band_h = int(H * 0.38)
    top = H - band_h

    # 底部渐变遮罩。曲线是实测调出来的，两次踩坑记录在此：
    #   · ^0.55 版太「透」——标题行处 alpha 仅 ~36，文字压在画面上可读性差；
    #   · ^0.95 版仍不够——线性缓升意味着文字顶端永远落在半透明区。
    #   终版：前 30% 带高内快速升到满值，其余全不透明。
    #   即「上沿平滑过渡、文字区绝对干净」，这是社媒图文封面唯一稳的做法。
    mask = Image.new('L', (W, band_h), 0)
    md = ImageDraw.Draw(mask)
    _ramp = band_h * 0.30
    for y in range(band_h):
        a = 250 if y >= _ramp else int(250 * min(1.0, (y / _ramp) ** 1.15))
        md.line([(0, y), (W, y)], fill=a)
    img.paste(Image.new('RGB', (W, band_h), (9, 11, 17)), (0, top), mask)

    d = ImageDraw.Draw(img)
    pad = int(W * 0.070)
    max_w = W - pad * 2

    yb = H - int(H * 0.052)                      # 底行（CTA / 域名）基线
    y_start = top + int(band_h * 0.30) + int(H * 0.012)
    avail = yb - int(H * 0.030) - y_start

    # 全英文 ⇒ 主标题 / 副标题 / CTA 统一用 Segoe UI Semibold 家族
    f_sub = pick_font(FONT_EN, int(W * 0.0305))
    f_cta = pick_font(FONT_EN, int(W * 0.0215))
    f_url = pick_font(FONT_MONO, int(W * 0.0195))

    base_en = int(W * 0.0455)
    f_en, en_lines, sub_lines = None, None, None
    for scale in (1.00, 0.96, 0.92, 0.88, 0.84, 0.80, 0.76, 0.72, 0.68):
        cand = pick_font(FONT_EN, max(14, int(base_en * scale)))
        el = wrap(title_en, cand, max_w, d)
        sl = wrap(subtitle_en, f_sub, max_w, d)[:2] if subtitle_en else []
        total = len(el) * int(cand.size * 1.20) + int(band_h * 0.035) + len(sl) * int(f_sub.size * 1.30)
        f_en, en_lines, sub_lines = cand, el, sl
        if total <= avail:
            break

    y = y_start
    # 左侧强调竖条（品牌色 amber），锚定视觉起点
    bar_x = pad - int(W * 0.026)
    d.rectangle([bar_x, y + int(f_en.size * 0.10),
                 bar_x + max(3, int(W * 0.0055)),
                 y + int(f_en.size * 1.05)], fill=(255, 186, 64))

    for ln in en_lines:
        d.text((pad + 3, y + 3), ln, font=f_en, fill=(0, 0, 0))          # 投影
        d.text((pad, y), ln, font=f_en, fill=(255, 255, 255))
        y += int(f_en.size * 1.20)

    if sub_lines:
        y += int(band_h * 0.035)
        for ln in sub_lines:
            d.text((pad + 2, y + 2), ln, font=f_sub, fill=(0, 0, 0))
            d.text((pad, y), ln, font=f_sub, fill=(201, 210, 224))
            y += int(f_sub.size * 1.30)

    # 底行：左 CTA，右域名（url 可参数化，默认 kkmatch.com；hlua40 战役传 'hlua.cc.cd'）
    d.text((pad, yb), cta, font=f_cta, fill=(255, 209, 128))
    d.text((W - pad - d.textlength(url, font=f_url), yb), url, font=f_url, fill=(150, 162, 180))

    target_dir = outdir or IMGDIR
    if not os.path.isdir(target_dir):
        os.makedirs(target_dir, exist_ok=True)
    out = os.path.join(target_dir, os.path.basename(path))
    img.save(out, 'PNG', optimize=True)
    return out


def main():
    args = [a.upper() for a in sys.argv[1:]]
    reuse = '--REUSE' in args
    only = set(a for a in args if not a.startswith('--'))
    os.makedirs(IMGDIR, exist_ok=True)

    with open(SAMPLES, 'r', encoding='utf-8') as f:
        doc = json.load(f)

    # --reuse：复用上一轮已生成的原图，只重跑叠字层。
    # 调版式时用它，避免每改一行排版就重新烧一遍生图配额（实测 6 张 ≈ 74s）。
    prev = {}
    man_path = os.path.join(OUTDIR, 'manifest.json')
    if reuse and os.path.exists(man_path):
        with open(man_path, 'r', encoding='utf-8') as f:
            for a in json.load(f).get('assets', []):
                prev[a['slot']] = a['base_image']

    manifest, ok, fail = [], 0, 0
    for s in doc['samples']:
        if only and s['slot'].upper() not in only:
            continue
        slot = s['slot']
        t0 = time.time()
        try:
            cached = prev.get(slot)
            if reuse and cached and os.path.exists(cached):
                raw = cached
                print('[%s] %s ← 复用原图 %s' % (slot, s['category'], os.path.basename(raw)), flush=True)
            else:
                print('[%s] %s ← 生图中…' % (slot, s['category']), flush=True)
                raw = gen_image(s['image_prompt'], s.get('image_negative', ''))
            out = overlay(raw, s['title_en'], s.get('subtitle_en', ''), s['cta'])
            size = os.path.getsize(out)
            print('[%s] ✅ %.1fs  %s  (%.0f KB)' % (slot, time.time() - t0, out, size / 1024), flush=True)
            manifest.append({
                'slot': slot, 'category': s['category'], 'anchor': s['anchor'],
                'image': os.path.relpath(out, ROOT).replace('\\', '/'),
                'base_image': raw.replace('\\', '/'),
                'bytes': size, 'elapsed_sec': round(time.time() - t0, 1),
            })
            ok += 1
        except Exception as e:
            print('[%s] ❌ %s' % (slot, e), flush=True)
            fail += 1

    with open(man_path, 'w', encoding='utf-8') as f:
        json.dump({'ok': ok, 'fail': fail, 'assets': manifest}, f, ensure_ascii=False, indent=1)
    print('\n完成：成功 %d / 失败 %d   → %s' % (ok, fail, man_path), flush=True)


if __name__ == '__main__':
    main()
