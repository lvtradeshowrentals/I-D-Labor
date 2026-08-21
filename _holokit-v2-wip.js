/* HOLOGRAM KIT v2 — the reference-matched rebuild (WIP, parked
   2026-08-20 to save plan usage). To resume: splice this file over
   mi-gl.js's HOLOGRAM KIT section and wire the builders array to
   mountRef(refRotunda/refPavilion/refFlagship/refCrystal).
   Iteration-2 judge verdicts to apply next are recorded in the
   session memory (world2-floor-moveIn-rebuild.md). */
/* ============ THE HOLOGRAM KIT v2 ============
   Rebuilt 2026-08-20 against the owner's four reference renders. The
   references are NOT line wireframes — each stand is THREE light systems:
   1. NEON: thick rounded glowing tubes tracing every silhouette, often
      stacked 2-3 deep (racing stripes). Real TubeGeometry along real
      curves, authored HDR so the bloom chain builds the halo.
   2. FROST: translucent glass volumes — normal-blended, fresnel-bright
      edges, milky body; denser and bluer on the flagship stand.
   3. GLOW: interior light — lit stair treads, slatted light columns,
      downlight dots, pendant halo rings, warm interior wash.
   All three clip against the same uBuild ground-up cut, so the lock ->
   materialise -> flash -> hover choreography survives unchanged. */
const HOLO = {
  ink: new THREE.Color(0.25, 0.83, 0.88).multiplyScalar(1.55),
};
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
/* ---- the two stand shaders ---- */
function neonMat(u, tint, k) {
  /* additive: white-hot core mixed toward the tint; the halo is bloom's */
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uBuild: u.uBuild, uH: u.uH, uT: u.uT, uFlash: u.uFlash,
      uOp: u.uOp, uTint: { value: new THREE.Color(tint) }, uK: { value: k } },
    vertexShader: `varying float vY;
      void main() { vY = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uBuild, uH, uT, uFlash, uOp, uK;
      uniform vec3 uTint;
      varying float vY;
      void main() {
        float bY = uBuild * uH;
        float vis = 1.0 - step(bY, vY);
        float building = step(0.001, 1.0 - uBuild) * step(0.001, uBuild);
        float hot = smoothstep(bY - 1.5, bY, vY) * building;
        /* TINT-dominant: the r1 white-heavy mix rolled every tube to
           white through AgX — the references are saturated electric blue
           with bloom supplying the white heart */
        vec3 col = mix(uTint, vec3(1.0), 0.10) * uK * 0.62 * (1.0 + 1.6 * uFlash);
        col += vec3(4.0, 6.5, 7.0) * hot;
        gl_FragColor = vec4(col * vis, uOp * vis);
      }`,
  });
}
function frostMat(u, o) {
  /* normal-blended milky glass; the fresnel term carries the edges.
     uIri swings the tint pink->violet->teal for the crystal stand. */
  return new THREE.ShaderMaterial({
    /* FrontSide by default: DoubleSide doubled every closed volume's
       coverage and turned the glass chalk-opaque (ref round 1). Open
       shells (tubes, panes) opt back in with o.ds. */
    transparent: true, depthWrite: false,
    side: o.ds ? THREE.DoubleSide : THREE.FrontSide,
    uniforms: { uBuild: u.uBuild, uH: u.uH, uT: u.uT, uFlash: u.uFlash,
      uOp: u.uOp,
      uTint: { value: new THREE.Color(o.tint == null ? 0xcfe8ff : o.tint) },
      uA: { value: o.alpha == null ? 0.10 : o.alpha },
      uAF: { value: o.edge == null ? 0.50 : o.edge },
      uGrid: { value: o.grid || 0 },
      uIri: { value: o.iri || 0 } },
    vertexShader: `varying float vY; varying vec3 vN; varying vec3 vNm; varying vec3 vP;
      void main() { vY = position.y; vP = position;
        vN = normalMatrix * normal; vNm = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uBuild, uH, uT, uFlash, uOp, uA, uAF, uGrid, uIri;
      uniform vec3 uTint;
      varying float vY; varying vec3 vN; varying vec3 vNm; varying vec3 vP;
      void main() {
        float bY = uBuild * uH;
        if (vY > bY) discard;
        float building = step(0.001, 1.0 - uBuild) * step(0.001, uBuild);
        /* fresnel HARD-confined and capped: a wide term painted every
           edge-on slab chalk-white (r1, r2) — real edge light comes from
           the neon tubes, the frost stays glass at every angle */
        float fr = pow(1.0 - abs(normalize(vN).z), 4.0);
        vec3 tint = uTint;
        /* LUMINOUS pastel ramp (judge r3: the salmon box) — bright
           pink -> violet -> teal, folded toward white */
        vec3 pastel = mix(vec3(1.0, 0.62, 0.85), vec3(0.50, 0.95, 0.89),
          0.5 + 0.5 * sin(vP.x * 0.9 + vY * 0.4 + uT * 0.25));
        tint = mix(tint, mix(pastel, vec3(1.0), 0.35), uIri);
        /* face-aware ORTHOGONAL mesh (judge r3: the diagonal hatching):
           floors tile x/z, walls tile horizontal/vertical */
        float lx = smoothstep(0.045, 0.0, abs(fract(vP.x * 0.5) - 0.5));
        float ly = smoothstep(0.045, 0.0, abs(fract(vY * 0.5) - 0.5));
        float lz = smoothstep(0.045, 0.0, abs(fract(vP.z * 0.5) - 0.5));
        vec3 an = abs(vNm);
        float grid = (an.y > 0.6 ? max(lx, lz)
                   : (an.x > an.z ? max(lz, ly) : max(lx, ly))) * uGrid;
        float hot = smoothstep(bY - 1.2, bY, vY) * building;
        vec3 col = tint * (0.26 + 0.9 * fr + 0.55 * grid) * (1.0 + 1.4 * uFlash)
                 + vec3(3.0, 4.5, 5.0) * hot;
        float a = uOp * clamp(uA + uAF * pow(fr, 1.5) * 0.45
                + grid * 0.10 + 0.25 * hot, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
      }`,
  });
}
/* ---- geometry helpers ---- */
const _bm4 = new THREE.Matrix4(), _beu = new THREE.Euler(),
      _bq = new THREE.Quaternion(), _bv = new THREE.Vector3(),
      _bone = new THREE.Vector3(1, 1, 1);
function bakeGeo(geo, x, y, z, ry, rx, rz) {
  _beu.set(rx || 0, ry || 0, rz || 0, 'YXZ');
  _bq.setFromEuler(_beu);
  _bv.set(x || 0, y || 0, z || 0);
  _bm4.compose(_bv, _bq, _bone);
  geo.applyMatrix4(_bm4);
  return geo;
}
/* rounded-rect outline in the XZ (floor) plane at height y */
function rrPts(w, d, cr, y) {
  const pts = [], hw = w / 2, hd = d / 2, r = Math.min(cr, hw, hd);
  const corner = (cx, cz, a0) => {
    for (let i = 0; i <= 7; i++) {
      const a = a0 + (i / 7) * Math.PI / 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, y || 0, cz + Math.sin(a) * r));
    }
  };
  corner(hw - r, hd - r, 0);
  corner(-(hw - r), hd - r, Math.PI / 2);
  corner(-(hw - r), -(hd - r), Math.PI);
  corner(hw - r, -(hd - r), Math.PI * 1.5);
  return pts;
}
/* rounded-rect outline standing in the XY plane (facing +z) */
function rrPtsV(w, h, cr) {
  const pts = [], hw = w / 2, hh = h / 2, r = Math.min(cr, hw, hh);
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= 7; i++) {
      const a = a0 + (i / 7) * Math.PI / 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
    }
  };
  corner(hw - r, hh - r, 0);
  corner(-(hw - r), hh - r, Math.PI / 2);
  corner(-(hw - r), -(hh - r), Math.PI);
  corner(hw - r, -(hh - r), Math.PI * 1.5);
  return pts;
}
function tubeGeo(pts, r, closed) {
  const curve = new THREE.CatmullRomCurve3(pts, !!closed, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(24, pts.length * 3), r, 6, !!closed);
}
/* ---- the stand assembler: buckets by material, 1 draw call each ---- */
function refKit(bo) {
  const u = { uBuild: { value: 0 }, uH: { value: bo.dims.H },
    uT: state.holoT, uFlash: { value: 0 }, uOp: { value: 1 } };
  const buckets = new Map();
  const push = (key, mkMat, geo) => {
    let b = buckets.get(key);
    if (!b) { b = { mat: mkMat(), geos: [] }; buckets.set(key, b); }
    b.geos.push(geo.index ? geo.toNonIndexed() : geo);
  };
  const kit = {
    u,
    /* neon tube along explicit points */
    tube(pts, r, tint, k, closed) {
      push('n' + tint + '|' + k, () => neonMat(u, tint, k), tubeGeo(pts, r, closed));
    },
    /* straight neon segment */
    seg(ax, ay, az, bx, by, bz, r, tint, k) {
      kit.tube([new THREE.Vector3(ax, ay, az),
        new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2),
        new THREE.Vector3(bx, by, bz)], r, tint, k, false);
    },
    /* horizontal rounded-rect neon ring */
    rr(w, d, cr, y, r, tint, k, cx, cz) {
      const g = tubeGeo(rrPts(w, d, cr, 0), r, true);
      push('n' + tint + '|' + k, () => neonMat(u, tint, k),
        bakeGeo(g, cx || 0, y, cz || 0));
    },
    /* vertical rounded-rect neon ring (stadium loop), facing +z */
    rrV(w, h, cr, r, tint, k, cx, cy, cz, ry) {
      const g = tubeGeo(rrPtsV(w, h, cr), r, true);
      push('n' + tint + '|' + k, () => neonMat(u, tint, k),
        bakeGeo(g, cx || 0, cy || 0, cz || 0, ry || 0));
    },
    /* horizontal neon circle */
    ring(rad, r, tint, k, cx, cy, cz) {
      const g = new THREE.TorusGeometry(rad, r, 6, 48);
      push('n' + tint + '|' + k, () => neonMat(u, tint, k),
        bakeGeo(g, cx || 0, cy || 0, cz || 0, 0, Math.PI / 2));
    },
    /* additive glow piece (interior light) — same shader as neon */
    glow(geo, x, y, z, ry, rx, tint, k) {
      push('n' + tint + '|' + k, () => neonMat(u, tint, k),
        bakeGeo(geo, x, y, z, ry, rx));
    },
    /* light disc: faces down (downlight) or up (floor pool) */
    dot(x, y, z, rad, tint, k, up) {
      const g = new THREE.CircleGeometry(rad, 16);
      push('n' + tint + '|' + k + '|' + (up ? 1 : 0), () => neonMat(u, tint, k),
        bakeGeo(g, x, y, z, 0, up ? -Math.PI / 2 : Math.PI / 2));
    },
    /* frosted glass piece */
    frost(geo, x, y, z, ry, rx, o) {
      o = o || {};
      const key = 'f' + (o.tint || 0) + '|' + (o.alpha || 0) + '|' +
        (o.edge || 0) + '|' + (o.iri || 0) + '|' + (o.grid || 0) + '|' + (o.ds || 0);
      push(key, () => frostMat(u, o), bakeGeo(geo, x, y, z, ry, rx, o.rz));
    },
    /* stair run with lit tread edges. dir: +1 rises toward +x, -1 toward -x */
    stairs(x0, z, dir, steps, w, rise, run, treadTint, edgeTint, ek) {
      for (let i = 0; i < steps; i++) {
        const x = x0 + dir * i * run, y = (i + 1) * rise;
        kit.frost(new THREE.BoxGeometry(run * 1.04, 0.28, w), x, y, z, 0, 0,
          { tint: treadTint, alpha: 0.32, edge: 0.5 });
        kit.glow(new THREE.BoxGeometry(0.14, 0.10, w * 0.96),
          x - dir * run * 0.5, y + 0.12, z, 0, 0, edgeTint, ek);
      }
    },
    finish() {
      const cat = (arrs) => {
        let n = 0; for (const a of arrs) n += a.length;
        const out = new Float32Array(n); let o = 0;
        for (const a of arrs) { out.set(a, o); o += a.length; }
        return out;
      };
      for (const b of buckets.values()) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(
          cat(b.geos.map(x => x.getAttribute('position').array)), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(
          cat(b.geos.map(x => x.getAttribute('normal').array)), 3));
        const m = new THREE.Mesh(g, b.mat);
        m.renderOrder = b.mat.blending === THREE.AdditiveBlending ? 9 : 8;
        m.frustumCulled = false;
        /* layer 2 = mirror pass only (never the depth/AO prepass) */
        m.layers.enable(2);
        bo.group.add(m);
      }
    },
  };
  return kit;
}

/* ============ THE FOUR REFERENCE STANDS ============
   Built to the owner's four renders (2026-08-20). Model space: feet,
   y up, x = long axis, z = toward the aisle. */

/* C1006 — REF 1 "the rotunda" (r4: judge — "collapse the splayed loop
   stacks into nested concentric arches; raise the tower"). */
function refRotunda(k, d) {
  const NEON = 0x1e78ff, FR = 0xcfe8ff, WARM = 0xffe4b8;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const C = THREE.CylinderGeometry;
  /* plinth + one tight striped bumper */
  k.frost(B(37, 1.0, 17), 0, 0.5, 0, 0, 0, { tint: FR, alpha: 0.14, edge: 0.4 });
  k.rr(37.2, 17.2, 4.5, 0.30, 0.16, NEON, 2.6);
  k.rr(36.2, 16.2, 4.5, 0.70, 0.14, NEON, 2.0);
  k.rr(35.2, 15.2, 4.5, 1.10, 0.12, NEON, 1.6);
  /* CONCENTRIC nested loops, nearly coplanar (z +-1.2 only) */
  for (const sx of [-1, 1]) {
    const L = [[10.5, 11.5, 0.28, 2.6, -1.2], [9.7, 10.6, 0.22, 2.2, 0],
               [8.9, 9.8, 0.18, 1.8, 1.2]];
    for (const [w, h, r, kk, dz] of L)
      k.rrV(w, h, 4.4 * (w / 10.5), r, NEON, kk, sx * 12.6, 7.0, dz, 0);
    k.frost(B(9.2, 10.2, 0.5), sx * 12.6, 7.0, 0, 0, 0,
      { tint: FR, alpha: 0.03, edge: 0.5 });
  }
  /* the warm louvered light column — one glowing drum, not dry sticks */
  k.frost(new C(2.3, 2.3, 13.0, 24, 1, true), 0, 7.0, 0, 0, 0,
    { tint: FR, alpha: 0.12, edge: 0.5, ds: true });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    k.glow(B(0.28, 12.2, 0.12), Math.cos(a) * 1.9, 7.0, Math.sin(a) * 1.9,
      -a, 0, WARM, 1.6);
  }
  k.glow(new C(1.45, 1.45, 12.4, 16), 0, 7.0, 0, 0, 0, WARM, 1.2);
  /* twin stairs flanking the column */
  k.stairs(-9.8, 5.2, 1, 8, 4.2, 0.68, 1.05, FR, WARM, 1.8);
  k.stairs(9.8, 5.2, -1, 8, 4.2, 0.68, 1.05, FR, WARM, 1.8);
  /* mid deck lifted to y ~14.5, ONE edge band */
  k.frost(B(19.5, 1.1, 12.5), 0, 14.3, 0, 0, 0, { tint: FR, alpha: 0.16, edge: 0.45 });
  k.rr(20.1, 13.1, 3.0, 15.0, 0.12, NEON, 2.0);
  /* glass drum y 15-22 with balustrade posts and rim rings */
  k.frost(new C(8.0, 8.0, 7.0, 40, 1, true), 0, 18.5, 0, 0, 0,
    { tint: FR, alpha: 0.12, edge: 0.6, ds: true });
  k.ring(8.0, 0.17, NEON, 2.7, 0, 15.25, 0);
  k.ring(8.0, 0.14, NEON, 2.2, 0, 21.8, 0);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.seg(Math.cos(a) * 7.7, 15.3, Math.sin(a) * 7.7,
      Math.cos(a) * 7.7, 18.3, Math.sin(a) * 7.7, 0.04, FR, 1.4);
  }
  k.frost(B(6.6, 5.6, 6.6), 0, 18.2, 0, Math.PI / 6, 0,
    { tint: FR, alpha: 0.09, edge: 0.5 });
  /* the crown: widest element of the stand */
  k.frost(new C(10.6, 10.6, 2.2, 48, 1, true), 0, 25.3, 0, 0, 0,
    { tint: FR, alpha: 0.17, edge: 0.55, ds: true });
  k.frost(new C(10.5, 10.5, 0.25, 48), 0, 26.5, 0, 0, 0,
    { tint: FR, alpha: 0.16, edge: 0.4 });
  k.ring(11.5, 0.26, NEON, 2.8, 0, 24.5, 0);
  k.ring(11.5, 0.22, NEON, 2.4, 0, 26.3, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.dot(Math.cos(a) * 7.0, 24.05, Math.sin(a) * 7.0, 0.5, WARM, 2.4);
  }
  /* reception counter, neon-trimmed */
  k.frost(B(6, 2.6, 2.4), -12.5, 2.3, 6.2, 0, 0,
    { tint: 0x27384f, alpha: 0.55, edge: 0.35 });
  k.rrV(5.2, 1.8, 0.7, 0.10, NEON, 2.6, -12.5, 2.4, 7.45, 0);
}

/* C3042 — REF 2 "the x-ray pavilion" (r4: judge — "luminous ghost-white,
   cool column, visible magenta/teal pools, integrated tunnel shoulder"). */
function refPavilion(k, d) {
  const INK = 0xdff2ff, FR = 0xe8f4ff;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const C = THREE.CylinderGeometry;
  const soft = { tint: FR, alpha: 0.08, edge: 0.75, grid: 0.8 };
  /* base + tiles + centre rings + the two colour pools */
  k.frost(B(37, 0.5, 17), 0, 0.25, 0, 0, 0, { tint: FR, alpha: 0.10, edge: 0.35, grid: 0.7 });
  k.rr(37.6, 17.6, 2.4, 0.55, 0.09, INK, 2.5);
  k.ring(3.8, 0.07, INK, 2.2, 1, 0.62, 0);
  k.ring(2.5, 0.06, INK, 1.6, 1, 0.62, 0);
  k.dot(1, 0.62, 0, 5.5, 0xff5fd2, 1.4, true);
  k.dot(12, 0.62, 1, 4.6, 0x3fe8d0, 1.2, true);
  /* the tunnel volume with an INTEGRATED rounded top-outer shoulder */
  k.frost(B(9.5, 13, 12.5), -11.5, 7.0, -1.5, 0, 0, soft);
  k.frost(new C(4.5, 4.5, 12.5, 16, 1, true, Math.PI, Math.PI / 2),
    -11.75, 9.0, -1.5, 0, Math.PI / 2, { tint: FR, alpha: 0.08, edge: 0.75, grid: 0.8, ds: true });
  k.frost(B(9.0, 12.4, 0.3), -11.5, 6.7, -7.4, 0, 0,
    { tint: FR, alpha: 0.07, edge: 0.5, grid: 0.7 });
  /* straight stair + mezzanine + rail */
  k.stairs(-14.5, 4.6, 1, 9, 3.6, 0.72, 1.0, FR, INK, 1.8);
  k.frost(B(12.5, 0.6, 8.5), -4.5, 7.0, -2.5, 0, 0, { tint: FR, alpha: 0.10, edge: 0.5 });
  k.seg(-10.5, 9.6, 1.6, 1.5, 9.6, 1.6, 0.07, INK, 2.5);
  for (const px of [-9.5, -6.5, -3.5, -0.5])
    k.seg(px, 7.3, 1.6, px, 9.5, 1.6, 0.045, INK, 1.7);
  /* cool white centre column, S-deck, ringed disc on a short drum */
  k.frost(new C(1.8, 1.8, 16.4, 24, 1, true), 1, 8.2, 0, 0, 0,
    { tint: FR, alpha: 0.12, edge: 0.55, ds: true });
  k.glow(new C(1.15, 1.15, 15.6, 16), 1, 8.0, 0, 0, 0, 0xeaf4ff, 0.7);
  k.frost(B(11, 0.7, 6.5), 6, 8.3, 1.5, 0, 0, { tint: FR, alpha: 0.10, edge: 0.5 });
  k.frost(new C(3.6, 3.6, 0.7, 28), 11.5, 8.3, 1.5, 0, 0,
    { tint: FR, alpha: 0.10, edge: 0.5 });
  k.frost(new C(3.2, 3.2, 1.6, 28, 1, true), 1, 14.9, 0, 0, 0,
    { tint: FR, alpha: 0.10, edge: 0.55, ds: true });
  k.frost(new C(8.6, 8.6, 1.1, 48), 1, 16.2, 0, 0, 0,
    { tint: FR, alpha: 0.07, edge: 0.55, grid: 0.55 });
  k.ring(8.65, 0.13, INK, 3.4, 1, 16.8, 0);
  k.ring(5.9, 0.09, INK, 2.6, 1, 16.85, 0);
  k.ring(3.3, 0.08, INK, 2.1, 1, 16.85, 0);
  /* quarter terrace on bright posts + hung canopy + seating */
  k.frost(new C(7.2, 7.2, 0.4, 32, 1, false, -Math.PI / 2, Math.PI), 12, 6.4, 1, 0, 0,
    { tint: FR, alpha: 0.10, edge: 0.5, ds: true });
  for (const [px, pz] of [[8.5, 4.5], [15.5, 4.5], [12, 7]])
    k.seg(px, 0.5, pz, px, 6.2, pz, 0.14, INK, 2.2);
  k.frost(B(5.5, 0.35, 4.6), 12, 4.6, 4.5, 0, 0, { tint: FR, alpha: 0.08, edge: 0.5 });
  k.frost(new C(1.15, 1.15, 1.9, 16), 12, 1.45, 3.6, 0, 0,
    { tint: FR, alpha: 0.14, edge: 0.5 });
  k.frost(B(1.5, 1.5, 1.5), 9.8, 1.25, 2.6, 0.5, 0, { tint: FR, alpha: 0.14, edge: 0.5 });
  k.frost(B(1.5, 1.5, 1.5), 14.2, 1.25, 4.8, -0.4, 0, { tint: FR, alpha: 0.14, edge: 0.5 });
  /* counters: L front-centre + two boxes right */
  k.frost(B(5, 2.6, 2), 1.5, 1.8, 6.2, 0, 0, { tint: FR, alpha: 0.16, edge: 0.55 });
  k.frost(B(2, 2.6, 4.2), -1, 1.8, 5.1, 0, 0, { tint: FR, alpha: 0.16, edge: 0.55 });
  k.rr(5.2, 2.2, 0.5, 3.2, 0.07, INK, 2.6, 1.5, 6.2);
  k.frost(B(3.2, 2.6, 2), 13, 1.8, -4.5, 0, 0, { tint: FR, alpha: 0.16, edge: 0.55 });
  k.frost(B(3.2, 2.6, 2), 17, 1.8, -1.5, 0, 0, { tint: FR, alpha: 0.16, edge: 0.55 });
}

/* C5020 — REF 3 "the flagship" (r4: judge — "solid lit building, not a
   ghost: double the frost, burn the tower, make the stair sculptural,
   light the interior warm"). */
function refFlagship(k, d) {
  const WHT = 0xffffff, BLU = 0x2f7dff, FR = 0xbfd8ff, DEEP = 0x2748c0;
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const C = THREE.CylinderGeometry;
  /* glossy self-lit base */
  k.frost(B(57, 0.7, 17.5), 0, 0.35, 0, 0, 0, { tint: 0xf2f8ff, alpha: 0.50, edge: 0.2 });
  k.glow(B(56, 0.10, 16.5), 0, 0.74, 0, 0, 0, WHT, 0.15);
  k.rr(58, 18, 2.6, 0.55, 0.15, WHT, 3.4);
  /* the logo tower: wider, burning saturated blue from inside */
  k.frost(B(12, 21, 15.5), 22.5, 11.2, 0, 0, 0,
    { tint: DEEP, alpha: 0.50, edge: 0.5 });
  k.glow(B(10.5, 19.5, 14), 22.5, 11.2, 0, 0, 0, 0x2f66ff, 0.8);
  k.rrV(10.8, 19.6, 2.8, 0.16, WHT, 3.6, 22.5, 11.2, 7.85, 0);
  k.rrV(10.8, 19.6, 2.8, 0.11, WHT, 2.3, 22.5, 11.2, -7.85, 0);
  {
    const mx = 28.9, my = 11.5;
    k.seg(mx, my + 3.4, -0.6, mx, my - 3.4, -3.0, 0.40, WHT, 6.0);
    k.seg(mx, my + 3.4, -0.6, mx, my - 3.4, 1.9, 0.40, WHT, 6.0);
    k.seg(mx, my - 0.4, -1.9, mx, my - 0.4, 0.8, 0.32, WHT, 5.0);
    k.seg(mx, my + 3.4, 2.9, mx, my - 3.4, 2.9, 0.36, WHT, 5.4);
  }
  /* wavy layered canopy — solid ribbons with blue under-glow */
  for (let L = 0; L < 3; L++) {
    const y0 = 18.8 + L * 0.85, pts = [];
    for (let x = -26; x <= 17; x += 2.0)
      pts.push(new THREE.Vector3(x, y0 + Math.sin(x * 0.16) * 0.55, 8.4 - L * 0.45));
    k.tube(pts, 0.22 - 0.04 * L, WHT, 3.2 - L * 0.7, false);
    if (L < 2)
      for (let x = -25.2; x <= 16.4; x += 2.1) {
        const yc = y0 + Math.sin((x + 1.0) * 0.16) * 0.55;
        const rz = Math.atan(Math.cos((x + 1.0) * 0.16) * 0.55 * 0.16);
        k.frost(B(2.6, 0.32, 13.2), x + 1.0, yc, 1.4 - L * 0.45, 0, 0,
          { tint: 0xeaf3ff, alpha: 0.30, edge: 0.4, rz: rz });
        k.glow(B(2.4, 0.06, 12.6), x + 1.0, yc - 0.28, 1.4 - L * 0.45, 0, 0,
          BLU, 0.55);
      }
  }
  /* louver block: crisp slats of light-and-gap */
  for (let i = 0; i < 7; i++)
    k.frost(B(11.5, 0.5, 9.5), -21.5, 8.2 + i * 1.05, -1.5, 0, 0,
      { tint: 0xcfe4ff, alpha: 0.22, edge: 0.5 });
  for (let i = 0; i < 6; i++)
    k.glow(B(11.0, 0.08, 9.0), -21.5, 8.75 + i * 1.05, -1.5, 0, 0, BLU, 1.8);
  k.rrV(12.2, 8.4, 1.6, 0.20, WHT, 3.5, -21.5, 11.4, 3.35, 0);
  /* mezzanine + glass balustrade + WARM interior */
  k.frost(B(30, 0.9, 15.5), 0, 9.8, 0, 0, 0, { tint: 0xdcecff, alpha: 0.18, edge: 0.4 });
  k.frost(B(30, 2.8, 0.18), 0, 11.7, 7.4, 0, 0, { tint: FR, alpha: 0.10, edge: 0.6 });
  k.seg(-15, 13.2, 7.4, 15, 13.2, 7.4, 0.13, WHT, 3.4);
  k.frost(B(30, 8.6, 0.4), 0, 14.7, -8.2, 0, 0, { tint: 0xf0f6ff, alpha: 0.22, edge: 0.4 });
  for (const px of [-9, 0, 9])
    k.glow(B(7.5, 4.2, 0.15), px, 13.6, -7.9, 0, 0, 0xffdfae, 1.6);
  for (const [dx2, dz2] of [[-5, -2], [3, -4], [11, -1]])
    k.dot(dx2, 9.4, dz2, 0.5, 0xffdfae, 2.0);
  for (const [fx, fz] of [[-6, -3], [4, -4], [10, -2]])
    k.frost(B(2.2, 1.4, 2.2), fx, 10.9, fz, 0.4, 0, { tint: FR, alpha: 0.16, edge: 0.5 });
  /* the sculptural sweep: wide lit treads + frost balustrade ribbon */
  {
    const cx = -3.5, cz = 3.2, r0 = 5.5, a0 = Math.PI * 1.2, a1 = Math.PI * 0.15;
    const N = 13, rail = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1), a = a0 + (a1 - a0) * t, y = 0.7 + t * 9.1;
      const x = cx + Math.cos(a) * r0, z = cz + Math.sin(a) * r0;
      k.frost(B(4.5, 0.30, 1.35), x, y, z, -a + Math.PI / 2, 0,
        { tint: 0xdcecff, alpha: 0.35, edge: 0.5 });
      k.glow(B(4.3, 0.10, 0.16), x, y + 0.14, z, -a + Math.PI / 2, 0, 0x4f8dff, 2.5);
      if (i < N - 1)
        k.frost(B(2.9, 2.5, 0.15), cx + Math.cos(a) * (r0 + 2.0), y + 1.5,
          cz + Math.sin(a) * (r0 + 2.0), -a, 0,
          { tint: 0xdcecff, alpha: 0.30, edge: 0.5 });
      rail.push(new THREE.Vector3(cx + Math.cos(a) * (r0 + 2.0), y + 2.85,
        cz + Math.sin(a) * (r0 + 2.0)));
    }
    k.tube(rail, 0.20, WHT, 3.5, false);
  }
  /* faceted counter, white-edged */
  k.frost(B(7, 3.5, 2.5), 3, 2.1, 6.2, 0.28, 0, { tint: 0x16307a, alpha: 0.5, edge: 0.5 });
  k.frost(B(7, 3.5, 2.5), 8.8, 2.1, 6.7, -0.34, 0, { tint: 0x16307a, alpha: 0.5, edge: 0.5 });
  k.seg(-0.2, 3.95, 7.1, 6.2, 4.1, 7.4, 0.13, WHT, 4.0);
  k.seg(6.2, 4.1, 7.4, 12.1, 3.85, 7.6, 0.11, WHT, 3.4);
}

/* C7050 — REF 4 "the crystal inline" (r4: judge — "the desk IS the focal
   point: full pastel ramp + white rim + underglow; pendants are lamps"). */
function refCrystal(k, d) {
  const WHT = 0xffffff, FRO = { tint: 0xdfeaff, alpha: 0.06, edge: 0.7, grid: 0.45 };
  const B = (w, h, dp) => new THREE.BoxGeometry(w, h, dp);
  const C = THREE.CylinderGeometry;
  /* shell with HOT white rims + a soft lit-from-beneath sheen */
  k.dot(0, 0.08, 0.5, 10.5, WHT, 0.10, true);
  k.frost(B(18, 0.6, 16), 0, 0.30, 0.5, 0, 0,
    { tint: 0xdfeaff, alpha: 0.10, edge: 0.6, iri: 0.25 });
  k.rr(18.2, 16.2, 1.2, 0.6, 0.15, WHT, 3.8);
  k.frost(B(18, 12, 0.5), 0, 6.5, -7.2, 0, 0, FRO);
  k.frost(B(0.5, 12, 15.5), -8.75, 6.5, 0.3, 0, 0, FRO);
  k.frost(B(18, 0.55, 16), 0, 12.55, 0.5, 0, 0,
    { tint: 0xdfeaff, alpha: 0.06, edge: 0.7, iri: 0.25 });
  k.rr(18.2, 16.2, 1.2, 12.85, 0.14, WHT, 3.4);
  k.rrV(17.4, 11.6, 1.0, 0.08, WHT, 2.6, 0, 6.6, -7.5, 0);
  /* pendant halo LAMPS, hung low under the canopy */
  const pend = [[-3.5, 9.2, -1.5, 1.7], [1.5, 8.2, 0.5, 2.4],
                [4.8, 9.5, -3.0, 1.35], [-0.5, 9.8, -4.0, 1.2]];
  for (const [px, py, pz, pr] of pend) {
    k.seg(px, 12.3, pz, px, py, pz, 0.04, WHT, 1.4);
    k.glow(new THREE.TorusGeometry(pr, 0.16, 8, 40), px, py, pz, 0, Math.PI / 2,
      WHT, 3.0);
    k.glow(new THREE.TorusGeometry(pr * 0.68, 0.07, 8, 32), px, py - 0.22, pz,
      0, Math.PI / 2, WHT, 1.6);
    k.dot(px, py - 0.05, pz, pr * 0.8, WHT, 0.15);
  }
  /* glass shelving cabinets with lit shelf edges */
  for (const [sx, sz, ry] of [[-5.5, -5.3, 0], [-1.0, -5.3, 0], [-6.9, 1.8, Math.PI / 2]]) {
    k.frost(B(4.4, 9.2, 1.9), sx, 5.1, sz, ry, 0, FRO);
    for (let s = 0; s < 4; s++) {
      const sy = 3.1 + s * 2.1;
      k.frost(B(4.2, 0.18, 1.8), sx, sy, sz, ry, 0,
        { tint: 0xdfeaff, alpha: 0.14, edge: 0.6 });
      const fx = ry ? sx + 0.95 : sx, fz = ry ? sz : sz + 0.95;
      const ex = ry ? 0 : 2.0, ez = ry ? 2.0 : 0;
      k.seg(fx - ex, sy + 0.12, fz - ez, fx + ex, sy + 0.12, fz + ez, 0.05, WHT, 1.8);
    }
    k.dot((ry ? sx + 0.95 : sx) - 0.4, 1.7, ry ? sz : sz + 0.98, 0.09, WHT, 2.0);
    k.dot((ry ? sx + 0.95 : sx) + 0.4, 1.7, ry ? sz : sz + 0.98, 0.09, WHT, 2.0);
  }
  /* THE DESK: luminous pastel iridescence, white rim, underglow, tablet */
  k.frost(B(7, 3.0, 3.2), 1.5, 2.0, 3.6, 0, 0,
    { tint: 0xffffff, alpha: 0.28, edge: 0.8, iri: 1 });
  k.rr(7.2, 3.4, 1.3, 3.55, 0.08, WHT, 2.2, 1.5, 3.6);
  k.glow(B(6.4, 0.10, 2.7), 1.5, 0.62, 3.6, 0, 0, 0xffc4e8, 0.8);
  k.frost(B(1.6, 1.2, 0.14), 1.5, 4.5, 3.3, 0, -0.26,
    { tint: 0xdfeaff, alpha: 0.20, edge: 0.6 });
  k.seg(1.5, 3.55, 3.45, 1.5, 4.0, 3.38, 0.05, WHT, 1.6);
  k.glow(B(1.45, 1.05, 0.06), 1.5, 4.52, 3.26, 0, -0.26, 0xbfe0ff, 3.0);
  /* open side shelf with lit fronts */
  k.frost(B(4.2, 4.6, 2.2), 6.4, 2.8, -1.0, 0, 0,
    { tint: 0xdfeaff, alpha: 0.09, edge: 0.7, grid: 0.45 });
  for (let s = 0; s < 2; s++) {
    const sy = 2.4 + s * 1.9;
    k.frost(B(4.0, 0.18, 2.1), 6.4, sy, -1.0, 0, 0,
      { tint: 0xdfeaff, alpha: 0.14, edge: 0.6 });
    k.seg(4.5, sy + 0.12, 0.05, 8.3, sy + 0.12, 0.05, 0.045, WHT, 1.6);
  }
}

function mountRef(bo, designFn) {
  const kit = refKit(bo);
  designFn(kit, bo.dims);
  kit.finish();
  const u = kit.u;
  /* pad furniture on its OWN group under the mount — the lock ring and
     floor glow must not bob or turn with the model */
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


