"""Score a frame against the four go/no-go gates the measuring critic set.
usage: python _gates.py shots_r24b/p033.png
The viewport is the WebGL band with the two DOM overlay panels masked out."""
import sys, colorsys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else 'shots_r24b/p033.png'
im = Image.open(path).convert('RGB')
W, H = im.size
px = im.load()

# WebGL band + mask the work-order card (left) and the timer HUD (right)
if H > 1200:                      # mobile portrait
    Y0, Y1 = int(H * 0.16), int(H * 0.62)
    masks = []
else:
    Y0, Y1 = 140, 758
    masks = [(60, 405, 330, 740), (1170, 680, 1400, 835)]

def masked(x, y):
    for mx0, my0, mx1, my1 in masks:
        if mx0 <= x <= mx1 and my0 <= y <= my1:
            return True
    return False

def luma(r, g, b):
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0

tot = 0; hot95 = 0; hot85 = 0
fam = {'red': 0, 'blue': 0, 'other': 0}
hotpts = []
for y in range(Y0, Y1, 2):
    for x in range(0, W, 2):
        if masked(x, y):
            continue
        r, g, b = px[x, y]
        tot += 1
        L = luma(r, g, b)
        if L > 0.95:
            hot95 += 1
            if len(hotpts) < 400:
                hotpts.append((x, y))
        if L > 0.85:
            hot85 += 1
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.15 and v > 0.06:
            deg = h * 360
            if deg < 45 or deg > 330:
                fam['red'] += 1
            elif 170 <= deg <= 280:
                fam['blue'] += 1
            else:
                fam['other'] += 1

pc = lambda n: 100.0 * n / max(1, tot)

# GATE 1 — hot pixels + a real bloom ramp around them
ring_near = ring_far = 0; nn = nf = 0
for (hx, hy) in hotpts[:120]:
    for dx, dy in ((5, 0), (-5, 0), (0, 5), (0, -5)):
        x, y = hx + dx, hy + dy
        if 0 <= x < W and Y0 <= y < Y1 and not masked(x, y):
            ring_near += luma(*px[x, y]); nn += 1
    for dx, dy in ((32, 0), (-32, 0), (0, 32), (0, -32)):
        x, y = hx + dx, hy + dy
        if 0 <= x < W and Y0 <= y < Y1 and not masked(x, y):
            ring_far += luma(*px[x, y]); nf += 1
near = ring_near / max(1, nn); far = ring_far / max(1, nf)
ramp = near / max(1e-4, far)

# GATE 3 — stand bbox (anything meaningfully lit)
bx0, by0, bx1, by1 = W, H, 0, 0
for y in range(Y0, Y1, 2):
    for x in range(0, W, 2):
        if masked(x, y):
            continue
        if luma(*px[x, y]) > 0.16:
            bx0 = min(bx0, x); bx1 = max(bx1, x)
            by0 = min(by0, y); by1 = max(by1, y)
bbox_pc = 100.0 * ((bx1 - bx0) * (by1 - by0)) / (W * H) if bx1 > bx0 else 0

# GATE 4 — vertical mirror correlation about the stand's base line
best = 0; bestY = 0
for fold in range(by1 - 120, by1 + 40, 6):
    num = den1 = den2 = 0.0; n = 0
    for dy in range(4, 90, 2):
        ya, yb = fold - dy, fold + dy
        if ya < Y0 or yb >= Y1:
            continue
        for x in range(max(0, bx0), min(W, bx1), 4):
            if masked(x, ya) or masked(x, yb):
                continue
            a = luma(*px[x, ya]); b = luma(*px[x, yb])
            num += a * b; den1 += a * a; den2 += b * b; n += 1
    if n > 400 and den1 > 0 and den2 > 0:
        c = num / (den1 ** 0.5 * den2 ** 0.5)
        if c > best:
            best, bestY = c, fold

print(f"frame            {path}  ({W}x{H})  viewport px sampled {tot}")
print(f"GATE 1  >0.95    {pc(hot95):.4f}%   (need >=0.15%)   [>0.85 = {pc(hot85):.3f}%]")
print(f"        bloom ramp  near/far = {near:.3f}/{far:.3f} = {ramp:.2f}x  (need >=2.0x)")
print(f"GATE 2  red      {pc(fam['red']):.2f}%   blue {pc(fam['blue']):.2f}%   "
      f"(need blue<15% and red>blue)")
print(f"GATE 3  bbox     {bbox_pc:.2f}% of frame  (need >=30%)")
print(f"GATE 4  mirror r {best:.3f} at y={bestY}  (need >=0.55)")
g1 = pc(hot95) >= 0.15 and ramp >= 2.0
g2 = pc(fam['blue']) < 15 and fam['red'] > fam['blue']
g3 = bbox_pc >= 30
g4 = best >= 0.55
print(f"PASS: G1={g1}  G2={g2}  G3={g3}  G4={g4}   -> {sum([g1,g2,g3,g4])}/4")
