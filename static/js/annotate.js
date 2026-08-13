/*
 * annotate.js — marking up a picture: blurring what should not be read,
 * numbering what has to be talked about, and drawing over the rest.
 *
 * The screenshot that explains something almost never explains it on its own.
 * What it needs is a circle around the button, a "1" and a "2" to point at in
 * the sentence below, an arrow to the number that matters, and a blurred patch
 * over the address that has no business being published. Doing that anywhere
 * else means leaving the editor, so it happens here, over the picture already
 * sitting in the document.
 *
 * The way it behaves is lifted from the image editor of the Agencia project,
 * which is the one already in daily use: you draw by dragging, you touch a mark
 * to pick it up, touching it also adopts its style the way an eyedropper does,
 * and every gesture is one step of undo. Copying a working interaction beats
 * inventing a second one that has to be learned.
 *
 * Marks are baked into a new file, like every other picture edit: the document
 * keeps one plain `<img>`, and the annotated copy is a picture like any other
 * wherever it is opened. Nothing is layered on top in HTML, because a layer
 * that only exists in this editor is a mark that vanishes on the way out.
 *
 * There is no drawing library behind this and none is needed: shapes live in a
 * plain list, in pixels of the picture, and ONE function paints that list —
 * scaled down for the preview, at natural size for the file. What you see is
 * therefore what comes out, without a second implementation to keep in step.
 */
(function (HE) {
  'use strict';

  var STAGE_W = 620;
  var STAGE_H = 430;
  var MIN_SIZE = 6;            // in pixels of the picture

  var TOOLS = ['blur', 'number', 'rect', 'ellipse', 'line', 'arrow'];
  /** The ones drawn by dragging from one end to the other. */
  var DRAGGED = { blur: true, rect: true, ellipse: true, line: true, arrow: true };
  var CLOSED = { rect: true, ellipse: true };

  /*
   * Eight colours to mark a picture with, chosen to shout over a screenshot
   * that already has colours of its own. Red goes first because it is what
   * anybody reaches for; the ninth swatch is the native picker, which covers
   * the rest without costing us a colour wheel.
   */
  var COLORS = [
    '#e5484d', '#f76b15', '#ffc53d', '#30a46c',
    '#0090ff', '#8e4ec6', '#1c2024', '#ffffff'
  ];

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  /* ------------------------------------------------------------- geometry -- */

  /**
   * The head of an arrow: two wings folded back from the tip. Its length comes
   * from the stroke, so a thick arrow gets a head to match instead of a pin.
   */
  function arrowHead(x0, y0, x1, y1, width) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    var len = Math.hypot(dx, dy) || 1;
    var head = Math.min(width * 4.5, len);
    var ux = dx / len;
    var uy = dy / len;
    var cos = Math.cos(0.45);      // 25° off the axis on each side
    var sin = Math.sin(0.45);
    return [
      { x: x1 - head * (ux * cos - uy * sin), y: y1 - head * (uy * cos + ux * sin) },
      { x: x1 - head * (ux * cos + uy * sin), y: y1 - head * (uy * cos - ux * sin) }
    ];
  }

  function boxOf(shape) {
    return {
      x: Math.min(shape.x0, shape.x1), y: Math.min(shape.y0, shape.y1),
      w: Math.abs(shape.x1 - shape.x0), h: Math.abs(shape.y1 - shape.y0)
    };
  }

  /**
   * The corner radius, capped at half the shorter side so a flat rectangle does
   * not turn into a deformed capsule.
   */
  function cornerRadius(shape) {
    if (!shape.rounded) { return 0; }
    var box = boxOf(shape);
    return Math.min(shape.width * 3, box.w / 2, box.h / 2);
  }

  /**
   * The box a mark occupies, in pixels of the picture: what gets outlined when
   * it is selected, and what a click is tested against to pick it up.
   *
   * The stroke-wide margin is not decorative: a horizontal line has a box of
   * height ZERO, and without it there would be nothing to grab.
   */
  function shapeBounds(shape) {
    var pad = Math.max(shape.kind === 'number' ? 0 : shape.width, 6);
    var box;
    if (shape.kind === 'number') {
      var r = shape.size / 2;
      box = { x: shape.x0 - r, y: shape.y0 - r, w: r * 2, h: r * 2 };
    } else {
      box = boxOf(shape);
    }
    return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
  }

  function hits(shape, point) {
    var b = shapeBounds(shape);
    return point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h;
  }

  /* -------------------------------------------------------------- drawing -- */

  /**
   * White or black, whichever can be read on the colour underneath. The usual
   * relative luminance: yellow and white ask for dark text, the rest for light.
   */
  function readableOn(hex) {
    var h = hex.replace('#', '');
    var n = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
    var channels = [0, 2, 4].map(function (i) {
      var c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    return L > 0.45 ? '#1c2024' : '#ffffff';
  }

  /**
   * The shadow is what keeps a red arrow visible over a red screenshot. Its
   * numbers follow the stroke, so a thin line gets a hint and a thick one a
   * proper lift.
   */
  function applyShadow(ctx, shape) {
    if (!shape.shadow) { return; }
    var w = shape.width || 3;
    ctx.shadowColor = 'rgba(0, 0, 0, .4)';
    ctx.shadowBlur = w * 1.2;
    ctx.shadowOffsetY = w * 0.6;
  }

  /**
   * Blurs one patch, and blurs it hard enough to be a decision rather than a
   * suggestion: a gentle blur over a licence plate is a promise the picture
   * does not keep.
   *
   * The whole picture is drawn through a clip so the filter has real pixels to
   * pull from around the patch, instead of the transparent edge it would find
   * if only the patch were drawn. Where the browser has no filter, the patch is
   * scaled down and back up: the mosaic is coarser to look at and just as
   * final.
   */
  function drawBlur(ctx, bitmap, shape) {
    var box = boxOf(shape);
    if (box.w < 1 || box.h < 1) { return; }
    // The strength is a percentage of the shorter side of the patch, so the
    // same setting reads the same over a stamp and over half a screenshot.
    var radius = Math.max(2, Math.min(box.w, box.h) * shape.strength / 100);

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    if (typeof ctx.filter === 'string') {
      ctx.filter = 'blur(' + radius.toFixed(2) + 'px)';
      ctx.drawImage(bitmap, 0, 0, bitmap.naturalWidth, bitmap.naturalHeight);
      ctx.filter = 'none';
    } else {
      var block = Math.max(1, Math.round(radius));
      var small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(box.w / block));
      small.height = Math.max(1, Math.round(box.h / block));
      small.getContext('2d').drawImage(
        bitmap, box.x, box.y, box.w, box.h, 0, 0, small.width, small.height
      );
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, box.x, box.y, box.w, box.h);
      ctx.imageSmoothingEnabled = true;
    }
    ctx.restore();
  }

  /**
   * A numbered disc. The white ring is not an ornament: without it a red circle
   * disappears over a dark app with red accents, and loses its edges over a
   * light one.
   */
  function drawNumber(ctx, shape, label) {
    var d = shape.size;
    var r = d / 2;
    var ring = Math.max(1.5, r * 0.13);

    ctx.save();
    applyShadow(ctx, shape);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(shape.x0, shape.y0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = shape.strokeColor;
    ctx.beginPath();
    ctx.arc(shape.x0, shape.y0, r - ring, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = readableOn(shape.strokeColor);
    ctx.font = '600 ' + (d * (label.length > 1 ? 0.46 : 0.54)) + 'px ' +
      'ui-sans-serif, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A hair downwards: `middle` centres on the font box, and a digit has no
    // descender to balance it.
    ctx.fillText(label, shape.x0, shape.y0 + d * 0.02);
  }

  /**
   * Fills and outlines the same figure, with the shadow cast ONCE. Without the
   * precaution a filled and outlined shape casts it twice — the fill throws it
   * and the stroke throws it again over the painted fill — and leaves a dark
   * ring inside the outline.
   */
  function fillAndStroke(ctx, shape) {
    if (shape.fill) {
      ctx.fillStyle = shape.fillColor;
      ctx.fill();
    }
    if (shape.stroke || !shape.fill) {
      if (shape.fill) { ctx.shadowColor = 'transparent'; }
      ctx.strokeStyle = shape.strokeColor;
      ctx.lineWidth = shape.width;
      ctx.stroke();
    }
  }

  function drawShape(ctx, bitmap, shape, label) {
    if (shape.kind === 'blur') { drawBlur(ctx, bitmap, shape); return; }
    if (shape.kind === 'number') { drawNumber(ctx, shape, label); return; }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    applyShadow(ctx, shape);

    if (shape.kind === 'rect') {
      var r = boxOf(shape);
      var radius = cornerRadius(shape);
      ctx.beginPath();
      // `roundRect` is from 2023 and not everywhere yet; with radius 0 a plain
      // rectangle is the same path, so there is no second branch to write.
      if (radius > 0 && ctx.roundRect) { ctx.roundRect(r.x, r.y, r.w, r.h, radius); }
      else { ctx.rect(r.x, r.y, r.w, r.h); }
      fillAndStroke(ctx, shape);
    } else if (shape.kind === 'ellipse') {
      var e = boxOf(shape);
      ctx.beginPath();
      ctx.ellipse(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2);
      fillAndStroke(ctx, shape);
    } else {
      // A line is its own outline: it takes the stroke colour even when the
      // outline was switched off, which would otherwise mean drawing nothing.
      ctx.strokeStyle = shape.strokeColor;
      ctx.fillStyle = shape.strokeColor;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(shape.x0, shape.y0);
      ctx.lineTo(shape.x1, shape.y1);
      ctx.stroke();
      if (shape.kind === 'arrow') {
        var wings = arrowHead(shape.x0, shape.y0, shape.x1, shape.y1, shape.width);
        // The head is filled in a path of its own: drawn from the same one, the
        // shadow of the shaft smears over the point.
        ctx.shadowColor = 'transparent';
        ctx.beginPath();
        ctx.moveTo(shape.x1, shape.y1);
        ctx.lineTo(wings[0].x, wings[0].y);
        ctx.lineTo(wings[1].x, wings[1].y);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * The discs are numbered in the order they were dropped, and the count is ONE
   * count for the screen and for the file: a sentence that talks about the "3"
   * has to find a 3 in the picture.
   */
  function labelsFor(shapes) {
    var n = 0;
    return shapes.map(function (shape) {
      return shape.kind === 'number' ? String(++n) : '';
    });
  }

  /**
   * Paints the picture and every mark on it. `scale` is the only difference
   * between what the dialog shows and what gets written to disk.
   */
  function paint(ctx, bitmap, shapes, scale) {
    var labels = labelsFor(shapes);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, bitmap.naturalWidth, bitmap.naturalHeight);
    ctx.drawImage(bitmap, 0, 0, bitmap.naturalWidth, bitmap.naturalHeight);
    shapes.forEach(function (shape, i) { drawShape(ctx, bitmap, shape, labels[i]); });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* --------------------------------------------------------- the dialog --- */

  function open(img) {
    HE.imagefile.open(img, open).then(function (source) {
      if (source) { openWith(img, source.bitmap, source.mime); }
    });
  }

  function openWith(img, bitmap, mime) {
    var natural = { w: bitmap.naturalWidth, h: bitmap.naturalHeight };
    var short = Math.min(natural.w, natural.h);

    /*
     * Proportions follow the picture instead of being fixed: a 3px stroke on a
     * phone screenshot is a thick line, and on a 4K capture it is invisible.
     */
    var state = {
      tool: 'blur',
      shapes: [],
      active: null,
      scale: 1,
      style: {
        strokeColor: COLORS[0],
        fillColor: COLORS[0],
        stroke: true,
        fill: false,
        shadow: true,
        rounded: true,
        width: clamp(Math.round(short * 0.006), 2, 14),
        size: clamp(Math.round(short * 0.07), 26, 120),
        strength: 14
      }
    };

    /* -- history ---------------------------------------------------------- */

    /*
     * Whole states, not operations with an inverse. There are already five
     * gestures to undo — draw, move, delete, restyle and clear — and each new
     * shape would add its own; copying four numbers and a list of shapes is
     * cheaper than keeping five inverses correct, and it cannot fall out of
     * step: what comes back is exactly what was there.
     */
    var past = [];
    var future = [];
    var lastTag = null;
    var HISTORY_LIMIT = 80;

    function snapshot() {
      return {
        shapes: state.shapes.map(function (s) { return Object.assign({}, s); }),
        active: state.active
      };
    }

    /** Called BEFORE touching anything: what is kept is the state to go back to. */
    function remember(tag) {
      if (tag && tag === lastTag) { return; }
      lastTag = tag || null;
      past.push(snapshot());
      if (past.length > HISTORY_LIMIT) { past.shift(); }
      future = [];
    }

    /*
     * A gesture that ended where it started is not a step: the touch that only
     * selected, the arrow stretched and dropped. Without this, undo spends a
     * Ctrl+Z on changing nothing visible, which is the fastest way to stop
     * trusting the button. Which shape was selected is left out of the
     * comparison on purpose: selecting is not an edit.
     */
    function forgetIfUnchanged() {
      var previous = past[past.length - 1];
      if (!previous) { return; }
      if (JSON.stringify(previous.shapes) === JSON.stringify(state.shapes)) {
        past.pop();
        lastTag = null;
      }
    }

    function restore(snap) {
      state.shapes = snap.shapes.map(function (s) { return Object.assign({}, s); });
      state.active = snap.active;
    }

    function undo() {
      if (!past.length) { return; }
      future.push(snapshot());
      restore(past.pop());
      lastTag = null;
      draw();
    }

    function redo() {
      if (!future.length) { return; }
      past.push(snapshot());
      restore(future.pop());
      lastTag = null;
      draw();
    }

    /* -- the stage -------------------------------------------------------- */

    var canvas = HE.el('canvas', { class: 'mark__canvas' });
    var halo = HE.el('div', { class: 'mark__halo', hidden: 'hidden' });
    var removeBtn = HE.el('button', {
      class: 'mark__remove', type: 'button', text: '✕',
      title: HE.t('mark.remove', 'Delete this mark (Del)')
    });
    halo.appendChild(removeBtn);
    var stage = HE.el('div', { class: 'mark__stage' }, [canvas, halo]);
    var ctx = canvas.getContext('2d');

    removeBtn.addEventListener('mousedown', function (event) { event.stopPropagation(); });
    removeBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      deleteSelected();
    });

    function selected() {
      return state.active === null ? null : state.shapes[state.active] || null;
    }

    function deleteSelected() {
      if (state.active === null || !state.shapes[state.active]) { return; }
      remember();
      state.shapes.splice(state.active, 1);
      state.active = null;
      draw();
    }

    function draw() {
      var scale = Math.min(STAGE_W / natural.w, STAGE_H / natural.h, 1);
      var width = Math.round(natural.w * scale);
      var height = Math.round(natural.h * scale);
      state.scale = width / natural.w;

      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      stage.style.width = width + 'px';
      stage.style.height = height + 'px';

      paint(ctx, bitmap, state.shapes, state.scale * dpr);

      var mark = selected();
      halo.hidden = !mark;
      if (mark) {
        var b = shapeBounds(mark);
        halo.style.left = Math.round(b.x * state.scale) + 'px';
        halo.style.top = Math.round(b.y * state.scale) + 'px';
        halo.style.width = Math.round(b.w * state.scale) + 'px';
        halo.style.height = Math.round(b.h * state.scale) + 'px';
      }

      undoBtn.disabled = !past.length;
      redoBtn.disabled = !future.length;
      var total = state.shapes.length;
      count.textContent = total
        ? total + ' ' + (total === 1 ? HE.t('mark.one', 'mark') : HE.t('mark.marks', 'marks'))
        : HE.t('mark.none', 'no marks yet');
      syncStyleBar();
    }

    /* -- the toolbar ------------------------------------------------------ */

    var bar = HE.el('div', { class: 'mark__bar' });

    function tool(host, title, label, onClick, extraClass) {
      var btn = HE.el('button', {
        class: 'btn btn--tool btn--sm' + (extraClass ? ' ' + extraClass : ''),
        type: 'button', title: title, html: label
      });
      btn.addEventListener('click', function (event) { event.preventDefault(); onClick(btn); });
      host.appendChild(btn);
      return btn;
    }

    var TOOL_ICONS = {
      blur: '&#9925;', number: '&#10112;', rect: '&#9633;',
      ellipse: '&#9711;', line: '&#8725;', arrow: '&#8599;'
    };

    var toolButtons = TOOLS.map(function (kind) {
      var btn = tool(bar, HE.t('mark.tool.' + kind, kind), TOOL_ICONS[kind], function () {
        state.tool = kind;
        // Choosing a tool lets go of what was selected: the style bar then
        // talks about what is about to be drawn, and not about the last mark.
        state.active = null;
        draw();
      });
      btn.dataset.tool = kind;
      return btn;
    });

    bar.appendChild(HE.el('span', { class: 'floatbar__sep' }));

    var undoBtn = tool(bar, HE.t('mark.undo', 'Undo (Ctrl+Z)'), '&#8630;', undo);
    var redoBtn = tool(bar, HE.t('mark.redo', 'Redo (Ctrl+Y)'), '&#8631;', redo);
    bar.appendChild(HE.el('span', { class: 'mark__spacer' }));
    tool(bar, HE.t('mark.clear', 'Take every mark off'), HE.t('mark.clearLabel', 'Clear'), function () {
      if (!state.shapes.length) { return; }
      remember();
      state.shapes = [];
      state.active = null;
      draw();
    });

    /* -- the style of what gets drawn ------------------------------------- */

    /*
     * A change of style paints what is selected AND stays as the style of the
     * next marks. The tag is what groups it in the history: dragging the wheel
     * of the native colour picker fires an event per pixel travelled, and those
     * have to undo in one step.
     */
    function setStyle(key, value, tag) {
      var mark = selected();
      if (mark && mark[key] !== value) { remember(tag + ':' + state.active); }
      state.style[key] = value;
      if (mark) { mark[key] = value; }
      draw();
    }

    /*
     * What the controls show: the selected mark when there is one, and the
     * style in hand when there is not. Reading it from the mark is what keeps
     * the bar honest after an undo, which puts the shapes back without
     * touching the style the next mark would be drawn with.
     */
    function styleValue(key) {
      var mark = selected();
      return mark && mark[key] !== undefined ? mark[key] : state.style[key];
    }

    function swatches(key) {
      var host = HE.el('div', { class: 'mark__swatches' });
      var picker = HE.el('input', { class: 'mark__picker', type: 'color', value: state.style[key] });
      var dots = COLORS.map(function (color) {
        var dot = HE.el('button', {
          class: 'mark__swatch', type: 'button', title: color, style: 'background:' + color
        });
        dot.dataset.color = color;
        dot.addEventListener('click', function () {
          setStyle(key, color, key);
          picker.value = color;
        });
        host.appendChild(dot);
        return dot;
      });
      picker.addEventListener('input', function () { setStyle(key, picker.value, key); });
      host.appendChild(picker);
      host.sync = function () {
        var current = styleValue(key);
        dots.forEach(function (dot) {
          dot.classList.toggle('is-active', dot.dataset.color === current);
        });
        picker.value = current;
      };
      host.sync();
      return host;
    }

    function toggle(key, labelText, className) {
      var input = HE.el('input', { type: 'checkbox' });
      input.checked = state.style[key];
      input.addEventListener('change', function () { setStyle(key, input.checked, key); });
      var row = HE.el('label', { class: 'mark__toggle ' + className }, [
        input, HE.el('span', { text: labelText })
      ]);
      row.sync = function () { input.checked = !!styleValue(key); };
      return row;
    }

    function slider(key, labelText, min, max, className, format) {
      var input = HE.el('input', {
        class: 'mark__slider', type: 'range',
        min: String(min), max: String(max), step: '1', value: String(state.style[key])
      });
      var readout = HE.el('span', { class: 'mark__number', text: format(state.style[key]) });
      input.addEventListener('input', function () {
        var value = parseInt(input.value, 10) || min;
        readout.textContent = format(value);
        setStyle(key, value, key);
      });
      var row = HE.el('div', { class: 'mark__field ' + className }, [
        HE.el('span', { class: 'mark__label', text: labelText }), input, readout
      ]);
      row.sync = function () {
        input.value = String(styleValue(key));
        readout.textContent = format(styleValue(key));
      };
      return row;
    }

    var strokeToggle = toggle('stroke', HE.t('mark.stroke', 'Outline'), 'mark__only--box');
    var fillToggle = toggle('fill', HE.t('mark.fill', 'Fill'), 'mark__only--box');
    var shadowToggle = toggle('shadow', HE.t('mark.shadow', 'Shadow'), 'mark__only--drawn');
    var roundToggle = toggle('rounded', HE.t('mark.rounded', 'Rounded'), 'mark__only--rect');
    var strokeColors = swatches('strokeColor');
    var fillColors = swatches('fillColor');
    var widthField = slider('width', HE.t('mark.width', 'Thickness'), 1,
      Math.max(24, Math.round(short * 0.05)), 'mark__only--stroked',
      function (v) { return v + ' px'; });
    var sizeField = slider('size', HE.t('mark.size', 'Size'), 14,
      Math.max(60, Math.round(short * 0.2)), 'mark__only--number',
      function (v) { return v + ' px'; });
    var strengthField = slider('strength', HE.t('mark.strength', 'Blur'), 4, 40, 'mark__only--blur',
      function (v) {
        return v < 10 ? HE.t('mark.light', 'light')
          : (v < 25 ? HE.t('mark.strong', 'strong') : HE.t('mark.total', 'unreadable'));
      });

    var styleRow = HE.el('div', { class: 'mark__style' }, [
      strokeToggle,
      // On a line the outline IS the shape, so a row of colours with nothing in
      // front of it would not say what it colours.
      HE.el('span', { class: 'mark__label mark__only--plain', text: HE.t('mark.color', 'Colour') }),
      HE.el('div', { class: 'mark__only--coloured' }, [strokeColors]),
      fillToggle,
      HE.el('div', { class: 'mark__only--box' }, [fillColors]),
      widthField, sizeField, strengthField,
      roundToggle, shadowToggle
    ]);

    /*
     * The bar talks about the selected mark when there is one, and about the
     * tool in hand when there is not — the same rule that decides which
     * controls are worth showing at all. A number is always filled and a line
     * has no corners to round; showing those switches anyway would suggest they
     * do nothing.
     */
    function syncStyleBar() {
      var mark = selected();
      var kind = mark ? mark.kind : state.tool;
      styleRow.dataset.kind = kind;
      [strokeToggle, fillToggle, shadowToggle, roundToggle,
        strokeColors, fillColors, widthField, sizeField, strengthField
      ].forEach(function (node) { if (node.sync) { node.sync(); } });
      toolButtons.forEach(function (btn) {
        btn.classList.toggle('is-active', btn.dataset.tool === state.tool);
      });
    }

    /* -- drawing and picking up ------------------------------------------- */

    var drag = null;

    function pointIn(event) {
      var rect = stage.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / state.scale,
        y: (event.clientY - rect.top) / state.scale
      };
    }

    function newShape(kind, at) {
      var shape = {
        kind: kind, x0: at.x, y0: at.y, x1: at.x, y1: at.y,
        strokeColor: state.style.strokeColor, fillColor: state.style.fillColor,
        stroke: state.style.stroke, fill: state.style.fill,
        shadow: state.style.shadow, rounded: state.style.rounded,
        width: state.style.width, size: state.style.size, strength: state.style.strength
      };
      return shape;
    }

    /** The topmost mark under the pointer, so what is drawn last is grabbed first. */
    function markAt(point) {
      for (var i = state.shapes.length - 1; i >= 0; i--) {
        if (hits(state.shapes[i], point)) { return i; }
      }
      return -1;
    }

    stage.addEventListener('mousedown', function (event) {
      if (event.button) { return; }
      event.preventDefault();
      var at = pointIn(event);
      var index = markAt(at);

      if (index !== -1) {
        // Touching a mark picks it up and adopts its style, the way an
        // eyedropper does: carrying on in the old colour after touching a green
        // one surprises everybody, every time.
        var mark = state.shapes[index];
        remember();
        state.active = index;
        ['strokeColor', 'fillColor', 'stroke', 'fill', 'shadow', 'rounded', 'width', 'size', 'strength']
          .forEach(function (key) {
            if (mark[key] !== undefined) { state.style[key] = mark[key]; }
          });
        drag = {
          mode: 'move', index: index, from: at, moved: false,
          origin: { x0: mark.x0, y0: mark.y0, x1: mark.x1, y1: mark.y1 }
        };
      } else if (state.tool === 'number') {
        // The disc is born where you touched and stays in hand for the same
        // gesture: if it landed two pixels off, you nudge it without letting go.
        remember();
        state.shapes.push(newShape('number', at));
        state.active = state.shapes.length - 1;
        drag = {
          mode: 'move', index: state.active, from: at, moved: true,
          origin: { x0: at.x, y0: at.y, x1: at.x, y1: at.y }
        };
      } else {
        remember();
        state.shapes.push(newShape(state.tool, at));
        state.active = state.shapes.length - 1;
        drag = { mode: 'draw', index: state.active, from: at, moved: false };
      }

      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', endDrag);
      draw();
    });

    function onDrag(event) {
      if (!drag) { return; }
      var at = pointIn(event);
      var mark = state.shapes[drag.index];
      if (!mark) { return; }
      if (Math.abs(at.x - drag.from.x) > 2 || Math.abs(at.y - drag.from.y) > 2) {
        drag.moved = true;
      }

      if (drag.mode === 'move') {
        // Moved by the delta rather than teleported under the pointer, so the
        // grip stays where it was taken.
        var dx = at.x - drag.from.x;
        var dy = at.y - drag.from.y;
        mark.x0 = drag.origin.x0 + dx;
        mark.y0 = drag.origin.y0 + dy;
        mark.x1 = drag.origin.x1 + dx;
        mark.y1 = drag.origin.y1 + dy;
      } else {
        var end = at;
        // Shift squares a box and locks a line to eighths of a turn.
        if (event.shiftKey) {
          if (mark.kind === 'line' || mark.kind === 'arrow') {
            var angle = Math.atan2(at.y - drag.from.y, at.x - drag.from.x);
            var step = Math.PI / 4;
            var snapped = Math.round(angle / step) * step;
            var len = Math.hypot(at.x - drag.from.x, at.y - drag.from.y);
            end = {
              x: drag.from.x + Math.cos(snapped) * len,
              y: drag.from.y + Math.sin(snapped) * len
            };
          } else {
            var side = Math.max(Math.abs(at.x - drag.from.x), Math.abs(at.y - drag.from.y));
            end = {
              x: drag.from.x + (at.x < drag.from.x ? -side : side),
              y: drag.from.y + (at.y < drag.from.y ? -side : side)
            };
          }
        }
        mark.x1 = clamp(end.x, 0, natural.w);
        mark.y1 = clamp(end.y, 0, natural.h);
      }
      draw();
    }

    function endDrag() {
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', endDrag);
      if (!drag) { return; }
      var mark = state.shapes[drag.index];

      // A shape stretched nowhere does not exist: without this, every click
      // with the arrow in hand would leave an arrow of length zero, invisible
      // and impossible to grab in order to delete it.
      if (drag.mode === 'draw' && mark) {
        var box = boxOf(mark);
        var long = Math.hypot(mark.x1 - mark.x0, mark.y1 - mark.y0);
        var real = (mark.kind === 'line' || mark.kind === 'arrow')
          ? long >= MIN_SIZE
          : box.w >= MIN_SIZE && box.h >= MIN_SIZE;
        if (!real) {
          state.shapes.splice(drag.index, 1);
          state.active = null;
        }
      }
      drag = null;
      forgetIfUnchanged();
      draw();
    }

    function onKey(event) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (state.active === null) { return; }
        event.preventDefault();
        event.stopPropagation();
        deleteSelected();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) { return; }
      var key = event.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); event.stopPropagation(); undo(); }
      else if (key === 'y') { event.preventDefault(); event.stopPropagation(); redo(); }
    }
    document.addEventListener('keydown', onKey, true);

    /* -- the modal -------------------------------------------------------- */

    var count = HE.el('span', { class: 'mark__count', text: '' });

    // The marked picture can end up beside the original or on top of it, the
    // same two endings the crop dialog offers, decided by the same rule about
    // which files can be written back — and the hint says whichever of the two
    // this picture really has.
    var overwriteReady = HE.imagefile.canOverwrite(img);

    var body = HE.el('div', { class: 'mark' }, [
      bar,
      styleRow,
      HE.el('div', { class: 'mark__stage-wrap' }, [stage]),
      HE.el('div', { class: 'mark__foot' }, [
        count,
        HE.el('span', { class: 'mark__hint', text: overwriteReady
          ? HE.t('mark.hintBoth', 'Drag to draw, touch a mark to move it. Keeping a copy leaves the original where it is; writing over it does not.')
          : HE.t('mark.hint') })
      ])
    ]);

    function settle(close, overwrite) {
      close();
      if (state.shapes.length) { apply(img, bitmap, state.shapes, mime, overwrite); }
    }

    var dialog = HE.modal({
      title: HE.t('mark.title', 'Annotate'),
      body: body,
      width: '760px',
      actions: [
        { label: HE.t('common.cancel'), onClick: function (close) { close(); } },
        {
          label: HE.t('mark.applyCopy', 'Save a copy'), primary: !overwriteReady,
          onClick: function (close) { settle(close, false); }
        },
        {
          label: HE.t('mark.applyOverwrite', 'Write over it'),
          primary: overwriteReady,
          disabled: !overwriteReady,
          title: overwriteReady ? '' :
            HE.t('image.noOverwrite', 'This picture can only be saved as a copy: its format is not one the editor writes back.'),
          onClick: function (close) { settle(close, true); }
        }
      ],
      onClose: function () {
        document.removeEventListener('keydown', onKey, true);
        endDrag();
      }
    });
    dialog.card.classList.add('mark-modal');
    draw();
  }

  function apply(img, bitmap, shapes, mime, overwrite) {
    var canvas = document.createElement('canvas');
    canvas.width = bitmap.naturalWidth;
    canvas.height = bitmap.naturalHeight;
    paint(canvas.getContext('2d'), bitmap, shapes, 1);
    HE.imagefile.write(img, canvas, mime, 'mark', { overwrite: overwrite });
  }

  HE.annotate = { open: open };

  HE.registerContextProvider(function (element) {
    if (!element || element.tagName !== 'IMG') { return []; }
    return [{
      label: HE.t('mark.title', 'Annotate') + '…',
      group: 'element',
      action: function () { open(element); }
    }];
  });

  /*
   * New CSS class names introduced by this module (for editor.css):
   *   .mark-modal          — the dialog, widened for the picture
   *   .mark__bar           — the tools, undo/redo and clear
   *   .mark__spacer        — pushes Clear to the far end of the bar
   *   .mark__style         — the row of colours, switches and sliders
   *   .mark__only--box     — shown for the shapes that have an inside (box, ellipse)
   *   .mark__only--rect    — shown for the box alone (rounded corners)
   *   .mark__only--drawn   — shown for everything except the blur
   *   .mark__only--stroked — shown where a stroke width means something
   *   .mark__only--coloured— shown wherever a colour applies (everything but blur)
   *   .mark__only--plain   — the "Colour" label, for the shapes with no Outline switch
   *   .mark__only--number  — shown for the numbered disc (its size)
   *   .mark__only--blur    — shown for the blur alone (its strength)
   *   .mark__toggle        — one of the switches
   *   .mark__swatches      — the eight colours plus the native picker
   *   .mark__swatch        — one of them
   *   .mark__picker        — the native colour input at the end of the row
   *   .mark__field         — a labelled slider
   *   .mark__label         — its name
   *   .mark__slider        — the slider itself
   *   .mark__number        — the value beside it
   *   .mark__stage-wrap    — the dark surface the picture sits on
   *   .mark__stage         — the picture at preview scale
   *   .mark__canvas        — the picture with its marks
   *   .mark__halo          — the outline around the selected mark
   *   .mark__remove        — the ✕ that deletes it
   *   .mark__foot          — the mark count and the hint under the stage
   *   .mark__count         — how many marks are on the picture
   *   .mark__hint          — the sentence beside it
   */
})(window.HE);
