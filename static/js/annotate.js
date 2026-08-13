/*
 * annotate.js — marking up a picture: blurring what should not be read, and
 * drawing boxes, ellipses, lines and arrows over what should.
 *
 * The screenshot that explains something almost never explains it on its own.
 * What it needs is a circle around the button, an arrow to the number that
 * matters, and a blurred patch over the address that has no business being
 * published. Doing that anywhere else means leaving the editor, so it happens
 * here, over the picture already sitting in the document.
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

  var TOOLS = ['blur', 'rect', 'ellipse', 'line', 'arrow'];

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

  /* -------------------------------------------------------------- drawing -- */

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
   * Blurs one patch of the picture, and blurs it hard enough to be a decision
   * rather than a suggestion: a gentle blur over a licence plate is a promise
   * the picture does not keep.
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
    var radius = Math.max(2, Math.min(box.w, box.h) * shape.strength);

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

  /** Fills and outlines the same figure, in that order. */
  function paintShape(ctx, shape) {
    if (shape.fill) {
      ctx.fillStyle = shape.fillColor;
      ctx.fill();
    }
    if (shape.stroke) {
      ctx.strokeStyle = shape.strokeColor;
      ctx.lineWidth = shape.width;
      ctx.stroke();
    }
  }

  function drawShape(ctx, bitmap, shape) {
    if (shape.kind === 'blur') { drawBlur(ctx, bitmap, shape); return; }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (shape.kind === 'rect') {
      var r = boxOf(shape);
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      paintShape(ctx, shape);
    } else if (shape.kind === 'ellipse') {
      var e = boxOf(shape);
      ctx.beginPath();
      ctx.ellipse(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2);
      paintShape(ctx, shape);
    } else if (shape.kind === 'line' || shape.kind === 'arrow') {
      // A line is its outline: it takes the stroke colour even when the shape
      // was drawn with the outline switched off, which would otherwise mean
      // drawing nothing at all.
      ctx.strokeStyle = shape.strokeColor;
      ctx.fillStyle = shape.strokeColor;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(shape.x0, shape.y0);
      ctx.lineTo(shape.x1, shape.y1);
      ctx.stroke();
      if (shape.kind === 'arrow') {
        var wings = arrowHead(shape.x0, shape.y0, shape.x1, shape.y1, shape.width);
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
   * Paints the picture and every mark on it. `scale` is the only difference
   * between what the dialog shows and what gets written to disk.
   */
  function paint(ctx, bitmap, shapes, scale) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, bitmap.naturalWidth, bitmap.naturalHeight);
    ctx.drawImage(bitmap, 0, 0, bitmap.naturalWidth, bitmap.naturalHeight);
    shapes.forEach(function (shape) { drawShape(ctx, bitmap, shape); });
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

    var state = {
      tool: 'blur',
      shapes: [],
      undone: [],
      scale: 1,
      // A stroke in pixels of a phone screenshot and the same number on a 4K
      // capture are not the same line, so the default follows the picture.
      style: {
        strokeColor: COLORS[0],
        fillColor: COLORS[0],
        stroke: true,
        fill: false,
        width: Math.max(2, Math.round(short * 0.006)),
        strength: 0.14
      }
    };

    var canvas = HE.el('canvas', { class: 'mark__canvas' });
    var stage = HE.el('div', { class: 'mark__stage' }, [canvas]);
    var ctx = canvas.getContext('2d');

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

      var live = pending ? state.shapes.concat([pending]) : state.shapes;
      paint(ctx, bitmap, live, state.scale * dpr);
      undoBtn.disabled = !state.shapes.length;
      redoBtn.disabled = !state.undone.length;
      count.textContent = state.shapes.length
        ? state.shapes.length + ' ' + HE.t('mark.marks', 'marks')
        : HE.t('mark.none', 'no marks yet');
    }

    /* -- the tools ------------------------------------------------------- */

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
      blur: '&#9925;', rect: '&#9633;', ellipse: '&#9711;',
      line: '&#8725;', arrow: '&#8599;'
    };

    var toolButtons = TOOLS.map(function (kind) {
      var btn = tool(bar, HE.t('mark.tool.' + kind, kind), TOOL_ICONS[kind], function () {
        state.tool = kind;
        markTool();
      });
      btn.dataset.tool = kind;
      return btn;
    });
    function markTool() {
      toolButtons.forEach(function (btn) {
        btn.classList.toggle('is-active', btn.dataset.tool === state.tool);
      });
      styleRow.dataset.tool = state.tool;
    }

    bar.appendChild(HE.el('span', { class: 'floatbar__sep' }));

    var undoBtn = tool(bar, HE.t('mark.undo', 'Undo the last mark'), '&#8630;', function () {
      if (!state.shapes.length) { return; }
      state.undone.push(state.shapes.pop());
      draw();
    });
    var redoBtn = tool(bar, HE.t('mark.redo', 'Put it back'), '&#8631;', function () {
      if (!state.undone.length) { return; }
      state.shapes.push(state.undone.pop());
      draw();
    });
    bar.appendChild(HE.el('span', { class: 'mark__spacer' }));
    tool(bar, HE.t('mark.clear', 'Take every mark off'), HE.t('mark.clearLabel', 'Clear'), function () {
      if (!state.shapes.length) { return; }
      state.undone = state.shapes.slice().reverse().concat(state.undone);
      state.shapes = [];
      draw();
    });

    /* -- the style of what gets drawn ------------------------------------ */

    /*
     * Changing a colour, the thickness or the fill also reaches the mark drawn
     * last: you draw the box, see that you wanted it filled, and say so right
     * there instead of undoing it and drawing it again with the option set.
     */
    function restyle(change) {
      change(state.style);
      var last = state.shapes[state.shapes.length - 1];
      if (last) {
        change(last);
        // Every mark carries its own copy of the style, so a later change to
        // the defaults leaves the older marks alone.
      }
      draw();
    }

    function swatches(current, onPick) {
      var host = HE.el('div', { class: 'mark__swatches' });
      COLORS.forEach(function (color) {
        var dot = HE.el('button', {
          class: 'mark__swatch', type: 'button', title: color,
          style: 'background:' + color
        });
        dot.addEventListener('click', function () {
          onPick(color);
          host.querySelectorAll('.mark__swatch').forEach(function (other) {
            other.classList.toggle('is-active', other === dot);
          });
          picker.value = color;
        });
        if (color === current) { dot.classList.add('is-active'); }
        host.appendChild(dot);
      });
      var picker = HE.el('input', { class: 'mark__picker', type: 'color', value: current });
      picker.addEventListener('input', function () {
        onPick(picker.value);
        host.querySelectorAll('.mark__swatch').forEach(function (other) {
          other.classList.remove('is-active');
        });
      });
      host.appendChild(picker);
      return host;
    }

    var strokeOn = HE.el('input', { type: 'checkbox' });
    strokeOn.checked = state.style.stroke;
    strokeOn.addEventListener('change', function () {
      restyle(function (target) { target.stroke = strokeOn.checked; });
    });

    var fillOn = HE.el('input', { type: 'checkbox' });
    fillOn.checked = state.style.fill;
    fillOn.addEventListener('change', function () {
      restyle(function (target) { target.fill = fillOn.checked; });
    });

    var widthInput = HE.el('input', {
      class: 'mark__slider', type: 'range', min: '1',
      max: String(Math.max(24, Math.round(short * 0.05))), step: '1',
      value: String(state.style.width)
    });
    var widthLabel = HE.el('span', { class: 'mark__number', text: state.style.width + ' px' });
    widthInput.addEventListener('input', function () {
      var value = parseInt(widthInput.value, 10) || 1;
      widthLabel.textContent = value + ' px';
      restyle(function (target) { target.width = value; });
    });

    var strengthInput = HE.el('input', {
      class: 'mark__slider', type: 'range', min: '4', max: '40', step: '1',
      value: String(Math.round(state.style.strength * 100))
    });
    var strengthLabel = HE.el('span', { class: 'mark__number', text: HE.t('mark.strong', 'strong') });
    strengthInput.addEventListener('input', function () {
      var value = (parseInt(strengthInput.value, 10) || 14) / 100;
      strengthLabel.textContent = value < 0.1
        ? HE.t('mark.light', 'light')
        : (value < 0.25 ? HE.t('mark.strong', 'strong') : HE.t('mark.total', 'unreadable'));
      restyle(function (target) { target.strength = value; });
    });

    var styleRow = HE.el('div', { class: 'mark__style' }, [
      // The outline can be switched off on a closed shape; on a line it IS the
      // shape, so the toggle only shows where switching it off means something.
      HE.el('label', { class: 'mark__toggle mark__only--box' }, [
        strokeOn, HE.el('span', { text: HE.t('mark.stroke', 'Outline') })
      ]),
      // On a line the "Outline" toggle is gone, and a row of colours with
      // nothing in front of it does not say what it colours.
      HE.el('span', { class: 'mark__label mark__only--line', text: HE.t('mark.color', 'Colour') }),
      HE.el('div', { class: 'mark__only--shape' }, [
        swatches(state.style.strokeColor, function (color) {
          restyle(function (target) { target.strokeColor = color; });
        })
      ]),
      HE.el('label', { class: 'mark__toggle mark__only--box' }, [
        fillOn, HE.el('span', { text: HE.t('mark.fill', 'Fill') })
      ]),
      HE.el('div', { class: 'mark__only--box' }, [
        swatches(state.style.fillColor, function (color) {
          restyle(function (target) { target.fillColor = color; });
        })
      ]),
      HE.el('div', { class: 'mark__field mark__only--shape' }, [
        HE.el('span', { class: 'mark__label', text: HE.t('mark.width', 'Thickness') }),
        widthInput, widthLabel
      ]),
      HE.el('div', { class: 'mark__field mark__only--blur' }, [
        HE.el('span', { class: 'mark__label', text: HE.t('mark.strength', 'Blur') }),
        strengthInput, strengthLabel
      ])
    ]);
    markTool();

    /* -- drawing on the picture ------------------------------------------ */

    var pending = null;
    var origin = null;

    function pointIn(event) {
      var rect = stage.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / state.scale,
        y: (event.clientY - rect.top) / state.scale
      };
    }

    function newShape(at) {
      return {
        kind: state.tool, x0: at.x, y0: at.y, x1: at.x, y1: at.y,
        strokeColor: state.style.strokeColor, fillColor: state.style.fillColor,
        stroke: state.style.stroke, fill: state.style.fill,
        width: state.style.width, strength: state.style.strength
      };
    }

    stage.addEventListener('mousedown', function (event) {
      event.preventDefault();
      origin = pointIn(event);
      pending = newShape(origin);
      document.addEventListener('mousemove', onDraw);
      document.addEventListener('mouseup', endDraw);
    });

    function onDraw(event) {
      if (!pending) { return; }
      var at = pointIn(event);
      // A box or a blur drawn with Shift comes out square; a line or an arrow
      // snaps to the nearest eighth of a turn.
      if (event.shiftKey) {
        if (pending.kind === 'line' || pending.kind === 'arrow') {
          var angle = Math.atan2(at.y - origin.y, at.x - origin.x);
          var step = Math.PI / 4;
          var snapped = Math.round(angle / step) * step;
          var len = Math.hypot(at.x - origin.x, at.y - origin.y);
          at = { x: origin.x + Math.cos(snapped) * len, y: origin.y + Math.sin(snapped) * len };
        } else {
          var side = Math.max(Math.abs(at.x - origin.x), Math.abs(at.y - origin.y));
          at = {
            x: origin.x + (at.x < origin.x ? -side : side),
            y: origin.y + (at.y < origin.y ? -side : side)
          };
        }
      }
      pending.x1 = Math.max(0, Math.min(natural.w, at.x));
      pending.y1 = Math.max(0, Math.min(natural.h, at.y));
      draw();
    }

    function endDraw() {
      document.removeEventListener('mousemove', onDraw);
      document.removeEventListener('mouseup', endDraw);
      if (!pending) { return; }
      var box = boxOf(pending);
      var long = Math.hypot(pending.x1 - pending.x0, pending.y1 - pending.y0);
      // A click that drew nothing is a click, not a mark of zero size.
      var drawn = (pending.kind === 'line' || pending.kind === 'arrow')
        ? long >= MIN_SIZE
        : box.w >= MIN_SIZE && box.h >= MIN_SIZE;
      if (drawn) {
        state.shapes.push(pending);
        state.undone = [];
      }
      pending = null;
      draw();
    }

    function onKey(event) {
      if (!(event.ctrlKey || event.metaKey)) { return; }
      var key = event.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); event.stopPropagation(); undoBtn.click(); }
      else if (key === 'y') { event.preventDefault(); event.stopPropagation(); redoBtn.click(); }
    }
    document.addEventListener('keydown', onKey, true);

    /* -- the modal -------------------------------------------------------- */

    var count = HE.el('span', { class: 'mark__count', text: '' });

    var body = HE.el('div', { class: 'mark' }, [
      bar,
      styleRow,
      HE.el('div', { class: 'mark__stage-wrap' }, [stage]),
      HE.el('div', { class: 'mark__foot' }, [
        count,
        HE.el('span', { class: 'mark__hint', text: HE.t('mark.hint', 'Drag over the picture to draw. The original file is kept: the marked copy is written next to it.') })
      ])
    ]);

    var dialog = HE.modal({
      title: HE.t('mark.title', 'Annotate'),
      body: body,
      width: '760px',
      actions: [
        { label: HE.t('common.cancel'), onClick: function (close) { close(); } },
        {
          label: HE.t('mark.apply', 'Apply'), primary: true,
          onClick: function (close) {
            close();
            if (!state.shapes.length) { return; }
            apply(img, bitmap, state.shapes, mime);
          }
        }
      ],
      onClose: function () {
        document.removeEventListener('keydown', onKey, true);
        endDraw();
      }
    });
    dialog.card.classList.add('mark-modal');
    draw();
  }

  function apply(img, bitmap, shapes, mime) {
    var canvas = document.createElement('canvas');
    canvas.width = bitmap.naturalWidth;
    canvas.height = bitmap.naturalHeight;
    paint(canvas.getContext('2d'), bitmap, shapes, 1);
    HE.imagefile.write(img, canvas, mime, 'mark');
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
   *   .mark-modal        — the dialog, widened for the picture
   *   .mark__bar         — the tools, undo/redo and clear
   *   .mark__spacer      — pushes Clear to the far end of the bar
   *   .mark__style       — the row of colours, thickness and blur strength
   *   .mark__only--box   — shown for the tools that have a fill (box, ellipse)
   *   .mark__only--shape — shown for everything that is drawn rather than blurred
   *   .mark__only--blur  — shown only for the blur tool
   *   .mark__toggle      — an "Outline" / "Fill" checkbox
   *   .mark__swatches    — the eight colours plus the native picker
   *   .mark__swatch      — one of them
   *   .mark__picker      — the native colour input at the end of the row
   *   .mark__field       — a labelled slider
   *   .mark__label       — its name
   *   .mark__slider      — the slider itself
   *   .mark__number      — the value beside it
   *   .mark__stage-wrap  — the dark surface the picture sits on
   *   .mark__stage       — the picture at preview scale
   *   .mark__canvas      — the picture with its marks
   *   .mark__foot        — the mark count and the hint under the stage
   *   .mark__count       — how many marks are on the picture
   *   .mark__hint        — the sentence beside it
   */
})(window.HE);
