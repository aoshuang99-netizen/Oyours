#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
hlua40-preview-gen.py — hlua40 战役「计划预览」素材生成器（真实生图 + 本地叠字）

复用 kk20-preview-gen.py 里两个踩坑调出来的资产（importlib 加载，不复制代码）：
  · gen_image(prompt, negative)  → 走本机 :3010 content-gen 真实生图
  · overlay(path, title, sub, cta, url, outdir)
       底部标题带（遮罩前 30% 带高内升到满值 / 自底向上排版 + 自动缩字号）
       url 与 outdir 已参数化 ⇒ hlua 战役传 url='hlua.cc.cd'

铁律：所有文字走 PIL 本地排版；image_prompt 里已禁 UI/文字元素
（扩散模型对「带文字的界面」必然吐乱码，实测出过 Cosfes / Olrlee 这类假文案）。

用法：
  python tools/hlua40-preview-gen.py                 # 全部样例
  python tools/hlua40-preview-gen.py H1 H3           # 只做指定样例
  python tools/hlua40-preview-gen.py --reuse         # 复用上轮底图，只重跑叠字层
"""
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUTDIR = os.path.join(ROOT, 'reports', 'hlua40-preview')
IMGDIR = os.path.join(OUTDIR, 'img')
SAMPLES = os.path.join(ROOT, 'reports', 'hlua40-samples.json')
MANIFEST = os.path.join(OUTDIR, 'manifest.json')
URL = 'hlua.cc.cd'

_src = os.path.join(HERE, 'kk20-preview-gen.py')
_spec = importlib.util.spec_from_file_location('kk20pg', _src)
kk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kk)


def main():
    args = [a.upper() for a in sys.argv[1:]]
    reuse = '--REUSE' in args
    only = {a for a in args if not a.startswith('--')}

    data = json.load(open(SAMPLES, encoding='utf-8'))
    samples = [s for s in data['samples'] if not only or s['id'].upper() in only]

    manifest = {}
    if reuse and os.path.exists(MANIFEST):
        try:
            manifest = json.load(open(MANIFEST, encoding='utf-8'))
        except Exception:
            manifest = {}

    os.makedirs(IMGDIR, exist_ok=True)
    rows = []
    for s in samples:
        sid = s['id']
        prev = manifest.get(sid) or {}
        base = prev.get('base_image')
        if reuse and base and os.path.exists(base):
            raw = base
            lived = '复用底图'
        else:
            t0 = time.time()
            raw = kk.gen_image(s['image_prompt'], s.get('image_negative', ''))
            lived = '真实生图 %.0fs' % (time.time() - t0)
        out = kk.overlay(raw, s['title_en'], s.get('subtitle_en', ''), s['cta_en'], url=URL, outdir=IMGDIR)
        rows.append({
            'id': sid, 'slot_id': s['slot_id'], 'angle_key': s['angle_key'],
            'creator_name': s['creator_name'], 'title_en': s['title_en'],
            'subtitle_en': s.get('subtitle_en', ''), 'cta_en': s['cta_en'],
            'tags': s['tags'], 'base_image': raw, 'final_image': out,
        })
        manifest[sid] = rows[-1]
        print('[%s] %s  %s  ->  %s' % (sid, s['creator_name'], lived, out))

    json.dump(manifest, open(MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('\n完成 %d 张，manifest: %s' % (len(rows), MANIFEST))


if __name__ == '__main__':
    main()
