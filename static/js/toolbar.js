/*
 * toolbar.js — formatting bar, top chrome buttons and their live state.
 *
 * Inline styling avoids the legacy <font> markup: execCommand is used with a
 * sentinel font name and the resulting nodes are rewritten as spans carrying a
 * real CSS declaration, which is what ends up in the saved file.
 */
(function (HE) {
  'use strict';

  var SENTINEL = 'HE-SENTINEL-FONT';

  var FONTS = [
    ['', 'font.inherit'],
    ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'System sans'],
    ['Georgia, "Times New Roman", serif', 'Georgia'],
    ['"Iowan Old Style", "Palatino Linotype", Palatino, serif', 'Palatino'],
    ['Helvetica, Arial, sans-serif', 'Helvetica'],
    ['Verdana, Geneva, sans-serif', 'Verdana'],
    ['"Trebuchet MS", sans-serif', 'Trebuchet'],
    ['"Courier New", Courier, monospace', 'Courier'],
    ['ui-monospace, "JetBrains Mono", "Fira Code", monospace', 'Monospace'],
    ['"Brush Script MT", cursive', 'Script'],
    ['Impact, Haettenschweiler, sans-serif', 'Impact']
  ];

  var SIZES = ['', '10px', '12px', '14px', '16px', '18px', '20px', '24px', '28px',
    '32px', '40px', '48px', '64px', '0.875rem', '1rem', '1.25rem', '1.5rem', '2rem'];

  var SYMBOLS = ('© ® ™ § ¶ † ‡ • · … – — « » “ ” ‘ ’ € £ ¥ ¢ ° ± × ÷ ≠ ≈ ≤ ≥ ∞ µ ' +
    'α β γ δ π Ω ∑ √ ∫ ∂ ← → ↑ ↓ ↔ ⇒ ⇔ ★ ☆ ♥ ♦ ♣ ♠ ✓ ✔ ✗ ✘ ☑ ☐ ☺ ☹ ¡ ¿ ñ Ñ á é í ó ú ü Ü').split(' ');

  /* ------------------------------------------------------------ helpers -- */

  function applyInlineStyle(property, value) {
    HE.edit(function () {
      var d = HE.doc();
      var win = HE.win();
      win.focus();
      var selection = win.getSelection();
      if (!selection || !selection.rangeCount) { return; }

      if (selection.isCollapsed) {
        // With a collapsed caret the closest block gets the declaration, which
        // is what people expect when they pick a font with nothing selected.
        var node = selection.anchorNode;
        var block = node && (node.nodeType === 1 ? node : node.parentElement);
        while (block && block !== d.body && win.getComputedStyle(block).display === 'inline') {
          block = block.parentElement;
        }
        if (block && block !== d.documentElement) { block.style[property] = value; }
        return;
      }

      d.execCommand('styleWithCSS', false, false);
      d.execCommand('fontName', false, SENTINEL);
      Array.prototype.forEach.call(d.querySelectorAll('font[face="' + SENTINEL + '"]'), function (font) {
        var span = d.createElement('span');
        span.style[property] = value;
        while (font.firstChild) { span.appendChild(font.firstChild); }
        font.parentNode.replaceChild(span, font);
      });
    });
  }

  function command(name, value) {
    HE.edit(function () { HE.exec(name, value); });
    refreshState();
  }

  /* ------------------------------------------------------------- wiring -- */

  HE.$$('[data-cmd]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.preventDefault();
      command(button.dataset.cmd);
    });
  });

  var blockSelect = document.getElementById('ctl-block');
  blockSelect.addEventListener('change', function () {
    command('formatBlock', '<' + blockSelect.value + '>');
  });

  var fontSelect = document.getElementById('ctl-font');
  fontSelect.innerHTML = ''; // the placeholder option comes from FONTS below
  FONTS.forEach(function (entry) {
    var label = entry[1].indexOf('.') !== -1 ? HE.t(entry[1]) : entry[1];
    var option = HE.el('option', { value: entry[0], text: label });
    if (entry[0]) { option.style.fontFamily = entry[0]; }
    fontSelect.appendChild(option);
  });
  fontSelect.addEventListener('change', function () {
    if (!fontSelect.value) { return; }
    applyInlineStyle('fontFamily', fontSelect.value);
  });

  var sizeSelect = document.getElementById('ctl-size');
  SIZES.forEach(function (size) {
    if (!size) { return; }
    sizeSelect.appendChild(HE.el('option', { value: size, text: size }));
  });
  sizeSelect.addEventListener('change', function () {
    if (!sizeSelect.value) { return; }
    applyInlineStyle('fontSize', sizeSelect.value);
  });

  var fore = document.getElementById('ctl-fore');
  fore.addEventListener('input', function () {
    document.getElementById('swatch-fore').style.setProperty('--swatch', fore.value);
    applyInlineStyle('color', fore.value);
  });

  var back = document.getElementById('ctl-back');
  back.addEventListener('input', function () {
    document.getElementById('swatch-back').style.setProperty('--swatch', back.value);
    applyInlineStyle('backgroundColor', back.value);
  });

  document.getElementById('btn-link').addEventListener('click', function () {
    HE.openLinkDialog();
  });

  document.getElementById('btn-hr').addEventListener('click', function () {
    command('insertHorizontalRule');
  });

  document.getElementById('btn-special').addEventListener('click', openSymbolPicker);

  document.getElementById('btn-image').addEventListener('click', openImageDialog);

  document.getElementById('btn-save').addEventListener('click', function () { HE.save(); });
  document.getElementById('btn-undo').addEventListener('click', function () { HE.undo(); });
  document.getElementById('btn-redo').addEventListener('click', function () { HE.redo(); });

  var langButton = document.getElementById('btn-lang');
  function paintLang() {
    document.getElementById('lang-label').textContent = HE.lang.toUpperCase();
  }
  langButton.addEventListener('click', function () {
    HE.setLang(HE.lang === 'es' ? 'en' : 'es');
    paintLang();
  });
  paintLang();

  /* ------------------------------------------------------ image insertion */

  function openImageDialog() {
    var body = HE.el('div', { class: 'imagepick' });
    var tabs = HE.el('div', { class: 'imagepick__actions' });

    var fileButton = HE.el('button', { class: 'btn btn--primary', type: 'button',
      text: HE.t('image.fromComputer', 'Choose a file…') });
    fileButton.addEventListener('click', function () {
      var picker = HE.el('input', { type: 'file', accept: 'image/*', multiple: 'multiple' });
      picker.addEventListener('change', function () {
        Array.prototype.slice.call(picker.files || []).reduce(function (chain, file) {
          return chain.then(function () {
            return HE.storeAsset(file).then(function (asset) { insertImage(asset.name); });
          });
        }, Promise.resolve()).then(function () { dialog.close(); });
      });
      picker.click();
    });

    var urlInput = HE.el('input', { class: 'ctl', type: 'text', placeholder: 'https://… or photo.png' });
    var urlButton = HE.el('button', { class: 'btn btn--ghost', type: 'button', text: HE.t('common.ok') });
    urlButton.addEventListener('click', function () {
      if (!urlInput.value.trim()) { return; }
      insertImage(urlInput.value.trim());
      dialog.close();
    });

    tabs.appendChild(fileButton);
    body.appendChild(tabs);
    body.appendChild(HE.el('div', { class: 'form__row' }, [
      HE.el('label', { class: 'form__label', text: 'URL' }), urlInput, urlButton
    ]));

    var gallery = HE.el('div', { class: 'imagepick__grid' });
    body.appendChild(HE.el('h3', { class: 'imagepick__title',
      text: HE.t('image.inFolder', 'Images already in this folder') }));
    body.appendChild(gallery);

    fetch('/api/folder').then(function (res) { return res.json(); }).then(function (data) {
      if (!data.images || !data.images.length) {
        gallery.appendChild(HE.el('p', { class: 'imagepick__empty',
          text: HE.t('image.noneInFolder', 'No images next to the document yet.') }));
        return;
      }
      data.images.forEach(function (image) {
        var thumb = HE.el('button', { class: 'imagepick__item', type: 'button', title: image.name }, [
          HE.el('img', { src: image.url, alt: image.name }),
          HE.el('span', { class: 'imagepick__name', text: image.name })
        ]);
        thumb.addEventListener('click', function () {
          insertImage(image.name);
          dialog.close();
        });
        gallery.appendChild(thumb);
      });
    });

    var dialog = HE.modal({
      title: HE.t('toolbar.image'),
      body: body,
      width: '640px',
      actions: [{ label: HE.t('common.cancel'), onClick: function (close) { close(); } }]
    });
  }

  function insertImage(src) {
    HE.edit(function () {
      HE.exec('insertHTML', '<img src="' + HE.escapeAttr(src) +
        '" alt="" style="max-width:100%;height:auto">');
    });
  }

  /* --------------------------------------------------------- symbol grid -- */

  function openSymbolPicker() {
    var grid = HE.el('div', { class: 'symbols' });
    SYMBOLS.forEach(function (symbol) {
      var button = HE.el('button', { class: 'symbols__item', type: 'button', text: symbol });
      button.addEventListener('click', function () {
        HE.edit(function () { HE.exec('insertText', symbol); });
      });
      grid.appendChild(button);
    });
    HE.modal({
      title: HE.t('toolbar.symbol'),
      body: grid,
      width: '520px',
      actions: [{ label: HE.t('props.close'), primary: true, onClick: function (close) { close(); } }]
    });
  }

  /* ---------------------------------------------------------- live state -- */

  var STATE_COMMANDS = ['bold', 'italic', 'underline', 'strikeThrough',
    'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull',
    'insertUnorderedList', 'insertOrderedList'];

  function refreshState() {
    var d = HE.doc();
    if (!d) { return; }
    STATE_COMMANDS.forEach(function (name) {
      var button = document.querySelector('[data-cmd="' + name + '"]');
      if (!button) { return; }
      var active = false;
      try { active = d.queryCommandState(name); } catch (err) { active = false; }
      button.classList.toggle('is-active', !!active);
    });

    var block = '';
    try { block = (d.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (err) { block = ''; }
    if (block) {
      var option = Array.prototype.filter.call(blockSelect.options, function (opt) {
        return opt.value === block;
      })[0];
      if (option) { blockSelect.value = block; }
    }

    var selected = HE.selected;
    if (selected && HE.win()) {
      var computed = HE.win().getComputedStyle(selected);
      var swatch = document.getElementById('swatch-fore');
      if (swatch && computed.color) { swatch.style.setProperty('--swatch', computed.color); }
    }
  }

  HE.on('select', refreshState);
  HE.on('document-loaded', function (d) {
    d.addEventListener('selectionchange', refreshState);
    d.addEventListener('keyup', refreshState);
    d.addEventListener('mouseup', refreshState);
    refreshState();
  });
  HE.on('lang', function () {
    HE.applyI18n(document);
    paintLang();
  });

  HE.toolbar = { applyInlineStyle: applyInlineStyle, command: command, refreshState: refreshState };
})(window.HE);
