// Mobile nav. On desktop the top bar shows the full nav. At ≤820px the bar
// collapses to brand + a hamburger, and EVERYTHING else — the nav links, the
// GitHub link, and the primary CTA — drops into a panel the hamburger opens.
// (Leaving GitHub + CTA in the bar on mobile pushed the hamburger off-screen,
// which is why the menu was unreachable.) Shared by every page; the only per-page
// markup is the <script defer src="/nav.js"> tag and the nav links themselves.
(function () {
  function init() {
    var nav = document.querySelector('nav.top');
    if (!nav) return;
    var wrap = nav.querySelector('.wrap');
    var links = nav.querySelector('.links');
    if (!wrap || !links) return;

    // Hamburger button (shown only ≤820px via CSS).
    var btn = document.createElement('button');
    btn.className = 'nav-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';

    // Mobile panel: clone the nav links, then the GitHub link, then the CTA, so
    // the whole bar is reachable from the menu. Cloning keeps the desktop bar
    // untouched; the originals are just hidden by CSS at mobile width.
    var panel = document.createElement('div');
    panel.className = 'nav-panel';
    links.querySelectorAll('a').forEach(function (a) { panel.appendChild(a.cloneNode(true)); });
    var ghost = wrap.querySelector(':scope > .ghost');
    if (ghost) panel.appendChild(ghost.cloneNode(true));
    var cta = wrap.querySelector(':scope > .btn.primary');
    if (cta) { var c = cta.cloneNode(true); c.classList.add('panel-cta'); panel.appendChild(c); }

    function setOpen(open) {
      nav.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function () { setOpen(!nav.classList.contains('open')); });
    panel.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', function (e) {
      if (nav.classList.contains('open') && !nav.contains(e.target)) setOpen(false);
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 820) setOpen(false); });

    wrap.appendChild(btn);
    nav.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
