/*
 * overlays.js — the floating controls drawn on top of the document:
 *   · the link editor popover (readable text + href + follow button)
 *   · image selection handles with aspect-ratio preserving resize
 *   · a small image action bar (alignment, size presets, alt text)
 *
 * Everything lives in the host page (inside #layer), never inside the edited
 * document, so nothing of this can end up in the saved file.
 */
(function (HE) {
  'use strict';

  var layer = document.getElementById('layer');

  /* =============================================================== links == */

  var linkTarget = null;

  function isAnchor(node) {
    return node && node.nodeType === 1 && node.tagName === 'A';
  }

  function anchorAt(node) {
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A') { return node; }
      node = node.parentElement;
    }
    return null;
  }

  /** Opens the link popover for an existing anchor. */
  function openLinkPopover(anchor) {
    linkTarget = anchor;

    var textInput = HE.el('input', { class: 'ctl', type: 'text', value: anchor.textContent || '' });
    var hrefInput = HE.el('input', { class: 'ctl', type: 'text', value: anchor.getAttribute('href') || '' });
    var newTab = HE.el('input', { type: 'checkbox' });
    newTab.checked = anchor.getAttribute('target') === '_blank';

    var body = HE.el('div', { class: 'linkbox' }, [
      HE.el('div', { class: 'linkbox__row' }, [
        HE.el('label', { class: 'linkbox__label', text: HE.t('link.text') }), textInput
      ]),
      HE.el('div', { class: 'linkbox__row' }, [
        HE.el('label', { class: 'linkbox__label', text: HE.t('link.href') }), hrefInput
      ]),
      HE.el('label', { class: 'linkbox__check' }, [newTab, HE.el('span', { text: HE.t('link.newTab') })])
    ]);

    var actions = HE.el('div', { class: 'linkbox__actions' });

    var openBtn = HE.el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, [
      iconSVG('M14 4h6v6M20 4l-9 9', true), HE.el('span', { text: HE.t('link.open') })
    ]);
    openBtn.addEventListener('click', function () {
      var href = hrefInput.value.trim();
      if (!href) { return; }
      window.open(resolveHref(href), '_blank', 'noopener');
    });

    var removeBtn = HE.el('button', {
      class: 'btn btn--ghost btn--sm btn--danger', type: 'button', text: HE.t('link.remove')
    });
    removeBtn.addEventListener('click', function () {
      HE.edit(function () {
        var parent = anchor.parentNode;
        while (anchor.firstChild) { parent.insertBefore(anchor.firstChild, anchor); }
        parent.removeChild(anchor);
      });
      HE.closePopover();
    });

    var applyBtn = HE.el('button', {
      class: 'btn btn--primary btn--sm', type: 'button', text: HE.t('link.apply')
    });
    function apply() {
      HE.edit(function () {
        anchor.setAttribute('href', hrefInput.value.trim());
        if (textInput.value !== anchor.textContent) { anchor.textContent = textInput.value; }
        if (newTab.checked) {
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noopener');
        } else {
          anchor.removeAttribute('target');
          if (anchor.getAttribute('rel') === 'noopener') { anchor.removeAttribute('rel'); }
        }
      });
      HE.closePopover();
    }
    applyBtn.addEventListener('click', apply);

    [textInput, hrefInput].forEach(function (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); apply(); }
      });
    });

    actions.appendChild(openBtn);
    actions.appendChild(HE.el('span', { class: 'linkbox__spacer' }));
    actions.appendChild(removeBtn);
    actions.appendChild(applyBtn);
    body.appendChild(actions);

    HE.popover({
      className: 'popover popover--link',
      body: body,
      rect: function () { return HE.rectInHost(anchor); },
      onClose: function () { linkTarget = null; }
    });
  }

  /** Absolute URL for the Open button, relative to the document folder. */
  function resolveHref(href) {
    try {
      return new URL(href, HE.win().location.href).href;
    } catch (err) {
      return href;
    }
  }

  /** Ctrl+K / toolbar: create a link on the current selection, or edit one. */
  HE.openLinkDialog = function () {
    var win = HE.win();
    var selection = win && win.getSelection();
    var existing = selection && selection.anchorNode ? anchorAt(
      selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement
    ) : null;

    if (existing) { openLinkPopover(existing); return; }
    if (!selection || selection.isCollapsed) {
      promptForNewLink('');
      return;
    }
    promptForNewLink(selection.toString());
  };

  function promptForNewLink(initialText) {
    var textInput = HE.el('input', { class: 'ctl', type: 'text', value: initialText });
    var hrefInput = HE.el('input', { class: 'ctl', type: 'text', value: 'https://', placeholder: 'https://' });
    var body = HE.el('div', { class: 'form' }, [
      HE.el('div', { class: 'form__row' }, [
        HE.el('label', { class: 'form__label', text: HE.t('link.text') }), textInput
      ]),
      HE.el('div', { class: 'form__row' }, [
        HE.el('label', { class: 'form__label', text: HE.t('link.href') }), hrefInput
      ])
    ]);

    var dialog = HE.modal({
      title: HE.t('link.title'),
      body: body,
      actions: [
        { label: HE.t('common.cancel'), onClick: function (close) { close(); } },
        {
          label: HE.t('common.ok'), primary: true, onClick: function (close) {
            var href = hrefInput.value.trim();
            if (!href) { close(); return; }
            var label = textInput.value.trim() || href;
            HE.edit(function () {
              HE.exec('insertHTML', '<a href="' + HE.escapeAttr(href) + '">' + HE.escapeText(label) + '</a>');
            });
            close();
          }
        }
      ]
    });
    hrefInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        dialog.card.querySelector('.btn--primary').click();
      }
    });
  }

  /* =============================================================== images == */

  var handleBox = null;
  var imageBar = null;
  var imageTarget = null;

  function buildHandleBox() {
    if (handleBox) { return handleBox; }
    handleBox = HE.el('div', { class: 'handles', hidden: 'hidden' });
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
      var handle = HE.el('span', { class: 'handles__grip handles__grip--' + dir, 'data-dir': dir });
      handle.addEventListener('mousedown', startResize);
      handleBox.appendChild(handle);
    });
    handleBox.appendChild(HE.el('span', { class: 'handles__badge' }));
    layer.appendChild(handleBox);
    return handleBox;
  }

  function buildImageBar() {
    if (imageBar) { return imageBar; }
    imageBar = HE.el('div', { class: 'floatbar', hidden: 'hidden' });
    layer.appendChild(imageBar);
    return imageBar;
  }

  function renderImageBar(img) {
    var bar = buildImageBar();
    bar.innerHTML = '';

    function tool(title, label, onClick) {
      var btn = HE.el('button', { class: 'btn btn--tool btn--sm', type: 'button', title: title, html: label });
      btn.addEventListener('click', function (event) { event.preventDefault(); onClick(); });
      bar.appendChild(btn);
      return btn;
    }

    // One click is one undo step: every declaration of an alignment is applied
    // inside a single edit.
    function setStyles(declarations) {
      HE.edit(function () {
        Object.keys(declarations).forEach(function (prop) {
          img.style[prop] = declarations[prop];
        });
      });
      positionImageChrome();
    }

    tool(HE.t('image.alignLeft', 'Align left'), '&#8676;', function () {
      setStyles({ float: 'left', margin: '0 1rem 1rem 0', display: '' });
    });
    tool(HE.t('image.alignCenter', 'Centre'), '&#8596;', function () {
      setStyles({ float: '', display: 'block', margin: '1rem auto' });
    });
    tool(HE.t('image.alignRight', 'Align right'), '&#8677;', function () {
      setStyles({ float: 'right', margin: '0 0 1rem 1rem', display: '' });
    });
    bar.appendChild(HE.el('span', { class: 'floatbar__sep' }));

    [25, 50, 75, 100].forEach(function (percent) {
      tool(percent + '%', percent + '%', function () {
        HE.edit(function () {
          img.style.width = percent + '%';
          img.style.height = 'auto';
        });
        positionImageChrome();
      });
    });
    tool(HE.t('image.reset', 'Original size'), '1:1', function () {
      HE.edit(function () {
        img.style.width = '';
        img.style.height = '';
        img.removeAttribute('width');
        img.removeAttribute('height');
      });
      positionImageChrome();
    });

    bar.appendChild(HE.el('span', { class: 'floatbar__sep' }));

    // A quarter turn is the whole job often enough to deserve its own button;
    // anything else (framing, mirroring, straightening) opens the dialog.
    tool(HE.t('crop.rotateLeft', 'Rotate left'), '&#8634;', function () {
      HE.imageedit.rotateLeft(img);
    });
    tool(HE.t('crop.rotateRight', 'Rotate right'), '&#8635;', function () {
      HE.imageedit.rotateRight(img);
    });
    tool(HE.t('crop.title', 'Crop and rotate'), '&#9974;', function () {
      HE.imageedit.open(img);
    });
    tool(HE.t('mark.title', 'Annotate'), '&#9998;', function () {
      HE.annotate.open(img);
    });
    bar.appendChild(HE.el('span', { class: 'floatbar__sep' }));

    tool(HE.t('image.alt', 'Alternative text'), 'ALT', function () { promptAlt(img); });
    tool(HE.t('menu.properties'), '&#9881;', function () {
      if (HE.props) { HE.props.openElement(img); }
    });
  }

  function promptAlt(img) {
    var input = HE.el('input', { class: 'ctl', type: 'text', value: img.getAttribute('alt') || '' });
    var titleInput = HE.el('input', { class: 'ctl', type: 'text', value: img.getAttribute('title') || '' });
    HE.modal({
      title: HE.t('image.alt', 'Alternative text'),
      body: HE.el('div', { class: 'form' }, [
        HE.el('div', { class: 'form__row' }, [
          HE.el('label', { class: 'form__label', text: 'alt' }), input
        ]),
        HE.el('div', { class: 'form__row' }, [
          HE.el('label', { class: 'form__label', text: 'title' }), titleInput
        ])
      ]),
      actions: [
        { label: HE.t('common.cancel'), onClick: function (close) { close(); } },
        {
          label: HE.t('common.ok'), primary: true, onClick: function (close) {
            HE.edit(function () {
              img.setAttribute('alt', input.value);
              if (titleInput.value) { img.setAttribute('title', titleInput.value); }
              else { img.removeAttribute('title'); }
            });
            close();
          }
        }
      ]
    });
  }

  /* ------------------------------------------------------------- resizing -- */

  var drag = null;

  function startResize(event) {
    if (!imageTarget) { return; }
    event.preventDefault();
    event.stopPropagation();

    var rect = HE.rectInHost(imageTarget);
    drag = {
      dir: event.currentTarget.dataset.dir,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      ratio: rect.width / (rect.height || 1)
    };
    document.body.classList.add('is-resizing');
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', endResize);
  }

  function onResize(event) {
    if (!drag || !imageTarget) { return; }
    var dx = event.clientX - drag.startX;
    var dy = event.clientY - drag.startY;
    var width = drag.startWidth;
    var height = drag.startHeight;

    if (drag.dir.indexOf('e') !== -1) { width = drag.startWidth + dx; }
    if (drag.dir.indexOf('w') !== -1) { width = drag.startWidth - dx; }
    if (drag.dir.indexOf('s') !== -1) { height = drag.startHeight + dy; }
    if (drag.dir.indexOf('n') !== -1) { height = drag.startHeight - dy; }

    // Aspect ratio is kept unless Shift is held, which is the opposite of most
    // drawing tools on purpose: in a document, distorted images are a mistake.
    var freeform = event.shiftKey;
    if (!freeform) {
      if (drag.dir === 'n' || drag.dir === 's') { width = height * drag.ratio; }
      else { height = width / drag.ratio; }
    }

    width = Math.max(16, Math.round(width));
    height = Math.max(16, Math.round(height));

    imageTarget.style.width = width + 'px';
    imageTarget.style.height = freeform ? height + 'px' : 'auto';
    imageTarget.style.maxWidth = '100%';
    positionImageChrome(width + ' × ' + height);
  }

  function endResize() {
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', endResize);
    document.body.classList.remove('is-resizing');
    if (drag) {
      drag = null;
      HE.markDirty();
      HE.pushHistory();
    }
  }

  /* ------------------------------------------------------------ placement -- */

  function positionImageChrome(badgeText) {
    if (!imageTarget || !imageTarget.isConnected) { hideImageChrome(); return; }
    var rect = HE.rectInHost(imageTarget);
    var box = buildHandleBox();
    var frameRect = HE.frame().getBoundingClientRect();

    var visible = rect.bottom > frameRect.top && rect.top < frameRect.bottom;
    box.hidden = !visible;
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';

    var badge = box.querySelector('.handles__badge');
    if (badge) {
      badge.textContent = badgeText ||
        (Math.round(rect.width) + ' × ' + Math.round(rect.height));
    }

    var bar = buildImageBar();
    bar.hidden = !visible;
    var above = rect.top - 46 > frameRect.top;
    bar.style.top = (above ? rect.top - 46 : Math.min(rect.bottom + 10, frameRect.bottom - 46)) + 'px';
    bar.style.left = Math.max(frameRect.left + 8, rect.left) + 'px';
  }

  function hideImageChrome() {
    if (handleBox) { handleBox.hidden = true; }
    if (imageBar) { imageBar.hidden = true; }
    imageTarget = null;
  }

  /* ------------------------------------------------------------- wiring --- */

  HE.on('select', function (element) {
    if (element && element.tagName === 'IMG') {
      imageTarget = element;
      renderImageBar(element);
      positionImageChrome();
    } else {
      hideImageChrome();
    }

    if (isAnchor(element)) { openLinkPopover(element); }
    else if (linkTarget && linkTarget !== element) { HE.closePopover(); }
  });

  HE.on('document-loaded', function (d) {
    hideImageChrome();
    // A click anywhere inside an anchor opens the link editor, even when the
    // click landed on a nested element such as <a><strong>text</strong></a>.
    d.addEventListener('click', function (event) {
      var anchor = anchorAt(event.target.nodeType === 1 ? event.target : event.target.parentElement);
      if (anchor) { openLinkPopover(anchor); }
    });
  });

  HE.registerOverlayRefresher(function () {
    if (imageTarget) { positionImageChrome(); }
  });

  HE.registerContextProvider(function (element) {
    var entries = [];
    var anchor = anchorAt(element);
    if (anchor) {
      entries.push({
        label: HE.t('link.title') + '…', group: 'element',
        action: function () { openLinkPopover(anchor); }
      });
      entries.push({
        label: HE.t('link.open'), group: 'element',
        action: function () { window.open(resolveHref(anchor.getAttribute('href') || ''), '_blank', 'noopener'); }
      });
    }
    if (element && element.tagName === 'IMG') {
      entries.push({
        label: HE.t('image.open', 'Open the image in a new tab'), group: 'element',
        action: function () { openImage(element); }
      });
      entries.push({
        label: HE.t('image.alt', 'Alternative text') + '…', group: 'element',
        action: function () { promptAlt(element); }
      });
      entries.push({
        label: HE.t('image.replace', 'Replace image…'), group: 'element',
        action: function () { replaceImage(element); }
      });
    }
    return entries;
  });

  /**
   * Opens the picture by itself, at the address the page is really using: a
   * file next to the document opens from its own folder, and one still hosted
   * elsewhere opens where it lives.
   */
  function openImage(img) {
    var url = img.currentSrc || resolveHref(img.getAttribute('src') || '');
    if (!url) { return; }
    if (url.indexOf('data:') === 0) {
      // Chrome refuses to navigate to a data URL, so an embedded picture is
      // handed over as a blob instead of leaving the menu entry doing nothing.
      fetch(url).then(function (res) { return res.blob(); }).then(function (blob) {
        window.open(URL.createObjectURL(blob), '_blank', 'noopener');
      }).catch(function (err) {
        HE.toast(HE.t('image.openFailed', 'Could not open the image: ') + err.message, 'error');
      });
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  function replaceImage(img) {
    var picker = HE.el('input', { type: 'file', accept: 'image/*' });
    picker.addEventListener('change', function () {
      if (!picker.files || !picker.files[0]) { return; }
      HE.storeAsset(picker.files[0]).then(function (asset) {
        HE.edit(function () { img.setAttribute('src', asset.name); });
        HE.toast(HE.t('image.stored') + asset.name, 'ok');
      }).catch(function (err) {
        HE.toast(HE.t('image.failed') + err.message, 'error');
      });
    });
    picker.click();
  }

  HE.overlays = {
    openLinkPopover: openLinkPopover,
    positionImageChrome: positionImageChrome,
    replaceImage: replaceImage,
    promptAlt: promptAlt
  };

  function iconSVG(path, open) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', open ? 'M14 4h6v6M20 4l-8 8M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6' : path);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }
})(window.HE);
