"""
Generate responsive derivatives for the gallery images.

Reads the 15 originals in assets/, writes WebP + JPEG at three widths into
assets/gallery/, and emits gallery-manifest.json with each image's intrinsic
size and a tiny base64 LQIP placeholder.

Pillow only -- no ffmpeg/ImageMagick/cwebp on this machine. AVIF needs
Pillow 11.3+ or pillow-avif-plugin, so this is WebP + JPEG fallback.
Originals are never modified.
"""
import base64
import io
import json
import os

from PIL import Image

SRC = r"C:\Users\Cleo\Desktop\world2\assets"
OUT = os.path.join(SRC, "gallery")
WIDTHS = [480, 960, 1600]

FILES = [
    "booth-fully-custom.jpg", "portfolio-1.jpg", "service-graphic-design.jpg",
    "booth-semi-custom.jpg", "service-lighting-av.jpg", "service-custom-fab.jpg",
    "portfolio-2.jpg", "booth-simple-rental.jpg", "service-installation.jpg",
    "service-custom.jpg", "service-install.jpg", "booth-cta-bg.jpg",
    "service-coordination.jpg", "service-emergency.jpg", "service1-install.jpg",
]

os.makedirs(OUT, exist_ok=True)
manifest = {}
before = after = 0

for name in FILES:
    path = os.path.join(SRC, name)
    stem = os.path.splitext(name)[0]
    before += os.path.getsize(path)

    with Image.open(path) as im:
        im = im.convert("RGB")
        ow, oh = im.size
        ratio = oh / ow

        made = []
        for w in WIDTHS:
            if w > ow:                      # never upscale
                continue
            h = round(w * ratio)
            rz = im.resize((w, h), Image.LANCZOS)

            wp = os.path.join(OUT, f"{stem}-{w}.webp")
            rz.save(wp, "WEBP", quality=80, method=6)

            jp = os.path.join(OUT, f"{stem}-{w}.jpg")
            rz.save(jp, "JPEG", quality=82, optimize=True, progressive=True)

            after += os.path.getsize(wp)
            made.append(w)

        # LQIP: a 20px-wide WebP inlined as a data URI, blurred up by CSS.
        lq = im.resize((20, max(1, round(20 * ratio))), Image.LANCZOS)
        buf = io.BytesIO()
        lq.save(buf, "WEBP", quality=42)
        lqip = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

        manifest[stem] = {
            "w": ow, "h": oh,
            "ratio": round(ow / oh, 4),
            "widths": made,
            "lqip": lqip,
            "lqip_bytes": len(lqip),
        }

with open(os.path.join(SRC, "gallery-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=1)

print(f"{len(FILES)} images -> {OUT}")
print(f"originals      {before/1024:8.0f} KB")
print(f"webp set       {after/1024:8.0f} KB   ({100*after/before:.0f}% of original, all 3 widths)")
print()
for k, v in manifest.items():
    print(f"  {k:26s} {v['w']:5d}x{v['h']:<5d} widths={v['widths']} lqip={v['lqip_bytes']}B")
