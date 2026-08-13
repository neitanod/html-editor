/*
 * lightbox.js — the picture seen large, and the document read as a gallery.
 *
 * Double-clicking a picture opens it filling the screen, where the wheel zooms
 * towards the pointer and dragging walks around what no longer fits. The
 * arrows, on screen and on the keyboard, step through every other picture of
 * the document in the order they appear in it.
 *
 * Like every other overlay this lives in the host page, never inside the edited
 * document, so nothing of it can reach the saved file. The picture is shown
 * from the same address the iframe already painted, so an image that is only on
 * disk next to the document is displayed without a second trip to the server.
 */
(function (HE) {
  'use strict';

  var MAX_SCALE = 12;
  var WHEEL_SPEED = 0.0018;
  var LINE_HEIGHT = 16;        // a wheel notch reported in lines, in pixels

  var ui = null;               // built on first use
  var gallery = [];            // the <img> elements of the document, in order
  var index = -1;
  var view = null;             // {natural, fit, scale, tx, ty}
  var pointers = {};           // active pointers, for dragging and pinching
  var pinch = null;
  var moved = false;           // a drag must not be read as a click on the backdrop

  /* ------------------------------------------------------------ the images -- */

  /**
   * Every picture of the document that has something to show. Pictures the
   * editor itself painted are left out: the gallery is the document's, not the
   * workbench's.
   */
  function collect() {
    var d = HE.doc();
    if (!d) { return []; }
    return HE.$$('img', d).filter(function (img) {
      if (img.closest('[data-html-editor-ui]')) { return false; }
      return !!(img.getAttribute('src') || img.currentSrc);
    });
  }

  /** The address the browser painted, which already resolved the relative src. */
  function sourceOf(img) {
    if (img.currentSrc) { return img.currentSrc; }
    try {
      return new URL(img.getAttribute('src') || '', HE.win().location.href).href;
    } catch (err) {
      return img.getAttribute('src') || '';
    }
  }

  function labelOf(img) {
    var src = (img.getAttribute('src') || '').split(/[?#]/)[0];
    var name = src.substring(src.lastIndexOf('/') + 1);
    return name || img.getAttribute('alt') || '';
  }

  /* ------------------------------------------------------------- the panel -- */

  function build() {
    if (ui) { return ui; }

    var picture = HE.el('img', { class: 'lightbox__img', alt: '' });
    var stage = HE.el('div', { class: 'lightbox__stage' }, [picture]);

    var counter = HE.el('span', { class: 'lightbox__counter', text: '' });
    var name = HE.el('span', { class: 'lightbox__name', text: '' });
    var size = HE.el('span', { class: 'lightbox__size', text: '' });
    var zoomLabel = HE.el('span', { class: 'lightbox__zoom', text: '' });

    var bar = HE.el('div', { class: 'lightbox__bar' }, [counter, name, size,
      HE.el('span', { class: 'lightbox__spacer' }), zoomLabel]);

    barButton(bar, 'gallery.zoomOut', 'Zoom out', '&minus;', function () { zoomBy(1 / 1.4); });
    barButton(bar, 'gallery.zoomIn', 'Zoom in', '+', function () { zoomBy(1.4); });
    barButton(bar, 'gallery.fit', 'Fit to the screen', '&#9633;', function () { reset(); });
    barButton(bar, 'gallery.close', 'Close', '&#10005;', function () { close(); }).classList
      .add('lightbox__btn--close');

    var prev = navButton('prev', 'gallery.prev', 'Previous image', 'M15 5 8 12l7 7');
    var next = navButton('next', 'gallery.next', 'Next image', 'M9 5l7 7-7 7');

    var root = HE.el('div', {
      class: 'lightbox', hidden: 'hidden', tabindex: '-1', role: 'dialog'
    }, [stage, bar, prev, next]);
    document.body.appendChild(root);

    ui = {
      root: root, stage: stage, picture: picture, bar: bar,
      counter: counter, name: name, size: size, zoomLabel: zoomLabel,
      prev: prev, next: next
    };

    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });

    // A click that lands on the backdrop closes; one that ends a drag does not.
    root.addEventListener('click', function (event) {
      if (event.target === root || event.target === stage) {
        if (!moved) { close(); }
      }
    });

    picture.addEventListener('load', function () {
      view = null;
      layout();
    });

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', onDoubleClick);
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    ['pointerup', 'pointercancel'].forEach(function (type) {
      stage.addEventListener(type, onPointerUp);
    });

    return ui;
  }

  function barButton(bar, key, fallback, glyph, onClick) {
    var btn = HE.el('button', {
      class: 'lightbox__btn', type: 'button', html: glyph,
      title: HE.t(key, fallback)
    });
    btn.dataset.i18nTitle = key;
    btn.addEventListener('click', function (event) { event.preventDefault(); onClick(); });
    bar.appendChild(btn);
    return btn;
  }

  function navButton(side, key, fallback, path) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);

    var btn = HE.el('button', {
      class: 'lightbox__nav lightbox__nav--' + side, type: 'button',
      title: HE.t(key, fallback)
    });
    btn.dataset.i18nTitle = key;
    btn.appendChild(svg);
    return btn;
  }

  /* -------------------------------------------------------------- geometry -- */

  /**
   * The picture is drawn from its top-left corner: `tx`/`ty` place that corner
   * inside the stage and `scale` says how big a natural pixel is on screen.
   * Fitting means the whole picture is visible; a picture smaller than the
   * screen is never blown up on arrival.
   */
  function measure() {
    var picture = ui.picture;
    var natural = {
      w: picture.naturalWidth || picture.width || 1,
      h: picture.naturalHeight || picture.height || 1
    };
    var box = ui.stage.getBoundingClientRect();
    var fit = Math.min(box.width / natural.w, box.height / natural.h, 1);
    return { natural: natural, fit: fit > 0 ? fit : 1, box: box };
  }

  function reset() {
    view = null;
    layout();
  }

  function layout() {
    if (!ui || ui.root.hidden) { return; }
    // Until the file has been decoded there is no size to fit: the load event
    // brings the picture back here with its natural dimensions known.
    if (!ui.picture.naturalWidth) { return; }
    var m = measure();
    if (!view || view.natural.w !== m.natural.w || view.natural.h !== m.natural.h) {
      view = { natural: m.natural, fit: m.fit, previousFit: m.fit, scale: m.fit, tx: 0, ty: 0 };
    } else {
      view.fit = m.fit;
      // Fitting again on a resize would throw away a zoom the reader is using;
      // only a picture that was already fitted follows the new size.
      if (Math.abs(view.scale - view.previousFit) < 0.0001) { view.scale = m.fit; }
    }
    view.previousFit = m.fit;
    clampToStage(m.box);
    draw();
  }

  /**
   * Keeps the picture honest: what is smaller than the stage sits centred, and
   * what is larger cannot be dragged past its own edges.
   */
  function clampToStage(box) {
    var rect = box || ui.stage.getBoundingClientRect();
    var w = view.natural.w * view.scale;
    var h = view.natural.h * view.scale;
    view.tx = w <= rect.width
      ? (rect.width - w) / 2
      : Math.min(0, Math.max(rect.width - w, view.tx));
    view.ty = h <= rect.height
      ? (rect.height - h) / 2
      : Math.min(0, Math.max(rect.height - h, view.ty));
  }

  function draw() {
    ui.picture.style.width = view.natural.w + 'px';
    ui.picture.style.height = view.natural.h + 'px';
    ui.picture.style.transform =
      'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.scale + ')';
    ui.stage.classList.toggle('is-pannable', isPannable());
    ui.zoomLabel.textContent = Math.round(view.scale * 100) + '%';
  }

  function isPannable() {
    var rect = ui.stage.getBoundingClientRect();
    return view.natural.w * view.scale > rect.width + 1 ||
      view.natural.h * view.scale > rect.height + 1;
  }

  function limits() {
    return { min: Math.min(view.fit, 1), max: Math.max(view.fit, 1) * MAX_SCALE };
  }

  /** Zooms so the point under (cx, cy), in stage coordinates, stays put. */
  function zoomAt(factor, cx, cy) {
    if (!view) { return; }
    var bounds = limits();
    var next = Math.min(bounds.max, Math.max(bounds.min, view.scale * factor));
    if (next === view.scale) { return; }
    var k = next / view.scale;
    view.tx = cx - (cx - view.tx) * k;
    view.ty = cy - (cy - view.ty) * k;
    view.scale = next;
    clampToStage();
    draw();
  }

  function zoomBy(factor) {
    var rect = ui.stage.getBoundingClientRect();
    zoomAt(factor, rect.width / 2, rect.height / 2);
  }

  function stagePoint(event) {
    var rect = ui.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /* -------------------------------------------------------------- gestures -- */

  function onWheel(event) {
    event.preventDefault();
    if (!view) { return; }
    var delta = event.deltaY * (event.deltaMode === 1 ? LINE_HEIGHT : 1);
    var point = stagePoint(event);
    zoomAt(Math.exp(-delta * WHEEL_SPEED), point.x, point.y);
  }

  function onDoubleClick(event) {
    event.preventDefault();
    if (!view) { return; }
    var point = stagePoint(event);
    // Halfway above the fit already counts as zoomed in: the second double
    // click always brings the whole picture back.
    if (view.scale > view.fit * 1.05) { reset(); return; }
    zoomAt(Math.max(1, view.fit * 3) / view.scale, point.x, point.y);
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) { return; }
    // Capturing keeps the drag alive when the pointer leaves the stage, and a
    // pointer that cannot be captured (a synthetic one, say) drags anyway.
    try { ui.stage.setPointerCapture(event.pointerId); } catch (err) { /* not essential */ }
    pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    moved = false;
    if (Object.keys(pointers).length === 2) { startPinch(); }
  }

  function onPointerMove(event) {
    var previous = pointers[event.pointerId];
    if (!previous || !view) { return; }
    var dx = event.clientX - previous.x;
    var dy = event.clientY - previous.y;
    pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { moved = true; }

    if (pinch && Object.keys(pointers).length >= 2) { updatePinch(); return; }

    view.tx += dx;
    view.ty += dy;
    clampToStage();
    draw();
  }

  function onPointerUp(event) {
    delete pointers[event.pointerId];
    if (Object.keys(pointers).length < 2) { pinch = null; }
    if (ui.stage.hasPointerCapture && ui.stage.hasPointerCapture(event.pointerId)) {
      ui.stage.releasePointerCapture(event.pointerId);
    }
  }

  function pinchState() {
    var points = Object.keys(pointers).map(function (id) { return pointers[id]; });
    var a = points[0];
    var b = points[1];
    var rect = ui.stage.getBoundingClientRect();
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top
    };
  }

  function startPinch() { pinch = pinchState(); }

  function updatePinch() {
    var now = pinchState();
    zoomAt(now.distance / pinch.distance, now.x, now.y);
    pinch = now;
  }

  /* ------------------------------------------------------------ navigation -- */

  function show(position) {
    var img = gallery[position];
    if (!img) { return; }
    index = position;
    var panel = build();
    view = null;
    panel.picture.src = sourceOf(img);
    panel.picture.alt = img.getAttribute('alt') || '';
    panel.name.textContent = labelOf(img);
    panel.counter.textContent = gallery.length > 1
      ? (position + 1) + ' / ' + gallery.length : '';
    panel.size.textContent = img.naturalWidth
      ? img.naturalWidth + ' × ' + img.naturalHeight : '';
    panel.prev.disabled = position === 0;
    panel.next.disabled = position === gallery.length - 1;
    panel.prev.hidden = gallery.length < 2;
    panel.next.hidden = gallery.length < 2;
    layout();
  }

  function step(direction) {
    var target = index + direction;
    if (target < 0 || target >= gallery.length) { return; }
    show(target);
  }

  /* ------------------------------------------------------- opening, closing -- */

  function open(img) {
    if (!img || img.tagName !== 'IMG') { return; }
    gallery = collect();
    var position = gallery.indexOf(img);
    if (position === -1) {
      gallery = [img];
      position = 0;
    }
    build();
    ui.root.hidden = false;
    document.body.classList.add('is-lightboxed');
    show(position);
    // The double click came from inside the iframe, so the keyboard is still
    // aimed at the document being edited; taking the focus is what makes the
    // arrows and Escape belong to the viewer.
    ui.root.focus();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', layout);
  }

  function close() {
    if (!ui || ui.root.hidden) { return; }
    ui.root.hidden = true;
    ui.picture.removeAttribute('src');
    document.body.classList.remove('is-lightboxed');
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', layout);
    pointers = {};
    pinch = null;
    view = null;
    // Coming back to the document with the picture that was being read already
    // selected: closing the viewer is not meant to lose your place.
    var img = gallery[index];
    gallery = [];
    index = -1;
    if (img && img.isConnected) { HE.select(img); }
  }

  function isOpen() { return !!ui && !ui.root.hidden; }

  function onKey(event) {
    if (!isOpen()) { return; }
    var key = event.key;
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); step(-1); return; }
    if (key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); step(1); return; }
    if (key === 'Home') { event.preventDefault(); show(0); return; }
    if (key === 'End') { event.preventDefault(); show(gallery.length - 1); return; }
    if (key === '+' || key === '=') { event.preventDefault(); zoomBy(1.4); return; }
    if (key === '-') { event.preventDefault(); zoomBy(1 / 1.4); return; }
    if (key === '0') { event.preventDefault(); reset(); }
  }

  /* ---------------------------------------------------------------- wiring -- */

  HE.on('document-loaded', function (d) {
    close();
    d.addEventListener('dblclick', function (event) {
      var target = event.target;
      if (!target || target.tagName !== 'IMG') { return; }
      // Without this the double click also selects the word around the picture
      // and leaves the document with a selection nobody asked for.
      event.preventDefault();
      open(target);
    });
  });

  // A document rewritten from the source panel (or by undo) leaves the viewer
  // pointing at an element that is no longer in the page.
  HE.on('mutated', function () {
    if (isOpen() && (!gallery[index] || !gallery[index].isConnected)) { close(); }
  });

  HE.registerContextProvider(function (element) {
    if (!element || element.tagName !== 'IMG') { return []; }
    return [{
      label: HE.t('gallery.view', 'View large') + '…',
      group: 'element',
      action: function () { open(element); }
    }];
  });

  HE.lightbox = {
    open: open, close: close, isOpen: isOpen,
    next: function () { step(1); },
    previous: function () { step(-1); }
  };

  /*
   * New CSS class names introduced by this module (for editor.css):
   *   .lightbox          — the full-screen backdrop
   *   .lightbox__stage   — the surface the picture is panned on
   *   .lightbox__img     — the picture itself, moved by a transform
   *   .lightbox__bar     — counter, file name, size and zoom controls
   *   .lightbox__btn     — one button of that bar
   *   .lightbox__nav     — the previous / next arrows on the sides
   */
})(window.HE);
