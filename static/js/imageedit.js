/*
 * imageedit.js — cropping, rotating and mirroring a picture that already lives
 * next to the document.
 *
 * The edit is baked into a new file rather than expressed as CSS. A
 * `transform: rotate()` with a clipping wrapper would leave the document with
 * markup nobody wrote on purpose, a box whose layout size no longer matches
 * what is drawn, and a picture that goes back to its old framing the moment the
 * file is opened somewhere that ignores the wrapper. Baking it keeps the HTML
 * as plain as it was — still one `<img src="photo.png">` — and the folder still
 * publishable as it stands.
 *
 * Which pictures can be touched, and what happens to the file that was there
 * before, is imagefile.js: this module only decides what gets painted.
 */
(function (HE) {
  'use strict';

  var MIN_CROP = 16;          // in pixels of the rotated image
  var STAGE_W = 620;
  var STAGE_H = 420;

  var RATIOS = [
    { key: 'free', label: null, value: null },
    { key: 'original', label: null, value: 'original' },
    { key: 'square', label: '1:1', value: 1 },
    { key: 'landscape', label: '4:3', value: 4 / 3 },
    { key: 'portrait', label: '3:4', value: 3 / 4 },
    { key: 'wide', label: '16:9', value: 16 / 9 }
  ];

  /* ---------------------------------------------------------- geometry ---- */

  function radians(state) {
    return (state.quarter * 90 + state.fine) * Math.PI / 180;
  }

  /** Bounding box of the rotated picture, in pixels of the original. */
  function frameSize(state) {
    var a = radians(state);
    var cos = Math.abs(Math.cos(a));
    var sin = Math.abs(Math.sin(a));
    var w = state.bitmap.naturalWidth;
    var h = state.bitmap.naturalHeight;
    return { w: w * cos + h * sin, h: w * sin + h * cos };
  }

  /** A point of the bounding box, back in the coordinates of the original. */
  function toSource(state, frame, x, y) {
    var a = radians(state);
    var dx = x - frame.w / 2;
    var dy = y - frame.h / 2;
    var cos = Math.cos(-a);
    var sin = Math.sin(-a);
    var u = dx * cos - dy * sin;
    var v = dx * sin + dy * cos;
    if (state.flipH) { u = -u; }
    if (state.flipV) { v = -v; }
    return { x: u + state.bitmap.naturalWidth / 2, y: v + state.bitmap.naturalHeight / 2 };
  }

  /**
   * True when the crop lies entirely on the picture. With a fine rotation the
   * bounding box has empty corners, and this is what keeps the frame from
   * wandering into them.
   */
  function fits(state, crop) {
    var frame = frameSize(state);
    var w = state.bitmap.naturalWidth;
    var h = state.bitmap.naturalHeight;
    // A fine rotation leaves half-transparent pixels along the edge, and the
    // margin keeps them out of the crop. A quarter turn lands on the pixel grid
    // and gets the whole picture, down to the rounding of the arithmetic.
    var margin = state.fine ? 1 : 0;
    var slack = 0.001;
    var corners = [
      [crop.x, crop.y], [crop.x + crop.w, crop.y],
      [crop.x + crop.w, crop.y + crop.h], [crop.x, crop.y + crop.h]
    ];
    return corners.every(function (point) {
      var p = toSource(state, frame, point[0], point[1]);
      return p.x >= margin - slack && p.y >= margin - slack &&
        p.x <= w - margin + slack && p.y <= h - margin + slack;
    });
  }

  /** Shrinks a crop around its centre until it fits, by bisection. */
  function shrinkToFit(state, crop) {
    if (fits(state, crop)) { return crop; }
    var cx = crop.x + crop.w / 2;
    var cy = crop.y + crop.h / 2;
    var low = 0;
    var high = 1;
    for (var i = 0; i < 24; i++) {
      var mid = (low + high) / 2;
      var candidate = {
        x: cx - crop.w * mid / 2, y: cy - crop.h * mid / 2,
        w: crop.w * mid, h: crop.h * mid
      };
      if (fits(state, candidate)) { low = mid; } else { high = mid; }
    }
    return {
      x: cx - crop.w * low / 2, y: cy - crop.h * low / 2,
      w: crop.w * low, h: crop.h * low
    };
  }

  /** The largest crop of the wanted ratio, centred on the picture. */
  function fullCrop(state, ratio) {
    var frame = frameSize(state);
    var crop = { x: 0, y: 0, w: frame.w, h: frame.h };
    if (ratio) {
      if (frame.w / frame.h > ratio) {
        crop.w = frame.h * ratio;
        crop.h = frame.h;
      } else {
        crop.w = frame.w;
        crop.h = frame.w / ratio;
      }
      crop.x = (frame.w - crop.w) / 2;
      crop.y = (frame.h - crop.h) / 2;
    }
    return shrinkToFit(state, crop);
  }

  /** Paints the picture into a context whose unit is one pixel of the crop. */
  function paint(ctx, state, crop, scale, background) {
    var frame = frameSize(state);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, crop.w, crop.h);
    }
    ctx.translate(-crop.x, -crop.y);
    ctx.translate(frame.w / 2, frame.h / 2);
    ctx.rotate(radians(state));
    ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      state.bitmap,
      -state.bitmap.naturalWidth / 2, -state.bitmap.naturalHeight / 2,
      state.bitmap.naturalWidth, state.bitmap.naturalHeight
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ------------------------------------------------------------ rendering -- */

  function render(ui, state) {
    var frame = frameSize(state);
    var scale = Math.min(STAGE_W / frame.w, STAGE_H / frame.h, 1);
    var width = Math.round(frame.w * scale);
    var height = Math.round(frame.h * scale);
    state.scale = width / frame.w;

    var ratio = window.devicePixelRatio || 1;
    ui.canvas.width = Math.round(width * ratio);
    ui.canvas.height = Math.round(height * ratio);
    ui.canvas.style.width = width + 'px';
    ui.canvas.style.height = height + 'px';
    paint(ui.canvas.getContext('2d'), state, { x: 0, y: 0, w: frame.w, h: frame.h },
      state.scale * ratio, null);

    ui.stage.style.width = width + 'px';
    ui.stage.style.height = height + 'px';

    var crop = state.crop;
    ui.frame.style.left = Math.round(crop.x * state.scale) + 'px';
    ui.frame.style.top = Math.round(crop.y * state.scale) + 'px';
    ui.frame.style.width = Math.round(crop.w * state.scale) + 'px';
    ui.frame.style.height = Math.round(crop.h * state.scale) + 'px';
    ui.size.textContent = Math.round(crop.w) + ' × ' + Math.round(crop.h) + ' px';
    ui.fineLabel.textContent = (state.fine > 0 ? '+' : '') + state.fine.toFixed(1) + '°';
  }

  /* ----------------------------------------------------------- the dialog -- */

  function open(img) {
    HE.imagefile.open(img, open).then(function (source) {
      if (!source) { return; }
      openWith(source.bitmap, source.mime, {
        onApply: function (canvas) { HE.imagefile.write(img, canvas, source.mime, 'crop'); }
      });
    });
  }

  /**
   * The dialog itself, over a bitmap that may not be in the document yet.
   * `options` = {title, applyLabel, cancelLabel, hint, onApply(canvas),
   * onCancel()}; what becomes of the canvas is the caller's business.
   */
  function openWith(bitmap, mime, options) {
    var state = {
      bitmap: bitmap, quarter: 0, fine: 0, flipH: false, flipV: false,
      ratio: null, scale: 1, crop: null
    };
    state.crop = fullCrop(state, null);

    var canvas = HE.el('canvas', { class: 'crop__canvas' });
    var cropFrame = HE.el('div', { class: 'crop__frame' });
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
      cropFrame.appendChild(HE.el('span', {
        class: 'crop__grip crop__grip--' + dir, 'data-dir': dir
      }));
    });
    cropFrame.appendChild(HE.el('span', { class: 'crop__thirds' }));
    var stage = HE.el('div', { class: 'crop__stage' }, [canvas, cropFrame]);

    var fine = HE.el('input', {
      class: 'crop__slider', type: 'range', min: '-45', max: '45', step: '0.5', value: '0'
    });
    var fineLabel = HE.el('span', { class: 'crop__degrees', text: '0.0°' });
    var size = HE.el('span', { class: 'crop__size', text: '' });

    var ui = { canvas: canvas, frame: cropFrame, stage: stage, size: size, fineLabel: fineLabel };
    var draw = function () { render(ui, state); };

    /* -- the toolbar ---------------------------------------------------- */

    function tool(bar, title, label, onClick) {
      var btn = HE.el('button', {
        class: 'btn btn--tool btn--sm', type: 'button', title: title, html: label
      });
      btn.addEventListener('click', function (event) { event.preventDefault(); onClick(); });
      bar.appendChild(btn);
      return btn;
    }

    var bar = HE.el('div', { class: 'crop__bar' });

    tool(bar, HE.t('crop.rotateLeft', 'Rotate left'), '&#8634;', function () { turn(-1); });
    tool(bar, HE.t('crop.rotateRight', 'Rotate right'), '&#8635;', function () { turn(1); });
    tool(bar, HE.t('crop.flipH', 'Mirror horizontally'), '&#8646;', function () { mirror('flipH'); });
    tool(bar, HE.t('crop.flipV', 'Mirror vertically'), '&#8645;', function () { mirror('flipV'); });
    bar.appendChild(HE.el('span', { class: 'floatbar__sep' }));

    var ratioButtons = RATIOS.map(function (entry) {
      var name = HE.t('crop.ratio.' + entry.key, entry.key);
      var btn = tool(bar, HE.t('crop.ratioTitle', 'Proportion: ') + name,
        entry.label || name, function () {
          state.ratio = entry.value === 'original'
            ? bitmap.naturalWidth / bitmap.naturalHeight
            : entry.value;
          state.crop = fullCrop(state, state.ratio);
          markRatio();
          draw();
        });
      btn.classList.add('crop__ratio');
      btn.dataset.ratio = entry.key;
      return btn;
    });
    function markRatio() {
      var current = RATIOS.filter(function (entry) {
        var value = entry.value === 'original' ? bitmap.naturalWidth / bitmap.naturalHeight : entry.value;
        return value === state.ratio;
      })[0];
      ratioButtons.forEach(function (btn) {
        btn.classList.toggle('is-active', !!current && btn.dataset.ratio === current.key);
      });
    }
    markRatio();

    bar.appendChild(HE.el('span', { class: 'crop__spacer' }));
    tool(bar, HE.t('crop.reset', 'Undo every change'), HE.t('crop.resetLabel', 'Reset'), function () {
      state.quarter = 0; state.fine = 0; state.flipH = false; state.flipV = false;
      state.ratio = null;
      fine.value = '0';
      state.crop = fullCrop(state, null);
      markRatio();
      draw();
    });

    /* A quarter turn takes the crop with it, so what you had framed stays
       framed instead of jumping back to the whole picture. */
    function turn(direction) {
      var frame = frameSize(state);
      var crop = state.crop;
      state.quarter = (state.quarter + direction + 4) % 4;
      state.crop = direction > 0
        ? { x: frame.h - (crop.y + crop.h), y: crop.x, w: crop.h, h: crop.w }
        : { x: crop.y, y: frame.w - (crop.x + crop.w), w: crop.h, h: crop.w };
      if (state.ratio) { state.ratio = 1 / state.ratio; markRatio(); }
      draw();
    }

    function mirror(axis) {
      var frame = frameSize(state);
      state[axis] = !state[axis];
      // The mirror is applied before the rotation, so which side of the frame
      // the crop bounces off depends on how far the picture has been turned.
      var horizontal = (state.quarter % 2 === 0) === (axis === 'flipH');
      if (horizontal) { state.crop.x = frame.w - (state.crop.x + state.crop.w); }
      else { state.crop.y = frame.h - (state.crop.y + state.crop.h); }
      state.crop = shrinkToFit(state, state.crop);
      draw();
    }

    fine.addEventListener('input', function () {
      state.fine = parseFloat(fine.value) || 0;
      state.crop = shrinkToFit(state, state.crop);
      draw();
    });

    var fineRow = HE.el('div', { class: 'crop__fine' }, [
      HE.el('label', { class: 'crop__fine-label', text: HE.t('crop.straighten', 'Straighten') }),
      fine, fineLabel
    ]);

    /* -- dragging the frame --------------------------------------------- */

    var drag = null;

    function pointIn(event) {
      var rect = stage.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / state.scale,
        y: (event.clientY - rect.top) / state.scale
      };
    }

    function accept(crop) {
      if (crop.w < MIN_CROP || crop.h < MIN_CROP) { return; }
      if (!fits(state, crop)) { return; }
      state.crop = crop;
      draw();
    }

    stage.addEventListener('mousedown', function (event) {
      event.preventDefault();
      var dir = event.target.dataset ? event.target.dataset.dir : null;
      var start = pointIn(event);
      drag = {
        dir: dir || (cropFrame.contains(event.target) ? 'move' : 'new'),
        start: start,
        origin: { x: state.crop.x, y: state.crop.y, w: state.crop.w, h: state.crop.h }
      };
      // Starting outside the frame draws a new one from that corner: the old
      // rectangle is left alone until the pointer has actually moved.
      if (drag.dir === 'new') {
        drag.origin = { x: start.x, y: start.y, w: 0, h: 0 };
        drag.dir = 'se';
      }
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', endDrag);
    });

    function onDrag(event) {
      if (!drag) { return; }
      var point = pointIn(event);
      var dx = point.x - drag.start.x;
      var dy = point.y - drag.start.y;
      var origin = drag.origin;
      var crop;

      if (drag.dir === 'move') {
        crop = { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h };
      } else {
        var left = origin.x;
        var top = origin.y;
        var right = origin.x + origin.w;
        var bottom = origin.y + origin.h;
        if (drag.dir.indexOf('w') !== -1) { left = origin.x + dx; }
        if (drag.dir.indexOf('e') !== -1) { right = origin.x + origin.w + dx; }
        if (drag.dir.indexOf('n') !== -1) { top = origin.y + dy; }
        if (drag.dir.indexOf('s') !== -1) { bottom = origin.y + origin.h + dy; }
        crop = { x: Math.min(left, right), y: Math.min(top, bottom),
          w: Math.abs(right - left), h: Math.abs(bottom - top) };

        if (state.ratio) {
          // The corner opposite the one being dragged stays where it is while
          // the ratio decides the other two sides.
          if (drag.dir === 'n' || drag.dir === 's') { crop.w = crop.h * state.ratio; }
          else { crop.h = crop.w / state.ratio; }
          if (drag.dir.indexOf('w') !== -1) { crop.x = right - crop.w; }
          if (drag.dir.indexOf('n') !== -1) { crop.y = bottom - crop.h; }
        }
      }
      accept(crop);
    }

    function endDrag() {
      drag = null;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', endDrag);
    }

    /* -- the modal ------------------------------------------------------- */

    var body = HE.el('div', { class: 'crop' }, [
      bar,
      HE.el('div', { class: 'crop__stage-wrap' }, [stage]),
      fineRow,
      HE.el('div', { class: 'crop__foot' }, [
        size,
        HE.el('span', { class: 'crop__hint', text: options.hint ||
          HE.t('crop.hint', 'Drag inside the picture to frame it. The original file is kept: the result is written next to it.') })
      ])
    ]);

    // Closing the dialog any other way — the ✕, Escape, a click on the
    // backdrop — means the same as pressing the button that walks away, and
    // `onClose` runs on the way out of Apply too, so it has to know which one
    // it was.
    var settled = false;

    var dialog = HE.modal({
      title: options.title || HE.t('crop.title', 'Crop and rotate'),
      body: body,
      width: '720px',
      actions: [
        {
          label: options.cancelLabel || HE.t('common.cancel'),
          onClick: function (close) { close(); }
        },
        {
          label: options.applyLabel || HE.t('crop.apply', 'Apply'), primary: true,
          onClick: function (close) {
            settled = true;
            close();
            options.onApply(bake(state, mime));
          }
        }
      ],
      onClose: function () {
        endDrag();
        if (!settled) {
          settled = true;
          options.onCancel && options.onCancel();
        }
      }
    });
    dialog.card.classList.add('crop-modal');
    draw();
  }

  /* ------------------------------------------------------------ applying -- */

  /** Paints the framed part at full size, ready to become a file. */
  function bake(state, mime) {
    var crop = state.crop;
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.w));
    canvas.height = Math.max(1, Math.round(crop.h));

    // A JPEG has no transparency: what a fine rotation leaves empty in the
    // corners would come out black, so it is filled with white instead.
    paint(canvas.getContext('2d'), state, crop, 1, mime === 'image/jpeg' ? '#ffffff' : null);
    return canvas;
  }

  /**
   * Frames a picture the moment it is pasted, before it has a file or a place
   * in the document. Resolves with what should be stored: the framed part, or
   * the picture untouched when the dialog is dismissed — the paste itself was
   * never in question, only how much of it lands.
   */
  function cropPasted(file) {
    return HE.imagefile.read(file).then(function (source) {
      return new Promise(function (resolve) {
        openWith(source.bitmap, source.mime, {
          title: HE.t('crop.pasteTitle', 'Frame the pasted picture'),
          applyLabel: HE.t('crop.pasteApply', 'Paste the frame'),
          cancelLabel: HE.t('crop.pasteWhole', 'Paste it whole'),
          hint: HE.t('crop.pasteHint', 'Drag inside the picture to frame it. Only what is framed gets stored next to the document.'),
          onApply: function (canvas) {
            HE.imagefile.toBlob(canvas, source.mime)
              .then(resolve)
              .catch(function () { resolve(file); })
              .then(source.release);
          },
          onCancel: function () { source.release(); resolve(file); }
        });
      });
    }).catch(function () {
      // A picture the browser cannot decode is not a picture the dialog can
      // frame, and refusing the paste over it would be a poor trade.
      return file;
    });
  }

  /**
   * A quarter turn straight from the image bar: the common case deserves one
   * click, and the dialog is there for everything else.
   */
  function quickRotate(img, direction) {
    HE.imagefile.open(img, function (again) { quickRotate(again, direction); }).then(function (source) {
      if (!source) { return; }
      var state = {
        bitmap: source.bitmap, quarter: (direction + 4) % 4, fine: 0,
        flipH: false, flipV: false, ratio: null, scale: 1, crop: null
      };
      state.crop = fullCrop(state, null);
      HE.imagefile.write(img, bake(state, source.mime), source.mime, 'crop');
    });
  }

  HE.imageedit = {
    open: open,
    cropPasted: cropPasted,
    rotateLeft: function (img) { quickRotate(img, -1); },
    rotateRight: function (img) { quickRotate(img, 1); }
  };

  HE.registerContextProvider(function (element) {
    if (!element || element.tagName !== 'IMG') { return []; }
    return [{
      label: HE.t('crop.title', 'Crop and rotate') + '…',
      group: 'element',
      action: function () { open(element); }
    }];
  });

  /*
   * New CSS class names introduced by this module (for editor.css):
   *   .crop-modal        — the dialog, widened for the picture
   *   .crop__bar         — rotation, mirroring and aspect ratio buttons
   *   .crop__ratio       — one aspect ratio button
   *   .crop__spacer      — pushes Reset to the far end of the bar
   *   .crop__stage-wrap  — the dark surface the picture sits on
   *   .crop__stage       — the picture at preview scale, and the frame over it
   *   .crop__canvas      — the picture as it is being rotated
   *   .crop__frame       — the crop rectangle
   *   .crop__grip        — its eight handles
   *   .crop__thirds      — the rule-of-thirds guides inside the frame
   *   .crop__fine        — the straighten slider row
   *   .crop__degrees     — the angle next to it
   *   .crop__foot        — the resulting size and the hint under the stage
   */
})(window.HE);
