/* MI-GL — the WebGL booth layer for the Move-In section.
   Four real custom exhibit booths (researched against CES/EXHIBITOR award
   builds), each shown MID-BUILD with crew and equipment, staged from one
   scroll-driven build scalar per booth. Renders into one transparent canvas
   whose camera EXACTLY reproduces the CSS 3D projection of the SVG hall —
   verified to <0.1px against the browser's own pipeline (_align.mjs).

   Coordinate contract (verified empirically, do not re-derive on paper):
   - BOOTH MODEL space: x = plan east (ft), y = UP (ft), z = plan south
     (ft, toward the aisle/camera). Right-handed, y-up. 1 ft = 5 plan units,
     applied by each booth mount's scale.
   - The plan group's matrix maps plan space onto the CSS world plane and
     applies the SVG camera (translate/scale), stage fit, world rake/yaw
     about the CSS transform-origin, all rebuilt per frame from the same
     numbers the CSS world receives.
   - The camera has an identity view matrix and a hand-built projection
     reproducing CSS `perspective:650px; perspective-origin:50% 56%` plus
     the y-flip to NDC. Depth row uses eye distances n=40, f=6000.

   Render pipeline (mi-post.js): HDR MSAA target -> hand-built 6-mip bloom
   -> AgX composite with grain/CA/dither. Renderer tone mapping is OFF —
   the transfer curve lives in the composite, so emissives authored >1.0
   stay HDR into the bloom threshold. Shadows: one directional key with a
   scale-tracking ortho frustum (the zoom is baked into the world matrix,
   so scaling the frustum by k keeps the cached depth map valid) rendered
   on demand, landing on a ShadowMaterial plane over the SVG drawing.
   Lights stay scale-invariant (hemi + directionals, no falloff). */
import * as THREE from 'three';
import { MiPost } from './mi-post.js';

let D = 650;   /* focal depth — per-beat variable, synced from the page */
const PO = { x: 0.50, y: 0.56 };   /* y is overridden per frame via paint */
const WO_ORIGIN = { x: 0.50, y: 0.62 };
const VBW = 1600, VBH = 1520;
const FT = 5;                      /* plan units per foot */

const NAVY7 = 0x1a2332, GOLD = 0xb8a573;
const SILVER = 0x828a94, WOOD = 0x4a443b;

const state = {
  renderer: null, scene: null, camera: null, plan: null,
  booths: [], rectW: 0, rectH: 0, narrow: false,
  ledTex: null, barsTex: null, t0: performance.now(),
  showGlows: [], envTex: null,
  houseRows: [], aisleGlow: [],
  post: null, shadowDirty: true, keyLight: null,
  reveal: { i: -1, flat: 0, fill: 1, strike: 0 },
  practicals: [], sway: [], dust: null, ledClones: [],
};

/* ================= textures ================= */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/* THE BROADCAST ATLAS (decree item 5): x-tileable, >=55% near-black, no
   saturated channel at full — hots are white-gold so AgX rolls them off.
   4 frames stacked (offset.y flips at 12fps, offset.x glides). Bands per
   frame: gold ticker / navy gridfield with data blocks / oscilloscope /
   countdown + wordmark. The company's product is the best pixel in frame. */
function makeLedAtlas() {
  const AW = 2048, FH = 256;
  const R01 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s); };
  return canvasTex(AW, FH * 4, (g) => {
    const TICKER = ' LVTSR · NAB ’26 · LVCC CENTRAL HALL · FLOOR RELEASE 16:00 · 19 CREW · 135 PERSON-HOURS · I&D ON SCHEDULE ·';
    for (let f = 0; f < 4; f++) {
      const y0 = f * FH;
      g.fillStyle = '#04060a'; g.fillRect(0, y0, AW, FH);
      if (f === 3) {
        /* drawn block 3 = TEXTURE FRAME 0 (flipY): the PIXEL-MAP TEST CARD
           every screen runs until the 14:00 color-balance deadline the
           work order promises (jury r10 — content follows the clock) */
        const bars = ['#8a8f94', '#8f8a4a', '#4a8a8a', '#4a8a4f',
                      '#84508a', '#8a4a4a', '#4a4f8a', '#1a1d22'];
        bars.forEach((c, bi) => {
          g.fillStyle = c; g.fillRect(bi * AW / 8, y0 + 8, AW / 8 + 1, 150);
        });
        g.strokeStyle = 'rgba(240,240,244,.8)'; g.lineWidth = 2;
        for (let cx2 = 128; cx2 < AW; cx2 += 256) {
          g.beginPath(); g.moveTo(cx2 - 14, y0 + 83); g.lineTo(cx2 + 14, y0 + 83);
          g.moveTo(cx2, y0 + 69); g.lineTo(cx2, y0 + 97); g.stroke();
        }
        g.strokeStyle = 'rgba(240,240,244,.55)';
        g.strokeRect(4, y0 + 6, AW - 8, 244);
        g.fillStyle = '#050708'; g.fillRect(0, y0 + 168, AW, 54);
        g.fillStyle = '#e2c186';
        g.font = '800 34px "Segoe UI", system-ui, sans-serif';
        g.fillText('PIXEL MAP · COLOR BALANCE BY 14:00 · LVTSR LED TECHS · C5020', 60, y0 + 206);
        g.fillStyle = 'rgba(230,235,240,.5)';
        g.font = '700 20px "Segoe UI", system-ui, sans-serif';
        for (let n = 0; n < 8; n++) g.fillText('P' + (n + 1), n * AW / 8 + 14, y0 + 244);
        g.fillStyle = 'rgba(0,4,8,.20)';
        for (let x = 0; x < AW; x += 6) g.fillRect(x, y0, 1, FH);
        for (let yy = 0; yy < FH; yy += 6) g.fillRect(0, y0 + yy, AW, 1);
        continue;
      }
      /* — gold ticker band — */
      g.fillStyle = '#050708'; g.fillRect(0, y0 + 8, AW, 50);
      g.font = '700 30px "Segoe UI", system-ui, sans-serif';
      g.fillStyle = '#e2c186';
      const shift = (f * 512) % AW;
      g.fillText(TICKER, -shift, y0 + 43);
      g.fillText(TICKER, AW - shift, y0 + 43);
      const lx = (620 + f * 512) % (AW - 120);
      g.fillStyle = '#ffedc2'; g.fillRect(lx, y0 + 14, 92, 38);
      g.fillStyle = '#151006'; g.font = '800 26px "Segoe UI", system-ui, sans-serif';
      g.fillText('LIVE', lx + 14, y0 + 42);
      g.fillStyle = '#8f7440'; g.fillRect(0, y0 + 60, AW, 2);
      /* — navy gridfield with data blocks — */
      g.strokeStyle = 'rgba(70,120,160,.10)'; g.lineWidth = 1;
      for (let x = 0; x <= AW; x += 64) { g.beginPath(); g.moveTo(x, y0 + 64); g.lineTo(x, y0 + 148); g.stroke(); }
      for (let yy = y0 + 64; yy <= y0 + 148; yy += 21) { g.beginPath(); g.moveTo(0, yy); g.lineTo(AW, yy); g.stroke(); }
      for (let i = 0; i < 30; i++) {
        const n = f * 100 + i;
        const bw = 26 + R01(n + 3) * 96;
        const bx2 = 20 + R01(n) * (AW - 60 - bw);
        const by = y0 + 66 + R01(n + 9) * 62;
        const bh = 6 + R01(n + 5) * 14;
        const r = R01(n + 7);
        g.fillStyle = r > 0.98 ? '#ffffff' : r > 0.90 ? '#ffedc2' :
                      r > 0.72 ? '#7fc4e8' : (r > 0.4 ? '#123a56' : '#0e2c42');
        g.fillRect(bx2, by, bw, bh);
        if (r > 0.90) { g.fillStyle = '#8f7440'; g.fillRect(bx2, by + bh + 2, bw, 2); }
      }
      for (let c = 0; c < 5; c++) {
        const cx = 180 + c * 400 + f * 37;
        for (let bar = 0; bar < 7; bar++) {
          const bh2 = 4 + R01(f * 50 + c * 9 + bar) * 30;
          g.fillStyle = bar === 5 ? '#ffedc2' : '#1a4a6e';
          g.fillRect(cx + bar * 9, y0 + 146 - bh2, 6, bh2);
        }
      }
      /* — oscilloscope band — */
      g.fillStyle = '#03050a'; g.fillRect(0, y0 + 152, AW, 58);
      g.strokeStyle = 'rgba(90,140,180,.14)';
      g.beginPath(); g.moveTo(0, y0 + 181); g.lineTo(AW, y0 + 181); g.stroke();
      g.strokeStyle = '#dff6ff'; g.lineWidth = 2.5;
      g.beginPath();
      const TAU = Math.PI * 2;
      for (let x = 0; x <= AW; x += 6) {
        const env = 0.35 + 0.65 * Math.abs(Math.sin(x * TAU * 3 / AW + f * 1.1));
        const yy = y0 + 181 + Math.sin(x * TAU * 9 / AW + f * 1.57) * 21 * env;
        x ? g.lineTo(x, yy) : g.moveTo(x, yy);
      }
      g.stroke();
      for (let d = 0; d < 8; d++) {
        const dx = (d * 256 + f * 64 + 128) % AW;
        g.fillStyle = '#ffedc2'; g.fillRect(dx - 2, y0 + 160, 4, 4);
      }
      /* — countdown + wordmark band — */
      g.fillStyle = '#ffedc2';
      g.font = '800 34px "Segoe UI", system-ui, sans-serif';
      g.fillText('16:00 FLOOR RELEASE', 40, y0 + 246);
      g.font = '700 20px "Segoe UI", system-ui, sans-serif';
      g.fillStyle = '#7fc4e8';
      g.fillText('HALL C · MOVE-IN DAY ' + (3), 460, y0 + 243);
      g.fillStyle = '#0a0d12'; g.fillRect(1560, y0 + 216, 420, 36);
      g.fillStyle = '#e2c186';
      g.font = '800 30px "Segoe UI", system-ui, sans-serif';
      g.fillText('LVTSR', 1580, y0 + 245);
      g.fillStyle = '#8f7440'; g.fillRect(1712, y0 + 222, 3, 26);
      g.fillStyle = '#9fc8dd';
      g.font = '700 19px "Segoe UI", system-ui, sans-serif';
      g.fillText('EXHIBIT SERVICES · LAS VEGAS', 1726, y0 + 241);
      /* pixel pitch — a whisper, not a screen door */
      g.fillStyle = 'rgba(0,4,8,.20)';
      for (let x = 0; x < AW; x += 6) g.fillRect(x, y0, 1, FH);
      for (let yy = 0; yy < FH; yy += 6) g.fillRect(0, y0 + yy, AW, 1);
    }
  });
}
/* THE SUPERGRAPHIC (canyon cliffs): large-format brand hero — a 40ft LED
   wall runs a luminous show graphic, not a dashboard. Deep navy field,
   white-gold sweep, giant wordmark, gold ticker footer. x-tileable. */
function makeCliffAtlas() {
  /* two stacked bands: canvas TOP half = the show supergraphic
     (v .5-1 after flipY), BOTTOM half = the pixel-map test card the
     cliffs run until 14:00 (v 0-.5). Clones use repeat.y 0.5. */
  const AW = 2048, AH = 512, TAU = Math.PI * 2;
  const t = canvasTex(AW, AH * 2, (g) => {
    /* — test band (canvas bottom half) — */
    g.fillStyle = '#07090d'; g.fillRect(0, AH, AW, AH);
    const cbars = ['#8a8f94', '#8f8a4a', '#4a8a8a', '#4a8a4f',
                   '#84508a', '#8a4a4a', '#4a4f8a', '#15181d'];
    cbars.forEach((c, bi) => {
      g.fillStyle = c; g.fillRect(bi * AW / 8, AH + 30, AW / 8 + 1, 300);
    });
    g.strokeStyle = 'rgba(240,240,244,.7)'; g.lineWidth = 3;
    g.strokeRect(10, AH + 12, AW - 20, AH - 24);
    for (let cx2 = 128; cx2 < AW; cx2 += 256) {
      g.beginPath(); g.moveTo(cx2 - 20, AH + 180); g.lineTo(cx2 + 20, AH + 180);
      g.moveTo(cx2, AH + 160); g.lineTo(cx2, AH + 200); g.stroke();
    }
    g.fillStyle = '#050708'; g.fillRect(0, AH + 350, AW, 90);
    g.fillStyle = '#e2c186';
    g.font = '800 56px "Segoe UI", system-ui, sans-serif';
    g.fillText('C5020 · 110 CABINETS · PIXEL MAP & COLOR BALANCE BY 14:00', 80, AH + 414);
    g.fillStyle = 'rgba(0,4,8,.16)';
    for (let x = 0; x < AW; x += 5) g.fillRect(x, AH, 1, AH);
    for (let y = AH; y < AH * 2; y += 5) g.fillRect(0, y, AW, 1);
    /* — supergraphic band (canvas top half) — */
    const bg = g.createLinearGradient(0, 0, 0, AH);
    bg.addColorStop(0, '#0d2242'); bg.addColorStop(0.55, '#0a1830');
    bg.addColorStop(1, '#050c1a');
    g.fillStyle = bg; g.fillRect(0, 0, AW, AH);
    /* the sweep: one wide diagonal white-gold light band, drawn twice for
       the tile seam */
    for (const ox of [0, AW, -AW]) {
      const sw = g.createLinearGradient(ox + 300, 0, ox + 980, AH);
      sw.addColorStop(0, 'rgba(255,240,214,0)');
      sw.addColorStop(0.46, 'rgba(255,240,214,.34)');
      sw.addColorStop(0.54, 'rgba(255,244,224,.5)');
      sw.addColorStop(0.62, 'rgba(255,240,214,.3)');
      sw.addColorStop(1, 'rgba(255,240,214,0)');
      g.fillStyle = sw; g.fillRect(ox, 0, AW, AH);
    }
    /* twin flowing ribbons — integer harmonics so the tile is seamless */
    g.lineWidth = 12; g.strokeStyle = 'rgba(234,246,255,.9)';
    g.beginPath();
    for (let x = 0; x <= AW; x += 8) {
      const yy = 240 + Math.sin(x * TAU * 2 / AW) * 88 + Math.sin(x * TAU * 5 / AW + 1.2) * 30;
      x ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
    g.lineWidth = 7; g.strokeStyle = 'rgba(226,193,134,.95)';
    g.beginPath();
    for (let x = 0; x <= AW; x += 8) {
      const yy = 268 + Math.sin(x * TAU * 2 / AW + 0.55) * 96 + Math.sin(x * TAU * 3 / AW + 2.6) * 34;
      x ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
    /* giant wordmark block */
    g.fillStyle = 'rgba(4,10,20,.55)'; g.fillRect(96, 128, 760, 240);
    g.fillStyle = '#f2f7fc';
    g.font = '800 150px "Segoe UI", system-ui, sans-serif';
    g.fillText('LVTSR', 128, 290);
    g.fillStyle = '#e2c186';
    g.font = '700 56px "Segoe UI", system-ui, sans-serif';
    g.fillText('NAB ’26 · CENTRAL HALL', 132, 352);
    g.fillStyle = '#e2c186';
    g.font = '700 44px "Segoe UI", system-ui, sans-serif';
    g.fillText('CUSTOM LED · FLOWN · FREE-STANDING', 1150, 452);
    /* gold ticker footer */
    g.fillStyle = '#050708'; g.fillRect(0, AH - 34, AW, 34);
    g.fillStyle = '#e2c186';
    g.font = '700 24px "Segoe UI", system-ui, sans-serif';
    g.fillText(' 110 CABINETS · 2 PROCESSORS · PIXEL MAP 14:00 · LVTSR I&D CREWS · CALL 0900 ·', 0, AH - 9);
    /* pixel pitch */
    g.fillStyle = 'rgba(0,4,8,.16)';
    for (let x = 0; x < AW; x += 5) g.fillRect(x, 0, 1, AH);
    for (let y = 0; y < AH; y += 5) g.fillRect(0, y, AW, 1);
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
function makeColorBars() {
  return canvasTex(256, 128, (g) => {
    const cs = ['#c8ccd0', '#c2c22a', '#2ac2c2', '#2ac22a', '#c22ac2', '#c22a2a', '#2a2ac2'];
    cs.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * 256 / 7, 0, 256 / 7 + 1, 128); });
    g.fillStyle = 'rgba(0,0,0,.45)';
    for (let x = 0; x < 256; x += 4) g.fillRect(x, 0, 1, 128);
    for (let y = 0; y < 128; y += 4) g.fillRect(0, y, 256, 1);
  });
}
const textTexCache = new Map();
function textTex(text, opt) {
  const key = text + JSON.stringify(opt || {});
  if (textTexCache.has(key)) return textTexCache.get(key);
  const o = Object.assign({ w: 1024, h: 128, fg: '#d8c894', bg: '#121a26',
    size: 72, glow: false }, opt);
  const t = canvasTex(o.w, o.h, (g) => {
    g.fillStyle = o.bg; g.fillRect(0, 0, o.w, o.h);
    g.font = `800 ${o.size}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (o.glow) { g.shadowColor = o.fg; g.shadowBlur = 18; }
    g.fillStyle = o.fg;
    g.fillText(text, o.w / 2, o.h / 2 + 4);
  });
  textTexCache.set(key, t);
  return t;
}
function makeGlowTex() {
  /* hot core: the old 0.5-peak texture died at the wide zoom (jury: booths
     read as dark islands at p088 because nothing bleeds past silhouettes) */
  return canvasTex(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    grd.addColorStop(0.65, 'rgba(255,255,255,0.10)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  });
}
let coneTex;
function makeConeTex() {
  /* a work-light throw: bright narrow apex fanning to nothing */
  coneTex = canvasTex(128, 128, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, 'rgba(255,235,190,0.85)');
    grd.addColorStop(0.5, 'rgba(255,220,160,0.28)');
    grd.addColorStop(1, 'rgba(255,210,140,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(58, 0); g.lineTo(70, 0); g.lineTo(122, 128); g.lineTo(6, 128);
    g.closePath(); g.fill();
  });
}
function makeBlobTex() {
  return canvasTex(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.6)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.28)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  });
}

/* ================= materials (shared — few programs) ================= */
const M = {};
/* constant-view-dir fresnel: view matrix is identity here (the flip lives
   in the world chain), so view-space normal.z IS "how much this face points
   at the screen" — edges that turn away catch a teal rim. Near-free. */
/* THE SHEET STANDS UP — shared reveal state. One uniform-object block,
   shared BY REFERENCE into every patched program, so a single .value write
   drives the whole scene: uFlat turns the subject booth into a plotter
   drawing (diffuse x0.03, ink x6), uSolidY sweeps matter in behind a hot
   band that blooms and spills onto the plan. The footprint gate (uRevMin/
   uRevMax in booth space) keeps the OTHER booths solid. */
/* THE GANTRY PRINTS THE BOOTH. Rigid things never change scale: parts sit
   at FULL size, first as gold-ink drawing, then as matter — and the border
   between the two is a noised molten front that follows a physical gantry
   of light traveling the footprint. uGz is the gantry position along the
   print axis (booth z, or top-down height for the drum via uRevDir). */
const RV = {
  uBoothInv: { value: new THREE.Matrix4() },
  uGz:       { value: 9999 },    /* gantry position, booth feet */
  uBandW:    { value: 1.0 },     /* molten band half-thickness */
  uFlat:     { value: 0 },
  uInkA:     { value: new THREE.Color(2.6, 1.55, 0.5) },   /* gold ink, HDR */
  uInkB:     { value: new THREE.Color(2.3, 1.45, 0.62) },   /* MOLTEN gold front */
  uLine:     { value: 1.15 },
  uRevMin:   { value: new THREE.Vector2(1, 1) },   /* empty gate by default */
  uRevMax:   { value: new THREE.Vector2(-1, -1) },
  uRevDir:   { value: 1 },   /* 1 = print along z, -1 = top-down (the drum) */
  uH:        { value: 30 },  /* subject booth height, for the climb lag */
  uInkR:     { value: 1.2 },     /* ink flood radius from the burnt seam */
  uFoot:     { value: new THREE.Vector2(20, 10) },  /* footprint half-extents */
};

function patchMat(mat, opt) {
  /* one composed injection: per-face value ladder (front 1.0 / side .74 /
     top .9 / underside .5), edge ink off the aHalf attribute, the reveal
     front, and (optionally) the screen-facing rim */
  if (opt.rim) mat.userData.rimBase = opt.rimS;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uBoothInv: RV.uBoothInv, uGz: RV.uGz, uBandW: RV.uBandW,
      uFlat: RV.uFlat, uInkA: RV.uInkA, uInkB: RV.uInkB, uLine: RV.uLine,
      uRevMin: RV.uRevMin, uRevMax: RV.uRevMax, uRevDir: RV.uRevDir,
      uH: RV.uH, uInkR: RV.uInkR, uFoot: RV.uFoot,
    });
    sh.vertexShader = ('varying vec3 vObjN; varying vec3 vBP;\n' +
      'varying vec3 vHalf; varying vec3 vLoc;\n' +
      'attribute vec3 aHalf; uniform mat4 uBoothInv;\n') + sh.vertexShader
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n vObjN = objectNormal;')
      .replace('#include <project_vertex>',
        `#include <project_vertex>
         vec4 uWp = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           uWp = instanceMatrix * uWp;
         #endif
         vBP = (uBoothInv * (modelMatrix * uWp)).xyz;
         vHalf = aHalf; vLoc = position;`);
    let frag = ('varying vec3 vObjN; varying vec3 vBP;\n' +
      'varying vec3 vHalf; varying vec3 vLoc;\n' +
      'uniform float uGz, uBandW, uFlat, uLine, uRevDir, uH, uInkR;\n' +
      'uniform vec2 uFoot;\n' +
      'uniform vec3 uInkA, uInkB; uniform vec2 uRevMin, uRevMax;\n' +
      '#define REVEAL_ON ' + (opt.reveal ? '1.0' : '0.0') + '\n') + sh.fragmentShader
      .replace('#include <color_fragment>',
        `#include <color_fragment>
         vec3 uOn = normalize(vObjN);
         float uLad = uOn.y < -0.55 ? 0.5
           : mix(mix(0.74, 1.0, smoothstep(0.35, 0.9, abs(uOn.z))),
                 0.9, smoothstep(0.55, 0.9, uOn.y));
         diffuseColor.rgb *= uLad;
         vec3 uE = vHalf - abs(vLoc);
         float uMid = uE.x + uE.y + uE.z
           - max(uE.x, max(uE.y, uE.z)) - min(uE.x, min(uE.y, uE.z));
         float uPx = fwidth(uMid);
         float uInk = 1.0 - smoothstep(uLine * uPx, uLine * uPx + uPx, uMid);
         if (vHalf.x * vHalf.y * vHalf.z < 1e-6) uInk = 0.0;
         float uGate = REVEAL_ON * step(uRevMin.x, vBP.x) * step(vBP.x, uRevMax.x)
                     * step(uRevMin.y, vBP.z) * step(vBP.z, uRevMax.y);
         /* THE PRINT FRONT: position along the gantry axis, lagged by
            height (tall matter lands later) and roughened by noise so the
            edge is molten, never a plane */
         float uNz = sin(vBP.x * 1.31 + vBP.y * 0.7) * 0.55
                   + sin(vBP.z * 1.73 - vBP.x * 0.53) * 0.30
                   + sin(vBP.y * 2.11 + vBP.z * 0.91) * 0.15;
         float uAxis = uRevDir > 0.0
           ? vBP.z + 0.30 * vBP.y + 0.14 * uNz * 7.0
           : (uH - vBP.y) + 0.10 * length(vBP.xz) + 0.14 * uNz * 7.0;
         float uSolid = smoothstep(uAxis - uBandW, uAxis + uBandW, uGz);
         float uBandF = (1.0 - smoothstep(0.0, uBandW * 1.4, abs(uGz - uAxis))) * uGate;
         float uFlatF = uFlat * (1.0 - uSolid) * uGate;
         /* the drawing FLOODS inward from the burnt perimeter seam */
         float uEdgeD = min(uFoot.x - abs(vBP.x), uFoot.y - abs(vBP.z))
                      / max(1.0, min(uFoot.x, uFoot.y));
         float uFlood = 1.0 - smoothstep(uInkR - 0.14, uInkR, max(0.0, uEdgeD));
         uFlatF *= 1.0;
         diffuseColor.rgb *= mix(1.0, 0.03, uFlatF);`)
      .replace('#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         totalEmissiveRadiance += uInkA * uInk * (2.6 * uFlatF * uFlood)
                                + uInkA * (0.06 * uFlatF * uFlood)
                                + uInkB * uBandF * 1.7;`);
    if (opt.rim) {
      sh.uniforms.uRimC = { value: new THREE.Color(opt.rim) };
      sh.uniforms.uRimS = { value: opt.rimS };
      frag = frag
        .replace('#include <common>', '#include <common>\nuniform vec3 uRimC; uniform float uRimS;')
        .replace('totalEmissiveRadiance += uInkA',
          `float uFr = pow(1.0 - abs(normalize(normal).z), 3.0);
           totalEmissiveRadiance += uRimC * (uFr * uRimS * (1.0 - uFlatF));
           totalEmissiveRadiance += uInkA`);
    }
    sh.fragmentShader = frag;
    mat.userData.sh = sh;
  };
}
function makeMaterials(envTex) {
  /* albedos lifted well above the brand hex — the TONE reads as navy once
     lit; painting the literal hex reads as black. The whole diffuse family
     carries the environment: metalness above zero with no envMap throws
     away diffuse and gets nothing back (the old "plasticky mud"). */
  const E = { emissive: 0x010204, emissiveIntensity: 1,
    envMap: envTex, envMapIntensity: .45 };
  M.navy9 = new THREE.MeshStandardMaterial({ color: 0x1c2734, roughness: .55, metalness: .3, ...E });
  M.navy7 = new THREE.MeshStandardMaterial({ color: 0x2c3d56, roughness: .45, metalness: .2, ...E });
  M.gold  = new THREE.MeshStandardMaterial({ color: GOLD, roughness: .32, metalness: .85,
    envMap: envTex, envMapIntensity: .9 });
  M.silver = new THREE.MeshStandardMaterial({ color: SILVER, roughness: .38, metalness: .9,
    envMap: envTex, envMapIntensity: .9 });
  M.alu = new THREE.MeshStandardMaterial({ color: 0x9aa6ad, roughness: .46, metalness: .85,
    envMap: envTex, envMapIntensity: .55 });
  M.charcoal = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: .7, metalness: .2,
    envMap: envTex, envMapIntensity: .5 });
  M.wood  = new THREE.MeshStandardMaterial({ color: WOOD, roughness: .8, metalness: .05, ...E, emissive: 0x020201 });
  M.ply   = new THREE.MeshStandardMaterial({ color: 0x9c8256, roughness: .85, metalness: 0, ...E, emissive: 0x020201 });
  M.dark  = new THREE.MeshStandardMaterial({ color: 0x232a33, roughness: .8, metalness: .1, ...E });
  M.carpet = new THREE.MeshStandardMaterial({ color: 0x172030, roughness: .95, metalness: 0, ...E, emissive: 0x000000 });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x9fc8dc, roughness: .05, metalness: .1,
    transparent: true, opacity: .28, depthWrite: false,
    envMap: envTex, envMapIntensity: 1.2 });
  M.smoke = new THREE.MeshStandardMaterial({ color: 0x121a24, roughness: .1, metalness: .2,
    transparent: true, opacity: .55, depthWrite: false,
    envMap: envTex, envMapIntensity: .6 });
  M.plastic = new THREE.MeshStandardMaterial({ color: 0xb8c4cc, roughness: .5, metalness: 0,
    transparent: true, opacity: .26, depthWrite: false,
    envMap: envTex, envMapIntensity: .8 });
  /* emissive family — MeshBasic is unlit; >1 channels punch through ACES */
  /* brand system is gold/navy — the old cyan slabs were the biggest
     off-brand pixel in every booth chapter (jury r10, twice) */
  M.teal  = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.55, 1.36, 0.98) });
  M.tealSoft = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.16, 0.55, 0.82) });
  M.warm  = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.75, 1.05) });
  M.amberGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 0.62, 0.16) });
  M.caution = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.35, 0.2) });
  /* workers are dark figures — only the stripes and headlamps catch light */
  M.hivis = new THREE.MeshStandardMaterial({ color: 0x9e5016, roughness: .8,
    emissive: 0x531f08, emissiveIntensity: .18 });
  M.skin = new THREE.MeshStandardMaterial({ color: 0xa87f60, roughness: .85 });
  M.hat  = new THREE.MeshStandardMaterial({ color: 0xd8b25a, roughness: .5,
    emissive: 0xd8b25a, emissiveIntensity: .12 });
  /* limbs never drop to pure black at distance (critic: 'noodle arms') */
  M.limb = new THREE.MeshStandardMaterial({ color: 0x333c46, roughness: .7 });
  /* attendees: no hi-vis, no hats — teal/ivory/slate civilians for doors */
  M.civ = [
    new THREE.MeshStandardMaterial({ color: 0x2d9cca, roughness: .75, emissive: 0x2d9cca, emissiveIntensity: .18 }),
    new THREE.MeshStandardMaterial({ color: 0xc9cdd4, roughness: .8, emissive: 0x9aa2ac, emissiveIntensity: .1 }),
    new THREE.MeshStandardMaterial({ color: 0x5a6b7e, roughness: .8, emissive: 0x5a6b7e, emissiveIntensity: .12 }),
  ];
  /* teal silhouette rim on the big navy masses — surged by applyShow so
     edges flare when the doors open. Dropped ~40% now real shadows shade. */
  /* the reveal chunk rides only the STRUCTURAL family — raw materials and
     equipment (wood/ply/carpet) stay physical while the plan stands up
     around them, which is what sells the drawing as a drawing */
  patchMat(M.navy9, { rim: 0x2d9cca, rimS: 0.22, reveal: true });
  patchMat(M.navy7, { rim: 0x2d9cca, rimS: 0.17, reveal: true });
  patchMat(M.dark,  { rim: 0x1a6a90, rimS: 0.13, reveal: true });
  patchMat(M.gold, { reveal: true }); patchMat(M.silver, { reveal: true });
  patchMat(M.alu, { reveal: true }); patchMat(M.charcoal, { reveal: true });
  /* soft goods join the drawing too — a lit blue carpet slab inside a
     gold wireframe broke the flat illusion (r9 ink-shot pass) */
  patchMat(M.wood, { reveal: true }); patchMat(M.ply, { reveal: true });
  patchMat(M.carpet, { reveal: true });
  /* shared emissives that surge when the house lights come up */
  M._boost = [
    [M.teal, new THREE.Color(0.28, 1.15, 1.7)],
    [M.tealSoft, new THREE.Color(0.16, 0.55, 0.82)],
    [M.warm, new THREE.Color(1.9, 1.55, 0.95)],
  ];
}
/* tiny gradient "hall" baked once through PMREM — metals reflect NOTHING
   without an environment in r160, which is why gold read as mud. A warm
   overhead card streaks the gold reveals; a cool side card glints silver. */
function makeEnvTex(renderer) {
  const env = new THREE.Scene();
  const grad = canvasTex(64, 64, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, '#3a5a78'); gr.addColorStop(0.55, '#0d141d');
    gr.addColorStop(1, '#241a0e');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16),
    new THREE.MeshBasicMaterial({ map: grad, side: THREE.BackSide })));
  for (let si = 0; si < 6; si++) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(46, 1.4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.1, 2.4) }));
    strip.position.set(0, 30, -30 + si * 12);
    strip.rotation.x = Math.PI / 2;
    env.add(strip);
  }
  const door = new THREE.Mesh(new THREE.PlaneGeometry(3, 14),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.6, 3.2) }));
  door.position.set(40, 6, 10); door.rotation.y = -Math.PI / 2; env.add(door);
  const cool = new THREE.Mesh(new THREE.PlaneGeometry(20, 30),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 3.2, 4.5) }));
  cool.position.set(-40, 10, 0); cool.rotation.y = Math.PI / 2; env.add(cool);
  /* floor bounce below the horizon so gold/silver undersides have
     something to catch — a PMREM with no lower hemisphere kills metals
     seen from above */
  const bounce = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.65, 0.85) }));
  bounce.position.set(0, -30, 0); bounce.rotation.x = -Math.PI / 2; env.add(bounce);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.05).texture;
  pm.dispose();
  return tex;
}

/* ================= small builders ================= */
/* chamfered box: every one of the ~2000 boxes gets a real bevel so edges
   catch the key light instead of vanishing into 90-degree black. Cached by
   dimension; carries a constant aHalf attribute (pre-bevel half extents)
   that the reveal shader's edge-ink relies on. */
const _box = new Map();
function boxGeo(w, h, d) {
  const key = w + ',' + h + ',' + d;
  if (_box.has(key)) return _box.get(key);
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const b = Math.min(Math.max(Math.min(w, Math.min(h, d)) * 0.06, 0.008), 0.06);
  const H = [hx, hy, hz], pos = [], nrm = [], uv = [];
  const tri = (A, B, C, N) => {
    const ab = [B[0]-A[0], B[1]-A[1], B[2]-A[2]], ac = [C[0]-A[0], C[1]-A[1], C[2]-A[2]];
    const cr = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    const flip = cr[0]*N[0] + cr[1]*N[1] + cr[2]*N[2] < 0;
    const P = flip ? [A, C, B] : [A, B, C];
    /* dominant-axis box mapping keeps crate labels / truss repeats intact */
    const ax = Math.abs(N[0]) > Math.abs(N[1])
      ? (Math.abs(N[0]) > Math.abs(N[2]) ? 0 : 2)
      : (Math.abs(N[1]) > Math.abs(N[2]) ? 1 : 2);
    const ua = ax === 0 ? 2 : 0, va = ax === 1 ? 2 : 1;
    for (const p of P) {
      pos.push(p[0], p[1], p[2]); nrm.push(N[0], N[1], N[2]);
      uv.push(p[ua] / (2 * H[ua]) + 0.5, p[va] / (2 * H[va]) + 0.5);
    }
  };
  const quad = (A, B, C, Dp, N) => { tri(A, B, C, N); tri(A, C, Dp, N); };
  const pt = (a, sa, b2, sb, c, sc, insA, insB, insC) => {
    const p = [0, 0, 0];
    p[a] = sa * (H[a] - (insA ? b : 0));
    p[b2] = sb * (H[b2] - (insB ? b : 0));
    p[c] = sc * (H[c] - (insC ? b : 0));
    return p;
  };
  /* 6 face plates, inset by the bevel */
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    for (const s of [1, -1]) {
      const N = [0, 0, 0]; N[a] = s;
      quad(pt(a,s, u, 1, v, 1, false,true,true), pt(a,s, u,-1, v, 1, false,true,true),
           pt(a,s, u,-1, v,-1, false,true,true), pt(a,s, u, 1, v,-1, false,true,true), N);
    }
  }
  /* 12 bevel strips — one per unordered axis pair x sign pair, swept along
     the third axis between the two faces' inset edges */
  for (const [a1, a2] of [[0, 1], [0, 2], [1, 2]]) {
    const t = 3 - a1 - a2;
    for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
      const EN = [0, 0, 0]; EN[a1] = s1 * 0.7071; EN[a2] = s2 * 0.7071;
      quad(pt(a1,s1, a2,s2, t, 1, false,true,true), pt(a1,s1, a2,s2, t,-1, false,true,true),
           pt(a2,s2, a1,s1, t,-1, false,true,true), pt(a2,s2, a1,s1, t, 1, false,true,true), EN);
    }
  }
  /* corner patches */
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const N = [sx * 0.577, sy * 0.577, sz * 0.577];
    tri(pt(0,sx, 1,sy, 2,sz, false,true,true),
        pt(1,sy, 0,sx, 2,sz, false,true,true),
        pt(2,sz, 0,sx, 1,sy, false,true,true), N);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  const half = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { half[i] = hx; half[i+1] = hy; half[i+2] = hz; }
  g.setAttribute('aHalf', new THREE.BufferAttribute(half, 3));
  _box.set(key, g);
  return g;
}
function bx(w, h, d, mat, x, y, z, ry) {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x || 0, y || 0, z || 0);
  if (ry) m.rotation.y = ry;
  return m;
}
let glowTex, blobTex, reflFadeTex;
function glowSprite(color, size, x, y, z, opacity) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, opacity: opacity == null ? .8 : opacity }));
  s.scale.setScalar(size); s.position.set(x, y, z); s.renderOrder = 3;
  return s;
}
/* two-layer glow: hot white core inside a colored bloom — survives the
   wide zoom where the single sprite vanished */
function glowSprite2(color, size, x, y, z, o) {
  const g = new THREE.Group();
  const op = o == null ? .8 : o;
  g.add(glowSprite(0xffffff, size * 0.35, x, y, z, op * 0.9));
  g.add(glowSprite(color, size, x, y, z, op * 0.75));
  return g;
}
/* warm/teal light pool on the concrete — the spill an emissive surface
   should cast. Registered in state.showGlows so the doors beat can breathe
   every pool up together. */
function pool(color, rx, rz, x, z, op) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true,
      opacity: op == null ? .22 : op, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;
  m.scale.set(rx * 2, rz * 2, 1);
  m.position.set(x, 0.06, z);
  m.renderOrder = 2;
  m.userData.baseOp = m.material.opacity;
  state.showGlows.push(m);
  return m;
}
/* fake polished-concrete reflection: a vertically-flipped clone of an
   emissive plane below the floor line, faded out by an alpha gradient.
   Composites over the DOM plan because the canvas is transparent. */
function mirrorPlane(w, h, mat, x, yCenter, z, strength) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat.clone());
  /* depthTest OFF: the mirror lives below the (opaque) platform slab, which
     would occlude it entirely — as additive low-opacity sheen it composites
     over the floor pixels instead, which is the look anyway */
  Object.assign(m.material, { transparent: true, opacity: strength == null ? .3 : strength,
    alphaMap: reflFadeTex, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, fog: false });
  m.position.set(x, -yCenter, z);
  m.scale.y = -1;               /* mirror about the floor line */
  m.renderOrder = 2;
  return m;
}
function blob(rx, rz, x, z, op) {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true,
      opacity: op == null ? .55 : op, depthWrite: false, toneMapped: false }));
  g.rotation.x = -Math.PI / 2;
  g.scale.set(rx * 2, rz * 2, 1);
  g.position.set(x, 0.045, z);
  g.renderOrder = 1;
  return g;
}
/* a glowing panel: emissive face + additive halo plane behind it */
function lightFace(w, h, mat, halo) {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  if (halo !== false) {
    /* two halos: a tight hot one and a wide bloom skirt so the panel
       still bleeds at the p088 wide zoom */
    const mk = (sw, sh, op, z) => {
      const hm = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh),
        new THREE.MeshBasicMaterial({ map: glowTex, color: 0x49b8e8,
          transparent: true, opacity: op, blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false }));
      hm.position.z = z; hm.renderOrder = 3;
      return hm;
    };
    /* halos halved — the real bloom pass carries the glow now */
    const g2 = new THREE.Group();
    g2.add(g, mk(w * 1.25, h * 1.5, .28, 0.15), mk(w * 2.1, h * 2.6, .09, 0.3));
    return g2;
  }
  const g2 = new THREE.Group();
  g2.add(g);
  return g2;
}

/* SEG lightbox: silver extrusion frame + emissive teal face */
function lightbox(w, h, text) {
  const g = new THREE.Group();
  g.add(bx(w, h, 0.3, M.navy7, 0, 0, -0.18));
  for (const s of [-1, 1]) {
    g.add(bx(0.18, h, 0.34, M.silver, s * (w / 2 - 0.09), 0, 0));
    g.add(bx(w, 0.18, 0.34, M.silver, 0, s * (h / 2 - 0.09), 0));
  }
  /* brand gold on charcoal, letters hot enough to halo their own plate —
     the cyan box read as a motel sign (owner: nothing "in glory" is cyan) */
  const faceMat = text
    ? new THREE.MeshBasicMaterial({
        map: textTex(text, { fg: '#ffd98e', bg: '#0d1218', size: 58, glow: true }),
        toneMapped: false, fog: false, color: new THREE.Color(1.55, 1.45, 1.25) })
    : M.teal;
  const f = lightFace(w - 0.4, h - 0.4, faceMat);
  f.position.z = 0.18;
  g.add(f);
  return g;
}
/* truss stick: two crossed cut-out planes (X-section) — 2 draw calls */
let trussTexH;
function makeTrussTex() {
  trussTexH = canvasTex(512, 64, (g) => {
    g.clearRect(0, 0, 512, 64);
    g.strokeStyle = '#aab4bd'; g.lineWidth = 7;
    g.beginPath(); g.moveTo(0, 5); g.lineTo(512, 5);
    g.moveTo(0, 59); g.lineTo(512, 59); g.stroke();
    g.lineWidth = 5;
    for (let x = 0; x <= 512 - 64; x += 64) {
      g.beginPath(); g.moveTo(x, 59); g.lineTo(x + 32, 5); g.lineTo(x + 64, 59); g.stroke();
      g.beginPath(); g.moveTo(x + 2, 59); g.lineTo(x + 2, 5); g.stroke();
    }
  });
  trussTexH.wrapS = THREE.RepeatWrapping;
}
const trussMatCache = new Map();
function truss(len, depth) {
  depth = depth || 1;
  const k = Math.round(len / depth * 4);
  if (!trussMatCache.has(k)) {
    const t = trussTexH.clone(); t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round(len / (depth * 2))), 1);
    trussMatCache.set(k, new THREE.MeshStandardMaterial({ map: t, alphaTest: .45,
      side: THREE.DoubleSide, roughness: .45, metalness: .8, color: 0xbfc8d0,
      envMap: state.envTex, envMapIntensity: .8 }));
  }
  const mat = trussMatCache.get(k);
  const g = new THREE.Group();
  const a = new THREE.Mesh(new THREE.PlaneGeometry(len, depth), mat);
  const b = a.clone(); b.rotation.x = Math.PI / 2;
  a.rotation.x = 0;
  g.add(a, b);
  return g;
}
function counterK1(len) {
  len = len || 6;
  const g = new THREE.Group();
  g.add(bx(len, 3.1, 2, M.navy7, 0, 1.85, 0));
  g.add(bx(len - 0.4, 0.35, 1.8, M.navy9, 0, 0.2, 0));       /* toe kick */
  g.add(bx(len + 0.2, 0.14, 2.2, M.gold, 0, 3.47, 0));       /* gold reveal */
  const f = lightFace(len - 0.8, 1.4, M.teal);                /* backlit logo band */
  f.position.set(0, 1.9, 1.02);
  g.add(f);
  return g;
}
function plinthK2(h) {
  h = h || 3.3;
  const g = new THREE.Group();
  g.add(bx(2, h, 2, M.navy7, 0, h / 2, 0));
  g.add(bx(2.2, 0.12, 2.2, M.gold, 0, h + 0.06, 0));
  const strip = bx(2.05, 0.1, 2.05, M.teal, 0, h - 0.14, 0);
  g.add(strip);
  return g;
}
function crateK7(l, w, h, label) {
  const g = new THREE.Group();
  g.add(bx(l, h, w, M.ply, 0, h / 2, 0));
  for (const s of [-1, 1]) {
    g.add(bx(l + 0.06, 0.5, w + 0.06, M.wood, 0, 0.3, 0));
    g.add(bx(l + 0.06, 0.5, w + 0.06, M.wood, 0, h - 0.3, 0));
    g.add(bx(0.5, h + 0.04, w + 0.06, M.wood, s * (l / 2 - 0.3), h / 2, 0));
  }
  if (label) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(l * 0.7, h * 0.34),
      new THREE.MeshStandardMaterial({ map: textTex(label, { fg: '#3a3227', bg: '#96805a', size: 60 }), roughness: .9 }));
    p.position.set(0, h * 0.55, w / 2 + 0.04);
    g.add(p);
  }
  return g;
}
function gangBox() {
  const g = new THREE.Group();
  g.add(bx(4, 3.4, 2, new THREE.MeshStandardMaterial({ color: 0x7c2820, roughness: .5, metalness: .4 }), 0, 1.9, 0));
  g.add(bx(4.1, 0.3, 2.1, M.dark, 0, 3.55, 0));
  g.add(bx(1.6, 0.5, 2.2, M.dark, -0.8, 1.2, 0.15));   /* open drawer */
  return g;
}
function ladderK12() {
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    const rail = bx(0.16, 6.2, 0.16, M.silver, s * 0.8, 3.1, 0);
    rail.rotation.z = s * -0.12;
    g.add(rail);
    for (let i = 0; i < 5; i++)
      g.add(bx(1.5 - i * 0.13, 0.12, 0.14, M.silver, 0, 0.9 + i * 1.15, s * 0.001));
  }
  g.rotation.x = 0.14;
  return g;
}
function scissorLift(platY) {
  const g = new THREE.Group();
  g.add(bx(8, 1.4, 4, M.navy9, 0, 0.9, 0));
  for (const c of [[-3.2, -1.6], [3.2, -1.6], [-3.2, 1.6], [3.2, 1.6]])
    g.add(bx(0.9, 0.7, 0.9, M.dark, c[0], 0.35, c[1]));
  /* scissor X pairs */
  const n = 3, seg = (platY - 1.6) / n;
  for (let i = 0; i < n; i++) {
    const y = 1.6 + seg * (i + 0.5);
    const a = bx(7.4, 0.22, 0.22, M.silver, 0, y, -1.5);
    a.rotation.z = 0.55 * (seg / 2.6);
    const b2 = a.clone(); b2.rotation.z *= -1;
    const c2 = a.clone(); c2.position.z = 1.5;
    const d2 = b2.clone(); d2.position.z = 1.5;
    g.add(a, b2, c2, d2);
  }
  g.add(bx(8.4, 0.5, 4.4, M.navy7, 0, platY + 0.25, 0));
  /* platform rails */
  for (const s of [-1, 1]) {
    g.add(bx(8.4, 0.14, 0.14, M.gold, 0, platY + 2, s * 2.1));
    g.add(bx(0.14, 1.6, 4.3, M.silver, s * 4.1, platY + 1.3, 0));
  }
  return g;
}
function forkliftK11() {
  const g = new THREE.Group();
  g.add(bx(5.4, 2.6, 3.6, M.navy9, -0.6, 2.1, 0));
  g.add(bx(2.6, 1.4, 3.2, new THREE.MeshStandardMaterial({ color: 0xc9a54e, roughness: .5, metalness: .3 }), -1.9, 3.9, 0)); /* counterweight top */
  g.add(bx(0.5, 6.8, 0.4, M.dark, 2.4, 3.4, -1.1));
  g.add(bx(0.5, 6.8, 0.4, M.dark, 2.4, 3.4, 1.1));      /* mast */
  g.add(bx(3.4, 0.22, 0.9, M.silver, 4.2, 0.5, -0.8));
  g.add(bx(3.4, 0.22, 0.9, M.silver, 4.2, 0.5, 0.8));   /* forks */
  g.add(bx(1.6, 1.2, 2.8, M.dark, 0.6, 4, 0));          /* cage */
  for (const p of [[-2.2, -1.7], [-2.2, 1.7], [1.6, -1.7], [1.6, 1.7]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.7, 12), M.dark);
    w.rotation.x = Math.PI / 2; w.position.set(p[0], 0.85, p[1]);
    g.add(w);
  }
  const beacon = bx(0.3, 0.3, 0.3, M.amberGlow, 0.6, 4.8, 0);
  g.add(beacon);
  g.add(glowSprite2(0xf0a030, 2.6, 0.6, 4.8, 0, .55));
  return g;
}
function carpetRoll() {
  const g = new THREE.Group();
  const r = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 10, 14), M.carpet);
  r.rotation.z = Math.PI / 2; r.position.y = 1.25;
  g.add(r);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 10.4, 8), M.ply);
  core.rotation.z = Math.PI / 2; core.position.y = 1.25;
  g.add(core);
  return g;
}
function workLight() {
  const g = new THREE.Group();
  for (const s of [-1, 0, 1]) {
    const leg = bx(0.1, 5.6, 0.1, M.dark, s * 0.5, 2.8, s ? -0.4 : 0.55);
    leg.rotation.z = s * 0.14; leg.rotation.x = s ? 0.1 : -0.14;
    g.add(leg);
  }
  g.add(bx(2.4, 1.1, 0.5, M.dark, 0, 5.9, 0));
  g.add(bx(1, 0.8, 0.1, M.warm, -0.6, 5.9, 0.28));
  g.add(bx(1, 0.8, 0.1, M.warm, 0.6, 5.9, 0.28));
  g.add(glowSprite2(0xffe8b0, 3.4, 0, 5.9, 0.4, .45));
  /* the promise a work light makes: a hot pool on the concrete in front
     of it (jury: "a work light that doesn't cast light is a broken promise") */
  const p = pool(0xffc878, 5.5, 4, 0, 3.4, .3);
  state.showGlows.pop();          /* practicals do not surge at doors */
  g.add(p);
  /* and a visible throw, so the story reads at wide zoom too */
  const cone = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 5.8),
    new THREE.MeshBasicMaterial({ map: coneTex, color: 0xffd9a0,
      transparent: true, opacity: .34, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide }));
  cone.position.set(0, 3.1, 1.9);
  cone.rotation.x = -0.3;
  cone.renderOrder = 3;
  g.add(cone);
  return g;
}
function cautionTape(len) {
  return bx(len, 0.25, 0.03, M.caution, 0, 0, 0);
}
function cable(x1, y1, z1, x2, y2, z2, thick) {
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const m = bx(thick || 0.07, l, thick || 0.07, M.silver, 0, 0, 0);
  m.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / l, dy / l, dz / l));
  return m;
}
/* hanging ring sign + rig cables */
function signRing(dia, h, topY) {
  const g = new THREE.Group();
  const r = dia / 2;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48, 1, true),
    new THREE.MeshStandardMaterial({ color: NAVY7, roughness: .5,
      metalness: .2, side: THREE.DoubleSide }));
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.06, r + 0.06, h * 0.34, 36, 1, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.78, 1.12), side: THREE.DoubleSide }));
  const cy = topY - h / 2;
  drum.position.y = cy; band.position.y = cy - h * 0.12;
  g.add(drum, band);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    g.add(cable(Math.cos(a) * r * 0.8, topY, Math.sin(a) * r * 0.8,
                Math.cos(a) * r * 0.2, topY + 14, Math.sin(a) * r * 0.2, 0.05));
  }
  g.add(glowSprite2(0x4ec2ee, dia * 0.9, 0, cy, 0, .4));
  return g;
}
/* low-poly worker ~5.9ft, poses via limb pivots */
let workerGeos = null;
function makeWorker(pose, civ) {
  if (!workerGeos) workerGeos = {
    torso: new THREE.CapsuleGeometry(.16, .30, 4, 8),
    stripe: new THREE.CylinderGeometry(.168, .168, .045, 8, 1, true),
    head: new THREE.IcosahedronGeometry(.11, 0),
    hat: new THREE.SphereGeometry(.135, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    brim: new THREE.CylinderGeometry(.16, .16, .02, 8),
    arm: new THREE.CapsuleGeometry(.05, .30, 3, 6),
    leg: new THREE.CapsuleGeometry(.07, .34, 3, 6),
  };
  const g = new THREE.Group();
  const torso = new THREE.Mesh(workerGeos.torso,
    civ == null ? M.hivis : M.civ[civ % M.civ.length]);
  torso.position.y = .78; g.add(torso);
  if (civ == null) for (const y of [.70, .86]) {
    const s = new THREE.Mesh(workerGeos.stripe,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.5, 1.4), side: THREE.DoubleSide }));
    s.position.y = y; g.add(s);
  }
  const head = new THREE.Mesh(workerGeos.head, M.skin); head.position.y = 1.12; g.add(head);
  if (civ == null) {
    const hat = new THREE.Mesh(workerGeos.hat, M.hat); hat.scale.y = .8; hat.position.y = 1.17; g.add(hat);
    const brim = new THREE.Mesh(workerGeos.brim, M.hat); brim.position.y = 1.155; g.add(brim);
  }
  const limbs = {};
  for (const [name, geo, len, x, y] of [
      ['armL', workerGeos.arm, .30, .21, .94], ['armR', workerGeos.arm, .30, -.21, .94],
      ['legL', workerGeos.leg, .34, .09, .42], ['legR', workerGeos.leg, .34, -.09, .42]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const limb = new THREE.Mesh(geo, M.limb);
    limb.position.y = -len / 2 - 0.06;
    pivot.add(limb); g.add(pivot); limbs[name] = pivot;
  }
  const POSES = {
    stand:    { armL: [-.2, 0, -.1], armR: [-.2, 0, .1] },
    carrying: { armL: [-1.5, 0, -.25], armR: [-1.5, 0, .25], legL: [.12, 0, 0], legR: [-.12, 0, 0] },
    kneeling: { armL: [-.9, 0, 0], armR: [-.4, 0, 0], legL: [-1.5, 0, 0], legR: [.2, 0, 0], rootY: -.28, rootRotX: .15 },
    guiding:  { armL: [-2.0, 0, -.3], armR: [-.3, 0, .4] },
    pointing: { armR: [-1.7, 0, -.5], armL: [0, 0, .2] },
  };
  const p = POSES[pose] || POSES.stand;
  for (const k of ['armL', 'armR', 'legL', 'legR']) if (p[k]) limbs[k].rotation.set(...p[k]);
  if (p.rootY) g.position.y = p.rootY;
  if (p.rootRotX) g.rotation.x = p.rootRotX;
  if (civ == null) {
    /* headlamp: a hot point on the brim + a warm splash ahead of it */
    const lamp = glowSprite(0xffe0a0, 0.26, 0.16, 1.16, 0.14, .65);
    g.add(lamp);
  }
  const wrap = new THREE.Group();
  wrap.add(g);
  wrap.scale.setScalar(4.6 * (0.93 + hash01(state.sway.length * 7 + 3) * 0.12));   /* recipe is ~1.28 units tall -> ~5.9 ft */
  /* the inner body sways on the idle clock — applyB owns the wrap, the
     idle layer owns the body, so they never fight */
  state.sway.push(g);
  return wrap;
}

/* ================= staging ================= */
const EASE = {
  steel: t => t < .7 ? t * 0.82 : 0.574 + (1 - Math.pow(1 - (t - .7) / .3, 3)) * .426,
  panel: t => { const s = 1.2, u = t - 1; return 1 + u * u * ((s + 1) * u + s); },
  bolt:  t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  slab:  t => t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
};
function makeBooth(group) {
  return { group, parts: [], b: -1, show: -1, live: false };
}
/* put(booth, object, x, y, z, staging) — three calling forms:
   numeric x/y/z sets the position; an OBJECT in the x slot means the
   position is already baked into the object (bx sets it) and the object
   is the staging options; null x keeps the position with options in the
   6th slot (cables). Mixing these silently was the NaN-matrix bug that
   made every wall and column vanish — keep all three forms working. */
const hash01 = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };
function put(bo, obj, x, y, z, o) {
  if (typeof x === 'number') obj.position.set(x, y, z);
  else if (x && typeof x === 'object') o = x;
  o = o || {};
  if (o.ry) obj.rotation.y = o.ry;
  bo.group.add(obj);
  const idx = bo.parts.length;
  /* LIT parts (screens, glows, sprites, glass) are light, not structure —
     they have no place in the ink drawing and hide until matter arrives */
  let lit = false;
  obj.traverse((n) => {
    const m = n.material;
    if (m && (m.isMeshBasicMaterial || m.isSpriteMaterial ||
              (m.transparent && !m.isShadowMaterial))) lit = true;
  });
  /* T10: everything with wheels or weight bites into the floor — an auto
     contact decal sized from the object's own model-space footprint.
     (Measured DETACHED: through the mount the axes are swapped + scaled.) */
  if (o && o.gear && !lit) {
    bo.group.remove(obj);
    obj.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(obj);
    bo.group.add(obj);
    if (isFinite(bb.min.x)) {
      const sx = (bb.max.x - bb.min.x) / 2, sz = (bb.max.z - bb.min.z) / 2;
      if (sx > 0.5 && sx < 20) {
        const dec = blob(sx * 1.15, sz * 1.15, 0, 0, .38);
        dec.position.set(
          (bb.min.x + bb.max.x) / 2 - obj.position.x,
          0.05 - obj.position.y,
          (bb.min.z + bb.max.z) / 2 - obj.position.z);
        obj.add(dec);
      }
    }
  }
  bo.parts.push({
    lit,
    obj, st: o.st == null ? 0.5 : o.st, w: o.w || 0.16,
    ease: EASE[o.ease || 'steel'],
    rest: { p: obj.position.clone(), rx: obj.rotation.x, ry: obj.rotation.y, rz: obj.rotation.z },
    /* dy authored => the part FLIES in (deck flown from above, panels
       descending); dy omitted => the part is a RISER: it stands up out of
       the flat drawing, scale.y 0.002 -> 1 across its erection window */
    riser: o.dy == null && !o.gear,
    baseSY: obj.scale.y,
    d: { x: o.dx || 0, y: o.dy || 0, z: o.dz || 0,
         rx: o.drx || 0, ry: o.dry || 0, rz: o.drz || 0 },
    /* THE DOORS CONTRACT: gear rolls out to freight on its own phase so no
       two parts leave on the same frame; showOnly finishing pieces ARRIVE
       through the same easing machinery. Pure functions of (b, show). */
    gear: !!o.gear, showOnly: !!o.showOnly,
    gs: hash01(idx) * 0.45,
    ss2: 0.30 + hash01(idx + 57) * 0.40,
  });
  return obj;
}
/* THE GANTRY PRINT. Rigid things never change scale. Every part exists at
   full size the whole time: as gold-ink drawing ahead of the gantry, as
   matter behind it. Its arrival "u" is when the gantry crosses its own
   station (z + height-lag + a designer bias from st) — flights fly their
   authored path on u, everything else lands with a damped settle. All of
   it a pure function of (b, show): scrub-reversible, no clocks. */
function applyB(bo, b, show) {
  if (show == null) show = Math.max(0, bo.show);
  if (bo.b === b && bo.show === show && !bo.revealDirty) return;
  bo.b = b; bo.show = show; bo.revealDirty = false;
  const flat = !!bo.revealFlat;
  const D2 = bo.dims ? bo.dims.D : 20, H2 = bo.dims ? bo.dims.H : 26;
  const topDown = bo.topDown;
  /* gantry position for this b — overshoots both ends so 0 and 1 are clean */
  const gz = topDown
    ? -2 + b * (H2 + 8)
    : (-D2 / 2 - 3) + b * (D2 + 6 + 0.30 * H2 + 3);
  bo.gz = gz;
  for (const p of bo.parts) {
    if (p.gzp == null) {
      const r = p.rest.p;
      p.gzp = topDown
        ? (H2 - r.y) + 0.10 * Math.hypot(r.x, r.z) + (p.st - 0.5) * 2.0
        : r.z + 0.30 * r.y + (p.st - 0.5) * 2.4 + (p.gs / 0.45 - 0.5) * 0.8;
      p.span = 4.5 + p.w * 10;
    }
    const u = Math.min(1, Math.max(0, (gz - p.gzp) / p.span));
    const e = 1 - p.ease(u);
    let x = p.rest.p.x + p.d.x * e;
    let y = p.rest.p.y + p.d.y * e;
    const z = p.rest.p.z + p.d.z * e;
    /* the landing: a damped oscillation in POSITION only — weight, not
       squash. At u=1 the term is ~e^-6, continuous to zero. */
    if (u > 0.001 && u < 1) {
      y += 0.015 * H2 * Math.exp(-6 * u) * Math.cos(9.4 * u * Math.PI);
    }
    let vis = u > 0.001;
    if (flat && !p.gear && !p.showOnly && !p.lit) vis = true;
    if (p.lit && flat) vis = u > 0.6;
    /* OWNER ORDER (2026-08-19): no booth lingers half-finished. Each stand
       reaches full show-glory at the END OF ITS OWN CHAPTER — gear rolls
       out and finishing pieces arrive as b closes, not at the 16:00 doors.
       fin = the booth's own completion, still a pure function of scroll. */
    const fin = Math.max(show, Math.min(1, Math.max(0, (b - 0.86) / 0.12)));
    if (p.gear) {
      const gt = Math.min(1, Math.max(0, (fin - p.gs) / 0.30));
      x -= 90 * gt * gt * gt;
      vis = u > 0.001 && gt < 1;
    } else if (p.showOnly) {
      const t2 = Math.min(1, Math.max(0, (fin - p.ss2) / 0.35));
      y += 6 * (1 - EASE.panel(t2));
      vis = t2 > 0.001;
    }
    p.obj.position.set(x, y, z);
    p.obj.scale.y = p.baseSY;
    p.obj.rotation.set(p.rest.rx + p.d.rx * e, p.rest.ry + p.d.ry * e, p.rest.rz + p.d.rz * e);
    p.obj.visible = vis;
  }
}

/* ================= architectural builders ================= */
/* finArray — N copies of one box on a line, one draw call. The workhorse
   of all four stands: louvres, soffit fins, slat screens, web members. */
function finArray(n, geo, mat, place) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  const d = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    place(d, i, n);
    d.updateMatrix();
    m.setMatrixAt(i, d.matrix);
  }
  m.instanceMatrix.needsUpdate = true;
  return m;
}
/* an open cylinder shell (arc), 48 segments — the drum's vocabulary */
function drumShell(r, h, mat, a0, aLen) {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, h, 48, 1, true, a0, aLen), mat);
}
function tubeRing(r, tubeR, mat) {
  return new THREE.Mesh(new THREE.TorusGeometry(r, tubeR, 10, 64), mat);
}
/* zigzag LED cliff: `facets` vertical planes alternating +-amp radians,
   one geometry, one material, UV striped per facet so the shared LED
   atlas content SHEARS across the folds */
function facetWall(len, h, facets, amp, vary) {
  const pos = [], nrm = [], uv = [], idx = [];
  const fw = len / facets;
  /* shared edge depths: alternating +- with an optional per-edge hash
     amplitude (decree: amp*(0.6+0.8*hash01) — irregular, never cracked,
     because facets meet at the SAME edge value) */
  const h01 = (j) => { const s = Math.sin(j * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s); };
  const ez = [];
  for (let j = 0; j <= facets; j++) {
    const a = vary ? amp * (0.6 + 0.8 * h01(j)) : amp;
    ez.push((j % 2 ? 1 : -1) * Math.sin(a) * fw / 2);
  }
  for (let i = 0; i < facets; i++) {
    const x0 = -len / 2 + i * fw, x1 = x0 + fw;
    const z0 = ez[i], z1 = ez[i + 1];
    const dz = z1 - z0, L = Math.hypot(fw, dz);
    const nx = -dz / L, nz = fw / L;
    const b = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, h, z0);
    for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
    uv.push(i / facets, 0, (i + 1) / facets, 0, (i + 1) / facets, 1, i / facets, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}
/* a practical: real falloff light parented into the booth. Distance and
   intensity are rescaled by the zoom every frame (syncWorld) or the
   falloff would breathe with the chapter camera. */
function practical(bo, color, intensity, distFt, x, y, z) {
  const L = new THREE.PointLight(color, 0, 1, 2);
  L.position.set(x, y, z);
  bo.group.add(L);
  state.practicals.push({ L, baseI: intensity, baseD: distFt * FT });
  return L;
}
/* the downward ground halo every stand throws once its lights are on */
function standHalo(bo, color, W, Dp, baseOp) {
  const q = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.3, Dp * 1.6),
    new THREE.MeshBasicMaterial({ map: glowTex, color,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false }));
  q.rotation.x = -Math.PI / 2;
  q.position.y = 0.06;
  q.renderOrder = 2;
  q.userData.baseOp = baseOp;
  bo.group.add(q);
  state.showGlows.push(q);
  return q;
}

/* ================= the four booths ================= */
/* Model space: x along the stand's long axis (plan east), z toward the
   aisle/camera (+), y up. Units: feet. Silhouette test: all four must be
   tellable apart in flat black — a plate on a mast, a sliced drum under a
   halo, a folded canyon, an opened crate on scissor masts. */

function booth1(bo) {           /* C1006 — THE HUNG DECK. 40x20 double-deck I&D */
  const W = 39.8, Dp = 19.8, hw = W / 2, hd = Dp / 2;
  put(bo, blob(hw * 1.14, hd * 1.25, 0, 0, .5), null, 0, 0, { st: 0.02, w: .04, dy: 0 });
  /* ground floor: platform + carpet */
  put(bo, bx(W, 0.5, Dp, M.ply, 0, 0.25, 0), { st: 0.04, w: .08 });
  put(bo, bx(W - 2, 0.12, Dp - 2, M.carpet, 0, 0.56, 0), { st: 0.07, w: .08 });
  /* THE MAST — the whole stand hangs off this. 30ft, aluminium, gold cap */
  put(bo, bx(2.6, 30, 2.6, M.alu, -6, 15, -hd + 2.2), { st: 0.10, w: .10 });
  put(bo, bx(3.1, 0.5, 3.1, M.gold, -6, 30.2, -hd + 2.2), { st: 0.18, w: .06 });
  /* two 40ft box-truss chords at 26ft with a diagonal web (one draw) */
  for (const zc of [-hd + 1, -hd + 3.4]) {
    put(bo, bx(W - 2, 0.55, 0.55, M.alu, 0, 26, zc), { st: 0.14, w: .08 });
    put(bo, bx(W - 2, 0.55, 0.55, M.alu, 0, 23.6, zc), { st: 0.16, w: .08 });
  }
  put(bo, finArray(30, boxGeo(0.22, 2.9, 0.22), M.silver, (d, i) => {
    d.position.set(-hw + 2.2 + i * (W - 4.4) / 29, 24.8, -hd + (i % 2 ? 1 : 3.4));
    d.rotation.z = (i % 2 ? 1 : -1) * 0.72;
  }), { st: 0.19, w: .09 });
  /* 16 tension rods + their light-ghost (a harp of light, 2 draws) */
  const rodGeo = new THREE.CylinderGeometry(.05, .05, 12.6, 6);
  put(bo, finArray(16, rodGeo, M.silver, (d, i) => {
    d.position.set(-hw + 3 + (i % 8) * (W - 6) / 7, 17.2, -hd + 1 + Math.floor(i / 8) * 2.4);
  }), { st: 0.24, w: .08 });
  put(bo, finArray(16, rodGeo, new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.14, 0.55, 0.85), transparent: true, opacity: .5,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), (d, i) => {
    d.position.set(-hw + 3 + (i % 8) * (W - 6) / 7, 17.2, -hd + 1 + Math.floor(i / 8) * 2.4);
    d.scale.set(2.1, 1, 2.1);
  }), { st: 0.30, w: .08 });
  /* THE DECK — flown in from above on the slab ease. 15ft deep, the front
     11ft cantilevers over the aisle, column-free. */
  put(bo, bx(W, 0.9, 15, M.navy9, 0, 11, -hd + 7.5), { st: 0.30, w: .14, dy: -15, ease: 'slab' });
  /* THE DECK VISIBLY HANGS (jury r10, industry #1: "no chain hoists, no
     drop lines — any rigger laughs this off the floor"): five hoist drops
     from the truss chords to the deck header, hoist body at the top */
  for (const hx of [-16, -8, 0, 8, 16]) {
    put(bo, bx(0.22, 11.6, 0.22, M.dark, hx, 17.2, -hd + 2.2), { st: 0.27, w: .06 });
    put(bo, bx(0.9, 1.25, 0.9, M.silver, hx, 22.7, -hd + 2.2), { st: 0.26, w: .06 });
  }
  /* soffit: ~90 gold fins under the deck — the corduroy ceiling the low
     camera looks straight up into. aHalf stripped: sub-0.2ft members turn
     into z-fight comb teeth under the edge-ink shader (jury r10, DP) */
  const finGeo = boxGeo(0.14, 0.45, 14.2);
  finGeo.deleteAttribute('aHalf');
  put(bo, finArray(90, finGeo, M.gold, (d, i) => {
    d.position.set(-hw + 0.6 + i * (W - 1.2) / 89, 10.3, -hd + 7.5);
  }), { st: 0.46, w: .14, dy: -3, ease: 'panel' });
  /* continuous folded balustrade plate (no pickets) + glass return */
  put(bo, bx(W, 3.4, 0.22, M.alu, 0, 13.4, -hd + 14.9), { st: 0.40, w: .10 });
  put(bo, bx(0.22, 3.4, 14.6, M.alu, -hw + 0.11, 13.4, -hd + 7.5), { st: 0.43, w: .08 });
  put(bo, bx(0.22, 3.4, 14.6, M.alu, hw - 0.11, 13.4, -hd + 7.5), { st: 0.43, w: .08 });
  put(bo, bx(W + 0.4, 0.3, 0.5, M.gold, 0, 15.2, -hd + 15), { st: 0.52, w: .08 });
  /* glass strip above the plate so the deck reads occupiable */
  put(bo, bx(W - 0.6, 1.7, 0.14, M.glass, 0, 16.1, -hd + 14.9), { showOnly: true });
  /* glass floor panel at the cantilever tip (showOnly, with a visitor) */
  put(bo, bx(6, 0.18, 6, M.glass, 8, 11.5, -hd + 12.5), { showOnly: true });
  /* folded-plate stair: 10 zig-zag treads, now with a visible stringer
     and a gold handrail (jury r10, industry: "floating treads, no
     stringer, no handrail — fire marshal laughs this off the floor") */
  for (let i = 0; i < 10; i++) {
    put(bo, bx(4.4, 0.28, 1.35, M.alu, hw - 3.4, 1.1 * (i + 1) - 0.1, hd - 2.2 - i * 1.28),
      { st: 0.34 + i * 0.012, w: .07 });
    put(bo, bx(4.4, 1.1, 0.24, M.alu, hw - 3.4, 1.1 * (i + 0.5), hd - 2.85 - i * 1.28),
      { st: 0.34 + i * 0.012, w: .07 });
  }
  {
    const strAng = -Math.atan2(11.5, 11.0);
    const stringer = bx(0.4, 17.2, 1.0, M.charcoal, hw - 5.45, 6.0, hd - 8.0);
    stringer.rotation.x = strAng;
    put(bo, stringer, { st: 0.33, w: .08 });
    const rail = bx(0.14, 17.4, 0.14, M.gold, hw - 1.35, 9.2, hd - 8.0);
    rail.rotation.x = strAng;
    put(bo, rail, { st: 0.45, w: .07 });
  }
  put(bo, bx(0.4, 0.9, 12.4, M.gold, hw - 1.3, 12.1, hd - 8.2), { st: 0.50, w: .08 });
  /* under-deck: reception counter + SEG banner + plinths */
  put(bo, counterK1(9), -4, 0.6, hd - 4, { st: 0.58, w: .10 });
  put(bo, plinthK2(3.6), -14, 0.6, hd - 6, { st: 0.62, w: .08 });
  put(bo, plinthK2(2.8), -10.5, 0.6, hd - 5, { st: 0.64, w: .08 });
  const seg = lightFace(16, 3.4, M.teal);
  seg.position.set(-2, 6.2, -hd + 0.9);
  put(bo, seg, { st: 0.72, w: .10 });
  /* fascia sign on the deck face */
  const fascia = lightbox(18, 2.1, 'LVTSR · C1006');
  fascia.position.set(0, 12.9, -hd + 15.05);
  put(bo, fascia, { st: 0.66, w: .10 });
  /* upstairs furniture silhouettes + attendee (showOnly) */
  put(bo, bx(6, 1.1, 2.4, M.navy7, -8, 12, -hd + 6), { showOnly: true });
  /* practicals: warm pool at the counter, cool wash under the deck */
  practical(bo, 0xffd9a0, 2.6, 16, -4, 8.5, hd - 4);
  practical(bo, 0x9fd4f2, 1.6, 18, 4, 9.5, -hd + 7);
  standHalo(bo, 0xc8a96a, W, Dp, 0.30);
  /* ---- the crew and their machines (gear — pulled before doors) ---- */
  put(bo, crateK7(7, 4, 7.5, 'C1006 · 6 OF 14'), hw - 5, 0, hd + 3.4, { st: 0.03, w: .05, gear: true });
  put(bo, crateK7(5, 3.4, 4.5, 'LVTSR · EMPTY'), -hw - 2.5, 0, hd - 1, { st: 0.20, w: .08, gear: true, ry: 0.3 });
  put(bo, forkliftK11(), -hw + 6, 0, hd + 2.6, { st: 0.26, w: .10, gear: true, ry: -0.5 });
  put(bo, scissorLift(9), -2, 0, -hd + 5.4, { st: 0.40, w: .10, gear: true, ry: 0.2 });
  put(bo, carpetRoll(), hw + 1.5, 0.8, hd + 1.2, { st: 0.05, w: .06, gear: true, ry: 1.35 });
  put(bo, workLight(), 10, 0, hd + 1.8, { st: 0.06, w: .05, gear: true, ry: -2.6 });
  put(bo, cautionTape(W * 0.72), -3, 1.05, hd + 2.3, { st: 0.12, w: .06, gear: true });
  put(bo, gangBox(), -hw + 1.6, 0, hd + 3.3, { st: 0.08, w: .06, gear: true, ry: 0.2 });
}

function booth2(bo) {           /* C3042 — THE OPERATIONS DRUM. 40x20 command hub */
  const W = 40, Dp = 20, hd = Dp / 2;
  const R = 11.6;
  put(bo, blob(15, 13, -4, 0, .5), null, 0, 0, { st: 0.02, w: .04, dy: 0 });
  put(bo, bx(W, 0.4, Dp, M.charcoal, 0, 0.2, 0), { st: 0.04, w: .08 });
  /* the drum: louvre rings sliced 100 degrees open toward the aisle,
     grouped 3-1-3-1 with double gaps (rhythm, not a venetian blind),
     every 5th ring gold, spiral offset capped at i*0.03 */
  const ringGeo = new THREE.CylinderGeometry(R, R, 0.22, 48, 1, true,
    Math.PI * 0.28, Math.PI * 1.44);
  const lys = []; let ly = 1.1, lg = 0;
  while (ly < 12.9) {
    const run = (lg % 2 === 0) ? 3 : 1;
    for (let k = 0; k < run && ly < 12.9; k++) { lys.push(ly); ly += 0.52; }
    ly += 0.78; lg++;
  }
  const lDark = [], lGold = [];
  lys.forEach((y, i) => ((i % 5 === 4) ? lGold : lDark).push([y, i]));
  const louvres = finArray(lDark.length, ringGeo, M.charcoal, (d, i) => {
    d.position.set(-4, lDark[i][0], 0); d.rotation.y = lDark[i][1] * 0.03;
  });
  louvres.material.side = THREE.DoubleSide;
  put(bo, louvres, { st: 0.10, w: .22 });
  const goldRingMat = M.gold.clone(); goldRingMat.side = THREE.DoubleSide;
  put(bo, finArray(lGold.length, ringGeo, goldRingMat, (d, i) => {
    d.position.set(-4, lGold[i][0], 0); d.rotation.y = lGold[i][1] * 0.03;
  }), { st: 0.14, w: .20 });
  /* drum cap ring + three legs up to the halo */
  put(bo, tubeRing(R + 0.3, 0.28, M.alu), null, 0, 0, {
    st: 0.34, w: .08 }).position.set(-4, 13.6, 0);
  bo.parts[bo.parts.length - 1].rest.p.set(-4, 13.6, 0);
  bo.parts[bo.parts.length - 1].obj.rotation.x = Math.PI / 2;
  bo.parts[bo.parts.length - 1].rest.rx = Math.PI / 2;
  /* three full-height GOLD BLADE FINS carry the halo — the toothpick legs
     and their hanger wires are dead (decree: fins are structure AND the
     brand's gold statement; radial, floor to ring) */
  for (const a of [0.4, 2.5, 4.6]) {
    const fin = bx(2.4, 19.4, 0.42, M.gold,
      -4 + Math.cos(a) * (R - 0.2), 9.7, Math.sin(a) * (R - 0.2));
    fin.rotation.y = -a;
    put(bo, fin, { st: 0.30 + a * 0.02, w: .10 });
  }
  /* THE MACHINED HALO — straightened (the 8-degree tilt read as an
     accident, not a design): charcoal torus with an inset emissive
     channel running its underside */
  const halo = tubeRing(13, 0.55, M.charcoal);
  halo.rotation.x = Math.PI / 2;
  put(bo, halo, null, 0, 0, { st: 0.44, w: .10, dy: -8, ease: 'slab' });
  halo.position.set(-4, 19, 0); bo.parts[bo.parts.length - 1].rest.p.set(-4, 19, 0);
  const haloGlow = tubeRing(12.85, 0.14, new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.5, 1.9, 2.6), fog: false }));
  haloGlow.rotation.x = Math.PI / 2;
  put(bo, haloGlow, null, 0, 0, { st: 0.80, w: .10, dy: -2, ease: 'bolt' });
  haloGlow.position.set(-4, 18.55, 0); bo.parts[bo.parts.length - 1].rest.p.set(-4, 18.55, 0);
  /* the 360-degree LED ribbon inside the drum — content runs all the way
     around with no seam (the "how did they do that" of this stand) */
  const ribbonTex = state.ledTex.clone(); state.ledClones.push([ribbonTex, 0.03]);
  ribbonTex.wrapS = THREE.RepeatWrapping;
  ribbonTex.repeat.set(3, 0.25);
  const ribbon = new THREE.Mesh(
    new THREE.CylinderGeometry(R - 1.2, R - 1.2, 2.6, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: ribbonTex, side: THREE.DoubleSide,
      color: new THREE.Color(1.5, 1.5, 1.6), fog: false }));
  put(bo, ribbon, null, 0, 0, { st: 0.74, w: .10 });
  ribbon.position.set(-4, 8.4, 0); bo.parts[bo.parts.length - 1].rest.p.set(-4, 8.4, 0);
  /* standoff arms tie the ribbon back to the louvre shell */
  put(bo, finArray(8, boxGeo(0.14, 0.14, 1.3), M.dark, (d, i2) => {
    const a2 = i2 * Math.PI / 4;
    d.position.set(-4 + Math.cos(a2) * (R - 0.6), 8.4, Math.sin(a2) * (R - 0.6));
    d.rotation.y = -a2;
  }), { st: 0.72, w: .08 });
  /* the floor is a live plan of THIS hall — an 18ft glowing disc read
     from directly overhead at exactly the moment the camera is overhead */
  const planDisc = new THREE.Mesh(new THREE.CircleGeometry(8.6, 48),
    new THREE.MeshBasicMaterial({ map: makeMiniPlan(), transparent: true,
      opacity: 0.92, fog: false }));
  planDisc.rotation.x = -Math.PI / 2;
  put(bo, planDisc, null, 0, 0, { st: 0.62, w: .12 });
  planDisc.position.set(-4, 0.48, 0); bo.parts[bo.parts.length - 1].rest.p.set(-4, 0.48, 0);
  /* THE HEART: a 12ft four-sided LED totem rising off the plan disc —
     the drum finally has something to protect */
  const totemTex = state.ledTex.clone(); state.ledClones.push([totemTex, 0.008]);
  totemTex.repeat.set(0.2, 0.18); totemTex.offset.set(0.06, 0.04);
  const totem = new THREE.Group();
  totem.add(bx(2.3, 12, 2.3, M.charcoal, 0, 6, 0));
  const tMat = new THREE.MeshBasicMaterial({ map: totemTex,
    color: new THREE.Color(1.6, 1.6, 1.7), fog: false });
  for (let f = 0; f < 4; f++) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 11.4), tMat);
    pl.rotation.y = f * Math.PI / 2;
    pl.position.set(Math.sin(f * Math.PI / 2) * 1.18, 6.2, Math.cos(f * Math.PI / 2) * 1.18);
    totem.add(pl);
  }
  put(bo, totem, null, 0, 0, { st: 0.66, w: .10 });
  totem.position.set(-4, 0.45, 0); bo.parts[bo.parts.length - 1].rest.p.set(-4, 0.45, 0);
  /* ops crescent: three angled counters facing the plan disc */
  put(bo, counterK1(7), -11, 0.4, 5.5, { st: 0.52, w: .08, ry: 0.7 });
  put(bo, counterK1(7), 3, 0.4, 5.5, { st: 0.55, w: .08, ry: -0.7 });
  put(bo, counterK1(6), -4, 0.4, -8, { st: 0.58, w: .08, ry: Math.PI });
  /* the mast: 28ft blade sign at the back corner */
  put(bo, bx(0.8, 28, 2.2, M.charcoal, 16.5, 14, -hd + 1.6), { st: 0.22, w: .10 });
  const blade = lightbox(2.0, 9, 'LVTSR · CONTROL');
  blade.rotation.y = Math.PI / 2;
  put(bo, blade, null, 0, 0, { st: 0.78, w: .08 });
  blade.position.set(16.4, 22, -hd + 1.6); bo.parts[bo.parts.length - 1].rest.p.set(16.4, 22, -hd + 1.6);
  /* practicals: the ribbon lights the drum floor; halo throws teal down */
  practical(bo, 0x59c8ea, 2.8, 20, -4, 9, 0);
  practical(bo, 0xffd9a0, 1.8, 14, -4, 4, 6);
  standHalo(bo, 0x59b8d8, W, Dp, 0.30);
  /* gear: this is the coordination job — lead + floor manager, light kit */
  put(bo, crateK7(6, 3.6, 5, 'EAC · C3042'), 13, 0, hd + 2.8, { st: 0.05, w: .06, gear: true, ry: -0.25 });
  put(bo, gangBox(), -14, 0, hd + 3, { st: 0.08, w: .06, gear: true, ry: 0.4 });
  put(bo, workLight(), 6, 0, hd + 2, { st: 0.06, w: .05, gear: true, ry: 2.9 });
}

function booth3(bo) {           /* C5020 — THE FOLDED CANYON. 60x20 custom LED */
  const W = 59.8, Dp = 20, hw = W / 2, hd = Dp / 2;
  put(bo, blob(hw * 1.08, hd * 1.3, 0, 0, .5), null, 0, 0, { st: 0.02, w: .04, dy: 0 });
  put(bo, bx(W, 0.4, Dp, M.charcoal, 0, 0.2, 0), { st: 0.04, w: .08 });
  /* THE CANYON: two opposing faceted LED cliffs with a walkable slot.
     Content shears across the folds; the far end caps in hot white so
     forced perspective reads 60ft deep from the aisle. */
  if (!state.cliffTex) state.cliffTex = makeCliffAtlas();
  const cliffTexA = state.cliffTex.clone(); cliffTexA.repeat.set(1.5, 0.5); state.ledClones.push([cliffTexA, 0.018]);
  const cliffTexB = state.cliffTex.clone(); cliffTexB.repeat.set(1.2, 0.5); state.ledClones.push([cliffTexB, -0.014]);
  cliffTexB.offset.x = 0.37;
  /* two-band texture: paint flips test card <-> supergraphic at 14:00 */
  cliffTexA.userData.twoFrame = true; cliffTexB.userData.twoFrame = true;
  cliffTexA.offset.y = 0.5; cliffTexB.offset.y = 0.5;
  const backCliff = new THREE.Mesh(facetWall(W - 4, 15, 14, 0.30, true),
    new THREE.MeshBasicMaterial({ map: cliffTexA,
      color: new THREE.Color(2.1, 2.1, 2.2), fog: false }));
  put(bo, backCliff, null, 0, 0, { st: 0.30, w: .18 });
  backCliff.position.set(0, 0, -hd + 1.6); bo.parts[bo.parts.length - 1].rest.p.set(0, 0, -hd + 1.6);
  /* second row: full-length now (the shed is dead — the canyon owns the
     whole stand) and leaning 10 degrees INTO the slot, so the walls
     converge overhead and the slot reads as a real crevice */
  const frontCliff = new THREE.Mesh(facetWall(W - 10, 11, 10, 0.26, true),
    new THREE.MeshBasicMaterial({ map: cliffTexB, side: THREE.DoubleSide,
      color: new THREE.Color(1.9, 1.9, 2.0), fog: false }));
  put(bo, frontCliff, null, 0, 0, { st: 0.42, w: .16 });
  frontCliff.position.set(-1, 0, hd - 7);
  frontCliff.rotation.x = -0.175;
  const fcp = bo.parts[bo.parts.length - 1];
  fcp.rest.p.set(-1, 0, hd - 7); fcp.rest.rx = -0.175;
  /* cliff structure: posts + spines so the panels read as BUILT */
  put(bo, finArray(8, boxGeo(0.5, 15.5, 0.9), M.charcoal, (d, i) => {
    d.position.set(-(W - 4) / 2 + i * (W - 4) / 7, 7.75, -hd + 0.9);
  }), { st: 0.24, w: .10 });
  put(bo, finArray(6, boxGeo(0.5, 11.5, 0.9), M.charcoal, (d, i) => {
    d.position.set(-1 - (W - 10) / 2 + i * (W - 10) / 5, 5.75, hd - 5.9);
    d.rotation.x = -0.175;
  }), { st: 0.38, w: .10 });
  /* emissive strips at both cliff feet: the light source the mirror floor
     doubles (decree item C5020 — "strips feed the mirror floor") */
  const stripMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.0, 1.82, 1.42), fog: false, toneMapped: false });
  put(bo, bx(W - 6, 0.22, 0.34, stripMat, 0, 0.32, -hd + 2.35), { st: 0.78, w: .08 });
  put(bo, bx(W - 12, 0.22, 0.34, stripMat, -1, 0.32, hd - 7.95), { st: 0.82, w: .08 });
  /* the white end-cap blade — 26ft, the tallest thing on the stand */
  put(bo, bx(1.1, 26, 12, M.charcoal, -hw + 1.8, 13, -hd + 7.2), { st: 0.50, w: .10 });
  const capGlow = lightFace(7, 15, new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.7, 1.75, 1.85), fog: false }), false);
  capGlow.rotation.y = Math.PI / 2;
  put(bo, capGlow, null, 0, 0, { st: 0.82, w: .10 });
  capGlow.position.set(-hw + 2.5, 12, -hd + 7.2);
  bo.parts[bo.parts.length - 1].rest.p.set(-hw + 2.5, 12, -hd + 7.2);
  /* slot floor: mirror sheen + light pools between the cliffs */
  put(bo, mirrorPlane(W - 12, 13, M.navy9, -1, 0, 0, 0.5), null, 0, 0, { st: 0.86, w: .08, dy: 0 });
  put(bo, pool(0x77c8f0, 26, 5, -2, -1, .30), null, 0, 0, { st: 0.88, w: .08, dy: 0 });
  /* the shed is dead (decree: "dies unconditionally"). The stand IS the
     canyon — a lit slot between two converging LED cliffs. The sign moves
     to the end-cap blade. */
  const pavSign = lightbox(7.5, 1.5, 'C5020 · LVTSR');
  pavSign.rotation.y = Math.PI / 2;
  put(bo, pavSign, null, 0, 0, { st: 0.74, w: .08 });
  pavSign.position.set(-hw + 2.6, 20.5, -hd + 7.2);
  bo.parts[bo.parts.length - 1].rest.p.set(-hw + 2.6, 20.5, -hd + 7.2);
  practical(bo, 0x86d4f2, 3.2, 24, -6, 8, 0);
  practical(bo, 0xa8d8f0, 2.4, 20, 14, 7, -1);
  standHalo(bo, 0x6ec0e8, W, Dp, 0.32);
  /* gear: the LED install in progress */
  put(bo, crateK7(6, 4, 5.5, 'LED 500 × 500 CABS'), -hw + 8, 0, hd + 3, { st: 0.05, w: .06, gear: true, ry: 0.2 });
  put(bo, crateK7(6, 4, 5.5, 'LED 500 × 500 CABS'), -hw + 15, 0, hd + 3.4, { st: 0.10, w: .06, gear: true, ry: -0.15 });
  put(bo, crateK7(5, 3.2, 4, 'PROCESSOR RACK'), 4, 0, hd + 2.6, { st: 0.16, w: .06, gear: true, ry: 0.35 });
  put(bo, scissorLift(11), -12, 0, -hd + 6, { st: 0.34, w: .10, gear: true, ry: 0.15 });
  put(bo, workLight(), -hw + 4, 0, hd + 1.6, { st: 0.06, w: .05, gear: true, ry: -2.4 });
  put(bo, carpetRoll(), hw - 3, 0.8, hd + 2.2, { st: 0.08, w: .06, gear: true, ry: 1.5 });
}

function booth4(bo) {           /* C7050 — THE DEPLOYABLE. 20x20 emergency */
  const W = 19.8, hw = W / 2, hd = hw;
  put(bo, blob(hw * 1.3, hw * 1.3, 0, 0, .55), null, 0, 0, { st: 0.02, w: .04, dy: 0 });
  /* the case floor: a road-case bottom, silver corner castings */
  put(bo, bx(W, 1.1, W, M.charcoal, 0, 0.55, 0), { st: 0.05, w: .08 });
  for (const c of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]])
    put(bo, bx(1.1, 1.4, 1.1, M.silver, c[0] * 0.96, 0.7, c[1] * 0.96), { st: 0.08, w: .06 });
  /* FOUR WALL PANELS UNFOLDED FLAT — the case has burst open into a
     flower: black shells down, amber inner linings up, glowing aprons on
     all four sides. Read from the steep camera it is unmistakable. */
  /* the case shows its own assembly instructions (decree: its one great
     idea) — a thin amber schematic glows out of near-black lining instead
     of the flat orange tabletop the owner hated */
  const schemTex = canvasTex(512, 256, (g) => {
    g.fillStyle = '#0a0705'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = 'rgba(230,160,70,.85)'; g.lineWidth = 2;
    g.strokeRect(24, 22, 200, 130);
    g.strokeRect(48, 44, 152, 86);
    g.beginPath(); g.moveTo(250, 90); g.lineTo(300, 90); g.lineTo(292, 82);
    g.moveTo(300, 90); g.lineTo(292, 98); g.stroke();
    g.strokeRect(330, 30, 40, 120);
    for (let yy = 40; yy < 140; yy += 22) {
      g.beginPath(); g.moveTo(330, yy); g.lineTo(370, yy + 14);
      g.moveTo(370, yy); g.lineTo(330, yy + 14); g.stroke();
    }
    g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(24, 190); g.lineTo(488, 190); g.stroke();
    g.setLineDash([]);
    g.font = '700 16px "Segoe UI", monospace';
    g.fillStyle = 'rgba(230,160,70,.9)';
    g.fillText('C7050 · RAPID DEPLOY · PANEL B', 24, 232);
    g.fillText('16FT', 390, 96);
    g.strokeRect(400, 170, 88, 10);
  });
  const apronMat = new THREE.MeshStandardMaterial({
    color: 0x0c0906, roughness: .6, metalness: .08,
    emissive: 0xffb050, emissiveIntensity: 0.8, emissiveMap: schemTex });
  [[0, -1, 0], [0, 1, Math.PI], [-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2]].forEach((side, i) => {
    const hinge = new THREE.Group();
    const panel = new THREE.Group();
    panel.add(bx(W - 1.6, 9.4, 0.7, M.charcoal, 0, 4.7, 0.4));
    panel.add(bx(W - 2.8, 8.2, 0.2, apronMat, 0, 4.6, 0.02));
    panel.add(bx(W - 3.6, 0.4, 0.34, M.silver, 0, 8.9, 0.22));
    /* road-case DNA: aluminium edge extrusions, ball corners, latches */
    for (const sSide of [-1, 1]) {
      panel.add(bx(0.34, 9.4, 0.8, M.alu, sSide * (W / 2 - 1.0), 4.7, 0.4));
      panel.add(bx(0.9, 0.9, 0.95, M.silver, sSide * (W / 2 - 1.05), 9.0, 0.42));
      panel.add(bx(1.15, 0.75, 0.5, M.silver, sSide * (W / 2 - 4.4), 8.75, 0.68));
    }
    hinge.add(panel);
    hinge.rotation.y = side[2];
    panel.rotation.x = Math.PI / 2 - 0.06;   /* fully open, faces up */
    hinge.position.set(side[0] * (hw - 0.5), 0.9, side[1] * (hd - 0.5));
    put(bo, hinge, { st: 0.16 + i * 0.05, w: .10 });
  });
  /* the lid, lifted 16ft on four scissor masts (thick enough to read) */
  for (const c of [[-hw + 2.2, -hd + 2.2], [hw - 2.2, -hd + 2.2], [-hw + 2.2, hd - 2.2], [hw - 2.2, hd - 2.2]]) {
    const mast = new THREE.Group();
    for (let s2 = 0; s2 < 5; s2++) {
      /* dark steel, slimmer members with silver pin blocks — the bright
         silver X-planks read as cartoon lattice in every dwell frame */
      const a = bx(0.3, 4.4, 0.3, M.charcoal, 0, 1.8 + s2 * 3.1, 0);
      a.rotation.z = 0.48;
      const b2 = a.clone(); b2.rotation.z = -0.48;
      mast.add(a, b2);
      mast.add(bx(0.44, 0.44, 0.44, M.silver, 0, 1.8 + s2 * 3.1 + 1.55, 0));
    }
    mast.position.set(c[0], 0.8, c[1]);
    put(bo, mast, { st: 0.36, w: .12 });
  }
  put(bo, bx(W + 0.8, 1.2, W + 0.8, M.charcoal, 0, 16.6, 0), { st: 0.46, w: .12, dy: -10, ease: 'slab' });
  for (const c of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]])
    put(bo, bx(1.2, 1.5, 1.2, M.silver, c[0] * 0.98, 16.6, c[1] * 0.98), { st: 0.52, w: .08 });
  /* the 24HR RESCUE lightbox hangs off the lid face */
  const box = lightbox(11, 2.4, 'BOOTH DOWN? · 24HR RESCUE');
  box.position.set(0, 14.6, hd + 0.6);
  put(bo, box, { st: 0.62, w: .10 });
  /* amber beacons on two lid corners */
  for (const c of [[-hw + 1, -hd + 1], [hw - 1, hd - 1]]) {
    put(bo, bx(0.5, 1.8, 0.5, M.silver, c[0], 18, c[1]), { st: 0.58, w: .06 });
    put(bo, glowSprite2(0xffa030, 3.2, c[0], 19.2, c[1], .7), null, 0, 0, { st: 0.66, w: .08, dy: 0 });
  }
  /* inside: tool wall + counters in the amber glow */
  put(bo, counterK1(6), 0, 0.9, -2, { st: 0.44, w: .08 });
  put(bo, bx(5, 6.5, 0.5, M.navy7, -hw + 3.4, 4.3, -hd + 1.6), { st: 0.40, w: .08 });
  put(bo, pool(0xff9a28, 12, 12, 0, 0, .34), null, 0, 0, { st: 0.72, w: .10, dy: 0 });
  practical(bo, 0xff9a28, 3.4, 18, 0, 7, 0);
  standHalo(bo, 0xd88a3c, W, W, 0.34);
  /* rapid crew — three hands, minimum call */
  put(bo, gangBox(), hw + 1.8, 0, -2, { st: 0.06, w: .06, gear: true, ry: -1.2 });
  put(bo, workLight(), -4, 0, hd + 1.5, { st: 0.05, w: .05, gear: true, ry: 2.5 });
}

/* a live miniature of THIS hall for the ops drum floor — grid, aisles,
   four gold stands */
function makeMiniPlan() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#0a1420'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(90,160,200,0.5)'; g.lineWidth = 1;
    for (let i = 16; i < 256; i += 24) {
      g.beginPath(); g.moveTo(i, 12); g.lineTo(i, 244); g.stroke();
      g.beginPath(); g.moveTo(12, i); g.lineTo(244, i); g.stroke();
    }
    g.strokeStyle = 'rgba(120,200,240,0.8)'; g.lineWidth = 2;
    g.strokeRect(10, 10, 236, 236);
    g.fillStyle = '#d4b978';
    g.fillRect(30, 28, 42, 20); g.fillRect(172, 84, 44, 22);
    g.fillRect(88, 138, 62, 22); g.fillRect(198, 190, 24, 24);
    g.fillStyle = 'rgba(255,240,200,0.9)';
    g.font = 'bold 13px system-ui';
    g.fillText('HALL C · LIVE', 86, 22);
  });
}

/* ================= the reveal rig ================= */
/* Physical cause for the materialize: a gold survey frame marks the empty
   footprint, a shock ring answers the strike, and a printer-head light bar
   rides the solid front so the fill has a visible machine doing it. */
function buildRevealRig(bo, W, Dp, H) {
  const g = new THREE.Group();
  g.visible = false;
  bo.group.add(g);
  const hw = W / 2, hd = Dp / 2;
  const goldHDR = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.2, 1.85, 1.05), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  /* the survey frame DRAWS ITSELF with the laser lap — four bars igniting
     in sequence around the perimeter, each growing from its corner. The
     cause and the mark are one event now (the exploding ring is dead). */
  const frame = new THREE.Group();
  const fb = [
    { m: bx(W + 0.6, 0.05, 0.22, goldHDR, 0, 0.06, hd + 0.2), axis: 'x', len: W + 0.6, dir: 1 },
    { m: bx(0.22, 0.05, Dp + 0.6, goldHDR, hw + 0.2, 0.06, 0), axis: 'z', len: Dp + 0.6, dir: -1 },
    { m: bx(W + 0.6, 0.05, 0.22, goldHDR, 0, 0.06, -hd - 0.2), axis: 'x', len: W + 0.6, dir: -1 },
    { m: bx(0.22, 0.05, Dp + 0.6, goldHDR, -hw - 0.2, 0.06, 0), axis: 'z', len: Dp + 0.6, dir: 1 },
  ];
  for (const b2 of fb) { b2.base = b2.m.position[b2.axis]; frame.add(b2.m); }
  g.add(frame);
  /* THE GANTRY: a portal of light that travels the footprint printing the
     booth — two posts, a crossbar, and a soft curtain glow trailing it.
     This is the machine the front follows; the cause is visible. */
  const headMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.6, 1.75, 0.85), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const head = new THREE.Group();
  /* a low print-bar rig: crossbar at knee height + end skids — a machine
     that reads as equipment, not a goal post */
  head.add(bx(W + 2.8, 0.26, 0.26, headMat, 0, 1.15, 0));
  head.add(bx(0.6, 1.15, 0.9, headMat, -hw - 1.2, 0.58, 0));
  head.add(bx(0.6, 1.15, 0.9, headMat, hw + 1.2, 0.58, 0));
  /* the curtain: a faint vertical sheet of light at the print plane */
  const curtain = new THREE.Mesh(new THREE.PlaneGeometry(W + 2.4, 7),
    new THREE.MeshBasicMaterial({ map: glowTex,
      color: new THREE.Color(1.2, 0.8, 0.35), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      side: THREE.DoubleSide }));
  curtain.position.set(0, 3.5, 0);
  head.add(curtain);
  g.add(head);
  bo.rig = { g, frame, frameBars: fb, frameMat: goldHDR, head, headMat,
             curtainMat: curtain.material, hw, hd, H };
}

/* ================= the crowd ================= */
/* 340 attendees in three draw calls (torso / head / legs, instanced).
   Every attendee is a pure function of the show scalar: spawn at the main
   entrance, walk their aisle, pool at one of the four stands — so
   scrubbing the doors chapter streams the public in and out. */
const CROWD_N = 200;
function buildCrowd(plan) {
  const torsoG = new THREE.CapsuleGeometry(0.85, 1.9, 3, 6);
  const headG = new THREE.IcosahedronGeometry(0.55, 0);
  const legsG = new THREE.CylinderGeometry(0.5, 0.42, 2.6, 5);
  const mkMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: .96 });
  const torso = new THREE.InstancedMesh(torsoG, mkMat(0x565a60), CROWD_N);
  const head = new THREE.InstancedMesh(headG, mkMat(0x0c0e12), CROWD_N);
  const legs = new THREE.InstancedMesh(legsG, mkMat(0x12161c), CROWD_N);
  /* clothing palette — flesh lives on the head mesh ONLY, and the tide
     stays NEAR-BLACK even under the doors key (decree: concert
     photography, not pawns — the old values washed tan at 16:00) */
  const civ = [new THREE.Color(0x0b0e11), new THREE.Color(0x10141a),
               new THREE.Color(0x151b22), new THREE.Color(0x1a212a),
               new THREE.Color(0x1e2630), new THREE.Color(0x3a2026)];
  const AISLES = [276, 476, 625, 775, 974, 1124];
  /* pool on the AISLE side of each stand, never inside the footprint */
  const STANDS = [[302, 282], [1199, 656], [700, 952], [1326, 1104]];
  const agents = [];
  for (let i = 0; i < CROWD_N; i++) {
    const h = hash01(i + 3), h2 = hash01(i + 211), h3 = hash01(i + 977);
    const stand = h3 < 0.88 ? STANDS[i % 4] : null;
    /* golden-angle spiral around the pool point — deterministic spacing,
       no merged blobs, no physics */
    const spN = Math.floor(i / 4), spA = spN * 2.399963;
    const spR = 4.5 + 5.0 * Math.sqrt(spN);
    const aisleY = stand
      ? AISLES.reduce((a2, b2) => Math.abs(b2 - stand[1]) < Math.abs(a2 - stand[1]) ? b2 : a2)
      : AISLES[Math.floor(h2 * AISLES.length)];
    const spawnX = 570 + h * 470;
    const lane = aisleY + (hash01(i + 431) - 0.5) * 30;
    const tx = stand ? stand[0] + Math.cos(spA) * spR * 1.7 : 250 + h2 * 1100;
    const ty = stand ? stand[1] + Math.sin(spA) * spR * 0.85 : aisleY + (h3 - 0.5) * 18;
    agents.push({
      spawnT: h2 * 0.85, speed: 0.7 + h * 0.6,
      p0: [spawnX, 1395], p1: [spawnX, lane], p2: [tx, lane], p3: [tx, ty],
      scale: 4.2 + h3 * 1.1,
    });
    /* THE PAYOFF READS: the first 19 figures are the LVTSR crew in gold
       vests (jury r10, industry: "19 crew · 135 person-hours deserves a
       visible crew, not a zombie mob") — early spawns, pooled at stands */
    if (i < 19) {
      agents[i].spawnT = 0.04 + (i / 19) * 0.18;
      torso.setColorAt(i, new THREE.Color(0xc9a54e));
    } else {
      torso.setColorAt(i, civ[i % civ.length]);
    }
  }
  torso.instanceColor.needsUpdate = true;
  for (const m of [torso, head, legs]) { m.frustumCulled = false; plan.add(m); }
  state.crowd = { torso, head, legs, agents, dummy: new THREE.Object3D(), last: -1 };
}
function updateCrowd(show) {
  const c = state.crowd;
  if (!c || show === c.last) return;
  c.last = show;
  const d = c.dummy;
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 0; i < CROWD_N; i++) {
    const a = c.agents[i];
    const t = Math.min(1, Math.max(0, (show - a.spawnT) / 0.55)) * a.speed;
    if (t <= 0.001) {
      d.position.set(0, 0, -999); d.scale.setScalar(0.001);
    } else {
      const u = Math.min(1, t);
      /* three-leg walk: south gate -> up the hall -> along the aisle -> pool */
      const leg = u < 0.45 ? lerp2(a.p0, a.p1, u / 0.45)
        : u < 0.8 ? lerp2(a.p1, a.p2, (u - 0.45) / 0.35)
        : lerp2(a.p2, a.p3, (u - 0.8) / 0.2);
      d.position.set(leg[0], leg[1], 0);
      d.scale.setScalar(a.scale);
    }
    d.rotation.set(Math.PI / 2, 0, 0);   /* capsule y-axis -> plan z (up) */
    const s = d.scale.x;
    d.position.z = 3.6 * s;              /* chest height, model-ft x scale */
    d.updateMatrix();
    c.torso.setMatrixAt(i, d.matrix);
    d.position.z = 5.6 * s;
    d.updateMatrix(); c.head.setMatrixAt(i, d.matrix);
    d.position.z = 1.35 * s;
    d.updateMatrix(); c.legs.setMatrixAt(i, d.matrix);
  }
  c.torso.instanceMatrix.needsUpdate = true;
  c.head.instanceMatrix.needsUpdate = true;
  c.legs.instanceMatrix.needsUpdate = true;
}

/* ================= scene ================= */
function init() {
  const mi = window.__MI;
  if (!mi) return false;
  state.narrow = mi.narrow;
  const stage = mi.stage;
  const canvas = document.createElement('canvas');
  canvas.className = 'mi-gl';
  canvas.setAttribute('aria-hidden', 'true');
  stage.insertBefore(canvas, stage.querySelector('.mi-vig'));

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true,
      antialias: false, powerPreference: 'high-performance',
      stencil: false });
  } catch (e) {
    console.warn('mi-gl: WebGL init failed, CSS fallback stays on', e);
    canvas.remove(); return false;
  }
  /* iOS memory pressure kills contexts mid-page: on loss, retire MIGL so
     the page's `window.MIGL ?` guards fall back to the CSS haze rather
     than narrating booths that are not there */
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('mi-gl: WebGL context lost — retiring the booth layer');
    window.MIGL = null;
    canvas.style.display = 'none';
  });
  canvas.addEventListener('webglcontextrestored', () => {
    window.MIGL = MIGL;
    canvas.style.display = '';
  });
  /* tone mapping is OFF at the renderer — the scene renders linear HDR
     into the post RT and the AgX transfer lives in the composite pass */
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  if (!mi.narrow && !location.search.includes('q_noshadow')) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;   /* re-rendered only on state change */
  }
  state.renderer = renderer;
  state.post = new MiPost(renderer);
  /* perf bisect flags (debug): ?q_noao ?q_noshadow ?q_nomsaa */
  if (location.search.includes('q_noao')) { state.post.enableDepth = false; state.post.u.uAOAmt.value = 0; state.post.u.uFogC.value = 0; }
  window.__post = state.post;
  if (mi.narrow) {
    state.post.enableDepth = false;
    state.post.u.uAOAmt.value = 0;
    state.post.u.uFogC.value = 0;
  }

  state.scene = new THREE.Scene();
  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;
  state.camera = camera;

  const plan = new THREE.Group();
  plan.matrixAutoUpdate = false;
  state.scene.add(plan);
  state.plan = plan;

  /* scale-invariant lights only (hemi + directionals have no distance
     falloff), so the zoom baked into the matrices never shifts exposure.
     Round 3 rig (jury: "no key, no fill, no rim — flat mid-navy mush"):
     ~6:1 key-to-fill, warm gold key vs teal ambient/rim, and the rim moved
     ABOVE the horizon so it actually grazes rooflines. */
  const hemi = new THREE.HemisphereLight(0x4a80a8, 0x241a10, 1.0);
  plan.add(hemi);
  const key = new THREE.DirectionalLight(0xffd9a6, 3.2);
  key.position.set(-600, 1800, 1400);   /* plan-space: front-left, high */
  plan.add(key); plan.add(key.target);
  key.target.position.set(800, 760, 0);
  state.keyLight = key;
  key.updateMatrix(); key.target.updateMatrix();
  if (renderer.shadowMap.enabled) {
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0006;           /* NDC — scale-invariant, set once */
  }
  const rim = new THREE.DirectionalLight(0x3fd0ff, 2.0);
  rim.position.set(1400, -1200, 1800);  /* behind-right, HIGH — edge light */
  plan.add(rim); plan.add(rim.target);
  rim.target.position.set(800, 760, 0);
  /* camera-side fill so verticals facing the viewer never fall to black —
     dropped hard so it stops flattening what the key sculpts */
  const fill = new THREE.DirectionalLight(0x9db8d4, 0.5);
  fill.position.set(800, 3000, 700);    /* due south of the hall, mid-high */
  plan.add(fill); plan.add(fill.target);
  fill.target.position.set(800, 700, 0);
  state.lights = { hemi, key, rim, fill,
    base: { hemi: 1.0, key: 3.2, rim: 2.0, fill: 0.5 } };

  /* depth cueing: fog uses view-space depth, and the view here is identity,
     so eye distance = fogDepth + D — monotonic and linear. Near/far are
     rescaled per-frame in syncWorld because zoom is baked into world units.
     Emissives/sprites opt out below: lit things punching through the haze
     while structure recedes IS the depth cue. */
  state.scene.fog = new THREE.Fog(0x060b12, 0, 1);

  /* the shadow catcher: an invisible plane over the whole hall floor that
     multiplies the key's shadow into the alpha channel — so the booths
     cast REAL contact shadows onto the CSS drawing underneath the canvas */
  if (renderer.shadowMap.enabled) {
    const shFloor = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1620),
      new THREE.ShadowMaterial({ opacity: 0.24, color: 0x01030a }));
    shFloor.material.fog = false;
    shFloor.position.set(800, 760, 0.35);
    shFloor.receiveShadow = true;
    plan.add(shFloor);
  }

  glowTex = makeGlowTex();
  blobTex = makeBlobTex();
  makeConeTex();
  /* reflection fade: white at the floor line, black at depth. flipY puts
     canvas row 0 at v=1, and the mirror's scale.y=-1 sends v=1 deepest —
     so row 0 is the dark end. */
  reflFadeTex = canvasTex(4, 64, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, '#000'); gr.addColorStop(0.35, '#333'); gr.addColorStop(1, '#fff');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 64);
  });
  makeTrussTex();
  state.envTex = makeEnvTex(renderer);
  makeMaterials(state.envTex);
  state.ledTex = makeLedAtlas();
  state.ledTex.wrapT = THREE.RepeatWrapping;
  state.ledTex.repeat.set(1, 0.25);
  state.barsTex = makeColorBars();

  /* THE CEILING (jury, twice: "the top half of every frame is untreated
     black nothing — a convention hall has one of the most graphically
     distinctive ceilings in architecture"). Hall-scale, in plan space
     (x east, y south, z up; 1ft = 5 units): four rows of high-bay
     fixtures at ~44ft + three truss runs. Fixtures idle as dim cool
     housings all day and SNAP ON row by row at doors — the house-lights
     beat the payoff frame was missing. */
  const bayZ = 220;
  /* the hall has a LID: a near-black deck above the fixtures, so the top
     of a raked frame is architecture, not void. A faint radial wash keeps
     it off pure black without pulling focus. */
  const lidTex = canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 76, 8, 64, 76, 92);
    gr.addColorStop(0, '#10151c'); gr.addColorStop(1, '#05070b');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
  const lid = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2200),
    new THREE.MeshBasicMaterial({ map: lidTex, fog: false }));
  lid.position.set(800, 700, bayZ + 34);
  lid.rotation.x = Math.PI;         /* face DOWN toward the floor */
  plan.add(lid);
  /* THE ROOF SPACE-FRAME (decree 6): crossed chord runs + catwalks under
     the lid. MeshStandard so the height-graded fog eats it upward — you
     read structure near the fixtures and haze above. */
  const roofZ = bayZ + 18;
  /* near-black steel: the frame reads as silhouette against the lid, not
     as pale beams catching the booth key. NOTHING up here casts shadow —
     a catwalk's 500-unit floor shadow read as a giant dirt wedge (r11). */
  const steelM = new THREE.MeshStandardMaterial({
    color: 0x0b0e13, roughness: 0.92, metalness: 0.2 });
  const noSh = (o) => { o.userData.noShadow = true; return o; };
  plan.add(noSh(finArray(5, boxGeo(2400, 1.2, 1.2), steelM, (d, i) => {
    d.position.set(800, 210 + i * 270, roofZ);
  })));
  plan.add(noSh(finArray(7, boxGeo(1.2, 1900, 1.2), steelM, (d, i) => {
    d.position.set(140 + i * 250, 740, roofZ + 4);
  })));
  /* (chevron lacing deleted — jury r10, industry: "LVCC's grid is
     orthogonal"; the diagonals read as scribbles in every mid-zoom) */
  /* catwalk boxes with one dim service lamp each — PERIMETER ONLY: a
     roof-height box over mid-hall projects into hero frames at the raked
     camera and reads as a giant slab lying on the floor (r11 "wedge") */
  for (const [cwx, cwy] of [[300, 130], [1350, 150], [790, 1470]]) {
    const cw = noSh(new THREE.Mesh(boxGeo(170, 14, 7), steelM));
    cw.position.set(cwx, cwy, roofZ - 8);
    plan.add(cw);
    const lampM = new THREE.SpriteMaterial({ map: glowTex,
      color: new THREE.Color(1.4, 1.1, 0.7), blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, opacity: 0.5 });
    const lamp = new THREE.Sprite(lampM);
    lamp.scale.setScalar(9); lamp.position.set(cwx - 60, cwy, roofZ - 14);
    plan.add(lamp);
  }
  /* THE WALLS: four distant planes at 10-15% brightness — ribbing, a dim
     CENTRAL HALL supergraphic, warm exit slivers. The void dies here. */
  const wallTex = canvasTex(1024, 160, (g) => {
    const wg = g.createLinearGradient(0, 0, 0, 160);
    wg.addColorStop(0, '#05080d'); wg.addColorStop(0.7, '#0b1119');
    wg.addColorStop(1, '#0d141d');
    g.fillStyle = wg; g.fillRect(0, 0, 1024, 160);
    g.fillStyle = 'rgba(150,180,210,.05)';
    for (let x = 0; x < 1024; x += 14) g.fillRect(x, 12, 2, 148);
    g.fillStyle = 'rgba(70,100,130,.16)';
    g.font = '800 64px "Segoe UI", system-ui, sans-serif';
    g.fillText('C E N T R A L   H A L L', 250, 92);
    for (let e = 0; e < 5; e++) {
      g.fillStyle = 'rgba(160,220,170,.5)';
      g.fillRect(90 + e * 210, 128, 14, 5);
      g.fillStyle = 'rgba(255,214,150,.35)';
      g.fillRect(150 + e * 210, 118, 26, 16);
    }
  });
  wallTex.wrapS = THREE.RepeatWrapping;
  const mkWall = (w, x, y, rz) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, bayZ + 40),
      new THREE.MeshBasicMaterial({ map: wallTex, fog: false,
        side: THREE.DoubleSide, color: new THREE.Color(0.55, 0.6, 0.66) }));
    m.rotation.x = Math.PI / 2;
    m.rotation.y = rz;
    m.position.set(x, y, (bayZ + 40) / 2 - 4);
    plan.add(m);
    return m;
  };
  mkWall(2600, 800, -40, 0);
  mkWall(2600, 800, 1560, Math.PI);
  mkWall(2300, -90, 730, Math.PI / 2);
  mkWall(2300, 1690, 730, -Math.PI / 2);
  /* NEIGHBOR MASSING: dark stands under construction ringing the four
     heroes — each a block with one dim warm work lamp. The hall reads
     inhabited without stealing a single beat. */
  /* outer ring only — never inside the hero field, never beside a stand */
  const nbrSpots = [
    [120, 200, 90, 60, 34], [300, 150, 70, 46, 26], [1420, 170, 110, 70, 44],
    [1600, 420, 66, 50, 56], [60, 900, 84, 58, 30], [1620, 1020, 96, 66, 38],
    [200, 1380, 120, 74, 30], [620, 1420, 76, 52, 48], [1060, 1400, 100, 66, 26],
    [1460, 1370, 84, 56, 40], [60, 1240, 60, 44, 22], [1650, 760, 74, 52, 30],
    [60, 520, 66, 46, 42], [900, 150, 64, 44, 30],
  ];
  const nbrLampM = new THREE.SpriteMaterial({ map: glowTex,
    color: new THREE.Color(1.5, 1.2, 0.75), blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, opacity: 0.26 });
  for (const [nx, ny, nw2, nd2, nh2] of nbrSpots) {
    const blkH = nh2;
    const blk = new THREE.Mesh(boxGeo(nw2, nd2, blkH), M.dark);
    blk.position.set(nx, ny, blkH / 2);
    plan.add(blk);
    const cap = new THREE.Mesh(boxGeo(nw2 * 0.4, nd2 * 0.5, blkH * 0.5), steelM);
    cap.position.set(nx + nw2 * 0.22, ny - nd2 * 0.14, blkH + blkH * 0.25);
    plan.add(cap);
    const lamp = new THREE.Sprite(nbrLampM);
    lamp.scale.setScalar(7);
    lamp.position.set(nx - nw2 * 0.3, ny + nd2 * 0.3, blkH + 3);
    plan.add(lamp);
  }
  state.fixtures = [];
  /* six rows: four over the hall, two beyond its north/south edges so the
     booth chapters (which look across the hall) get a lid in their upper
     third instead of void */
  for (let r = 0; r < 4; r++) {
    const y = 240 + r * 350;
    const housingMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.09, 0.11, 0.14), fog: false });
    const spriteMat = new THREE.SpriteMaterial({ map: glowTex,
      color: new THREE.Color(2.6, 2.35, 1.7), blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, opacity: 0 });
    for (let i = 0; i < 6; i++) {
      const x = 190 + i * 250;
      const h = new THREE.Mesh(boxGeo(14, 14, 5), housingMat);
      h.position.set(x, y, bayZ);
      plan.add(h);
      /* suspension stem: the vertical line above the dot is what makes it
         read as HANGING rather than sitting on the floor */
      const stem = new THREE.Mesh(boxGeo(1.6, 1.6, 26), M.dark);
      stem.position.set(x, y, bayZ + 16);
      plan.add(stem);
      /* small hot points, not floating orbs — high-bays at 44ft are dots */
      const sp = new THREE.Sprite(spriteMat);
      sp.scale.setScalar(15); sp.position.set(x, y, bayZ - 5); sp.renderOrder = 3;
      plan.add(sp);
      state.fixtures.push({ parts: [h, stem, sp], x, y, z: bayZ });
    }
    state.houseRows.push({ housingMat, spriteMat,
      base: new THREE.Color(0.16, 0.20, 0.24),
      on: new THREE.Color(0.95, 0.9, 0.72) });   /* the sprite carries the light */
  }
  /* SHADER-CONE SHAFTS (decree 6): one additive ShaderMaterial cone per
     fixture — fresnel-soft silhouette (|view-normal z|), tight hot throat
     flaring to a faint foot, 2-octave angular noise scrolled on idle time,
     depth-fade at the floor. The white paper cone is dead. */
  state.shaftT = { value: 0 };
  const mkShaftMat = () => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
    uniforms: { uOp: { value: 0 }, uT: state.shaftT,
      uCol: { value: new THREE.Color(0.92, 0.97, 1.05) } },
    vertexShader:
      `varying vec3 vN; varying vec3 vP;
       void main() {
         vN = normalMatrix * normal; vP = position;
         gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
       }`,
    fragmentShader:
      `uniform float uOp, uT; uniform vec3 uCol;
       varying vec3 vN; varying vec3 vP;
       void main() {
         float edge = smoothstep(0.04, 0.60, abs(normalize(vN).z));
         float t = clamp(vP.y / 212.0 + 0.5, 0.0, 1.0);
         float ang = atan(vP.x, vP.z);
         float n = 0.72 + 0.18 * sin(ang * 6.0 + uT * 0.4 + vP.y * 0.06)
                        + 0.10 * sin(ang * 13.0 - uT * 0.27);
         float a = uOp * edge * n * (0.20 + 0.95 * pow(t, 1.8));
         a *= smoothstep(0.0, 0.07, t);
         gl_FragColor = vec4(uCol, a);
       }`
  });
  state.shaftMats = [];
  for (let r = 0; r < state.houseRows.length; r++) state.shaftMats.push(mkShaftMat());
  const shaftGeo = new THREE.ConeGeometry(19, bayZ - 8, 18, 1, true);
  state.shaftPools = [];
  for (const f of state.fixtures) {
    const row = Math.round((f.y - 240) / 350);
    if (row < 0 || row > 3) continue;
    const cone = new THREE.Mesh(shaftGeo, state.shaftMats[row]);
    cone.rotation.x = Math.PI / 2;     /* apex up at the fixture */
    cone.position.set(f.x, f.y, (bayZ - 8) / 2);
    cone.renderOrder = 4;
    plan.add(cone);
    f.parts.push(cone);
    const pm = new THREE.MeshBasicMaterial({ map: glowTex,
      color: new THREE.Color(1.15, 1.1, 0.95), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const pool2 = new THREE.Mesh(new THREE.PlaneGeometry(64, 46), pm);
    pool2.position.set(f.x, f.y, 0.7);
    pool2.renderOrder = 2;
    plan.add(pool2);
    f.parts.push(pool2);
    state.shaftPools.push({ m: pm, row });
  }

  /* the house glow: one soft wash over the whole hall floor that rises with
     the doors surge — "lights on" must LIFT the room, not just the booths */
  const houseGlow = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1620),
    new THREE.MeshBasicMaterial({ map: glowTex, color: 0xb8c2c0,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false }));
  houseGlow.position.set(800, 760, 0.8);
  houseGlow.renderOrder = 1;
  plan.add(houseGlow);
  state.houseGlow = houseGlow.material;
  /* (the old truss runs are gone — at hall zoom they read as a smear of
     rust across the horizon; the fixtures + shafts carry the ceiling) */
  /* aisle carpet: three long quads that warm up with the doors surge, so
     the routes between the four stands read as opened to the public */
  for (const ay of [470, 790, 1115, 1345]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1380, 52),
      new THREE.MeshBasicMaterial({ map: glowTex, color: 0x3f96c8,
        transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, fog: false }));
    q.position.set(800, ay, 1.2);
    q.renderOrder = 2;
    plan.add(q);
    state.aisleGlow.push(q.material);
  }

  if (!mi.narrow) buildCrowd(plan);
  /* hall dust: one Points cloud, fixed pixel size (the bespoke projection
     breaks sizeAttenuation), drifting on the idle clock */
  {
    const n = mi.narrow ? 500 : 1300;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pts[i * 3] = 60 + hash01(i) * 1480;
      pts[i * 3 + 1] = 60 + hash01(i + 501) * 1400;
      pts[i * 3 + 2] = 4 + hash01(i + 903) * 150;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const dust = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9fc2dc, size: 1.15, sizeAttenuation: false,
      transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false }));
    dust.frustumCulled = false;
    plan.add(dust);
    state.dust = dust;
  }
  const builders = [booth1, booth2, booth3, booth4];
  mi.WO.forEach((w, i) => {
    const r = w.rect;
    const mount = new THREE.Group();
    mount.matrixAutoUpdate = false;
    /* model ft -> plan units, y-up -> css z-up, model z (south) -> +plan y */
    const s = FT, cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
    mount.matrix.set(
      s, 0, 0, cx,
      0, 0, s, cy,
      0, s, 0, 0,
      0, 0, 0, 1
    );
    plan.add(mount);
    const inner = new THREE.Group();
    mount.add(inner);
    const bo = makeBooth(inner);
    bo.mount = mount;
    bo.dims = { W: r[2] / FT, D: r[3] / FT, H: [30, 28, 26, 22][i] };
    bo.topDown = i === 1;   /* the drum prints top-down */
    builders[i](bo);
    buildRevealRig(bo, bo.dims.W, bo.dims.D, bo.dims.H);
    state.booths.push(bo);
  });
  /* THE FLOOR BECOMES REAL: near-black polished concrete that arrives in
     the gantry's wake and floods the hall at floor release — with a true
     mirrored-world reflection. The blueprint survives where the wet floor
     hasn't reached. */
  {
    const roughTex = canvasTex(1024, 1024, (g) => {
      g.fillStyle = '#808080'; g.fillRect(0, 0, 1024, 1024);
      /* expansion joints on a 20ft module + scuffs — detail lives in
         roughness so it appears only where light finds it */
      g.strokeStyle = '#b8b8b8'; g.lineWidth = 3;
      for (let i = 0; i <= 1024; i += 102) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(1024, i); g.stroke();
      }
      for (let i = 0; i < 260; i++) {
        const x = Math.random() * 1024, y = Math.random() * 1024;
        g.strokeStyle = 'rgba(' + (140 + Math.random() * 60 | 0) + ',' +
          (140 + Math.random() * 60 | 0) + ',' + (140 + Math.random() * 60 | 0) + ',0.5)';
        g.lineWidth = 1 + Math.random() * 2;
        g.beginPath(); g.moveTo(x, y);
        g.lineTo(x + (Math.random() - 0.5) * 90, y + (Math.random() - 0.5) * 24);
        g.stroke();
      }
    });
    roughTex.wrapS = roughTex.wrapT = THREE.RepeatWrapping;
    const wetMat = new THREE.MeshStandardMaterial({
      color: 0x0a0e14, roughness: 0.48, metalness: 0.05,
      roughnessMap: roughTex, transparent: true, depthWrite: false,
      envMap: state.envTex, envMapIntensity: 0.2,
    });
    state.wetU = { value: 0 };
    state.reflU = { value: null };
    state.reflRes = { value: new THREE.Vector2(1, 1) };
    wetMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        uBoothInv: RV.uBoothInv, uGz: RV.uGz, uBandW: RV.uBandW,
        uRevMin: RV.uRevMin, uRevMax: RV.uRevMax, uRevDir: RV.uRevDir,
        uWet: state.wetU, uRefl: state.reflU, uReflRes: state.reflRes,
        uFlat: RV.uFlat,
      });
      sh.vertexShader = 'varying vec3 vBPf;\nuniform mat4 uBoothInv;\n' + sh.vertexShader
        .replace('#include <project_vertex>',
          `#include <project_vertex>
           vBPf = (uBoothInv * (modelMatrix * vec4(transformed, 1.0))).xyz;`);
      sh.fragmentShader = ('varying vec3 vBPf;\n' +
        'uniform float uGz, uBandW, uRevDir, uWet, uFlat;\n' +
        'uniform vec2 uRevMin, uRevMax, uReflRes;\n' +
        'uniform sampler2D uRefl;\n') + sh.fragmentShader
        .replace('#include <dithering_fragment>',
          `#include <dithering_fragment>
           float wGate = step(uRevMin.x, vBPf.x) * step(vBPf.x, uRevMax.x)
                       * step(uRevMin.y, vBPf.z) * step(vBPf.z, uRevMax.y);
           float wAxis = uRevDir > 0.0 ? vBPf.z : 0.0;
           float wSolid = smoothstep(wAxis - uBandW, wAxis + uBandW, uGz);
           /* the gold-ink beat burns against BLACK GLASS: the footprint
              floods dark the moment the drawing pours in (uFlat), so the
              ink doubles in the floor before a single part stands */
           float wCov = clamp(uWet + wGate * max(wSolid, uFlat * 0.92), 0.0, 1.0);
           vec2 rUv = vec2(gl_FragCoord.x / uReflRes.x, 1.0 - gl_FragCoord.y / uReflRes.y);
           vec3 refl = texture2D(uRefl, rUv).rgb;
           /* clamped: HDR screen content mirrored at full strength blew
              out into slabs brighter than the source (r11 p066) */
           gl_FragColor.rgb += min(refl * 0.42, vec3(0.72)) * wCov;
           gl_FragColor.a *= wCov;`);
    };
    const wet = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1620), wetMat);
    wet.position.set(800, 760, 0.5);
    wet.renderOrder = 1;
    /* the catcher plane owns contact shadows; the wet layer receiving the
       key shadow painted a giant textured dirt-wedge across the hall */
    wet.receiveShadow = false;
    plan.add(wet);
    /* UVs tile the roughness on the 20ft module */
    wetMat.roughnessMap.repeat.set(17, 16);
    state.wetFloor = wet;
  }

  /* CREW PRESENCE IS LIGHT NOW, not figures: one roaming work-lamp per
     stand drifts through the footprint on the idle clock — the hall reads
     WORKED without a single close-up capsule person */
  state.roamers = [];
  state.booths.forEach((bo, ri) => {
    const rg = new THREE.Group();
    const rp = pool(0xffd9a0, 4.5, 3.5, 0, 0, .28);
    state.showGlows.pop();
    rg.add(rp);
    bo.group.add(rg);
    state.roamers.push({ g: rg, bo, ph: ri * 1.7,
      rx: bo.dims.W * 0.28, rz: bo.dims.D * 0.22 });
  });

  /* everything unlit-emissive punches THROUGH the fog: screens, halos,
     sprites, signage, blobs, pools. Structure recedes, light does not.
     Same traversal flags the structural family into the shadow pass. */
  state.scene.traverse((o) => {
    const m = o.material;
    if (m && (m.isMeshBasicMaterial || m.isSpriteMaterial)) m.fog = false;
    if (renderer.shadowMap.enabled && o.isMesh && m &&
        m.isMeshStandardMaterial && !m.transparent && !o.userData.noShadow) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
    /* layer 1 = the depth prepass set: opaque geometry only, so sprites
       and glows never write depth into the AO / aerial-perspective pass */
    if (o.isMesh && m && !m.transparent && !m.isSpriteMaterial) o.layers.enable(1);
    /* lights must ALSO live on layer 1: the mirror pass renders with
       camera.layers.set(1), and three filters lights by camera layers —
       without this every standard material renders unlit black in the
       reflection */
    if (o.isLight) o.layers.enable(1);
  });

  /* prewarm every shader program NOW: first-visibility compilation was a
     measured 1-2s hitch exactly when a booth's chapter opened */
  state.booths.forEach(bo => { bo.group.visible = true; });
  syncProjection(state.camera, 1440, 900);
  state.renderer.compile(state.scene, state.camera);
  state.booths.forEach(bo => { bo.group.visible = false; });
  return true;
}

/* world matrix: F · T(o) · Rx(rake) · Rz(yaw) · T(-o) · planToStage.
   F = diag(1,-1,1) flips css y-down into a y-up world ONCE at the top of
   the chain. Without it the mounts' axis swap left an ODD mirror count
   before projection, view-space normals pointed into every surface, and
   both lights shaded the whole build as back-faces (measured: key light
   changes did nothing). With F the mirrors pair up: normals, winding and
   texture text all come out right. The projection's y row is positive to
   match (the flip lives in F, not in the projection). */
const _m = { o: new THREE.Matrix4(), rx: new THREE.Matrix4(), rz: new THREE.Matrix4(),
  no: new THREE.Matrix4(), aff: new THREE.Matrix4(), f: new THREE.Matrix4() };
const _revM = new THREE.Matrix4();
const _flipZ = new THREE.Matrix4().makeScale(1, 1, -1);
const _savedPlan = new THREE.Matrix4();
_m.f.set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
function syncWorld(cam) {
  const { rectW, rectH } = state;
  const ox = WO_ORIGIN.x * rectW, oy = WO_ORIGIN.y * rectH;
  const rake = cam.rake * Math.PI / 180, yaw = cam.yaw * Math.PI / 180;
  const k = cam.s * cam.fit;
  const offX = cam.tx * cam.fit + (rectW - VBW * cam.fit) / 2;
  const offY = cam.ty * cam.fit + (rectH - VBH * cam.fit) / 2;
  _m.o.makeTranslation(ox, oy, 0);
  _m.rx.makeRotationX(rake);
  _m.rz.makeRotationZ(yaw);
  _m.no.makeTranslation(-ox, -oy, 0);
  _m.aff.set(k, 0, 0, offX, 0, k, 0, offY, 0, 0, k, 0, 0, 0, 0, 1);
  state.plan.matrix.copy(_m.f)
    .multiply(_m.o).multiply(_m.rx).multiply(_m.rz).multiply(_m.no).multiply(_m.aff);
  state.plan.matrixWorldNeedsUpdate = true;
  /* fog distances live in world units, and the zoom k is baked into them —
     rescale per frame so the haze never breathes with the chapter zoom.
     (eye distance = fogDepth + D, so near = d0*k - D) */
  if (state.scene.fog) {
    state.scene.fog.near = 1400 * k - D;
    state.scene.fog.far = 5600 * k - D;
  }
  /* aerial perspective params track the zoom exactly like the fog does */
  if (state.post && state.post.enableDepth) {
    state.post.u.uFogK.value = state.projK;
    state.post.u.uFogC.value = state.projC;
    state.post.u.uFogNear.value = 2100 * k;
    state.post.u.uFogFar.value = 5800 * k;
  }
  /* practicals: point-light falloff must not breathe with the zoom — the
     zoom lives in the world matrix, so range and inverse-square intensity
     both rescale by k every frame */
  for (const pr of state.practicals) {
    pr.L.distance = pr.baseD * k;
    pr.L.intensity = pr.baseI * k * k * FT * FT;
  }
  /* shadow frustum tracks the zoom: everything the light sees scales by k,
     so scaling the ortho bounds/near/far by k keeps the CACHED depth map
     valid — the map only re-renders when scene state actually changes */
  const key = state.keyLight;
  if (key && key.castShadow) {
    const sc = key.shadow.camera;
    sc.left = -1800 * k; sc.right = 1800 * k;
    sc.top = 1800 * k; sc.bottom = -1800 * k;
    sc.near = 100 * k; sc.far = 6000 * k;
    sc.updateProjectionMatrix();
    key.shadow.normalBias = 6 * k;       /* world units — must scale */
    /* the light hangs under plan, whose matrix we just rewrote — refresh
       its world matrix by hand so the shadow matrices see THIS frame */
    key.matrixWorld.multiplyMatrices(state.plan.matrix, key.matrix);
    key.target.matrixWorld.multiplyMatrices(state.plan.matrix, key.target.matrix);
    key.shadow.updateMatrices(key);
  }
}
function syncProjection(cam, rectW, rectH) {
  const ox = PO.x * rectW, oy = PO.y * rectH;
  /* nothing renders nearer than ~400 eye units — near 300 buys ~8x depth
     precision across the hall band vs the old 40 */
  const n = 300, f = 6000;
  const A = -(f + n) / (D * (f - n));
  const B = (f + n) / (f - n) - 2 * n * f / (D * (f - n));
  /* the post pipeline reconstructs eye distance from the depth buffer:
     dist = C / (ndc + K), K = A*D, C = D*(A*D + B) */
  state.projK = A * D;
  state.projC = D * (A * D + B);
  cam.projectionMatrix.set(
    2 / rectW, 0, (1 - 2 * ox / rectW) / D, -1,
    0, 2 / rectH, (2 * oy / rectH - 1) / D, 1,
    0, 0, A, B,
    0, 0, -1 / D, 1);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

/* ================= public API ================= */
let ledFrame = -1, curShow = -1, curDay = -1;
const _keyCold = new THREE.Color(0xffd9a6), _keyWarm = new THREE.Color(0xffeccc);
/* the day arc in COLOR, not just intensity (jury: "if you cropped the HUD,
   no juror could order the frames chronologically") — cold blue dawn ->
   neutral noon; fog and hemisphere travel together */
const _fogCold = new THREE.Color(0x020408), _fogNoon = new THREE.Color(0x0a131f);
const _skyCold = new THREE.Color(0x2c4a6a), _skyNoon = new THREE.Color(0x6b93b4);
const _gndCold = new THREE.Color(0x160f08), _gndNoon = new THREE.Color(0x3a2c18);
/* the doors surge pushes both toward warm show-light */
const _fogShow = new THREE.Color(0x121d2c), _skyShow = new THREE.Color(0x8aa4b8);
/* THE LIGHTING SCRIPT — every chapter is a re-lit set with one motivated
   statement. cold: security pools in a dead hall. rise: cold dock light
   arrives. WO1: one hard work light. WO2: cyan/amber cross-key. WO3: the
   LED wall is a 20ft softbox. lapse: the highbays march on. WO4: a dark
   island under one top light. doors: full show light. Values are absolute
   intensities; blending runs across the first 30% of each chapter. */
const LS = [
  { hemi: 0.030, key: 0.25, fill: 0.02, exp: 0.66, kc: 0xffc37a, sl: [0.92, 0.98, 1.10], sat: 0.95, vig: 0.32, hal: 0.05 },
  { hemi: 0.085, key: 2.60, fill: 0.05, exp: 0.84, kc: 0xbfdcff, sl: [0.95, 1.00, 1.08], sat: 1.05, vig: 0.24, hal: 0.08 },
  { hemi: 0.110, key: 3.20, fill: 0.07, exp: 0.98, kc: 0xffe2b0, sl: [1.06, 1.00, 0.94], sat: 1.15, vig: 0.22, hal: 0.11 },
  /* jury r10 (DP): the day must CLIMB — level up ~2 stops and warm from
     dawn-blue toward afternoon-neutral between 08:00 and 14:47, so frames
     order chronologically with the HUD cropped */
  { hemi: 0.130, key: 1.90, fill: 0.06, exp: 1.02, kc: 0xddeaf8, sl: [0.94, 1.02, 1.10], sat: 1.20, vig: 0.26, hal: 0.13 },
  { hemi: 0.190, key: 2.60, fill: 0.09, exp: 1.12, kc: 0xf2ecdc, sl: [0.98, 1.00, 1.02], sat: 1.24, vig: 0.24, hal: 0.17 },
  { hemi: 0.380, key: 2.90, fill: 0.16, exp: 1.34, kc: 0xffe9c8, sl: [1.03, 1.01, 0.97], sat: 1.18, vig: 0.14, hal: 0.10 },
  { hemi: 0.075, key: 3.80, fill: 0.04, exp: 0.94, kc: 0xfff0d0, sl: [1.08, 0.98, 0.90], sat: 1.08, vig: 0.40, hal: 0.13 },
  { hemi: 0.380, key: 3.10, fill: 0.18, exp: 1.55, kc: 0xffe6c0, sl: [1.08, 1.02, 0.94], sat: 1.26, vig: 0.20, hal: 0.22 },
  { hemi: 0.340, key: 2.70, fill: 0.16, exp: 1.46, kc: 0xffe6c0, sl: [1.04, 1.00, 0.98], sat: 1.14, vig: 0.30, hal: 0.13 },
];
const _kcA = new THREE.Color(), _kcB = new THREE.Color();
let curDim = 0, curBeat = 0, curBeatT = 0;
function applyShow(t, day, dim, beat, beatT) {
  if (day == null) day = curDay < 0 ? 1 : curDay;
  if (dim == null) dim = 0;
  if (beat == null) beat = curBeat;
  beatT = beatT == null ? 1 : Math.round(beatT * 200) / 200;
  if (t === curShow && day === curDay && dim === curDim &&
      beat === curBeat && beatT === curBeatT) return;
  /* only a geometry change dirties the shadow map — day is light-only */
  if (t !== curShow) state.shadowDirty = true;
  curShow = t; curDay = day; curDim = dim; curBeat = beat; curBeatT = beatT;
  /* the breath before the surge: house lights DROP, hall goes black,
     then the doors beat snaps everything on at once */
  const dk = 1 - 0.72 * dim;
  const lsA = LS[Math.max(0, Math.min(LS.length - 1, beat - 1))];
  const lsB = LS[Math.max(0, Math.min(LS.length - 1, beat))];
  const lm = beatT >= 0.30 ? 1 : (beatT / 0.30) * (beatT / 0.30) * (3 - 2 * beatT / 0.30);
  const cue = {
    hemi: lsA.hemi + (lsB.hemi - lsA.hemi) * lm,
    key: lsA.key + (lsB.key - lsA.key) * lm,
    fill: lsA.fill + (lsB.fill - lsA.fill) * lm,
    exp: lsA.exp + (lsB.exp - lsA.exp) * lm,
  };
  _kcA.set(lsA.kc); _kcB.set(lsB.kc); _kcA.lerp(_kcB, lm);
  /* GLORY LIFT (owner 2026-08-19): the back third of every work-order
     chapter dwells on a COMPLETED stand — the set celebrates it. Key up,
     air up, halation up; still a pure function of scroll. */
  const gloryRaw = (beat === 2 || beat === 3 || beat === 4 || beat === 6)
    ? Math.min(1, Math.max(0, (beatT - 0.62) / 0.23)) : 0;
  const glory = gloryRaw * gloryRaw * (3 - 2 * gloryRaw);
  cue.key *= 1 + 0.30 * glory;
  cue.hemi *= 1 + 0.35 * glory;
  cue.exp *= 1 + 0.12 * glory;
  if (state.post) {
    const u = state.post.u;
    u.uSlope.value.set(
      lsA.sl[0] + (lsB.sl[0] - lsA.sl[0]) * lm,
      lsA.sl[1] + (lsB.sl[1] - lsA.sl[1]) * lm,
      lsA.sl[2] + (lsB.sl[2] - lsA.sl[2]) * lm);
    u.uSat.value = lsA.sat + (lsB.sat - lsA.sat) * lm;
    u.uVig.value = lsA.vig + (lsB.vig - lsA.vig) * lm;
    u.uHal.value = lsA.hal + (lsB.hal - lsA.hal) * lm + 0.04 * glory;
  }
  /* THE DOORS BEAT: not a linear +12% — a shaped surge that overshoots
     mid-transition and settles bright. pulse peaks at t=.5 and returns,
     so scrubbing through doors reads as the house lights SNAPPING on. */
  const pulse = Math.sin(Math.min(1, t) * Math.PI);
  const s = t + 0.5 * pulse;
  for (const [mat, base] of M._boost)
    mat.color.copy(base).multiplyScalar(1 + 1.3 * s);
  /* the SCRIPT owns the levels now; day only colors the air */
  const L = state.lights;
  L.hemi.intensity = cue.hemi * (1 + 0.9 * t) * dk;
  L.hemi.color.copy(_skyCold).lerp(_skyNoon, day).lerp(_skyShow, t * 0.7);
  L.hemi.groundColor.copy(_gndCold).lerp(_gndNoon, day);
  if (state.scene.fog) {
    state.scene.fog.color.copy(_fogCold).lerp(_fogNoon, day).lerp(_fogShow, t * 0.6);
    if (state.post) state.post.u.uFogCol.value.copy(state.scene.fog.color).multiplyScalar(1.5);
  }
  L.key.intensity = cue.key * (1 + 0.45 * s) * dk;
  L.key.color.copy(_kcA).lerp(_keyWarm, t * 0.6);
  L.rim.intensity = (0.35 + cue.key * 0.28) * (1 + 0.9 * s) * dk;
  L.fill.intensity = cue.fill * dk;
  if (state.post) {
    state.post.u.uExposure.value = cue.exp * (1 + 0.30 * pulse + 0.08 * t) * (1 - 0.30 * dim);
    state.post.u.uBloomStrength.value = 0.05 + 0.04 * day + 0.10 * t + 0.18 * pulse + 0.05 * glory;
    state.post.u.uRadius.value = 1.0 + 0.7 * t;    /* bloom opens at doors */
  }
  updateCrowd(t);
  /* house lights snap on ROW BY ROW across the doors surge — the ceiling
     is dim housings all day, then the hall's own fixtures become the event.
     Front-loaded stagger (jury 3rd pass: any capture late in the chapter
     must catch the hall LIT), and Doors must be the BRIGHTEST frame. */
  for (let r = 0; r < state.houseRows.length; r++) {
    const hr = state.houseRows[r];
    /* the timelapse IS the light show: banks march on one by one across
       the ceiling; the rescue beat pulls them back down to one island */
    const lapseRt = beat === 5 ? Math.min(1, Math.max(0, (beatT - 0.3 - r * 0.14) / 0.22)) : 0;
    const rt = Math.max(Math.min(1, Math.max(0, (t - r * 0.07) / 0.22)), lapseRt) * dk;
    hr.housingMat.color.copy(hr.base).lerp(hr.on, rt);
    hr.spriteMat.opacity = 0.8 * rt;
    if (state.shaftMats && state.shaftMats[r])
      state.shaftMats[r].uniforms.uOp.value = 0.14 * rt;
  }
  if (state.shaftPools)
    for (const sp2 of state.shaftPools) {
      const rt2 = Math.max(
        Math.min(1, Math.max(0, (t - sp2.row * 0.07) / 0.22)),
        beat === 5 ? Math.min(1, Math.max(0, (beatT - 0.3 - sp2.row * 0.14) / 0.22)) : 0) * dk;
      sp2.m.opacity = 0.16 * rt2;
    }
  /* jury r10 (Awwwards): the blueprint IS the banned Tron grid — it dies
     progressively as the day's work covers the hall, not all at once at
     doors. Pure function of (beat, beatT); doors t still completes it. */
  const wetBase = beat >= 2
    ? Math.min(0.72, Math.max(0, ((beat - 2) + beatT) * 0.17)) : 0;
  if (state.wetU) state.wetU.value = Math.max(t, wetBase);
  for (const am of state.aisleGlow) am.opacity = 0.18 * t;
  if (state.houseGlow) state.houseGlow.opacity = 0.09 * t;
  for (const m of [M.navy9, M.navy7, M.dark])
    if (m.userData.sh) m.userData.sh.uniforms.uRimS.value = m.userData.rimBase * (1 + 1.2 * s);
  for (const g of state.showGlows)
    g.material.opacity = Math.min(.9, g.userData.baseOp * (0.55 + 0.45 * day + 1.1 * t));
  for (const bo of state.booths)
    if (bo.live) applyB(bo, bo.b < 0 ? 1 : bo.b, t);
}
const MIGL = {
  ready: false,
  resize(rectW, rectH) {
    state.rectW = rectW; state.rectH = rectH;
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, state.narrow ? 1.0 : 1.2));
    state.renderer.setSize(rectW, rectH, false);
    if (state.post) state.post.resize();
    syncProjection(state.camera, rectW, rectH);
  },
  setStands(upto, subject) {
    state.booths.forEach((bo, i) => {
      bo.live = i <= upto;
      bo.group.visible = bo.live;
      if (bo.live && i !== subject) applyB(bo, 1);
    });
    state.shadowDirty = true;
  },
  /* weak-GPU escape hatch: one-way drop to a lite tier that keeps the
     look (grade, bloom, gantry) and sheds the depth/AO/MSAA tax */
  setQuality(q) {
    if (q !== 'lite' || !state.post) return;
    window.__miLite = true;
    state.post.enableDepth = false;
    state.post.lite = true;
    state.post.u.uAOAmt.value = 0;
    state.post.u.uFogC.value = 0;
    state.renderer.shadowMap.enabled = false;
    state.renderer.setPixelRatio(1.0);
    state.renderer.setSize(state.rectW, state.rectH, false);
    state.post.dispose();
    state.post.resize();
    syncProjection(state.camera, state.rectW, state.rectH);
  },
  setB(i, b) {
    const bo = state.booths[i];
    if (bo && bo.live && bo.b !== b) {
      applyB(bo, b);
      if (Math.abs((bo.sb == null ? -1 : bo.sb) - b) > 0.04) {
        state.shadowDirty = true; bo.sb = b;
      }
    }
  },
  /* THE SHEET STANDS UP. flat: 1 = the subject booth renders as plotter
     ink; fill: 0..1 sweeps the solid front bottom-to-top (>=1 = built);
     strike: 0..1 plays the shock ring. Everything else derives. */
  setReveal(i, o) {
    const rv = state.reveal;
    if (i < 0 || !state.booths[i]) {
      if (rv.i >= 0) {
        const prev = state.booths[rv.i];
        if (prev && prev.revealFlat) {
          prev.revealFlat = false; prev.revealDirty = true;
          applyB(prev, Math.max(0, prev.b), Math.max(0, prev.show));
        }
        if (prev && prev.rig) { prev.rig.g.visible = false; }
      }
      rv.i = -1;
      RV.uFlat.value = 0; RV.uGz.value = 9999;
      RV.uRevMin.value.set(1, 1); RV.uRevMax.value.set(-1, -1);
      return;
    }
    /* jumping booths (skip link, scrollbar drag) must not strand a frozen
       ink rig on the previous subject */
    if (rv.i >= 0 && rv.i !== i) {
      const prev = state.booths[rv.i];
      if (prev) {
        if (prev.revealFlat) {
          prev.revealFlat = false; prev.revealDirty = true;
          applyB(prev, Math.max(0, prev.b), Math.max(0, prev.show));
          state.shadowDirty = true;
        }
        if (prev.rig) prev.rig.g.visible = false;
      }
    }
    const bo = state.booths[i];
    rv.i = i; rv.flat = o.flat || 0;
    rv.fill = o.fill == null ? 1 : o.fill; rv.strike = o.strike || 0;
    RV.uInkR.value = o.ink == null ? 1.2 : o.ink;
    RV.uFoot.value.set(bo.dims.W / 2, bo.dims.D / 2);
    const wasFlat = !!bo.revealFlat;
    bo.revealFlat = rv.flat > 0.02 && rv.fill < 0.98;
    if (wasFlat !== bo.revealFlat) {
      bo.revealDirty = true;
      applyB(bo, Math.max(0, bo.b), Math.max(0, bo.show));
      state.shadowDirty = true;
    }
    RV.uFlat.value = rv.flat;
    const H = bo.dims.H;
    /* the drum prints TOP-DOWN — its camera looks down on it (oversight);
       everything else prints along the footprint behind the gantry */
    const topDown = bo.topDown;
    RV.uRevDir.value = topDown ? -1 : 1;
    RV.uH.value = H;
    /* the SHADER front and the CPU arrival share bo.gz — one clock.
       applyB computes it from b; here we hand it to the uniforms. */
    RV.uGz.value = bo.gz == null ? 9999 : bo.gz;
    RV.uRevMin.value.set(-bo.dims.W / 2 - 2, -bo.dims.D / 2 - 2);
    RV.uRevMax.value.set(bo.dims.W / 2 + 2, bo.dims.D / 2 + 2);
    const rig = bo.rig;
    const printing = bo.b > 0.001 && bo.b < 0.999;
    rig.g.visible = rv.flat > 0.01 || printing ||
                    (rv.strike > 0.001 && rv.strike < 1);
    /* perimeter ignition: each bar grows from its corner as the lap runs,
       with a hot overshoot pulse the moment the circuit closes */
    const lap = Math.min(1, rv.strike * 1.02);
    for (let fi = 0; fi < rig.frameBars.length; fi++) {
      const b2 = rig.frameBars[fi];
      const seg = Math.min(1, Math.max(0.001, (lap - fi * 0.25) / 0.25));
      b2.m.scale[b2.axis] = seg;
      b2.m.position[b2.axis] = b2.base + b2.dir * (seg - 1) * b2.len / 2;
      b2.m.visible = lap > fi * 0.25;
    }
    /* hot pulse the frame the circuit closes, settling to the flat glow */
    const closePulse = rv.strike > 0.9 && rv.strike < 1
      ? Math.sin((rv.strike - 0.9) * 10 * Math.PI) * 0.5 : 0;
    rig.frameMat.opacity = Math.max(0.85 * rv.flat,
      rv.strike > 0.001 && rv.strike < 1 ? 0.35 + 0.6 * lap + closePulse : 0);
    /* the gantry rides the print: portal + trailing light curtain at the
       front plane. Hidden for the drum (its halo is its own machine). */
    const headOn = printing && !topDown;
    rig.headMat.opacity = headOn ? 0.85 : 0;
    if (rig.curtainMat) rig.curtainMat.opacity = headOn ? 0.07 : 0;
    if (headOn) rig.head.position.z =
      Math.max(-bo.dims.D / 2 - 1.5, Math.min(bo.dims.D / 2 + 1.5, bo.gz || 0));
  },
  paint(cam) {
    if (!state.renderer) return;
    if (cam.D && (cam.D !== D || (cam.poy || 0.56) !== PO.y)) {
      D = cam.D; PO.y = cam.poy || 0.56;
      syncProjection(state.camera, state.rectW, state.rectH);
    }
    if (cam.rectW !== state.rectW || cam.rectH !== state.rectH)
      MIGL.resize(cam.rectW, cam.rectH);
    applyShow(cam.show || 0, cam.day == null ? 1 : cam.day, cam.dim || 0,
      cam.beat || 0, cam.beatT == null ? 1 : cam.beatT);
    /* THE IDLE LAYER — loudest when the reader is still. Nothing on this
       screen is ever frozen: LED content runs, crew shift their weight,
       dust drifts through the light. */
    const tSec = (performance.now() - state.t0) / 1000;
    const idle = cam.idle == null ? 1 : cam.idle;
    /* CONTENT FOLLOWS THE CLOCK: every screen runs the pixel-map test
       card until 14:00, then snaps to the broadcast loop (frame 0 is the
       card; 1-3 are the show frames) */
    const preMap = (curDay < 0.818) && (curShow || 0) <= 0.01;
    const fr = preMap ? 0 : 1 + Math.floor(tSec * 12.5) % 3;
    if (fr !== ledFrame) { ledFrame = fr; state.ledTex.offset.y = fr * 0.25; }
    state.ledTex.offset.x = preMap ? 0 : (tSec * 0.012) % 1;
    for (const [ct, sp] of state.ledClones) {
      if (ct.userData.twoFrame) ct.offset.y = preMap ? 0 : 0.5;
      else if (!ct.userData.noFlip) ct.offset.y = fr * 0.25;
      ct.offset.x = (tSec * sp) % 1;
    }
    if (state.shaftT) state.shaftT.value = tSec * idle;
    for (let i = 0; i < state.sway.length; i++)
      state.sway[i].rotation.z = Math.sin(tSec * 1.15 + i * 1.7) * 0.045 * idle;
    if (state.roamers)
      for (const rr of state.roamers) {
        rr.g.position.x = Math.sin(tSec * 0.11 + rr.ph) * rr.rx;
        rr.g.position.z = Math.cos(tSec * 0.07 + rr.ph * 2.1) * rr.rz;
        /* not while the print camera owns the frame — the drifting warm
           pool read as an "unmotivated orange smear" mid-drawing (jury) */
        rr.g.visible = !!(rr.bo.live && rr.bo.b > 0.92 && (rr.bo.show || 0) < 0.5);
      }
    if (state.dust) {
      state.dust.position.x = Math.sin(tSec * 0.09) * 26;
      state.dust.position.y = Math.cos(tSec * 0.06) * 20;
      state.dust.material.opacity = Math.max(0.03, 0.05 + 0.05 * (curDay || 0) - 0.07 * (curShow || 0));
    }
    syncWorld(cam);
    /* the reveal front lives in the SUBJECT booth's model space — rebuild
       its inverse against this frame's plan matrix */
    if (state.reveal.i >= 0) {
      const bo = state.booths[state.reveal.i];
      _revM.multiplyMatrices(state.plan.matrix, bo.mount.matrix);
      RV.uBoothInv.value.copy(_revM).invert();
    }
    /* proximity cull: a fixture whose clip-w collapses is about to project
       enormous (the 05:45 rake put two of them on screen at booth scale —
       jury: "desk lamps"). w = 1 - z_world/D from the projection's last row. */
    if (state.fixtures) {
      const e = state.plan.matrix.elements;
      for (const f of state.fixtures) {
        const zw = e[2] * f.x + e[6] * f.y + e[10] * f.z + e[14];
        const vis = (1 - zw / D) > 0.62;
        if (f.vis !== vis) {
          f.vis = vis;
          for (const p of f.parts) p.visible = vis;
        }
      }
    }
    /* THE MIRROR WORLD: when the floor is wet (print in flight or floor
       release), render the opaque set flipped across the floor plane into
       the reflection target. Projection y-row negated so winding survives
       the mirror; the shader un-flips the image. */
    const rvB = state.reveal.i >= 0 ? state.booths[state.reveal.i] : null;
    const needRefl = state.post && !state.post.lite && state.post.reflRT &&
      (curShow > 0.01 || (rvB && ((rvB.b > 0.001 && rvB.b < 0.999) ||
        RV.uFlat.value > 0.01)));
    if (needRefl) {
      const r2 = state.renderer, cam2 = state.camera;
      _savedPlan.copy(state.plan.matrix);
      state.plan.matrix.multiply(_flipZ);
      state.plan.matrixWorldNeedsUpdate = true;
      /* winding compensation = negate the WHOLE projection y row. This
         projection is CSS-style: row1 carries an off-center z-skew (e[9])
         and a w term (e[13]) — negating e[5] alone (the classic trick for
         standard cameras) shears the frustum and empties the pass */
      const pe = cam2.projectionMatrix.elements;
      pe[1] *= -1; pe[5] *= -1; pe[9] *= -1; pe[13] *= -1;
      state.wetFloor.visible = false;
      const prevMask = cam2.layers.mask;
      cam2.layers.set(1);
      r2.setRenderTarget(state.post.reflRT);
      r2.setClearColor(0x000000, 0);
      r2.clear();
      r2.render(state.scene, cam2);
      cam2.layers.mask = prevMask;
      pe[1] *= -1; pe[5] *= -1; pe[9] *= -1; pe[13] *= -1;
      state.plan.matrix.copy(_savedPlan);
      state.plan.matrixWorldNeedsUpdate = true;
      state.wetFloor.visible = true;
      r2.setRenderTarget(null);
      state.reflU.value = state.post.blurRefl() || state.post.reflRT.texture;
      state.renderer.getDrawingBufferSize(state.reflRes.value);
    } else if (state.reflU && !state.reflU.value && state.post && state.post.reflRT) {
      state.reflU.value = state.post.reflRT.texture;
    }
    if (state.shadowDirty && state.renderer.shadowMap.enabled) {
      state.renderer.shadowMap.needsUpdate = true;
      state.shadowDirty = false;
    }
    state.post.render(state.scene, state.camera);
  },
  _scene() { return state.scene; },
  _booths() { return state.booths; },
  _debugProject(X, Y, Z) {
    const v = new THREE.Vector3(X, Y, Z || 0);
    /* plan-space point: apply plan matrix then projection */
    const w = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(state.plan.matrix)
      .applyMatrix4(state.camera.projectionMatrix);
    return { x: (w.x / w.w + 1) / 2 * state.rectW, y: (1 - w.y / w.w) / 2 * state.rectH };
  },
};

window.__RV = RV;
window.__state = state;
if (init()) {
  MIGL.ready = true;
  window.MIGL = MIGL;
  window.dispatchEvent(new Event('migl-ready'));
}
