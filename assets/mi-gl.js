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
  practicals: [], sway: [], ledClones: [],
  holoT: { value: 0 }, fleet: null, lastT: null,
};

/* ================= textures ================= */
function canvasTex(w, h, draw, linear) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  /* roughness / normal / height data must stay LINEAR — tagging it sRGB
     silently gamma-mangles every value */
  t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
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
        /* a GREY-STEP WEDGE, not a pastel swatch board. Nine desaturated
           hues nowhere else in the piece made the calibration wall the
           brightest, most saturated thing on screen and read as
           placeholder art (critics, unanimous). Monochrome steps + ONE
           saturated bar is what a real pixel-map pass looks like. */
        const bars = ['#101317', '#1c2126', '#2a3036', '#383f46',
                      '#474f57', '#575f68', '#67707a', '#79828d'];
        bars.forEach((c, bi) => {
          g.fillStyle = c; g.fillRect(bi * AW / 8, y0 + 8, AW / 8 + 1, 150);
        });
        g.fillStyle = '#c9a54e';
        g.fillRect(AW - AW / 8, y0 + 8, AW / 8, 150);
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
/* ============ PROCEDURAL SURFACE SET ============
   Every surface in the owner's reference photos has grain, brush or a
   panel seam; ours were flat untextured colour, which is the largest
   single realism gap. All generated in canvas — no image files. */
let _surf = null;
function surfaces() {
  if (_surf) return _surf;
  /* WOOD — stacked bands with a fine ripple, plus darker growth lines.
     Feeds map + roughnessMap on the slat cloud and wood elements. */
  const wood = canvasTex(512, 512, (g) => {
    g.fillStyle = '#6b4a24'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 260; i++) {
      const y = Math.random() * 512;
      const w = 0.6 + Math.random() * 2.4;
      const l = 0.10 + Math.random() * 0.30;
      g.strokeStyle = 'rgba(' + (28 + Math.random() * 40 | 0) + ',' +
        (16 + Math.random() * 26 | 0) + ',6,' + l.toFixed(2) + ')';
      g.lineWidth = w;
      g.beginPath();
      for (let x = 0; x <= 512; x += 16)
        g[x ? 'lineTo' : 'moveTo'](x, y + Math.sin(x * 0.02 + y) * 3.5);
      g.stroke();
    }
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = 'rgba(200,160,110,' + (0.04 + Math.random() * 0.07).toFixed(2) + ')';
      g.lineWidth = 0.8 + Math.random();
      const y = Math.random() * 512;
      g.beginPath();
      for (let x = 0; x <= 512; x += 16)
        g[x ? 'lineTo' : 'moveTo'](x, y + Math.sin(x * 0.017 + y * 0.4) * 2.4);
      g.stroke();
    }
  });
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  /* BRUSHED METAL — fine directional streaks in a roughness map. A metal
     with a uniform roughness reads as plastic; the streaks are what make
     a highlight stretch along the grain. */
  const brushed = canvasTex(512, 512, (g) => {
    g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i++) {
      const y = Math.random() * 512;
      const v = 90 + Math.random() * 90 | 0;
      g.strokeStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.30)';
      g.lineWidth = 0.5 + Math.random() * 1.3;
      const x0 = Math.random() * 512, len = 60 + Math.random() * 400;
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + len, y + (Math.random() - .5) * 1.5);
      g.stroke();
    }
  });
  brushed.colorSpace = THREE.NoColorSpace;
  brushed.wrapS = brushed.wrapT = THREE.RepeatWrapping;
  /* PANEL SEAMS — a 4ft module of dark reveals with a soft AO gutter.
     Turns any large flat into a built panel system. */
  const seam = canvasTex(512, 512, (g) => {
    g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, 512, 512);
    for (const p of [0, 128, 256, 384]) {
      const gv = g.createLinearGradient(p - 8, 0, p + 8, 0);
      gv.addColorStop(0, 'rgba(40,40,40,0)');
      gv.addColorStop(0.5, 'rgba(28,28,28,0.85)');
      gv.addColorStop(1, 'rgba(40,40,40,0)');
      g.fillStyle = gv; g.fillRect(p - 8, 0, 16, 512);
      const gh = g.createLinearGradient(0, p - 8, 0, p + 8);
      gh.addColorStop(0, 'rgba(40,40,40,0)');
      gh.addColorStop(0.5, 'rgba(28,28,28,0.85)');
      gh.addColorStop(1, 'rgba(40,40,40,0)');
      g.fillStyle = gh; g.fillRect(0, p - 8, 512, 16);
    }
  });
  seam.colorSpace = THREE.NoColorSpace;
  seam.wrapS = seam.wrapT = THREE.RepeatWrapping;
  /* bind a surface map to uv1 (feet) at a real-world tile size */
  const at = (tex, feet) => { const t = tex.clone(); t.needsUpdate = true;
    t.channel = 1; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / feet, 1 / feet); return t; };
  _surf = { wood, brushed, seam, at };
  return _surf;
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
/* ANALYTIC SOFFIT OCCLUSION. AO and shadows are both off on mobile, and a
   HemisphereLight is a pure normal.y lerp, so a face buried under a canopy
   receives exactly the same ambient as one facing the open aisle — which is
   the literal definition of flat. Ten instructions buy most of what a
   viewer reads as GI under a deck. uSoffitK is 0 until a stand sets it, so
   with no stands on the floor this term costs nothing visually. */
const SOFFIT = {
  uSoffitY: { value: 11.4 },
  uSoffitK: { value: 0.0 },
  uFoot:    { value: new THREE.Vector2(20, 10) },
};

function patchMat(mat, opt) {
  /* Two cheap terms, both hall lighting: a per-face value ladder (front 1.0
     / side .74 / top .9 / underside .5) so a box is never one flat tone,
     and the soffit occlusion above. Optionally a screen-facing rim.
     (The plotter-ink / print-front reveal that used to live here went out
     with the stand designs on 2026-08-20 — it was booth logic.) */
  if (opt.rim) mat.userData.rimBase = opt.rimS;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uSoffitY: SOFFIT.uSoffitY, uSoffitK: SOFFIT.uSoffitK, uFoot: SOFFIT.uFoot,
    });
    sh.vertexShader = `varying vec3 vObjN; varying vec3 vBP;
` + sh.vertexShader
      .replace('#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vObjN = objectNormal;`)
      .replace('#include <project_vertex>',
        `#include <project_vertex>
         vec4 uWp = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           uWp = instanceMatrix * uWp;
         #endif
         vBP = uWp.xyz;`);
    let frag = `varying vec3 vObjN; varying vec3 vBP;
uniform float uSoffitY, uSoffitK;
uniform vec2 uFoot;
` + sh.fragmentShader
      .replace('#include <color_fragment>',
        `#include <color_fragment>
         vec3 uOn = normalize(vObjN);
         float uLad = uOn.y < -0.55 ? 0.5
           : mix(mix(0.74, 1.0, smoothstep(0.35, 0.9, abs(uOn.z))),
                 0.9, smoothstep(0.55, 0.9, uOn.y));
         diffuseColor.rgb *= uLad;
         float sIn  = (1.0 - smoothstep(uFoot.x * 0.80, uFoot.x * 1.15, abs(vBP.x)))
                    * (1.0 - smoothstep(uFoot.y * 0.80, uFoot.y * 1.15, abs(vBP.z)));
         diffuseColor.rgb *= 1.0 - uSoffitK
                           * smoothstep(uSoffitY, uSoffitY - 9.0, vBP.y) * sIn;`);
    if (opt.rim) {
      sh.uniforms.uRimC = { value: new THREE.Color(opt.rim) };
      sh.uniforms.uRimS = { value: opt.rimS };
      frag = frag
        .replace('#include <common>', `#include <common>
uniform vec3 uRimC; uniform float uRimS;`)
        .replace('#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float uFr = pow(1.0 - abs(normalize(normal).z), 3.0);
           totalEmissiveRadiance += uRimC * uFr * uRimS;`);
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
  /* BRAND SLAB — the reference booth's red: a big, flat, saturated mass
     that is STRUCTURE, not paint on a wall. Slightly self-lit so it stays
     brilliant in a dark hall the way a lit red "N" does. */
  /* NO EMISSIVE ON A BIG DIFFUSE MASS. Emissive adds a constant with no
     N·L, no falloff and no shadow, so it lifts the SHADE side as much as
     the lit side: measured, it took the hero slab's key/shade ratio from
     9:1 down to 2.6:1. That flat term was the "flat and boring". The mass
     is read bright by LIGHT (hot grazing practicals), never by emission. */
  M.brand = new THREE.MeshStandardMaterial({ color: 0xd10a16, roughness: .44,
    metalness: .06, envMap: envTex, envMapIntensity: 0.9 });
  M.brandDark = new THREE.MeshStandardMaterial({ color: 0x131315, roughness: .66,
    metalness: .12 });
  M.gold  = new THREE.MeshStandardMaterial({ color: GOLD, roughness: .22, metalness: .85,
    envMap: envTex, envMapIntensity: 1.6 });
  /* ANODIZED, NOT WHITE (owner 2026-08-19: the stands read as white
     foam-core). A metal's look is albedo x reflection, so a bright albedo
     on a 40ft fascia becomes a blown-out slab with no value structure.
     Real extrusion in a dark hall is a dark body with hot specular EDGES —
     darken the albedo and let the bevel/env carry the highlight. */
  M.silver = new THREE.MeshStandardMaterial({ color: 0x59626c, roughness: .26, metalness: .92,
    envMap: envTex, envMapIntensity: 1.35 });
  M.alu = new THREE.MeshStandardMaterial({ color: 0x474f57, roughness: .30, metalness: .9,
    envMap: envTex, envMapIntensity: .85 });
  M.charcoal = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: .7, metalness: .2,
    envMap: envTex, envMapIntensity: .5 });
  M.wood  = new THREE.MeshStandardMaterial({ color: WOOD, roughness: .8, metalness: .05, ...E, emissive: 0x020201 });
  M.ply   = new THREE.MeshStandardMaterial({ color: 0x9c8256, roughness: .85, metalness: 0, ...E, emissive: 0x020201 });
  M.dark  = new THREE.MeshStandardMaterial({ color: 0x232a33, roughness: .8, metalness: .1, ...E });
  M.carpet = new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: .95, metalness: 0, ...E, emissive: 0x000000 });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: .05, metalness: .1,
    transparent: true, opacity: .18, depthWrite: false,
    envMap: envTex, envMapIntensity: 0.40 });
  M.smoke = new THREE.MeshStandardMaterial({ color: 0x121a24, roughness: .1, metalness: .2,
    transparent: true, opacity: .55, depthWrite: false,
    envMap: envTex, envMapIntensity: .6 });
  M.plastic = new THREE.MeshStandardMaterial({ color: 0xb8c4cc, roughness: .5, metalness: 0,
    transparent: true, opacity: .26, depthWrite: false,
    envMap: envTex, envMapIntensity: .8 });
  /* ---- SURFACE MAPS ----
     Every reference surface has grain, brush or a seam; flat untextured
     colour was the largest remaining realism gap. All bound to uv1, which
     carries object-space FEET, so one texture tiles at a constant real
     size on a 0.5ft slat and a 14ft slab alike. */
  {
    const S = surfaces();
    /* wood: the one warm material, on the slat cloud */
    M.wood.map = S.at(S.wood, 8);
    M.wood.roughnessMap = S.at(S.brushed, 8);
    M.wood.roughness = 0.78;
    M.wood.color.setHex(0x8a6a3e);
    M.wood.emissive.setHex(0x000000);
    M.ply.map = S.at(S.wood, 8);
    M.ply.roughness = 0.85;
    /* brushed aluminium: a uniform roughness reads as plastic — the
       streaks are what stretch a highlight along the grain */
    M.silver.roughnessMap = S.at(S.brushed, 4);
    M.alu.roughnessMap = S.at(S.brushed, 4);
    /* panel seams on every large flat mass — kills the "painted slab" */
    for (const m of [M.brand, M.brandDark, M.charcoal, M.navy9, M.navy7]) {
      m.roughnessMap = S.at(S.seam, 8);
    }
  }
  /* emissive family — MeshBasic is unlit; >1 channels punch through ACES */
  /* brand system is gold/navy — the old cyan slabs were the biggest
     off-brand pixel in every booth chapter (jury r10, twice) */
  M.teal  = new THREE.MeshBasicMaterial({ color: new THREE.Color(7.8, 6.8, 4.9) });
  M.tealSoft = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.30, 0.26) });
  M.warm  = new THREE.MeshBasicMaterial({ color: new THREE.Color(8.8, 7.0, 4.2) });
  M.amberGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(5.8, 3.1, 0.8) });
  M.caution = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.8, 4.0, 0.6) });
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
  /* SMALL HOT SOURCES. The env was six long low-contrast strips and three
     big cards, which through PMREM becomes a smooth wash — a metal lit by
     it has no glint anywhere. Archviz reads as archviz partly because a
     few percent of pixels are blown specular. These are the sources that
     produce them: tiny, very bright, many. */
  const hotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(60, 52, 36) });
  const hotGeo = new THREE.PlaneGeometry(0.8, 0.8);
  for (let i = 0; i < 30; i++) {
    const q = new THREE.Mesh(hotGeo, hotMat);
    q.position.set(-24 + (i % 6) * 9.6, 28, -20 + Math.floor(i / 6) * 10);
    q.rotation.x = Math.PI / 2;
    env.add(q);
  }
  /* a horizon ring of them too, so vertical faces get a kick */
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(34, 27, 17) });
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2;
    const q = new THREE.Mesh(hotGeo, ringMat);
    q.position.set(Math.cos(a) * 44, 6, Math.sin(a) * 44);
    q.lookAt(0, 6, 0);
    env.add(q);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.0).texture;
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
  /* the chamfer clamp was 0.06ft = 0.72in ≈ 0.8 device pixels, i.e. every
     bevel in the scene was sub-pixel and no edge ever caught the key.
     0.30 gives a hero mass ~4px of lit arris for zero extra vertices. */
  const b = Math.min(Math.max(Math.min(w, Math.min(h, d)) * 0.05, 0.01), 0.30);
  const H = [hx, hy, hz], pos = [], nrm = [], uv = [], uv1 = [];
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
      /* uv1 = object-space FEET, so a shared grain/seam texture tiles at a
         constant real-world size on every box regardless of its extents */
      uv1.push(p[ua], p[va]);
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
  g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(uv1), 2));
  const half = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { half[i] = hx; half[i+1] = hy; half[i+2] = hz; }
  g.setAttribute('aHalf', new THREE.BufferAttribute(half, 3));
  _box.set(key, g);
  return g;
}
/* ============ THE FABRICATION KIT ============
   Design-agnostic detail builders. The single biggest reason the stands
   read as "modeled" rather than "built" is that nothing shows HOW it is
   held together — no base plates, no gussets, no rail shoes, no seams.
   Every one of these is cheap geometry that buys enormous believability,
   and they are shared by all four stands. */

let glowTex, blobTex, reflFadeTex;
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
/* ================= staging ================= */
const EASE = {
  steel: t => t < .7 ? t * 0.82 : 0.574 + (1 - Math.pow(1 - (t - .7) / .3, 3)) * .426,
  panel: t => { const s = 1.2, u = t - 1; return 1 + u * u * ((s + 1) * u + s); },
  bolt:  t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  slab:  t => t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
};
/* ============ THE CREW ============
   The product is LABOUR, and until now no worker appeared anywhere before
   the 16:00 visitor crowd — a viewer came away thinking the company builds
   booths rather than supplies the people who build them.
   These are NOT the blocky capsules that were rejected: every figure has
   two articulated arms in a working pose, a stance with the weight on one
   leg, and a silhouette that reads at 40-80px because the limbs come AWAY
   from the body. Unlit near-black (a lit figure takes the warm key and
   turns terracotta) with one hi-vis band and a hard hat. */
/* THE ONE WARM MATERIAL THAT GLOWS. Every warm pixel in the piece was
   line-work — cove strips, arris lines, dot rows. The reference's warm
   surface is a BROAD emissive face, and that is what makes a stand read
   as lit from within rather than painted. */
function makeBooth(group) {
  return { group, parts: [], b: -1, show: -1, live: false };
}
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
/* ================= the four booths ================= */
/* deterministic 0..1 hash — scatter that survives a scrub */
const hash01 = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };
/* attendees for the 16:00 floor release — not stand geometry */
const CROWD_N = 200;
/* Model space: x along the stand's long axis (plan east), z toward the
   aisle/camera (+), y up. Units: feet. Silhouette test: all four must be
   tellable apart in flat black — a plate on a mast, a sliced drum under a
   halo, a folded canyon, an opened crate on scissor masts. */

function buildCrowd(plan) {
  const torsoG = new THREE.CapsuleGeometry(0.85, 1.9, 3, 6);
  const headG = new THREE.IcosahedronGeometry(0.55, 0);
  const legsG = new THREE.CylinderGeometry(0.5, 0.42, 2.6, 5);
  /* UNLIT silhouettes. A lit grey crowd takes the warm key and turns tan —
     the "terracotta army" the critics flagged twice. MeshBasic near-black
     cannot be lifted by any light, so the tide stays a tide. Cheaper too. */
  const mkMat = (c) => new THREE.MeshBasicMaterial({ color: c, fog: true });
  const torso = new THREE.InstancedMesh(torsoG, mkMat(0x14151a), CROWD_N);
  const head = new THREE.InstancedMesh(headG, mkMat(0x0a0b0e), CROWD_N);
  const legs = new THREE.InstancedMesh(legsG, mkMat(0x0c0d11), CROWD_N);
  /* clothing palette — flesh lives on the head mesh ONLY, and the tide
     stays NEAR-BLACK even under the doors key (decree: concert
     photography, not pawns — the old values washed tan at 16:00) */
  const civ = [new THREE.Color(0x0d0e12), new THREE.Color(0x121319),
               new THREE.Color(0x171921), new THREE.Color(0x1c1f28),
               new THREE.Color(0x212530), new THREE.Color(0x3a1c1e)];
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
      torso.setColorAt(i, new THREE.Color(0x8e2118));
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

/* ================= THE FREIGHT FLEET =================
   Owner 2026-08-24. The aisle current used to be three shader ribbons —
   "streaks of light running down the aisles". Same three lanes, same
   alternating directions, same slow current: the thing MOVING down them is
   now what would actually be moving down a hall on build day. A hall with
   freight in the aisles is a hall being built; a hall with light streaks in
   the aisles is a screensaver.

   The truck is a 5,000lb-class IC counterbalance forklift measured off real
   spec sheets (Toyota 8FGCU25, cross-checked Hyster H50XT / Yale GLC050):
   7.8ft to the fork face, 11.3ft over the forks, 3.5ft wide, 6.7ft to the
   top of the overhead guard, 4.9ft wheelbase, 2.1ft drive tyres up front
   and 1.55ft steer tyres set inboard behind, 1.5ft of counterweight past
   the rear axle. It is modelled in FEET in the same model space the booths
   use (x = plan east / forward, y = up, z = plan south) and mounted through
   the same ft->plan basis swap.

   The five proportions that make it read as a forklift at 40px — which is
   the size it is at the top-down map, i.e. most of the time:
     guard height ~1.37x wheelbase; drive tyre ~1.35x steer tyre with the
     steer pair visibly inboard; the counterweight a rounded tail mass ~30%
     of the wheelbase; the cab mass sitting over the REAR axle; and mast and
     guard as two near-equal vertical masses at either end.

   ONE geometry, merged per material, drawn as InstancedMesh: six trucks
   cost twelve draw calls, not three hundred. */

/* three's BufferGeometryUtils lives in examples/, which this build does not
   ship — so a merge is a de-index, a matrix apply, and a concat. Every kit
   geometry carries position/normal/uv (+uv1 on boxGeo); anything missing
   uv1 falls back to uv, which is the same guarantee init()'s traverse makes
   for the rest of the scene. */
function mergeParts(parts) {
  let n = 0;
  const flat = [];
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    flat.push({ g, m: p.m });
    n += g.attributes.position.count;
  }
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2), uv1 = new Float32Array(n * 2);
  const nm = new THREE.Matrix3(), v = new THREE.Vector3();
  let o = 0;
  for (const p of flat) {
    const a = p.g.attributes, c = a.position.count;
    nm.getNormalMatrix(p.m);
    const au = a.uv, au1 = a.uv1 || a.uv;
    for (let i = 0; i < c; i++) {
      const j3 = (o + i) * 3, j2 = (o + i) * 2;
      v.fromBufferAttribute(a.position, i).applyMatrix4(p.m);
      pos[j3] = v.x; pos[j3 + 1] = v.y; pos[j3 + 2] = v.z;
      v.fromBufferAttribute(a.normal, i).applyMatrix3(nm).normalize();
      nrm[j3] = v.x; nrm[j3 + 1] = v.y; nrm[j3 + 2] = v.z;
      if (au) { uv[j2] = au.getX(i); uv[j2 + 1] = au.getY(i); }
      if (au1) { uv1[j2] = au1.getX(i); uv1[j2 + 1] = au1.getY(i); }
    }
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return g;
}
/* a bucket of parts destined for one material. pair() mirrors across the
   centreline; the mirror of a rotation about z is itself, and the mirror of
   one about x or y is its negation — true for the SINGLE-axis rotations
   this kit uses, which is all it is asked for. */
function bucket() {
  const parts = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const api = {
    parts,
    add(g, x, y, z, rx, ry, rz) {
      e.set(rx || 0, ry || 0, rz || 0);
      q.setFromEuler(e);
      v.set(x || 0, y || 0, z || 0);
      parts.push({ g, m: new THREE.Matrix4().compose(v, q, one) });
      return api;
    },
    addM(g, m) { parts.push({ g, m }); return api; },
    pair(g, x, y, z, rx, ry, rz) {
      api.add(g, x, y, z, rx, ry, rz);
      api.add(g, x, y, -z, -(rx || 0), -(ry || 0), rz || 0);
      return api;
    },
    geo() { return mergeParts(parts); },
  };
  return api;
}
/* a cylinder laid along the model z axis (an axle, a wheel, a tank) */
function zCyl(r, len, seg) {
  return new THREE.CylinderGeometry(r, r, len, seg || 14).rotateX(Math.PI / 2);
}
/* the yellow-black hazard tape that lives on a counterweight tail and on
   fork heels — the one place a real truck is allowed to be loud */
let hazTex;
function makeHazTex() {
  hazTex = canvasTex(64, 64, (g) => {
    g.fillStyle = '#0b0b0c'; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#d9a11c'; g.lineWidth = 12;
    for (let i = -80; i < 128; i += 24) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke();
    }
  });
  hazTex.wrapS = hazTex.wrapT = THREE.RepeatWrapping;
  hazTex.repeat.set(3, 1);
}

const FM = {};
/* The fleet owns its materials rather than borrowing M.*, because it skips
   patchMat: that patch's soffit term reads a GLOBAL uniform owned by
   whichever stand is on screen, and a forklift out in the aisle is not
   under that stand's canopy.
   They are OPAQUE. An earlier cut made them transparent so the fleet could
   be dimmed, and dimming a solid does not make it recede — it makes it a
   ghost. The booth numbers read straight through the mast, and at the
   doors beat six half-there forklifts hung in the crowd like red spectres.
   The fleet leaves the floor by DRIVING OFF IT instead (see updateFleet). */
function makeFleetMats(envTex) {
  const T = {};
  /* Toyota Orange (#E4650E) taken down a stop: at full albedo a 3.5ft-wide
     painted mass under the warm key blows straight past the bloom knee and
     the truck becomes a glowing lozenge with no form in it */
  FM.body = new THREE.MeshStandardMaterial({ color: 0xc0560f, roughness: .42,
    metalness: .18, envMap: envTex, envMapIntensity: 1.0, ...T });
  /* mast, guard and forks are black on a real truck, but a literal black
     against a near-black hall is a HOLE, not a machine — the whole front
     half of the silhouette disappeared. Lifted to a dark graphite that
     still reads as painted black wherever the key touches it. */
  FM.steel = new THREE.MeshStandardMaterial({ color: 0x272c33, roughness: .48,
    metalness: .62, envMap: envTex, envMapIntensity: 1.0, ...T });
  FM.chrome = new THREE.MeshStandardMaterial({ color: 0x717983, roughness: .24,
    metalness: .95, envMap: envTex, envMapIntensity: 1.5, ...T });
  FM.rubber = new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: .95,
    metalness: 0, ...T });
  FM.haz = new THREE.MeshStandardMaterial({ map: hazTex, roughness: .6,
    metalness: .1, ...T });
  /* unlit near-black, exactly like the aisle crowd: a LIT grey figure takes
     the warm key and goes terracotta, and MeshBasic cannot be lifted */
  FM.crew = new THREE.MeshBasicMaterial({ color: 0x0d0e12, fog: true });
  FM.vest = new THREE.MeshStandardMaterial({ color: 0xb8331d, roughness: .68,
    metalness: .05, envMap: envTex, envMapIntensity: .5, ...T });
  /* exhibit-house crates are painted one solid colour and stencilled, not
     bare ply — slate keeps the mass legible against both the navy hall and
     the black mast without competing with the orange */
  FM.crate = new THREE.MeshStandardMaterial({ color: 0x525d6b, roughness: .78,
    metalness: .06, envMap: envTex, envMapIntensity: .40, ...T });
  /* the same trick the stands use: a roughness map on uv1 (object-space
     FEET) so the grain tiles at a constant real size no matter how big the
     part is. Painted sheet steel that is uniformly rough reads as plastic,
     and a 3.5ft slab of flat orange was reading exactly that way. */
  {
    const S = surfaces();
    FM.body.roughnessMap = S.at(S.brushed, 2.0);
    FM.steel.roughnessMap = S.at(S.brushed, 1.6);
    FM.crate.roughnessMap = S.at(S.wood, 3.0);
  }
}
const glowMat = (color, op) => {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  m.userData.op0 = op;
  return m;
};

/* ---- the truck, part by part, in feet; origin = ground at the DRIVE axle,
   +x forward. Every number below is off a spec sheet, not eyeballed. ---- */
const FK = {
  W: 3.50,        /* overall width */
  HW: 1.75,
  WB: 4.90,       /* wheelbase — rear axle at x = -4.90 */
  TAIL: -6.41,    /* 1.51ft of counterweight past the rear axle */
  FACE: 1.40,     /* fork face */
  TIP: 4.90,      /* 42in forks */
  GUARD: 6.70,    /* top of the overhead guard */
  MAST: 7.10,     /* mast lowered height */
  TILT: 0.105,    /* 6deg back — travelling attitude, load on the backrest.
                     Do not push this much past 6: the mast is 6.3ft tall,
                     so every degree walks its head 0.11ft toward the cab,
                     and at 8 the mast top arrived INSIDE the overhead guard
                     and the whole front mass vanished behind the posts. */
  RF: 1.05, RR: 0.775,          /* drive / steer tyre radii */
  TF: 1.45, TR: 1.25,           /* drive / steer half-track */
  PX: 0.75, PY: 0.85,           /* the mast's tilt pivot */
};
/* everything forward of the tilt pivot — channels, carriage, backrest,
   forks and therefore the LOAD — turns about this one matrix */
const tiltM = () => new THREE.Matrix4()
  .makeRotationZ(FK.TILT).setPosition(FK.PX, FK.PY, 0)
  .multiply(new THREE.Matrix4().makeTranslation(-FK.PX, -FK.PY, 0));
function buildTruckGeo() {
  const body = bucket(), steel = bucket(), chrome = bucket(),
        rubber = bucket(), haz = bucket();

  /* ---- counterweight: a rounded cast tail, full width, ground clearance
     to 3.7ft where it blends into the seat back. Extruded from a plan
     outline because the PLAN silhouette is the one the map camera sees. */
  const cw = new THREE.Shape();
  const cx0 = FK.TAIL, cx1 = -4.30, cr = 0.56;
  cw.moveTo(cx1, FK.HW);
  cw.lineTo(cx0 + cr, FK.HW);
  cw.absarc(cx0 + cr, FK.HW - cr, cr, Math.PI / 2, Math.PI, false);
  cw.lineTo(cx0, -FK.HW + cr);
  cw.absarc(cx0 + cr, -FK.HW + cr, cr, Math.PI, Math.PI * 1.5, false);
  cw.lineTo(cx1, -FK.HW);
  cw.closePath();
  const cwG = new THREE.ExtrudeGeometry(cw, { depth: 3.20, curveSegments: 7,
    bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09, bevelSegments: 2 })
    .rotateX(-Math.PI / 2);
  body.add(cwG, 0, 0.36, 0);
  /* ---- frame, hood, cowl ---- */
  body.add(boxGeo(5.10, 1.00, 3.34), -2.30, 1.02);        /* lower frame */
  body.add(boxGeo(2.72, 1.10, 3.30), -2.94, 1.98);        /* engine cover */
  body.add(boxGeo(0.74, 1.28, 2.55), -1.16, 1.92);        /* dash pod */
  body.pair(boxGeo(2.40, 0.62, 0.22), -2.10, 1.34, 1.72); /* fender skirt */
  /* ---- running gear ---- */
  steel.add(zCyl(0.30, 3.20), 0, FK.RF);                  /* drive axle */
  steel.add(zCyl(0.20, 2.40), -FK.WB, FK.RR);             /* steer axle */
  steel.add(boxGeo(0.90, 0.52, 2.70), -FK.WB, 0.90);      /* steer beam */
  steel.add(boxGeo(1.70, 0.10, 2.90), -1.32, 1.40);       /* floorboard */
  steel.pair(boxGeo(0.80, 0.10, 0.60), -2.20, 0.88, 1.76);/* step plate */
  rubber.pair(zCyl(FK.RF, 0.65, 18), 0, FK.RF, FK.TF);
  rubber.pair(zCyl(FK.RR, 0.50, 16), -FK.WB, FK.RR, FK.TR);
  chrome.pair(zCyl(0.40, 0.68, 12), 0, FK.RF, FK.TF);
  chrome.pair(zCyl(0.28, 0.53, 12), -FK.WB, FK.RR, FK.TR);
  /* ---- operator: seat on the hood, wheel raked 35deg off vertical ---- */
  steel.add(boxGeo(1.30, 0.16, 1.70), -3.55, 2.60);
  rubber.add(boxGeo(1.24, 0.34, 1.62), -3.56, 2.79);      /* cushion */
  rubber.add(boxGeo(0.30, 1.05, 1.58), -4.16, 3.34, 0, 0, 0, -0.16);
  steel.add(new THREE.CylinderGeometry(0.09, 0.09, 1.15, 8), -1.52, 3.06, 0, 0, 0, 0.55);
  steel.add(new THREE.TorusGeometry(0.60, 0.062, 6, 18)
    .rotateY(Math.PI / 2).rotateZ(-0.61), -1.82, 3.52);
  /* ---- overhead guard: 2in square tube, front posts plumb, rear posts
     raked 12deg back, roof a run of fore-aft flat bars (gaps under the 6in
     the standard allows, which is what stops it reading as a solid lid) */
  steel.pair(boxGeo(0.20, 4.40, 0.20), -0.98, 4.44, 1.60);
  steel.pair(boxGeo(0.20, 3.40, 0.20), -4.95, 5.10, 1.62, 0, 0, 0.21);
  steel.add(boxGeo(0.26, 0.16, 3.34), -0.88, 6.60);
  steel.add(boxGeo(0.26, 0.16, 3.34), -5.28, 6.60);
  steel.pair(boxGeo(4.46, 0.18, 0.20), -3.08, 6.60, 1.64);
  /* 2.4in gaps: over the 1-1.5in a real perforated roof runs, well under
     the 6in the standard caps it at, and the only spacing that still reads
     as a SLATTED roof rather than a solid lid at hall scale */
  for (let k = 0; k < 6; k++)
    steel.add(boxGeo(4.42, 0.12, 0.40), -3.08, 6.66, -1.50 + k * 0.60);
  /* ---- LPG: an indoor truck runs propane, and the tank lying across the
     counterweight behind the seat is the single most identifying lump on
     the machine after the mast ---- */
  chrome.add(zCyl(0.55, 2.40, 16), -5.30, 4.30);
  chrome.add(zCyl(0.16, 0.60, 8), -4.60, 4.30, 1.30);
  /* ---- hazard tape: rear corners of the counterweight ---- */
  haz.add(boxGeo(0.06, 0.80, 1.70), FK.TAIL + 0.02, 2.55);
  /* ---- MAST + CARRIAGE. Built about the tilt pivot and added back tilted
     8deg: everything forward of the pivot — channels, carriage, backrest,
     forks and therefore the load — leans back together, which is how a
     loaded truck actually travels. ---- */
  {
    /* the mast is mounted AHEAD of the drive axle, not over it, and the
       guard's front posts sit a clear 0.8ft behind its head — that gap is
       what makes the two vertical masses read as two masses */
    const mast = bucket();
    const R = (x, y) => [x - FK.PX, y - FK.PY];
    let p;
    p = R(0.72, 3.95); mast.pair(boxGeo(0.34, 6.30, 0.26), p[0], p[1], 1.36);
    p = R(0.96, 3.85); mast.pair(boxGeo(0.26, 5.70, 0.20), p[0], p[1], 1.08);
    p = R(0.78, 7.02); mast.add(boxGeo(0.42, 0.28, 3.00), p[0], p[1]);
    p = R(0.78, 0.96); mast.add(boxGeo(0.42, 0.30, 3.00), p[0], p[1]);
    p = R(0.72, 6.98); mast.add(zCyl(0.24, 0.34, 12), p[0], p[1]);
    p = R(0.84, 4.70); mast.pair(boxGeo(0.06, 4.60, 0.05), p[0], p[1], 0.52);
    /* carriage, load backrest (4ft of it, slatted) and the forks */
    p = R(1.32, 1.35); mast.add(boxGeo(0.16, 2.00, 2.60), p[0], p[1]);
    p = R(1.46, 2.60); mast.pair(boxGeo(0.12, 4.00, 0.22), p[0], p[1], 1.16);
    for (let k = 0; k < 4; k++) {
      p = R(1.46, 1.00 + k * 1.05); mast.add(boxGeo(0.11, 0.20, 2.40), p[0], p[1]);
    }
    p = R(1.46, 1.35); mast.pair(boxGeo(0.20, 2.00, 0.34), p[0], p[1], 0.90);
    p = R(3.20, 0.40); mast.pair(boxGeo(3.56, 0.146, 0.33), p[0], p[1], 0.90);
    steel.addM(mast.geo(), tiltM());
    /* the single lift cylinder rides behind the channels; the exposed rod
       is the one bare-steel thing on the machine */
    const cyl = bucket();
    p = R(0.46, 3.00); cyl.add(new THREE.CylinderGeometry(0.19, 0.19, 4.00, 10), p[0], p[1]);
    p = R(0.46, 6.00); cyl.add(new THREE.CylinderGeometry(0.11, 0.11, 2.30, 8), p[0], p[1]);
    chrome.addM(cyl.geo(), tiltM());
    /* tilt rams: chassis to mast, the diagonal that says the mast MOVES */
    steel.pair(new THREE.CylinderGeometry(0.13, 0.13, 1.70, 8), 0.06, 2.45, 1.46, 0, 0, -0.72);
  }
  /* ---- THE OPERATOR. The product this page sells is LABOUR, and a hall
     full of driverless trucks sells automation. Same rules the aisle crowd
     is built to: near-black so the warm key can never turn it terracotta,
     one hi-vis band, a hard hat, and a silhouette that reads because the
     arms come AWAY from the body — here, both hands out on the wheel. */
  const crew = bucket(), vest = bucket();
  const SX = -3.30, SY = 2.95;             /* hips, on the seat cushion */
  crew.add(new THREE.CapsuleGeometry(0.42, 0.55, 3, 7), SX + 0.10, SY + 1.02, 0, 0, 0, 0.10);
  crew.add(new THREE.CapsuleGeometry(0.36, 0.72, 3, 6), SX + 0.62, SY + 0.30, 0, 0, 0, 1.25);
  crew.add(new THREE.IcosahedronGeometry(0.40, 1), SX + 0.20, SY + 1.92);
  crew.pair(new THREE.CapsuleGeometry(0.13, 1.35, 3, 5), SX + 0.86, SY + 1.28, 0.44, 0, 0, 1.02);
  vest.add(new THREE.CapsuleGeometry(0.44, 0.30, 3, 7), SX + 0.12, SY + 1.02, 0, 0, 0, 0.10);
  /* hard hat: a shallow dome with a brim, which is the whole silhouette */
  vest.add(new THREE.SphereGeometry(0.42, 10, 5, 0, 6.283, 0, 1.25), SX + 0.20, SY + 2.02);
  vest.add(new THREE.CylinderGeometry(0.50, 0.50, 0.07, 10), SX + 0.20, SY + 2.03);
  return { body: body.geo(), steel: steel.geo(), chrome: chrome.geo(),
    rubber: rubber.geo(), haz: haz.geo(), crew: crew.geo(), vest: vest.geo() };
}
/* the freight: a stencilled exhibit-house crate on 4x4 skids, sitting on
   the forks against the backrest — so it carries the mast's tilt too */
function buildLoadGeo() {
  const paint = bucket(), cap = bucket();
  /* the deck sits on the TOP OF THE FORK BLADES (y 0.475) with the skids
     hanging outboard of them — which is how a skidded crate is actually
     picked, and why the fork tips stay visible past the front face */
  const CD = 3.00, CH = 3.90, CW = 4.60, CX = 3.05, CY = 0.475 + CH / 2;
  paint.add(boxGeo(CD, CH, CW), CX, CY);
  cap.pair(boxGeo(CD, 0.33, 0.36), CX, 0.31, 1.72);            /* skids */
  const hd = CD / 2, hh = CH / 2, hw = CW / 2, E = 0.13;
  for (const sy of [1, -1]) for (const sz of [1, -1]) {
    cap.add(boxGeo(CD, E, E), CX, CY + sy * hh, sz * hw);      /* along x */
    cap.add(boxGeo(E, CH, E), CX + sy * hd, CY, sz * hw);      /* along y */
    cap.add(boxGeo(E, E, CW), CX + sy * hd, CY + sz * hh, 0);  /* along z */
  }
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1])
    cap.add(boxGeo(0.30, 0.30, 0.30), CX + sx * hd, CY + sy * hh, sz * hw);
  cap.add(boxGeo(0.05, 0.90, 2.60), CX + hd + 0.02, CY + 0.60); /* stencil plate */
  /* the load leans with the forks, so it must turn about the SAME pivot the
     mast does — off by 0.2ft and the crate floats off the fork blades */
  const m = tiltM();
  return { crate: mergeParts([{ g: paint.geo(), m }]),
    caps: mergeParts([{ g: cap.geo(), m }]) };
}

/* THE LANES ARE THE STREAKS' LANES — the drawing's own aisle centrelines,
   same three, same alternating directions. Only the thing moving changed. */
const FLEET_LANES = [476.1, 775.1, 1124.1];
/* THE LAP IS LONGER THAN THE HALL (owner 2026-08-24: "it feels like there
   could be too many forklifts too close together"). The truck is only
   drawn across model x 17..304, so a 470ft lap leaves each one OFF the
   drawing about 39% of its cycle. That is where the subtlety comes from —
   not from slowing anything down, but from letting an aisle stand empty
   for a while before the next machine crosses it.

   The number that matters is trucks x duty = how many are on the floor at
   once. Six on a 330ft lap gave 5.2 — three lanes permanently occupied,
   which is a conveyor, not a hall. Four on a 570ft lap gave 1.75 and
   over-corrected hard: the map camera looked right, but the hero beats
   frame maybe a third of the floor, so most of them had no forklift in
   shot at all and the piece lost the life it was built for. Five on 470
   gives ~3.0 — about one per lane, which is what the light streaks it
   replaced were, and it holds up at BOTH cameras. */
const FLEET_X0 = -75, FLEET_X1 = 395;    /* model ft: on and off the drawing */
/* ...and while it is off it is not DRAWN. The hall shell runs model x
   10..310; a truck that keeps rolling past that is a forklift parked in
   the black outside the building, which is what the first long-lap cut
   looked like at the map camera — half a machine straddling the west wall,
   sitting on the headline. It cuts out just clear of the shell instead.
   The cut is a pop, and a pop was the lesser evil here: it lands at the
   extreme edge of the frame (east is off-frame entirely at the map
   camera), it happens where the freight doors are, and every alternative
   is a fade — which on a solid means a ghost. */
/* Bounds are on the truck's ORIGIN, so they carry its overhang: the tail
   sits 6.4ft behind it and a crate reaches ~5ft in front, and at a looser
   6/314 the tail still hung past the west wall into the black with the
   headline behind it. 17/304 keeps the whole machine inside the shell. */
const FLEET_IN = 17, FLEET_OUT = 304;
/* FIVE TRUCKS. `at` is model x at scene start; a reader arrives at an
   arbitrary phase, so what keeps them apart has to hold at EVERY phase,
   not just this one. Two rules do it:

   1. WHERE A LANE CARRIES TWO TRUCKS THEY RUN AT AN IDENTICAL SPEED, so
      their gap is locked forever and one is always near an edge or off it
      while the other has the aisle to itself. Give a shared lane even
      slightly different speeds and the gap closes over a few minutes
      until one truck drives through the other.
   2. The two shared lanes use DIFFERENT gaps — 235ft in lane 1, 155ft in
      lane 2. Both at half a lap looked fine in isolation and was quietly
      wrong: lanes 1 and 2 run opposite ways and cross every 33s, and with
      equal gaps BOTH pairs aligned on the same frame, so every crossing
      arrived as two stacked columns at once. Unequal gaps break that.
   3. Speed varies BETWEEN lanes — 9.2 / 7.4 / 6.9 — so the three aisles
      drift out of step and the set never settles into a pattern.

   Crossings between opposing lanes are unavoidable and wanted: two
   forklifts passing in neighbouring aisles is what a hall looks like. The
   trucks visible at scene start are simply set DIVERGING so the first one
   cannot happen immediately — an earlier cut had a westbound truck at 232
   and an eastbound one at 96 meeting dead level eight seconds in.

   Four start on the drawing, spread across it at x 250 / 210 / 120 / 55;
   the fifth starts out past the east wall and drives in.

   Direction alternates by lane exactly as the streaks did — eastbound
   runs loaded out of the west freight doors, westbound is deliveries and
   empty trucks going back for the next piece. */
const FLEET_PLAN = [
  { lane: 0, at:  250, loaded: false, speed: 9.2, off:  0.9 },
  { lane: 1, at:  120, loaded: true,  speed: 7.4, off: -1.0 },
  { lane: 1, at:  355, loaded: true,  speed: 7.4, off:  1.1 },
  { lane: 2, at:  210, loaded: true,  speed: 6.9, off:  0.4 },
  { lane: 2, at:   55, loaded: false, speed: 6.9, off: -0.8 },
];
function buildFleet(plan) {
  makeHazTex();
  makeFleetMats(state.envTex);
  const T = buildTruckGeo(), L = buildLoadGeo();

  const fleet = new THREE.Group();
  fleet.matrixAutoUpdate = false;
  /* model ft -> plan units, y-up -> plan z-up, model z (south) -> +plan y.
     The same basis swap every booth mount uses, so the parity that makes
     the lights shade the right side of a surface is the parity here too. */
  fleet.matrix.set(FT, 0, 0, 0, 0, 0, FT, 0, 0, FT, 0, 0, 0, 0, 0, 1);
  plan.add(fleet);

  const N = FLEET_PLAN.length;
  const meshes = [], rig = [];
  const mk = (geo, mat, order) => {
    const m = new THREE.InstancedMesh(geo, mat, N);
    m.frustumCulled = false;
    m.renderOrder = order == null ? 4 : order;
    m.userData.noShadow = true;   /* the shadow map is CACHED; a moving
                                     caster would smear a stale silhouette
                                     across the floor. Contact blobs below. */
    fleet.add(m);
    meshes.push(m);
    rig.push(m);                  /* every mesh takes the truck's matrix —
                                     each part's offset is baked into its
                                     geometry, never into an instance */
    return m;
  };
  const F = {
    body: mk(T.body, FM.body), steel: mk(T.steel, FM.steel),
    chrome: mk(T.chrome, FM.chrome), rubber: mk(T.rubber, FM.rubber),
    haz: mk(T.haz, FM.haz),
    crew: mk(T.crew, FM.crew), vest: mk(T.vest, FM.vest),
    crate: mk(L.crate, FM.crate), caps: mk(L.caps, FM.steel),
  };
  /* ---- the light on the truck ---- */
  /* every lamp's offset is baked into its GEOMETRY, so a lamp mesh takes
     the very same per-truck matrix the body does. The beacon's offset used
     to live in its instance matrix instead — which updateFleet then never
     wrote, and six beacons hovered together over the hall origin. */
  const bead = (r) => new THREE.IcosahedronGeometry(r, 1);
  const heads = bucket();
  heads.pair(bead(0.17), -0.92, 5.60, 1.48);      /* on the front guard posts */
  F.head = mk(heads.geo(), glowMat(0xffe6bc, 0.95), 6);
  const tails = bucket();
  /* both rear lamps live on the FLAT of the counterweight tail: past
     z = +-0.89 that face curves away into the corner radius */
  tails.pair(bead(0.13), FK.TAIL - 0.02, 2.30, 0.74);
  F.tail = mk(tails.geo(), glowMat(0xff3320, 0.7), 6);
  F.beacon = mk(bead(0.26).translate(-4.10, 6.96, 0), glowMat(0xffa317, 1.0), 6);
  for (let i = 0; i < N; i++) F.beacon.setColorAt(i, new THREE.Color(1, 1, 1));
  F.beacon.instanceColor.needsUpdate = true;
  /* WHAT THE TRUCK PUTS ON THE FLOOR — and the honest heir to the streak:
     a pool of light sliding down the aisle, now with a machine attached.
     Warm at the nose (headlights), cold at the tail (the blue LED spot
     modern warehouse trucks project 10-20ft behind them as a pedestrian
     warning). Split warm/cool because the drawing UNDERNEATH is cyan: a
     blue pool on a blue floor is a pool nobody can see, and the warm nose
     is the half that actually reads at the map camera.
     FLOAT THEM CLEAR OF THE FLOOR STACK. At the drawing's own height these
     were invisible on desktop and only on desktop — three's ShadowMaterial
     is transparent but STILL depth-writes, so the hall's shadow-catcher
     plane at plan z 0.35 was quietly rejecting them. They sit at plan z
     1.6 now, which is exactly where the light streaks used to live. */
  const sq = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const PZ = 0.32;                        /* model ft -> plan z 1.6 */
  const nose = bucket(), tail = bucket();
  nose.add(sq.clone().scale(11.0, 1, 6.0), 8.0, PZ, 0);
  tail.add(sq.clone().scale(8.0, 1, 4.2), -15.5, PZ, 0);
  /* NOT glowTex. That texture is authored with a hot core so booths bleed
     past their silhouettes at hall zoom, and a hot core stretched 11ft down
     an aisle and then seen at a hero rake foreshortens into a hard bright
     LINE — it read as a lens scratch across the drawing. A pool of light on
     a floor has no core; it has a middle and an edge. */
  const poolTex = canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.42)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
  const noseM = glowMat(0xffc07a, 0.62); noseM.map = poolTex;
  const tailM = glowMat(0x7fb4ff, 0.85); tailM.map = poolTex;
  F.nose = mk(nose.geo(), noseM, 3);
  F.spot = mk(tail.geo(), tailM, 3);
  /* THESE fade with rake — and only these. It is the old streaks' own rule,
     kept for the only part of the fleet it was ever right for: an 11ft pool
     lying flat on the floor is a pool from above and a hard bright BAND
     once the camera drops to eye level, because a plane seen edge-on has
     nowhere to put its area. The trucks stay solid at every rake; their
     light steps back as the eye reaches the floor. */
  const pools = [noseM, tailM];
  /* contact shadow: the key's shadow map cannot follow these, so the thing
     that actually grounds a truck on the drawing is a soft blob under it */
  const blobM = new THREE.MeshBasicMaterial({ map: blobTex, color: 0x02040a,
    transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
  F.blob = mk(sq.clone().scale(13.5, 1, 6.2).translate(-1.0, 0.16, 0), blobM, 2);

  /* loaded trucks run at a show floor's posted 5mph; an empty one running
     back to the dock is quicker. `off` walks each truck a foot or so off
     its aisle centreline — nobody drives the painted line, and dead-centre
     was the last thing making the set read as being on rails. */
  const span = FLEET_X1 - FLEET_X0;
  const trucks = FLEET_PLAN.map((t, i) => {
    const dir = t.lane % 2 ? 1 : -1;
    return {
      z: FLEET_LANES[t.lane] / FT + t.off,
      dir, loaded: t.loaded, speed: t.speed,
      phase: (dir > 0 ? t.at - FLEET_X0 : FLEET_X1 - t.at) / span,
      seed: hash01(i + 53) * 6.28,
    };
  });
  /* the load rides on its own two meshes so an EMPTY truck — one running
     back to the dock for the next piece — can simply zero-scale them */
  const load = [F.crate, F.caps];
  const gone = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < N; i++) {
    if (trucks[i].loaded) continue;
    for (const m of load) m.setMatrixAt(i, gone);
  }
  state.fleet = { F, meshes, rig, load, trucks, pools, on: true, gone, span,
    dummy: new THREE.Object3D(), col: new THREE.Color() };
}
/* Trucks are wall-clock driven, like every other idle-layer thing on this
   screen — a hall does not stop working because the reader stopped
   scrolling. Scroll only decides how LOUD they are. */
function updateFleet(tSec, show, rake) {
  const S = state.fleet;
  if (!S) return;
  const rf = 1 - Math.min(1, Math.max(0, (rake - 26) / 26));
  for (let i = 0; i < S.pools.length; i++)
    S.pools[i].opacity = S.pools[i].userData.op0 * rf;
  /* THE FLEET CLEARS THE FLOOR FOR THE PUBLIC — by driving off it. As the
     doors beat opens, every truck is pushed toward the end of its lane and
     out of the drawing, and once past the end it stops being placed at all.
     It reads as the fleet getting out of the way, it staggers itself for
     free (a truck near the exit leaves first), and it is a pure function of
     `show`, so scrubbing back up brings them straight back.
     The obvious alternative — fading them — was tried and is wrong: a
     half-transparent solid does not recede, it turns into a ghost with the
     floor plan's booth numbers legible through its mast. */
  const on = show < 0.92;
  if (S.on !== on) {
    S.on = on;
    for (let i = 0; i < S.meshes.length; i++) S.meshes[i].visible = on;
  }
  if (!on) return;

  /* Wall clock, deliberately. There is no way to anchor this to the moment
     the reader arrives: the page paints one isolated frame from snap() on
     migl-ready, seconds after load and long before the section is near, so
     any "first paint" hook arms against page load and buys nothing. Which
     means the phase at arrival is effectively arbitrary — and that is why
     the spacing in FLEET_PLAN is guaranteed STRUCTURALLY rather than by
     the opening positions. */
  const tf = tSec;

  const d = S.dummy, F = S.F, rig = S.rig, push = show * S.span * 1.12;
  const park = (i) => {
    for (let k = 0; k < rig.length; k++) rig[k].setMatrixAt(i, S.gone);
  };
  for (let i = 0; i < S.trucks.length; i++) {
    const t = S.trucks[i];
    const u = (tf * t.speed + t.phase * S.span) % S.span + push;
    if (u > S.span) { park(i); continue; }
    const x = t.dir > 0 ? FLEET_X0 + u : FLEET_X1 - u;
    if (x < FLEET_IN || x > FLEET_OUT) { park(i); continue; }
    /* suspension bob and a lane-keeping wobble: a rigid truck sliding down
       a perfect line is the tell that it is a sprite, not a machine */
    d.position.set(x, Math.sin(tf * 4.3 + t.seed) * 0.035, t.z);
    d.rotation.set(
      Math.sin(tf * 2.7 + t.seed) * 0.013,
      (t.dir > 0 ? 0 : Math.PI) + Math.sin(tf * 0.55 + t.seed) * 0.011,
      0);
    d.updateMatrix();
    for (let k = 0; k < rig.length; k++) rig[k].setMatrixAt(i, d.matrix);
    if (!t.loaded) for (let k = 0; k < S.load.length; k++) S.load[k].setMatrixAt(i, S.gone);

    /* rotating amber beacon: a sharp sweep at ~1.3Hz, not a sine — a lamp
       that merely breathes reads as a glow, a lamp that SWEEPS reads as a
       machine moving under its own power */
    const b = 0.16 + 1.5 * Math.pow(0.5 + 0.5 * Math.cos((tf * 1.3 + t.seed) * 6.283), 4);
    F.beacon.setColorAt(i, S.col.setRGB(b, b, b));
  }
  for (let k = 0; k < rig.length; k++) rig[k].instanceMatrix.needsUpdate = true;
  F.beacon.instanceColor.needsUpdate = true;
}

/* THE PLAN GOES INTO GL (mobile). Measured 2026-08-19 on a 390x844 DPR-3
   phone profile: the DOM SVG floor plan re-rasterizes EVERY scroll frame
   under the changing 3D transform — 115ms median frames with it, 25ms
   without, while the whole WebGL scene costs ~0. No single sub-layer is
   the culprit (bisected: patterns/text/booths/aisles/furniture all ~100ms+
   individually); it is the aggregate vector load. So on narrow we raster
   the static drawing ONCE into a texture and let the GL layer draw it —
   the DOM keeps only the live bits (lasers, survey burns, booth hit
   targets), which measured smooth. */
function rasterizePlan(px, done) {
  try {
    const svg = document.querySelector('.mi-plan');
    if (!svg || !svg.cloneNode) return done(null);
    const clone = svg.cloneNode(true);
    Array.prototype.slice.call(clone.childNodes).forEach((n) => {
      if (n.nodeType !== 1) return;
      const tag = (n.tagName || '').toLowerCase();
      const cls = (n.getAttribute && n.getAttribute('class')) || '';
      if (tag === 'defs') return;
      if (cls.indexOf('fp-lay-plan') >= 0 || cls.indexOf('fp-lay-truss') >= 0) return;
      clone.removeChild(n);
    });
    /* STRIP THE LIVE CAMERA. paint() writes a scroll-driven `transform`
       onto these groups every frame, and cloneNode copies it — so the
       texture was baked WITH the camera of whatever frame happened to be
       on screen at load, and the whole drawing then sat MOBY (205 plan
       units) north of every GL element for the rest of the session.
       Measured 2026-08-20 against the aisle lines: it is why the aisle
       streaks looked like they ran through the booth rows. The texture
       must hold the drawing in plain viewBox space. */
    const lays = clone.querySelectorAll('.fp-lay-plan, .fp-lay-truss');
    for (let i = 0; i < lays.length; i++) lays[i].removeAttribute('transform');
    /* THE LIVE OVERLAYS MUST NOT BE BAKED. The survey burns and the
       laser trails are built by the page INTO .fp-lay-plan, so cloning
       that layer drags them along — and their selectors are .mi-*, which
       this rasteriser's `.fp|.mi-plan` filter does not collect. With no
       rule reaching them they fall back to SVG defaults: opacity 1 and
       fill BLACK, one opaque rectangle per work-order footprint. That is
       the blacked-out booth space (owner 2026-08-20); it sampled as pure
       rgb(0,0,0) in the texture. They are animated DOM anyway. */
    const liveBits = clone.querySelectorAll('.mi-laser, .mi-survey');
    for (let i = 0; i < liveBits.length; i++)
      liveBits[i].parentNode.removeChild(liveBits[i]);
    /* THE APRON GOES. Below the hall sits desktop draughting furniture —
       title block, scale bar, north compass, MAIN ENTRANCE. On a phone it
       is an unreadable dark band under the plan (owner 2026-08-20), and
       the stylesheet's own mobile rules never reach here: this rasteriser
       only copies rules that have a selectorText, so @media blocks are
       silently skipped. Drop the nodes instead. */
    /* NARROW ONLY. On desktop the apron IS the look — the title block,
       scale bar, compass and dimension rule are what make this read as a
       drawing rather than a diagram, and the letterbox mattes frame them
       instead of burying them. Dropping them here (which is what happened
       the first time this ran on desktop) quietly deleted half the
       draughting language. */
    if (state.narrow) {
      const drop = clone.querySelectorAll('.fp-tb, .fp-scale, .fp-north, .fp-dim, .fp-cols');
      for (let i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);
      const dockT = clone.querySelectorAll('.fp-dock text, .fp-door text');
      for (let i = 0; i < dockT.length; i++)
        if ((dockT[i].textContent || '').indexOf('MAIN ENTRANCE') >= 0)
          dockT[i].parentNode.removeChild(dockT[i]);
    }
    let css = '';
    for (let si = 0; si < document.styleSheets.length; si++) {
      let rules = null;
      try { rules = document.styleSheets[si].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (let ri = 0; ri < rules.length; ri++) {
        const r = rules[ri];
        if (r.selectorText && /\.fp|\.mi-plan/.test(r.selectorText)) css += r.cssText + '\n';
      }
    }
    const cs = getComputedStyle(document.documentElement);
    const gold = (cs.getPropertyValue('--accent-gold') || '#b8a573').trim();
    /* THE FOUR STANDS, PAINTED BY HAND. Their stylesheet rules do not
       survive into the raster document — measured 2026-08-20 by sampling
       the texture: a stand interior comes back as pure rgb(0,0,0), the
       SVG default fill, while every earlier .fp rule renders correctly.
       So on mobile each LVTSR stand read as a black hole punched in the
       floor plan (owner: "one of the booth spaces is completely blacked
       out"). An inline style attribute outranks any rule, so the stand
       is painted here instead: same glass as every other booth space,
       with the gold border and number still marking it as ours. */
    const paint = (sel, style) => {
      const n = clone.querySelectorAll(sel);
      for (let i = 0; i < n.length; i++) n[i].setAttribute('style', style);
    };
    paint('.fp-stand-bg', 'fill:none');
    paint('.fp-stand-r', 'fill:rgba(45,156,202,0.17);stroke:' + gold + ';stroke-width:1.6');
    paint('.fp-stand-g', 'fill:none;stroke:rgba(184,165,115,0.30);stroke-width:1;stroke-dasharray:4 4');
    paint('.fp-stand-n', 'fill:#d4bc7d');
    paint('.fp-stand-c', 'fill:rgba(212,188,125,0.7)');
    css = ':root{--accent-gold:' + gold + ';--wall:1;--plandim:0;}\n' +
      'svg{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}\n' +
      '.mi-plan{opacity:1;}\n' + css;
    const NSS = 'http://www.w3.org/2000/svg';
    const st = document.createElementNS(NSS, 'style');
    st.textContent = css;
    clone.insertBefore(st, clone.firstChild);
    const h = Math.round(px * VBH / VBW);
    clone.setAttribute('width', px);
    clone.setAttribute('height', h);
    clone.setAttribute('preserveAspectRatio', 'none');
    const str = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = px; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, px, h);
      done(c);
    };
    img.onerror = () => done(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
  } catch (e) { done(null); }
}
function buildPlanPlane(plan, renderer) {
  /* 2560 is the width the mobile camera actually resolves: DPR 2 x 350css
     = 700 device px showing 1600/3.4 = 470 plan units -> 2383px needed */
  /* 2560 is the width the mobile camera resolves. Desktop zooms further
     in (s ~2.9 shows ~550 plan units across the frame) so it wants more,
     but 4096 is a 64MB texture before mipmaps — real weight on exactly the
     old GPUs this change exists to help. 3072 is the compromise; the plan
     is dimmed under a hologram at the tightest framings anyway. */
  rasterizePlan(state.narrow ? 2560 : 3072, (c) => {
    if (!c) return;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;                 /* plan +y runs SOUTH = image rows down */
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    /* OWNER 2026-08-19: "everything just kind of blacks out… I want to
       actually see the booth layouts, I want everything to pop." The plan
       reads a touch under the stands so they stay the subject, but it
       stays legible — never a black void to scroll through. */
    /* near-full-strength COOL tint: the drawing's own cyan ink is the
       look now — the old amber multiply was the "morphed" palette */
    const m = new THREE.Mesh(new THREE.PlaneGeometry(VBW, VBH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true,
        color: new THREE.Color(0.80, 0.90, 1.00),
        depthWrite: false, fog: false, toneMapped: false }));
    m.position.set(VBW / 2, VBH / 2, 0.15);
    m.renderOrder = 0;
    plan.add(m);
    state.planPlane = m;
    /* the heavy vector layers retire — the live ones stay in the DOM */
    const dead = document.querySelectorAll('.fp-lay-plan, .fp-lay-truss');
    for (let i = 0; i < dead.length; i++) dead[i].style.display = 'none';
    window.__planInGL = true;
  });
}

/* ============ THE HOLOGRAM KIT ============
   The four stands are LIGHT, not matter: ice-cyan structural holograms
   projected onto their pads. Authoring rules (researched 2026-08-20):
   - the core ink rides JUST past the bloom knee (soft halo) while the
     construction front is authored ~8x, so bloom flares only the front —
     selective glow, never glow-fog;
   - the cyan is green-shifted (#3fd4e0 family): the luma-weighted bloom
     threshold taxes blue ~3x, so deep blue never blooms and ice-teal
     blooms cheap. AgX then rolls the hot core toward white on its own;
   - additive shaders multiply to BLACK instead of discarding — black
     adds nothing, keeps early-Z, keeps the reveal branchless;
   - scanlines are a pow3 sawtooth in MODEL Y so they stay continuous
     across merged parts and read "display", not "paint";
   - flicker is a BIRTH event only. A finished hologram is stable —
     a looping glitch is the #1 cheap tell (Westworld brief: appear
     "clean, like an Apple product").
   (The owner's four reference renders arrived late on 2026-08-20; the
   reference-matched rebuild lives in _holokit-v2-wip.js and swaps back
   in over this section when that work resumes.) */
const HOLO = {
  ink: new THREE.Color(0.25, 0.83, 0.88).multiplyScalar(1.55),
  hot: new THREE.Color(0.85, 0.985, 1.0).multiplyScalar(8.0),
};
const HOLO_SHARED = `
  uniform float uBuild, uH, uT, uFlash, uOp;
  uniform vec3 uInk, uHot;
  varying float vY;
  float h21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }`;
function holoLineMat(u) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: u,
    vertexShader: `varying float vY; varying vec2 vXZ;
      void main() {
        vY = position.y; vXZ = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: HOLO_SHARED + `
      varying vec2 vXZ;
      void main() {
        float building = step(0.001, 1.0 - uBuild) * step(0.001, uBuild);
        /* a CLEAN cut. Hash jitter read as TV static; a sine ripple read
           as dot-lattice interference on every horizontal slab. The hot
           front and the settle flash carry the drama alone. */
        float bY = uBuild * uH;
        float vis = 1.0 - step(bY, vY);
        float scan = 0.86 + 0.14 * pow(fract(vY * 0.55 - uT * 0.16), 3.0);
        /* birth flicker only — one hard 24Hz dropout while the front is live */
        float fl = 1.0 - building * 0.22 * step(0.86, h21(vec2(floor(uT * 24.0), 7.0)));
        float hot = smoothstep(bY - 2.2, bY, vY) * building;
        vec3 col = uInk * scan * fl * (1.0 + 1.6 * uFlash) + uHot * hot;
        gl_FragColor = vec4(col * vis, uOp * vis);
      }`,
  });
}
function holoShellMat(u) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: u,
    vertexShader: `varying float vY; varying vec3 vN; varying vec3 vNm; varying vec2 vXZ;
      void main() {
        vY = position.y; vXZ = position.xz;
        vN = normalMatrix * normal; vNm = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: HOLO_SHARED + `
      varying vec3 vN; varying vec3 vNm; varying vec2 vXZ;
      void main() {
        float building = step(0.001, 1.0 - uBuild) * step(0.001, uBuild);
        float bY = uBuild * uH;
        float vis = 1.0 - step(bY, vY);
        /* fresnel ghost surface; the silhouette ring a DoubleSide fresnel
           produces is folded back down so edges stay soft */
        float fr = pow(1.0 - abs(normalize(vN).z), 2.0);
        fr *= smoothstep(1.0, 0.35, fr);
        float scan = 0.72 + 0.28 * pow(fract(vY * 0.55 - uT * 0.16), 3.0);
        /* one broad survey band climbs the volume on the idle clock —
           the "alive" tell on a finished stand */
        float sweep = smoothstep(2.4, 0.0, abs(vY - fract(uT * 0.09) * uH));
        float hot = smoothstep(bY - 1.6, bY, vY) * building;
        /* decks and floors go NEAR-CLEAR: a filled horizontal face reads
           as aquarium glass — the hologram is an OUTLINE, the walls keep
           only their fresnel ghost */
        float horiz = clamp(abs(vNm.y), 0.0, 1.0);
        float body = mix(1.0, 0.30, horiz);
        vec3 col = uInk * (0.10 + 0.55 * fr) * scan * (1.0 + 1.6 * uFlash)
                 + uInk * sweep * 0.16 + uHot * hot * 0.32;
        gl_FragColor = vec4(col * vis,
          uOp * (0.035 + 0.26 * fr) * body * vis + uOp * 0.10 * hot * vis);
      }`,
  });
}
function holoRingMat(u) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: u,
    vertexShader: `varying vec2 vUv2;
      void main() { vUv2 = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uRing, uOp; uniform vec3 uInk;
      varying vec2 vUv2;
      void main() {
        vec2 p = vUv2 - 0.5;
        float r = length(p) * 2.0;
        /* the lock-in: a ring sweeps out across the pad... */
        float live = smoothstep(0.0, 0.05, uRing) * (1.0 - smoothstep(0.92, 1.12, uRing));
        float ring = smoothstep(0.085, 0.0, abs(r - uRing)) * live;
        /* ...and hands off to HAIRLINE corner brackets as the claim mark */
        vec2 a = abs(p);
        float frame = smoothstep(0.011, 0.003, abs(max(a.x, a.y) - 0.478))
                    * smoothstep(0.30, 0.40, min(a.x, a.y))
                    * smoothstep(0.95, 1.10, uRing);
        gl_FragColor = vec4(uInk * 1.6, uOp * (ring * 0.70 + frame * 0.20));
      }`,
  });
}
/* geometry collector: merges every part's silhouette edges into ONE
   LineSegments and every surface into ONE shell mesh per stand — 2 draw
   calls per stand, zero per-frame geometry work. `geo` is consumed. */
function holoCollect() {
  const line = [], shell = [];
  const m4 = new THREE.Matrix4(), eul = new THREE.Euler(),
        q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1),
        v = new THREE.Vector3();
  return {
    add(geo, x, y, z, ry, rx, thresh, rz) {
      /* rz (roll) added for holoDeck v2: sloped stair stringers and
         handrails need a rotation about the run axis' normal — a box long
         in x rolled by the pitch angle. YXZ order keeps ry/rx behaviour
         identical for every existing call. */
      eul.set(rx || 0, ry || 0, rz || 0, 'YXZ');
      q.setFromEuler(eul);
      v.set(x || 0, y || 0, z || 0);
      m4.compose(v, q, one);
      /* threshold 22 deg: cylinder facets vanish, real arrises stay */
      const e = new THREE.EdgesGeometry(geo, thresh == null ? 22 : thresh);
      e.applyMatrix4(m4);
      line.push(e.getAttribute('position').array);
      const s = (geo.index ? geo.toNonIndexed() : geo).applyMatrix4(m4);
      shell.push({ p: s.getAttribute('position').array,
                   n: s.getAttribute('normal').array });
      return this;
    },
    build() {
      const cat = (arrs) => {
        let n = 0; for (const a of arrs) n += a.length;
        const out = new Float32Array(n); let o = 0;
        for (const a of arrs) { out.set(a, o); o += a.length; }
        return out;
      };
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(cat(line), 3));
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position',
        new THREE.BufferAttribute(cat(shell.map(s => s.p)), 3));
      sg.setAttribute('normal',
        new THREE.BufferAttribute(cat(shell.map(s => s.n)), 3));
      return { lg, sg };
    },
  };
}
/* ============ THE FOUR HOLO STANDS ============
   PLACEHOLDER ARCHITECTURE (2026-08-20): the owner's reference renders
   arrived and a full rebuild to match them is staged in
   _holokit-v2-wip.js — these placeholders hold the choreography until
   that work resumes. Model space: feet, y up, x = long axis, z = toward
   the aisle. */
function holoDeck(c, d) {
  /* C1006 — 40x20 DOUBLE-DECK, v2 (2026-08-23). The v1 placeholder had
     toy architecture: 18in risers climbing to a point below the deck,
     rails with no opening at the stair head, a canopy on sticks. This
     rebuild follows a researched engineering brief (IBC 1011 stairs,
     beMatrix/ExpoDeck-type structure) — every number below is a real
     construction dimension in feet. Parti: deck over the back 12ft at
     12'0", open double-height front zone, hero stair as a solid closed-
     stringer wedge across the front face, rooftop sign blade carried by
     the back column lines. All heights sit on the 0.5ft raised floor. */
  const W = d.W, D = d.D, W2 = W / 2, D2 = D / 2;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const FL = 0.5;                    /* raised show floor (plinth top) */
  const DK = FL + 12.0;              /* deck walking surface */
  const R = 6.857 / 12, T = 11 / 12; /* riser 6-7/8in, tread 11in (IBC) */
  const SLOPE = Math.atan2(R, T);    /* 31.9deg — real stair pitch */
  const ZF = D2 - 7.3;               /* deck front face (back 12ft) */
  /* raised floor runs one foot shy of the pad line so every back-of-
     house element (wall, plates, closet) LANDS on it — jury r1: the
     back wall and plates hung past the old D-2 floor edge */
  c.add(B(W - 1, 0.5, D - 1), 0, 0.25, 0);

  /* -------- deck structure: columns > beams > joists > slab -------- */
  const COLX = [-W2 + 1.5, -W2 / 2 + 0.5, 0, W2 / 2 - 0.5, W2 - 1.5];
  for (const cx of COLX) {
    for (const cz of [ZF - 0.6, -D2 + 1.1]) {          /* two rows, 4in posts */
      c.add(B(0.35, 10.75, 0.35), cx, FL + 5.375, cz);
      c.add(B(1.0, 0.1, 1.0), cx, FL + 0.05, cz);      /* base plates */
    }
    /* primary beams span the short (12ft) way, row to row, tight under
       the slab with the column tops meeting their undersides */
    c.add(B(0.55, 0.9, ZF + D2 - 1.7), cx, DK - 1.0, ZF - 0.6 - (ZF + D2 - 1.7) / 2);
  }
  /* (joists deleted, jury r1: through a transparent slab they read as
     loose lumber lying ON the deck — beams + slab carry the story) */
  c.add(B(W - 1, 0.55, 12.0), 0, DK - 0.28, ZF - 6.0); /* deck slab */
  /* fascia lightbox band: ONE confident 2.5ft branded band wrapping all
     four deck edges, flush with the walking surface, corners closed */
  c.add(B(W - 0.7, 2.5, 0.3), 0, DK - 1.25, ZF + 0.05);
  c.add(B(W - 0.7, 2.5, 0.3), 0, DK - 1.25, ZF - 12.1);
  for (const s of [-1, 1])
    c.add(B(0.3, 2.5, 12.4), s * (W2 - 0.35), DK - 1.25, ZF - 6.05);

  /* -------- hero stair: 21 risers to the deck, wedge on the front ----
     top landing at x -11.4..-7.4 arrives flush with the deck through a
     4ft guardrail opening; 20 treads descend rightward from the landing;
     the 21st riser is the step off the bottom tread to the floor. */
  const SW2 = 2.0, SZ = ZF + 2.15;   /* 4ft hero width, band off the deck face */
  const TOPX = -7.4;
  for (let j = 1; j <= 20; j++) {
    const yt = DK - j * R, xf = TOPX + (j - 1) * T;
    c.add(B(T, 0.18, 3.9), xf + T / 2, yt - 0.09, SZ);           /* tread */
    /* closed riser UNDER each nosing, rising to the surface above it */
    c.add(B(0.1, R, 3.9), xf + 0.05, yt + R / 2, SZ);
  }
  /* the 21st riser: bottom tread edge down to the raised floor (inset a
     hair so it never draws coplanar with the tread face) */
  c.add(B(0.1, DK - 20 * R - FL, 3.9), TOPX + 20 * T - 0.06,
    (DK - 20 * R + FL) / 2, SZ);
  /* nosing line: (TOPX, DK) -> (TOPX+20T, DK-20R); everything sloped
     hangs off its midpoint. Raked ends are TRIMMED: ~1ft at the top so
     the panel dies inside the landing parapet, ~1ft at the bottom so it
     lands on the newel instead of overshooting the last riser. */
  const MX = TOPX + 10 * T, MY = DK - 10 * R, SL = 20 * T / Math.cos(SLOPE);
  /* closed outer stringer/balustrade: solid parapet 42in above nosings */
  c.add(B(SL - 1.8, 3.35, 0.14), MX - 0.09, MY + 1.58, SZ + SW2 - 0.1, 0, 0, 22, -SLOPE);
  c.add(B(SL - 1.8, 0.18, 0.3), MX - 0.09, MY + 3.65, SZ + SW2 - 0.1, 0, 0, 22, -SLOPE);
  /* grounded newel closes the wedge's bottom edge on both faces */
  c.add(B(0.5, 3.6, 0.2), 10.9, FL + 1.8, SZ + SW2 - 0.1);
  /* inner handrail at 36in riding the fascia, terminated both ends:
     a floor newel at the bottom, a landing post at the top */
  c.add(B(SL + 0.3, 0.15, 0.15), MX, MY + 3.0, SZ - SW2 + 0.15, 0, 0, 22, -SLOPE);
  c.add(B(0.12, 3.6, 0.12), 10.9, FL + 1.8, SZ - SW2 + 0.15);
  c.add(B(0.12, 3.0, 0.12), -7.6, DK + 1.5, SZ - SW2 + 0.15);
  /* sloped soffit plate closes the underside; trimmed clear of the floor
     at the foot and of the parapet at the head */
  c.add(B(SL - 3.2, 0.15, 3.9), MX - 0.51, MY - 0.98, SZ, 0, 0, 22, -SLOPE);
  /* under-stair storage: five stepped volumes riding the soffit line so
     the wedge reads SOLID (jury r1: two loose crates under a bridge) */
  for (const [x0, x1] of [[-7.4, -4.3], [-4.3, -1.2], [-1.2, 1.9],
                          [1.9, 5.0], [5.0, 8.1]]) {
    const top = DK - (x1 - TOPX) / T * R - 1.4;
    c.add(B(x1 - x0 - 0.05, top - FL, 3.8), (x0 + x1) / 2, (top + FL) / 2, SZ);
  }
  /* top landing: slab flush with the deck, closet below, parapet + end
     panel above — the horizontal rail run doubles as the 12in handrail
     extension past the top riser */
  c.add(B(4.0, 1.3, 4.0), -9.4, DK - 0.65, SZ);
  c.add(B(3.9, 10.7, 3.8), -9.4, FL + 5.35, SZ);
  c.add(B(4.2, 4.7, 0.14), -9.4, DK + 1.15, SZ + SW2 - 0.1);
  c.add(B(4.4, 0.18, 0.3), -9.4, DK + 3.5, SZ + SW2 - 0.1);
  c.add(B(0.14, 4.7, 3.9), -11.45, DK + 1.15, SZ);
  c.add(B(0.3, 0.18, 4.1), -11.45, DK + 3.5, SZ);

  /* -------- 42in glass guardrail on every open deck edge ------------
     posts + continuous top cap + glass infill; the front edge breaks at
     the stair head (x -11.4..-7.4) and returns with jamb posts there */
  const rail = (x0, z0, x1, z1) => {
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
    const n = Math.max(1, Math.round(L / 4.4));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      c.add(B(0.14, 3.4, 0.14), x0 + dx * t, DK + 1.7, z0 + dz * t);
    }
    const ry = Math.atan2(-dz, dx);
    c.add(B(L + 0.14, 0.18, 0.25), x0 + dx / 2, DK + 3.5, z0 + dz / 2, ry);
    c.add(B(L - 0.2, 2.7, 0.07), x0 + dx / 2, DK + 1.85, z0 + dz / 2, ry);
  };
  rail(-W2 + 0.65, ZF - 0.25, -11.45, ZF - 0.25);      /* front, left of stair */
  rail(-7.45, ZF - 0.25, W2 - 0.65, ZF - 0.25);        /* front, right of stair */
  for (const s of [-1, 1])                             /* both ends */
    rail(s * (W2 - 0.65), ZF - 0.35, s * (W2 - 0.65), -D2 + 0.75);
  /* back rail runs in three segments so glass and cap BUTT the sign
     fins (x +-8.95..9.95) instead of passing through them */
  rail(-W2 + 0.65, -D2 + 0.75, -10.0, -D2 + 0.75);
  rail(-8.9, -D2 + 0.75, 8.9, -D2 + 0.75);
  rail(10.0, -D2 + 0.75, W2 - 0.65, -D2 + 0.75);

  /* -------- under-deck program --------
     back wall LANDS on the raised floor and RISES to the slab underside
     (jury r1: it floated behind the plinth with a slot at the top) */
  c.add(B(W - 2, 11.45, 0.35), 0, FL + 5.725, -D2 + 0.75);
  /* rear elevation gets a designed face for the turntable: three
     recessed panel frames on the wall's outside */
  for (const px of [-13, 0, 13])
    c.add(B(8, 6, 0.18), px, FL + 4.0, -D2 + 0.48);
  c.add(B(14, 7, 0.3), 2, FL + 6.0, -D2 + 1.05);                 /* LED wall */
  /* glass meeting room, walls on the column lines, closed by the back
     wall; the thin front face reads as glass through the shell fresnel */
  c.add(B(8.95, 9, 0.08), -13.93, FL + 4.5, -1.9);
  c.add(B(0.3, 9, 7.1), -9.45, FL + 4.5, -5.45);
  c.add(B(0.3, 9, 7.1), -18.4, FL + 4.5, -5.45);
  c.add(B(9.25, 0.2, 7.3), -13.93, FL + 9.1, -5.45);
  for (const px of [12, 16.5])                         /* demo plinths */
    c.add(B(2.5, 3.0, 2.0), px, FL + 1.5, -2.5);

  /* -------- open front zone: one clean angled reception counter on the
     right, a 10ft media totem + inlaid floor graphic on the left -------- */
  c.add(B(6, 3.5, 2.5), 16.1, FL + 1.75, 7.3, -0.2);
  c.add(B(4, 10, 1.5), -15.5, FL + 5, 6.5);
  c.add(B(7, 0.06, 5), -15, FL + 0.06, 4.2);

  /* -------- deck hospitality, silhouette scale: 10ft bar against the
     back rail with four stools, two facing sofas + table clear of the
     4ft front circulation path, planters at the front corners -------- */
  c.add(B(8, 3.5, 2.0), -14.5, DK + 1.75, -8.0);                 /* bar */
  for (const sx of [-17, -15, -13, -11])
    c.add(new THREE.CylinderGeometry(0.75, 0.75, 2.5, 24), sx, DK + 1.25, -6.4);
  c.add(B(3, 1.2, 7), 6.6, DK + 0.6, -5.0);                      /* sofa seats */
  c.add(B(0.7, 2.6, 7), 4.85, DK + 1.3, -5.0);                   /* + backs */
  c.add(B(3, 1.2, 7), 11.4, DK + 0.6, -5.0);
  c.add(B(0.7, 2.6, 7), 13.15, DK + 1.3, -5.0);
  c.add(new THREE.CylinderGeometry(0.85, 0.85, 1.3, 32), 9, DK + 0.65, -5.0);
  for (const s of [-1, 1])                                       /* planters */
    c.add(B(2, 3, 2), s * 18.2, DK + 1.5, 1.2);

  /* -------- rooftop sign: two 1x3ft vertical fins continue the back
     column lines from the deck to 29ft; the 6ft blade spans between
     them and dies into their faces — no stub beams, no toothpicks */
  for (const s of [-1, 1])
    c.add(B(1.0, 16.5, 2.2), s * (W2 / 2 - 0.5), DK + 8.25, -D2 + 1.6);
  c.add(B(W / 2 - 2.0, 6, 0.55), 0, DK + 13.5, -D2 + 1.6);       /* blade */
}
function holoGate(c, d) {
  /* C3042 — 40x20 CLASSIC ISLAND, v3 (2026-08-23). v2 was a portal of
     clad towers + a truss header + rigged cubes: structurally correct
     but it read as a construction site, not an exhibit (owner: "too
     overly complex"). This is the language a show floor actually
     speaks — a graphic back wall with a brand header, an enclosed
     meeting room, an open demo floor, a reception counter, a lounge,
     and the one element that says TRADE SHOW at a glance: a hanging
     sign on cables up to the hall steel. Fewer, bigger, calmer parts. */
  const W = d.W, D = d.D, W2 = W / 2, D2 = D / 2;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const FL = 0.5;
  c.add(B(W - 1, 0.5, D - 1), 0, 0.25, 0);             /* raised floor */

  /* -------- back wall: 34ft of graphic, brand header, one return ----
     GRAPHICS FACE THE AISLE. They were mounted at -D2+0.72, which is
     the BACK face — every panel faced the neighbour and the money side
     was a blank slab (jury r1). Only the right end takes a return: the
     meeting room caps the left end, and a return there speared the
     room's roof and a chair. */
  c.add(B(34, 14, 0.5), 0, FL + 7, -D2 + 1);
  for (const px of [-3.2, 5, 13.2])                    /* graphic panels */
    c.add(B(6.4, 9, 0.2), px, FL + 6.5, -D2 + 1.35);
  c.add(B(34.4, 2, 0.9), 0, FL + 13.3, -D2 + 1);       /* header band */
  c.add(B(34.4, 0.6, 1.0), 0, FL + 0.3, -D2 + 1);      /* base */
  c.add(B(0.5, 14, 4), 17, FL + 7, -D2 + 2.75);        /* end return */

  /* -------- enclosed meeting room, left end, flush to the wall line
     (it used to hang 2ft past it, leaving a 2x9ft hole in its back) -- */
  for (const px of [-15.5, -8.5])                      /* front, door gap */
    c.add(B(3, 9, 0.15), px, FL + 4.5, 0.25);
  for (const px of [-17, -7])                          /* side walls */
    c.add(B(0.15, 9, 9.3), px, FL + 4.5, -4.4);
  c.add(B(10.2, 0.3, 9.4), -12, FL + 9.15, -4.35);     /* roof */
  c.add(B(4.2, 0.3, 0.3), -12, FL + 8.85, 0.25);       /* door header */
  c.add(B(5, 2.5, 3), -12, FL + 1.25, -4);             /* table */
  for (const cx of [-16, -8]) for (const cz of [-5.5, -2.5])
    c.add(B(1.6, 2.8, 1.6), cx, FL + 1.4, cz);         /* chairs */

  /* -------- open demo floor: three plinths with monitors -------- */
  for (const px of [-1, 5, 11]) {
    c.add(B(3, 3, 2), px, FL + 1.5, -1);
    c.add(B(3.4, 2.2, 0.25), px, FL + 4.1, -1);
  }
  /* -------- brand lightbox tower: 20ft so it reads as a beacon over
     the 14.8ft wall header, not as a bump on the end of it -------- */
  c.add(B(3.5, 20, 3.5), 17, FL + 10, -1.5);
  c.add(B(4, 0.5, 4), 17, FL + 0.25, -1.5);
  /* -------- reception counter, angled to the aisle -------- */
  c.add(B(8, 3.5, 2.5), 13, FL + 1.75, 6.5, -0.25);
  c.add(B(8.2, 0.2, 2.7), 13, FL + 3.6, 6.5, -0.25);
  /* -------- lounge, front left: it was sitting dead centre blocking
     the walk-in while the front-left quadrant sat empty -------- */
  for (const cx of [-15, -10])
    c.add(B(2.5, 2.2, 2.5), cx, FL + 1.1, 5.5);
  c.add(new THREE.CylinderGeometry(1.2, 1.2, 1.3, 12), -12.5, FL + 0.65, 5.5);

  /* -------- THE HANGING SIGN: 22x8 banner, bottom at 18.5ft, flown
     on four cables to the hall steel (the booth itself carries none of
     it — this is the one honestly-flown element on the floor) ------- */
  c.add(B(22, 4, 8), 0, FL + 20, -2);
  for (const sx of [-11, 11]) for (const sz of [-6, 2])
    c.add(B(0.07, 5, 0.07), sx, FL + 24.5, sz);
}
function holoCanyon(c, d) {
  /* C5020 — 60x20 LED THEATRE, v3 (2026-08-23). v2 was two angled 20ft
     LED walls on four ground-support towers each, plus a six-legged
     truss ring — every bit of it code-correct and every bit of it
     visible, so the booth read as its own falsework (owner: "too overly
     complex"; jury: "structure outshouting content", "a leg in the
     money shot"). v3 says the same thing with a fraction of the parts:
     ONE big LED wall you can actually read, angled graphic wings, a
     theatre of benches facing it, demo pods, and a long hanging banner.
     The wall's support is four slim posts and a rail behind it —
     present, honest, and out of the picture. */
  const W = d.W, D = d.D, W2 = W / 2, D2 = D / 2;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const FL = 0.5;
  c.add(B(W - 1, 0.5, D - 1), 0, 0.25, 0);             /* raised floor */

  /* -------- the hero: one 32x16 LED wall + brand header --------
     seams on an 8ft module: 32 divides into four clean bays. A 4ft
     module put twelve verticals across the hero surface and the wall
     read as a mullioned cage (jury r2) — and pushing them to +-14 left
     2ft half-cabinets at the ends. Four lines, four bays, done. */
  c.add(B(32, 16, 0.7), 0, FL + 8, -8.2);
  for (const px of [-8, 0, 8])                         /* cabinet seams */
    c.add(B(0.25, 16, 0.9), px, FL + 8, -8.2);
  c.add(B(32, 0.25, 0.9), 0, FL + 8, -8.2);
  c.add(B(32.4, 2, 1.0), 0, FL + 17, -8.2);            /* header band */
  /* ground support: four posts + a rail, LANDING on the deck (the base
     plates used to cantilever 3in off the back edge) and finishing at
     the wall top so the header hides them */
  for (const px of [-12, -4, 4, 12]) {
    c.add(B(0.8, 16, 0.8), px, FL + 8, -8.7);
    c.add(B(1.6, 0.25, 1.6), px, FL + 0.125, -8.7);
  }
  c.add(B(32, 0.6, 0.6), 0, FL + 15.5, -8.95);
  /* -------- angled graphic wings, lapping ~1ft onto the wall ends --- */
  for (const s of [-1, 1]) {
    c.add(B(10, 14, 0.5), s * 19.3, FL + 7, -6.2, -s * 0.5);
    c.add(B(10.2, 0.5, 1.0), s * 19.3, FL + 0.25, -6.2, -s * 0.5);
  }
  /* -------- theatre: three bench rows on a 4ft pitch. At a 3ft pitch
     with 2.5ft benches there were six inches of legroom and the rows
     fused into one striped slab (jury r2). -------- */
  for (const cz of [-4, 0, 4])
    c.add(B(18, 1.5, 1.6), 0, FL + 0.75, cz);
  /* -------- reception counter, front left -------- */
  c.add(B(8, 3.5, 2.5), -18, FL + 1.75, 6.5, 0.25);
  c.add(B(8.2, 0.2, 2.7), -18, FL + 3.6, 6.5, 0.25);
  /* -------- demo pods, front right -------- */
  for (const px of [13, 19, 25]) {
    c.add(B(3, 3, 2), px, FL + 1.5, 6.5);
    c.add(B(3.4, 2.2, 0.25), px, FL + 4.1, 6.5);
  }
  /* -------- brand lightbox towers: 18ft, bookending the wall header
     on its own datum instead of matching the wings' 14 -------- */
  for (const s of [-1, 1]) {
    c.add(B(3.5, 18, 3.5), s * 27.4, FL + 9, -4);
    c.add(B(3.8, 0.5, 3.8), s * 27.4, FL + 0.25, -4);
  }
  /* -------- hanging banner: spans the BOOTH (40ft), not the screen,
     with clear daylight over the header — at 28ft sitting 1ft into the
     header band it had stopped reading as flown (jury r2) -------- */
  c.add(B(40, 3.5, 6), 0, FL + 21.25, 0);
  for (const sx of [-20, 20]) for (const sz of [-3, 3])
    c.add(B(0.07, 2.5, 0.07), sx, FL + 24.25, sz);
}
function holoHalo(c, d) {
  /* C7050 — 20x20 HALO PAVILION, v3 (2026-08-23). The crown has a LOAD
     PATH now: the totem's mast carries the upper ring on four spoke
     arms, and the lower ring hangs from the upper on four RAKED rods.
     (Vertical rods were the v2 bug — a vertical rod cannot join two
     rings of different radii, it lands inside one shell and outside
     the other, so the lower ring hung on nothing.) The drum was also
     dropped to 12ft and its studs halved: at 13.5ft with 17 studs it
     was a palisade fence that swallowed the aisle opening and left the
     crown reading as a lid rather than a halo. Taper 7.3 -> 6.5 -> 6.0
     so the crown genuinely overhangs. */
  const W = d.W, D = d.D, D2 = D / 2;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const C = THREE.CylinderGeometry;
  const FL = 0.5;
  const DR = 6.0, DH = 12, DCZ = -2.1,
        A0 = 80 * Math.PI / 180, AL = 200 * Math.PI / 180;
  c.add(B(W - 1, 0.5, D - 1), 0, 0.25, 0);             /* raised floor */

  /* -------- drum: 200deg shell opening to the aisle, floor/mid/top
     tracks and studs every 25deg, radial returns at both open ends --- */
  c.add(new C(DR + 0.05, DR + 0.05, DH, 48, 1, true, A0, AL),
    0, FL + DH / 2, DCZ);
  for (let k = 0; k <= 8; k++) {
    const a = A0 + AL * k / 8;
    c.add(B(0.22, DH, 0.22), DR * Math.sin(a), FL + DH / 2,
      DCZ + DR * Math.cos(a));
  }
  for (const ty of [0.125, DH / 2, DH - 0.15])
    for (let k = 0; k < 8; k++) {
      const a = A0 + AL * (k + 0.5) / 8;
      c.add(B(2.62, 0.25, 0.25), DR * Math.sin(a), FL + ty,
        DCZ + DR * Math.cos(a), a);
    }
  for (const s of [-1, 1]) {
    const a = s > 0 ? A0 : A0 + AL;
    c.add(B(2, DH, 0.3), (DR - 1) * Math.sin(a), FL + DH / 2,
      DCZ + (DR - 1) * Math.cos(a), a - Math.PI / 2);
  }
  /* -------- central totem + the mast that carries the crown -------- */
  c.add(B(4, 0.75, 4), 0, FL + 0.375, DCZ);            /* base plinth */
  c.add(B(2.5, 15, 2.5), 0, FL + 8, DCZ);              /* totem */
  c.add(B(0.7, 4.25, 0.7), 0, FL + 17.375, DCZ);       /* mast, flush at 20 */
  /* -------- upper halo on four spoke arms, set at the band's centre
     so the ring screens them (at the top edge they read as a gunsight
     X sitting on the crown) -------- */
  c.add(new C(7.3, 7.3, 2, 48, 1, true), 0, FL + 18.5, DCZ);
  c.add(B(14.6, 0.3, 0.45), 0, FL + 18.5, DCZ);        /* spokes x */
  c.add(B(0.45, 0.3, 14.6), 0, FL + 18.5, DCZ);        /* spokes z */
  /* -------- lower halo on four RAKED rods: rz tilts each rod inside
     its own radial plane, then ry = a - PI/2 swings that plane to
     azimuth a. Ends land on r 7.3 / y 18.1 and r 6.5 / y 17.0. ------ */
  c.add(new C(6.5, 6.5, 1.5, 48, 1, true), 0, FL + 15.75, DCZ);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    c.add(B(0.35, 1.36, 0.35), 6.9 * Math.sin(a), FL + 17.05,
      DCZ + 6.9 * Math.cos(a), a - Math.PI / 2, 0, 22, -0.629);
  }
  /* -------- aisle counter: a 6ft round reception, which is what a
     20x20 pavilion needs — the 3ft one read as a stool, and the two
     loose planter cubes read as debris and are gone -------- */
  c.add(new C(3, 3, 3.5, 16), 5.8, FL + 1.75, 6.3);
  c.add(new C(3.2, 3.2, 0.18, 32), 5.8, FL + 3.6, 6.3);
  c.add(new C(6.8, 6.8, 0.06, 48, 1, true), 0, FL + 0.03, DCZ);
}
function mountHolo(bo, designFn) {
  const c = holoCollect();
  designFn(c, bo.dims);
  const g = c.build();
  const u = {
    uBuild: { value: 0 }, uH: { value: bo.dims.H }, uT: state.holoT,
    uFlash: { value: 0 }, uOp: { value: 1 },
    uInk: { value: HOLO.ink }, uHot: { value: HOLO.hot },
  };
  const shell = new THREE.Mesh(g.sg, holoShellMat(u));
  const lines = new THREE.LineSegments(g.lg, holoLineMat(u));
  shell.renderOrder = 8; lines.renderOrder = 9;
  shell.frustumCulled = lines.frustumCulled = false;
  /* layer 2 = the mirror-pass set: the hologram doubles in the wet floor
     but stays OUT of the depth prepass (layer 1), so AO and the aerial
     haze never treat light as matter */
  shell.layers.enable(2); lines.layers.enable(2);
  bo.group.add(shell); bo.group.add(lines);
  /* the pad furniture lives on its OWN group under the mount — the lock
     ring and floor glow must not bob or turn with the model */
  const fx = new THREE.Group();
  bo.mount.add(fx); bo.fx = fx;
  const ru = { uRing: { value: 0 }, uOp: { value: 1 }, uInk: { value: HOLO.ink } };
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), holoRingMat(ru));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  ring.scale.set(bo.dims.W + 6, bo.dims.D + 6, 1);
  ring.renderOrder = 7; ring.frustumCulled = false;
  fx.add(ring);
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: glowTex, color: 0x2aa8d8,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.05;
  pad.scale.set(bo.dims.W * 2.0, bo.dims.D * 2.0, 1);
  pad.renderOrder = 6; pad.frustumCulled = false;
  fx.add(pad);
  bo.holo = { u, ru, padM: pad.material, spin: 0, amp: 0 };
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
  /* NEUTRAL-DARK AMBIENT. This used to be a blue sky at full strength and
     it was over half the light in the scene: an omnidirectional wash means
     nothing has a dark side, and a blue wash is the direct complement of
     our warm accent so it desaturated it to khaki. Ambient is now dim and
     neutral; the warm key does the modelling. */
  const hemi = new THREE.HemisphereLight(0x171314, 0x1a1206, 1.0);
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
  /* the rim is a NEUTRAL warm now — at 0xff9d5c its specular painted an
     unmotivated orange pool onto the wet floor at every hero rake (r2) */
  const rim = new THREE.DirectionalLight(0xcfb59c, 2.0);
  rim.position.set(1400, -1200, 1800);  /* behind-right, HIGH — edge light */
  plan.add(rim); plan.add(rim.target);
  rim.target.position.set(800, 760, 0);
  /* camera-side fill so verticals facing the viewer never fall to black —
     dropped hard so it stops flattening what the key sculpts */
  const fill = new THREE.DirectionalLight(0xbfc4cc, 0.5);
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
  state.scene.fog = new THREE.Fog(0x080605, 0, 1);

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
  /* the roof chords sweep across frame as long stray diagonals at a low
     hero camera — kept as a list so paint can retire them when the eye
     drops to floor level */
  state.roofSteel = [
    noSh(finArray(5, boxGeo(2400, 1.2, 1.2), steelM, (d, i) => {
      d.position.set(800, 210 + i * 270, roofZ);
    })),
    noSh(finArray(7, boxGeo(1.2, 1900, 1.2), steelM, (d, i) => {
      d.position.set(140 + i * 250, 740, roofZ + 4);
    })),
  ];
  state.roofSteel.forEach(o => plan.add(o));
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
    /* catwalks gate with the roof set — from straight above they read
       as debris lying on the drawing (r2) */
    state.roofSteel.push(cw, lamp);
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
  /* THE EDGE FADE. Sizing the walls bigger never fixed this: whatever
     the size, a wall is a rectangle, and at the low rakes the hero
     cameras use its own boundary lands in frame as a hard-edged slab
     lying over the stand (measured — hiding this one mesh removed the
     edge). So the boundary is dissolved in the texture's ALPHA instead:
     transparent at the top and down both sides, opaque toward the floor.
     No edge exists to be seen at any camera. */
  {
    const g = wallTex.image.getContext('2d');
    const px = g.getImageData(0, 0, 1024, 160);
    const d = px.data;
    for (let y = 0; y < 160; y++) {
      const fy = Math.min(1, Math.max(0, (y - 8) / 96));      /* 0 top -> 1 low */
      for (let x = 0; x < 1024; x++) {
        const ex = Math.min(x, 1023 - x) / 150;
        const fx = Math.min(1, Math.max(0, ex));
        d[(y * 1024 + x) * 4 + 3] = Math.round(255 * fy * fx);
      }
    }
    g.putImageData(px, 0, 0);
    wallTex.needsUpdate = true;
  }
  wallTex.wrapS = THREE.ClampToEdgeWrapping;
  wallTex.wrapT = THREE.ClampToEdgeWrapping;
  /* THE WALLS MUST NEVER SHOW AN EDGE. They were sized to the hall, so at
     the low rakes the hero cameras use, a wall's own rectangle lands
     inside the frame — a hard-edged lighter slab sitting over the stand.
     Oversize them well past the hall and repeat the texture so the
     ribbing keeps its real scale. */
  const WALL_H = (bayZ + 40) * 3.2;
  const mkWall = (w0, x, y, rz) => {
    const w = w0 * 2.3;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, WALL_H),
      new THREE.MeshBasicMaterial({ map: wallTex, fog: false,
        side: THREE.DoubleSide, color: new THREE.Color(0.46, 0.34, 0.30),
        transparent: true, depthWrite: false }));
    m.renderOrder = -10;
    m.rotation.x = Math.PI / 2;
    m.rotation.y = rz;
    m.position.set(x, y, WALL_H / 2 - 4);
    plan.add(m);
    return m;
  };
  /* THE FOUR WALL PLANES ARE RETIRED. Measured, not guessed: bisecting
     every mesh in the scene by screenshot showed that hiding ONE of these
     removed most of the hard-edged slab that was sitting across the hero
     frame. A wall is a rectangle, and at the low rakes these cameras use
     its own boundary lands in shot. Oversizing it and fading its alpha
     both failed; the void cap below is a cylinder and has no boundary to
     show, so it does the same job — keeping the hall from ending in pure
     black — without the artifact. mkWall is kept for the graphic it
     carries in case a future camera wants a real back wall. */
  void mkWall;
  /* NO SHELL AROUND THE HALL (owner 2026-08-20). What used to sit here
     was a void-cap cylinder plus a wide radial-gradient ground apron,
     both meant to stop a raked horizon running into pure black. On a
     real desktop they read as exactly what the owner called them — "a
     radius wall or skirt or blinder" curving up around the floor as the
     camera tilts into the hall. The brief is an OPEN map: the drawing
     floats on the page's own dark ground, nothing rings it, and nothing
     may ever stand between the eye and the plan. The frame edges are
     softened by the CSS vignette and fog overlays instead of geometry. */
  /* (NEIGHBOR MASSING DELETED — owner 2026-08-20: the ring of dark
     blocks read as "a complete wall around the whole hall" that the
     camera could end up behind. Nothing solid may ever stand between the
     eye and the floor plan again; the hall's depth cue is now the lit
     plan itself receding into the void-cap grade.) */
  state.fixtures = [];
  /* six rows: four over the hall, two beyond its north/south edges so the
     booth chapters (which look across the hall) get a lid in their upper
     third instead of void */
  /* THE FIXTURE HAS A SHAPE (owner 2026-08-21: the hanging lights "read
     as lackluster, underbuilt"). A flat-shaded box on a stick with a
     sprite under it is three marks of the SAME value, so the eye reads a
     stick with a dot and nothing more. A high-bay is legible because it
     has three VALUES stacked: dark housing, a mid-tone reflector bell
     catching light on its inner face, and a hot lens at the mouth. That
     is what is added here — no extra light sources, no extra draw
     complexity worth measuring, and all three tiers still ride the same
     row snap-on so the doors surge is unchanged. */
  /* sized for the SHOT, not for scale realism: these are read across the
     hall at a grazing angle, where a shallow bell collapses to a 3px
     line. A deep bell keeps a silhouette from anywhere on the floor. */
  const reflGeo = new THREE.CylinderGeometry(6.5, 13, 12, 14, 1, true);
  const lensGeo = new THREE.CircleGeometry(12, 18);
  for (let r = 0; r < 4; r++) {
    const y = 240 + r * 350;
    const housingMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.09, 0.11, 0.14), fog: false,
      transparent: true, opacity: 0 });
    /* the bell sits a stop above the housing so the two never merge into
       one silhouette; DoubleSide because the lit face is the INSIDE */
    const reflMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.20, 0.24, 0.29), fog: false,
      side: THREE.DoubleSide, transparent: true, opacity: 0 });
    /* the stem and boss need their OWN material: M.dark is shared with
       half the scene, and the ceiling fades independently of all of it */
    const metalMat = M.dark.clone();
    metalMat.transparent = true; metalMat.opacity = 0;
    const lensMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 1.45, 1.05), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: false, fog: false, side: THREE.DoubleSide });
    const spriteMat = new THREE.SpriteMaterial({ map: glowTex,
      color: new THREE.Color(2.6, 2.35, 1.7), blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false, opacity: 0 });
    for (let i = 0; i < 6; i++) {
      const x = 190 + i * 250;
      const h = new THREE.Mesh(boxGeo(12, 12, 9), housingMat);
      h.position.set(x, y, bayZ);
      plan.add(h);
      /* reflector bell, flaring DOWN: CylinderGeometry runs along +Y and
         rotation.x=PI/2 maps +Y to +Z, so radiusTop is the narrow end at
         the housing and radiusBottom is the wide mouth below it */
      const refl = new THREE.Mesh(reflGeo, reflMat);
      refl.rotation.x = Math.PI / 2;
      refl.position.set(x, y, bayZ - 10.5);   /* hangs off the housing base */
      plan.add(refl);
      /* the lens: a hard bright disc across the mouth. The sprite alone
         was a soft blob with no edge — this gives the fixture a source */
      const lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.set(x, y, bayZ - 16.2);   /* flush across the bell mouth */
      lens.renderOrder = 3;
      plan.add(lens);
      /* suspension stem: the vertical line above the dot is what makes it
         read as HANGING rather than sitting on the floor */
      const stem = new THREE.Mesh(boxGeo(1.6, 1.6, 26), metalMat);
      stem.position.set(x, y, bayZ + 17.5);
      plan.add(stem);
      /* and it has to hang FROM something — a boss where the stem meets
         the deck, so the run terminates instead of fading out */
      const boss = new THREE.Mesh(boxGeo(5, 5, 1.6), metalMat);
      boss.position.set(x, y, bayZ + 30.5);
      plan.add(boss);
      /* small hot points, not floating orbs — high-bays at 44ft are dots.
         Dropped below the new mouth so the glare reads as light LEAVING
         the fixture rather than the housing itself being incandescent. */
      const sp = new THREE.Sprite(spriteMat);
      sp.scale.setScalar(17); sp.position.set(x, y, bayZ - 18); sp.renderOrder = 3;
      plan.add(sp);
      state.fixtures.push({ parts: [h, refl, lens, stem, boss, sp], x, y, z: bayZ });
    }
    state.houseRows.push({ housingMat, spriteMat, reflMat, lensMat, metalMat,
      base: new THREE.Color(0.10, 0.12, 0.15),
      on: new THREE.Color(0.95, 0.9, 0.72),
      /* the bell runs a full stop ahead of the housing all day and goes
         hotter at doors — that value gap IS the form. Both sit LOW: a
         pale fixture reads as a row of chalky traffic cones, and the
         thing that should be bright up there is the lamp, not the metal. */
      reflBase: new THREE.Color(0.20, 0.24, 0.30),
      reflOn: new THREE.Color(1.10, 1.02, 0.80) });
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
      uCol: { value: new THREE.Color(1.0, 0.92, 0.78) } },
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
         /* SOFT SILHOUETTE: the old smoothstep(.04,.60) left a hard rim,
            so the shafts read as opaque grey traffic cones. Squaring a
            wide falloff makes the edge vanish into the air instead. */
         float edge = abs(normalize(vN).z);
         edge = edge * edge * smoothstep(0.0, 0.92, edge);
         float t = clamp(vP.y / 212.0 + 0.5, 0.0, 1.0);
         float ang = atan(vP.x, vP.z);
         float n = 0.72 + 0.18 * sin(ang * 6.0 + uT * 0.4 + vP.y * 0.06)
                        + 0.10 * sin(ang * 13.0 - uT * 0.27);
         /* inverse-square-ish drop plus an invisible top quarter: light
            leaves the fixture, it does not glow along its whole length */
         float a = uOp * edge * n * (0.06 + 1.15 * pow(t, 2.4));
         a *= smoothstep(0.0, 0.10, t) * smoothstep(1.0, 0.72, t);
         /* ordered dither — the smooth gradient banded hard on 8-bit */
         float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
         a += (d - 0.5) * 0.006;
         gl_FragColor = vec4(uCol, max(a, 0.0));
       }`
  });
  state.shaftMats = [];
  for (let r = 0; r < state.houseRows.length; r++) state.shaftMats.push(mkShaftMat());
  /* apex parks at the new bell mouth (bayZ-17) so the beam leaves the
     fixture instead of starting inside the reflector and poking out */
  const shaftGeo = new THREE.ConeGeometry(19, bayZ - 17, 18, 1, true);
  state.shaftPools = [];
  let fi2 = 0;
  for (const f of state.fixtures) {
    const row = Math.round((f.y - 240) / 350);
    if (row < 0 || row > 3) continue;
    /* HALF THE SHAFTS. Twenty-four evenly spaced identical beams read as
       a row of traffic cones; a checker keeps the rhythm irregular and
       lets each remaining beam matter (critics, unanimous). */
    if ((fi2++ + row) % 2) continue;
    const cone = new THREE.Mesh(shaftGeo, state.shaftMats[row]);
    cone.rotation.x = Math.PI / 2;     /* apex up at the fixture */
    cone.position.set(f.x, f.y, (bayZ - 17) / 2);
    cone.renderOrder = 4;
    plan.add(cone);
    f.parts.push(cone);
    /* the beam has to LAND: a real pool, sized to the cone's 19-unit
       mouth and warm like its source, or the shaft terminates in mid-air */
    const pm = new THREE.MeshBasicMaterial({ map: glowTex,
      color: new THREE.Color(1.35, 1.18, 0.92), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const pool2 = new THREE.Mesh(new THREE.PlaneGeometry(96, 74), pm);
    pool2.position.set(f.x, f.y, 0.7);
    pool2.renderOrder = 2;
    plan.add(pool2);
    f.parts.push(pool2);
    state.shaftPools.push({ m: pm, row });
  }

  /* the house glow: one soft wash over the whole hall floor that rises with
     the doors surge — "lights on" must LIFT the room, not just the booths */
  const houseGlow = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1620),
    new THREE.MeshBasicMaterial({ map: glowTex, color: 0x9cb4c6,
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

  /* THE PLAN IS A TEXTURE EVERYWHERE NOW (owner 2026-08-22). This was
     mobile-only because the DOM SVG carried the booth hit targets for the
     tap-a-quote panel, and baking it killed them. That feature is gone, so
     desktop gets the same treatment — which matters, because desktop was
     the choppy one precisely BECAUSE it kept re-rasterising the whole
     vector drawing every scroll frame under a changing transform.
     Note this also retires the DOM survey-laser overlay on desktop: it
     lives inside .fp-lay-plan, which this hides. Mobile has shipped
     without it since 2026-08-19; the GL pad ring and corner brackets carry
     that beat now. */
  buildPlanPlane(plan, renderer);
  if (!mi.narrow) buildCrowd(plan);
  /* (the hall-dust Points cloud is DELETED — owner 2026-08-20: "little
     sparkles that are really doing nothing… zero value". The electricity
     lives in the aisle current below instead.) */
  /* ============ THE AISLE CURRENT ============
     Was three shader ribbons — "streaks of light running down the aisles".
     Now it is six forklifts hauling exhibit freight down the same three
     lanes, in the same directions, at the same unhurried pace. See THE
     FREIGHT FLEET above for the machine and why it is built the way it is. */
  buildFleet(plan);
  /* ================= THE STAND SEAM =================
     Every stand design was removed on 2026-08-20 for a clean restart.
     What survives below is the MOUNT: one group per work order, already
     positioned on the floor plan and already carrying the model->plan
     transform, so a new design only has to build in model space —
     feet, y up, z toward the aisle, origin at the centre of the pad.
     Drop builders into this array (one per work order) and they receive
     a booth object `bo` with `bo.group` (add geometry here), `bo.dims`
     {W, D, H} in feet, and `bo.mount`. Nothing else is assumed. */
  const builders = [
    (bo) => mountHolo(bo, holoDeck),
    (bo) => mountHolo(bo, holoGate),
    (bo) => mountHolo(bo, holoCanyon),
    (bo) => mountHolo(bo, holoHalo),
  ];
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
    if (builders[i]) builders[i](bo);
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
      /* NEAR-BLACK NAVY, high roughness, faint env: under the warm doors
         key the old grey floor went TAN and buried the cyan drawing (r2).
         The wet layer is a reflection carrier now, never a slab. */
      color: 0x0e1219, roughness: 0.92, metalness: 0.0,
      roughnessMap: roughTex, transparent: true, depthWrite: false,
      envMap: state.envTex, envMapIntensity: 0.08,
    });
    state.wetU = { value: 0 };
    state.reflU = { value: null };
    state.reflRes = { value: new THREE.Vector2(1, 1) };
    wetMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {

        uWet: state.wetU, uRefl: state.reflU, uReflRes: state.reflRes,
      });
      /* The footprint gate that used to drive this came from the stand
         print and went out with it. Coverage is now just uWet, which the
         day/show script owns. The reflection is deliberately weak — the
         owner asked for a floor that is lighter and NOT a mirror. */
      sh.fragmentShader = ('uniform float uWet;\n' +
        'uniform vec2 uReflRes;\n' +
        'uniform sampler2D uRefl;\n') + sh.fragmentShader
        .replace('#include <dithering_fragment>',
          `#include <dithering_fragment>
           float wCov = clamp(uWet, 0.0, 1.0);
           vec2 rUv = vec2(gl_FragCoord.x / uReflRes.x, 1.0 - gl_FragCoord.y / uReflRes.y);
           vec3 refl = texture2D(uRefl, rUv).rgb;
           gl_FragColor.rgb += min(refl * 0.10, vec3(0.4)) * wCov;
           gl_FragColor.a *= wCov * 0.55;`);
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

  /* (the roaming warm work-lamp pools are gone — an amber smear drifting
     through a cyan hologram read as a projector fault, not a crew) */

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
    /* uv1 GUARANTEE. The surface maps sample channel 1 (object-space
       feet, set by boxGeo). Plane/Cylinder/custom geometries have no uv1,
       and three compiles ROUGHNESSMAP_UV = uv1 regardless -> "undeclared
       identifier" and a dead shader. Fall those back to uv. */
    if (o.isMesh && o.geometry && o.geometry.attributes &&
        o.geometry.attributes.uv && !o.geometry.attributes.uv1) {
      o.geometry.setAttribute('uv1', o.geometry.attributes.uv);
    }
    /* layer 1 = the depth prepass set: opaque geometry only, so sprites
       and glows never write depth into the AO / aerial-perspective pass */
    if (o.isMesh && m && !m.isSpriteMaterial && !o.userData.noPre &&
        (!m.transparent || m.isMeshBasicMaterial)) o.layers.enable(1);
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
/* the AIR IS NAVY now, never brown-black: fog, sky and floor bounce all
   live in the brand's cool family so the hall reads as one deep blue
   room with a luminous drawing on its floor (owner 2026-08-20) */
const _fogCold = new THREE.Color(0x060a12), _fogNoon = new THREE.Color(0x0a1420);
const _skyCold = new THREE.Color(0x3d5a7a), _skyNoon = new THREE.Color(0x6f94b6);
const _gndCold = new THREE.Color(0x101826), _gndNoon = new THREE.Color(0x24354a);
/* the doors surge pushes both toward warm show-light */
const _fogShow = new THREE.Color(0x121b28), _skyShow = new THREE.Color(0x93aec2);
/* THE LIGHTING SCRIPT — every chapter is a re-lit set with one motivated
   statement. cold: security pools in a dead hall. rise: cold dock light
   arrives. WO1: one hard work light. WO2: cyan/amber cross-key. WO3: the
   LED wall is a 20ft softbox. lapse: the highbays march on. WO4: a dark
   island under one top light. doors: full show light. Values are absolute
   intensities; blending runs across the first 30% of each chapter. */
/* OWNER 2026-08-19: "as we dive into the animation everything just kind
   of blacks out… I want everything to pop." The night-shift grade had
   pushed the whole run into a void — every beat is lifted, fills raised
   off zero so nothing falls to pure black, and vignettes pulled back. */
const LS = [
  /* One row per CHAPTER — the table is indexed by beat, so it must track
     the CH table's length or the tail chapters silently clamp to the last
     row and the day arc dies. Order:
     0 cold · 1 rise · 2 wo0 · 3 transit · 4 wo1 · 5 transit · 6 wo2
     7 lapse · 8 transit · 9 wo3 · 10 doors · 11 sheet
     Level and colour temperature climb monotonically: cold blue-grey
     dawn -> neutral midday -> warm show light. */
  /* RETONED 2026-08-20 (owner: "somehow it morphed into this completely
     dark scene… I want to see the whole show floor"). The floor of every
     row is LIFTED — hemi never below 0.24, fills never near zero, no
     vignette past 0.17 — so no beat can fall into a void. The day still
     climbs cold-blue -> neutral -> warm show light, but it is a grade,
     not a blackout. */
  { hemi: 0.240, key: 2.40, fill: 0.20, exp: 1.24, kc: 0x9fc0dd, sl: [0.93, 0.99, 1.10], sat: 1.02, vig: 0.17, hal: 0.08 },
  { hemi: 0.280, key: 3.40, fill: 0.24, exp: 1.30, kc: 0xaec2d6, sl: [0.95, 1.00, 1.07], sat: 1.06, vig: 0.15, hal: 0.09 },
  { hemi: 0.330, key: 4.40, fill: 0.28, exp: 1.36, kc: 0xc0ccd8, sl: [0.97, 1.00, 1.04], sat: 1.10, vig: 0.13, hal: 0.10 },
  { hemi: 0.380, key: 4.80, fill: 0.30, exp: 1.42, kc: 0xc8d1da, sl: [0.98, 1.00, 1.03], sat: 1.12, vig: 0.12, hal: 0.10 },
  { hemi: 0.350, key: 5.10, fill: 0.28, exp: 1.38, kc: 0xd2d6d6, sl: [1.00, 1.00, 1.00], sat: 1.13, vig: 0.13, hal: 0.11 },
  { hemi: 0.400, key: 5.50, fill: 0.32, exp: 1.44, kc: 0xdcdbd4, sl: [1.01, 1.00, 0.99], sat: 1.14, vig: 0.12, hal: 0.11 },
  { hemi: 0.370, key: 5.80, fill: 0.30, exp: 1.40, kc: 0xe6e0d2, sl: [1.02, 1.00, 0.98], sat: 1.15, vig: 0.13, hal: 0.12 },
  { hemi: 0.410, key: 6.20, fill: 0.32, exp: 1.46, kc: 0xf2e6cc, sl: [1.03, 1.01, 0.97], sat: 1.15, vig: 0.12, hal: 0.11 },
  { hemi: 0.440, key: 6.40, fill: 0.34, exp: 1.50, kc: 0xf8ead2, sl: [1.04, 1.00, 0.96], sat: 1.14, vig: 0.11, hal: 0.12 },
  { hemi: 0.400, key: 6.50, fill: 0.30, exp: 1.44, kc: 0xffeeda, sl: [1.05, 1.00, 0.95], sat: 1.14, vig: 0.14, hal: 0.12 },
  { hemi: 0.460, key: 6.30, fill: 0.36, exp: 1.58, kc: 0xffe6c0, sl: [1.06, 1.02, 0.95], sat: 1.24, vig: 0.10, hal: 0.18 },
  /* the CLOSE — at or above the peak; the cards get their contrast from
     their own DOM scrim, never by dimming the room you are selling */
  { hemi: 0.465, key: 6.40, fill: 0.36, exp: 1.60, kc: 0xffe6c0, sl: [1.06, 1.02, 0.95], sat: 1.26, vig: 0.09, hal: 0.16 },
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
  const gloryRaw = (beat === 2 || beat === 4 || beat === 6 || beat === 9)
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
  L.rim.intensity = (0.35 + cue.key * 0.28) * (1 + 0.6 * s) * dk;
  L.fill.intensity = cue.fill * dk;
  if (state.post) {
    state.post.u.uExposure.value = cue.exp * (1 + 0.30 * pulse + 0.08 * t) * (1 - 0.30 * dim);
    /* BLOOM CARRIES THE LOOK. At 0.05 every light line in the stands was
       a flat painted stripe — the owner's "flat and boring". The
       reference stands glow: the light sources bleed into the air around
       them and that halation IS the production value. */
    state.post.u.uBloomStrength.value = 0.34 + 0.05 * day + 0.10 * t + 0.18 * pulse + 0.06 * glory;
    state.post.u.uRadius.value = 1.0 + 0.7 * t;    /* bloom opens at doors */
  }
  updateCrowd(t);
  /* house lights snap on ROW BY ROW across the doors surge — the ceiling
     is dim housings all day, then the hall's own fixtures become the event.
     Front-loaded stagger (jury 3rd pass: any capture late in the chapter
     must catch the hall LIT), and Doors must be the BRIGHTEST frame. */
  /* THE CEILING IS NOT IN THE OPENING SHOT (owner 2026-08-21: "hide those
     lights in this initial view, they don't look good whatsoever, but they
     can be visible once you actually get into the animation"). Beats 0-1
     are the top-down map and the rise — the fixtures hang across the upper
     third of a frame that is meant to read as a clean drawing, and at that
     camera they are a row of grey stubs against black. They fade up over
     the first quarter of the first service beat, where the camera is down
     in the hall and a ceiling is what sells the room.
     Everything ceiling-side multiplies by ceilT, and the whole set stops
     drawing at zero. */
  const ceilT = beat <= 1 ? 0
    : beat === 2 ? Math.min(1, Math.max(0, (beatT - 0.06) / 0.26))
    : 1;
  for (let r = 0; r < state.houseRows.length; r++) {
    const hr = state.houseRows[r];
    hr.housingMat.opacity = ceilT;
    if (hr.reflMat) hr.reflMat.opacity = ceilT;
    if (hr.metalMat) hr.metalMat.opacity = ceilT;
    /* the timelapse IS the light show: banks march on one by one across
       the ceiling; the rescue beat pulls them back down to one island */
    const lapseRt = beat === 5 ? Math.min(1, Math.max(0, (beatT - 0.3 - r * 0.14) / 0.22)) : 0;
    const rt = Math.max(Math.min(1, Math.max(0, (t - r * 0.07) / 0.22)), lapseRt) * dk;
    hr.housingMat.color.copy(hr.base).lerp(hr.on, rt);
    if (hr.reflMat) hr.reflMat.color.copy(hr.reflBase).lerp(hr.reflOn, rt);
    /* the lens carries a low ember all day so the ceiling is never a row
       of dead boxes, then goes to full with the row */
    if (hr.lensMat) hr.lensMat.opacity = (0.22 + 0.68 * rt) * ceilT;
    /* the lens disc is edge-on from a floor-level camera and vanishes;
       the sprite is a billboard, so it is the ember that actually reads
       from anywhere in the hall. A trace of it all day gives the ceiling
       a pulse instead of a row of dead housings. */
    hr.spriteMat.opacity = (0.07 + 0.8 * rt) * ceilT;
    /* A WORK-LIGHT FLOOR (owner 2026-08-21: the hall view is lackluster).
       Before doors every shaft was at exactly zero, so the map was one
       flat sheet of blue with nothing in the air above it. A trace of
       beam all day gives the hall depth and a reason for the fixtures to
       be there; it is an order of magnitude under the doors surge, so
       "lights on" still lands as the event it was tuned to be. */
    if (state.shaftMats && state.shaftMats[r])
      state.shaftMats[r].uniforms.uOp.value = (0.014 + 0.10 * rt) * dk * ceilT;
  }
  if (state.shaftPools)
    for (const sp2 of state.shaftPools) {
      const rt2 = Math.max(
        Math.min(1, Math.max(0, (t - sp2.row * 0.07) / 0.22)),
        beat === 5 ? Math.min(1, Math.max(0, (beatT - 0.3 - sp2.row * 0.14) / 0.22)) : 0) * dk;
      sp2.m.opacity = (0.05 + 0.30 * rt2) * dk * ceilT;
    }
  /* nothing ceiling-side is on screen at zero — stop drawing all of it */
  if (state.ceilVis !== (ceilT > 0.002)) {
    state.ceilVis = ceilT > 0.002;
    for (const f of state.fixtures) for (const pt of f.parts) pt.visible = state.ceilVis;
  }
  /* jury r10 (Awwwards): the blueprint IS the banned Tron grid — it dies
     progressively as the day's work covers the hall, not all at once at
     doors. Pure function of (beat, beatT); doors t still completes it. */
  const wetBase = beat >= 2
    ? Math.min(0.5, Math.max(0, ((beat - 2) + beatT) * 0.17)) : 0;
  if (state.wetU) state.wetU.value = Math.max(t * 0.85, wetBase);
  for (const am of state.aisleGlow) am.opacity = 0.18 * t;
  if (state.houseGlow) state.houseGlow.opacity = 0.07 * t;
  for (const m of [M.navy9, M.navy7, M.dark])
    if (m.userData.sh) m.userData.sh.uniforms.uRimS.value = m.userData.rimBase * (1 + 1.2 * s);
  for (const g of state.showGlows)
    g.material.opacity = Math.min(.9, g.userData.baseOp * (0.55 + 0.45 * day + 1.1 * t));

}
const MIGL = {
  ready: false,
  resize(rectW, rectH) {
    state.rectW = rectW; state.rectH = rectH;
    /* mobile ran at DPR 1.0 on DPR-3 phones — a 3x upscale, which is the
       whole "not crisp" complaint. With the plan off the DOM there is
       budget for real resolution. */
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, state.narrow ? 2.0 : 1.2));
    state.renderer.setSize(rectW, rectH, false);
    if (state.post) state.post.resize();
    syncProjection(state.camera, rectW, rectH);
  },
  setStands(upto, subject) {
    state.booths.forEach((bo, i) => {
      bo.live = i <= upto;
      bo.group.visible = bo.live;
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
    /* At a low hero camera the 2400-unit roof chords sweep across the
       frame as long stray diagonals cutting straight through the subject.
       Above ~64 deg of rake the eye is near the floor — retire them. */
    if (state.roofSteel) {
      /* hidden at the low hero rakes (long stray diagonals through the
         subject) AND at the top-down map (black scratches on the plan) */
      const rk0 = cam.rake || 0;
      const rv = rk0 > 26 && rk0 < 64;
      for (const o of state.roofSteel) if (o.visible !== rv) o.visible = rv;
    }
    /* the GL plan obeys the same dim curve the DOM plan used to */
    if (state.planPlane)
      state.planPlane.material.opacity =
        Math.max(0, 1 - 0.42 * (cam.planDim || 0)) * (1 - 0.72 * (cam.dim || 0));
    /* THE IDLE LAYER — loudest when the reader is still. Nothing on this
       screen is ever frozen: LED content runs, crew shift their weight,
       dust drifts through the light. */
    const tSec = (performance.now() - state.t0) / 1000;
    const idle = cam.idle == null ? 1 : cam.idle;
    /* CONTENT FOLLOWS THE CLOCK: every screen runs the pixel-map test
       card until 14:00, then snaps to the broadcast loop (frame 0 is the
       card; 1-3 are the show frames) */
    /* the test card is a BRIEF early-morning state only. Running it until
       14:00 meant the hero LED product spent most of the piece showing a
       technician's grey wedge — i.e. looking broken (owner: make it pop) */
    const preMap = (curDay < 0.28) && (curShow || 0) <= 0.01;
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
    state.holoT.value = tSec;
    /* ============ HOLOGRAM CHOREOGRAPHY ============
       arrive (empty pad) -> lock ring sweeps the pad -> ground-up
       materialise behind a hot front -> settle flash -> hover + slow
       turntable. Build/lock/flash arrive from the page as PURE functions
       of scroll (scrub back and the stand un-builds); only the hover bob
       and the turntable ride the idle clock, because a 360 view has to
       keep turning while the reader holds still. */
    const dtH = state.lastT == null ? 0
      : Math.min(0.05, Math.max(0, tSec - state.lastT));
    state.lastT = tSec;
    const subj = cam.subj == null ? -1 : cam.subj;
    for (let bi = 0; bi < state.booths.length; bi++) {
      const bo = state.booths[bi], h = bo.holo;
      if (!h) continue;
      const isSub = bi === subj;
      const target = !bo.live ? 0 : isSub ? (cam.build || 0) : 1;
      h.u.uBuild.value = target;
      h.u.uFlash.value = isSub ? (cam.flash || 0) : 0;
      /* subject: the ring sweep obeys the scroll. Finished stands keep
         only the corner brackets (uRing parked past the sweep). */
      h.ru.uRing.value = !bo.live ? 0 : (isSub ? (cam.lock || 0) : 1) * 1.15;
      const built = bo.live && target > 0.995;
      h.amp += ((built ? 1 : 0) - h.amp) * (dtH ? 1 - Math.exp(-dtH * 2.4) : 0);
      h.spin += dtH * 0.17 * h.amp;
      bo.group.rotation.y = h.spin;
      bo.group.position.y = h.amp * (1.15 + 0.45 * Math.sin(tSec * 0.85 + bi * 2.1));
      h.padM.opacity = bo.live
        ? 0.05 + 0.10 * target + 0.12 * (isSub ? (cam.lock || 0) : 0) : 0;
      if (bo.fx) bo.fx.visible = bo.live;
    }
    /* the aisle current: six forklifts working the three lanes the light
       streaks used to run down */
    updateFleet(tSec, curShow || 0, cam.rake || 0);
    syncWorld(cam);
    /* proximity cull: a fixture whose clip-w collapses is about to project
       enormous (the 05:45 rake put two of them on screen at booth scale —
       jury: "desk lamps"). w = 1 - z_world/D from the projection's last row. */
    if (state.fixtures) {
      const e = state.plan.matrix.elements;
      for (const f of state.fixtures) {
        const zw = e[2] * f.x + e[6] * f.y + e[10] * f.z + e[14];
        /* ceiling hardware is for raked frames only — seen from straight
           above the housings scatter over the map as grey flecks (r2) */
        const vis = (1 - zw / D) > 0.62 && (cam.rake || 0) > 24;
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
    const needRefl = state.post && !state.post.lite && state.post.reflRT &&
      (curShow > 0.01 || (state.wetU && state.wetU.value > 0.01));
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
      cam2.layers.enable(2);   /* the holograms double in the wet floor */
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
};

window.__state = state;
if (init()) {
  MIGL.ready = true;
  window.MIGL = MIGL;
  window.dispatchEvent(new Event('migl-ready'));
}
