#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
kk20-arts.py — KKMatch 每日批次的配图生成器（真实生图 + 本地叠字）

设计要点
--------
1) **复用而非重写**：`kk20-preview-gen.py` 里的两个函数是踩坑调出来的资产 ——
   `gen_image()` 走 :3010 content-gen 真实生图；`overlay()` 的排版引擎经过两次
   返工（遮罩前 30% 带高内升到满值；自底向上排版 + 可用高度预算 + 自动缩字号）。
   这里用 importlib 加载它（文件名带横线不能直接 import），不复制一行代码。
2) **文字一律本地排版**：扩散模型对「带文字的界面/卡片」构图必然吐乱码
   （实测出过 `Cosfes` / `Olrlee` / `Dve 3646,220` 这类假 UI 文案），
   因此 image_prompt 里必须禁 UI 元素，一切文字走 PIL 叠加。
3) 原地把 `image` / `base_image` 写回 batch JSON，供注入器直接读取。

用法
----
  python tools/kk20-arts.py --batch reports/kk20-batches/2026-09-22-evening.json
  python tools/kk20-arts.py --batch <file> --reuse        # 复用已生成原图，只重排字（省生图配额）
  python tools/kk20-arts.py --batch <file> --only 1 3 5   # 只做指定序号
"""

import argparse
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ── 加载复用模块（kk20-preview-gen.py 的 overlay / gen_image / pick_font）──
_SRC = os.path.join(HERE, 'kk20-preview-gen.py')
_spec = importlib.util.spec_from_file_location('kk20pg', _SRC)
kk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kk)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch', required=True, help='batch JSON 路径（原地回写 image 字段）')
    ap.add_argument('--outdir', default='D:/mscms-content/kk20',
                    help='叠字成品输出目录（默认 D:/mscms-content/kk20 —— 发布资产一律落 D 盘，'
                         '与 :3010 生图产物同盘，避免 C 盘空间与清理风险）')
    ap.add_argument('--reuse', action='store_true', help='复用已存在原图，只重跑叠字层')
    ap.add_argument('--force', action='store_true', help='即使成品已存在也重新生成（默认跳过已存在的）')
    ap.add_argument('--only', nargs='*', type=int, default=None, help='只做指定 n（1-based 序号）')
    args = ap.parse_args()

    batch_path = os.path.abspath(args.batch)
    if not os.path.exists(batch_path):
        print('❌ batch 文件不存在: %s' % batch_path, file=sys.stderr)
        return 2

    with open(batch_path, 'r', encoding='utf-8') as f:
        doc = json.load(f)

    items = doc.get('items') or []
    if not items:
        print('❌ batch 里没有 items', file=sys.stderr)
        return 2

    outdir = os.path.abspath(args.outdir) if args.outdir else os.path.join(os.path.dirname(batch_path), 'img')
    os.makedirs(outdir, exist_ok=True)
    # overlay() 用模块级 IMGDIR 决定落盘位置 ⇒ 必须重定向，否则会写进预览目录
    kk.IMGDIR = outdir

    ok = fail = 0
    for idx, it in enumerate(items, 1):
        if args.only and idx not in args.only:
            continue
        n = it.get('n', idx)
        t0 = time.time()
        try:
            # 成品已存在 ⇒ 跳过。这是 `kk20-daily.js --resume` 补跑的关键：
            # 只有配图失败的那几条会被重做，已成功的 18 张不会重烧生图配额。
            if not args.force and not args.reuse and it.get('image') and os.path.exists(it['image']):
                print('[%2d] skip  成品已存在 %s' % (n, os.path.basename(it['image'])), flush=True)
                ok += 1
                continue
            base = it.get('base_image')
            if args.reuse and base and os.path.exists(base):
                raw = base
                print('[%2d] reuse %s' % (n, os.path.basename(raw)), flush=True)
            else:
                print('[%2d] gen   %s' % (n, it.get('category', '')), flush=True)
                raw = kk.gen_image(it['image_prompt'], it.get('image_negative', ''))

            out = kk.overlay(raw, it.get('title_en', ''), it.get('subtitle_en', ''), it.get('cta', ''))
            it['base_image'] = str(raw).replace('\\', '/')
            it['image'] = str(out).replace('\\', '/')
            it['image_bytes'] = os.path.getsize(out)
            ok += 1
            print('[%2d] ✅ %.1fs  %s  (%.0f KB)' % (n, time.time() - t0, os.path.basename(out), it['image_bytes'] / 1024), flush=True)
        except Exception as e:
            it['image_error'] = str(e)[:300]
            fail += 1
            print('[%2d] ❌ %s' % (n, e), flush=True)

    doc['art_ok'] = ok
    doc['art_fail'] = fail
    with open(batch_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    print('\n配图完成：成功 %d / 失败 %d  → %s' % (ok, fail, batch_path), flush=True)
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
