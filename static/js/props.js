/*
 * props.js — property & style inspector.
 *
 * Provides:
 *   HE.props.openElement(el)          element inspector modal (Style / Attributes / Classes / Content)
 *   HE.props.openStyles(el)           same modal, opened on the Style tab
 *   HE.props.openDocument()           document settings modal (Page / Page style / Head / Html)
 *   HE.props.buildStyleForm(el)       reusable friendly style form (DOM node)
 *   HE.props.buildAttributesTable(el) reusable attributes editor (DOM node)
 *
 * Everything that mutates the edited document goes through HE.edit() so the
 * change lands in the undo history. Text-ish controls also preview live on
 * "input" (without recording history) and commit on "change".
 */
(function (HE) {
  'use strict';

  if (!HE) { return; }

  var uid = 0;

  /* ------------------------------------------------------------ catalogues */

  var UNITS = ['px', 'rem', 'em', '%', 'vw', 'vh'];

  var FONT_STACKS = [
    { label: 'System UI', value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
    { label: 'Arial / Helvetica', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
    { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
    { label: 'Trebuchet MS', value: '"Trebuchet MS", "Lucida Grande", sans-serif' },
    { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
    { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
    { label: 'Garamond', value: 'Garamond, "Palatino Linotype", serif' },
    { label: 'Courier New', value: '"Courier New", Courier, monospace' },
    { label: 'Monospace', value: 'Menlo, Consolas, monospace' },
    { label: 'Cursive', value: 'cursive' },
    { label: 'Inherit', value: 'inherit' }
  ];

  var FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
  var TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];
  var TEXT_TRANSFORMS = ['none', 'uppercase', 'lowercase', 'capitalize'];
  var FONT_STYLES = ['normal', 'italic', 'oblique'];
  var TEXT_DECORATIONS = ['none', 'underline', 'line-through', 'overline'];
  var BG_REPEATS = ['repeat', 'no-repeat', 'repeat-x', 'repeat-y'];
  var BG_SIZES = ['auto', 'cover', 'contain'];
  var DISPLAYS = ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none'];
  var POSITIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky'];
  var FLOATS = ['none', 'left', 'right'];
  var OVERFLOWS = ['visible', 'hidden', 'auto', 'scroll'];
  var FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];
  var JUSTIFIES = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'];
  var ALIGNS = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'];
  var BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double'];
  var CURSORS = ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'crosshair', 'not-allowed'];

  var ATTR_SUGGESTIONS = {
    '*': ['id', 'class', 'title', 'style', 'lang', 'dir', 'hidden', 'tabindex'],
    a: ['href', 'target', 'rel', 'title', 'download', 'name'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    input: ['type', 'name', 'value', 'placeholder', 'required', 'disabled', 'checked'],
    button: ['type', 'name', 'value', 'disabled'],
    form: ['action', 'method', 'name', 'enctype', 'target'],
    label: ['for'],
    iframe: ['src', 'width', 'height', 'allow', 'loading'],
    video: ['src', 'controls', 'autoplay', 'loop', 'muted', 'poster', 'width', 'height'],
    audio: ['src', 'controls', 'autoplay', 'loop', 'muted'],
    td: ['colspan', 'rowspan', 'headers'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'type', 'reversed'],
    time: ['datetime'],
    meta: ['name', 'content', 'charset', 'property'],
    link: ['rel', 'href', 'type', 'media'],
    html: ['lang', 'dir']
  };

  var COMMON_TAGS = ['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption',
    'span', 'strong', 'em', 'code', 'small', 'mark', 'ul', 'ol', 'li', 'a', 'button'];

  var PARKED_SCRIPT_TYPE = 'text/x-html-editor-parked';

  /* -------------------------------------------------------------- helpers */

  function computedOf(el) {
    var win = el.ownerDocument && el.ownerDocument.defaultView;
    return win ? win.getComputedStyle(el) : null;
  }

  function inlineValue(el, prop) {
    return el.style.getPropertyValue(prop);
  }

  function computedValue(el, prop) {
    var c = computedOf(el);
    return c ? c.getPropertyValue(prop) : '';
  }

  /** Live preview: mutate without recording history (committed later). */
  function setStyleLive(el, prop, value) {
    if (HE.readOnly) { return; }
    if (value === '' || value === null || value === undefined) {
      el.style.removeProperty(prop);
    } else {
      el.style.setProperty(prop, value);
    }
    HE.refreshOverlays();
  }

  /** Definitive change, recorded in the undo history. */
  function setStyleCommit(el, prop, value) {
    HE.edit(function () {
      if (value === '' || value === null || value === undefined) {
        el.style.removeProperty(prop);
      } else {
        el.style.setProperty(prop, value);
      }
      if (!el.getAttribute('style')) { el.removeAttribute('style'); }
    });
  }

  /** Several style properties in one undo step. `map` = {prop: value|''}. */
  function setStylesCommit(el, map) {
    HE.edit(function () {
      Object.keys(map).forEach(function (prop) {
        var value = map[prop];
        if (value === '' || value === null || value === undefined) {
          el.style.removeProperty(prop);
        } else {
          el.style.setProperty(prop, value);
        }
      });
      if (!el.getAttribute('style')) { el.removeAttribute('style'); }
    });
  }

  /** Resolve any CSS colour to #rrggbb for the colour picker widget. */
  function cssColorToHex(color) {
    if (!color) { return ''; }
    var hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (hex) { return color.trim(); }
    var probe = document.createElement('span');
    probe.style.color = color;
    document.body.appendChild(probe);
    var rgb = window.getComputedStyle(probe).color;
    probe.remove();
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    if (!m) { return ''; }
    function two(n) { var s = (+n).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + two(m[1]) + two(m[2]) + two(m[3]);
  }

  function parseNumberUnit(value) {
    var m = /^(-?[\d.]+)(px|rem|em|%|vw|vh)?$/.exec((value || '').trim());
    return m ? { num: m[1], unit: m[2] || 'px' } : { num: '', unit: 'px' };
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) { return ''; }
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1048576) { return Math.round(bytes / 1024) + ' KB'; }
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* -------------------------------------------------------- field builders */

  function field(labelText, controls, extraClass) {
    var wrap = HE.el('div', { class: 'field' + (extraClass ? ' ' + extraClass : '') }, [
      HE.el('label', { class: 'field__label', text: labelText })
    ]);
    controls.forEach(function (c) { wrap.appendChild(c); });
    return wrap;
  }

  /** Free text field for one CSS property; computed value as placeholder. */
  function fieldText(el, prop, label) {
    var input = HE.el('input', {
      class: 'ctl field__control', type: 'text',
      placeholder: computedValue(el, prop)
    });
    input.value = inlineValue(el, prop);
    input.addEventListener('input', function () { setStyleLive(el, prop, input.value); });
    input.addEventListener('change', function () { setStyleCommit(el, prop, input.value); });
    return field(label, [input]);
  }

  /** Select for one CSS property. `options`: strings or {label, value}. */
  function fieldSelect(el, prop, label, options, onApply) {
    var sel = HE.el('select', { class: 'ctl ctl--select field__control' });
    sel.title = computedValue(el, prop);
    sel.appendChild(HE.el('option', { value: '', text: HE.t('common.default', 'Default') }));
    var current = inlineValue(el, prop);
    var found = false;
    options.forEach(function (opt) {
      var value = typeof opt === 'string' ? opt : opt.value;
      var text = typeof opt === 'string' ? opt : opt.label;
      if (value === current) { found = true; }
      sel.appendChild(HE.el('option', { value: value, text: text }));
    });
    if (current && !found) { sel.appendChild(HE.el('option', { value: current, text: current })); }
    sel.value = current;
    sel.addEventListener('change', function () {
      setStyleCommit(el, prop, sel.value);
      if (onApply) { onApply(sel.value); }
    });
    return field(label, [sel]);
  }

  /** Colour picker + free text (any CSS colour) for one property. */
  function fieldColor(el, prop, label) {
    var current = inlineValue(el, prop);
    var text = HE.el('input', {
      class: 'ctl field__control field-color__text', type: 'text',
      placeholder: computedValue(el, prop)
    });
    text.value = current;
    var picker = HE.el('input', { class: 'field-color__picker', type: 'color' });
    picker.value = cssColorToHex(current || computedValue(el, prop)) || '#000000';

    picker.addEventListener('input', function () {
      text.value = picker.value;
      setStyleLive(el, prop, picker.value);
    });
    picker.addEventListener('change', function () {
      text.value = picker.value;
      setStyleCommit(el, prop, picker.value);
    });
    text.addEventListener('input', function () { setStyleLive(el, prop, text.value); });
    text.addEventListener('change', function () {
      setStyleCommit(el, prop, text.value);
      var hex = cssColorToHex(text.value);
      if (hex) { picker.value = hex; }
    });
    var row = HE.el('div', { class: 'field-color field__row' }, [picker, text]);
    return field(label, [row]);
  }

  /** Number + unit selector (px/rem/em/%…) for one property. */
  function fieldNumberUnit(el, prop, label) {
    var parsed = parseNumberUnit(inlineValue(el, prop));
    var num = HE.el('input', {
      class: 'ctl field__control field-unit__num', type: 'number', step: 'any',
      placeholder: computedValue(el, prop)
    });
    num.value = parsed.num;
    var unit = HE.el('select', { class: 'ctl ctl--select field-unit__unit' });
    UNITS.forEach(function (u) { unit.appendChild(HE.el('option', { value: u, text: u })); });
    unit.value = parsed.unit;

    function value() { return num.value === '' ? '' : num.value + unit.value; }
    num.addEventListener('input', function () { setStyleLive(el, prop, value()); });
    num.addEventListener('change', function () { setStyleCommit(el, prop, value()); });
    unit.addEventListener('change', function () {
      if (num.value !== '') { setStyleCommit(el, prop, value()); }
    });
    var row = HE.el('div', { class: 'field-unit field__row' }, [num, unit]);
    return field(label, [row]);
  }

  /** Opacity-style slider with a reset button. */
  function fieldRange(el, prop, label, min, max, step) {
    var current = inlineValue(el, prop);
    var input = HE.el('input', { class: 'field-range__input', type: 'range', min: min, max: max, step: step });
    input.value = current || computedValue(el, prop) || max;
    var out = HE.el('span', { class: 'field-range__value', text: input.value });
    var reset = HE.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', text: '×',
      title: HE.t('props.reset', 'Reset')
    });
    input.addEventListener('input', function () {
      out.textContent = input.value;
      setStyleLive(el, prop, input.value);
    });
    input.addEventListener('change', function () { setStyleCommit(el, prop, input.value); });
    reset.addEventListener('click', function () {
      setStyleCommit(el, prop, '');
      input.value = computedValue(el, prop) || max;
      out.textContent = input.value;
    });
    var row = HE.el('div', { class: 'field-range field__row' }, [input, out, reset]);
    return field(label, [row]);
  }

  /** Compact 4-side control (margin/padding) with a "link all sides" toggle. */
  function fieldSides(el, base, label) {
    var sides = ['top', 'right', 'bottom', 'left'];
    var linked = false;
    var inputs = {};

    var link = HE.el('button', {
      class: 'props-sides__link btn btn--ghost btn--sm', type: 'button',
      'aria-pressed': 'false', text: '🔗',
      title: HE.t('props.linkSides', 'Link all sides')
    });
    link.addEventListener('click', function () {
      linked = !linked;
      link.setAttribute('aria-pressed', String(linked));
      link.classList.toggle('is-active', linked);
    });

    var grid = HE.el('div', { class: 'props-sides__grid' });
    sides.forEach(function (side) {
      var prop = base + '-' + side;
      var input = HE.el('input', {
        class: 'ctl props-sides__input', type: 'text',
        placeholder: computedValue(el, prop),
        title: label + ' ' + side
      });
      input.value = inlineValue(el, prop);
      inputs[side] = input;

      input.addEventListener('input', function () {
        if (linked) {
          sides.forEach(function (s) {
            inputs[s].value = input.value;
            setStyleLive(el, base + '-' + s, input.value);
          });
        } else {
          setStyleLive(el, prop, input.value);
        }
      });
      input.addEventListener('change', function () {
        var map = {};
        if (linked) {
          sides.forEach(function (s) { map[base + '-' + s] = input.value; });
        } else {
          map[prop] = input.value;
        }
        setStylesCommit(el, map);
      });
      grid.appendChild(input);
    });

    var row = HE.el('div', { class: 'props-sides field__row' }, [grid, link]);
    return field(label, [row], 'field--wide');
  }

  /** Border editor: width/style/colour with an "apply to side" selector. */
  function fieldBorder(el) {
    var sideSel = HE.el('select', { class: 'ctl ctl--select field__control' });
    [{ value: '', label: HE.t('props.allSides', 'All sides') },
     { value: 'top', label: 'top' }, { value: 'right', label: 'right' },
     { value: 'bottom', label: 'bottom' }, { value: 'left', label: 'left' }
    ].forEach(function (o) { sideSel.appendChild(HE.el('option', { value: o.value, text: o.label })); });

    var slot = HE.el('div', { class: 'props-border__slot' });

    function prefix() { return sideSel.value ? 'border-' + sideSel.value : 'border'; }

    function render() {
      slot.innerHTML = '';
      var p = prefix();
      slot.appendChild(fieldNumberUnit(el, p + '-width', HE.t('props.borderWidth', 'Width')));
      slot.appendChild(fieldSelect(el, p + '-style', HE.t('props.borderStyle', 'Style'), BORDER_STYLES));
      slot.appendChild(fieldColor(el, p + '-color', HE.t('props.borderColor', 'Colour')));
    }
    sideSel.addEventListener('change', render);
    render();

    var wrap = HE.el('div', { class: 'props-border field--wide' }, [
      field(HE.t('props.borderSide', 'Border on'), [sideSel]),
      slot
    ]);
    return wrap;
  }

  /** Simple box-shadow builder: x / y / blur / spread / colour. */
  function fieldShadow(el) {
    var existing = inlineValue(el, 'box-shadow');
    var m = /(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?(?:\s+(-?[\d.]+)px)?\s*(.*)/.exec(existing || '');
    var parts = {
      x: m ? m[1] : '', y: m ? m[2] : '',
      blur: (m && m[3]) || '', spread: (m && m[4]) || '',
      color: (m && m[5]) || ''
    };
    var inputs = {};
    var row = HE.el('div', { class: 'props-shadow field__row' });

    function value() {
      if (inputs.x.value === '' && inputs.y.value === '') { return ''; }
      return (inputs.x.value || 0) + 'px ' + (inputs.y.value || 0) + 'px ' +
        (inputs.blur.value || 0) + 'px ' + (inputs.spread.value || 0) + 'px ' +
        (inputs.color.value || 'rgba(0,0,0,.25)');
    }
    function commit() { setStyleCommit(el, 'box-shadow', value()); }

    [['x', 'X'], ['y', 'Y'], ['blur', HE.t('props.blur', 'Blur')], ['spread', HE.t('props.spread', 'Spread')]]
      .forEach(function (def) {
        var input = HE.el('input', {
          class: 'ctl props-shadow__num', type: 'number', step: 'any',
          placeholder: def[1], title: def[1]
        });
        input.value = parts[def[0]];
        input.addEventListener('input', function () { setStyleLive(el, 'box-shadow', value()); });
        input.addEventListener('change', commit);
        inputs[def[0]] = input;
        row.appendChild(input);
      });

    var color = HE.el('input', {
      class: 'ctl props-shadow__color', type: 'text',
      placeholder: HE.t('props.colour', 'Colour')
    });
    color.value = parts.color;
    color.addEventListener('change', commit);
    inputs.color = color;
    row.appendChild(color);

    var clear = HE.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', text: '×',
      title: HE.t('props.reset', 'Reset')
    });
    clear.addEventListener('click', function () {
      setStyleCommit(el, 'box-shadow', '');
      inputs.x.value = inputs.y.value = inputs.blur.value = inputs.spread.value = '';
      inputs.color.value = '';
    });
    row.appendChild(clear);

    return field(HE.t('props.shadow', 'Shadow'), [row], 'field--wide');
  }

  /** rotate() / scale() simple transform fields. */
  function fieldTransform(el) {
    var existing = inlineValue(el, 'transform');
    var rot = /rotate\((-?[\d.]+)deg\)/.exec(existing || '');
    var sc = /scale\(([\d.]+)\)/.exec(existing || '');

    var rotate = HE.el('input', { class: 'ctl props-transform__num', type: 'number', step: 'any', placeholder: '0' });
    rotate.value = rot ? rot[1] : '';
    var scale = HE.el('input', { class: 'ctl props-transform__num', type: 'number', step: 'any', placeholder: '1' });
    scale.value = sc ? sc[1] : '';

    function value() {
      var parts = [];
      if (rotate.value !== '') { parts.push('rotate(' + rotate.value + 'deg)'); }
      if (scale.value !== '') { parts.push('scale(' + scale.value + ')'); }
      return parts.join(' ');
    }
    [rotate, scale].forEach(function (input) {
      input.addEventListener('input', function () { setStyleLive(el, 'transform', value()); });
      input.addEventListener('change', function () { setStyleCommit(el, 'transform', value()); });
    });

    var row = HE.el('div', { class: 'props-transform field__row' }, [
      HE.el('span', { class: 'field__hint', text: HE.t('props.rotate', 'Rotate (deg)') }), rotate,
      HE.el('span', { class: 'field__hint', text: HE.t('props.scale', 'Scale') }), scale
    ]);
    return field(HE.t('props.transform', 'Transform'), [row], 'field--wide');
  }

  /* -------------------------------------------------- folder image picker */

  /**
   * "Choose file from the document folder" button + dropdown panel fed by
   * GET /api/folder ({images: [{name, url, size}]}). onPick(url) on click.
   */
  function folderPicker(onPick) {
    var btn = HE.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      text: HE.t('props.browseFolder', 'Choose…')
    });
    var panel = HE.el('div', { class: 'props-folder' });
    panel.hidden = true;
    var loaded = false;

    btn.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      if (panel.hidden || loaded) { return; }
      loaded = true;
      panel.appendChild(HE.el('span', { class: 'field__hint', text: HE.t('props.loading', 'Loading…') }));
      fetch('/api/folder').then(function (res) {
        return res.json();
      }).then(function (data) {
        panel.innerHTML = '';
        var images = (data && data.images) || [];
        if (!images.length) {
          panel.appendChild(HE.el('span', { class: 'field__hint', text: HE.t('props.noImages', 'No images in the document folder') }));
          return;
        }
        images.forEach(function (img) {
          var item = HE.el('button', { class: 'props-folder__item', type: 'button', title: img.name }, [
            HE.el('img', { class: 'props-folder__thumb', src: img.url, alt: '' }),
            HE.el('span', { class: 'props-folder__name', text: img.name }),
            HE.el('span', { class: 'props-folder__size', text: formatSize(img.size) })
          ]);
          item.addEventListener('click', function () {
            panel.hidden = true;
            onPick(img.url, img);
          });
          panel.appendChild(item);
        });
      }).catch(function (err) {
        panel.innerHTML = '';
        HE.toast(HE.t('props.folderFailed', 'Could not list the document folder: ') + err.message, 'error');
      });
    });

    return { button: btn, panel: panel };
  }

  /** Background image URL field with the folder picker attached. */
  function fieldBackgroundImage(el) {
    var raw = inlineValue(el, 'background-image');
    var m = /url\((['"]?)(.*?)\1\)/.exec(raw || '');
    var input = HE.el('input', {
      class: 'ctl field__control', type: 'text',
      placeholder: computedValue(el, 'background-image')
    });
    input.value = m ? m[2] : (raw === 'none' ? '' : raw || '');

    function value() { return input.value ? 'url("' + input.value.replace(/"/g, '%22') + '")' : ''; }
    input.addEventListener('change', function () { setStyleCommit(el, 'background-image', value()); });

    var picker = folderPicker(function (url) {
      input.value = url;
      setStyleCommit(el, 'background-image', value());
    });
    var row = HE.el('div', { class: 'field__row' }, [input, picker.button]);
    var wrap = field(HE.t('props.bgImage', 'Image URL'), [row, picker.panel], 'field--wide');
    return wrap;
  }

  /* ----------------------------------------------------- style form (tab 1) */

  function section(title, nodes) {
    return HE.el('section', { class: 'props-section' }, [
      HE.el('h3', { class: 'props-section__title', text: title }),
      HE.el('div', { class: 'props-grid' }, nodes)
    ]);
  }

  /**
   * The friendly style form. Reads inline styles (computed as hints), writes
   * back through HE.edit. Returned node exposes .refresh() to re-render.
   */
  HE.props = HE.props || {};

  HE.props.buildStyleForm = function (el) {
    var wrap = HE.el('div', { class: 'props-style' });

    function render() {
      wrap.innerHTML = '';

      /* Text */
      wrap.appendChild(section(HE.t('props.sec.text', 'Text'), [
        fieldSelect(el, 'font-family', HE.t('props.fontFamily', 'Font'), FONT_STACKS),
        fieldNumberUnit(el, 'font-size', HE.t('props.fontSize', 'Size')),
        fieldSelect(el, 'font-weight', HE.t('props.fontWeight', 'Weight'), FONT_WEIGHTS),
        fieldText(el, 'line-height', HE.t('props.lineHeight', 'Line height')),
        fieldNumberUnit(el, 'letter-spacing', HE.t('props.letterSpacing', 'Letter spacing')),
        fieldSelect(el, 'text-align', HE.t('props.textAlign', 'Align'), TEXT_ALIGNS),
        fieldSelect(el, 'text-transform', HE.t('props.textTransform', 'Case'), TEXT_TRANSFORMS),
        fieldSelect(el, 'font-style', HE.t('props.fontStyle', 'Style'), FONT_STYLES),
        fieldSelect(el, 'text-decoration', HE.t('props.textDecoration', 'Decoration'), TEXT_DECORATIONS),
        fieldColor(el, 'color', HE.t('props.textColour', 'Colour'))
      ]));

      /* Background */
      wrap.appendChild(section(HE.t('props.sec.background', 'Background'), [
        fieldColor(el, 'background-color', HE.t('props.bgColour', 'Colour')),
        fieldBackgroundImage(el),
        fieldSelect(el, 'background-repeat', HE.t('props.bgRepeat', 'Repeat'), BG_REPEATS),
        fieldSelect(el, 'background-size', HE.t('props.bgSize', 'Size'), BG_SIZES),
        fieldText(el, 'background-position', HE.t('props.bgPosition', 'Position'))
      ]));

      /* Box */
      wrap.appendChild(section(HE.t('props.sec.box', 'Box'), [
        fieldNumberUnit(el, 'width', HE.t('props.width', 'Width')),
        fieldNumberUnit(el, 'height', HE.t('props.height', 'Height')),
        fieldNumberUnit(el, 'max-width', HE.t('props.maxWidth', 'Max width')),
        fieldNumberUnit(el, 'min-height', HE.t('props.minHeight', 'Min height')),
        fieldSides(el, 'margin', HE.t('props.margin', 'Margin')),
        fieldSides(el, 'padding', HE.t('props.padding', 'Padding')),
        fieldBorder(el),
        fieldNumberUnit(el, 'border-radius', HE.t('props.borderRadius', 'Corner radius')),
        fieldShadow(el)
      ]));

      /* Layout */
      var flexBox = HE.el('div', { class: 'props-flex props-grid' }, [
        fieldSelect(el, 'flex-direction', HE.t('props.flexDirection', 'Direction'), FLEX_DIRECTIONS),
        fieldSelect(el, 'justify-content', HE.t('props.justify', 'Justify'), JUSTIFIES),
        fieldSelect(el, 'align-items', HE.t('props.alignItems', 'Align items'), ALIGNS),
        fieldNumberUnit(el, 'gap', HE.t('props.gap', 'Gap'))
      ]);
      var offsets = HE.el('div', { class: 'props-offsets props-grid' }, [
        fieldText(el, 'top', 'Top'),
        fieldText(el, 'right', 'Right'),
        fieldText(el, 'bottom', 'Bottom'),
        fieldText(el, 'left', 'Left')
      ]);
      function syncFlex() {
        var display = inlineValue(el, 'display') || computedValue(el, 'display');
        flexBox.hidden = !(display === 'flex' || display === 'inline-flex');
      }
      function syncOffsets() {
        var position = inlineValue(el, 'position') || computedValue(el, 'position');
        offsets.hidden = (!position || position === 'static');
      }
      syncFlex();
      syncOffsets();

      var layout = section(HE.t('props.sec.layout', 'Layout'), [
        fieldSelect(el, 'display', HE.t('props.display', 'Display'), DISPLAYS, syncFlex),
        fieldSelect(el, 'position', HE.t('props.position', 'Position'), POSITIONS, syncOffsets),
        fieldSelect(el, 'float', HE.t('props.float', 'Float'), FLOATS),
        fieldSelect(el, 'overflow', HE.t('props.overflow', 'Overflow'), OVERFLOWS)
      ]);
      layout.appendChild(offsets);
      layout.appendChild(flexBox);
      wrap.appendChild(layout);

      /* Effects */
      wrap.appendChild(section(HE.t('props.sec.effects', 'Effects'), [
        fieldRange(el, 'opacity', HE.t('props.opacity', 'Opacity'), 0, 1, 0.01),
        fieldTransform(el),
        fieldSelect(el, 'cursor', HE.t('props.cursor', 'Cursor'), CURSORS)
      ]));

      /* Clear all inline styles */
      var clear = HE.el('button', {
        class: 'btn btn--ghost props-style__clear', type: 'button',
        text: HE.t('props.clearStyles', 'Clear inline styles')
      });
      clear.addEventListener('click', function () {
        HE.edit(function () { el.removeAttribute('style'); });
        render();
      });
      wrap.appendChild(clear);
    }

    render();
    wrap.refresh = render;
    return wrap;
  };

  /* ------------------------------------------------- attributes table (tab 2) */

  function isHiddenAttr(name) {
    return name.indexOf('data-he-') === 0 ||
      name.indexOf('data-html-editor') === 0 ||
      name === 'contenteditable' || name === 'spellcheck';
  }

  function suggestionsFor(element) {
    var tag = element.tagName.toLowerCase();
    var generic = ATTR_SUGGESTIONS['*'];
    var specific = ATTR_SUGGESTIONS[tag] || [];
    return specific.concat(generic.filter(function (a) { return specific.indexOf(a) < 0; }));
  }

  HE.props.buildAttributesTable = function (element) {
    var wrap = HE.el('div', { class: 'props-attrs' });
    var listId = 'props-attr-suggest-' + (++uid);
    var datalist = HE.el('datalist', { id: listId });
    suggestionsFor(element).forEach(function (name) {
      datalist.appendChild(HE.el('option', { value: name }));
    });
    wrap.appendChild(datalist);

    var rows = HE.el('div', { class: 'props-attrs__rows' });
    wrap.appendChild(rows);

    function attrRow(name, value) {
      var nameInput = HE.el('input', { class: 'ctl props-attrs__name', type: 'text', list: listId });
      nameInput.value = name;
      var valueInput = HE.el('input', { class: 'ctl props-attrs__value', type: 'text' });
      valueInput.value = value;
      var remove = HE.el('button', {
        class: 'btn btn--ghost btn--sm props-attrs__remove', type: 'button', text: '×',
        title: HE.t('props.remove', 'Remove')
      });
      var row = HE.el('div', { class: 'props-attrs__row' }, [nameInput, valueInput, remove]);
      var currentName = name;

      nameInput.addEventListener('change', function () {
        var next = nameInput.value.trim();
        if (!next || next === currentName) { nameInput.value = currentName; return; }
        try {
          HE.edit(function () {
            element.removeAttribute(currentName);
            element.setAttribute(next, valueInput.value);
          });
          currentName = next;
        } catch (err) {
          HE.toast(HE.t('props.badAttr', 'Invalid attribute name: ') + next, 'error');
          nameInput.value = currentName;
        }
      });
      valueInput.addEventListener('change', function () {
        HE.edit(function () { element.setAttribute(currentName, valueInput.value); });
      });
      remove.addEventListener('click', function () {
        HE.edit(function () { element.removeAttribute(currentName); });
        row.remove();
      });
      return row;
    }

    Array.prototype.slice.call(element.attributes).forEach(function (attr) {
      if (isHiddenAttr(attr.name)) { return; }
      rows.appendChild(attrRow(attr.name, attr.value));
    });

    /* Add-attribute row */
    var addName = HE.el('input', {
      class: 'ctl props-attrs__name', type: 'text', list: listId,
      placeholder: HE.t('props.name', 'Name')
    });
    var addValue = HE.el('input', {
      class: 'ctl props-attrs__value', type: 'text',
      placeholder: HE.t('props.value', 'Value')
    });
    var addBtn = HE.el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      text: HE.t('props.add', 'Add attribute')
    });
    function addAttribute() {
      var name = addName.value.trim();
      if (!name) { return; }
      if (isHiddenAttr(name)) {
        HE.toast(HE.t('props.reserved', 'That attribute is managed by the editor'), 'warn');
        return;
      }
      try {
        HE.edit(function () { element.setAttribute(name, addValue.value); });
      } catch (err) {
        HE.toast(HE.t('props.badAttr', 'Invalid attribute name: ') + name, 'error');
        return;
      }
      rows.appendChild(attrRow(name, addValue.value));
      addName.value = '';
      addValue.value = '';
      addName.focus();
    }
    addBtn.addEventListener('click', addAttribute);
    addValue.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addAttribute(); }
    });
    wrap.appendChild(HE.el('div', { class: 'props-attrs__row props-attrs__addrow' }, [addName, addValue, addBtn]));

    return wrap;
  };

  /* ---------------------------------------------- classes & id tab (tab 3) */

  function matchingRules(el) {
    var out = [];
    var sheets = el.ownerDocument.styleSheets;
    function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.type === 1) { // CSSStyleRule
          try {
            if (el.matches(rule.selectorText)) {
              out.push({ selector: rule.selectorText, css: rule.style.cssText });
            }
          } catch (err) { /* unparseable selector for matches() */ }
        } else if (rule.cssRules) { // @media, @supports…
          walk(rule.cssRules);
        }
      }
    }
    for (var s = 0; s < sheets.length; s++) {
      var sheet = sheets[s];
      var owner = sheet.ownerNode;
      if (owner && owner.getAttribute && owner.getAttribute('data-html-editor-ui')) { continue; }
      var rules;
      try { rules = sheet.cssRules; } catch (err) { continue; } // cross-origin
      if (rules) { walk(rules); }
    }
    return out;
  }

  function buildClassesTab(el) {
    var wrap = HE.el('div', { class: 'props-classes' });

    /* id */
    var idInput = HE.el('input', { class: 'ctl field__control', type: 'text' });
    idInput.value = el.id || '';
    idInput.addEventListener('change', function () {
      HE.edit(function () {
        if (idInput.value.trim()) { el.setAttribute('id', idInput.value.trim()); }
        else { el.removeAttribute('id'); }
      });
    });
    wrap.appendChild(field('id', [idInput]));

    /* class chips */
    var chips = HE.el('div', { class: 'props-chips' });
    function renderChips() {
      chips.innerHTML = '';
      Array.prototype.slice.call(el.classList).forEach(function (cls) {
        if (cls.indexOf('he-') === 0) { return; } // editor bookkeeping classes
        var remove = HE.el('button', { class: 'props-chip__remove', type: 'button', text: '×' });
        remove.addEventListener('click', function () {
          HE.edit(function () {
            el.classList.remove(cls);
            if (!el.getAttribute('class')) { el.removeAttribute('class'); }
          });
          renderChips();
        });
        chips.appendChild(HE.el('span', { class: 'props-chip' }, [
          HE.el('span', { class: 'props-chip__label', text: cls }), remove
        ]));
      });
    }
    renderChips();

    var addInput = HE.el('input', {
      class: 'ctl', type: 'text',
      placeholder: HE.t('props.addClass', 'Add a class…')
    });
    var addBtn = HE.el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '+' });
    function addClass() {
      var cls = addInput.value.trim().replace(/\s+/g, '-');
      if (!cls || cls.indexOf('he-') === 0) { return; }
      HE.edit(function () { el.classList.add(cls); });
      addInput.value = '';
      renderChips();
    }
    addBtn.addEventListener('click', addClass);
    addInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addClass(); }
    });
    wrap.appendChild(field(HE.t('props.classes', 'Classes'), [
      chips,
      HE.el('div', { class: 'field__row' }, [addInput, addBtn])
    ], 'field--wide'));

    /* matching CSS rules (read only) */
    var rulesWrap = HE.el('div', { class: 'props-rules' }, [
      HE.el('h3', { class: 'props-section__title', text: HE.t('props.matchedRules', 'CSS rules that apply') })
    ]);
    var rules = matchingRules(el);
    if (!rules.length) {
      rulesWrap.appendChild(HE.el('p', { class: 'field__hint', text: HE.t('props.noRules', 'No document stylesheet rules match this element.') }));
    } else {
      rules.forEach(function (rule) {
        var css = rule.css.length > 220 ? rule.css.slice(0, 220) + '…' : rule.css;
        rulesWrap.appendChild(HE.el('div', { class: 'props-rules__item' }, [
          HE.el('code', { class: 'props-rules__selector', text: rule.selector }),
          HE.el('span', { class: 'props-rules__css', text: css })
        ]));
      });
    }
    wrap.appendChild(rulesWrap);

    return wrap;
  }

  /* --------------------------------------------------- content tab (tab 4) */

  function changeTag(el, tagName) {
    var doc = el.ownerDocument;
    var next = doc.createElement(tagName);
    Array.prototype.slice.call(el.attributes).forEach(function (attr) {
      next.setAttribute(attr.name, attr.value);
    });
    while (el.firstChild) { next.appendChild(el.firstChild); }
    el.parentNode.replaceChild(next, el);
    return next;
  }

  function buildContentTab(el, reopenAt) {
    var wrap = HE.el('div', { class: 'props-content' });
    var tag = el.tagName.toLowerCase();

    /* tag name + "change tag to…" */
    var tagRow = HE.el('div', { class: 'field__row' }, [
      HE.el('code', { class: 'props-content__tag', text: '<' + tag + '>' })
    ]);
    if (tag !== 'body' && tag !== 'html' && tag !== 'head') {
      var tagSel = HE.el('select', { class: 'ctl ctl--select' });
      tagSel.appendChild(HE.el('option', { value: '', text: HE.t('props.changeTag', 'Change tag to…') }));
      COMMON_TAGS.forEach(function (t) {
        if (t !== tag) { tagSel.appendChild(HE.el('option', { value: t, text: '<' + t + '>' })); }
      });
      tagSel.addEventListener('change', function () {
        if (!tagSel.value) { return; }
        var next = HE.edit(function () { return changeTag(el, tagSel.value); });
        if (next) {
          HE.select(next);
          reopenAt(next, 3); // rebuild the inspector around the new element
        }
      });
      tagRow.appendChild(tagSel);
    }
    wrap.appendChild(field(HE.t('props.tag', 'Tag'), [tagRow]));

    /* innerHTML */
    var ta = HE.el('textarea', { class: 'props-content__html', rows: '12', spellcheck: 'false' });
    ta.value = el.innerHTML;
    var apply = HE.el('button', {
      class: 'btn btn--primary', type: 'button',
      text: HE.t('props.apply', 'Apply')
    });
    apply.addEventListener('click', function () {
      HE.edit(function () { el.innerHTML = ta.value; });
      HE.toast(HE.t('props.contentApplied', 'Content applied'), 'ok');
    });
    wrap.appendChild(field(HE.t('props.content', 'Content (HTML)'), [ta, apply], 'field--wide'));

    return wrap;
  }

  /* --------------------------------------------------------- tabs + modal */

  function buildTabs(defs, startIndex) {
    var root = HE.el('div', { class: 'props-tabs' });
    var bar = HE.el('div', { class: 'props-tabs__bar', role: 'tablist' });
    var panels = HE.el('div', { class: 'props-tabs__panels' });
    root.appendChild(bar);
    root.appendChild(panels);

    var tabs = [];
    var built = [];

    defs.forEach(function (def, i) {
      var tab = HE.el('button', { class: 'props-tabs__tab', type: 'button', role: 'tab', text: def.label });
      tab.addEventListener('click', function () { select(i); });
      bar.appendChild(tab);
      tabs.push(tab);
      built.push(null);
    });

    function select(index) {
      tabs.forEach(function (tab, i) { tab.classList.toggle('is-active', i === index); });
      if (!built[index]) {
        built[index] = HE.el('div', { class: 'props-tabs__panel', role: 'tabpanel' });
        built[index].appendChild(defs[index].build());
        panels.appendChild(built[index]);
      }
      built.forEach(function (panel, i) { if (panel) { panel.hidden = i !== index; } });
    }

    select(startIndex || 0);
    return root;
  }

  /** Cheap drag: the modal follows the pointer while the header is held. */
  function makeDraggable(card) {
    var head = card.querySelector('.modal__head');
    if (!head) { return; }
    var dx = 0, dy = 0;
    head.style.cursor = 'move';
    head.addEventListener('mousedown', function (event) {
      if (event.target.closest('button, input, select, textarea')) { return; }
      var sx = event.clientX - dx;
      var sy = event.clientY - dy;
      function move(ev) {
        dx = ev.clientX - sx;
        dy = ev.clientY - sy;
        card.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      event.preventDefault();
    });
  }

  /* ------------------------------------------------------ element inspector */

  function openElementAt(el, tabIndex) {
    if (!el || el.nodeType !== 1) { return; }

    var tabs = buildTabs([
      { label: HE.t('props.tab.style', 'Style'), build: function () { return HE.props.buildStyleForm(el); } },
      { label: HE.t('props.attributes', 'Attributes'), build: function () { return HE.props.buildAttributesTable(el); } },
      { label: HE.t('props.tab.classes', 'Classes & id'), build: function () { return buildClassesTab(el); } },
      { label: HE.t('props.tab.content', 'Content'), build: function () { return buildContentTab(el, openElementAt); } }
    ], tabIndex || 0);

    var modal = HE.modal({
      title: HE.t('props.title', 'Properties of ') + HE.describe(el),
      width: '760px',
      body: tabs,
      actions: [
        { label: HE.t('props.close', 'Close'), primary: true, onClick: function (close) { close(); } }
      ]
    });
    makeDraggable(modal.card);
    modal.card.classList.add('props-modal');
    return modal;
  }

  HE.props.openElement = function (el) { return openElementAt(el, 0); };
  HE.props.openStyles = function (el) { return openElementAt(el, 0); };

  /* ------------------------------------------------------ document settings */

  function headOf() {
    var d = HE.doc();
    return d && d.head;
  }

  function setTitleTag(d, value) {
    var node = d.head.querySelector('title');
    if (!value) { if (node) { node.remove(); } return; }
    if (!node) { node = d.createElement('title'); d.head.insertBefore(node, d.head.firstChild); }
    node.textContent = value;
  }

  function setCharsetMeta(d, value) {
    var node = d.head.querySelector('meta[charset]');
    if (!value) { if (node) { node.remove(); } return; }
    if (!node) { node = d.createElement('meta'); d.head.insertBefore(node, d.head.firstChild); }
    node.setAttribute('charset', value);
  }

  function setNamedMeta(d, name, value) {
    var node = d.head.querySelector('meta[name="' + name + '"]');
    if (!value) { if (node) { node.remove(); } return; }
    if (!node) { node = d.createElement('meta'); node.setAttribute('name', name); d.head.appendChild(node); }
    node.setAttribute('content', value);
  }

  function setPropertyMeta(d, property, value) {
    var node = d.head.querySelector('meta[property="' + property + '"]');
    if (!value) { if (node) { node.remove(); } return; }
    if (!node) { node = d.createElement('meta'); node.setAttribute('property', property); d.head.appendChild(node); }
    node.setAttribute('content', value);
  }

  function setFaviconLink(d, value) {
    var node = d.head.querySelector('link[rel~="icon"]');
    if (!value) { if (node) { node.remove(); } return; }
    if (!node) { node = d.createElement('link'); node.setAttribute('rel', 'icon'); d.head.appendChild(node); }
    node.setAttribute('href', value);
  }

  /** Generic "value <-> head tag" text field; empty value removes the tag. */
  function docField(label, getValue, setValue, extra) {
    var input = HE.el('input', { class: 'ctl field__control', type: 'text' });
    input.value = getValue() || '';
    input.addEventListener('change', function () {
      HE.edit(function () { setValue(input.value.trim()); });
    });
    var controls = [input];
    if (extra) { controls = controls.concat(extra(input)); }
    return field(label, controls);
  }

  function buildPageTab() {
    var d = HE.doc();
    var html = d.documentElement;
    var wrap = HE.el('div', { class: 'props-page' });

    wrap.appendChild(section(HE.t('props.sec.page', 'Page'), [
      docField(HE.t('props.pageTitle', 'Title'),
        function () { var t = d.head.querySelector('title'); return t ? t.textContent : ''; },
        function (v) { setTitleTag(d, v); }),
      docField(HE.t('props.pageLang', 'Language (lang)'),
        function () { return html.getAttribute('lang'); },
        function (v) { if (v) { html.setAttribute('lang', v); } else { html.removeAttribute('lang'); } }),
      docField(HE.t('props.charset', 'Charset'),
        function () { var m = d.head.querySelector('meta[charset]'); return m ? m.getAttribute('charset') : ''; },
        function (v) { setCharsetMeta(d, v); }),
      docField(HE.t('props.viewport', 'Viewport'),
        function () { var m = d.head.querySelector('meta[name="viewport"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setNamedMeta(d, 'viewport', v); })
    ]));

    wrap.appendChild(section(HE.t('props.sec.meta', 'Search & sharing'), [
      docField(HE.t('props.description', 'Description'),
        function () { var m = d.head.querySelector('meta[name="description"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setNamedMeta(d, 'description', v); }),
      docField(HE.t('props.keywords', 'Keywords'),
        function () { var m = d.head.querySelector('meta[name="keywords"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setNamedMeta(d, 'keywords', v); }),
      docField(HE.t('props.author', 'Author'),
        function () { var m = d.head.querySelector('meta[name="author"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setNamedMeta(d, 'author', v); }),
      docField(HE.t('props.themeColor', 'Theme colour'),
        function () { var m = d.head.querySelector('meta[name="theme-color"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setNamedMeta(d, 'theme-color', v); }),
      docField(HE.t('props.favicon', 'Favicon'),
        function () { var l = d.head.querySelector('link[rel~="icon"]'); return l ? l.getAttribute('href') : ''; },
        function (v) { setFaviconLink(d, v); },
        function (input) {
          var picker = folderPicker(function (url) {
            input.value = url;
            HE.edit(function () { setFaviconLink(d, url); });
          });
          return [picker.button, picker.panel];
        })
    ]));

    wrap.appendChild(section('Open Graph', [
      docField('og:title',
        function () { var m = d.head.querySelector('meta[property="og:title"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setPropertyMeta(d, 'og:title', v); }),
      docField('og:description',
        function () { var m = d.head.querySelector('meta[property="og:description"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setPropertyMeta(d, 'og:description', v); }),
      docField('og:image',
        function () { var m = d.head.querySelector('meta[property="og:image"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setPropertyMeta(d, 'og:image', v); }),
      docField('og:url',
        function () { var m = d.head.querySelector('meta[property="og:url"]'); return m ? m.getAttribute('content') : ''; },
        function (v) { setPropertyMeta(d, 'og:url', v); })
    ]));

    return wrap;
  }

  function buildPageStyleTab() {
    var body = HE.body();
    var wrap = HE.el('div', { class: 'props-pagestyle' });

    var form = HE.props.buildStyleForm(body);
    var centre = HE.el('button', {
      class: 'btn btn--ghost', type: 'button',
      text: HE.t('props.centrePage', 'Centre the page (max-width + auto margins)')
    });
    centre.addEventListener('click', function () {
      HE.edit(function () {
        if (!body.style.getPropertyValue('max-width')) { body.style.setProperty('max-width', '800px'); }
        body.style.setProperty('margin-left', 'auto');
        body.style.setProperty('margin-right', 'auto');
      });
      form.refresh();
    });

    wrap.appendChild(HE.el('div', { class: 'props-pagestyle__helpers' }, [centre]));
    wrap.appendChild(form);
    return wrap;
  }

  function headSerialized(d) {
    var clone = d.head.cloneNode(true);
    HE.$$('[data-html-editor-ui]', clone).forEach(function (node) { node.remove(); });
    return clone.innerHTML;
  }

  function headNodeLabel(node) {
    var tag = node.tagName.toLowerCase();
    var label = '<' + tag;
    ['rel', 'name', 'property', 'charset', 'href', 'src', 'content'].forEach(function (attr) {
      var v = node.getAttribute(attr);
      if (v) {
        if (v.length > 60) { v = v.slice(0, 60) + '…'; }
        label += ' ' + attr + '="' + v + '"';
      }
    });
    label += '>';
    if (tag === 'script' && node.getAttribute('type') === PARKED_SCRIPT_TYPE) {
      label += ' — ' + HE.t('props.parkedScript', 'script (parked while editing)');
    }
    return label;
  }

  function buildHeadTab() {
    var d = HE.doc();
    var wrap = HE.el('div', { class: 'props-head' });

    /* current head tags with remove buttons */
    var list = HE.el('div', { class: 'props-headlist' });
    function renderList() {
      list.innerHTML = '';
      HE.$$('link, style, script, meta, title', d.head).forEach(function (node) {
        if (node.getAttribute('data-html-editor-ui')) { return; }
        var remove = HE.el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: '×',
          title: HE.t('props.remove', 'Remove')
        });
        remove.addEventListener('click', function () {
          HE.edit(function () { node.remove(); });
          renderList();
          ta.value = headSerialized(d);
        });
        list.appendChild(HE.el('div', { class: 'props-headlist__item' }, [
          HE.el('code', { class: 'props-headlist__desc', text: headNodeLabel(node) }),
          remove
        ]));
      });
    }

    /* quick add helpers */
    var helpers = HE.el('div', { class: 'props-head__helpers' });
    var hrefInput = HE.el('input', { class: 'ctl', type: 'text', placeholder: 'styles.css' });
    var addLink = HE.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      text: HE.t('props.addStylesheet', 'Add stylesheet link')
    });
    addLink.addEventListener('click', function () {
      var href = hrefInput.value.trim();
      if (!href) { return; }
      HE.edit(function () {
        var link = d.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', href);
        d.head.appendChild(link);
      });
      hrefInput.value = '';
      renderList();
      ta.value = headSerialized(d);
    });
    var addStyle = HE.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      text: HE.t('props.addStyle', 'Add inline <style>')
    });
    addStyle.addEventListener('click', function () {
      HE.edit(function () {
        var style = d.createElement('style');
        style.textContent = '\n/* your styles */\n';
        d.head.appendChild(style);
      });
      renderList();
      ta.value = headSerialized(d);
    });
    var metaName = HE.el('input', { class: 'ctl', type: 'text', placeholder: HE.t('props.name', 'Name') });
    var metaContent = HE.el('input', { class: 'ctl', type: 'text', placeholder: HE.t('props.value', 'Value') });
    var addMeta = HE.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      text: HE.t('props.addMeta', 'Add meta')
    });
    addMeta.addEventListener('click', function () {
      var name = metaName.value.trim();
      if (!name) { return; }
      HE.edit(function () { setNamedMeta(d, name, metaContent.value || ' '); });
      metaName.value = '';
      metaContent.value = '';
      renderList();
      ta.value = headSerialized(d);
    });
    helpers.appendChild(HE.el('div', { class: 'field__row' }, [hrefInput, addLink]));
    helpers.appendChild(HE.el('div', { class: 'field__row' }, [addStyle]));
    helpers.appendChild(HE.el('div', { class: 'field__row' }, [metaName, metaContent, addMeta]));

    /* raw head escape hatch */
    var ta = HE.el('textarea', { class: 'props-head__raw', rows: '10', spellcheck: 'false' });
    ta.value = headSerialized(d);
    var apply = HE.el('button', { class: 'btn btn--primary', type: 'button', text: HE.t('props.apply', 'Apply') });
    apply.addEventListener('click', function () {
      HE.edit(function () {
        d.head.innerHTML = ta.value;
        HE.prepareFrame(); // reinstall the editor-only stylesheet we stripped
      });
      renderList();
      HE.toast(HE.t('props.headApplied', 'Head updated'), 'ok');
    });

    wrap.appendChild(HE.el('h3', { class: 'props-section__title', text: HE.t('props.headTags', 'Tags in <head>') }));
    wrap.appendChild(list);
    wrap.appendChild(helpers);
    wrap.appendChild(HE.el('h3', { class: 'props-section__title', text: HE.t('props.headRaw', 'Raw head (advanced)') }));
    wrap.appendChild(field(HE.t('props.headRawHint', 'Full HTML of <head>'), [ta, apply], 'field--wide'));

    renderList();
    return wrap;
  }

  HE.props.openDocument = function () {
    var d = HE.doc();
    if (!d || !d.head) { return; }

    var tabs = buildTabs([
      { label: HE.t('props.tab.page', 'Page'), build: buildPageTab },
      { label: HE.t('props.tab.pageStyle', 'Page style'), build: buildPageStyleTab },
      { label: HE.t('props.tab.head', 'Head / raw'), build: buildHeadTab },
      { label: HE.t('props.tab.htmlEl', 'Html element'), build: function () { return HE.props.buildAttributesTable(d.documentElement); } }
    ], 0);

    var modal = HE.modal({
      title: HE.t('props.docTitle', 'Document settings'),
      width: '760px',
      body: tabs,
      actions: [
        { label: HE.t('props.close', 'Close'), primary: true, onClick: function (close) { close(); } }
      ]
    });
    makeDraggable(modal.card);
    modal.card.classList.add('props-modal');
    return modal;
  };

  /* ----------------------------------------------------------- registration */

  HE.registerContextProvider(function (el) {
    if (!el || el.nodeType !== 1) { return []; }
    return [
      {
        label: HE.t('menu.properties', 'Properties…'),
        group: 'inspect',
        action: function () { HE.props.openElement(el); }
      },
      {
        label: HE.t('menu.styles', 'Style…'),
        group: 'inspect',
        action: function () { HE.props.openStyles(el); }
      }
    ];
  });

  var docBtn = document.getElementById('btn-doc-settings');
  if (docBtn) {
    docBtn.addEventListener('click', function () { HE.props.openDocument(); });
  }

  HE.modules.props = true;

  /*
   * New CSS class names introduced by this module (for editor.css):
   *
   *   props-modal
   *   props-tabs, props-tabs__bar, props-tabs__tab, props-tabs__panels, props-tabs__panel
   *   props-style, props-style__clear
   *   props-section, props-section__title, props-grid
   *   props-sides, props-sides__grid, props-sides__input, props-sides__link
   *   props-border, props-border__slot
   *   props-shadow, props-shadow__num, props-shadow__color
   *   props-transform, props-transform__num
   *   props-flex, props-offsets
   *   props-folder, props-folder__item, props-folder__thumb, props-folder__name, props-folder__size
   *   props-attrs, props-attrs__rows, props-attrs__row, props-attrs__addrow,
   *   props-attrs__name, props-attrs__value, props-attrs__remove
   *   props-classes, props-chips, props-chip, props-chip__label, props-chip__remove
   *   props-rules, props-rules__item, props-rules__selector, props-rules__css
   *   props-content, props-content__tag, props-content__html
   *   props-page, props-pagestyle, props-pagestyle__helpers
   *   props-head, props-head__helpers, props-head__raw
   *   props-headlist, props-headlist__item, props-headlist__desc
   *   field, field--wide, field__label, field__control, field__row, field__hint
   *   field-color, field-color__picker, field-color__text
   *   field-unit, field-unit__num, field-unit__unit
   *   field-range, field-range__input, field-range__value
   *
   * State classes reused/introduced: is-active (tabs, link-sides toggle).
   */
})(window.HE);
