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
 *     <div class="sv-track"><div class="sv-pin"> <video class="sv-video"
 *
 * The clip's URL goes in data-src, NOT src, with preload="none" — the script
 * promotes it to a real src once the block is within ~1.5 screens. Leaving it
 * in src still works and simply loads it immediately, which costs the visitor a
 * multi-megabyte download during first paint for a stage they have not reached.
 *
 * The scope's height is whatever the sections inside it come to, so the clip is
 * paced by the content it plays behind. Tune the pace with those sections'
 * min-height in the stylesheet. data-scroll-length="340" (vh) is only for a
 * standalone block that has no content of its own to give it height.
 *
 * data-scroll-start="50" (vh) starts the scrub half a screen EARLY, while the
 * block is still rising into view, rather than holding frame 0 until it pins.
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

    /* Lead-in before the block is pinned, as a fraction of the viewport.
       Clamped to one screen: beyond that the scrub would begin before any of
       the block is on screen at all. */
    var lead = parseFloat(section.getAttribute('data-scroll-start'));
    this.lead = (isFinite(lead) && lead > 0) ? Math.min(lead, 100) / 100 : 0;

    /* Threshold for "is this a different frame yet". There is no API for a
       clip's frame rate, so this is a deliberate under-estimate: too small only
       costs a redundant seek, which the seeking guard absorbs, while too large
       would visibly drop frames on 60fps footage. */
    this.frame = 1 / 60;
    this.lastSeek = -1;
    this.ready = false;
    this.running = false;
    this.visible = false;
    this.requested = false;
    this.lastT = 0;

    /* Listeners first, fetch second: requestLoad() below is what actually starts
       the download, and it must never race ahead of the handlers watching for it. */
    this.watchMedia();
    this.bind();
  }

  /**
   * Wire up the media events. This does NOT start a download — see requestLoad.
   */
  ScrollVideo.prototype.watchMedia = function () {
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

    /* A clip left inline in the markup (no data-src) is already downloading, so
       it is past the point requestLoad would take it to. */
    if (v.getAttribute('src')) {
      this.requested = true;
      this.armTimeout();
      if (v.readyState >= 1) {
        this.duration = v.duration || 0;
        if (this.duration > 0) { this.sizeTrack(); this.measure(); prime(); }
      }
      if (v.readyState >= 3) this.markReady();
    }
  };

  /**
   * Start fetching the clip.
   *
   * The markup holds the URL in data-src and preload="none", so nothing is
   * requested until this runs — a scroll stage sits several screens down the
   * page, and a multi-megabyte clip downloading during first paint competes
   * with the content the visitor is actually looking at. bind() calls this when
   * the block is within ~1.5 screens, which on any real scroll speed is a long
   * time before the first frame is needed, so the stage is still fully buffered
   * by the time it pins. The file itself is untouched: same bytes, later.
   */
  ScrollVideo.prototype.requestLoad = function () {
    if (this.requested) return;
    this.requested = true;

    var v = this.video;
    var src = v.getAttribute('data-src');
    if (src && !v.getAttribute('src')) v.setAttribute('src', src);
    v.preload = 'auto';
    try { v.load(); } catch (e) { /* older engines fetch off the src alone */ }
    this.armTimeout();
  };

  /**
   * If nothing has loaded at all after a generous wait, fall back to the poster
   * rather than leaving a blank pinned block in the page. Armed when the fetch
   * starts, not at construction — otherwise a deferred clip would be written off
   * before it was ever asked for.
   *
   * The deadline judges PROGRESS rather than elapsed time. Since the fetch now
   * begins a screen or so before the stage is needed instead of at page load,
   * there is less slack in front of it, and a fixed stopwatch would write off a
   * clip on a slow connection that was still arriving perfectly well. Two things
   * therefore buy more time: bytes actually landing, and a backgrounded tab —
   * browsers suspend media loading outright when the tab is hidden, so a stalled
   * counter there says nothing about whether the clip is reachable.
   */
  ScrollVideo.prototype.armTimeout = function () {
    var self = this;
    var v = this.video;
    var STEP = 20000;
    var STALL_LIMIT = 3;   // consecutive checks with no new bytes before giving up
    var stalled = 0;
    var lastEnd = -1;

    function bufferedEnd() {
      try { return v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; }
      catch (e) { return 0; }
    }

    function check() {
      if (self.ready) return;

      /* Hidden tab: the browser has parked the download. Do not judge it, and do
         not let the clock run while it is parked. */
      if (document.hidden) { window.setTimeout(check, STEP); return; }

      /* Give up on a STALL, not on a stopwatch. A wall-clock deadline punishes a
         slow connection for being slow — these clips are multi-megabyte, and a
         visitor on hotel wifi can legitimately still be downloading well past any
         fixed cutoff. What actually means "this is never going to arrive" is the
         buffer not growing between checks. */
      var end = bufferedEnd();
      var grew = end > lastEnd;
      lastEnd = end;

      var loading = v.networkState === 2 /* NETWORK_LOADING */;
      if (grew || (loading && v.readyState > 0)) { stalled = 0; }
      else { stalled++; }

      if (stalled < STALL_LIMIT) { window.setTimeout(check, STEP); return; }

      if (!v.readyState || v.readyState < 2) self.fail('video stalled while loading');
    }

    window.setTimeout(check, STEP);
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
      var url = this.video
        ? (this.video.getAttribute('src') || this.video.getAttribute('data-src') || 'unknown')
        : 'unknown';
      console.warn('[scroll-video] ' + why + ' — falling back to the poster. ' +
        'Expected a clip at ' + url);
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
   * Progress geometry. By default 0 is the instant the pin's top edge reaches
   * the top of the viewport and 1 is when the track's bottom edge reaches the
   * bottom of it — exactly the span over which the sticky element is stuck, so
   * the first and last frames are both reachable and neither is clipped.
   *
   * data-scroll-start (in vh) moves the START EARLIER by that much, so the clip
   * is already running while the block is still rising into view instead of
   * sitting on frame 0 until it is pinned. "50" begins the scrub when the
   * block's top edge is halfway up the screen. The end is unchanged, so a
   * lead-in lengthens the scrub rather than speeding it up.
   */
  ScrollVideo.prototype.measure = function () {
    var rect = this.track.getBoundingClientRect();
    var top = rect.top + window.pageYOffset;
    var start = top - this.lead * window.innerHeight;
    var end = top + this.track.offsetHeight - window.innerHeight;
    this.range = { top: start, scrub: Math.max(1, end - start) };
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

    /* Fetch the clip once the block is within ~1.5 screens of the viewport, so
       the download is well underway before the stage pins but is not competing
       with first paint. One-shot: disconnect as soon as it has fired. */
    if ('IntersectionObserver' in window) {
      var pio = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            self.requestLoad();
            pio.disconnect();
            return;
          }
        }
      }, { rootMargin: '150% 0px' });
      pio.observe(this.track);
    } else {
      /* No observer to tell us when to start, so behave as before. */
      this.requestLoad();
    }

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
