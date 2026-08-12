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

  /* HE.serialize marks elements whose computed white-space preserves spaces
   * (pre / pre-wrap / break-spaces) with this attribute; the printer treats
   * them like <pre> and strips the attribute so it never reaches the file. */
  var RAW_ATTR_RE = /\sdata-he-raw\b/i;

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
      var token = {
        type: isClose ? 'close' : 'open',
        raw: raw, name: name, selfClosing: selfClosing
      };
      tokens.push(token);
      i = te;

      /* Raw-content elements: swallow everything until the matching close
       * tag. Both the intrinsic raw tags and any element marked with
       * data-he-raw (white-space-preserving CSS) qualify. */
      if (!isClose && !selfClosing && !VOID_TAGS[name] &&
          (RAW_TAGS[name] || RAW_ATTR_RE.test(raw))) {
        token.rawContent = true;
        var closeIdx;
        if (RAW_TAGS[name]) {
          /* These cannot nest themselves: first close tag wins. */
          closeIdx = lower.indexOf('</' + name, i);
        } else {
          /* Marked elements can contain same-named children: balance them. */
          closeIdx = findBalancedClose(lower, name, i);
        }
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

  function isTagDelim(ch) {
    return ch === '' || ch === '>' || ch === '/' || /\s/.test(ch);
  }

  /** Index (in `lower`) of the close tag matching an already-consumed open
   *  tag of `name`, counting same-named nested opens. -1 when unclosed. */
  function findBalancedClose(lower, name, from) {
    var openNeedle = '<' + name;
    var closeNeedle = '</' + name;
    var n = lower.length;
    var depth = 1;
    var i = from;
    while (i < n) {
      var c = lower.indexOf(closeNeedle, i);
      if (c === -1) { return -1; }
      var o = lower.indexOf(openNeedle, i);
      while (o !== -1 && o < c && !isTagDelim(lower.charAt(o + openNeedle.length))) {
        o = lower.indexOf(openNeedle, o + 1);
      }
      if (o !== -1 && o < c) {
        depth++;
        i = o + openNeedle.length;
      } else if (isTagDelim(lower.charAt(c + closeNeedle.length))) {
        depth--;
        if (depth === 0) { return c; }
        i = c + closeNeedle.length;
      } else {
        i = c + 1; /* something like </divx — keep scanning */
      }
    }
    return -1;
  }

  /** Removes the editor-injected data-he-raw attribute from an opening tag.
   *  Quote-aware, so attribute values that merely mention it are untouched. */
  function stripRawAttr(tag) {
    if (!RAW_ATTR_RE.test(tag)) { return tag; }
    var out = '';
    var i = 0;
    var n = tag.length;
    var quote = '';
    while (i < n) {
      var ch = tag.charAt(i);
      if (quote) {
        out += ch;
        if (ch === quote) { quote = ''; }
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) {
        var m = /^\s+data-he-raw(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/i.exec(tag.slice(i));
        if (m) {
          i += m[0].length;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  /* ------------------------------------------------------ pretty printer -- */

  function pad(depth) {
    var out = '';
    for (var k = 0; k < depth; k++) { out += '  '; }
    return out;
  }

  /* Structural elements that always get the multi-line treatment, so the
   * document skeleton is one landmark per line even when nearly empty. */
  var FORCE_BLOCK = { html: 1, head: 1, body: 1 };

  /** Allows at most one consecutive blank line (used on comment bodies;
   *  raw-text element content is never passed through here). */
  function collapseBlankLines(text) {
    var parts = text.split('\n');
    var out = [];
    var blanks = 0;
    for (var i = 0; i < parts.length; i++) {
      if (/^\s*$/.test(parts[i])) {
        blanks++;
        if (blanks <= 1) { out.push(parts[i]); }
      } else {
        blanks = 0;
        out.push(parts[i]);
      }
    }
    return out.join('\n');
  }

  /**
   * Builds a light tree from the flat tokens. Raw-text elements are folded
   * into a single verbatim 'raw' node (open tag + exact content + close tag).
   * Unmatched close tags become 'closetag' leaves so nothing is dropped.
   */
  function buildTree(tokens) {
    var root = { type: 'el', tag: '#root', openRaw: '', closeRaw: '', children: [] };
    var stack = [root];

    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      var parent = stack[stack.length - 1];

      if (tok.type === 'text' || tok.type === 'comment' || tok.type === 'doctype') {
        parent.children.push({ type: tok.type, raw: tok.raw });

      } else if (tok.type === 'rawtext') {
        /* Orphan raw text (normally consumed with its opening tag below). */
        parent.children.push({ type: 'raw', raw: tok.raw });

      } else if (tok.type === 'open') {
        if (tok.rawContent) {
          /* Zero added whitespace around the verbatim content, so raw
           * elements (intrinsic or data-he-raw marked) never change. */
          var assembled = stripRawAttr(tok.raw);
          var k = i + 1;
          if (k < tokens.length && tokens[k].type === 'rawtext') {
            assembled += tokens[k].raw;
            k++;
          }
          if (k < tokens.length && tokens[k].type === 'close' && tokens[k].name === tok.name) {
            assembled += tokens[k].raw;
            k++;
          }
          parent.children.push({ type: 'raw', raw: assembled });
          i = k - 1;
        } else {
          /* Void/self-closing elements can carry the marker too (inherited
           * white-space): strip it here as well so it never reaches disk. */
          var node = { type: 'el', tag: tok.name, openRaw: stripRawAttr(tok.raw), closeRaw: '', children: [] };
          parent.children.push(node);
          if (!VOID_TAGS[tok.name] && !tok.selfClosing) { stack.push(node); }
        }

      } else if (tok.type === 'close') {
        var at = -1;
        for (var s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tag === tok.name) { at = s; break; }
        }
        if (at === -1) {
          parent.children.push({ type: 'closetag', raw: tok.raw });
        } else {
          /* Implicitly closes anything left open above the match. */
          stack[at].closeRaw = tok.raw;
          stack.length = at;
        }
      }
    }
    return root;
  }

  /** True when the node renders as part of the surrounding text flow:
   *  a text node, or an inline element whose whole subtree is inline. */
  function isInlineOnly(node) {
    if (node.type === 'text') { return true; }
    if (node.type !== 'el' || !INLINE_TAGS[node.tag]) { return false; }
    for (var i = 0; i < node.children.length; i++) {
      if (!isInlineOnly(node.children[i])) { return false; }
    }
    return true;
  }

  function hasOnlyInlineContent(node) {
    for (var i = 0; i < node.children.length; i++) {
      if (!isInlineOnly(node.children[i])) { return false; }
    }
    return true;
  }

  /** Renders a run of inline-only nodes as a single string. */
  function renderInline(nodes) {
    var s = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'text') { s += n.raw.replace(/\s+/g, ' '); }
      else { s += n.openRaw + renderInline(n.children) + n.closeRaw; }
    }
    return s;
  }

  function trimEdges(s) {
    return s.replace(/^\s+/, '').replace(/\s+$/, '');
  }

  function formatTokens(tokens) {
    var lines = [];
    var root = buildTree(tokens);

    function printNodes(nodes, depth) {
      var flow = []; /* pending run of text + inline elements */

      function flushFlow() {
        if (!flow.length) { return; }
        var s = trimEdges(renderInline(flow));
        flow = [];
        if (s) { lines.push(pad(depth) + s); }
      }

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (isInlineOnly(node)) {
          flow.push(node);
          continue;
        }
        flushFlow();
        printNode(node, depth);
      }
      flushFlow();
    }

    function printNode(node, depth) {
      if (node.type === 'text') {
        var t = trimEdges(node.raw.replace(/\s+/g, ' '));
        if (t) { lines.push(pad(depth) + t); }
      } else if (node.type === 'comment') {
        lines.push(pad(depth) + collapseBlankLines(node.raw));
      } else if (node.type === 'doctype' || node.type === 'closetag' || node.type === 'raw') {
        lines.push(pad(depth) + node.raw);
      } else if (!FORCE_BLOCK[node.tag] && hasOnlyInlineContent(node)) {
        /* Text-only (or inline-only) element: keep it on a single line so
         * no whitespace is injected into its rendered content. */
        lines.push(pad(depth) + node.openRaw + trimEdges(renderInline(node.children)) + node.closeRaw);
      } else {
        lines.push(pad(depth) + node.openRaw);
        printNodes(node.children, depth + 1);
        if (node.closeRaw) { lines.push(pad(depth) + node.closeRaw); }
      }
    }

    printNodes(root.children, 0);
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

  /** True while the textarea content diverges from the live document.
   *  Safe to call at any time, even before the panel was ever opened. */
  function hasPendingChanges() {
    return !!input && input.value !== lastApplied;
  }

  /**
   * Opens the panel and selects the opening tag of `el` in the source text.
   * When the textarea holds unapplied edits, asks first (Apply / Discard /
   * Cancel) instead of silently overwriting them.
   */
  function revealElement(el) {
    if (!el || el.nodeType !== 1) { return; }
    if (hasPendingChanges()) {
      HE.modal({
        title: HE.t('source.unappliedTitle', 'Unapplied source changes'),
        body: HE.el('p', { text: HE.t('source.unappliedBody', 'The source panel has changes you did not apply. Apply them before jumping to the element?') }),
        actions: [
          {
            label: HE.t('source.apply'),
            primary: true,
            onClick: function (closeModal) {
              closeModal();
              if (apply()) { doReveal(el); }
            }
          },
          {
            label: HE.t('source.discard', 'Discard'),
            onClick: function (closeModal) {
              closeModal();
              setDirty(false);
              doReveal(el); /* overwrites the textarea from the document */
            }
          },
          {
            label: HE.t('common.cancel'),
            onClick: function (closeModal) { closeModal(); }
          }
        ]
      });
      return;
    }
    doReveal(el);
  }

  /**
   * The element is briefly tagged with a unique data-he-find attribute; the
   * serialized text is searched for it, the marker is stripped from the
   * displayed text, and the recorded offset selects the clean opening tag.
   */
  function doReveal(el) {
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
    hasPendingChanges: hasPendingChanges,
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
