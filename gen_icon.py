#!/usr/bin/env python3
"""Generate MSCMS v14 app icon (PNG + ICO)"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 256
ICON_DIR = r"C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\MSCMS-v14-Desktop\resources\app\assets"

# Create 256x256 master image
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Background: rounded rect with gradient
bg_color1 = (10, 22, 40, 255)   # #0a1628
bg_color2 = (22, 42, 74, 255)   # #162a4a

# Simple gradient background
for y in range(SIZE):
    ratio = y / SIZE
    r = int(bg_color1[0] + (bg_color2[0] - bg_color1[0]) * ratio)
    g = int(bg_color1[1] + (bg_color2[1] - bg_color1[1]) * ratio)
    b = int(bg_color1[2] + (bg_color2[2] - bg_color1[2]) * ratio)
    for x in range(SIZE):
        # Rounded corners
        corner_r = 50
        in_corner = False
        # Top-left
        if x < corner_r and y < corner_r:
            dx = corner_r - x
            dy = corner_r - y
            if dx*dx + dy*dy > corner_r*corner_r:
                in_corner = True
        # Top-right
        elif x > SIZE - corner_r and y < corner_r:
            dx = x - (SIZE - corner_r)
            dy = corner_r - y
            if dx*dx + dy*dy > corner_r*corner_r:
                in_corner = True
        # Bottom-left
        elif x < corner_r and y > SIZE - corner_r:
            dx = corner_r - x
            dy = y - (SIZE - corner_r)
            if dx*dx + dy*dy > corner_r*corner_r:
                in_corner = True
        # Bottom-right
        elif x > SIZE - corner_r and y > SIZE - corner_r:
            dx = x - (SIZE - corner_r)
            dy = y - (SIZE - corner_r)
            if dx*dx + dy*dy > corner_r*corner_r:
                in_corner = True
        
        if not in_corner:
            img.putpixel((x, y), (r, g, b, 255))

# Draw glow circle
glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow)
for i in range(80, 0, -1):
    alpha = int(60 * (1 - i/80))
    glow_draw.ellipse(
        [SIZE//2 - i, SIZE//2 - i, SIZE//2 + i, SIZE//2 + i],
        fill=(0, 212, 255, alpha)
    )
img = Image.alpha_composite(img, glow)
draw = ImageDraw.Draw(img)

# Draw "M" letter with gradient effect
try:
    font_large = ImageFont.truetype("C:\\Windows\\Fonts\\segoeuib.ttf", 160)
except:
    try:
        font_large = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", 160)
    except:
        font_large = ImageFont.load_default()

try:
    font_small = ImageFont.truetype("C:\\Windows\\Fonts\\segoeuib.ttf", 32)
except:
    try:
        font_small = ImageFont.truetype("C:\\Windows\\Fonts\\arialbd.ttf", 32)
    except:
        font_small = ImageFont.load_default()

# Draw "M" with cyan-purple gradient (simulate by drawing multiple layers)
text = "M"
# Get text bounding box
bbox = draw.textbbox((0, 0), text, font=font_large)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
tx = (SIZE - tw) // 2 - bbox[0]
ty = (SIZE - th) // 2 - bbox[1] - 10

# Draw with gradient color (cyan to purple)
draw.text((tx, ty), text, fill=(0, 212, 255, 255), font=font_large)

# Draw "v14" badge
v14_text = "v14"
v14_bbox = draw.textbbox((0, 0), v14_text, font=font_small)
v14_w = v14_bbox[2] - v14_bbox[0]
v14_x = SIZE - v14_w - 25
v14_y = SIZE - 50
draw.text((v14_x, v14_y), v14_text, fill=(123, 97, 255, 255), font=font_small)

# Save PNG
png_path = os.path.join(ICON_DIR, "icon.png")
img.save(png_path, "PNG")
print(f"PNG saved: {png_path}")

# Save ICO (multi-size)
ico_path = os.path.join(ICON_DIR, "icon.ico")
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
img.save(ico_path, format='ICO', sizes=sizes)
print(f"ICO saved: {ico_path}")

# Copy ICO to app root
import shutil
root_ico = r"C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\MSCMS-v14-Desktop\icon.ico"
shutil.copy2(ico_path, root_ico)
print(f"ICO copied to app root: {root_ico}")

print("Done!")
