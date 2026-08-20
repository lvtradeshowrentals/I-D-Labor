/* ============================================================
   BUILD STAGE — "The Live Build"  (engine)

   A CSS-3D trade show exhibit that assembles itself from the form
   beside it. Pure DOM + CSS transforms + WebAudio. No library.

   Coordinate contract (must match build-stage.css):
     x = right (feet)   y = UP (feet)   z = toward viewer (feet)
   CSS y grows DOWNWARD, so place() emits translate3d(x, -y, z) and the
   lighting maths below is in CSS space (y down), not maths space.

   Placed nodes use left/top:50% plus negative margins, so the default
   transform-origin (50% 50%) is the node's own centre and the translate
   lands that centre on the requested point. Group nodes are 0x0, which
   makes a child's 50% resolve to the group's origin — that is what lets
   parts nest.

   CAMERA SIGN, derived (do not "fix" this by flipping it back):
   the floor is authored at rotateX(90deg), so its normal is
   Rx(90)·(0,0,1) = (0,-1,0) — up, since y is down. Under the world
   rotation that becomes (0,-cos,-sin), whose z is -sin(camRX). Facing
   the viewer needs z > 0, so camRX must be NEGATIVE. Positive renders
   the underside of the floor. The clamp keeps it strictly negative, so
   the camera can never pass beneath the floor.

   HARD RULE: never put opacity<1 / filter / mask / clip-path on a node
   that has 3D children. Per CSS Transforms L2 that forces
   transform-style:flat and collapses the subtree. Only LEAF faces may
   carry them. Group-level fades happen on .bs-veil, which sits outside
   the perspective entirely.

   MASS is one scalar per part driving fall height, duration, sound
   pitch and level, camera shake, contact shadow and haptic together.
   That coherence is what makes a scene read as real rather than as a
   set of unrelated tweens.

   The stage is decorative: the 3D viewport is aria-hidden, it never
   owns a form value, and every field keeps working if this file fails
   to load. The sound button is deliberately OUTSIDE the hidden subtree
   — a focusable control inside aria-hidden is a WCAG 4.1.2 failure and
   would leave assistive-tech users unable to mute.
   ============================================================ */
(function () {
    'use strict';

    var FT = 12;                       /* px per foot before world scale */
    var WALL_H = 8;                    /* standard back-wall height, ft   */
    var TOP_FT = 18;                   /* tallest feature, for the fit    */

    var mqReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    var reduced = !!(mqReduce && mqReduce.matches);

    /* localStorage THROWS on PROPERTY ACCESS (not just the call) when site
       data is blocked. Unguarded, that aborts the constructor mid-build. */
    var LS = {
        get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    };

    /* Motion vocabulary — exact analytic curves, not UI presets.
       E_FALL is exact free fall: with x1=1/3, x2=2/3 the bezier's x(s)=s
       exactly, so y(s)=s^2 is constant acceleration, not an approximation. */
    var E_FALL = 'cubic-bezier(0.333, 0, 0.667, 0.333)';
    var E_LAND = 'cubic-bezier(0.333, 0.667, 0.667, 1)';

    /* ---------- 3x3 maths (CSS convention: x right, y DOWN, z at viewer) ---------- */
    function rotX(a) { a *= Math.PI / 180; var c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
    function rotY(a) { a *= Math.PI / 180; var c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
    function mul(A, B) {
        var M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++)
            M[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
        return M;
    }
    function ap(M, v) {
        return [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
                M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
                M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
    }
    function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function nrm(v) { var l = Math.sqrt(dot(v, v)) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

    /* Three-point rig. y is DOWN, so "above" is negative y. FILL is the hall's
       bounced ambient — without it the shadow side goes darker than the
       backdrop and the booth loses its silhouette entirely. */
    var KEY = nrm([-0.82, -0.42, 0.39]);
    var FILL = nrm([0.62, -0.15, 0.55]);
    var RIMD = nrm([0.30, -0.55, -0.80]);
    var VIEW = [0, 0, 1];
    var HALF = nrm([KEY[0] + VIEW[0], KEY[1] + VIEW[1], KEY[2] + VIEW[2]]);

    /* ---------- DOM ---------- */
    function mk(cls, parent) {
        var n = document.createElement('div');
        n.className = cls;
        if (parent) parent.appendChild(n);
        return n;
    }
    function place(n, o) {
        var w = (o.w || 0) * FT, h = (o.h || 0) * FT;
        n.style.width = w + 'px';
        n.style.height = h + 'px';
        n.style.marginLeft = (-w / 2) + 'px';
        n.style.marginTop = (-h / 2) + 'px';
        n.style.transform =
            'translate3d(' + ((o.x || 0) * FT) + 'px,' + (-(o.y || 0) * FT) + 'px,' + ((o.z || 0) * FT) + 'px)' +
            ' rotateY(' + (o.ry || 0) + 'deg) rotateX(' + (o.rx || 0) + 'deg)';
    }

    /* Give a vertical panel real thickness. A zero-thickness quad has no
       silhouette, and the silhouette is where the eye decides whether an
       object has mass — a 4in return catching the key light as a bright
       sliver against the dark face beside it is what stops the booth reading
       as folded paper. EPS insets the meeting edges: planes that share an
       edge exactly land in the same BSP leaf in Chrome (hairline flicker) and
       sort wrongly in Firefox, which splits boxes inside-out. */
    var EPS = 0.03;
    function slab(o, t) {
        var ry = o.ry || 0, r = ry * Math.PI / 180;
        var nx = Math.sin(r), nz = Math.cos(r);
        var ux = Math.cos(r), uz = -Math.sin(r);
        var x = o.x || 0, y = o.y || 0, z = o.z || 0, h = t / 2;
        var w2 = o.w / 2 - EPS;
        return [
            { w: o.w, h: o.h, x: x + nx * h, y: y, z: z + nz * h, ry: ry },
            { w: o.w, h: o.h, x: x - nx * h, y: y, z: z - nz * h, ry: ry + 180 },
            { w: t, h: o.h - EPS, x: x - ux * w2, y: y, z: z - uz * w2, ry: ry + 90 },
            { w: t, h: o.h - EPS, x: x + ux * w2, y: y, z: z + uz * w2, ry: ry + 90 },
            { w: o.w - EPS, h: t, x: x, y: y + o.h / 2 - EPS, z: z, ry: ry, rx: 90 }
        ];
    }
    function slabs(list, t) {
        var out = [];
        for (var i = 0; i < list.length; i++) out = out.concat(slab(list[i], t));
        return out;
    }

    /* ---------- audio ---------- */
    var Snd = {
        ctx: null, bus: null, duck: null, reward: null, wet: null, ana: null, noise: null,
        on: false, bed: null, _rdy: null, _comp: null, _hum: null,

        init: function () {
            if (this.ctx) {
                if (this.ctx.state !== 'running') this._rdy = this.ctx.resume().catch(function () { });
                return this._rdy;
            }
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            try { this.ctx = new AC(); } catch (e) { return null; }
            var c = this.ctx, self = this;

            try {                                    /* iOS unlock, inside the gesture */
                var b = c.createBuffer(1, 1, 22050), s0 = c.createBufferSource();
                s0.buffer = b; s0.connect(c.destination); s0.start(0);
            } catch (e) { /* ignore */ }

            var n2 = Math.floor(c.sampleRate * 2);
            this.noise = c.createBuffer(1, n2, c.sampleRate);
            var nd = this.noise.getChannelData(0);
            for (var k = 0; k < n2; k++) nd[k] = Math.random() * 2 - 1;

            this.bus = c.createGain(); this.bus.gain.value = 0.34;
            this.duck = c.createGain(); this.duck.gain.value = 1;

            /* Content below ~33Hz is inaudible on laptops and phones but still
               drives gain reduction — strip it before the compressor. */
            var hp = c.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 33; hp.Q.value = 0.6;

            var comp = c.createDynamicsCompressor();
            comp.threshold.value = -12; comp.knee.value = 14; comp.ratio.value = 4;
            comp.attack.value = 0.012;               /* lets transients through   */
            comp.release.value = 0.28;               /* won't track sub cycles    */
            this._comp = comp;

            var makeup = c.createGain(); makeup.gain.value = 1.5;

            var lim = c.createWaveShaper();          /* safety net for pile-ups */
            var cur = new Float32Array(1025);
            for (var i = 0; i < 1025; i++) { var x = i / 512 - 1; cur[i] = Math.tanh(x * 1.7) / Math.tanh(1.7); }
            lim.curve = cur; lim.oversample = '4x';

            /* Events and the bed duck; the completion chord does NOT. Routing it
               through its own duck attenuated its attack to 28% and swelled it up
               as the duck released -- "muffled then louder", the exact opposite of
               "silence then impact". */
            this.reward = c.createGain(); this.reward.gain.value = 1;
            this.bus.connect(this.duck);
            this.duck.connect(hp);
            this.reward.connect(hp);
            hp.connect(comp);
            comp.connect(makeup); makeup.connect(lim); lim.connect(c.destination);

            this.ana = c.createAnalyser(); this.ana.fftSize = 64;
            makeup.connect(this.ana);

            /* The IR costs hundreds of thousands of Math.random calls — never
               build it inside the gesture handler. Run dry until idle. */
            var build = function () { self._reverb(); };
            if (window.requestIdleCallback) requestIdleCallback(build, { timeout: 1200 });
            else setTimeout(build, 260);

            c.addEventListener('statechange', function () {
                if (!document.hidden && c.state === 'interrupted') c.resume().catch(function () { });
            });

            this._rdy = (c.state === 'running') ? Promise.resolve() : c.resume().catch(function () { });
            return this._rdy;
        },

        /* Pre-delay is THE cue for room size; without it the tail glues to the
           source and reads as smear, not space. The tail must also darken as it
           decays or it sounds metallic. Band-limited send so the sub never gets
           convolved into mud. */
        _reverb: function () {
            var c = this.ctx; if (!c || this.wet) return;
            try {
                var SR = c.sampleRate, pre = Math.floor(SR * 0.032), len = Math.floor(SR * 2.1);
                var ir = c.createBuffer(2, pre + len, SR);
                for (var ch = 0; ch < 2; ch++) {
                    var d = ir.getChannelData(ch), lp = 0;
                    var off = pre + Math.floor(SR * (ch ? 0.0031 : 0));
                    for (var i = 0; i < len; i++) {
                        var t = i / len;
                        lp += (0.42 - 0.36 * t) * ((Math.random() * 2 - 1) - lp);
                        d[off + i] = lp * Math.pow(1 - t, 2.4) * (1 - 0.25 * Math.random());
                    }
                }
                var conv = c.createConvolver(); conv.buffer = ir;
                var sHP = c.createBiquadFilter(); sHP.type = 'highpass'; sHP.frequency.value = 280;
                var sLP = c.createBiquadFilter(); sLP.type = 'lowpass'; sLP.frequency.value = 5600;
                this.wet = c.createGain(); this.wet.gain.value = 0.26;
                this.bus.connect(sHP); sHP.connect(sLP); sLP.connect(conv);
                conv.connect(this.wet); this.wet.connect(this._comp);
            } catch (e) { /* dry only */ }
        },

        ready: function () { return this.on && this.ctx && this.ctx.state === 'running'; },

        _pan: function (x, halfW, yaw) {
            var c = this.ctx;
            if (!c.createStereoPanner) return this.bus;
            var sx = Math.cos((yaw || 0) * Math.PI / 180) * (x || 0);
            var n = c.createStereoPanner();
            n.pan.value = Math.max(-1, Math.min(1, sx / (halfW || 1))) * 0.68;
            n.connect(this.bus);
            return n;
        },

        _nz: function (out, t, freq, type, q, gain, dur) {
            var c = this.ctx;
            var n = c.createBufferSource(); n.buffer = this.noise;
            var f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
            var g = c.createGain();
            g.gain.setValueAtTime(gain, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            g.gain.setValueAtTime(0, t + dur);
            n.connect(f); f.connect(g); g.connect(out);
            n.start(t, Math.random() * 1.9);         /* random offset IS the variation;
                                                        resampling white noise is a no-op */
            n.stop(t + dur + 0.02);
        },

        /* snap (contact crack) / body / sub / inharmonic ring. Mass drives level
           and decay, not sub pitch — a heavy impact excites the room's modes
           harder, it does not lower them. */
        thunk: function (mass, x, halfW, yaw) {
            if (!this.ready()) return;
            mass = Math.max(0.15, mass || 1);
            var c = this.ctx, t = c.currentTime, out = this._pan(x, halfW, yaw);
            var j = 1 + (Math.random() * 0.18 - 0.09);

            var o = c.createOscillator(), g = c.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(132 * j, t);
            o.frequency.exponentialRampToValueAtTime(38, t + 0.085);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.5 + 0.28 * Math.min(2, mass), t + 0.005);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26 + 0.2 * mass);
            o.connect(g); g.connect(out);

            var s = c.createOscillator(), sg = c.createGain();
            s.type = 'sine';
            s.frequency.setValueAtTime(52 * (1 + (Math.random() * 0.08 - 0.04)), t);
            s.frequency.exponentialRampToValueAtTime(41, t + 0.11);
            sg.gain.setValueAtTime(0.0001, t);
            sg.gain.exponentialRampToValueAtTime(0.26 + 0.2 * Math.min(2, mass), t + 0.016);
            sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3 + 0.22 * mass);
            s.connect(sg); sg.connect(out);

            this._nz(out, t, 5200 + Math.random() * 2400, 'highpass', 1, 0.18 / Math.sqrt(mass), 0.006);
            this._nz(out, t, (760 / Math.sqrt(mass)) * (0.88 + Math.random() * 0.24), 'bandpass', 1.6, 0.28, 0.13 * mass);

            [1, 1.51, 2.34].forEach(function (r, i) {
                var q = c.createOscillator(), qg = c.createGain();
                q.type = 'triangle';
                q.frequency.value = 188 * r / Math.sqrt(mass) * j;
                var end = t + 0.55 / (i + 1);
                qg.gain.setValueAtTime(0.0001, t);
                qg.gain.exponentialRampToValueAtTime(0.065 / (i + 1), t + 0.01);
                qg.gain.exponentialRampToValueAtTime(0.0001, end);
                qg.gain.setValueAtTime(0, end);      /* exp ramps never reach zero */
                q.connect(qg); qg.connect(out);
                q.start(t); q.stop(end + 0.02);
            });

            o.start(t); o.stop(t + 0.5 + 0.2 * mass);
            s.start(t); s.stop(t + 0.6 + 0.22 * mass);
        },

        /* Two events 18ms apart — that double tap is the difference between
           "click" and "latch". */
        latch: function () {
            if (!this.ready()) return;
            var t = this.ctx.currentTime;
            this._nz(this.bus, t, 3400, 'bandpass', 6, 0.24, 0.028);
            this._nz(this.bus, t + 0.018, 3400, 'bandpass', 6, 0.13, 0.026);
        },
        unlatch: function () {
            if (!this.ready()) return;
            var c = this.ctx, t = c.currentTime;
            this._nz(this.bus, t, 5200, 'bandpass', 7, 0.2, 0.018);
            var o = c.createOscillator(), g = c.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(70, t + 0.06);
            o.frequency.exponentialRampToValueAtTime(52, t + 0.2);
            g.gain.setValueAtTime(0.0001, t + 0.06);
            g.gain.exponentialRampToValueAtTime(0.24, t + 0.075);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
            g.gain.setValueAtTime(0, t + 0.25);
            o.connect(g); g.connect(this.bus);
            o.start(t + 0.06); o.stop(t + 0.26);
        },

        /* Dedicated duck node — writing automation onto the shared bus gain
           lets concurrent ducks stack and park the bus permanently quiet. */
        complete: function () {
            if (!this.ready()) return;
            var c = this.ctx, t = c.currentTime, d = this.duck.gain;
            d.cancelScheduledValues(t);
            d.setValueAtTime(d.value, t);
            d.linearRampToValueAtTime(0.28, t + 0.018);
            d.setValueAtTime(0.28, t + 0.14);
            d.linearRampToValueAtTime(1, t + 0.52);

            var sub = c.createOscillator(), sgn = c.createGain();
            sub.type = 'sine'; sub.frequency.value = 55;
            sgn.gain.setValueAtTime(0.0001, t + 0.08);
            sgn.gain.linearRampToValueAtTime(0.28, t + 0.14);
            sgn.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
            sgn.gain.setValueAtTime(0, t + 1.92);
            sub.connect(sgn); sgn.connect(this.reward);
            sub.start(t + 0.08); sub.stop(t + 1.95);

            /* root/fifth/octave/twelfth/ninth — not a major triad, which reads
               as an app notification. */
            [1, 1.5, 2, 3, 4.5].forEach(function (r, i) {
                var o = c.createOscillator(), g = c.createGain();
                o.type = i > 2 ? 'sine' : 'triangle';
                o.frequency.value = 110 * r;
                var st = t + 0.12 + i * 0.018;
                g.gain.setValueAtTime(0.0001, st);
                g.gain.linearRampToValueAtTime(0.07 / (1 + i * 0.4), st + 0.04);
                g.gain.exponentialRampToValueAtTime(0.0001, st + 1.8);
                g.gain.setValueAtTime(0, st + 1.82);
                o.connect(g); g.connect(this.reward);
                o.start(st); o.stop(st + 1.85);
            });
        },

        /* Contactor tick + strike thump: what a stage lamp actually sounds like
           when it hits. The hum that follows is free "the rig is powered". */
        lamp: function () {
            if (!this.ready()) return;
            var c = this.ctx, t = c.currentTime;
            this._nz(this.bus, t, 9000, 'highpass', 1, 0.16, 0.01);
            var o = c.createOscillator(), g = c.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(130, t + 0.012);
            o.frequency.exponentialRampToValueAtTime(58, t + 0.14);
            g.gain.setValueAtTime(0.0001, t + 0.012);
            g.gain.exponentialRampToValueAtTime(0.34, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
            g.gain.setValueAtTime(0, t + 0.32);
            o.connect(g); g.connect(this.bus);
            o.start(t + 0.012); o.stop(t + 0.34);
        },
        hum: function () {
            if (!this.ready() || this._hum) return;
            var c = this.ctx, t = c.currentTime;
            var o = c.createOscillator(), g = c.createGain();
            o.type = 'sawtooth'; o.frequency.value = 100;
            var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
            g.gain.value = 0;
            g.gain.setTargetAtTime(0.016, t, 0.6);
            o.connect(lp); lp.connect(g); g.connect(this.bus);
            o.start(t);
            this._hum = g;
        },
        /* Rising noise sweep — the approach into the blackout. */
        swell: function (dur) {
            if (!this.ready()) return;
            var c = this.ctx, t = c.currentTime;
            var n = c.createBufferSource(); n.buffer = this.noise;
            var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
            bp.frequency.setValueAtTime(240, t);
            bp.frequency.exponentialRampToValueAtTime(3400, t + dur);
            var g = c.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(0.16, t + dur * 0.86);
            g.gain.linearRampToValueAtTime(0.0001, t + dur);
            g.gain.setValueAtTime(0, t + dur + 0.02);
            n.connect(bp); bp.connect(g); g.connect(this.bus);
            n.start(t, Math.random() * 1.5); n.stop(t + dur + 0.05);
        },

        /* Discrete events in silence is what a FORM sounds like; a world has a
           floor under it. Cutting the bed just before the chord is what makes
           the chord land. */
        startBed: function () {
            if (!this.ready() || this.bed) return;
            var c = this.ctx, t = c.currentTime;
            var n = c.createBufferSource(); n.buffer = this.noise; n.loop = true;
            var lp0 = c.createBiquadFilter(); lp0.type = 'lowpass'; lp0.frequency.value = 680;
            var rg = c.createGain(); rg.gain.value = 0;
            rg.gain.setTargetAtTime(0.02, t, 1.4);
            n.connect(lp0); lp0.connect(rg); rg.connect(this.bus);
            n.start(t);

            var a = c.createOscillator(), b = c.createOscillator();
            var blp = c.createBiquadFilter(), bg = c.createGain();
            a.type = b.type = 'sawtooth';
            a.frequency.value = 55; b.frequency.value = 55.3;   /* 0.3Hz beat */
            blp.type = 'lowpass'; blp.frequency.value = 180; blp.Q.value = 1;
            bg.gain.value = 0.008;
            a.connect(blp); b.connect(blp); blp.connect(bg); bg.connect(this.bus);
            a.start(t); b.start(t);
            this.bed = { lp: blp, gain: bg, room: rg };
        },
        setBed: function (pct) {
            if (!this.bed || !this.ready()) return;
            var t = this.ctx.currentTime;
            this.bed.lp.frequency.setTargetAtTime(180 + 740 * pct, t, 0.9);
            this.bed.lp.Q.setTargetAtTime(1 + 5.5 * pct, t, 0.9);
            this.bed.gain.gain.setTargetAtTime(0.008 + 0.05 * pct, t, 1.2);
        },
        cutBed: function () {
            if (!this.bed || !this.ready()) return;
            var t = this.ctx.currentTime, g = this.bed.gain.gain;
            g.cancelScheduledValues(t);
            g.setValueAtTime(g.value, t);
            g.linearRampToValueAtTime(0.0001, t + 0.06);
        }
    };

    /* Haptics get their OWN toggle. Chaining them to the sound toggle strips
       the one feedback channel that survives a silent phone from exactly the
       users who muted. A real impact is ONE pulse; past ~30ms it reads as a
       notification and kills the illusion. */
    var Hap = { on: LS.get('bsHaptic') !== 'off' };
    function buzz(p) {
        if (reduced || !Hap.on || !navigator.vibrate) return;
        try { navigator.vibrate(p); } catch (e) { /* ignore */ }
    }

    /* ---------- footprints ---------- */
    var SIZES = {
        '10x10': { w: 10, d: 10, island: false, label: "10' x 10'" },
        '10x20': { w: 20, d: 10, island: false, label: "10' x 20'" },
        '20x20': { w: 20, d: 20, island: true, label: "20' x 20'" },
        '20x30': { w: 30, d: 20, island: true, label: "20' x 30'" },
        /* was an exact duplicate of 20x30 -- three distinct booths behind five
           options makes "size rebuilds real geometry" a no-op for most picks */
        'island-custom': { w: 40, d: 24, island: true, label: 'Island / Custom' }
    };
    var DEFAULT_SIZE = SIZES['20x20'];
    function sizeFor(k) {
        return Object.prototype.hasOwnProperty.call(SIZES, k) ? SIZES[k] : DEFAULT_SIZE;
    }

    function geometry(f) {
        var w = f.w, d = f.d, H = WALL_H, P = [];
        var T = 0.34;                                /* panel thickness, ft */
        var ty = H + 6.5, bw = 0.95;                 /* truss ring — must clear the sign */

        P.push({ key: 'plate', mat: 'carpet', mass: 0.6, planes: [{ w: w, h: d, y: 0.2, rx: 90 }] });

        if (!f.island) {
            P.push({
                key: 'back', mat: 'wall', mass: 1.6, shadow: { w: w * 1.1, d: 1.8, z: -d / 2 },
                planes: slab({ w: w, h: H, y: H / 2, z: -d / 2 }, T)
            });
            P.push({
                key: 'sides', mat: 'wall', mass: 1.2,
                planes: slabs([
                    { w: d, h: H, x: -w / 2, y: H / 2, ry: 90 },
                    { w: d, h: H, x: w / 2, y: H / 2, ry: 90 }
                ], T)
            });
            P.push({ key: 'screen', mat: 'screen', mass: 0.5, planes: [{ w: Math.min(9, w * 0.5), h: 4.6, y: H * 0.56, z: -d / 2 + T }] });
            P.push({ key: 'sign', mat: 'gold', mass: 0.7, sign: true, planes: slab({ w: w * 0.76, h: 2.2, y: H + 1.8, z: -d / 2 + 0.3 }, 0.5) });
        } else {
            var tw = Math.max(5.5, Math.min(9, w * 0.3)), th = H + 1.5;
            P.push({
                key: 'back', mat: 'wall', mass: 1.9, shadow: { w: tw * 1.7, d: tw * 1.7 },
                planes: slabs([
                    { w: tw, h: th, y: th / 2, z: -tw / 2 },
                    { w: tw, h: th, y: th / 2, z: tw / 2 },
                    { w: tw, h: th, x: -tw / 2, y: th / 2, ry: 90 },
                    { w: tw, h: th, x: tw / 2, y: th / 2, ry: 90 }
                ], T).concat([
                    /* Cap it. An open-topped shell shows its own interior from any
                       raised camera — the loudest possible "hollow prop" tell. */
                    { w: tw + T - EPS, h: tw + T - EPS, y: th + T / 2, rx: 90 }
                ])
            });
            P.push({
                key: 'sides', mat: 'wall', mass: 1.0,
                planes: slabs([
                    { w: w * 0.26, h: H * 0.72, x: -w * 0.34, y: H * 0.36, z: -d * 0.16, ry: 34 },
                    { w: w * 0.26, h: H * 0.72, x: w * 0.34, y: H * 0.36, z: -d * 0.16, ry: -34 }
                ], T)
            });
            P.push({ key: 'screen', mat: 'screen', mass: 0.5, planes: [{ w: tw * 0.8, h: 4.3, y: th * 0.56, z: tw / 2 + T }] });
            P.push({
                key: 'sign', mat: 'gold', mass: 0.7, sign: true, hangTo: ty,
                planes: slab({ w: Math.min(14, w * 0.58), h: 2.6, y: th + 3.0, z: 0 }, 0.5)
            });
        }

        var cw = 4.2, ch = 3.4, cd = 1.8;
        var cx = -w / 2 + cw / 2 + 1.4, cz = d / 2 - cd / 2 - 1.6;
        P.push({
            key: 'counter', mat: 'gold', mass: 0.9,
            shadow: { w: cw * 1.6, d: cd * 2.4, x: cx, z: cz },
            planes: [
                { w: cw, h: ch, x: cx, y: ch / 2, z: cz + cd / 2 },
                { w: cw, h: ch, x: cx, y: ch / 2, z: cz - cd / 2 },
                { w: cd - EPS, h: ch - EPS, x: cx - cw / 2, y: ch / 2, z: cz, ry: 90 },
                { w: cd - EPS, h: ch - EPS, x: cx + cw / 2, y: ch / 2, z: cz, ry: 90 },
                { w: cw + 0.3, h: cd + 0.3, x: cx, y: ch, z: cz, rx: 90 }
            ]
        });

        /* Box-section truss. Thin quads cannot resolve as a lattice at this
           projection, so the web is PAINTED (see build-stage.css) onto a
           section deep enough to read. */
        P.push({
            key: 'truss', mat: 'truss', mass: 1.6, beams: true, lattice: true, motor: true, trussY: ty,
            planes: slabs([
                { w: w * 0.72, h: bw, y: ty, z: -d * 0.04 },
                { w: w * 0.72, h: bw, y: ty, z: -d * 0.34 },
                { w: d * 0.3, h: bw, x: -w * 0.36, y: ty, z: -d * 0.19, ry: 90 },
                { w: d * 0.3, h: bw, x: w * 0.36, y: ty, z: -d * 0.19, ry: 90 }
            ], bw).concat([
                { w: 0.2, h: 1.8, x: -w * 0.36, y: ty + 1.3, z: -d * 0.04 },
                { w: 0.2, h: 1.8, x: w * 0.36, y: ty + 1.3, z: -d * 0.04 },
                { w: 0.85, h: 0.85, x: -w * 0.28, y: ty - 0.95, z: -d * 0.04 },
                { w: 0.85, h: 0.85, x: w * 0.28, y: ty - 0.95, z: -d * 0.04 }
            ])
        });

        return P;
    }

    /* ---------- stage ---------- */
    function Stage(root) {
        var profile = root.getAttribute('data-build-stage') || 'quote';
        var form = document.querySelector(root.getAttribute('data-form') || 'form[data-ajax]');
        if (!form) { root.parentNode && root.parentNode.removeChild(root); return; }

        var vp = mk('bs-viewport', root);
        vp.setAttribute('aria-hidden', 'true');      /* hide the SCENE, not the controls */
        var world = mk('bs-world', vp);
        var orbit = mk('bs-orbit', world);
        var orbitB = mk('bs-orbit-b', orbit);
        mk('bs-veil', root);
        var hud = mk('bs-hud', root);
        hud.setAttribute('aria-hidden', 'true');

        var tl = mk('bs-hud-tl', hud);
        mk('bs-tag', tl).innerHTML = '<span class="bs-live"></span> Live build';
        var modeTag = mk('bs-tag bs-mode', tl);
        var modeB = document.createElement('b');
        modeB.textContent = 'STANDBY';
        modeTag.appendChild(modeB);

        var specList = document.createElement('ul');
        specList.className = 'bs-spec';
        hud.appendChild(specList);

        var prog = mk('bs-prog', hud);
        var prow = mk('bs-prog-row', prog);
        /* Not "progress": filling every REQUIRED field yields 4 of 7 parts, and
           calling that 57% manufactures failure at the moment of conversion. */
        prow.innerHTML = '<span>Build detail</span><b class="bs-prog-n">0%</b>';
        var pfill = mk('bs-prog-fill', mk('bs-prog-bar', prog));
        var progN = prow.querySelector('.bs-prog-n');
        if (!reduced) mk('bs-drag', hud).textContent = 'Drag to orbit';

        /* Sound button lives OUTSIDE the aria-hidden subtree so it is reachable
           and announced. Defaults OFF: unrequested audio on the first keystroke
           into a contact form is hostile and gets the tab flagged. */
        var sndBtn = document.createElement('button');
        sndBtn.type = 'button';
        sndBtn.className = 'bs-sound';
        sndBtn.innerHTML = '<span></span><span></span><span></span>';
        root.appendChild(sndBtn);
        var meterBars = sndBtn.querySelectorAll('span');

        Snd.on = LS.get('bsSound') === 'on' && !reduced;
        function syncSndBtn() {
            sndBtn.setAttribute('aria-pressed', Snd.on ? 'true' : 'false');
            sndBtn.setAttribute('aria-label', Snd.on ? 'Mute build sound' : 'Enable build sound');
        }
        syncSndBtn();
        sndBtn.addEventListener('click', function () {
            Snd.on = !Snd.on;
            LS.set('bsSound', Snd.on ? 'on' : 'off');
            syncSndBtn();
            if (Snd.on) {
                var r = Snd.init();
                var go = function () { Snd.latch(); Snd.startBed(); startMeter(); };
                if (r && r.then) r.then(go); else go();
            }
        });

        var ground = mk('bs-el bs-ground', orbitB);
        place(ground, { w: 38, h: 38, y: 0, rx: 90 });

        /* ---------- the hall ----------
           Neighbouring stands, an aisle and a ceiling grid. The booth was
           floating in a radial-gradient void, and no amount of per-face lighting
           substitutes for context: "power and presence" is a compositional
           property before it is a rendering one. These are static, built once,
           never relit, and deliberately NOT in `planes`, so they add zero
           per-frame cost. The two faint colour accents are the only non-palette
           hues in the scene — far away and at low alpha, they make the navy and
           gold read as chosen rather than as all that was available. */
        (function buildHall() {
            var far = [
                { w: 18, h: 7.5, x: -40, y: 3.75, z: -46, ry: 22, tint: 'rgba(178, 122, 152, 0.42)' },
                { w: 22, h: 8.5, x: 41, y: 4.25, z: -52, ry: -18, tint: 'rgba(122, 178, 152, 0.38)' },
                { w: 34, h: 6.5, x: -4, y: 3.25, z: -66, ry: 2, tint: 'rgba(150, 175, 215, 0.3)' }
            ];
            far.forEach(function (o) {
                var n = mk('bs-el bs-far', orbitB);
                place(n, o);
                var sgn = mk('bs-farsign', n);
                sgn.style.background = o.tint;
            });
            /* aisle running to the vanishing point */
            var aisle = mk('bs-el bs-aisle', orbitB);
            place(aisle, { w: 13, h: 74, y: 0.02, z: 6, rx: 90 });
            /* hall ceiling grid, high enough to read as structure not as a lid */
            var ceil = mk('bs-el bs-ceil', orbitB);
            place(ceil, { w: 84, h: 84, y: 34, rx: 90 });
        })();
        var pool = mk('bs-el bs-pool', orbitB);
        var group = mk('bs-el', orbitB);
        place(group, {});

        var parts = {}, planes = [], beams = [], shadows = {}, billboards = [];
        var dimWrap = null, dimA = null, dimB = null, decalEl = null;
        var stampWrap = null, stampEl = null, ringEl = null;
        var decalWrap = null, caseEl = null;

        /* ---------- camera ---------- */
        /* nearer eye level: looking down onto it reads as a diorama */
        var camRY = -32, camRX = -11, camS = 1;
        var pxRY = 0, pxRX = 0, tRY = 0, tRX = 0, vRY = 0, vRX = 0, spring = 0;
        var dragging = false, lastX = 0, lastY = 0, driftY = 0, driftX = 0;
        var visible = true, relightReq = 0, vpRect = null, islandNow = true;

        function camera() {
            world.style.transform =
                'translate3d(0,20%,-60px)' +
                /* z left unscaled so the effective FOV does not change with
                   footprint — otherwise the lens changes when the user picks a
                   different booth size from a dropdown */
                ' scale3d(' + camS + ',' + camS + ',1)' +
                ' rotateX(' + (camRX + pxRX) + 'deg)' +
                ' rotateY(' + (camRY + pxRY) + 'deg)';
            queueRelight();
        }
        function queueRelight() {
            /* rAF is never scheduled in a background tab, so a stage built
               while hidden would stay unlit even though the page can still be
               rasterized (print, screenshot, tab preview). Apply synchronously
               in that case; coalesce into a frame otherwise. */
            if (document.hidden) {
                relight(camRX + pxRX + driftX, camRY + pxRY + driftY);
                return;
            }
            if (relightReq) return;
            relightReq = requestAnimationFrame(function () {
                relightReq = 0;
                relight(camRX + pxRX + driftX, camRY + pxRY + driftY);
            });
        }

        function relight(rx, ry) {
            var W = mul(rotX(rx), rotY(ry));
            for (var i = 0; i < planes.length; i++) {
                var p = planes[i];
                if (!p.live) continue;               /* unbuilt parts are wireframe only */
                var n = ap(W, p.n), u = ap(W, p.u), v = ap(W, p.v);
                var kl = dot(n, KEY);
                /* wrap: light bleeds past the terminator so the shadow side never
                   falls below the backdrop and the silhouette survives */
                var wrap = Math.max(0, (kl + 0.35) / 1.35);
                /* Floor at 0.13, not 0.22: the higher floor kept the shadow side
                   above the backdrop but flattened every face into one midtone.
                   Value separation belongs behind the booth (.bs::before), not in
                   the shader. */
                var lum = 0.13 + 0.72 * Math.pow(wrap, 0.9) + Math.max(0, dot(n, FILL)) * 0.24;
                var rim = Math.pow(Math.max(0, dot(n, RIMD)), 2.2) * 0.9;
                var spec = p.ks * Math.pow(Math.max(0, dot(n, HALF)), p.shin);

                var ip = [KEY[0] - n[0] * kl, KEY[1] - n[1] * kl, KEY[2] - n[2] * kl];
                var su = dot(ip, u), sv = dot(ip, v);

                var s = p.el.style;
                s.setProperty('--lum', lum.toFixed(3));
                s.setProperty('--rim', rim.toFixed(3));
                s.setProperty('--spec', spec.toFixed(3));
                s.setProperty('--sx', (50 - su * 42).toFixed(1) + '%');
                s.setProperty('--sy', (50 + sv * 42).toFixed(1) + '%');
                s.setProperty('--bx', (su * 1.6).toFixed(2) + 'px');
                s.setProperty('--by', (sv * 1.6).toFixed(2) + 'px');
                s.setProperty('--envang', (Math.atan2(sv, su) * 180 / Math.PI + 90).toFixed(1) + 'deg');
            }
            /* Light shafts are DOM quads — counter-rotate or they go edge-on
               and vanish. */
            var byaw = 'rotateY(' + (-ry) + 'deg)';   /* shafts stay vertical */
            for (var m = 0; m < billboards.length; m++) billboards[m].style.transform = byaw;
        }

        /* Fit from BOTH axes and the real viewport — width alone clipped the
           truss and the rigging straight off the top of the frame. */
        function fit(f) {
            /* Fill the frame, but fit against the height that is ACTUALLY
               available above the floor. The world origin sits at 50% + the 7%
               translate = 57% from the top, so the usable headroom is 0.57*vh,
               not the whole viewport — measuring against full height overflowed
               the top by ~35px and clipped the header sign, which carries the
               visitor's own company name. The origin is pushed LOW in the frame
               (see camera()) because the booth only grows upward from it — a
               centred origin left the bottom 40% permanently bare ground. */
            var vh = vp.clientHeight || 440;
            /* In the short docked band, fit to the SIGN (~14.5ft) rather than the
               ceiling rigging (~18ft). Cropping the rigging is free; shrinking the
               booth until the company name is unreadable is not. */
            var topFt = vh < 230 ? 14.5 : TOP_FT;
            camS = Math.min(430 / (f.w * FT), (vh * 0.72 - 8) / (topFt * FT));
            camS = Math.max(0.32, Math.min(1.7, camS));
        }

        /* ---------- build ---------- */
        function rebuild(f) {
            group.innerHTML = '';
            parts = {}; planes = []; beams = []; shadows = {}; billboards = [];
            dimWrap = null; decalWrap = null; caseEl = null;
            stampWrap = null; stampEl = null; ringEl = null;
            islandNow = f.island;

            geometry(f).forEach(function (p) {
                var g = mk('bs-el bs-part bs-mat-' + (p.mat || 'wall'), group);
                place(g, {});
                g.__mass = p.mass || 1;
                g.__planes = [];
                g.__motor = !!p.motor;
                /* centroid x, so the impact actually pans where the part landed */
                var sxx = 0;
                p.planes.forEach(function (pl) { sxx += (pl.x || 0); });
                g.__cx = p.planes.length ? sxx / p.planes.length : 0;

                var cs = getComputedStyle(g);
                var ks = parseFloat(cs.getPropertyValue('--ks')) || 0;
                var shin = parseFloat(cs.getPropertyValue('--shin')) || 16;

                /* Rank by descending height then centre-out, so a multi-plane
                   part resolves as a spatial wave rather than in array order. */
                var order = p.planes.map(function (pl, i) { return { i: i, y: pl.y || 0, x: Math.abs(pl.x || 0) }; })
                    .sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
                var rank = {};
                order.forEach(function (o, r) { rank[o.i] = r; });
                var N = p.planes.length;

                p.planes.forEach(function (pl, idx) {
                    var n = mk('bs-el', g);
                    place(n, pl);
                    var solid = mk('bs-face bs-solid' + (p.lattice ? ' is-lattice' : ''), n);
                    mk('bs-face bs-wire', n);        /* wire AFTER solid: the blueprint
                                                        edges survive on built parts and
                                                        double as silhouette AA */
                    /* Gaps SHRINK toward the end — pieces hesitate then slam
                       together. A constant step is the signature of a conveyor. */
                    var t01 = N > 1 ? rank[idx] / (N - 1) : 0;
                    solid.style.transitionDelay = (190 * (1 - Math.pow(1 - t01, 2.4))).toFixed(0) + 'ms';

                    var R = mul(rotY(pl.ry || 0), rotX(pl.rx || 0));
                    var rec = {
                        el: solid, live: false, ks: ks, shin: shin,
                        n: ap(R, [0, 0, 1]), u: ap(R, [1, 0, 0]), v: ap(R, [0, 1, 0])
                    };
                    planes.push(rec);
                    g.__planes.push(rec);

                    if (p.sign && !(pl.ry || 0) && pl.w > 2 && !pl.rx) {
                        var tx = mk('bs-signtext', n);
                        tx.style.fontSize = (pl.h * FT * 0.55) + 'px';
                        g.__sign = tx;
                    }
                });

                /* Cables must terminate ON the truss. Running them past it into
                   empty air is the first thing a visitor sees once they type a
                   company name. */
                if (p.hangTo) {
                    var top = p.hangTo, signTop = p.planes[0].y + p.planes[0].h / 2;
                    var len = Math.max(0.6, top - signTop);
                    [-0.36, 0.36].forEach(function (k) {
                        var c = mk('bs-el bs-cable', g);
                        place(c, { w: 0.16, h: len, x: p.planes[0].w * k, y: signTop + len / 2, z: p.planes[0].z || 0 });
                    });
                }
                if (p.beams) {
                    [-0.28, 0.28].forEach(function (k) {
                        /* Wrapper carries the placement; the inner shaft is
                           counter-rotated each camera update so it always faces the
                           viewer. A world-locked billboard collapses to a 1px sliver
                           the moment you orbit past ~80deg. */
                        var bwrap = mk('bs-el', g);
                        var top2 = p.trussY - 1.0, hh = top2 - 0.25;
                        place(bwrap, { w: 6.4, h: hh, x: f.w * k, y: 0.25 + hh / 2, z: -f.d * 0.04 });
                        var b = mk('bs-beam', bwrap);
                        billboards.push(b);
                        beams.push(b);
                        var lp = mk('bs-el bs-beam-pool', g);
                        place(lp, { w: 7, h: 5.5, x: f.w * k, y: 0.62, z: -f.d * 0.04, rx: 90 });
                        beams.push(lp);
                    });
                }
                if (p.shadow) {
                    var sh = mk('bs-el bs-cshadow', group);
                    place(sh, { w: p.shadow.w, h: p.shadow.d || p.shadow.w, x: p.shadow.x || 0, y: 0.45, z: p.shadow.z || 0, rx: 90 });
                    shadows[p.key] = sh;
                }
                parts[p.key] = g;
            });


            /* Floor tiers spaced >=0.1ft (1.2px). They were within ~0.1px, which
               z-fought continuously under the idle drift. */
            dimWrap = mk('bs-el bs-dim-wrap', group);
            place(dimWrap, { w: f.w, h: 1.2, y: 0.35, z: f.d / 2 + 1.8, rx: 90 });
            var dim = mk('bs-dim', dimWrap);
            dimA = document.createElement('span');
            dimB = document.createElement('span');
            dim.appendChild(dimA); dim.appendChild(document.createElement('i')); dim.appendChild(dimB);
            dimA.textContent = f.w + "'"; dimB.textContent = f.d + "'";
            dimWrap.style.opacity = '0';

            decalWrap = mk('bs-el bs-decal-wrap', group);
            place(decalWrap, { w: Math.min(12, f.w * 0.5), h: 1.7, y: 0.55, z: f.d / 2 - 5, rx: 90 });
            decalEl = mk('bs-decal', decalWrap);
            decalWrap.style.opacity = '0';

            place(pool, { w: f.w * 1.45, h: f.d * 1.6, y: 0.1, rx: 90 });

            /* Finale furniture: the floor stamp and the ring it throws. */
            /* STANDS UP and faces the camera. Lying flat at rotateX(90deg) it was
               almost edge-on at the near-eye-level camera and compressed into an
               illegible sliver — the same foreshortening that makes the floor
               decal and dimension line marginal at this angle. The billboard
               wrapper is separate from the plate because the slam animation
               drives `transform` and would otherwise clobber the counter-rotation. */
            stampWrap = mk('bs-el', group);
            place(stampWrap, { w: Math.max(14, Math.min(19, f.w * 0.62)), h: 3.4, y: 2.8, z: f.d / 2 + 2.6 });
            var sBill = mk('bs-stampbill', stampWrap);
            billboards.push(sBill);
            stampEl = mk('bs-stamp', sBill);
            ringEl = mk('bs-el bs-ring', group);
            place(ringEl, { w: f.w * 0.55, h: f.w * 0.55, y: 0.65, z: f.d / 2 + 2.8, rx: 90 });

            caseEl = mk('bs-el bs-case', group);
            place(caseEl, {});
            var bw2 = 5, bh2 = 3.4, bd2 = 3;
            [
                { w: bw2, h: bh2, y: bh2 / 2, z: bd2 / 2 },
                { w: bw2, h: bh2, y: bh2 / 2, z: -bd2 / 2 },
                { w: bd2 - EPS, h: bh2 - EPS, x: -bw2 / 2, y: bh2 / 2, ry: 90 },
                { w: bd2 - EPS, h: bh2 - EPS, x: bw2 / 2, y: bh2 / 2, ry: 90 },
                { w: bw2 - EPS, h: bd2 - EPS, y: bh2, rx: 90 }
            ].forEach(function (fc, i) {
                var n = mk('bs-el', caseEl);
                place(n, fc);
                mk('bs-face', n);
                if (i === 0) caseEl.__label = mk('bs-caselabel', n);
            });

            fit(f);
            camera();
        }

        /* ---------- landing beat ---------- */
        function shake(mass) {
            if (reduced) return;
            var A = Math.min(2.2, 0.85 * mass);
            /* on the viewport, never on .bs-world — that is a 3D ancestor */
            vp.animate([
                { transform: 'translate3d(0,0,0)' },
                { transform: 'translate3d(' + (A * 0.6) + 'px,' + A + 'px,0)' },
                { transform: 'translate3d(' + (-A * 0.7) + 'px,' + (-A * 0.55) + 'px,0)' },
                { transform: 'translate3d(' + (A * 0.35) + 'px,' + (A * 0.3) + 'px,0)' },
                { transform: 'translate3d(0,0,0)' }
            ], { duration: 110, easing: 'linear' });
        }

        function litUp(g) {
            for (var i = 0; i < g.__planes.length; i++) g.__planes[i].live = true;
            queueRelight();
        }

        function land(g, key, mass, silent) {
            if (reduced || silent) {
                g.classList.add('is-built');
                litUp(g);
                if (shadows[key]) shadows[key].classList.add('is-on');
                return;
            }
            /* Height in FEET, duration derived: t = sqrt(2h/g), g = 32.2 ft/s^2.
               The old constant 210+90*mass px was ~31ft in 330ms -- about 18g.
               The curve was exact free fall; the SCALE was a slam. This company's
               promise is that a $200k exhibit arrives INTACT, so the motion has to
               read as rigging, not as dropping. */
            var hFt = 4 + 2.5 * mass;
            var fall = g.__motor ? 900 : Math.round(1000 * Math.sqrt(2 * hFt / 32.2));
            var antic = 140, total = antic + fall;
            var drop = hFt * FT;

            var anim = g.animate([
                { transform: 'translate3d(0,' + (-drop) + 'px,26px)', offset: 0, easing: 'linear' },
                { transform: 'translate3d(0,' + (-drop) + 'px,26px)', offset: antic / total,
                  easing: g.__motor ? 'linear' : E_FALL },  /* chain motors run at constant speed */
                { transform: 'translate3d(0,0,0)', offset: 1 }
            ], { duration: total });

            g.classList.add('is-falling');
            g.style.setProperty('--bs-fall', fall + 'ms');
            litUp(g);
            /* anim.finished, NOT setTimeout: the user is typing while this plays and
               every keystroke runs sync() on the main thread, which drifted the
               impact off the visual landing. Contact has to be ONE instant. */
            var done = function () {
                if (!g.isConnected || !g.classList.contains('is-falling')) return;
                g.classList.remove('is-falling');
                g.classList.add('is-built');
                shake(mass);
                Snd.thunk(mass, g.__cx, currentSize ? currentSize.w / 2 : 15, camRY + pxRY);
                buzz(Math.min(28, Math.round(11 + 9 * mass)));
                if (shadows[key]) shadows[key].classList.add('is-on');
            };
            /* anim.finished is the accurate signal, but the document timeline
               pauses in a hidden tab and the animation can also be cancelled, so
               it may never settle. done() is guarded on .is-falling, which makes
               it idempotent — a late backstop can only ever fix a stuck part. */
            if (anim.finished && anim.finished.then) anim.finished.then(done).catch(function () { });
            setTimeout(done, total + 260);
        }

        /* ---------- state ---------- */
        function val(name) {
            var n = form.elements[name];
            return n ? (n.value || '').trim() : '';
        }

        var built = {}, celebrated = false, lastVal = {};
        var currentSize = null, touched = {}, replaying = false;
        var lastSpec = {}, lastMode = '', lastDecal = '', lastSign = '', signTimer = 0;

        function setBuilt(key, on) {
            var g = parts[key];
            if (!g || !!built[key] === !!on) return;
            built[key] = !!on;
            if (on) {
                land(g, key, g.__mass || 1, replaying);
            } else {
                g.classList.remove('is-built', 'is-falling');
                for (var i = 0; i < g.__planes.length; i++) g.__planes[i].live = false;
                if (shadows[key]) shadows[key].classList.remove('is-on');
                if (!replaying) { Snd.unlatch(); buzz([10, 24, 16]); }
            }
        }

        /* Pre-create every spec row so the HUD keeps a fixed reading order
           instead of ordering itself by which field the user filled first. */
        var SPEC_KEYS = profile === 'labor'
            ? ['FOOTPRINT', 'EXHIBITOR', 'SHOW', 'VENUE', 'CREW', 'HOURS']
            : ['FOOTPRINT', 'EXHIBITOR', 'SHOW', 'SCOPE'];
        var specEls = {};
        SPEC_KEYS.forEach(function (label) {
            var li = document.createElement('li');
            li.appendChild(document.createTextNode(label + ' '));
            var b = document.createElement('b');
            li.appendChild(b);
            specList.appendChild(li);
            specEls[label] = { li: li, b: b };
        });
        function specLine(label, value) {
            var e = specEls[label];
            if (!e || lastSpec[label] === value) return;
            lastSpec[label] = value;
            if (!value) { e.li.classList.remove('is-on'); return; }
            e.b.textContent = value;                 /* textContent — user input */
            e.li.classList.add('is-on');
        }

        function sync() {
            var f = sizeFor(val('booth_size'));
            if (!currentSize || currentSize.label !== f.label) {
                currentSize = f;
                var was = built;
                built = {};
                rebuild(f);
                /* Re-assert prior state silently. Replaying it would fire N
                   thunks at one ctx.currentTime — ~70 nodes at identical start
                   times through a compressor, which clips into a smear — and N
                   vibrate() calls, each cancelling the last. */
                replaying = true;
                Object.keys(was).forEach(function (k) { if (was[k]) setBuilt(k, true); });
                replaying = false;
                lastSpec = {}; lastMode = ''; lastDecal = ''; lastSign = '';
            }

            var company = val('company');
            var event_ = val('event') || val('event_name');
            var service = val('service');
            var message = val('message') || val('special_requirements');
            var installers = parseInt(val('installers'), 10);

            /* Progress must be reachable by filling the REQUIRED fields. Gating
               the whole overhead rig on a field the label calls "(optional)"
               meant a valid submission topped out at 29%. */
            var on = {
                plate: !!(val('name') || val('contact_name') || company),
                back: !!val('email'),
                sides: !!val('phone'),
                sign: !!company,
                screen: !!(val('interested_in') || val('venue') || message),
                /* explicit user change: booth_size is a <select> that already has
                   a value at load, so testing the value alone opened the page at
                   14% with a counter nobody asked for */
                counter: !!(touched.booth_size || val('booth') || val('service')),
                truss: !!(val('budget') || val('estimated_hours') || val('move_in_date') || message)
            };
            Object.keys(on).forEach(function (k) { setBuilt(k, on[k]); });

            var sg = parts.sign;
            if (sg && sg.__sign) {
                var txt = company ? company.toUpperCase().slice(0, 22) : '';
                if (txt !== lastSign) {
                    lastSign = txt;
                    sg.__sign.textContent = txt;
                    fitSign(sg.__sign);
                    /* Strike the WHOLE name once it settles. Bound to is-built the
                       ballast flash fired on the "A" of "ACME" and the text then
                       mutated silently -- the most memorable beat in the concept,
                       spent on one character. */
                    clearTimeout(signTimer);
                    sg.__sign.classList.remove('is-lit');
                    if (txt) {
                        signTimer = setTimeout(function () {
                            void sg.__sign.offsetWidth;     /* restart the animation */
                            sg.__sign.classList.add('is-lit');
                        }, 520);
                    }
                }
            }

            if (decalEl) {
                var dtxt = [event_, val('booth')].filter(Boolean).join(' · ').slice(0, 30);
                if (dtxt !== lastDecal) {
                    lastDecal = dtxt;
                    decalEl.textContent = dtxt;
                    decalWrap.style.opacity = dtxt ? '1' : '0';
                }
            }
            if (dimWrap) dimWrap.style.opacity = on.plate ? '1' : '0';

            beams.forEach(function (b) { b.classList.toggle('is-on', on.truss); });

            var mode = 'STANDBY';
            if (service === 'Dismantle') mode = 'DISMANTLE';
            else if (service === 'Both') mode = 'INSTALL + DISMANTLE';
            else if (service === 'Installation') mode = 'INSTALL';
            else if (on.plate) mode = 'BUILDING';
            if (mode !== lastMode) { lastMode = mode; modeB.textContent = mode; }

            specLine('FOOTPRINT', f.label);
            specLine('EXHIBITOR', company);
            specLine('SHOW', event_);
            if (profile === 'labor') {
                specLine('VENUE', val('venue'));
                specLine('CREW', isNaN(installers) ? '' : installers + ' installers');
                specLine('HOURS', val('estimated_hours'));
            } else {
                specLine('SCOPE', val('interested_in'));
            }

            var keys = Object.keys(on), done = 0;
            keys.forEach(function (k) { if (on[k]) done++; });
            var pct = done / keys.length;
            pfill.style.transform = 'scaleX(' + pct.toFixed(3) + ')';   /* not width: no layout */
            progN.textContent = Math.round(pct * 100) + '%';
            root.style.setProperty('--bs-progress', pct.toFixed(2));
            Snd.setBed(pct);

            if (pct === 1 && !celebrated) {
                celebrated = true;
                Snd.cutBed();                        /* the silence is the impact */
                setTimeout(function () { Snd.complete(); }, 60);
                buzz([18, 30, 18, 30, 55]);
            } else if (pct < 1) { celebrated = false; }
        }

        /* Scale text to fit a KNOWN container width. Comparing an element's own
           clientWidth to its scrollWidth only works when that element is width
           constrained; inside a flex column the child is shrink-to-fit, so the two
           are always equal and the fit silently never fires — which is how the
           confirmation headline shipped clipped at both ends. */
        function fitInto(el, boxPx) {
            if (!el) return;
            el.style.transform = '';
            el.style.display = 'inline-block';
            requestAnimationFrame(function () {
                /* offsetWidth, NOT getBoundingClientRect(): inside a 3D-transformed
                   subtree the rect is the PROJECTED width while boxPx is a layout
                   width. Comparing the two is a coordinate-space mismatch and the
                   ratio is meaningless — which is why the headline still shipped
                   clipped after the first fix. */
                var w = el.offsetWidth;
                if (!w || !boxPx) return;
                var k = Math.min(1, (boxPx - 14) / w);
                if (k < 1) el.style.transform = 'scaleX(' + Math.max(0.5, k) + ')';
            });
        }
        function fitSign(el) {
            if (el) fitInto(el, el.parentNode ? el.parentNode.clientWidth : 0);
        }

        /* ---------- wiring ---------- */
        var latchTimer = {};
        function onField(e) {
            var t = e.target;
            if (t && t.name) {
                touched[t.name] = 1;
                var v = (t.value || '').trim();
                if (v && v !== lastVal[t.name]) {
                    lastVal[t.name] = v;
                    clearTimeout(latchTimer[t.name]);
                    /* commit, not keystroke — a latch on "you typed A" teaches the
                       user the sound means nothing */
                    latchTimer[t.name] = setTimeout(function () { Snd.latch(); buzz(16); }, 300);
                } else if (!v) { lastVal[t.name] = ''; }
            }
            sync();
        }
        form.addEventListener('input', onField);
        form.addEventListener('change', onField);

        function unlock() {
            if (!Snd.on) return;
            var r = Snd.init();
            var go = function () { Snd.startBed(); startMeter(); };
            if (r && r.then) r.then(go); else go();
        }
        ['pointerdown', 'keydown', 'touchend'].forEach(function (ev) {
            window.addEventListener(ev, unlock, { once: true, capture: true });
        });
        /* The drag hint must only clear when the STAGE is touched — bound to
           window it vanished the moment the user focused any field. */
        vp.addEventListener('pointerdown', function () { root.classList.add('is-touched'); }, { once: true });

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && Snd.ctx && Snd.ctx.state !== 'running') Snd.ctx.resume().catch(function () { });
        });
        if (mqReduce && mqReduce.addEventListener) {
            mqReduce.addEventListener('change', function (e) {
                reduced = e.matches;
                if (reduced) { Snd.on = false; syncSndBtn(); }
            });
        }
        window.addEventListener('resize', function () {
            if (currentSize) { fit(currentSize); camera(); }
        });

        /* The stage changes height when it docks, which is not a window resize —
           without this the camera keeps the tall-band scale and the booth
           overflows the compact band. */
        if (window.ResizeObserver) {
            var lastH = 0;
            new ResizeObserver(function () {
                var h = vp.clientHeight;
                if (!h || h === lastH || !currentSize) return;
                lastH = h;
                fit(currentSize);
                camera();
            }).observe(vp);
        }

        /* ---------- dock ----------
           A sentinel just above the stage: once it passes under the navbar the
           stage is pinned, so compact it. Cheap, and it never reads layout on
           scroll. The CSS only reacts below 1000px, so this is inert on desktop. */
        (function dock() {
            var host = root.closest ? root.closest('[data-bs-dock]') : null;
            if (!host || !window.IntersectionObserver || !host.parentNode) return;
            /* ABSOLUTE, not in flow. As a normal sibling this becomes an extra
               GRID ITEM on desktop and pushes the stage into the form's column.
               Positioned against the row wrapper (which is position:relative), it
               marks exactly where the stage begins to pin and costs no layout. */
            var sentinel = document.createElement('div');
            sentinel.setAttribute('aria-hidden', 'true');
            sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none';
            host.parentNode.insertBefore(sentinel, host);
            new IntersectionObserver(function (es) {
                host.classList.toggle('is-docked', !es[0].isIntersecting);
            }, { rootMargin: '-71px 0px 0px 0px', threshold: 0 }).observe(sentinel);
        })();

        /* ---------- FINALE: show open ----------
           Beat sheet (ms from submit):
             0     everything stops, hall drops to black, rising swell
             200   lamp 1 strikes    380  lamp 2    560  lamp 3
             700   screen wakes
             900   header sign ignites — their own name
             1100  crew and aisle visitors arrive
             1300  the only camera push-in in the whole piece
             1620  floor stamp SLAMS + dust ring + resolving chord
             then it holds, lit, indefinitely. */
        var finaleTimers = [];
        function at(ms, fn) { finaleTimers.push(setTimeout(fn, ms)); }

        function finale() {
            if (root.classList.contains('is-open')) return;
            root.classList.add('is-open');

            /* Break out of the mobile docked band — the climax cannot play in a
               184px strip. ResizeObserver refits the camera when the height changes. */
            var host = root.closest ? root.closest('[data-bs-dock]') : null;
            if (host) { host.classList.remove('is-docked'); host.classList.add('is-finale'); }

            Snd.cutBed();
            Snd.swell(0.62);
            buzz([30, 40, 90]);

            /* lamps, one at a time */
            var beamDelay = 0;
            beams.forEach(function (b, i) {
                beamDelay = 200 + Math.floor(i / 2) * 180;
                b.style.setProperty('--bs-lamp', beamDelay + 'ms');
                b.classList.add('is-on');
            });
            at(200, function () { Snd.lamp(); Snd.hum(); buzz(14); });
            at(380, function () { Snd.lamp(); buzz(14); });
            at(560, function () { Snd.lamp(); buzz(14); });

            /* the sign — the beat that matters */
            at(900, function () { Snd.thunk(0.5, 0, 15, camRY + pxRY); buzz(18); });

            /* the only camera move in the piece */
            at(1300, function () {
                var from = camS, to = camS * 1.045, t0 = performance.now();
                (function push(now) {
                    var k = Math.min(1, ((now || performance.now()) - t0) / 700);
                    var e = 1 - Math.pow(1 - k, 3);
                    camS = from + (to - from) * e;
                    camera();
                    if (k < 1) requestAnimationFrame(push);
                })(t0);
            });

            /* stamp */
            at(1620, function () {
                shake(2);
                Snd.thunk(2.2, 0, currentSize ? currentSize.w / 2 : 15, camRY + pxRY);
                buzz([26, 34, 80]);
            });
            at(1720, function () { Snd.complete(); });

            if (stampEl) {
                var show = val('event') || val('event_name');
                var when = new Date();
                /* Two lines, not one: a single run overflowed the plate and was
                   clipped at both ends. The headline is fixed; the variable part
                   (their show) goes on the subordinate line. Both auto-fitted. */
                stampEl.textContent = '';
                var h1 = document.createElement('b');
                h1.textContent = 'Request received';
                var h2 = document.createElement('span');
                h2.textContent = (show ? show.toUpperCase().slice(0, 22) + ' \u00b7 ' : '') +
                    (when.getMonth() + 1) + '/' + when.getDate() + '/' +
                    String(when.getFullYear()).slice(2);
                stampEl.appendChild(h1);
                stampEl.appendChild(h2);
                var box = stampEl.clientWidth || stampWrap.clientWidth;
                fitInto(h1, box);
                fitInto(h2, box);
            }
            var mb = modeTag.querySelector('b');
            if (mb) mb.textContent = 'REQUEST RECEIVED';
        }

        form.addEventListener('submit', finale);

        /* If the post fails, site.js re-enables the button and alerts — put the
           booth back rather than leaving the user retrying against a dead scene. */
        form.addEventListener('bs:restore', function () {
            finaleTimers.forEach(clearTimeout);
            finaleTimers = [];
            root.classList.remove('is-open');
            var host2 = root.closest ? root.closest('[data-bs-dock]') : null;
            if (host2) host2.classList.remove('is-finale');
            beams.forEach(function (b) { b.style.removeProperty('--bs-lamp'); });
            var mb2 = modeTag.querySelector('b');
            if (mb2) mb2.textContent = 'BUILDING';
        });

        /* ---------- orbit ---------- */
        function stepSpring() {
            vRY += (tRY - pxRY) * 0.26; pxRY += vRY; vRY *= 0.58;
            vRX += (tRX - pxRX) * 0.26; pxRX += vRX; vRX *= 0.58;
            camera();
            spring = (Math.abs(vRY) + Math.abs(vRX) > 0.004) ? requestAnimationFrame(stepSpring) : 0;
        }

        if (!reduced) {
            vp.style.cursor = 'grab';
            vp.addEventListener('pointerdown', function (e) {
                dragging = true; lastX = e.clientX; lastY = e.clientY;
                vpRect = vp.getBoundingClientRect();
                root.classList.add('is-dragging');
                vp.style.cursor = 'grabbing';
                try { vp.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            });
            vp.addEventListener('pointermove', function (e) {
                if (dragging) {
                    camRY += (e.clientX - lastX) * 0.32;
                    /* Clamp the arc. Unclamped, orbiting past 90 deg showed the
                       visitor's own company name mirrored. */
                    var lim = islandNow ? 128 : 68;
                    camRY = Math.max(-lim, Math.min(lim, camRY));
                    camRX = Math.max(-52, Math.min(-4, camRX - (e.clientY - lastY) * 0.2));
                    lastX = e.clientX; lastY = e.clientY;
                    camera();
                } else {
                    /* cache the rect: reading it per move forces sync layout */
                    if (!vpRect) vpRect = vp.getBoundingClientRect();
                    tRY = ((e.clientX - vpRect.left) / vpRect.width - 0.5) * 7;
                    tRX = ((e.clientY - vpRect.top) / vpRect.height - 0.5) * -4;
                    if (!spring) spring = requestAnimationFrame(stepSpring);
                }
            });
            function endDrag(e) {
                if (!dragging) return;
                dragging = false;
                root.classList.remove('is-dragging');
                vp.style.cursor = 'grab';
                try {
                    if (e && e.pointerId != null && vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
                } catch (err) { /* ignore */ }
            }
            vp.addEventListener('pointerup', endDrag);
            vp.addEventListener('pointercancel', endDrag);
            vp.addEventListener('pointerleave', function () {
                if (!dragging) { tRY = 0; tRX = 0; if (!spring) spring = requestAnimationFrame(stepSpring); }
            });
            window.addEventListener('scroll', function () { vpRect = null; }, { passive: true });
            window.addEventListener('resize', function () { vpRect = null; });

            if (window.IntersectionObserver) {
                new IntersectionObserver(function (es) {
                    visible = es[0].isIntersecting;
                    orbit.style.animationPlayState = visible ? '' : 'paused';
                    orbitB.style.animationPlayState = visible ? '' : 'paused';
                    if (visible) startMeter();
                }, { threshold: 0 }).observe(root);
            }

            /* NO idle relight sampler. It modelled bs-drift-x as a sine over
               [-1.1,+1.1] when the keyframes are a triangle over [0,1.1], and took
               its phase from performance.now() rather than the animation's start --
               so the light swayed out of step with the geometry and sometimes the
               wrong way. It also cost ~4,500 setProperty calls per second, forever,
               to animate a +/-2.4deg change that is below perceptual threshold.
               Lighting updates on real camera movement, which is when it is
               legible. */
        }

        var meterRaf = 0, meterBuf = null;
        function startMeter() {
            if (meterRaf || !Snd.ana) return;
            meterBuf = meterBuf || new Uint8Array(Snd.ana.frequencyBinCount);
            (function tick() {
                if (!visible || !Snd.ready() || document.hidden) { meterRaf = 0; return; }
                Snd.ana.getByteFrequencyData(meterBuf);
                for (var i = 0; i < meterBars.length; i++) {
                    /* scaleY, not height — height relayouts the flex row 60x/s */
                    meterBars[i].style.transform = 'scaleY(' + (0.22 + (meterBuf[2 + i * 4] / 255) * 3.4).toFixed(2) + ')';
                }
                meterRaf = requestAnimationFrame(tick);
            })();
        }

        rebuild(DEFAULT_SIZE);
        currentSize = DEFAULT_SIZE;
        sync();
    }

    function init() {
        var nodes = document.querySelectorAll('[data-build-stage]');
        for (var i = 0; i < nodes.length; i++) {
            /* one broken stage must not take the others — or the page — down */
            try { Stage(nodes[i]); }
            catch (e) {
                if (window.console) console.warn('[build-stage]', e);
                var n = nodes[i];
                if (n.parentNode) n.parentNode.removeChild(n);
            }
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
