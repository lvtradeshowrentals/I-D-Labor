"""Splice the rebuilt gallery section into gallery.html."""
import json, os, re

ROOT = r"C:\Users\Cleo\Desktop\world2"
man = json.load(open(os.path.join(ROOT, "assets", "gallery-manifest.json"), encoding="utf-8"))

# Art direction: span is hand-assigned per photo, not auto-flowed.
# span 3 = feature (half the 6-col grid), span 2 = standard third.
# The three highest-resolution sources carry the feature cells.
ITEMS = [
    # stem, cats, title, meta, alt, span      (source width in comment)
    ("booth-fully-custom", "islands lighting", "40×40 Double-Deck Island", "CES 2026 · Central Hall",
     "40 by 40 double-deck custom island exhibit at CES 2026", 3),            # 832
    ("service-lighting-av", "lighting", "Video Wall Integration", "LED &amp; AV Systems",
     "Seamless LED video wall integrated into an exhibit header", 3),         # 784
    ("portfolio-1", "islands", "30×30 Peninsula Island", "NAB Show 2026",
     "30 by 30 peninsula island exhibit with backlit brand wall at NAB Show", 2),
    ("booth-semi-custom", "inline", "20×20 Semi-Custom Inline", "SEMA 2026",
     "20 by 20 semi-custom inline booth with tower and reception counter at SEMA", 2),
    ("service-installation", "fabrication", "On-Site Structural Install", "Certified I&amp;D Crew",
     "Install crew assembling structural exhibit framework on the show floor", 2),
    ("booth-cta-bg", "islands lighting", "40×50 Flagship Island", "CES 2026",
     "40 by 50 flagship island exhibit lit for the CES show floor", 3),        # 784
    ("service-custom-fab", "fabrication", "Reception Counter Fabrication", "In-House Build Shop",
     "Custom reception counter under fabrication in the build shop", 3),       # 784
    ("booth-simple-rental", "inline", "10×20 Modular Rental", "MAGIC 2026",
     "10 by 20 modular rental booth with backwall graphics at MAGIC", 2),
    ("portfolio-2", "islands graphics", "20×30 Open-Concept Island", "CONEXPO 2026",
     "20 by 30 open-concept island exhibit with feature graphics at CONEXPO", 2),
    ("service-install", "fabrication", "Double-Deck Steel Framework", "Engineered Build",
     "Engineered steel framework for a double-deck exhibit under construction", 2),
    ("service-custom", "graphics fabrication", "Illuminated Logo Header", "Custom Signage",
     "Illuminated dimensional logo header mounted on a custom exhibit", 3),    # 784
    ("service-emergency", "lighting", "Overnight Lighting Retrofit", "Rush Turnaround",
     "Overnight lighting retrofit on an exhibit ahead of show open", 3),       # 784
    ("service-graphic-design", "graphics", "Backlit Fabric Graphics", "Large-Format Print",
     "Backlit tension-fabric graphics on a large-format exhibit wall", 2),
    ("service-coordination", "inline", "Meeting Lounge Environment", "Semi-Custom Inline",
     "Semi-custom meeting lounge environment inside an inline exhibit", 2),
    ("service1-install", "fabrication", "Crated &amp; Staged for Freight", "Storage &amp; Logistics",
     "Custom exhibit components crated and staged for freight and storage", 2),
]
FOLD = 10         # rows 1-4 (3+3 | 2+2+2 | 3+3 | 2+2+2) -- a clean edge, no orphan

FILTERS = [("all", "All Work"), ("islands", "Custom Islands"), ("inline", "Inline Booths"),
           ("fabrication", "Fabrication"), ("graphics", "Graphics"), ("lighting", "Lighting &amp; AV")]

counts = {k: 0 for k, _ in FILTERS}
counts["all"] = len(ITEMS)
for _, cats, *_ in ITEMS:
    for c in cats.split():
        counts[c] = counts.get(c, 0) + 1

rail = "\n".join(
    f'                        <button class="g-chip{" is-on" if k == "all" else ""}" data-filter="{k}" '
    f'role="tab" aria-selected="{"true" if k=="all" else "false"}">'
    f'<span class="g-chip-t">{label}</span><span class="g-chip-n">{counts[k]}</span></button>'
    for k, label in FILTERS)

cards = []
for i, (stem, cats, title, meta, alt, span) in enumerate(ITEMS):
    m = man[stem]
    ws = m["widths"]
    webp = ", ".join(f"assets/gallery/{stem}-{w}.webp {w}w" for w in ws)
    sizes = "(max-width:640px) 100vw, (max-width:1000px) 50vw, " + ("50vw" if span == 3 else "33vw")
    # Single JPEG fallback for the ~3% without WebP; the <source> above
    # carries the responsive set, so the <img> needs no srcset of its own.
    fallback = f"assets/gallery/{stem}-{ws[-1]}.jpg"
    late = ' hidden' if i >= FOLD else ''
    prio = ' fetchpriority="high"' if i < 2 else ''
    lazy = 'eager' if i < 2 else 'lazy'
    cards.append(f'''                        <button class="g-item" data-span="{span}" data-cat="{cats}"
                                data-stem="{stem}" data-title="{title}" data-meta="{meta}"
                                style="--lqip:url('{m["lqip"]}')"{late}>
                            <span class="g-frame">
                                <picture>
                                    <source type="image/webp" srcset="{webp}" sizes="{sizes}">
                                    <img src="{fallback}"
                                         width="{m['w']}" height="{m['h']}" alt="{alt}"
                                         loading="{lazy}" decoding="async"{prio}>
                                </picture>
                            </span>
                            <span class="g-meta">
                                <span class="g-num">{i+1:02d}</span>
                                <span class="g-txt"><b>{title}</b><i>{meta}</i></span>
                            </span>
                        </button>''')

block = f'''                <div class="g-rail" data-reveal>
                    <div class="g-rail-track" role="tablist" aria-label="Filter portfolio by program type">
{rail}
                        <span class="g-rail-ink" aria-hidden="true"></span>
                    </div>
                    <p class="g-rail-live" role="status" aria-live="polite">Showing all {len(ITEMS)} builds</p>
                </div>

                <div class="g-grid" id="gGrid">
{chr(10).join(cards)}
                </div>

                <div class="g-more-wrap">
                    <button class="g-more" id="gMore">Show all {len(ITEMS)} builds <span class="ar" aria-hidden="true">&darr;</span></button>
                </div>

                <p class="gal-grid-note">Showing a selection of recent programs — our full <b>1,000+ build</b> archive is available on request.</p>'''

src = open(os.path.join(ROOT, "gallery.html"), encoding="utf-8").read()
# Idempotent: works on the original markup and on a previous splice.
start = src.index('                <div class="g-rail" data-reveal>') if '<div class="g-rail"' in src else src.index('                <div class="gallery-filter" data-reveal>')
end = src.index('            </div>\n        </section>', start)
open(os.path.join(ROOT, "gallery.html"), "w", encoding="utf-8").write(src[:start] + block + "\n" + src[end:])
print("spliced.  items=%d  fold=%d  counts=%s" % (len(ITEMS), FOLD, counts))
