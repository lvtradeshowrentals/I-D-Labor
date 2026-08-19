/* mi-post.js — the render pipeline for the Move-In booth layer.
   HDR scene RT (MSAA) -> threshold/Karis prefilter -> 6-mip dual-filter
   bloom -> composite (bloom + alpha spill + grain + CA + AgX + sRGB +
   TPDF dither). No addons; the whole chain is three core + raw GLSL.
   The canvas is alpha-composited over the CSS floor plan, so every pass
   preserves premultiplied alpha — the bloom spill deliberately raises
   alpha so booth glow bleeds onto the drawing underneath. */
import * as THREE from 'three';

const VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const AGX = /* glsl */`
  vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
         - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  const mat3 AgXIn = mat3(
    0.856627153315983, 0.137318972929847, 0.11189821299995,
    0.0951212405381588, 0.761241990602591, 0.0767994186031903,
    0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const mat3 AgXOut = mat3(
    1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
    -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
    -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  vec3 agx(vec3 c) {
    c = AgXIn * c;
    c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
    c = agxContrast(c);
    c = AgXOut * c;
    return pow(max(vec3(0.0), c), vec3(2.2));
  }
  vec3 lin2srgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
               step(vec3(0.0031308), c));
  }`;

const PREFILTER_FS = /* glsl */`
  uniform sampler2D tSrc;
  uniform float uThresh, uKnee;
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  vec3 karis(vec3 c) { return c / (1.0 + luma(c)); }
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    float l = luma(c);
    float soft = clamp(l - uThresh + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, l - uThresh) / max(l, 1e-4);
    gl_FragColor = vec4(karis(c * w), 1.0);
  }`;

/* Jimenez 13-tap downsample: inner 2x2 box at half weight + corners */
const DOWN_FS = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 t = uTexel;
    vec3 a = texture2D(tSrc, vUv + t * vec2(-2.0,  2.0)).rgb;
    vec3 b = texture2D(tSrc, vUv + t * vec2( 0.0,  2.0)).rgb;
    vec3 c = texture2D(tSrc, vUv + t * vec2( 2.0,  2.0)).rgb;
    vec3 d = texture2D(tSrc, vUv + t * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture2D(tSrc, vUv).rgb;
    vec3 f = texture2D(tSrc, vUv + t * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
    vec3 h = texture2D(tSrc, vUv + t * vec2( 0.0, -2.0)).rgb;
    vec3 i = texture2D(tSrc, vUv + t * vec2( 2.0, -2.0)).rgb;
    vec3 j = texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb;
    vec3 k = texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb;
    vec3 l = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
    vec3 m = texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb;
    vec3 col = (j + k + l + m) * 0.125;
    col += (a + c + g + i) * 0.03125;
    col += (b + d + f + h) * 0.0625;
    col += e * 0.125;
    gl_FragColor = vec4(col, 1.0);
  }`;

/* 9-tap tent upsample, rendered additively into the mip above */
const UP_FS = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vec2 t = uTexel * uScale;
    vec3 c = texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb
           + texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb
           + texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb
           + texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb
           + (texture2D(tSrc, vUv + t * vec2( 0.0,  1.0)).rgb
            + texture2D(tSrc, vUv + t * vec2(-1.0,  0.0)).rgb
            + texture2D(tSrc, vUv + t * vec2( 1.0,  0.0)).rgb
            + texture2D(tSrc, vUv + t * vec2( 0.0, -1.0)).rgb) * 2.0
           + texture2D(tSrc, vUv).rgb * 4.0;
    gl_FragColor = vec4(c / 16.0, 1.0);
  }`;

const COMPOSITE_FS = /* glsl */`
  uniform sampler2D tScene, tBloom;
  uniform float uExposure, uBloomStrength, uBloomAlpha;
  uniform float uGrain, uTime, uCA;
  varying vec2 vUv;
  ${'' /* AGX inserted below */}
  __AGX__
  float h21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    /* chromatic aberration: radial, capped ~1.5 device px at the corner */
    vec2 dir = vUv - 0.5;
    vec2 off = dir * min(uCA * dot(dir, dir), 0.0016);
    vec4 s = texture2D(tScene, vUv);
    float a = s.a;
    vec3 col = s.rgb;
    if (uCA > 0.0001) {
      col.r = texture2D(tScene, vUv - off).r;
      col.b = texture2D(tScene, vUv + off).b;
    }
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    col += bloom * uBloomStrength;
    /* the spill: glow raises coverage, so booth light lands ON the plan */
    a = clamp(a + luma(bloom) * uBloomStrength * uBloomAlpha, 0.0, 1.0);
    /* film grain — linear, pre-curve, low-mids only: pure blacks stay
       clean (dark speckle reads as compression noise, not film) */
    float gt = floor(uTime * 24.0) / 24.0;
    float g = h21(gl_FragCoord.xy + fract(gt) * 371.0) - 0.5;
    float gl2 = luma(col);
    col += g * uGrain * smoothstep(0.012, 0.06, gl2)
         * (1.0 - smoothstep(0.28, 0.65, gl2)) * a;
    col = max(col, 0.0);
    /* transfer: exposure -> AgX -> sRGB (premultiplied throughout) */
    col = agx(col * uExposure);
    /* AgX trades saturation for range — buy the punch back, then a gentle
       crush so the darks sit down instead of floating grey */
    float tl = luma(col);
    col = clamp(mix(vec3(tl), col, 1.22) * 1.05 - 0.006, 0.0, 1.0);
    col = lin2srgb(col);
    /* TPDF dither kills the navy banding */
    col += (h21(gl_FragCoord.xy) - h21(gl_FragCoord.xy + vec2(37.13, 91.71))) * (1.0 / 255.0);
    gl_FragColor = vec4(col, a);
  }`;

function passMat(fs, uniforms) {
  return new THREE.RawShaderMaterial({
    vertexShader: 'precision highp float;\nattribute vec3 position;\n' + VS,
    fragmentShader: 'precision highp float;\n' + fs,
    uniforms, depthTest: false, depthWrite: false,
  });
}

const MIPS = 6;

export class MiPost {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    /* fullscreen triangle — no diagonal seam */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(geo, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.u = {
      uExposure: { value: 1.65 },
      uBloomStrength: { value: 0.055 },
      uBloomAlpha: { value: 0.6 },
      uGrain: { value: 0.012 },
      uTime: { value: 0 },
      uCA: { value: 0.0006 },
      uRadius: { value: 1.0 },
    };
    this.mPre = passMat(PREFILTER_FS, {
      tSrc: { value: null }, uThresh: { value: 1.12 }, uKnee: { value: 0.5 } });
    this.mDown = passMat(DOWN_FS, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mUp = passMat(UP_FS, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uScale: { value: 1.0 } });
    this.mUp.blending = THREE.AdditiveBlending;
    this.mUp.transparent = true;
    this.mComp = passMat(COMPOSITE_FS.replace('__AGX__', AGX), {
      tScene: { value: null }, tBloom: { value: null },
      uExposure: this.u.uExposure, uBloomStrength: this.u.uBloomStrength,
      uBloomAlpha: this.u.uBloomAlpha, uGrain: this.u.uGrain,
      uTime: this.u.uTime, uCA: this.u.uCA });
    this.sceneRT = null;
    this.mips = [];
  }

  resize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(4, size.x), h = Math.max(4, size.y);
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;
    this.dispose();
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false, samples: 4,
    });
    this.mips = [];
    let mw = Math.max(2, w >> 1), mh = Math.max(2, h >> 1);
    for (let i = 0; i < MIPS; i++) {
      this.mips.push(new THREE.WebGLRenderTarget(mw, mh, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false,
      }));
      mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1);
    }
  }

  dispose() {
    if (this.sceneRT) this.sceneRT.dispose();
    for (const m of this.mips) m.dispose();
    this.mips = [];
    this.sceneRT = null;
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  render(scene, camera) {
    const r = this.renderer;
    if (!this.sceneRT) this.resize();
    this.u.uTime.value = performance.now() / 1000;

    /* 1 — scene, HDR, MSAA, alpha 0 */
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, camera);

    /* 2 — bloom prefilter + down chain */
    this.mPre.uniforms.tSrc.value = this.sceneRT.texture;
    this.pass(this.mPre, this.mips[0]);
    for (let i = 1; i < this.mips.length; i++) {
      this.mDown.uniforms.tSrc.value = this.mips[i - 1].texture;
      this.mDown.uniforms.uTexel.value.set(
        1 / this.mips[i - 1].width, 1 / this.mips[i - 1].height);
      this.pass(this.mDown, this.mips[i]);
    }
    /* 3 — tent upsample, additive */
    this.mUp.uniforms.uScale.value = this.u.uRadius.value;
    for (let i = this.mips.length - 2; i >= 0; i--) {
      this.mUp.uniforms.tSrc.value = this.mips[i + 1].texture;
      this.mUp.uniforms.uTexel.value.set(
        1 / this.mips[i + 1].width, 1 / this.mips[i + 1].height);
      this.pass(this.mUp, this.mips[i]);
    }

    /* 4 — composite to canvas */
    this.mComp.uniforms.tScene.value = this.sceneRT.texture;
    this.mComp.uniforms.tBloom.value = this.mips[0].texture;
    this.pass(this.mComp, null);
    r.setRenderTarget(null);
  }
}
