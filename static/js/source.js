/*
 * source.js — split-view HTML source panel.
 *
 * Shows the pretty-printed source of the document being edited next to the
 * WYSIWYG canvas, with syntax highlighting (overlay technique: a transparent
 * textarea on top of a <pre> that carries the coloured tokens), line numbers,
 * a draggable splitter, and Apply to push edits back into the live iframe.
 */
(function (HE) {
  'use strict';

  /* --------------------------------------------------------- tag tables -- */

  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  /* Elements whose inner text must be preserved byte-for-byte. */
  var RAW_TAGS = { pre: 1, textarea: 1, script: 1, style: 1 };

  /* Elements kept in the flow of the surrounding text when re-indenting. */
  var INLINE_TAGS = {
    a: 1, abbr: 1, b: 1, bdi: 1, bdo: 1, br: 1, cite: 1, code: 1, data: 1,
    dfn: 1, em: 1, i: 1, img: 1, kbd: 1, mark: 1, q: 1, rp: 1, rt: 1,
    ruby: 1, s: 1, samp: 1, small: 1, span: 1, strong: 1, sub: 1, sup: 1,
    time: 1, u: 1, var: 1, wbr: 1, button: 1, input: 1, label: 1, output: 1
  };

  var HIGHLIGHT_LIMIT = 300 * 1024; /* above this, skip colouring */
  var SPLIT_KEY = 'html-editor.splitWidth';
  var SYNC_DEBOUNCE = 300;

  /* ---------------------------------------------------------- tokenizer -- */

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Splits an HTML string into flat tokens:
   *   {type:'text'|'comment'|'doctype'|'open'|'close'|'rawtext',
   *    raw, name?, selfClosing?}
   * The concatenation of every token's `raw` is always the exact input, so
   * anything built from these tokens can never lose content.
   */
  function tokenize(html) {
    var tokens = [];
    var lower = html.toLowerCase();
    var n = html.length;
    var i = 0;

    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt === -1) {
        tokens.push({ type: 'text', raw: html.slice(i) });
        break;
      }
      if (lt > i) { tokens.push({ type: 'text', raw: html.slice(i, lt) }); }

      if (html.substr(lt, 4) === '<!--') {
        var ce = html.indexOf('-->', lt + 4);
        ce = ce === -1 ? n : ce + 3;
        tokens.push({ type: 'comment', raw: html.slice(lt, ce) });
        i = ce;
        continue;
      }

      var next = html.charAt(lt + 1);
      if (next === '!' || next === '?') {
        var de = html.indexOf('>', lt);
        de = de === -1 ? n : de + 1;
        tokens.push({ type: 'doctype', raw: html.slice(lt, de) });
        i = de;
        continue;
      }

      var isClose = next === '/';
      var nameMatch = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(html.slice(lt + (isClose ? 2 : 1)));
      if (!nameMatch) {
        /* A lone "<" that opens no tag: plain text. */
        tokens.push({ type: 'text', raw: '<' });
        i = lt + 1;
        continue;
      }

      /* Find the closing ">" of the tag, skipping quoted attribute values. */
      var j = lt + 1;
      var quote = '';
      while (j < n) {
        var c = html.charAt(j);
        if (quote) {
          if (c === quote) { quote = ''; }
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          break;
        }
        j++;
      }
      var te = j < n ? j + 1 : n;
      var raw = html.slice(lt, te);
      var name = nameMatch[0].toLowerCase();
      var selfClosing = /\/\s*>$/.test(raw);
      tokens.push({
        type: isClose ? 'close' : 'open',
        raw: raw, name: name, selfClosing: selfClosing
      });
      i = te;

      /* Raw-text elements: swallow everything until the matching close tag. */
      if (!isClose && !selfClosing && RAW_TAGS[name]) {
        var closeIdx = lower.indexOf('</' + name, i);
        if (closeIdx === -1) {
          if (i < n) { tokens.push({ type: 'rawtext', raw: html.slice(i) }); }
          i = n;
        } else {
          if (closeIdx > i) { tokens.push({ type: 'rawtext', raw: html.slice(i, closeIdx) }); }
          i = closeIdx;
        }
      }
    }
    return tokens;
  }

  /* ------------------------------------------------------ pretty printer -- */

  function pad(depth) {
    var out = '';
    for (var k = 0; k < depth; k++) { out += '  '; }
    return out;
  }

  function formatTokens(tokens) {
    var lines = [];
    var depth = 0;
    var buf = ''; /* pending inline flow (text + inline tags) */

    function flush() {
      var trimmed = buf.replace(/^\s+/, '').replace(/\s+$/, '');
      buf = '';
      if (trimmed) { lines.push(pad(depth) + trimmed); }
    }

    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];

      if (tok.type === 'text') {
        buf += tok.raw.replace(/\s+/g, ' ');

      } else if (tok.type === 'comment' || tok.type === 'doctype') {
        flush();
        lines.push(pad(depth) + tok.raw);

      } else if (tok.type === 'rawtext') {
        /* Orphan raw text (normally consumed with its opening tag below). */
        flush();
        lines.push(tok.raw);

      } else if (tok.type === 'open') {
        if (RAW_TAGS[tok.name] && !tok.selfClosing) {
          /* Emit open tag + verbatim content + close tag with zero added
           * whitespace, so <pre>/<textarea>/<script>/<style> never change. */
          flush();
          var assembled = tok.raw;
          var k = i + 1;
          if (k < tokens.length && tokens[k].type === 'rawtext') {
            assembled += tokens[k].raw;
            k++;
          }
          if (k < tokens.length && tokens[k].type === 'close' && tokens[k].name === tok.name) {
            assembled += tokens[k].raw;
            k++;
          }
          lines.push(pad(depth) + assembled);
          i = k - 1;
        } else if (INLINE_TAGS[tok.name]) {
          buf += tok.raw;
        } else {
          flush();
          lines.push(pad(depth) + tok.raw);
          if (!VOID_TAGS[tok.name] && !tok.selfClosing) { depth++; }
        }

      } else if (tok.type === 'close') {
        if (INLINE_TAGS[tok.name]) {
          buf += tok.raw;
        } else {
          flush();
          if (depth > 0) { depth--; }
          lines.push(pad(depth) + tok.raw);
        }
      }
    }
    flush();
    return lines.join('\n') + '\n';
  }

  /**
   * Re-indents HTML with two spaces, one block element per line. Raw-text
   * elements keep their exact content. Falls back to the input untouched if
   * anything goes wrong: it must never lose content.
   */
  HE.formatHTML = function (html) {
    if (typeof html !== 'string' || html === '') { return html || ''; }
    try {
      return formatTokens(tokenize(html));
    } catch (err) {
      console.error('[html-editor] formatHTML', err);
      return html;
    }
  };

  /* -------------------------------------------------- syntax highlighting -- */

  function highlightTag(raw) {
    var m = /^<\/?[a-zA-Z][a-zA-Z0-9:_-]*/.exec(raw);
    if (!m) { return '<span class="tok-text">' + escapeHtml(raw) + '</span>'; }
    var out = '<span class="tok-tag">' + escapeHtml(m[0]) + '</span>';
    var rest = raw.slice(m[0].length);
    var re = /\s+|"[^"]*"?|'[^']*'?|\/?>|=|[^\s=>"']+/g;
    var expectValue = false;
    var piece;
    while ((piece = re.exec(rest)) !== null) {
      var s = piece[0];
      if (/^\s/.test(s)) {
        out += escapeHtml(s);
      } else if (s === '=') {
        out += '=';
        expectValue = true;
      } else if (s === '>' || s === '/>') {
        out += '<span class="tok-tag">' + escapeHtml(s) + '</span>';
      } else if (s.charAt(0) === '"' || s.charAt(0) === "'") {
        out += '<span class="tok-value">' + escapeHtml(s) + '</span>';
        expectValue = false;
      } else if (expectValue) {
        out += '<span class="tok-value">' + escapeHtml(s) + '</span>';
        expectValue = false;
      } else {
        out += '<span class="tok-attr">' + escapeHtml(s) + '</span>';
      }
    }
    return out;
  }

  function highlightSource(text) {
    var tokens = tokenize(text);
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      switch (tok.type) {
        case 'comment':
          out.push('<span class="tok-comment">' + escapeHtml(tok.raw) + '</span>');
          break;
        case 'doctype':
          out.push('<span class="tok-doctype">' + escapeHtml(tok.raw) + '</span>');
          break;
        case 'open':
        case 'close':
          out.push(highlightTag(tok.raw));
          break;
        default:
          out.push('<span class="tok-text">' + escapeHtml(tok.raw) + '</span>');
      }
    }
    return out.join('');
  }

  /* -------------------------------------------------------------- panel -- */

  var panel = document.getElementById('source');
  var splitter = document.getElementById('splitter');
  var input = document.getElementById('source-input');
  var highlight = document.getElementById('source-highlight');
  var gutter = document.getElementById('source-gutter');
  var statusEl = document.getElementById('source-status');
  var btnSource = document.getElementById('btn-source');
  var btnApply = document.getElementById('btn-apply');
  var btnFormat = document.getElementById('btn-format');
  var btnClose = document.getElementById('btn-source-close');

  var lastApplied = ''; /* text known to match the live document */
  var srcDirty = false; /* textarea diverges from the document */
  var gutterLines = 0;
  var syncTimer = null;

  function setDirty(flag) {
    srcDirty = flag;
    if (!statusEl) { return; }
    if (flag) {
      statusEl.textContent = HE.t('source.modified', 'Source modified — Apply (Ctrl+Enter) to update the page');
      statusEl.classList.add('is-modified');
    } else {
      statusEl.textContent = HE.t('source.hint');
      statusEl.classList.remove('is-modified');
    }
  }

  function syncScroll() {
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  }

  function renderGutter() {
    var count = input.value.split('\n').length;
    if (count === gutterLines) { return; }
    gutterLines = count;
    var nums = new Array(count);
    for (var k = 0; k < count; k++) { nums[k] = k + 1; }
    gutter.textContent = nums.join('\n') + '\n';
  }

  function renderHighlight() {
    var text = input.value;
    if (text.length > HIGHLIGHT_LIMIT) {
      /* Too big to colour on every keystroke: plain mirror keeps metrics. */
      highlight.textContent = text + '\n';
    } else {
      highlight.innerHTML = highlightSource(text) + '\n';
    }
    renderGutter();
    syncScroll();
  }

  /* ------------------------------------------------------- split sizing -- */

  function clampWidth(w) {
    var stageEl = document.getElementById('stage');
    var max = stageEl ? Math.max(280, stageEl.getBoundingClientRect().width - 320) : 900;
    return Math.min(Math.max(240, w), max);
  }

  function applyWidth(w) {
    w = clampWidth(w);
    panel.style.width = w + 'px';
    panel.style.flex = '0 0 ' + w + 'px';
    return w;
  }

  function applyStoredWidth() {
    var saved = parseInt(localStorage.getItem(SPLIT_KEY), 10);
    if (saved > 0) { applyWidth(saved); }
  }

  function initSplitter() {
    splitter.addEventListener('mousedown', function (event) {
      event.preventDefault();
      var frame = HE.frame();
      /* The iframe swallows mousemove; turn it off while dragging. */
      if (frame) { frame.style.pointerEvents = 'none'; }
      var prevCursor = document.body.style.cursor;
      var prevSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      var width = panel.getBoundingClientRect().width;

      function onMove(ev) {
        var stageEl = document.getElementById('stage');
        var right = stageEl ? stageEl.getBoundingClientRect().right : window.innerWidth;
        width = applyWidth(right - ev.clientX - splitter.offsetWidth / 2);
        HE.refreshOverlays();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (frame) { frame.style.pointerEvents = ''; }
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        localStorage.setItem(SPLIT_KEY, String(Math.round(width)));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* ---------------------------------------------------------- open/close -- */

  function isOpen() {
    return !!panel && !panel.hidden;
  }

  function open() {
    if (isOpen()) { return; }
    panel.hidden = false;
    splitter.hidden = false;
    applyStoredWidth();
    if (btnSource) { btnSource.setAttribute('aria-pressed', 'true'); }
    sync();
    renderHighlight();
    HE.refreshOverlays();
  }

  function close() {
    if (!isOpen()) { return; }
    panel.hidden = true;
    splitter.hidden = true;
    if (btnSource) { btnSource.setAttribute('aria-pressed', 'false'); }
    HE.refreshOverlays();
  }

  function toggle() {
    if (isOpen()) { close(); } else { open(); }
  }

  /* ---------------------------------------------------------------- sync -- */

  /** Regenerates the textarea from the live document (unless the user is in
   *  the middle of editing it), preserving caret and scroll position. */
  function sync() {
    if (!isOpen()) { return; }
    if (document.activeElement === input && srcDirty) { return; }
    var text;
    try {
      text = HE.formatHTML(HE.serialize());
    } catch (err) {
      text = HE.serialize();
    }
    lastApplied = text;
    if (text === input.value) {
      setDirty(false);
      return;
    }
    var selStart = input.selectionStart;
    var selEnd = input.selectionEnd;
    var st = input.scrollTop;
    var sl = input.scrollLeft;
    input.value = text;
    if (document.activeElement === input) {
      try {
        input.setSelectionRange(Math.min(selStart, text.length), Math.min(selEnd, text.length));
      } catch (err) { /* ignore */ }
    }
    input.scrollTop = st;
    input.scrollLeft = sl;
    setDirty(false);
    renderHighlight();
  }

  function scheduleSync() {
    if (!isOpen()) { return; }
    if (syncTimer) { clearTimeout(syncTimer); }
    syncTimer = setTimeout(function () {
      syncTimer = null;
      sync();
    }, SYNC_DEBOUNCE);
  }

  /* --------------------------------------------------------------- apply -- */

  /** Parses the textarea and pushes it into the live iframe document. */
  function apply() {
    if (HE.readOnly) {
      HE.toast(HE.t('save.readonly'), 'warn');
      return false;
    }
    var text = input.value;
    if (text === lastApplied) { return true; } /* nothing new to push */

    var parsed = null;
    try {
      parsed = new DOMParser().parseFromString(text, 'text/html');
    } catch (err) {
      parsed = null;
    }
    if (!parsed || !parsed.documentElement) {
      HE.toast(HE.t('source.invalid'), 'error');
      return false;
    }

    var d = HE.doc();
    if (!d || !d.documentElement) { return false; }

    try {
      HE.clearSelection();
      var live = d.documentElement;
      var src = parsed.documentElement;
      /* Mirror the <html> attributes: drop the missing, copy the rest. */
      for (var i = live.attributes.length - 1; i >= 0; i--) {
        var attr = live.attributes[i];
        if (!src.hasAttribute(attr.name)) { live.removeAttribute(attr.name); }
      }
      for (i = 0; i < src.attributes.length; i++) {
        live.setAttribute(src.attributes[i].name, src.attributes[i].value);
      }
      live.innerHTML = src.innerHTML;
      HE.prepareFrame();
    } catch (err) {
      console.error('[html-editor] source apply', err);
      HE.toast(HE.t('source.invalid'), 'error');
      return false;
    }

    lastApplied = text;
    setDirty(false);
    HE.markDirty();
    HE.pushHistory();
    HE.refreshOverlays();
    HE.emit('mutated');
    HE.toast(HE.t('source.applied'), 'ok');
    return true;
  }

  /* ------------------------------------------------------ reveal element -- */

  /**
   * Opens the panel and selects the opening tag of `el` in the source text.
   * The element is briefly tagged with a unique data-he-find attribute; the
   * serialized text is searched for it, the marker is stripped from the
   * displayed text, and the recorded offset selects the clean opening tag.
   */
  function revealElement(el) {
    if (!el || el.nodeType !== 1) { return; }
    open();
    var d = HE.doc();
    if (!d) { return; }

    var marker = 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
    var marked = '';
    el.setAttribute('data-he-find', marker);
    try {
      marked = HE.formatHTML(HE.serialize());
    } finally {
      el.removeAttribute('data-he-find');
    }

    var attrText = 'data-he-find="' + marker + '"';
    var idx = marked.indexOf(attrText);
    if (idx === -1) { sync(); return; }

    var tagStart = marked.lastIndexOf('<', idx);
    var before = marked.slice(0, idx);
    var after = marked.slice(idx + attrText.length);
    if (before.charAt(before.length - 1) === ' ') { before = before.slice(0, -1); }
    var clean = before + after;
    var tagEnd = clean.indexOf('>', tagStart);
    tagEnd = tagEnd === -1 ? tagStart + 1 : tagEnd + 1;

    input.value = clean;
    lastApplied = clean;
    setDirty(false);
    renderHighlight();

    input.focus();
    try {
      input.setSelectionRange(tagStart, tagEnd);
    } catch (err) { /* ignore */ }

    var line = clean.slice(0, tagStart).split('\n').length - 1;
    var lineHeight = parseFloat(window.getComputedStyle(input).lineHeight) || 18;
    input.scrollTop = Math.max(0, line * lineHeight - input.clientHeight / 3);
    input.scrollLeft = 0;
    syncScroll();
  }

  /* -------------------------------------------------------------- wiring -- */

  function onInput() {
    setDirty(input.value !== lastApplied);
    renderHighlight();
  }

  function init() {
    if (!panel || !input) { return; }

    input.addEventListener('input', onInput);
    input.addEventListener('scroll', syncScroll);

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') {
        event.preventDefault();
        var start = input.selectionStart;
        var end = input.selectionEnd;
        if (typeof input.setRangeText === 'function') {
          input.setRangeText('  ', start, end, 'end');
        } else {
          input.value = input.value.slice(0, start) + '  ' + input.value.slice(end);
          input.selectionStart = input.selectionEnd = start + 2;
        }
        onInput();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        apply();
      }
    });

    /* Blur with unsaved source edits pushes them into the document. */
    input.addEventListener('blur', function () {
      if (srcDirty && !HE.readOnly) { apply(); }
    });

    if (btnApply) { btnApply.addEventListener('click', function () { apply(); }); }
    if (btnClose) { btnClose.addEventListener('click', close); }
    if (btnSource) { btnSource.addEventListener('click', toggle); }
    if (btnFormat) {
      btnFormat.addEventListener('click', function () {
        var st = input.scrollTop;
        var formatted = HE.formatHTML(input.value);
        if (formatted !== input.value) {
          input.value = formatted;
          onInput();
        }
        input.scrollTop = st;
        syncScroll();
      });
    }

    if (HE.readOnly) {
      if (btnApply) { btnApply.disabled = true; }
      input.readOnly = true;
    }

    initSplitter();

    /* Refresh when the WYSIWYG side changes (debounced; sync() itself
     * refuses to clobber unsaved edits while the textarea is focused). */
    HE.on('mutated', scheduleSync);
    HE.on('typed', scheduleSync);
    HE.on('history', scheduleSync);
    HE.on('lang', function () { setDirty(srcDirty); });
  }

  init();

  HE.source = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    sync: sync,
    apply: apply,
    revealElement: revealElement
  };
  HE.modules.source = HE.source;

  /*
   * New CSS class names introduced by this module (for editor.css):
   *   .tok-tag      — tag delimiters and names inside #source-highlight
   *   .tok-attr     — attribute names
   *   .tok-value    — attribute values (including quotes)
   *   .tok-comment  — <!-- comments -->
   *   .tok-doctype  — doctype / processing instructions
   *   .tok-text     — plain text nodes and raw script/style content
   *   .is-modified  — set on #source-status while the textarea diverges
   *                   from the live document
   */
})(window.HE);
