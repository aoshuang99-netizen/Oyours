#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
hlua40-frames.py — 为「引用达人视频内容」抽出真实封面帧。

数据链：reports/hlua40-creators.json 的 local_videos 字段（已做 ftyp 文件头校验）
        → ffmpeg（imageio_ffmpeg 自带 v7.1）→ reports/hlua40-preview/frames/<creator>-<n>.jpg

⚠️ 该批次 216 个 .video 里 191 个其实是 HTML 抓取失败页，pool.js 已在源头剔除，
   本脚本仍再校验一次（防上游改动），解码失败即跳过并计入 stats。

用法:
  python tools/hlua40-frames.py            # 抽全部
  python tools/hlua40-frames.py --limit 2  # 每位达人最多 2 帧
"""
import hashlib
import json
import os
import subprocess
import sys

import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = 'D:/alua_scraped_data/videos/'
CREATORS = os.path.join(ROOT, 'reports', 'hlua40-creators.json')
OUTDIR = os.path.join(ROOT, 'reports', 'hlua40-preview', 'frames')

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def is_mp4(p):
    try:
        with open(p, 'rb') as f:
            head = f.read(12)
        return head[4:8] == b'ftyp'
    except OSError:
        return False


def grab(src, out, at='1.5'):
    """抽单帧：-ss 放在 -i 前 = 关键帧快速定位（大文件不必解全片）。"""
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = subprocess.run(
        [FFMPEG, '-y', '-ss', at, '-i', src, '-frames:v', '1', '-update', '1',
         '-vf', 'scale=1080:-2', '-q:v', '3', out],
        capture_output=True, text=True, timeout=180,
    )
    return r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 4096


def scan_all():
    """全库扫描：总文件数 vs 通过 ftyp 校验的真 MP4 数（该批次混入大量 HTML 失败页）"""
    tot = mp4 = html = 0
    try:
        dirs = os.listdir(SRC)
    except OSError:
        return tot, mp4, html
    for d in dirs:
        p = os.path.join(SRC, d)
        if not os.path.isdir(p):
            continue
        for f in os.listdir(p):
            fp = os.path.join(p, f)
            tot += 1
            with open(fp, 'rb') as fh:
                head = fh.read(16)
            if head[4:8] == b'ftyp':
                mp4 += 1
            elif head[:5].lower().startswith((b'<!doc', b'<html')):
                html += 1
    return tot, mp4, html


def main():
    limit = 3
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    with open(CREATORS, 'r', encoding='utf-8') as f:
        creators = json.load(f)['creators']

    os.makedirs(OUTDIR, exist_ok=True)
    rows, skipped, dup = [], 0, 0
    for c in creators:
        locals_ = c.get('local_videos') or []
        if not locals_:
            continue
        made = []
        seen_src = set()       # 源文件内容指纹去重（vid_00 与 vid_03 常是同一段视频）
        seen_frame = set()     # 抽出的帧再做一次画面指纹去重
        for rel in locals_:
            src = SRC + rel
            if not is_mp4(src):
                skipped += 1
                continue
            with open(src, 'rb') as fh:
                src_md5 = hashlib.md5(fh.read()).hexdigest()
            if src_md5 in seen_src:
                dup += 1
                continue
            seen_src.add(src_md5)
            if len(made) >= limit:
                break
            slug = ''.join(ch if ch.isalnum() else '_' for ch in c['name'])[:24].strip('_')
            out = os.path.join(OUTDIR, f'{slug}-{len(made):02d}.jpg')
            if not grab(src, out):
                skipped += 1
                continue
            with open(out, 'rb') as fh:
                frame_md5 = hashlib.md5(fh.read()).hexdigest()
            if frame_md5 in seen_frame:
                dup += 1
                os.remove(out)
                continue
            seen_frame.add(frame_md5)
            made.append({'file': os.path.relpath(out, ROOT).replace('\\', '/'),
                         'source': 'D:/alua_scraped_data/videos/' + rel})
        if made:
            rows.append({'creator': c['name'], 'user_id': c['user_id'], 'frames': made})

    scanned, mp4_files, html_files = scan_all()
    with open(os.path.join(ROOT, 'reports', 'hlua40-frames.json'), 'w', encoding='utf-8') as f:
        json.dump({'ffmpeg': FFMPEG, 'creators_with_frames': len(rows),
                   'total_frames': sum(len(r['frames']) for r in rows),
                   'scanned_files': scanned, 'mp4_files': mp4_files, 'html_error_files': html_files,
                   'skipped_decode': skipped, 'duplicate_sources': dup, 'items': rows},
                  f, ensure_ascii=False, indent=2)

    print(f'ffmpeg: {FFMPEG}')
    print(f'全库扫描 {scanned} 个文件：真 MP4 {mp4_files} · HTML 失败页 {html_files}')
    print(f'达人数 {len(rows)} · 抽出帧 {sum(len(r["frames"]) for r in rows)} · 解码失败跳过 {skipped} · 重复源剔除 {dup}')
    for r in rows:
        print(' ', r['creator'].ljust(18), '→', ', '.join(os.path.basename(x['file']) for x in r['frames']))


if __name__ == '__main__':
    main()
