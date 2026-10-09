#!/usr/bin/env python3
"""把生成的 PNG 图标处理成 Windows 可用的 .ico（去白底、圆角透明、多尺寸）。

用法:
  <venv-python> tools/make-app-icon.py <源PNG> <输出目录>
产出:
  <输出目录>/icon.png   512x512 透明圆角
  <输出目录>/icon.ico   16/24/32/48/64/128/256 多尺寸
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

RADIUS_RATIO = 0.255   # 圆角半径占边长比例（同时用于裁掉角落水印）
CLEAN = "--clean" in sys.argv   # 默认不用修补；需要时显式开启


def trim_white(im: Image.Image, pad: int = 2) -> Image.Image:
    """裁掉图标四周的白底留白（生成图常带白边）。"""
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if not (r > 244 and g > 244 and b > 244):
                xs.append(x)
                ys.append(y)
    if not xs:
        return im
    box = (max(min(xs) - pad, 0), max(min(ys) - pad, 0),
           min(max(xs) + 1 + pad, w), min(max(ys) + 1 + pad, h))
    return im.crop(box)


def square(im: Image.Image) -> Image.Image:
    """补成正方形（居中）。"""
    w, h = im.size
    s = max(w, h)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(im, ((s - w) // 2, (s - h) // 2))
    return canvas


def detect_faint_mark(im: Image.Image, corner: float = 0.68,
                      lo: float = 8.0, hi: float = 60.0):
    """在右下角区域找出「淡淡的叠加残留」（水印/残字）。

    做法：把原图与强模糊版相减。对比度极大的（例如主体字母 M）用上限 hi 排除，
    只保留弱对比的淡痕。返回 bbox（含 12px 外扩）或 None。
    """
    import numpy as np

    rgb = im.convert("RGB")
    arr = np.asarray(rgb, dtype=np.float64)
    blurred = np.asarray(rgb.filter(ImageFilter.GaussianBlur(30)), dtype=np.float64)
    diff = np.abs(arr - blurred).max(axis=2)

    w, h = rgb.size
    sel = np.zeros_like(diff, dtype=bool)
    sel[int(h * corner):, int(w * corner):] = True
    sel &= (diff > lo) & (diff < hi)

    ys, xs = np.where(sel)
    if len(xs) < 20:
        return None
    pad = 12
    return (int(xs.min()) - pad, int(ys.min()) - pad,
            int(xs.max()) + 1 + pad, int(ys.max()) + 1 + pad)


def clamp_inside(im: Image.Image, box, alpha_min: int = 250):
    """把 box 收缩到完全落在不透明区域内（保证填充边界取自纯渐变，不碰圆角透明区）。"""
    import numpy as np

    a = np.asarray(im)[:, :, 3]
    h, w = a.shape
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
    while x1 - x0 > 8 and (a[y0:y1, x0:x1].min() < alpha_min):
        # 优先收缩右下（该区域靠近圆角）
        if x1 - 1 > x0:
            x1 -= 1
        elif y1 - 1 > y0:
            y1 -= 1
        else:
            break
    return (x0, y0, x1, y1)


def inpaint(im: Image.Image, box, iters: int = 1500) -> Image.Image:
    """拉普拉斯调和填充：抹掉 box 内的水印/残字，且与四周严格无缝。

    原理：把 box 内部的像素当作未知量，边界像素固定为真值，
    反复用「四邻平均」迭代收敛（离散拉普拉斯方程的解 = 最平滑的过渡面）。
    图像生成模型常在右下角留水印（本图是淡淡的 "AI"），
    而该区域本就是平滑渐变，调和填充后肉眼看不出修补痕迹。
    """
    import numpy as np

    W, H = im.size
    x0, y0 = max(box[0], 0), max(box[1], 0)
    x1, y1 = min(box[2], W), min(box[3], H)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return im

    # 各向外扩 1 像素作为固定边界
    bx0, by0 = max(x0 - 1, 0), max(y0 - 1, 0)
    bx1, by1 = min(x1 + 1, W), min(y1 + 1, H)
    region = im.crop((bx0, by0, bx1, by1))
    arr = np.asarray(region, dtype=np.float64).copy()   # (h, w, 4)

    h, w = arr.shape[:2]
    fixed = np.zeros((h, w), dtype=bool)
    fixed[0, :] = fixed[-1, :] = True
    fixed[:, 0] = fixed[:, -1] = True

    cur = arr.copy()
    # 初值：边界均值
    mean = arr[fixed].mean(axis=0)
    cur[~fixed] = mean

    for _ in range(iters):
        nb = (np.roll(cur, 1, 0) + np.roll(cur, -1, 0) +
              np.roll(cur, 1, 1) + np.roll(cur, -1, 1)) / 4.0
        cur[~fixed] = nb[~fixed]

    out = Image.fromarray(np.clip(cur, 0, 255).astype(np.uint8), "RGBA")
    im.paste(out, (bx0, by0))
    return im


def rounded_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    """生成圆角矩形 alpha 蒙版（视觉上贴近 squircle）。"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    im = Image.open(src).convert("RGBA")
    im = square(trim_white(im))
    master = im.resize((1024, 1024), Image.LANCZOS)
    # 圆角蒙版：0.255 的半径既保持正常圆角方块的观感，
    # 又能把生成模型留在右下角的水印整块裁掉（0.225 时刚好差几个像素切不干净）。
    master.putalpha(rounded_mask(1024, RADIUS_RATIO))

    if CLEAN:
        mark = detect_faint_mark(master)
        if mark:
            box = clamp_inside(master, mark)
            print("检测到淡痕:", mark, "→ 收缩后:", box)
            master = inpaint(master, box)
        else:
            print("未检测到淡痕，跳过修补")
    im = master

    png_path = os.path.join(outdir, "icon.png")
    ico_path = os.path.join(outdir, "icon.ico")

    master.resize((512, 512), Image.LANCZOS).save(png_path, "PNG")

    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base = master.resize((256, 256), Image.LANCZOS)
    base.save(ico_path, format="ICO", sizes=sizes)

    print("PNG :", png_path, os.path.getsize(png_path), "bytes")
    print("ICO :", ico_path, os.path.getsize(ico_path), "bytes")
    with Image.open(ico_path) as chk:
        print("ICO 内含尺寸:", sorted(chk.info.get("sizes", [])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
