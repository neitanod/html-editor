/*
 * assets.js — turning remote resources into files that live next to the
 * document.
 *
 * Content copied from a web page arrives with its images still pointing at the
 * original site: the folder looks complete but breaks the day that site moves
 * them. Downloading happens in the Go process (a cross-origin image fetched
 * from the page is opaque to JavaScript), and this module decides what to
 * download, marks the nodes so the rewrite finds exactly them, and swaps the
 * addresses for relative names.
 */
(function (HE) {
  'use strict';

  var MARK = 'data-he-localize';
  var CONCURRENCY = 3;
  var sessionChoice = null; // 'plain' | 'download', remembered per session

  /* --------------------------------------------------------- discovery --- */

  function isRemote(value) {
    return /^(https?:)?\/\//i.test((value || '').trim());
  }

  function absolute(value) {
    var url = (value || '').trim();
    return url.indexOf('//') === 0 ? 'https:' + url : url;
  }

  /** Every remote address inside a srcset, with its descriptor kept apart. */
  function srcsetEntries(value) {
    return (value || '').split(',').map(function (part) {
      var trimmed = part.trim();
      if (!trimmed) { return null; }
      var space = trimmed.search(/\s/);
      return {
        url: space === -1 ? trimmed : trimmed.slice(0, space),
        descriptor: space === -1 ? '' : trimmed.slice(space).trim()
      };
    }).filter(Boolean);
  }

  var CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

  function styleURLs(value) {
    var found = [];
    var match;
    CSS_URL.lastIndex = 0;
    while ((match = CSS_URL.exec(value || '')) !== null) {
      if (isRemote(match[2])) { found.push(match[2]); }
    }
    return found;
  }

  /**
   * Collects every remote resource reachable from `root` (a document, an
   * element or a parsed fragment). Returns the distinct addresses.
   */
  function collect(root) {
    var urls = [];
    function push(value) {
      if (!isRemote(value)) { return; }
      var url = absolute(value);
      if (urls.indexOf(url) === -1) { urls.push(url); }
    }

    root.querySelectorAll('img[src], source[src], video[poster], audio[src], embed[src]')
      .forEach(function (node) {
        push(node.getAttribute('src'));
        push(node.getAttribute('poster'));
      });
    root.querySelectorAll('[srcset]').forEach(function (node) {
      srcsetEntries(node.getAttribute('srcset')).forEach(function (entry) { push(entry.url); });
    });
    root.querySelectorAll('[style]').forEach(function (node) {
      styleURLs(node.getAttribute('style')).forEach(push);
    });
    return urls;
  }

  /** Tags the elements that carry remote resources so the rewrite finds them. */
  function mark(root) {
    var counter = 0;
    root.querySelectorAll('img, source, video, audio, embed, [srcset], [style]')
      .forEach(function (node) {
        var remote =
          isRemote(node.getAttribute('src')) ||
          isRemote(node.getAttribute('poster')) ||
          srcsetEntries(node.getAttribute('srcset')).some(function (entry) {
            return isRemote(entry.url);
          }) ||
          styleURLs(node.getAttribute('style')).length > 0;
        if (remote) { node.setAttribute(MARK, String(counter++)); }
      });
    return counter;
  }

  /* --------------------------------------------------------- downloading -- */

  function download(url) {
    return fetch('/api/fetch-asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok) { throw new Error(payload.error || res.statusText); }
        return payload;
      });
    });
  }

  /**
   * Downloads every address once and resolves to a map address → local name.
   * Failures are reported but never abort the run: a page with one dead image
   * should still get the other twenty localised.
   */
  function downloadAll(urls, onProgress) {
    var localNames = {};
    var failures = [];
    var index = 0;
    var done = 0;

    function next() {
      if (index >= urls.length) { return Promise.resolve(); }
      var url = urls[index++];
      return download(url).then(function (asset) {
        localNames[url] = asset.name;
      }).catch(function (err) {
        failures.push({ url: url, error: err.message });
      }).then(function () {
        done += 1;
        if (onProgress) { onProgress(done, urls.length); }
        return next();
      });
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, urls.length); i++) { workers.push(next()); }
    return Promise.all(workers).then(function () {
      return { names: localNames, failures: failures };
    });
  }

  /* ---------------------------------------------------------- rewriting --- */

  function rewriteAttribute(node, attr, names) {
    var value = node.getAttribute(attr);
    if (!isRemote(value)) { return; }
    var local = names[absolute(value)];
    if (local) { node.setAttribute(attr, local); }
  }

  function rewriteSrcset(node, names) {
    var value = node.getAttribute('srcset');
    if (!value) { return; }
    var rewritten = srcsetEntries(value).map(function (entry) {
      var local = isRemote(entry.url) ? names[absolute(entry.url)] : null;
      var url = local || entry.url;
      return entry.descriptor ? url + ' ' + entry.descriptor : url;
    }).join(', ');
    node.setAttribute('srcset', rewritten);
  }

  function rewriteStyle(node, names) {
    var value = node.getAttribute('style');
    if (!value || value.indexOf('url(') === -1) { return; }
    var rewritten = value.replace(CSS_URL, function (whole, quote, url) {
      if (!isRemote(url)) { return whole; }
      var local = names[absolute(url)];
      return local ? 'url(' + quote + local + quote + ')' : whole;
    });
    node.setAttribute('style', rewritten);
  }

  /** Applies the downloaded names to the marked nodes and clears the marks. */
  function rewriteMarked(root, names) {
    root.querySelectorAll('[' + MARK + ']').forEach(function (node) {
      rewriteAttribute(node, 'src', names);
      rewriteAttribute(node, 'poster', names);
      rewriteSrcset(node, names);
      rewriteStyle(node, names);
      node.removeAttribute(MARK);
    });
  }

  function clearMarks(root) {
    root.querySelectorAll('[' + MARK + ']').forEach(function (node) {
      node.removeAttribute(MARK);
    });
  }

  /* -------------------------------------------------------------- report -- */

  function report(count, failures) {
    if (!count) {
      HE.toast(HE.t('assets.noneFound', 'No external resources to download'), 'info');
      return;
    }
    if (failures.length) {
      HE.toast(HE.t('assets.someFailed', 'Downloaded ') + (count - failures.length) + '/' + count +
        HE.t('assets.someFailedTail', ' resources; the rest kept their original address'), 'warn');
      failures.forEach(function (failure) {
        console.warn('[html-editor] could not download ' + failure.url + ': ' + failure.error);
      });
    } else {
      HE.toast(HE.t('assets.stored', 'Stored ') + count +
        HE.t('assets.storedTail', ' resources next to the document'), 'ok');
    }
  }

  function progressToast(done, total) {
    var host = document.getElementById('assets-progress');
    if (!host) {
      host = HE.el('div', { class: 'toast toast--info is-in', id: 'assets-progress' });
      document.getElementById('toasts').appendChild(host);
    }
    host.textContent = HE.t('assets.downloading', 'Downloading resources… ') + done + '/' + total;
    if (done >= total) {
      setTimeout(function () { host.remove(); }, 400);
    }
  }

  /* ---------------------------------------------------------- public API -- */

  /**
   * Downloads the resources referenced by the marked nodes under `root` (which
   * lives in the edited document) and relinks them relatively.
   */
  function localizeMarked(root) {
    var urls = collect(root);
    if (!urls.length) { clearMarks(root); return Promise.resolve(0); }

    return downloadAll(urls, progressToast).then(function (result) {
      HE.edit(function () { rewriteMarked(root, result.names); });
      report(urls.length, result.failures);
      clearMarks(root);
      return urls.length - result.failures.length;
    }).catch(function (err) {
      clearMarks(root);
      HE.toast(HE.t('assets.failed', 'Could not download the resources: ') + err.message, 'error');
      return 0;
    });
  }

  /** Menu command: localise everything already in the document. */
  function localizeDocument() {
    var d = HE.doc();
    if (!d) { return Promise.resolve(0); }
    var count = mark(d.documentElement);
    if (!count) {
      HE.toast(HE.t('assets.noneFound', 'No external resources to download'), 'info');
      return Promise.resolve(0);
    }
    return localizeMarked(d.documentElement);
  }

  /** True when the clipboard HTML references anything hosted elsewhere. */
  function hasRemoteResources(html) {
    return collect(new DOMParser().parseFromString(html, 'text/html')).length > 0;
  }

  /**
   * Called from the paste handler once it has taken over the event. The caret
   * position is captured up front: opening the dialog moves the focus to the
   * host page, and the insertion has to land where the user was typing.
   */
  function handlePastedHTML(html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var caret = captureCaret();

    if (sessionChoice === 'plain') { insert(html, caret); return; }
    if (sessionChoice === 'download') { insertAndLocalize(parsed, caret); return; }

    ask(collect(parsed).length, function (choice, remember) {
      if (remember) { sessionChoice = choice; }
      if (choice === 'download') { insertAndLocalize(parsed, caret); }
      else { insert(html, caret); }
    });
  }

  function captureCaret() {
    var win = HE.win();
    var selection = win && win.getSelection();
    if (!selection || !selection.rangeCount) { return null; }
    return selection.getRangeAt(0).cloneRange();
  }

  function restoreCaret(range) {
    var win = HE.win();
    if (!win) { return; }
    win.focus();
    if (!range) { return; }
    var selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insert(html, caret) {
    restoreCaret(caret);
    HE.edit(function () { HE.exec('insertHTML', html); });
  }

  function insertAndLocalize(parsed, caret) {
    mark(parsed.body);
    var marked = parsed.body.innerHTML;
    restoreCaret(caret);
    HE.edit(function () { HE.exec('insertHTML', marked); });
    localizeMarked(HE.doc().documentElement);
  }

  function ask(count, callback) {
    var remember = HE.el('input', { type: 'checkbox' });
    var body = HE.el('div', { class: 'form' }, [
      HE.el('p', { class: 'assets-ask__text',
        text: HE.t('assets.askIntro', 'What you are pasting links ') + count +
          HE.t('assets.askIntroTail', ' resources hosted on other sites.') }),
      HE.el('p', { class: 'assets-ask__hint',
        text: HE.t('assets.askHint', 'Downloading them keeps the folder self-contained: the files land next to the document and are linked relatively.') }),
      HE.el('label', { class: 'assets-ask__remember' }, [
        remember, HE.el('span', { text: HE.t('assets.remember', 'Remember my choice for this session') })
      ])
    ]);

    HE.modal({
      title: HE.t('assets.askTitle', 'Paste with external resources'),
      body: body,
      width: '520px',
      actions: [
        {
          label: HE.t('assets.pastePlain', 'Paste as is'),
          onClick: function (close) { close(); callback('plain', remember.checked); }
        },
        {
          label: HE.t('assets.pasteDownload', 'Download and link them'), primary: true,
          onClick: function (close) { close(); callback('download', remember.checked); }
        }
      ]
    });
  }

  HE.assets = {
    collect: collect,
    localizeDocument: localizeDocument,
    localizeMarked: localizeMarked,
    hasRemoteResources: hasRemoteResources,
    handlePastedHTML: handlePastedHTML,
    forgetChoice: function () { sessionChoice = null; }
  };

  /* Offer it on the background context menu, next to the document commands. */
  HE.registerContextProvider(function (element) {
    var d = HE.doc();
    var isBackground = !element || element === d.body || element === d.documentElement;
    if (!isBackground) { return []; }
    return [{
      label: HE.t('assets.localizeDocument', 'Download external resources…'),
      group: 'document',
      action: localizeDocument
    }];
  });

  /*
   * New CSS class names introduced by this module (for editor.css):
   *   .assets-ask__text     — the sentence with the resource count
   *   .assets-ask__hint     — the explanation under it
   *   .assets-ask__remember — the "remember my choice" checkbox row
   */
})(window.HE);
