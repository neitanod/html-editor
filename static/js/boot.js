/*
 * boot.js — wires the iframe, the global shortcuts and the lifecycle stream.
 * Loaded last, once every module had a chance to register itself.
 */
(function (HE) {
  'use strict';

  var frame = HE.frame();
  var mutationObserver = null;
  var typingTimer = null;

  /* ------------------------------------------------------- document load -- */

  function frameURL() {
    return '/doc/' + encodeURIComponent(HE.fileName) + '?editor=1&t=' + Date.now();
  }

  function loadDocument() {
    frame.src = frameURL();
  }

  frame.addEventListener('load', function () {
    var d = HE.doc();
    if (!d || !d.body) { return; }

    HE.ready = true;
    HE.prepareFrame();
    attachDocumentListeners(d);
    observeMutations(d);

    HE.history.stack = [];
    HE.history.index = -1;
    HE.pushHistory();

    HE.markClean();
    HE.emit('document-loaded', d);
    updateStatus();
  });

  /* -------------------------------------------------- listeners in frame -- */

  function attachDocumentListeners(d) {
    var win = HE.win();

    d.addEventListener('mousedown', function (event) {
      if (event.button !== 0) { return; }
      HE.closeContextMenu && HE.closeContextMenu();
      var target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
      HE.select(target);
    }, true);

    d.addEventListener('mouseover', function (event) {
      var target = event.target;
      if (!target || target.nodeType !== 1) { return; }
      if (HE.hovered && HE.hovered !== target) { HE.hovered.classList.remove('he-hover'); }
      if (target !== d.body && target !== d.documentElement) {
        target.classList.add('he-hover');
        HE.hovered = target;
      }
    });

    d.addEventListener('mouseout', function () {
      if (HE.hovered) { HE.hovered.classList.remove('he-hover'); HE.hovered = null; }
    });

    // Following a link inside the editor would unload the document, so links
    // are inert while editing; the link overlay offers an explicit Open button.
    d.addEventListener('click', function (event) {
      var anchor = event.target.closest && event.target.closest('a[href]');
      if (anchor) { event.preventDefault(); }
    });

    d.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      var target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
      HE.select(target);
      var frameRect = frame.getBoundingClientRect();
      HE.openContextMenu(target, {
        x: event.clientX + frameRect.left,
        y: event.clientY + frameRect.top
      });
    });

    d.addEventListener('input', function () {
      HE.markDirty();
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { HE.pushHistory(); }, 550);
      HE.emit('typed');
    });

    d.addEventListener('keydown', function (event) { handleShortcut(event, true); });
    d.addEventListener('keyup', function (event) {
      if (event.key === ' ' || event.key === 'Enter') { linkifyBeforeCaret(); }
    });
    d.addEventListener('paste', handlePaste, true);
    d.addEventListener('drop', handleDrop, true);
    d.addEventListener('dragover', function (event) {
      if (event.dataTransfer && event.dataTransfer.types &&
          Array.prototype.indexOf.call(event.dataTransfer.types, 'Files') !== -1) {
        event.preventDefault();
      }
    }, true);

    d.addEventListener('selectionchange', updateStatus);
    win.addEventListener('scroll', function () { HE.refreshOverlays(); }, true);
    win.addEventListener('resize', function () { HE.refreshOverlays(); });
  }

  function observeMutations(d) {
    if (mutationObserver) { mutationObserver.disconnect(); }
    mutationObserver = new MutationObserver(function (records) {
      var meaningful = records.some(function (record) {
        if (record.type === 'attributes') {
          return ['class', 'contenteditable', 'spellcheck', 'data-he-id'].indexOf(record.attributeName) === -1;
        }
        return !Array.prototype.some.call(record.addedNodes, function (node) {
          return node.nodeType === 1 && node.hasAttribute('data-html-editor-ui');
        });
      });
      if (!meaningful) { return; }
      HE.markDirty();
      HE.emit('mutated');
    });
    mutationObserver.observe(d.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
  }

  /* ---------------------------------------------------------- clipboard -- */

  function handlePaste(event) {
    var data = event.clipboardData;
    if (!data) { return; }

    var files = [];
    Array.prototype.forEach.call(data.items || [], function (item) {
      if (item.kind === 'file' && item.type.indexOf('image/') === 0) {
        var file = item.getAsFile();
        if (file) { files.push(file); }
      }
    });

    if (files.length) {
      event.preventDefault();
      insertImageFiles(files);
      return;
    }

    // Plain-text URLs become links, which is what people expect when pasting
    // an address over a selection or on an empty line.
    var text = (data.getData('text/plain') || '').trim();
    var html = data.getData('text/html');
    if (!html && /^https?:\/\/\S+$/i.test(text)) {
      event.preventDefault();
      HE.edit(function () {
        var selection = HE.win().getSelection();
        var label = selection && !selection.isCollapsed ? selection.toString() : text;
        HE.exec('insertHTML', '<a href="' + escapeAttr(text) + '">' + escapeText(label) + '</a>');
      });
    }
  }

  // Typing an address and pressing space (or Enter) turns it into a link, the
  // same way pasting one does. Only the word just finished is considered.
  var URL_AT_END = /(^|[\s(])((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)])[\s]$/i;

  function linkifyBeforeCaret() {
    var d = HE.doc();
    var win = HE.win();
    var selection = win.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) { return; }

    var node = selection.anchorNode;
    if (!node || node.nodeType !== 3) { return; }
    if (node.parentElement && node.parentElement.closest('a')) { return; }

    var text = node.textContent.slice(0, selection.anchorOffset);
    var match = URL_AT_END.exec(text);
    if (!match) { return; }

    var url = match[2];
    var start = text.length - url.length - 1;
    if (start < 0) { return; }

    HE.edit(function () {
      var range = d.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + url.length);
      var anchor = d.createElement('a');
      anchor.setAttribute('href', /^www\./i.test(url) ? 'https://' + url : url);
      anchor.textContent = url;
      range.deleteContents();
      range.insertNode(anchor);

      var after = d.createRange();
      after.setStartAfter(anchor);
      after.collapse(true);
      selection.removeAllRanges();
      selection.addRange(after);
    });
  }

  function handleDrop(event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) { return; }
    var images = Array.prototype.filter.call(files, function (file) {
      return file.type.indexOf('image/') === 0;
    });
    if (!images.length) { return; }
    event.preventDefault();
    var range = caretRangeFromPoint(event.clientX, event.clientY);
    insertImageFiles(images, range);
  }

  function caretRangeFromPoint(x, y) {
    var d = HE.doc();
    if (d.caretRangeFromPoint) { return d.caretRangeFromPoint(x, y); }
    if (d.caretPositionFromPoint) {
      var pos = d.caretPositionFromPoint(x, y);
      if (!pos) { return null; }
      var range = d.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function insertImageFiles(files, range) {
    HE.toast(HE.t('image.uploading'), 'info');
    files.reduce(function (chain, file) {
      return chain.then(function () {
        return HE.storeAsset(file).then(function (asset) {
          HE.edit(function () {
            var img = HE.doc().createElement('img');
            img.setAttribute('src', asset.name);
            img.setAttribute('alt', '');
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            insertNode(img, range);
            HE.select(img);
          });
          HE.toast(HE.t('image.stored') + asset.name, 'ok');
        });
      });
    }, Promise.resolve()).catch(function (err) {
      HE.toast(HE.t('image.failed') + err.message, 'error');
    });
  }

  function insertNode(node, range) {
    var win = HE.win();
    var selection = win.getSelection();
    var target = range;
    if (!target && selection && selection.rangeCount) { target = selection.getRangeAt(0); }
    if (target) {
      target.deleteContents();
      target.insertNode(node);
      target.setStartAfter(node);
      target.collapse(true);
      selection.removeAllRanges();
      selection.addRange(target);
    } else {
      HE.body().appendChild(node);
    }
  }

  function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  HE.escapeAttr = escapeAttr;
  HE.escapeText = escapeText;

  /* ---------------------------------------------------------- shortcuts -- */

  function handleShortcut(event, fromFrame) {
    var mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      if (event.key === 'Escape') {
        HE.closePopover();
        HE.closeContextMenu && HE.closeContextMenu();
      }
      return;
    }
    var key = event.key.toLowerCase();

    if (key === 's') { event.preventDefault(); HE.save(); return; }
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); HE.undo(); return; }
    if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); HE.redo(); return; }
    if (key === 'k') { event.preventDefault(); HE.openLinkDialog && HE.openLinkDialog(); return; }
    if (key === 'e' && event.shiftKey) { event.preventDefault(); HE.source.toggle(); return; }
    if (key === 'enter' && !fromFrame) { return; }
    if (key === 'v' && event.shiftKey && fromFrame) {
      event.preventDefault();
      pastePlainText();
    }
  }

  function pastePlainText() {
    if (!navigator.clipboard || !navigator.clipboard.readText) { return; }
    navigator.clipboard.readText().then(function (text) {
      HE.edit(function () { HE.exec('insertText', text); });
    });
  }

  document.addEventListener('keydown', function (event) { handleShortcut(event, false); });

  /* --------------------------------------------------------- status bar -- */

  function updateStatus() {
    var crumbs = document.getElementById('crumbs');
    var selectionLabel = document.getElementById('status-selection');
    if (!crumbs) { return; }

    crumbs.innerHTML = '';
    var chain = HE.selected ? HE.pathOf(HE.selected) : [];
    chain.forEach(function (node, index) {
      var button = HE.el('button', {
        class: 'crumb' + (index === chain.length - 1 ? ' is-current' : ''),
        type: 'button',
        text: HE.describe(node)
      });
      button.addEventListener('click', function () { HE.select(node); });
      crumbs.appendChild(button);
      if (index < chain.length - 1) {
        crumbs.appendChild(HE.el('span', { class: 'crumb__sep', text: '›' }));
      }
    });

    if (selectionLabel) {
      selectionLabel.textContent = HE.selected ? HE.describe(HE.selected) : HE.t('status.nothing');
    }
  }

  HE.on('select', updateStatus);
  HE.on('mutated', function () { HE.refreshOverlays(); });

  HE.on('dirty', function (dirty) {
    var docStatus = document.getElementById('status-doc');
    if (docStatus) {
      docStatus.textContent = dirty ? HE.t('status.unsaved') : HE.t('status.saved');
      docStatus.classList.toggle('is-dirty', !!dirty);
    }
    document.title = (dirty ? '• ' : '') + HE.fileName + ' — html-editor';
  });

  /* --------------------------------------------------- exec helper (DOM) -- */

  /** execCommand wrapper that always runs with the iframe focused. */
  HE.exec = function (command, value) {
    var d = HE.doc();
    if (!d) { return false; }
    HE.win().focus();
    try {
      return d.execCommand(command, false, value === undefined ? null : value);
    } catch (err) {
      console.error('[html-editor] execCommand ' + command, err);
      return false;
    }
  };

  /* ---------------------------------------------------------- lifecycle -- */

  var eventSource = null;
  var reconnectTimer = null;
  var reconnectAttempts = 0;

  function connectStream() {
    if (eventSource) { eventSource.close(); }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    eventSource = new EventSource('/api/stream');
    eventSource.addEventListener('hello', function () { reconnectAttempts = 0; });
    eventSource.onerror = function () {
      if (reconnectTimer) { return; }
      eventSource.close();
      eventSource = null;
      reconnectAttempts += 1;
      var delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000);
      reconnectTimer = setTimeout(connectStream, delay);
    };
  }

  window.addEventListener('load', function () {
    navigator.sendBeacon && navigator.sendBeacon('/api/open');
    connectStream();
    loadDocument();
  });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted || (eventSource && eventSource.readyState === 2)) { connectStream(); }
  });

  window.addEventListener('beforeunload', function (event) {
    if (HE.dirty) {
      event.preventDefault();
      event.returnValue = HE.t('confirm.discard');
      return event.returnValue;
    }
  });

  window.addEventListener('unload', function () {
    if (eventSource) { eventSource.close(); }
    navigator.sendBeacon && navigator.sendBeacon('/api/close');
  });

  window.addEventListener('resize', function () { HE.refreshOverlays(); });

  HE.reload = loadDocument;
})(window.HE);
