#!/usr/bin/env python3
"""Generate the SupportOS app icon (1024x1024) for Tauri.

Design rationale: a deep indigo->blue rounded square (trust, local-first calm),
a bold white "S" for SupportOS, and a small "insight spark" dot at the top
right - the AI assistance that accompanies (never replaces) the support agent.
Rendered large so it survives downscaling to 32x32.
"""
import os
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "app-icon.png")

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# Vertical gradient: indigo (#4F46E5) -> blue (#0EA5E9)
top = (79, 70, 229)
bottom = (14, 165, 233)
gradient = Image.new("RGBA", (SIZE, SIZE))
gd = ImageDraw.Draw(gradient)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    gd.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# Rounded-square mask
mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
RADIUS = 220
md.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
img.paste(gradient, (0, 0), mask)

draw = ImageDraw.Draw(img)

# Soft inner highlight along the top edge
hl = Image.new("L", (SIZE, SIZE), 0)
hd = ImageDraw.Draw(hl)
hd.rounded_rectangle([40, 40, SIZE - 41, 260], radius=180, fill=70)
highlight = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
highlight.putalpha(hl)
img = Image.alpha_composite(img, highlight)
draw = ImageDraw.Draw(img)

# The "S" glyph - try bundled bold fonts, fall back to default
font = None
for candidate in [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]:
    if os.path.exists(candidate):
        font = ImageFont.truetype(candidate, 560)
        break
if font is None:
    font = ImageFont.load_default()

text = "S"
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (SIZE - tw) / 2 - bbox[0]
y = (SIZE - th) / 2 - bbox[1] - 18

# Subtle shadow for depth
shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.text((x + 10, y + 22), text, font=font, fill=(10, 20, 60, 90))
img = Image.alpha_composite(img, shadow)
draw = ImageDraw.Draw(img)
draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

# Insight spark (top-right): a soft glow + solid dot
spark_c = (SIZE - 190, 190)
for radius, alpha in [(64, 40), (46, 70), (30, 110)]:
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd2 = ImageDraw.Draw(glow)
    gd2.ellipse([spark_c[0] - radius, spark_c[1] - radius, spark_c[0] + radius, spark_c[1] + radius], fill=(255, 255, 255, alpha))
    img = Image.alpha_composite(img, glow)
draw = ImageDraw.Draw(img)
draw.ellipse([spark_c[0] - 17, spark_c[1] - 17, spark_c[0] + 17, spark_c[1] + 17], fill=(255, 255, 255, 255))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print("icon written: " + OUT)
