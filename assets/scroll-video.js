/**
 * scroll-video.js — scroll-scrubbed video.
 *
 * The video does not play on its own. Its playhead is bound to the scroll
 * position over a pinned block: scroll down and it runs forward, scroll back up
 * and it runs backward, stop and it holds on a frame. Reverse comes free —
 * "reverse" is just a decreasing target, not a separate playback mode.
 *
 * On index.html the pinned block spans three content sections, so the clip runs
 * as a backdrop from the first headline through to the end of the third.
 *
 * Smoothness comes from three things, in order of how much they matter:
 *
 *   1. THE ENCODE. Ordinary H.264 only stores a full picture every few seconds
 *      and rebuilds everything in between from the frame before it. Seeking
 *      backwards through that means decoding a whole group of pictures for every
 *      step, which is exactly the stutter people mean by "jittery scroll video".
 *      An all-intra encode (every frame a keyframe) makes any frame a direct
 *      lookup. Re-encode the source once with:
 *
 *        ffmpeg -i source.mp4 -an -vf "scale=1600:-2" -c:v libx264
 *               -preset slow -crf 22 -g 1 -pix_fmt yuv420p
 *               -movflags +faststart assets/booth-scroll.mp4
 *
 *      -g 1 is the important flag (every frame a keyframe) and -an drops the
 *      audio track, which is dead weight for a clip that never plays.
 *   2. A DAMPED TARGET. Raw scroll is a step function on a wheel — it arrives in
 *      ~100px jumps. We spring toward it instead of snapping, so the playhead
 *      accelerates and eases rather than teleporting.
 *   3. NOT OUTRUNNING THE DECODER. A new seek is only issued when the previous
 *      one has been served. Queuing seeks faster than the decoder can answer is
 *      what makes a scrubber feel like it is fighting you.
 *
 * No dependencies, no modules, no import map — so it also works over file://.
 *
 * Markup contract (see index.html):
 *   <section class="sv" data-scroll-video>
 *     <div class="sv-track"><div class="sv-pin"> <video class="sv-video">
 *
 * The scope's height is whatever the sections inside it come to, so the clip is
 * paced by the content it plays behind. Tune the pace with those sections'
 * min-height in the stylesheet. data-scroll-length="340" (vh) is only for a
 * standalone block that has no content of its own to give it height.
 */

(function () {
  'use strict';

  var REDUCED = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function ScrollVideo(section) {
    this.section = section;
    this.track = section.querySelector('.sv-track');
    this.pin = section.querySelector('.sv-pin');
    this.video = section.querySelector('.sv-video');
    this.bar = section.querySelector('.sv-bar-fill');

    if (!this.track || !this.pin || !this.video) return;

    this.p = 0;          // raw scroll progress, 0..1
    this.smooth = 0;     // damped playhead position, 0..1
    this.vel = 0;
    this.duration = 0;
    /* Threshold for "is this a different frame yet". There is no API for a
       clip's frame rate, so this is a deliberate under-estimate: too small only
       costs a redundant seek, which the seeking guard absorbs, while too large
       would visibly drop frames on 60fps footage. */
    this.frame = 1 / 60;
    this.lastSeek = -1;
    this.ready = false;
    this.running = false;
    this.visible = false;
    this.lastT = 0;

    this.bind();
    this.load();
  }

  ScrollVideo.prototype.load = function () {
    var self = this;
    var v = this.video;

    /* Muted inline video is allowed to start on its own, and on iOS a video that
       has never played will not paint a seeked frame at all — so we start it and
       immediately stop it, purely to wake the decoder up. */
    function prime() {
      var pr = v.play();
      if (pr && pr.then) pr.then(function () { v.pause(); }).catch(function () {});
      else { try { v.pause(); } catch (e) {} }
    }

    v.addEventListener('loadedmetadata', function () {
      self.duration = v.duration || 0;
      if (!isFinite(self.duration) || self.duration <= 0) return self.fail('no duration');
      self.sizeTrack();
      self.measure();
      prime();
    });

    /* readyState 4 means it can play through without stalling, which for a
       scrubber means the frames are there to seek to. */
    v.addEventListener('canplaythrough', function () { self.markReady(); });
    v.addEventListener('loadeddata', function () {
      if (v.readyState >= 2) self.markReady();
    });

    v.addEventListener('error', function () { self.fail('video failed to load'); });

    /* If nothing has loaded at all after a generous wait, fall back to the
       poster rather than leaving a blank pinned block in the page. */
    window.setTimeout(function () {
      if (!self.ready && (!v.readyState || v.readyState < 2)) self.fail('video did not load');
    }, 20000);

    if (v.readyState >= 1) {
      self.duration = v.duration || 0;
      if (self.duration > 0) { self.sizeTrack(); self.measure(); prime(); }
    }
    if (v.readyState >= 3) self.markReady();
  };

  ScrollVideo.prototype.markReady = function () {
    if (this.ready) return;
    this.ready = true;
    this.section.classList.add('is-ready');
    /* Land on the first frame so the block never shows black before the visitor
       reaches it. */
    this.seek(0);
    this.update();
  };

  /**
   * Hide the stage and let the sections fall back to their own backgrounds.
   * Every style override is scoped to .sv:not(.sv-off), so adding the class is
   * all it takes — the copy stops being transparent-over-video and the page
   * looks exactly as it would have without the feature.
   */
  ScrollVideo.prototype.fail = function (why) {
    if (this.section.classList.contains('sv-off')) return;
    this.section.classList.add('sv-off');
    var poster = this.video && this.video.getAttribute('poster');
    if (poster) this.pin.style.backgroundImage = 'url("' + poster + '")';
    this.stop();
    if (window.console && console.warn) {
      console.warn('[scroll-video] ' + why + ' — falling back to the poster. ' +
        'Expected a clip at assets/booth-scroll.mp4');
    }
  };

  /**
   * Track height.
   *
   * Normally there is nothing to do: the scope's height is whatever the sections
   * inside it come to, which is the point — the clip is paced by the content it
   * is playing behind, not the other way round. Tune it with the sections'
   * min-height in the stylesheet.
   *
   * data-scroll-length (in vh) is only for a standalone block with no content
   * of its own to give it height.
   */
  ScrollVideo.prototype.sizeTrack = function () {
    var fixed = parseFloat(this.section.getAttribute('data-scroll-length'));
    if (isFinite(fixed) && fixed > 0) {
      this.track.style.height = fixed + 'vh';
    }
  };

  /**
   * Progress geometry. 0 the instant the pin's top edge reaches the top of the
   * viewport, 1 when the track's bottom edge reaches the bottom of it. That is
   * exactly the span over which the sticky element is actually stuck, so the
   * first and last frames are both reachable and neither is clipped.
   */
  ScrollVideo.prototype.measure = function () {
    var rect = this.track.getBoundingClientRect();
    var top = rect.top + window.pageYOffset;
    var scrub = Math.max(1, this.track.offsetHeight - window.innerHeight);
    this.range = { top: top, scrub: scrub };
  };

  ScrollVideo.prototype.progress = function () {
    if (!this.range) return 0;
    return clamp01((window.pageYOffset - this.range.top) / this.range.scrub);
  };

  /**
   * Issue a seek, but never more than one at a time.
   *
   * If the decoder is still working, the request is DROPPED rather than queued.
   * The animation loop is running anyway and will try again next frame with a
   * fresher target — whereas a queued one would, by the time it was served, be
   * pointing at where the scroll used to be. Replaying stale targets is what
   * makes a reversing scrub stutter forward for a frame before catching itself.
   *
   * lastSeek is only updated when a seek is actually issued, so a dropped one is
   * guaranteed to be retried rather than swallowed by the threshold below.
   */
  ScrollVideo.prototype.seek = function (t) {
    var v = this.video;
    if (!this.duration) return;
    var want = clamp(t, 0, Math.max(0, this.duration - this.frame * 0.5));

    /* Below half a frame there is nothing new to show. */
    if (this.lastSeek >= 0 && Math.abs(want - this.lastSeek) < this.frame * 0.5) return;
    if (v.seeking) return;

    this.lastSeek = want;
    try { v.currentTime = want; } catch (e) { /* not seekable yet */ }
  };

  /** Progress readout. scaleX on a pre-sized bar, so it never triggers layout. */
  ScrollVideo.prototype.update = function () {
    if (this.bar) this.bar.style.transform = 'scaleX(' + this.smooth.toFixed(4) + ')';
  };

  ScrollVideo.prototype.tick = function (now) {
    if (!this.running) return;
    this.raf = window.requestAnimationFrame(this.boundTick);

    var dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : 1 / 60;
    this.lastT = now;

    this.p = this.progress();

    if (REDUCED) {
      this.smooth = this.p;
      this.vel = 0;
    } else {
      /* Critically damped spring. Stiffness rises with the size of the gap, so
         ordinary scrubbing feels weighted while a big jump — an anchor link, a
         resize, a run of dropped frames — is caught in a beat instead of
         drifting seconds behind the page. */
      var x = this.smooth - this.p;
      var w = 9.0 + Math.abs(x) * 30;
      var ex = Math.exp(-w * dt);
      var tmp = (this.vel + w * x) * dt;
      var next = this.p + (x + tmp) * ex;

      /* Never travel away from the target. At the instant the visitor reverses,
         the spring still carries the momentum of the previous direction, so the
         playhead would run forward for a frame or two before turning around —
         a small thing, but it reads as the video glitching rather than obeying.
         Freezing instead (and dumping the momentum) makes the turn crisp while
         leaving the damping untouched everywhere else. */
      if ((next - this.smooth) * (this.p - this.smooth) < 0) {
        next = this.smooth;
        this.vel = 0;
      } else {
        this.vel = (this.vel - w * tmp) * ex;
      }
      this.smooth = next;
    }

    if (this.ready) this.seek(this.smooth * this.duration);
    this.update();
  };

  ScrollVideo.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.lastT = 0;
    this.raf = window.requestAnimationFrame(this.boundTick);
  };

  ScrollVideo.prototype.stop = function () {
    this.running = false;
    if (this.raf) window.cancelAnimationFrame(this.raf);
  };

  ScrollVideo.prototype.bind = function () {
    var self = this;
    this.boundTick = function (t) { self.tick(t); };

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        self.sizeTrack();
        self.measure();
      }, 120);
    }, { passive: true });

    window.addEventListener('load', function () { self.measure(); });

    /* Only burn frames while the block is on screen — and only decode while it
       is, which also stops the video holding a decoder open down the page. */
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          self.visible = entries[i].isIntersecting;
        }
        if (self.visible) { self.measure(); self.start(); } else { self.stop(); }
      }, { rootMargin: '25% 0px' });
      io.observe(this.track);
    } else {
      this.visible = true;
      this.start();
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !self.visible) self.stop(); else self.start();
    });
  };

  function boot() {
    var nodes = document.querySelectorAll('[data-scroll-video]');
    for (var i = 0; i < nodes.length; i++) new ScrollVideo(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
