// Quick-install modal — shared across all marketing pages. Zero dependencies.
//
// A browser page CANNOT install software on a visitor's machine (the sandbox
// forbids it), so this is the honest version of "quick install": a guided,
// OS-aware walkthrough that ends in one copy-paste. Because Codenomics runs via
// `npx` (identical on every OS), the OS tabs only differ in the Node 20+
// prerequisite and how you open a terminal.
//
// Any element with [data-install-open] opens the dialog. We listen via event
// delegation on document, so nav.js's cloned mobile-panel CTA opens it too,
// regardless of script order. The <dialog> is built once on first open.
(function () {
  var CMD = 'npx codenomics init';

  var OS = {
    macos: {
      label: 'macOS',
      term: 'Open <b>Terminal</b> — press ⌘&nbsp;Space, type “Terminal”, hit Enter.',
      node: {
        cmd: 'brew install node',
        note: 'No Homebrew? <a href="https://nodejs.org/en/download" target="_blank" rel="noopener">Download the macOS installer →</a>'
      }
    },
    windows: {
      label: 'Windows',
      term: 'Open <b>PowerShell</b> — press ⊞&nbsp;Win, type “PowerShell”, hit Enter.',
      node: {
        cmd: 'winget install OpenJS.NodeJS.LTS',
        note: 'No winget? <a href="https://nodejs.org/en/download" target="_blank" rel="noopener">Download the Windows installer →</a>'
      }
    },
    linux: {
      label: 'Linux',
      term: 'Open your <b>terminal</b> (on most desktops, Ctrl&nbsp;Alt&nbsp;T).',
      node: {
        cmd: '',
        note: 'Install Node 20+ with <a href="https://github.com/nvm-sh/nvm" target="_blank" rel="noopener">nvm</a> or your distro’s package manager.'
      }
    }
  };

  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) ||
             navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.indexOf('win') > -1) return 'windows';
    if (p.indexOf('mac') > -1 || p.indexOf('iphone') > -1 || p.indexOf('ipad') > -1) return 'macos';
    return 'linux';
  }

  function cmdRow(text) {
    return '<div class="cmd"><span><span class="prompt">$</span> ' + text + '</span>' +
           '<button type="button" class="im-copy" data-copy="' + text + '">copy</button></div>';
  }

  var dialog, steps;

  function renderSteps(os) {
    var d = OS[os];
    steps.innerHTML =
      '<div class="im-step"><div class="im-n">1</div><div class="im-body">' +
        '<h4>Open your terminal</h4><p>' + d.term + '</p></div></div>' +
      '<div class="im-step"><div class="im-n">2</div><div class="im-body">' +
        '<h4>Make sure you have Node&nbsp;20+</h4>' +
        '<p>Check with <code>node -v</code>. Need it?</p>' +
        (d.node.cmd ? cmdRow(d.node.cmd) : '') +
        '<p class="im-note">' + d.node.note + '</p>' +
      '</div></div>' +
      '<div class="im-step"><div class="im-n">3</div><div class="im-body">' +
        '<h4>Run Codenomics</h4>' +
        '<p><code>npx</code> runs it instantly — no global install, nothing left behind.</p>' +
        cmdRow(CMD) +
      '</div></div>';

    Array.prototype.forEach.call(dialog.querySelectorAll('.im-tab'), function (t) {
      var on = t.getAttribute('data-os') === os;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'install-modal';
    dialog.setAttribute('aria-label', 'Install Codenomics');
    dialog.innerHTML =
      '<div class="im-head">' +
        '<form method="dialog"><button class="im-close" type="submit" aria-label="Close">✕</button></form>' +
        '<span class="eyebrow">● Quick install</span>' +
        '<h3>Codenomics running in ~30 seconds</h3>' +
        '<p class="im-sub">Local-first — your code, prompts and transcripts never leave your machine.</p>' +
      '</div>' +
      '<div class="im-tabs" role="tablist">' +
        Object.keys(OS).map(function (k) {
          return '<button type="button" class="im-tab" role="tab" data-os="' + k + '">' + OS[k].label + '</button>';
        }).join('') +
      '</div>' +
      '<div class="im-steps"></div>' +
      '<div class="im-foot">Then <code>npx codenomics serve</code> opens your private dashboard at ' +
        '<code>localhost:3737</code>. ' +
        '<a href="https://www.npmjs.com/package/codenomics" target="_blank" rel="noopener">npm</a> · ' +
        '<a href="https://github.com/axomiqlabs/codenomics" target="_blank" rel="noopener">source</a></div>';

    steps = dialog.querySelector('.im-steps');

    dialog.addEventListener('click', function (e) {
      var tab = e.target.closest('.im-tab');
      if (tab) { renderSteps(tab.getAttribute('data-os')); return; }

      var copy = e.target.closest('.im-copy');
      if (copy) {
        if (navigator.clipboard) navigator.clipboard.writeText(copy.getAttribute('data-copy'));
        var prev = copy.textContent;
        copy.textContent = 'copied';
        setTimeout(function () { copy.textContent = prev; }, 1400);
        return;
      }

      // A click on the dialog element itself (the padding/backdrop area, not its
      // content) closes it. Esc + the ✕ button are handled natively by <form
      // method="dialog">.
      if (e.target === dialog) dialog.close();
    });

    document.body.appendChild(dialog);
    renderSteps(detectOS());
  }

  function open() {
    if (!dialog) build();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', ''); // ancient-browser fallback
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-install-open]');
    if (!trigger) return;
    e.preventDefault();
    open();
  });
})();
