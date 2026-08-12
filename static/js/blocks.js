/*
 * blocks.js — note, quotation and source-code blocks.
 *
 * Public API:
 *   HE.blocks.apply(kind)      — wrap the selection ('note' | 'citation' | 'code')
 *   HE.blocks.remove(el, kind) — unwrap one of those blocks again
 *
 * Each kind carries its own look in a <style> tag embedded in the document,
 * identified by a fixed id (html-editor-notes-styles, and its two siblings).
 * The tag is written once, the first time that kind of block is used, and is
 * never touched again: whatever the user edits in there is theirs to keep.
 */
(function (HE) {
  'use strict';

  if (!HE) { return; }

  var BLOCK_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION',
    'ARTICLE', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'FIGURE',
    'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FORM', 'DL', 'DT', 'DD',
    'TD', 'TH'];

  /* ------------------------------------------------------------- styles -- */

  var NOTE_CSS = [
    '.html-editor-note {',
    '  margin: 1.6em 0;',
    '  padding: 1em 1.25em;',
    '  border-left: 4px solid #e0a63c;',
    '  border-radius: 6px;',
    '  background: #fff8e8;',
    '  color: #4a3c1d;',
    '  line-height: 1.6;',
    '}',
    '.html-editor-note > :first-child { margin-top: 0; }',
    '.html-editor-note > :last-child { margin-bottom: 0; }'
  ].join('\n');

  var CITATION_CSS = [
    '.html-editor-citation {',
    '  position: relative;',
    '  margin: 1.8em 0;',
    '  padding: .2em 0 .2em 2.6em;',
    '  color: #3d4450;',
    '}',
    '.html-editor-citation::before {',
    '  content: "\\201C";',
    '  position: absolute;',
    '  left: 0;',
    '  top: -.12em;',
    '  font: 3.4em/1 Georgia, "Times New Roman", serif;',
    '  color: #d3d8e0;',
    '}',
    '.html-editor-citation blockquote {',
    '  margin: 0;',
    '  font: italic 1.12em/1.65 Georgia, "Times New Roman", serif;',
    '}',
    '.html-editor-citation blockquote > :first-child { margin-top: 0; }',
    '.html-editor-citation blockquote > :last-child { margin-bottom: 0; }',
    '.html-editor-citation figcaption {',
    '  margin-top: .7em;',
    '  font-size: .88em;',
    '  font-style: normal;',
    '  letter-spacing: .02em;',
    '  color: #7b8493;',
    '}',
    '.html-editor-citation figcaption::before { content: "\\2014\\00a0"; }'
  ].join('\n');

  var CODE_CSS = [
    '.html-editor-sourcecode {',
    '  margin: 1.6em 0;',
    '  padding: 1em 1.15em;',
    '  overflow-x: auto;',
    '  border-radius: 8px;',
    '  background: #1d2229;',
    '  color: #e7edf4;',
    '  font-size: .92em;',
    '  line-height: 1.55;',
    '  tab-size: 2;',
    '}',
    '.html-editor-sourcecode code {',
    '  font-family: ui-monospace, "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", monospace;',
    '  padding: 0;',
    '  background: none;',
    '  color: inherit;',
    '}'
  ].join('\n');

  /* -------------------------------------------------------------- kinds -- */

  var KINDS = {
    note: {
      klass: 'html-editor-note',
      styleId: 'html-editor-notes-styles',
      css: NOTE_CSS,
      removeLabel: 'blocks.removeNote',
      build: buildNote,
      unpack: unpackNote
    },
    citation: {
      klass: 'html-editor-citation',
      styleId: 'html-editor-citation-styles',
      css: CITATION_CSS,
      removeLabel: 'blocks.removeCitation',
      build: buildCitation,
      unpack: unpackCitation
    },
    code: {
      klass: 'html-editor-sourcecode',
      styleId: 'html-editor-sourcecode-styles',
      css: CODE_CSS,
      removeLabel: 'blocks.removeCode',
      build: buildCode,
      unpack: unpackCode
    }
  };

  /**
   * Writes the <style> for this kind if the document does not carry it yet.
   * The id is the whole contract: once it is there the tag is left alone, so
   * the styles the user tweaked survive every later block of the same kind.
   */
  function ensureStyles(d, spec) {
    if (d.getElementById(spec.styleId)) { return false; }
    var style = d.createElement('style');
    style.id = spec.styleId;
    style.textContent = '\n/* ' + HE.t('blocks.cssComment') + ' */\n' + spec.css + '\n';
    (d.head || d.documentElement).appendChild(style);
    return true;
  }

  /* ------------------------------------------------------------ builders -- */

  function buildNote(d, fragment) {
    var note = d.createElement('aside');
    note.className = KINDS.note.klass;
    note.appendChild(paragraphed(d, fragment));
    return { element: note, caret: null };
  }

  function buildCitation(d, fragment) {
    var figure = d.createElement('figure');
    figure.className = KINDS.citation.klass;
    var quote = d.createElement('blockquote');
    quote.appendChild(paragraphed(d, fragment));
    var caption = d.createElement('figcaption');
    caption.textContent = HE.t('blocks.citationSource');
    figure.appendChild(quote);
    figure.appendChild(caption);
    // The caption starts selected so typing the author replaces the
    // placeholder, and deleting it leaves a citation with no attribution.
    return { element: figure, caret: caption };
  }

  function buildCode(d, fragment) {
    var pre = d.createElement('pre');
    pre.className = KINDS.code.klass;
    var code = d.createElement('code');
    code.textContent = plainText(d, fragment);
    pre.appendChild(code);
    return { element: pre, caret: null };
  }

  /* ------------------------------------------------------------ unpacking */

  function unpackNote(d, note) {
    return Array.prototype.slice.call(note.childNodes);
  }

  function unpackCitation(d, figure) {
    var out = [];
    var quote = figure.querySelector('blockquote');
    Array.prototype.slice.call((quote || figure).childNodes).forEach(function (node) {
      if (node.nodeName === 'FIGCAPTION') { return; }
      out.push(node);
    });
    var caption = figure.querySelector('figcaption');
    if (caption && caption.textContent.trim()) {
      var p = d.createElement('p');
      p.textContent = caption.textContent.trim();
      out.push(p);
    }
    return out;
  }

  function unpackCode(d, pre) {
    return pre.textContent.replace(/\n+$/, '').split('\n').map(function (line) {
      var p = d.createElement('p');
      if (line.trim()) { p.textContent = line; }
      else { p.appendChild(d.createElement('br')); }
      return p;
    });
  }

  /* ------------------------------------------------------------ helpers -- */

  function isBlock(node) {
    return node && node.nodeType === 1 && BLOCK_TAGS.indexOf(node.tagName) !== -1;
  }

  /** Nearest block-level ancestor (inclusive), stopping short of the body. */
  function closestBlock(node, d) {
    while (node && node.nodeType !== 1) { node = node.parentNode; }
    while (node && node.nodeType === 1) {
      if (node === d.body || node === d.documentElement) { return null; }
      if (isBlock(node)) { return node; }
      node = node.parentElement;
    }
    return null;
  }

  /** Lifts a node until it is a direct child of `parent`. */
  function liftTo(node, parent) {
    while (node && node.parentElement && node.parentElement !== parent) {
      node = node.parentElement;
    }
    return node;
  }

  /**
   * The run of sibling nodes the selection covers, as [first, last]. Partially
   * selected blocks count whole: marking half a paragraph as a note and getting
   * back half a paragraph inside a box is never what anybody means.
   */
  function selectedRun(d, range) {
    var start = closestBlock(range.startContainer, d);
    var end = range.collapsed ? start : closestBlock(range.endContainer, d);
    if (!start || !end) { return null; }
    if (start === end || start.contains(end)) { return cellSafe(d, start, start); }
    if (end.contains(start)) { return cellSafe(d, end, end); }

    var common = start.parentElement;
    while (common && !common.contains(end)) { common = common.parentElement; }
    if (!common) { return cellSafe(d, start, start); }
    return cellSafe(d, liftTo(start, common), liftTo(end, common));
  }

  var TABLE_PARTS = { TD: 1, TH: 1, TR: 1, TBODY: 1, THEAD: 1, TFOOT: 1,
    CAPTION: 1, COLGROUP: 1, COL: 1 };
  var LIST_ITEMS = { LI: 1, DT: 1, DD: 1 };

  /**
   * List items and table cells only make sense inside their parent, so the box
   * never takes their place: a single one is boxed from the inside, and a run
   * of them takes the whole list or table along.
   */
  function cellSafe(d, first, last) {
    if (TABLE_PARTS[first.tagName] || TABLE_PARTS[last.tagName]) {
      var isCell = first.tagName === 'TD' || first.tagName === 'TH';
      if (first === last && isCell && first.firstChild) {
        return [first.firstChild, first.lastChild];
      }
      var table = first.closest('table') || last.closest('table');
      return table && table !== d.body ? [table, table] : [first, last];
    }
    if (LIST_ITEMS[first.tagName] || LIST_ITEMS[last.tagName]) {
      if (first === last && first.firstChild) {
        return [first.firstChild, first.lastChild];
      }
      var list = first.parentElement;
      return list && list !== d.body ? [list, list] : [first, last];
    }
    return [first, last];
  }

  /** Moves the run into a fragment, leaving a marker where it was. */
  function takeRun(d, first, last) {
    var fragment = d.createDocumentFragment();
    var anchor = d.createComment('html-editor');
    first.parentNode.insertBefore(anchor, first);
    var node = first;
    while (node) {
      var next = node.nextSibling;
      fragment.appendChild(node);
      if (node === last) { break; }
      node = next;
    }
    return { fragment: fragment, anchor: anchor };
  }

  /** Wraps loose inline content in a paragraph; blocks are left as they are. */
  function paragraphed(d, fragment) {
    var hasBlock = false;
    Array.prototype.forEach.call(fragment.childNodes, function (node) {
      if (isBlock(node)) { hasBlock = true; }
    });
    if (hasBlock) { return fragment; }
    var p = d.createElement('p');
    p.appendChild(fragment);
    return p;
  }

  /** Text of a fragment with the line breaks its markup implies. */
  function plainText(d, fragment) {
    var holder = d.createElement('div');
    holder.appendChild(fragment);
    Array.prototype.forEach.call(holder.querySelectorAll('br'), function (br) {
      br.parentNode.replaceChild(d.createTextNode('\n'), br);
    });
    var lines = [];
    Array.prototype.forEach.call(holder.childNodes, function (node) {
      lines.push(node.textContent);
    });
    // The no-break spaces a rich-text paragraph is full of would be code the
    // compiler rejects, so inside a code block they go back to plain spaces.
    return lines.join('\n').replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  function placeCaret(win, d, element) {
    var selection = win.getSelection();
    if (!selection) { return; }
    var range = d.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /* -------------------------------------------------------------- public -- */

  /** The block of `kind` the element sits in, if any. */
  function enclosing(element, kind) {
    if (!element || !element.closest) { return null; }
    return element.closest('.' + KINDS[kind].klass);
  }

  function elementAt(node) {
    while (node && node.nodeType !== 1) { node = node.parentNode; }
    return node;
  }

  function apply(kind) {
    var spec = KINDS[kind];
    if (!spec) { return; }
    var d = HE.doc();
    var win = HE.win();
    if (!d || !win) { return; }

    win.focus();
    var selection = win.getSelection();
    if (!selection || !selection.rangeCount) { return; }
    var range = selection.getRangeAt(0);

    // Applying the same kind again from inside one of these blocks takes it
    // off, which is the only sensible reading of "make this a note" when it
    // already is one.
    var existing = enclosing(elementAt(range.startContainer), kind);
    if (existing) { remove(existing, kind); return; }

    HE.edit(function () {
      var announce = ensureStyles(d, spec);
      var run = selectedRun(d, range);
      var taken;
      if (run) {
        taken = takeRun(d, run[0], run[1]);
      } else {
        // Loose text with no block around it: the range itself is the content.
        var anchor = d.createComment('html-editor');
        var fragment = range.extractContents();
        range.insertNode(anchor);
        taken = { fragment: fragment, anchor: anchor };
      }

      var built = spec.build(d, taken.fragment);
      taken.anchor.parentNode.replaceChild(built.element, taken.anchor);
      HE.select(built.element);
      if (built.caret) { placeCaret(win, d, built.caret); }
      if (announce) { HE.toast(HE.t('blocks.stylesAdded') + '#' + spec.styleId, 'ok'); }
    });
  }

  function remove(element, kind) {
    var spec = KINDS[kind];
    if (!spec || !element) { return; }
    var d = HE.doc();
    HE.edit(function () {
      var parent = element.parentNode;
      spec.unpack(d, element).forEach(function (node) { parent.insertBefore(node, element); });
      element.remove();
      HE.select(parent === d.body ? null : parent);
    });
  }

  /* -------------------------------------------------------------- wiring -- */

  [['btn-note', 'note'], ['btn-citation', 'citation'], ['btn-code', 'code']].forEach(function (pair) {
    var button = document.getElementById(pair[0]);
    if (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        apply(pair[1]);
      });
    }
  });

  HE.registerContextProvider(function (element) {
    var entries = [];
    Object.keys(KINDS).forEach(function (kind) {
      var host = enclosing(element, kind);
      if (!host) { return; }
      entries.push({
        label: HE.t(KINDS[kind].removeLabel),
        group: 'element',
        action: function () { remove(host, kind); }
      });
    });
    return entries;
  });

  HE.blocks = { apply: apply, remove: remove, kinds: KINDS };
  HE.modules.blocks = true;
})(window.HE);
