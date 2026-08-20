/*
 * print.js — the print dialog, and the page setup that goes with it.
 *
 * Printing straight from a browser tab hands the page over to whatever @page
 * rule the file happens to carry. Chrome then greys out paper and orientation
 * — the document already decided them — and the PDF comes out sideways with
 * no way to argue. So the editor prints a copy of its own: the document
 * without the editor's marks and with its scripts still parked, rendered into
 * a frame whose page setup this module writes, with the document's own @page
 * rules dropped first. The browser dialog opens on top of that with nothing
 * decided for it.
 */
(function () {
  'use strict';

  var MM_PX = 96 / 25.4;          // CSS millimetre, at the 96dpi print assumes
  var STYLE_ID = 'html-editor-print-css';
  var SETUP_ID = 'html-editor-print-setup';
  var SETUP_ATTR = 'data-print-setup';
  var STORE_KEY = 'html-editor.print';
  // Not he-*: that prefix belongs to the editor's own marks, and serialize()
  // strips it on the way to disk — a page break has to survive being saved.
  var BREAK_CLASS = 'page-break';

  var PAPERS = [
    { id: 'a4', label: 'A4', w: 210, h: 297 },
    { id: 'letter', label: 'Letter (8.5 × 11 in)', w: 215.9, h: 279.4 },
    { id: 'legal', label: 'Legal (8.5 × 14 in)', w: 215.9, h: 355.6 },
    { id: 'tabloid', label: 'Tabloid (11 × 17 in)', w: 279.4, h: 431.8 },
    { id: 'a3', label: 'A3', w: 297, h: 420 },
    { id: 'a5', label: 'A5', w: 148, h: 210 },
    { id: 'custom', label: '', w: 210, h: 297 }
  ];

  var MARGIN_PRESETS = {
    normal: [20, 20, 20, 20],
    narrow: [10, 10, 10, 10],
    wide: [25, 30, 25, 30],
    none: [0, 0, 0, 0]
  };

  var DEFAULTS = {
    paper: 'a4',
    customW: 210,
    customH: 297,
    landscape: false,
    lockPaper: true,
    marginPreset: 'normal',
    margins: [20, 20, 20, 20],
    fitWidth: false,
    scale: 100,
    backgrounds: true,
    dropDocumentPage: true,
    keepTogether: true,
    repeatHeaders: true,
    fitImages: true,
    fullWidth: false
  };

  /* ------------------------------------------------------------- options -- */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function sanitise(raw) {
    var o = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') { return o; }
    Object.keys(DEFAULTS).forEach(function (key) {
      if (raw[key] === undefined || raw[key] === null) { return; }
      if (key === 'margins') {
        if (Object.prototype.toString.call(raw.margins) === '[object Array]' && raw.margins.length === 4) {
          o.margins = raw.margins.map(function (n) { return clampNumber(n, 0, 100, 0); });
        }
        return;
      }
      if (typeof DEFAULTS[key] === 'boolean') { o[key] = !!raw[key]; return; }
      if (typeof DEFAULTS[key] === 'number') { o[key] = clampNumber(raw[key], 5, 2000, DEFAULTS[key]); return; }
      o[key] = String(raw[key]);
    });
    if (!paperById(o.paper)) { o.paper = DEFAULTS.paper; }
    o.scale = clampNumber(o.scale, 10, 400, 100);
    return o;
  }

  function clampNumber(value, min, max, fallback) {
    var n = parseFloat(value);
    if (!isFinite(n)) { return fallback; }
    return Math.min(max, Math.max(min, n));
  }

  function paperById(id) {
    for (var i = 0; i < PAPERS.length; i++) { if (PAPERS[i].id === id) { return PAPERS[i]; } }
    return null;
  }

  /** Paper size in millimetres, orientation already applied. */
  function paperSize(o) {
    var paper = paperById(o.paper) || PAPERS[0];
    var w = o.paper === 'custom' ? o.customW : paper.w;
    var h = o.paper === 'custom' ? o.customH : paper.h;
    return o.landscape ? { w: h, h: w } : { w: w, h: h };
  }

  /** The rectangle the content actually gets, in CSS pixels. */
  function usableBox(o) {
    var size = paperSize(o);
    var m = o.margins;
    return {
      w: Math.max(40, (size.w - m[1] - m[3]) * MM_PX),
      h: Math.max(40, (size.h - m[0] - m[2]) * MM_PX)
    };
  }

  function round(n) { return Math.round(n * 100) / 100; }

  /* ----------------------------------------------------------- print CSS -- */

  function pageRule(o) {
    var size = paperSize(o);
    var margin = o.margins.map(function (n) { return round(n) + 'mm'; }).join(' ');
    // Naming a size is what pins the job to this paper — and also what makes
    // the browser dialog grey the choice out. Someone who would rather decide
    // there gets the margins and nothing else.
    var decl = o.lockPaper
      ? 'size: ' + round(size.w) + 'mm ' + round(size.h) + 'mm; margin: ' + margin + ';'
      : 'margin: ' + margin + ';';
    return '@page { ' + decl + ' }';
  }

  function printCSS(o, forScreen) {
    var css = [];
    if (!forScreen) { css.push(pageRule(o)); }
    css.push('html { background: #fff; }');
    if (o.scale !== 100) {
      // zoom, not transform: a scaled transform paints outside the page box
      // and the printer keeps paginating as if nothing had shrunk.
      css.push('html { zoom: ' + round(o.scale / 100) + '; }');
    }
    if (o.backgrounds) {
      css.push('*, *::before, *::after {' +
        ' -webkit-print-color-adjust: exact !important;' +
        ' print-color-adjust: exact !important; }');
    }
    if (o.fullWidth) {
      css.push('body { max-width: none !important; width: auto !important;' +
        ' margin-left: 0 !important; margin-right: 0 !important; }');
    }
    if (o.fitImages) {
      css.push('img, svg, video, canvas, iframe { max-width: 100% !important; height: auto !important; }');
    }
    if (o.keepTogether) {
      css.push('img, svg, figure, table, pre, blockquote { break-inside: avoid; page-break-inside: avoid; }');
      css.push('tr, td, th, li { break-inside: avoid; page-break-inside: avoid; }');
      css.push('h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }');
      css.push('p { orphans: 3; widows: 3; }');
    }
    if (o.repeatHeaders) {
      css.push('thead { display: table-header-group; }');
      css.push('tfoot { display: table-footer-group; }');
    }
    css.push('.' + BREAK_CLASS + ' { break-after: page; page-break-after: always; height: 0; }');
    if (forScreen) {
      // The preview is a sheet, so it shows what overflows the way paper does
      // — cut off at the edge, without a scrollbar offering to reveal it.
      css.push('html { overflow: hidden; }');
      css.push('body { margin: 0 !important; }');
    }
    return css.join('\n');
  }

  /* ------------------------------------------------- setup in the document */

  /** Reads back the setup a previous "Save in the document" wrote, if any. */
  function setupFromDocument() {
    var d = HE.doc();
    var node = d && d.getElementById(SETUP_ID);
    if (!node) { return null; }
    try { return sanitise(JSON.parse(node.getAttribute(SETUP_ATTR) || '{}')); } catch (err) { return null; }
  }

  function writeSetupToDocument(o) {
    var d = HE.doc();
    if (!d || !d.head) { return; }
    HE.edit(function () {
      var node = d.getElementById(SETUP_ID);
      if (!node) {
        node = d.createElement('style');
        node.id = SETUP_ID;
        d.head.appendChild(node);
      }
      node.setAttribute(SETUP_ATTR, JSON.stringify(o));
      node.textContent = '\n/* ' + HE.t('print.cssComment',
        'Page setup written by html-editor. Edit it freely: the editor only ' +
        'rewrites this tag when you press "Save in the document" again.') + ' */\n' +
        printCSS(o, false) + '\n';
    });
  }

  function loadPrefs() {
    try { return sanitise(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (err) { return clone(DEFAULTS); }
  }

  function savePrefs(o) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (err) { /* private mode: not worth a toast */ }
  }

  /* ------------------------------------------------------- render a copy -- */

  /** Absolute URL the document's relative links have to resolve against. */
  function documentBase() {
    var frame = HE.frame();
    var src = (frame && frame.src) || location.href;
    return src.split('#')[0].split('?')[0];
  }

  /**
   * Writes a clean copy of the document into `frame` and calls back once its
   * images, stylesheets and fonts have settled. `forScreen` builds the
   * preview flavour, which leaves @page out because screens ignore it.
   */
  function renderInto(frame, o, forScreen, done) {
    var html = HE.serialize();
    var pdoc = frame.contentDocument;
    if (!pdoc) { done(null); return; }

    pdoc.open();
    pdoc.write(html);
    pdoc.close();

    // about:blank has no base of its own, so every relative image and
    // stylesheet in the document would 404 without this.
    if (!pdoc.querySelector('base')) {
      var base = pdoc.createElement('base');
      base.href = documentBase();
      (pdoc.head || pdoc.documentElement).insertBefore(base, (pdoc.head || pdoc.documentElement).firstChild);
    }

    var style = pdoc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = printCSS(o, forScreen);
    (pdoc.head || pdoc.documentElement).appendChild(style);

    whenSettled(pdoc, function () {
      if (o.dropDocumentPage) { dropPageRules(pdoc); }
      done(pdoc);
    });
  }

  /**
   * Deletes every @page rule the document brought with it. This is the one
   * that unlocks paper and orientation in the browser dialog.
   */
  function dropPageRules(pdoc) {
    var sheets = pdoc.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (sheet.ownerNode && sheet.ownerNode.id === STYLE_ID) { continue; }
      try { dropFrom(sheet); } catch (err) { /* a sheet we cannot read is a sheet we cannot fix */ }
    }
  }

  function dropFrom(container) {
    var rules = container.cssRules;
    if (!rules) { return; }
    for (var i = rules.length - 1; i >= 0; i--) {
      var rule = rules[i];
      if (rule.type === 6) { container.deleteRule(i); }
      else if (rule.cssRules) { dropFrom(rule); }
    }
  }

  function whenSettled(pdoc, done) {
    var win = pdoc.defaultView || window;
    var deadline = Date.now() + 4000;
    var finished = false;

    function finish() {
      if (finished) { return; }
      finished = true;
      if (pdoc.fonts && pdoc.fonts.ready && pdoc.fonts.ready.then) {
        pdoc.fonts.ready.then(function () { done(); }, function () { done(); });
      } else { done(); }
    }

    (function poll() {
      if (Date.now() > deadline) { finish(); return; }
      var pending = false;
      var images = pdoc.images || [];
      for (var i = 0; i < images.length; i++) {
        if (!images[i].complete) { pending = true; break; }
      }
      if (!pending) {
        var links = pdoc.querySelectorAll('link[rel~="stylesheet"]');
        for (var j = 0; j < links.length; j++) {
          try { if (!links[j].sheet) { pending = true; break; } } catch (err) { /* failed to load */ }
        }
      }
      if (!pending) { finish(); return; }
      win.setTimeout(poll, 60);
    })();
  }

  /**
   * Where each sheet ends, in content pixels. A page fills up and breaks on its
   * own, unless a manual break gets there first — everything after one starts
   * on a fresh sheet, however little of the last one was used.
   */
  function pageCuts(pdoc, height, usableH) {
    var win = pdoc.defaultView;
    var marks = pdoc.querySelectorAll('.' + BREAK_CLASS);
    var forced = [];
    for (var i = 0; i < marks.length; i++) {
      var y = marks[i].getBoundingClientRect().top + (win ? win.scrollY : 0);
      if (y > 0) { forced.push(y); }
    }
    forced.sort(function (a, b) { return a - b; });

    var cuts = [];
    var top = 0;
    var next = 0;
    while (top < height && cuts.length < 500) {
      next = top + usableH;
      if (forced.length && forced[0] <= next) {
        var mark = forced.shift();
        if (mark <= top) { continue; }
        next = mark;
      }
      if (next >= height) { break; }
      cuts.push(next);
      top = next;
    }
    return cuts;
  }

  /** Content width with the scale backed out, used by "fit to the width". */
  function measureWidth(pdoc) {
    var body = pdoc.body;
    var root = pdoc.documentElement;
    if (!body || !root) { return 0; }
    var zoom = parseFloat(root.style.zoom || '1') || 1;
    return Math.max(body.scrollWidth, root.scrollWidth) / (zoom || 1);
  }

  /* --------------------------------------------------------------- print -- */

  var printFrame = null;

  function print(o) {
    var d = HE.doc();
    if (!d || !d.body) {
      HE.toast(HE.t('print.notReady', 'The document is still loading'), 'warn');
      return;
    }
    if (printFrame) { printFrame.remove(); printFrame = null; }

    var size = paperSize(o);
    // No src: an explicit about:blank leaves a navigation pending that can
    // land after the write and replace everything with a blank page.
    printFrame = HE.el('iframe', { class: 'print-frame', 'aria-hidden': 'true' });
    printFrame.style.width = Math.round(size.w * MM_PX) + 'px';
    printFrame.style.height = Math.round(size.h * MM_PX) + 'px';
    document.body.appendChild(printFrame);

    renderInto(printFrame, o, false, function (pdoc) {
      if (!pdoc) {
        HE.toast(HE.t('print.failed', 'The document could not be prepared for printing'), 'error');
        return;
      }
      applyFitWidth(pdoc, o, function () {
        var win = printFrame.contentWindow;
        try {
          win.focus();
          win.print();
        } catch (err) {
          HE.toast(HE.t('print.failed', 'The document could not be prepared for printing'), 'error');
        }
        // The frame has to outlive the dialog: Chrome prints from the live
        // document, so tearing it down too early prints a blank page.
        setTimeout(function () {
          if (printFrame) { printFrame.remove(); printFrame = null; }
        }, 60000);
        if (win.addEventListener) {
          win.addEventListener('afterprint', function () {
            setTimeout(function () {
              if (printFrame) { printFrame.remove(); printFrame = null; }
            }, 500);
          });
        }
      });
    });
  }

  /** Turns "fit to the width" into a concrete zoom, once the copy is laid out. */
  function applyFitWidth(pdoc, o, done) {
    if (!o.fitWidth) { done(round(o.scale)); return; }
    var box = usableBox(o);
    var width = measureWidth(pdoc);
    var scale = width > box.w ? Math.max(10, Math.floor((box.w / width) * 100)) : 100;
    var style = pdoc.getElementById(STYLE_ID);
    var effective = clone(o);
    effective.scale = scale;
    if (style) { style.textContent = printCSS(effective, false); }
    done(scale);
  }

  /* ---------------------------------------------------------- page break -- */

  /**
   * Starts a new sheet at the block the cursor is in. The break goes before
   * that block rather than inside it: a div dropped in the middle of a heading
   * is invalid HTML, and the page would break in the middle of the title.
   */
  function insertPageBreak() {
    var d = HE.doc();
    if (!d || HE.readOnly) { return false; }
    var sel = d.getSelection && d.getSelection();
    if (!sel || !sel.rangeCount) { return false; }
    var node = sel.getRangeAt(0).startContainer;
    if (!node || !d.body.contains(node)) { return false; }

    var block = node.nodeType === 1 ? node : node.parentElement;
    while (block && block.parentElement && block.parentElement !== d.body) {
      block = block.parentElement;
    }
    if (!block || block === d.body) { return false; }

    HE.edit(function () {
      var mark = d.createElement('div');
      mark.className = BREAK_CLASS;
      mark.setAttribute('style', 'break-after: page; page-break-after: always; height: 0;');
      block.parentNode.insertBefore(mark, block);
    });
    return true;
  }

  /* ------------------------------------------------------------ the form -- */

  function labelled(text, controls, extraClass) {
    var wrap = HE.el('div', { class: 'field' + (extraClass ? ' ' + extraClass : '') }, [
      HE.el('label', { class: 'field__label', text: text })
    ]);
    controls.forEach(function (c) { wrap.appendChild(c); });
    return wrap;
  }

  function section(title, children) {
    var wrap = HE.el('div', { class: 'props-section' }, [
      HE.el('h3', { class: 'props-section__title', text: title })
    ]);
    children.forEach(function (child) { wrap.appendChild(child); });
    return wrap;
  }

  function checkbox(text, checked, onChange) {
    var input = HE.el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', function () { onChange(input.checked); });
    return HE.el('label', { class: 'print-check' }, [input, HE.el('span', { text: text })]);
  }

  HE.print = HE.print || {};

  HE.print.open = function () {
    var d = HE.doc();
    if (!d || !d.body) {
      HE.toast(HE.t('print.notReady', 'The document is still loading'), 'warn');
      return null;
    }
    var o = setupFromDocument() || loadPrefs();
    var refresh = null;

    var body = HE.el('div', { class: 'print' });
    var form = HE.el('div', { class: 'print__form' });
    var side = HE.el('div', { class: 'print__side' });
    body.appendChild(form);
    body.appendChild(side);

    /* ---- paper ---- */
    var paperSelect = HE.el('select', { class: 'ctl ctl--select field__control' });
    PAPERS.forEach(function (paper) {
      paperSelect.appendChild(HE.el('option', {
        value: paper.id,
        text: paper.id === 'custom' ? HE.t('print.paperCustom', 'Custom size…') : paper.label
      }));
    });
    paperSelect.value = o.paper;
    paperSelect.addEventListener('change', function () {
      o.paper = paperSelect.value;
      customRow.hidden = o.paper !== 'custom';
      refresh();
    });

    var customW = HE.el('input', { class: 'ctl field__control', type: 'number', min: '20', max: '2000', step: '1' });
    var customH = HE.el('input', { class: 'ctl field__control', type: 'number', min: '20', max: '2000', step: '1' });
    customW.value = o.customW;
    customH.value = o.customH;
    customW.addEventListener('change', function () { o.customW = clampNumber(customW.value, 20, 2000, 210); customW.value = o.customW; refresh(); });
    customH.addEventListener('change', function () { o.customH = clampNumber(customH.value, 20, 2000, 297); customH.value = o.customH; refresh(); });
    var customRow = labelled(HE.t('print.customSize', 'Width × height (mm)'), [
      HE.el('div', { class: 'field__row' }, [customW, HE.el('span', { class: 'field__hint', text: '×' }), customH])
    ], 'field--wide');
    customRow.hidden = o.paper !== 'custom';

    var orientation = HE.el('div', { class: 'print__orient' });
    [
      { value: false, label: HE.t('print.portrait', 'Portrait') },
      { value: true, label: HE.t('print.landscape', 'Landscape') }
    ].forEach(function (choice) {
      var btn = HE.el('button', { class: 'btn btn--ghost', type: 'button', text: choice.label });
      btn.addEventListener('click', function () { o.landscape = choice.value; syncOrientation(); refresh(); });
      btn.dataset.value = String(choice.value);
      orientation.appendChild(btn);
    });
    function syncOrientation() {
      HE.$$('button', orientation).forEach(function (btn) {
        btn.classList.toggle('is-active', btn.dataset.value === String(o.landscape));
      });
    }
    syncOrientation();

    var lock = checkbox(
      HE.t('print.lockPaper', 'Pin this paper on the print job'),
      o.lockPaper,
      function (on) { o.lockPaper = on; refresh(); });

    form.appendChild(section(HE.t('print.sec.paper', 'Paper'), [
      HE.el('div', { class: 'props-grid' }, [
        labelled(HE.t('print.paper', 'Size'), [paperSelect]),
        labelled(HE.t('print.orientation', 'Orientation'), [orientation]),
        customRow
      ]),
      lock,
      HE.el('p', {
        class: 'field__hint',
        text: HE.t('print.lockHint',
          'Pinned, the browser dialog shows this paper and greys the choice out. ' +
          'Unpinned, it only gets the margins and you pick paper and orientation there.')
      })
    ]));

    /* ---- margins ---- */
    var marginSelect = HE.el('select', { class: 'ctl ctl--select field__control' });
    [
      { id: 'normal', label: HE.t('print.marginNormal', 'Normal (20 mm)') },
      { id: 'narrow', label: HE.t('print.marginNarrow', 'Narrow (10 mm)') },
      { id: 'wide', label: HE.t('print.marginWide', 'Wide (25 / 30 mm)') },
      { id: 'none', label: HE.t('print.marginNone', 'None') },
      { id: 'custom', label: HE.t('print.marginCustom', 'Custom…') }
    ].forEach(function (choice) {
      marginSelect.appendChild(HE.el('option', { value: choice.id, text: choice.label }));
    });
    marginSelect.value = o.marginPreset;
    marginSelect.addEventListener('change', function () {
      o.marginPreset = marginSelect.value;
      if (MARGIN_PRESETS[o.marginPreset]) { o.margins = MARGIN_PRESETS[o.marginPreset].slice(); }
      syncMargins();
      refresh();
    });

    var sideInputs = [];
    var sideGrid = HE.el('div', { class: 'print__sides' });
    [
      HE.t('print.top', 'Top'), HE.t('print.right', 'Right'),
      HE.t('print.bottom', 'Bottom'), HE.t('print.left', 'Left')
    ].forEach(function (label, index) {
      var input = HE.el('input', { class: 'ctl field__control', type: 'number', min: '0', max: '100', step: '1' });
      input.value = o.margins[index];
      input.addEventListener('change', function () {
        o.margins[index] = clampNumber(input.value, 0, 100, 0);
        input.value = o.margins[index];
        o.marginPreset = 'custom';
        marginSelect.value = 'custom';
        refresh();
      });
      sideInputs.push(input);
      sideGrid.appendChild(labelled(label, [input]));
    });
    function syncMargins() {
      sideInputs.forEach(function (input, index) { input.value = o.margins[index]; });
    }

    form.appendChild(section(HE.t('print.sec.margins', 'Margins'), [
      HE.el('div', { class: 'props-grid' }, [labelled(HE.t('print.marginPreset', 'Preset'), [marginSelect])]),
      sideGrid
    ]));

    /* ---- scale ---- */
    var scaleInput = HE.el('input', { class: 'ctl field__control', type: 'number', min: '10', max: '400', step: '5' });
    scaleInput.value = o.scale;
    scaleInput.disabled = o.fitWidth;
    scaleInput.addEventListener('change', function () {
      o.scale = clampNumber(scaleInput.value, 10, 400, 100);
      scaleInput.value = o.scale;
      refresh();
    });
    var fit = checkbox(HE.t('print.fitWidth', 'Shrink until the page is wide enough'), o.fitWidth, function (on) {
      o.fitWidth = on;
      scaleInput.disabled = on;
      refresh();
    });

    form.appendChild(section(HE.t('print.sec.scale', 'Scale'), [
      HE.el('div', { class: 'props-grid' }, [labelled(HE.t('print.scale', 'Scale (%)'), [scaleInput])]),
      fit
    ]));

    /* ---- what goes on the paper ---- */
    var toggles = HE.el('div', { class: 'print__toggles' });
    [
      ['dropDocumentPage', HE.t('print.dropPage', "Ignore the document's own page setup (@page)")],
      ['backgrounds', HE.t('print.backgrounds', 'Print background colours and images')],
      ['keepTogether', HE.t('print.keepTogether', 'Keep tables, pictures and figures whole')],
      ['repeatHeaders', HE.t('print.repeatHeaders', 'Repeat table headers on every page')],
      ['fitImages', HE.t('print.fitImages', 'Shrink pictures wider than the page')],
      ['fullWidth', HE.t('print.fullWidth', 'Use the whole width (drop the page max-width)')]
    ].forEach(function (pair) {
      toggles.appendChild(checkbox(pair[1], o[pair[0]], function (on) { o[pair[0]] = on; refresh(); }));
    });

    form.appendChild(section(HE.t('print.sec.content', 'What goes on the paper'), [
      toggles,
      HE.el('p', {
        class: 'field__hint',
        text: HE.t('print.dropPageHint',
          "A document carrying its own @page is why the browser dialog greys out " +
          'paper and orientation. Ignoring it is what gives those options back.')
      })
    ]));

    /* ---- tools ---- */
    var breakBtn = HE.el('button', {
      class: 'btn btn--ghost', type: 'button',
      text: HE.t('print.insertBreak', 'Insert a page break at the cursor')
    });
    breakBtn.disabled = HE.readOnly;
    breakBtn.addEventListener('click', function () {
      if (insertPageBreak()) {
        HE.toast(HE.t('print.breakInserted', 'Page break inserted'), 'ok');
        refresh();
      } else {
        HE.toast(HE.t('print.breakNoCursor', 'Put the cursor where the new page should start first'), 'warn');
      }
    });
    form.appendChild(section(HE.t('print.sec.tools', 'Page breaks'), [
      HE.el('div', { class: 'field__row' }, [breakBtn])
    ]));

    /* ---- preview ---- */
    var stage = HE.el('div', { class: 'print-preview__stage' });
    var sheet = HE.el('div', { class: 'print-preview__sheet' });
    var previewFrame = HE.el('iframe', { class: 'print-preview__frame', title: 'Print preview' });
    var cuts = HE.el('div', { class: 'print-preview__cuts' });
    sheet.appendChild(previewFrame);
    stage.appendChild(sheet);
    // A scaled element keeps its unscaled layout box, so the sheet needs a
    // wrapper cut to the size it ends up painting at, or the panel scrolls
    // sideways over empty space. The cut lines hang off that wrapper instead
    // of the stage: inside it a hairline would be scaled down to nothing,
    // which is the one place it has to show.
    var fit = HE.el('div', { class: 'print-preview__fit' }, [stage, cuts]);
    var viewport = HE.el('div', { class: 'print-preview' }, [fit]);
    var summary = HE.el('p', { class: 'print-preview__summary', text: '' });
    side.appendChild(HE.el('h3', { class: 'props-section__title', text: HE.t('print.preview', 'Preview') }));
    side.appendChild(viewport);
    side.appendChild(summary);

    var timer = null;
    var generation = 0;

    refresh = function () {
      savePrefs(o);
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(draw, 180);
    };

    function draw() {
      var mine = ++generation;
      var size = paperSize(o);
      var box = usableBox(o);
      var pageW = size.w * MM_PX;
      var available = viewport.clientWidth - 24;
      var k = Math.min(1, available > 0 ? available / pageW : 0.4);

      stage.style.transform = 'scale(' + k + ')';
      stage.style.width = pageW + 'px';
      fit.style.width = Math.round(pageW * k) + 'px';
      sheet.style.width = pageW + 'px';
      sheet.style.paddingTop = o.margins[0] * MM_PX + 'px';
      sheet.style.paddingRight = o.margins[1] * MM_PX + 'px';
      sheet.style.paddingBottom = o.margins[2] * MM_PX + 'px';
      sheet.style.paddingLeft = o.margins[3] * MM_PX + 'px';
      previewFrame.style.width = box.w + 'px';
      previewFrame.style.height = Math.round(box.h) + 'px';

      renderInto(previewFrame, o, true, function (pdoc) {
        if (!pdoc || mine !== generation) { return; }
        applyFitWidth(pdoc, o, function (effective) {
          if (mine !== generation) { return; }
          if (o.fitWidth) { scaleInput.value = effective; }
          var height = Math.max(
            pdoc.body ? pdoc.body.scrollHeight : 0,
            pdoc.documentElement ? pdoc.documentElement.scrollHeight : 0);
          previewFrame.style.height = height + 'px';

          var breaks = pageCuts(pdoc, height, box.h);
          var offset = o.margins[0] * MM_PX;
          cuts.innerHTML = '';
          breaks.forEach(function (y) {
            var line = HE.el('div', { class: 'print-preview__cut' });
            line.style.top = Math.round((offset + y) * k) + 'px';
            cuts.appendChild(line);
          });
          fit.style.height = Math.round(sheet.offsetHeight * k) + 'px';
          summary.textContent = HE.t('print.pages', 'About {n} page(s) · {w} × {h} mm')
            .replace('{n}', breaks.length + 1)
            .replace('{w}', round(size.w))
            .replace('{h}', round(size.h));
        });
      });
    }

    var modal = HE.modal({
      title: HE.t('print.title', 'Print'),
      width: '980px',
      body: body,
      actions: [
        {
          label: HE.t('print.saveInDocument', 'Save in the document'),
          title: HE.t('print.saveInDocumentHint',
            'Writes this page setup into the file, so it also prints this way outside the editor'),
          disabled: HE.readOnly,
          onClick: function () {
            writeSetupToDocument(o);
            HE.toast(HE.t('print.saved', 'Page setup written into the document'), 'ok');
          }
        },
        {
          label: HE.t('print.print', 'Print…'),
          primary: true,
          onClick: function (close) { close(); print(o); }
        }
      ],
      onClose: function () { generation++; savePrefs(o); }
    });
    modal.card.classList.add('print-modal');

    draw();
    return modal;
  };

  HE.print.run = function (options) { print(sanitise(options || setupFromDocument() || loadPrefs())); };
  HE.print.insertPageBreak = insertPageBreak;

  var button = document.getElementById('btn-print');
  if (button) {
    button.addEventListener('click', function () { HE.print.open(); });
  }

  HE.registerContextProvider(function (el) {
    if (!el || el.nodeType !== 1 || HE.readOnly) { return []; }
    return [{
      label: HE.t('menu.pageBreak', 'Page break here'),
      group: 'insert',
      action: function () {
        if (!insertPageBreak()) {
          HE.toast(HE.t('print.breakNoCursor', 'Put the cursor where the new page should start first'), 'warn');
        }
      }
    }];
  });

  HE.modules.print = true;

  /*
   * New CSS class names introduced by this module (for editor.css):
   *
   *   print-frame
   *   print-modal, print, print__form, print__side, print__orient, print__sides,
   *   print__toggles, print-check
   *   print-preview, print-preview__fit, print-preview__stage, print-preview__sheet,
   *   print-preview__frame, print-preview__cuts, print-preview__cut,
   *   print-preview__summary
   */
})();
