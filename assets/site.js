/* ============================================================
   LV TRADE SHOW RENTALS — SHARED SITE BEHAVIOR
   Powers all new pages. Vanilla JS, no dependencies.
   Every feature is feature-detected so pages only use what they need.
   Respects prefers-reduced-motion.
   ============================================================ */
(function () {
    'use strict';

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var finePointer = window.matchMedia('(pointer: fine)').matches;

    function ready(fn) {
        if (document.readyState !== 'loading') fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    ready(function () {

        /* ---------- Navbar: solid on scroll ---------- */
        var navbar = document.getElementById('navbar') || document.querySelector('.navbar');
        function onScrollNav() {
            if (!navbar) return;
            if (window.pageYOffset > 40) navbar.classList.add('scrolled');
            else navbar.classList.remove('scrolled');
        }
        onScrollNav();
        window.addEventListener('scroll', onScrollNav, { passive: true });

        /* ---------- Hamburger / mobile drawer ---------- */
        var hamburger = document.getElementById('hamburger');
        var menu = document.getElementById('navbar-menu');
        var overlay = document.getElementById('menu-overlay');
        function closeMenu() {
            if (hamburger) hamburger.classList.remove('active');
            if (menu) menu.classList.remove('active');
            if (overlay) overlay.classList.remove('active');
        }
        if (hamburger && menu) {
            hamburger.addEventListener('click', function () {
                hamburger.classList.toggle('active');
                menu.classList.toggle('active');
                if (overlay) overlay.classList.toggle('active');
            });
        }
        if (overlay) overlay.addEventListener('click', closeMenu);
        if (menu) menu.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeMenu); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

        /* ---------- Active nav link (auto by filename) ---------- */
        if (menu) {
            var path = window.location.pathname.split('/').pop() || 'index.html';
            menu.querySelectorAll('a').forEach(function (a) {
                var href = (a.getAttribute('href') || '').split('/').pop();
                if (href && href === path) a.classList.add('active');
            });
        }

        /* ---------- Smooth scroll for in-page anchors ---------- */
        document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
            anchor.addEventListener('click', function (e) {
                var href = this.getAttribute('href');
                if (href && href.length > 1 && document.querySelector(href)) {
                    e.preventDefault();
                    document.querySelector(href).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
                }
            });
        });

        /* ---------- Scroll reveal ---------- */
        var revealEls = document.querySelectorAll('[data-reveal], .reveal-group');
        if (revealEls.length) {
            if (reduceMotion || !('IntersectionObserver' in window)) {
                revealEls.forEach(function (el) { el.classList.add('revealed'); });
            } else {
                var revObs = new IntersectionObserver(function (entries) {
                    entries.forEach(function (en) {
                        if (en.isIntersecting) { en.target.classList.add('revealed'); revObs.unobserve(en.target); }
                    });
                }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
                revealEls.forEach(function (el) { revObs.observe(el); });
            }
        }

        /* ---------- Count-up stats ---------- */
        function animateCount(el, target, suffix) {
            if (reduceMotion) { el.textContent = target + (suffix || ''); return; }
            var dur = 1800, start = 0, t0 = null;
            function step(ts) {
                if (!t0) t0 = ts;
                var p = Math.min((ts - t0) / dur, 1);
                var eased = 1 - Math.pow(1 - p, 3);
                el.textContent = Math.floor(eased * (target - start) + start) + (suffix || '');
                if (p < 1) requestAnimationFrame(step);
                else el.textContent = target + (suffix || '');
            }
            requestAnimationFrame(step);
        }
        var counters = document.querySelectorAll('[data-count]');
        if (counters.length && 'IntersectionObserver' in window) {
            var cObs = new IntersectionObserver(function (entries) {
                entries.forEach(function (en) {
                    if (en.isIntersecting && !en.target.dataset.done) {
                        en.target.dataset.done = '1';
                        var target = parseInt(en.target.getAttribute('data-count'), 10);
                        var suffix = en.target.getAttribute('data-suffix') || '';
                        var numEl = en.target.querySelector('.stat-num') || en.target;
                        animateCount(numEl, target, suffix);
                    }
                });
            }, { threshold: 0.5 });
            counters.forEach(function (c) { cObs.observe(c); });
        } else {
            counters.forEach(function (c) {
                var numEl = c.querySelector('.stat-num') || c;
                numEl.textContent = c.getAttribute('data-count') + (c.getAttribute('data-suffix') || '');
            });
        }

        /* ---------- 3D tilt ---------- */
        if (finePointer && !reduceMotion) {
            document.querySelectorAll('.tilt').forEach(function (card) {
                var max = parseFloat(card.getAttribute('data-tilt-max') || '9');
                card.addEventListener('mousemove', function (e) {
                    var r = card.getBoundingClientRect();
                    var px = (e.clientX - r.left) / r.width;
                    var py = (e.clientY - r.top) / r.height;
                    var rx = (0.5 - py) * max * 2;
                    var ry = (px - 0.5) * max * 2;
                    card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
                    card.style.setProperty('--gx', (px * 100).toFixed(1) + '%');
                    card.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
                });
                card.addEventListener('mouseleave', function () {
                    card.style.transform = 'perspective(900px) rotateX(0) rotateY(0)';
                });
            });
        }

        /* ---------- Parallax ([data-parallax="0.3"]) ---------- */
        var parallaxEls = document.querySelectorAll('[data-parallax]');
        if (parallaxEls.length && !reduceMotion) {
            var ticking = false;
            function parallax() {
                var vh = window.innerHeight;
                parallaxEls.forEach(function (el) {
                    var speed = parseFloat(el.getAttribute('data-parallax')) || 0.2;
                    var r = el.getBoundingClientRect();
                    if (r.bottom > 0 && r.top < vh) {
                        var offset = (r.top + r.height / 2 - vh / 2) * -speed;
                        el.style.transform = 'translate3d(0,' + offset.toFixed(1) + 'px,0)';
                    }
                });
                ticking = false;
            }
            window.addEventListener('scroll', function () {
                if (!ticking) { requestAnimationFrame(parallax); ticking = true; }
            }, { passive: true });
            parallax();
        }

        /* ---------- AJAX form submit (progressive enhancement) ----------
           Forms post to FormSubmit.co. The markup keeps the plain endpoint so a
           no-JS browser still submits and lands on FormSubmit's thank-you page;
           here we rewrite it to the /ajax/ endpoint, which answers with JSON so
           the visitor never leaves the page. ------------------------------- */
        document.querySelectorAll('form[data-ajax="true"]').forEach(function (form) {
            form.addEventListener('submit', function (e) {
                var action = form.getAttribute('action') || '';
                // If the form still points at a placeholder endpoint, let it submit
                // normally so the user clearly sees it needs configuring.
                if (action.indexOf('YOUR_FORM_ID') !== -1) return;
                if (action.indexOf('formsubmit.co/') !== -1 && action.indexOf('/ajax/') === -1) {
                    action = action.replace('formsubmit.co/', 'formsubmit.co/ajax/');
                }
                e.preventDefault();
                var btn = form.querySelector('[type="submit"]');
                var original = btn ? btn.textContent : '';
                if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
                fetch(action, { method: 'POST', body: new FormData(form), headers: { 'Accept': 'application/json' } })
                    .then(function (r) {
                        if (r.ok) {
                            var ok = form.parentNode.querySelector('.form-success');
                            if (ok) { form.style.display = 'none'; ok.style.display = 'block'; }
                            else { form.reset(); if (btn) btn.textContent = 'Sent ✓'; }
                        } else { throw new Error('submit failed'); }
                    })
                    .catch(function () {
                        if (btn) { btn.disabled = false; btn.textContent = original; }
                        /* Let the build stage put the booth back — otherwise it
                           stays packed into its road case and slid off screen
                           while the user is being told to try again. */
                        form.dispatchEvent(new Event('bs:restore'));
                        alert('Something went wrong. Please call us at 702-483-8279 or try again.');
                    });
            });
        });

    });
})();
