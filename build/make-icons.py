#!/usr/bin/env python3
# Ikone aplikacije (tramvaj) – izrađuje ih GitHub pri objavi.  python3 build/make-icons.py app/icons
import os, sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else 'app/icons'
os.makedirs(OUT, exist_ok=True)

def icon(size, maskable=False):
    S = 1024
    im = Image.new('RGB', (S, S), (27, 36, 64)); d = ImageDraw.Draw(im)
    sc = 0.78 if maskable else 1.0
    c = S / 2
    def R(x0, y0, x1, y1): return [c + (x0 - c) * sc, c + (y0 - c) * sc, c + (x1 - c) * sc, c + (y1 - c) * sc]
    def P(x, y): return (c + (x - c) * sc, c + (y - c) * sc)
    blue, white, dark, yel = (47, 95, 176), (240, 244, 255), (27, 36, 64), (255, 205, 80)
    d.line([P(380, 150), P(512, 250)], fill=white, width=int(22 * sc))
    d.line([P(644, 150), P(512, 250)], fill=white, width=int(22 * sc))
    d.rounded_rectangle(R(250, 250, 774, 800), radius=int(90 * sc), fill=blue)
    d.rounded_rectangle(R(310, 320, 714, 520), radius=int(30 * sc), fill=white)
    d.rectangle(R(505, 320, 519, 520), fill=blue)
    d.ellipse(R(320, 620, 410, 710), fill=yel); d.ellipse(R(614, 620, 704, 710), fill=yel)
    d.rounded_rectangle(R(440, 640, 584, 690), radius=int(20 * sc), fill=dark)
    d.rectangle(R(320, 800, 400, 850), fill=white); d.rectangle(R(624, 800, 704, 850), fill=white)
    d.rectangle(R(200, 860, 824, 885), fill=(159, 176, 212))
    return im.resize((size, size), Image.LANCZOS)

icon(192).save(os.path.join(OUT, 'icon-192.png'))
icon(180).save(os.path.join(OUT, 'icon-180.png'))
icon(512).save(os.path.join(OUT, 'icon-512.png'))
icon(512, True).save(os.path.join(OUT, 'icon-512-maskable.png'))
print('Ikone spremljene u', OUT)
