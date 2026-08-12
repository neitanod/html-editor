/*
 * core.js — shared state and services for every other module.
 *
 * The editor UI lives in this document; the file being edited lives inside an
 * iframe served from /doc/, so relative URLs, stylesheets and images behave
 * exactly like they will on disk. Everything the modules need to talk to that
 * iframe goes through the HE namespace defined here.
 */
(function (global) {
  'use strict';

  var HE = {
    version: document.documentElement.dataset.version || 'dev',
    fileName: document.documentElement.dataset.file || 'index.html',
    filePath: document.documentElement.dataset.path || '',
    readOnly: document.documentElement.dataset.readOnly === 'true',
    dirty: false,
    ready: false,
    selected: null,
    modules: {},
    contextProviders: [],
    overlayRefreshers: [],
    listeners: {}
  };

  /* ---------------------------------------------------------------- i18n -- */

  var STRINGS = {
    en: {
      'toolbar.save': 'Save', 'toolbar.source': 'Source', 'toolbar.undo': 'Undo (Ctrl+Z)',
      'toolbar.redo': 'Redo (Ctrl+Y)', 'toolbar.bold': 'Bold (Ctrl+B)', 'toolbar.italic': 'Italic (Ctrl+I)',
      'toolbar.underline': 'Underline (Ctrl+U)', 'toolbar.strike': 'Strikethrough',
      'toolbar.clear': 'Clear formatting', 'toolbar.textColor': 'Text colour',
      'toolbar.highlight': 'Highlight colour', 'toolbar.alignLeft': 'Align left',
      'toolbar.alignCenter': 'Align centre', 'toolbar.alignRight': 'Align right',
      'toolbar.alignJustify': 'Justify', 'toolbar.bullets': 'Bulleted list',
      'toolbar.numbers': 'Numbered list', 'toolbar.indent': 'Increase indent',
      'toolbar.outdent': 'Decrease indent', 'toolbar.link': 'Insert link (Ctrl+K)',
      'toolbar.image': 'Insert image', 'toolbar.table': 'Insert table',
      'toolbar.hr': 'Horizontal rule', 'toolbar.symbol': 'Special character',
      'toolbar.block': 'Paragraph style', 'toolbar.font': 'Font family', 'toolbar.size': 'Font size',
      'toolbar.docSettings': 'Document settings: title, metadata, page styles',
      'toolbar.docSettingsShort': 'Document',
      'block.p': 'Paragraph', 'block.quote': 'Quote', 'block.pre': 'Preformatted',
      'font.inherit': 'Font', 'size.default': 'Size',
      'source.title': 'Source', 'source.apply': 'Apply', 'source.format': 'Format',
      'source.hint': 'Edit the source and press Apply (Ctrl+Enter)',
      'source.applied': 'Source applied to the document',
      'source.invalid': 'The source could not be parsed',
      'status.saved': 'Saved', 'status.unsaved': 'Unsaved changes',
      'status.selection': 'Selection', 'status.nothing': 'Nothing selected',
      'save.ok': 'Saved to disk', 'save.fail': 'Could not save: ',
      'save.readonly': 'Read-only mode: saving is disabled',
      'image.uploading': 'Storing image next to the document…',
      'image.stored': 'Image stored as ',
      'image.failed': 'Could not store the image: ',
      'link.text': 'Text', 'link.href': 'Address', 'link.open': 'Open', 'link.apply': 'Apply',
      'link.remove': 'Remove link', 'link.title': 'Link', 'link.newTab': 'Open in a new tab',
      'menu.copy': 'Copy', 'menu.cut': 'Cut', 'menu.paste': 'Paste', 'menu.duplicate': 'Duplicate',
      'menu.delete': 'Delete', 'menu.viewSource': 'View in source', 'menu.properties': 'Properties…',
      'menu.styles': 'Style…', 'menu.selectParent': 'Select parent',
      'menu.body': 'Body properties…', 'menu.head': 'Head & metadata…', 'menu.html': 'Html element…',
      'menu.insert': 'Insert', 'menu.table': 'Table', 'menu.image': 'Image…', 'menu.link': 'Link…',
      'menu.wrap': 'Wrap in', 'menu.copyHtml': 'Copy HTML',
      'props.title': 'Properties of ', 'props.attributes': 'Attributes', 'props.add': 'Add attribute',
      'props.name': 'Name', 'props.value': 'Value', 'props.apply': 'Apply', 'props.cancel': 'Cancel',
      'props.close': 'Close', 'props.remove': 'Remove',
      'common.ok': 'OK', 'common.cancel': 'Cancel', 'common.none': 'None', 'common.default': 'Default',
      'confirm.discard': 'The document has unsaved changes. Leave anyway?',
      'table.insert': 'Insert table', 'table.rows': 'Rows', 'table.columns': 'Columns',
      // -- image ---------------------------------------------------------------
      'image.alignLeft': 'Align left', 'image.alignCenter': 'Centre', 'image.alignRight': 'Align right',
      'image.alt': 'Alternative text', 'image.replace': 'Replace image…', 'image.reset': 'Original size',
      'image.fromComputer': 'Choose a file…', 'image.inFolder': 'Images already in this folder',
      'image.noneInFolder': 'No images next to the document yet.',
      // -- menu ----------------------------------------------------------------
      'menu.pasteHint': 'Use Ctrl+V to paste',
      // -- props ---------------------------------------------------------------
      'props.tab.style': 'Style', 'props.tab.classes': 'Classes & id', 'props.tab.content': 'Content',
      'props.tab.page': 'Page', 'props.tab.pageStyle': 'Page style', 'props.tab.head': 'Head / raw',
      'props.tab.htmlEl': 'Html element', 'props.sec.text': 'Text', 'props.sec.box': 'Box',
      'props.sec.layout': 'Layout', 'props.sec.background': 'Background', 'props.sec.effects': 'Effects',
      'props.sec.page': 'Page', 'props.sec.meta': 'Search & sharing', 'props.tag': 'Tag',
      'props.changeTag': 'Change tag to…', 'props.classes': 'Classes', 'props.addClass': 'Add a class…',
      'props.content': 'Content (HTML)', 'props.contentApplied': 'Content applied',
      'props.badAttr': 'Invalid attribute name: ', 'props.reserved': 'That attribute is managed by the editor',
      'props.fontFamily': 'Font', 'props.fontSize': 'Size', 'props.fontWeight': 'Weight',
      'props.fontStyle': 'Style', 'props.textColour': 'Colour', 'props.textAlign': 'Align',
      'props.lineHeight': 'Line height', 'props.letterSpacing': 'Letter spacing',
      'props.textDecoration': 'Decoration', 'props.textTransform': 'Case', 'props.width': 'Width',
      'props.height': 'Height', 'props.maxWidth': 'Max width', 'props.minHeight': 'Min height',
      'props.margin': 'Margin', 'props.padding': 'Padding', 'props.allSides': 'All sides',
      'props.linkSides': 'Link all sides', 'props.borderWidth': 'Width', 'props.borderStyle': 'Style',
      'props.borderColor': 'Colour', 'props.borderSide': 'Border on', 'props.borderRadius': 'Corner radius',
      'props.display': 'Display', 'props.position': 'Position', 'props.float': 'Float',
      'props.overflow': 'Overflow', 'props.flexDirection': 'Direction', 'props.justify': 'Justify',
      'props.alignItems': 'Align items', 'props.gap': 'Gap', 'props.bgColour': 'Colour',
      'props.bgImage': 'Image URL', 'props.bgSize': 'Size', 'props.bgPosition': 'Position',
      'props.bgRepeat': 'Repeat', 'props.opacity': 'Opacity', 'props.shadow': 'Shadow', 'props.blur': 'Blur',
      'props.spread': 'Spread', 'props.cursor': 'Cursor', 'props.transform': 'Transform',
      'props.rotate': 'Rotate (deg)', 'props.scale': 'Scale', 'props.colour': 'Colour', 'props.reset': 'Reset',
      'props.loading': 'Loading…', 'props.clearStyles': 'Clear inline styles',
      'props.matchedRules': 'CSS rules that apply',
      'props.noRules': 'No document stylesheet rules match this element.',
      'props.docTitle': 'Document settings', 'props.pageTitle': 'Title', 'props.pageLang': 'Language (lang)',
      'props.charset': 'Charset', 'props.viewport': 'Viewport', 'props.description': 'Description',
      'props.keywords': 'Keywords', 'props.author': 'Author', 'props.favicon': 'Favicon',
      'props.themeColor': 'Theme colour', 'props.centrePage': 'Centre the page (max-width + auto margins)',
      'props.headTags': 'Tags in <head>', 'props.headRaw': 'Raw head (advanced)',
      'props.headRawHint': 'Full HTML of <head>', 'props.headApplied': 'Head updated',
      'props.addMeta': 'Add meta', 'props.addStyle': 'Add inline <style>',
      'props.addStylesheet': 'Add stylesheet link', 'props.parkedScript': 'script (parked while editing)',
      'props.browseFolder': 'Choose…', 'props.noImages': 'No images in the document folder',
      'props.folderFailed': 'Could not list the document folder: ',
      // -- source --------------------------------------------------------------
      'source.modified': 'Source modified — Apply (Ctrl+Enter) to update the page',
      // -- table ---------------------------------------------------------------
      'table.rowAbove': 'Insert row above', 'table.rowBelow': 'Insert row below',
      'table.colLeft': 'Insert column left', 'table.colRight': 'Insert column right',
      'table.delRow': 'Delete row', 'table.delCol': 'Delete column', 'table.delTable': 'Delete table',
      'table.merge': 'Merge cells', 'table.split': 'Split cell',
      'table.nothingToSplit': 'This cell is not merged',
      'table.selectCells': 'Drag across cells first, then merge', 'table.toggleHeader': 'Toggle header row',
      'table.headerRow': 'Header row', 'table.headerCol': 'Header column',
      'table.distribute': 'Distribute columns evenly', 'table.vTop': 'Align top',
      'table.vMiddle': 'Align middle', 'table.vBottom': 'Align bottom',
      'table.cellBackground': 'Cell background', 'table.borders': 'Borders', 'table.border': 'Border',
      'table.borderColor': 'Colour', 'table.borderSolid': 'Solid', 'table.borderThin': 'Thin',
      'table.width': 'Width', 'table.alignment': 'Alignment', 'table.caption': 'Caption',
      'table.padding': 'Cell padding', 'table.striped': 'Striped rows'
    },
    es: {
      'toolbar.save': 'Guardar', 'toolbar.source': 'Código', 'toolbar.undo': 'Deshacer (Ctrl+Z)',
      'toolbar.redo': 'Rehacer (Ctrl+Y)', 'toolbar.bold': 'Negrita (Ctrl+B)', 'toolbar.italic': 'Cursiva (Ctrl+I)',
      'toolbar.underline': 'Subrayado (Ctrl+U)', 'toolbar.strike': 'Tachado',
      'toolbar.clear': 'Quitar formato', 'toolbar.textColor': 'Color del texto',
      'toolbar.highlight': 'Color de resaltado', 'toolbar.alignLeft': 'Alinear a la izquierda',
      'toolbar.alignCenter': 'Centrar', 'toolbar.alignRight': 'Alinear a la derecha',
      'toolbar.alignJustify': 'Justificar', 'toolbar.bullets': 'Lista con viñetas',
      'toolbar.numbers': 'Lista numerada', 'toolbar.indent': 'Aumentar sangría',
      'toolbar.outdent': 'Reducir sangría', 'toolbar.link': 'Insertar enlace (Ctrl+K)',
      'toolbar.image': 'Insertar imagen', 'toolbar.table': 'Insertar tabla',
      'toolbar.hr': 'Línea horizontal', 'toolbar.symbol': 'Carácter especial',
      'toolbar.block': 'Estilo de párrafo', 'toolbar.font': 'Tipografía', 'toolbar.size': 'Tamaño',
      'toolbar.docSettings': 'Ajustes del documento: título, metadatos, estilos de página',
      'toolbar.docSettingsShort': 'Documento',
      'block.p': 'Párrafo', 'block.quote': 'Cita', 'block.pre': 'Preformateado',
      'font.inherit': 'Tipografía', 'size.default': 'Tamaño',
      'source.title': 'Código fuente', 'source.apply': 'Aplicar', 'source.format': 'Formatear',
      'source.hint': 'Editá el código y apretá Aplicar (Ctrl+Enter)',
      'source.applied': 'Código aplicado al documento',
      'source.invalid': 'No se pudo interpretar el código',
      'status.saved': 'Guardado', 'status.unsaved': 'Cambios sin guardar',
      'status.selection': 'Selección', 'status.nothing': 'Nada seleccionado',
      'save.ok': 'Guardado en disco', 'save.fail': 'No se pudo guardar: ',
      'save.readonly': 'Modo sólo lectura: no se puede guardar',
      'image.uploading': 'Guardando la imagen junto al documento…',
      'image.stored': 'Imagen guardada como ',
      'image.failed': 'No se pudo guardar la imagen: ',
      'link.text': 'Texto', 'link.href': 'Dirección', 'link.open': 'Abrir', 'link.apply': 'Aplicar',
      'link.remove': 'Quitar enlace', 'link.title': 'Enlace', 'link.newTab': 'Abrir en una pestaña nueva',
      'menu.copy': 'Copiar', 'menu.cut': 'Cortar', 'menu.paste': 'Pegar', 'menu.duplicate': 'Duplicar',
      'menu.delete': 'Borrar', 'menu.viewSource': 'Ver en el código', 'menu.properties': 'Propiedades…',
      'menu.styles': 'Estilo…', 'menu.selectParent': 'Seleccionar el padre',
      'menu.body': 'Propiedades del body…', 'menu.head': 'Head y metadatos…', 'menu.html': 'Elemento html…',
      'menu.insert': 'Insertar', 'menu.table': 'Tabla', 'menu.image': 'Imagen…', 'menu.link': 'Enlace…',
      'menu.wrap': 'Envolver en', 'menu.copyHtml': 'Copiar HTML',
      'props.title': 'Propiedades de ', 'props.attributes': 'Atributos', 'props.add': 'Agregar atributo',
      'props.name': 'Nombre', 'props.value': 'Valor', 'props.apply': 'Aplicar', 'props.cancel': 'Cancelar',
      'props.close': 'Cerrar', 'props.remove': 'Quitar',
      'common.ok': 'Aceptar', 'common.cancel': 'Cancelar', 'common.none': 'Ninguno', 'common.default': 'Por defecto',
      'confirm.discard': 'El documento tiene cambios sin guardar. ¿Salir igual?',
      'table.insert': 'Insertar tabla', 'table.rows': 'Filas', 'table.columns': 'Columnas',
      // -- image ---------------------------------------------------------------
      'image.alignLeft': 'Alinear a la izquierda', 'image.alignCenter': 'Centrar',
      'image.alignRight': 'Alinear a la derecha', 'image.alt': 'Texto alternativo',
      'image.replace': 'Reemplazar imagen…', 'image.reset': 'Tamaño original',
      'image.fromComputer': 'Elegí un archivo…', 'image.inFolder': 'Imágenes que ya están en esta carpeta',
      'image.noneInFolder': 'Todavía no hay imágenes junto al documento.',
      // -- menu ----------------------------------------------------------------
      'menu.pasteHint': 'Usá Ctrl+V para pegar',
      // -- props ---------------------------------------------------------------
      'props.tab.style': 'Estilo', 'props.tab.classes': 'Clases e id', 'props.tab.content': 'Contenido',
      'props.tab.page': 'Página', 'props.tab.pageStyle': 'Estilo de página', 'props.tab.head': 'Head / crudo',
      'props.tab.htmlEl': 'Elemento html', 'props.sec.text': 'Texto', 'props.sec.box': 'Caja',
      'props.sec.layout': 'Disposición', 'props.sec.background': 'Fondo', 'props.sec.effects': 'Efectos',
      'props.sec.page': 'Página', 'props.sec.meta': 'Buscadores y redes', 'props.tag': 'Etiqueta',
      'props.changeTag': 'Cambiar la etiqueta a…', 'props.classes': 'Clases',
      'props.addClass': 'Agregar una clase…', 'props.content': 'Contenido (HTML)',
      'props.contentApplied': 'Contenido aplicado', 'props.badAttr': 'Nombre de atributo inválido: ',
      'props.reserved': 'Ese atributo lo maneja el editor', 'props.fontFamily': 'Tipografía',
      'props.fontSize': 'Tamaño', 'props.fontWeight': 'Peso', 'props.fontStyle': 'Estilo',
      'props.textColour': 'Color', 'props.textAlign': 'Alineación', 'props.lineHeight': 'Interlineado',
      'props.letterSpacing': 'Espaciado entre letras', 'props.textDecoration': 'Decoración',
      'props.textTransform': 'Capitalización', 'props.width': 'Ancho', 'props.height': 'Alto',
      'props.maxWidth': 'Ancho máximo', 'props.minHeight': 'Alto mínimo', 'props.margin': 'Margen',
      'props.padding': 'Relleno', 'props.allSides': 'Todos los lados',
      'props.linkSides': 'Vincular todos los lados', 'props.borderWidth': 'Grosor',
      'props.borderStyle': 'Estilo', 'props.borderColor': 'Color', 'props.borderSide': 'Borde en',
      'props.borderRadius': 'Radio de las esquinas', 'props.display': 'Display', 'props.position': 'Posición',
      'props.float': 'Float', 'props.overflow': 'Overflow', 'props.flexDirection': 'Dirección',
      'props.justify': 'Justificar', 'props.alignItems': 'Alinear ítems', 'props.gap': 'Separación',
      'props.bgColour': 'Color', 'props.bgImage': 'URL de la imagen', 'props.bgSize': 'Tamaño',
      'props.bgPosition': 'Posición', 'props.bgRepeat': 'Repetición', 'props.opacity': 'Opacidad',
      'props.shadow': 'Sombra', 'props.blur': 'Desenfoque', 'props.spread': 'Extensión',
      'props.cursor': 'Cursor', 'props.transform': 'Transformación', 'props.rotate': 'Rotación (deg)',
      'props.scale': 'Escala', 'props.colour': 'Color', 'props.reset': 'Restablecer',
      'props.loading': 'Cargando…', 'props.clearStyles': 'Quitar estilos en línea',
      'props.matchedRules': 'Reglas CSS que aplican',
      'props.noRules': 'Ninguna regla de las hojas de estilos del documento coincide con este elemento.',
      'props.docTitle': 'Ajustes del documento', 'props.pageTitle': 'Título', 'props.pageLang': 'Idioma (lang)',
      'props.charset': 'Charset', 'props.viewport': 'Viewport', 'props.description': 'Descripción',
      'props.keywords': 'Palabras clave', 'props.author': 'Autor', 'props.favicon': 'Favicon',
      'props.themeColor': 'Color del tema',
      'props.centrePage': 'Centrar la página (max-width + márgenes automáticos)',
      'props.headTags': 'Etiquetas en el <head>', 'props.headRaw': 'Head crudo (avanzado)',
      'props.headRawHint': 'HTML completo del <head>', 'props.headApplied': 'Head actualizado',
      'props.addMeta': 'Agregar meta', 'props.addStyle': 'Agregar <style> en línea',
      'props.addStylesheet': 'Agregar hoja de estilos',
      'props.parkedScript': 'script (suspendido durante la edición)', 'props.browseFolder': 'Elegir…',
      'props.noImages': 'No hay imágenes en la carpeta del documento',
      'props.folderFailed': 'No se pudo listar la carpeta del documento: ',
      // -- source --------------------------------------------------------------
      'source.modified': 'Código modificado — apretá Aplicar (Ctrl+Enter) para actualizar la página',
      // -- table ---------------------------------------------------------------
      'table.rowAbove': 'Insertar fila arriba', 'table.rowBelow': 'Insertar fila abajo',
      'table.colLeft': 'Insertar columna a la izquierda', 'table.colRight': 'Insertar columna a la derecha',
      'table.delRow': 'Borrar fila', 'table.delCol': 'Borrar columna', 'table.delTable': 'Borrar tabla',
      'table.merge': 'Combinar celdas', 'table.split': 'Dividir celda',
      'table.nothingToSplit': 'Esta celda no está combinada',
      'table.selectCells': 'Primero arrastrá sobre las celdas y después combiná',
      'table.toggleHeader': 'Alternar fila de encabezado', 'table.headerRow': 'Fila de encabezado',
      'table.headerCol': 'Columna de encabezado', 'table.distribute': 'Distribuir columnas uniformemente',
      'table.vTop': 'Alinear arriba', 'table.vMiddle': 'Alinear al medio', 'table.vBottom': 'Alinear abajo',
      'table.cellBackground': 'Fondo de celda', 'table.borders': 'Bordes', 'table.border': 'Borde',
      'table.borderColor': 'Color', 'table.borderSolid': 'Sólido', 'table.borderThin': 'Fino',
      'table.width': 'Ancho', 'table.alignment': 'Alineación', 'table.caption': 'Leyenda',
      'table.padding': 'Relleno de celda', 'table.striped': 'Filas alternadas'
    }
  };

  HE.lang = (localStorage.getItem('html-editor.lang') ||
    ((navigator.language || 'en').toLowerCase().indexOf('es') === 0 ? 'es' : 'en'));

  HE.t = function (key, fallback) {
    var table = STRINGS[HE.lang] || STRINGS.en;
    return table[key] || STRINGS.en[key] || fallback || key;
  };

  HE.setLang = function (lang) {
    HE.lang = lang === 'es' ? 'es' : 'en';
    localStorage.setItem('html-editor.lang', HE.lang);
    HE.applyI18n(document);
    HE.emit('lang', HE.lang);
  };

  HE.applyI18n = function (root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = HE.t(node.dataset.i18n, node.textContent);
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach(function (node) {
      node.title = HE.t(node.dataset.i18nTitle, node.title);
    });
  };

  /* ------------------------------------------------------------- events -- */

  HE.on = function (name, fn) {
    (HE.listeners[name] = HE.listeners[name] || []).push(fn);
  };

  HE.emit = function (name, payload) {
    (HE.listeners[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (err) { console.error('[html-editor] listener for ' + name, err); }
    });
  };

  /* ---------------------------------------------------------- iframe API -- */

  HE.frame = function () { return document.getElementById('frame'); };
  HE.win = function () { var f = HE.frame(); return f && f.contentWindow; };
  HE.doc = function () { var f = HE.frame(); return f && f.contentDocument; };
  HE.body = function () { var d = HE.doc(); return d && d.body; };

  HE.$ = function (selector, root) { return (root || document).querySelector(selector); };
  HE.$$ = function (selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  };

  HE.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'class') { node.className = attrs[key]; }
      else if (key === 'text') { node.textContent = attrs[key]; }
      else if (key === 'html') { node.innerHTML = attrs[key]; }
      else if (key.indexOf('on') === 0 && typeof attrs[key] === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      } else if (attrs[key] !== null && attrs[key] !== undefined) {
        node.setAttribute(key, attrs[key]);
      }
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  };

  /* ------------------------------------------------------- selection API -- */

  HE.select = function (element) {
    if (HE.selected === element) { HE.emit('select', element); return element; }
    if (HE.selected && HE.selected.classList) {
      HE.selected.classList.remove('he-selected');
    }
    HE.selected = element || null;
    if (HE.selected && HE.selected.classList) {
      HE.selected.classList.add('he-selected');
    }
    HE.emit('select', HE.selected);
    HE.refreshOverlays();
    return HE.selected;
  };

  HE.clearSelection = function () { HE.select(null); };

  /** Path from <html> down to the element, used by the breadcrumb bar. */
  HE.pathOf = function (element) {
    var chain = [];
    var node = element;
    while (node && node.nodeType === 1) {
      chain.unshift(node);
      node = node.parentElement;
    }
    return chain;
  };

  HE.describe = function (element) {
    if (!element || element.nodeType !== 1) { return ''; }
    var label = element.tagName.toLowerCase();
    if (element.id) { label += '#' + element.id; }
    var cls = (element.getAttribute('class') || '')
      .split(/\s+/).filter(function (c) { return c && c.indexOf('he-') !== 0; });
    if (cls.length) { label += '.' + cls.join('.'); }
    return label;
  };

  /* --------------------------------------------------------- overlays ---- */

  HE.registerOverlayRefresher = function (fn) { HE.overlayRefreshers.push(fn); };

  HE.refreshOverlays = function () {
    HE.overlayRefreshers.forEach(function (fn) {
      try { fn(); } catch (err) { console.error('[html-editor] overlay refresh', err); }
    });
  };

  /** Bounding rect of an element inside the iframe, in host viewport space. */
  HE.rectInHost = function (element) {
    var frame = HE.frame();
    if (!element || !frame) { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    var r = element.getBoundingClientRect();
    var f = frame.getBoundingClientRect();
    return {
      top: r.top + f.top, left: r.left + f.left,
      width: r.width, height: r.height,
      bottom: r.top + f.top + r.height, right: r.left + f.left + r.width
    };
  };

  /* ---------------------------------------------------- context menu API -- */

  /**
   * Modules register a provider that receives the right-clicked element and
   * returns menu entries: {label, icon, action, danger, separator, submenu}.
   */
  HE.registerContextProvider = function (fn) { HE.contextProviders.push(fn); };

  /* ------------------------------------------------------------ history -- */

  var history = { stack: [], index: -1, restoring: false, typingTimer: null };
  HE.history = history;
  var HISTORY_LIMIT = 120;

  HE.snapshot = function () {
    var d = HE.doc();
    return d && d.documentElement ? d.documentElement.innerHTML : '';
  };

  HE.pushHistory = function () {
    if (history.restoring || !HE.ready) { return; }
    var current = HE.snapshot();
    if (history.index >= 0 && history.stack[history.index] === current) { return; }
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(current);
    if (history.stack.length > HISTORY_LIMIT) { history.stack.shift(); }
    history.index = history.stack.length - 1;
    HE.emit('history', history);
  };

  function restore(html) {
    var d = HE.doc();
    if (!d) { return; }
    history.restoring = true;
    HE.select(null);
    d.documentElement.innerHTML = html;
    HE.prepareFrame();
    history.restoring = false;
    HE.markDirty();
    HE.emit('history', history);
  }

  HE.undo = function () {
    if (history.index <= 0) { return; }
    history.index -= 1;
    restore(history.stack[history.index]);
  };

  HE.redo = function () {
    if (history.index >= history.stack.length - 1) { return; }
    history.index += 1;
    restore(history.stack[history.index]);
  };

  /** Runs a structural mutation and records it in the history. */
  HE.edit = function (fn) {
    if (HE.readOnly) { HE.toast(HE.t('save.readonly'), 'warn'); return; }
    var result = fn();
    HE.markDirty();
    HE.pushHistory();
    HE.refreshOverlays();
    HE.emit('mutated');
    return result;
  };

  /* -------------------------------------------------------- dirty state -- */

  HE.markDirty = function () {
    HE.dirty = true;
    var dot = document.getElementById('dirty-dot');
    if (dot) { dot.hidden = false; }
    HE.emit('dirty', true);
  };

  HE.markClean = function () {
    HE.dirty = false;
    var dot = document.getElementById('dirty-dot');
    if (dot) { dot.hidden = true; }
    HE.emit('dirty', false);
  };

  /* -------------------------------------------------------- serialising -- */

  var EDITOR_ATTRS = ['contenteditable', 'spellcheck', 'data-he-id', 'data-he-hover'];

  /** Full document HTML, with every trace of the editor removed. */
  HE.serialize = function () {
    var d = HE.doc();
    if (!d) { return ''; }
    var clone = d.documentElement.cloneNode(true);

    clone.querySelectorAll('[data-html-editor-ui]').forEach(function (node) { node.remove(); });
    EDITOR_ATTRS.forEach(function (attr) {
      clone.querySelectorAll('[' + attr + ']').forEach(function (node) { node.removeAttribute(attr); });
    });
    clone.querySelectorAll('[class]').forEach(function (node) {
      var kept = node.getAttribute('class').split(/\s+/).filter(function (c) {
        return c && c.indexOf('he-') !== 0;
      });
      if (kept.length) { node.setAttribute('class', kept.join(' ')); }
      else { node.removeAttribute('class'); }
    });

    var doctype = '<!DOCTYPE html>';
    if (d.doctype) {
      doctype = '<!DOCTYPE ' + d.doctype.name +
        (d.doctype.publicId ? ' PUBLIC "' + d.doctype.publicId + '"' : '') +
        (!d.doctype.publicId && d.doctype.systemId ? ' SYSTEM' : '') +
        (d.doctype.systemId ? ' "' + d.doctype.systemId + '"' : '') + '>';
    }
    return doctype + '\n' + clone.outerHTML + '\n';
  };

  /* -------------------------------------------------------------- saving -- */

  HE.save = function () {
    if (HE.readOnly) { HE.toast(HE.t('save.readonly'), 'warn'); return Promise.resolve(false); }
    // The browser serialises everything on very few lines; the file on disk is
    // meant to stay readable, so it is re-indented before it is written.
    var content = HE.formatHTML ? HE.formatHTML(HE.serialize()) : HE.serialize();
    return fetch('/api/document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) { throw new Error(data.error || res.statusText); }
        return data;
      });
    }).then(function (data) {
      HE.markClean();
      HE.toast(HE.t('save.ok'), 'ok');
      HE.emit('saved', data);
      return true;
    }).catch(function (err) {
      HE.toast(HE.t('save.fail') + err.message, 'error');
      return false;
    });
  };

  /* ------------------------------------------------------------- assets -- */

  /** Uploads a File/Blob next to the document; resolves to its relative name. */
  HE.storeAsset = function (file, suggestedName) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('cannot read file')); };
      reader.onload = function () {
        var data = String(reader.result).split(',')[1] || '';
        fetch('/api/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: suggestedName || file.name || '',
            mime: file.type || '',
            data: data
          })
        }).then(function (res) {
          return res.json().then(function (payload) {
            if (!res.ok) { throw new Error(payload.error || res.statusText); }
            return payload;
          });
        }).then(resolve).catch(reject);
      };
      reader.readAsDataURL(file);
    });
  };

  /* --------------------------------------------------------------- toast -- */

  HE.toast = function (message, kind) {
    var host = document.getElementById('toasts');
    if (!host) { return; }
    var node = HE.el('div', { class: 'toast toast--' + (kind || 'info'), text: message });
    host.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('is-in'); });
    setTimeout(function () {
      node.classList.remove('is-in');
      setTimeout(function () { node.remove(); }, 260);
    }, kind === 'error' ? 6000 : 2600);
  };

  /* --------------------------------------------------------------- modal -- */

  /**
   * Opens a modal dialog. `options` = {title, body (Node), actions:[{label,
   * primary, onClick(close)}], width, onClose}.
   */
  HE.modal = function (options) {
    var root = document.getElementById('modal-root');
    root.innerHTML = '';
    root.hidden = false;

    var card = HE.el('div', { class: 'modal' });
    if (options.width) { card.style.maxWidth = options.width; }

    var head = HE.el('header', { class: 'modal__head' }, [
      HE.el('h2', { class: 'modal__title', text: options.title || '' })
    ]);
    var closeBtn = HE.el('button', { class: 'modal__close', type: 'button', 'aria-label': 'Close', text: '✕' });
    head.appendChild(closeBtn);
    card.appendChild(head);

    var body = HE.el('div', { class: 'modal__body' });
    if (options.body) { body.appendChild(options.body); }
    card.appendChild(body);

    var foot = HE.el('footer', { class: 'modal__foot' });
    (options.actions || []).forEach(function (action) {
      var btn = HE.el('button', {
        class: 'btn ' + (action.primary ? 'btn--primary' : 'btn--ghost'),
        type: 'button',
        text: action.label
      });
      btn.addEventListener('click', function () { action.onClick && action.onClick(close); });
      foot.appendChild(btn);
    });
    if ((options.actions || []).length) { card.appendChild(foot); }

    root.appendChild(card);

    function close() {
      root.hidden = true;
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      options.onClose && options.onClose();
    }
    function onKey(event) {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    }
    closeBtn.addEventListener('click', close);
    root.addEventListener('mousedown', function (event) {
      if (event.target === root) { close(); }
    });
    document.addEventListener('keydown', onKey, true);

    var focusable = card.querySelector('input, select, textarea, button.btn--primary');
    if (focusable) { setTimeout(function () { focusable.focus(); }, 30); }

    return { close: close, card: card, body: body };
  };

  /* ------------------------------------------------------------ popover -- */

  var activePopover = null;

  /**
   * Floating panel anchored to a rect (host viewport coordinates). It flips
   * above or below depending on the room available.
   */
  HE.popover = function (options) {
    HE.closePopover();
    var host = document.getElementById('popover');
    host.innerHTML = '';
    host.hidden = false;
    host.className = 'popover' + (options.className ? ' ' + options.className : '');
    if (options.body) { host.appendChild(options.body); }

    function place() {
      var rect = typeof options.rect === 'function' ? options.rect() : options.rect;
      if (!rect) { return; }
      var box = host.getBoundingClientRect();
      var margin = 10;
      var top = rect.bottom + margin;
      var flipped = false;
      if (top + box.height > window.innerHeight - 12 && rect.top - box.height - margin > 12) {
        top = rect.top - box.height - margin;
        flipped = true;
      }
      var left = Math.min(
        Math.max(12, rect.left),
        Math.max(12, window.innerWidth - box.width - 12)
      );
      host.style.top = Math.max(12, top) + 'px';
      host.style.left = left + 'px';
      host.dataset.placement = flipped ? 'above' : 'below';
    }

    place();
    requestAnimationFrame(place);

    activePopover = { close: closePopover, update: place, node: host, onClose: options.onClose };

    function closePopover() {
      host.hidden = true;
      host.innerHTML = '';
      if (activePopover && activePopover.onClose) { activePopover.onClose(); }
      activePopover = null;
    }

    return activePopover;
  };

  HE.closePopover = function () {
    if (activePopover) { activePopover.close(); }
  };

  HE.updatePopover = function () {
    if (activePopover) { activePopover.update(); }
  };

  HE.registerOverlayRefresher(function () { HE.updatePopover(); });

  /* ------------------------------------------------- iframe preparation -- */

  var EDITOR_STYLE_ID = 'html-editor-runtime-style';

  var RUNTIME_CSS = [
    '.he-selected { outline: 2px solid #f0a637 !important; outline-offset: 1px; }',
    '.he-hover { outline: 1px dashed rgba(240,166,55,.75) !important; outline-offset: 1px; }',
    '.he-drop { outline: 2px dashed #4aa3ff !important; }',
    'body { caret-color: #f0863a; }',
    '[contenteditable="true"]:focus { outline: none; }',
    'table.he-empty-borders td, table.he-empty-borders th { outline: 1px dotted rgba(0,0,0,.18); }',
    '.he-cell-selected { background: rgba(240,166,55,.22) !important; outline: 1px solid #f0a637 !important; }',
    '.he-col-resize { cursor: col-resize !important; }'
  ].join('\n');

  /**
   * Makes the freshly loaded (or restored) document editable and re-installs
   * the editor-only stylesheet. Called on load and after every history restore.
   */
  HE.prepareFrame = function () {
    var d = HE.doc();
    if (!d || !d.body) { return; }

    if (!d.getElementById(EDITOR_STYLE_ID)) {
      var style = d.createElement('style');
      style.id = EDITOR_STYLE_ID;
      style.setAttribute('data-html-editor-ui', '1');
      style.textContent = RUNTIME_CSS;
      (d.head || d.documentElement).appendChild(style);
    }

    if (!HE.readOnly) {
      d.body.setAttribute('contenteditable', 'true');
      d.body.setAttribute('spellcheck', 'false');
    }
    HE.emit('frame-prepared', d);
  };

  global.HE = HE;
})(window);
