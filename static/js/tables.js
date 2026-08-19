/*
 * tables.js — Word-style table insertion and editing.
 *
 * Public API:
 *   HE.tables.openInsertDialog()            — insert-table picker dialog
 *   HE.tables.insert(rows, cols, options)   — insert a table at the caret
 *   HE.tables.contextEntries(el)            — context-menu entries for tables
 *
 * Everything that mutates the document goes through HE.edit() so undo/redo
 * and the dirty flag keep working. Editor-only state uses the `he-` class
 * prefix (stripped on save by core.js). Nothing structural is injected into
 * the edited document except one <style data-html-editor-ui="1"> tag, which
 * core.js removes when serialising.
 */
(function (HE) {
  'use strict';

  if (!HE) { return; }

  /* ------------------------------------------------------------ helpers -- */

  var BLOCK_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION',
    'ARTICLE', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'FIGURE',
    'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FORM', 'DL', 'DT', 'DD',
    'TD', 'TH'];

  function isBlock(el) {
    return el && el.nodeType === 1 && BLOCK_TAGS.indexOf(el.tagName) !== -1;
  }

  /** Nearest td/th ancestor (inclusive), stopping at body. */
  function closestCell(node) {
    while (node && node.nodeType !== 1) { node = node.parentNode; }
    while (node && node.nodeType === 1) {
      if (node.tagName === 'TD' || node.tagName === 'TH') { return node; }
      if (node.tagName === 'BODY' || node.tagName === 'HTML') { return null; }
      node = node.parentElement;
    }
    return null;
  }

  /** Nearest table ancestor (inclusive), stopping at body. */
  function closestTable(node) {
    while (node && node.nodeType !== 1) { node = node.parentNode; }
    while (node && node.nodeType === 1) {
      if (node.tagName === 'TABLE') { return node; }
      if (node.tagName === 'BODY' || node.tagName === 'HTML') { return null; }
      node = node.parentElement;
    }
    return null;
  }

  /** All cells belonging directly to this table (nested tables excluded). */
  function ownCells(table) {
    return Array.prototype.slice.call(table.querySelectorAll('th, td'))
      .filter(function (cell) { return closestTable(cell) === table; });
  }

  function insertAfter(node, ref) {
    ref.parentElement.insertBefore(node, ref.nextSibling);
  }

  function setSpan(cell, attr, value) {
    if (value > 1) { cell.setAttribute(attr, String(value)); }
    else { cell.removeAttribute(attr); }
  }

  /** A brand-new empty cell. Empty cells get <br> so they are clickable. */
  function freshCell(doc, tag) {
    var cell = doc.createElement(tag || 'td');
    cell.innerHTML = '<br>';
    return cell;
  }

  /** New empty cell copying the look (tag + style + class) of a reference. */
  function freshCellLike(ref) {
    var cell = ref.cloneNode(false);
    cell.removeAttribute('colspan');
    cell.removeAttribute('rowspan');
    cell.removeAttribute('id');
    if (cell.classList) { HE.unmark(cell, 'he-cell-selected'); }
    cell.innerHTML = '<br>';
    return cell;
  }

  /** Replace a cell with the same content under another tag (td <-> th). */
  function convertCellTag(cell, tag) {
    if (cell.tagName.toLowerCase() === tag) { return cell; }
    var doc = cell.ownerDocument;
    var next = doc.createElement(tag);
    for (var i = 0; i < cell.attributes.length; i++) {
      next.setAttribute(cell.attributes[i].name, cell.attributes[i].value);
    }
    while (cell.firstChild) { next.appendChild(cell.firstChild); }
    cell.parentElement.replaceChild(next, cell);
    return next;
  }

  function cellHasContent(cell) {
    if (cell.textContent.replace(/\s+/g, '') !== '') { return true; }
    return !!cell.querySelector('img, video, audio, table, iframe, hr, input, button, svg, canvas');
  }

  /* --------------------------------------------------------- grid model -- */

  /**
   * Builds a logical grid of the table: grid.rows[r][c] -> info describing
   * the cell that covers that slot, accounting for colspan/rowspan.
   * info = {cell, row, col, rowSpan, colSpan}, where row/col are the slot
   * where the cell STARTS.
   */
  function buildGrid(table) {
    var domRows = table.rows;
    var rows = [];
    var r, c;
    for (r = 0; r < domRows.length; r++) { rows[r] = rows[r] || []; }
    for (r = 0; r < domRows.length; r++) {
      var cells = domRows[r].cells;
      var col = 0;
      for (c = 0; c < cells.length; c++) {
        var cell = cells[c];
        rows[r] = rows[r] || [];
        while (rows[r][col]) { col++; }
        var cs = Math.max(1, cell.colSpan || 1);
        var rs = Math.max(1, cell.rowSpan || 1);
        var info = { cell: cell, row: r, col: col, rowSpan: rs, colSpan: cs };
        var maxR = Math.min(r + rs, domRows.length);
        for (var rr = r; rr < maxR; rr++) {
          rows[rr] = rows[rr] || [];
          for (var cc = col; cc < col + cs; cc++) { rows[rr][cc] = info; }
        }
        col += cs;
      }
    }
    var width = 0;
    for (r = 0; r < rows.length; r++) { width = Math.max(width, rows[r].length); }
    return { table: table, rows: rows, width: width, height: domRows.length };
  }

  function infoOf(grid, cell) {
    for (var r = 0; r < grid.rows.length; r++) {
      for (var c = 0; c < grid.rows[r].length; c++) {
        var info = grid.rows[r][c];
        if (info && info.cell === cell) { return info; }
      }
    }
    return null;
  }

  /** Unique cell infos inside a grid rectangle (inclusive bounds). */
  function uniqueInfosInRect(grid, rect) {
    var out = [];
    for (var r = rect.r1; r <= rect.r2; r++) {
      for (var c = rect.c1; c <= rect.c2; c++) {
        var info = grid.rows[r] && grid.rows[r][c];
        if (info && out.indexOf(info) === -1) { out.push(info); }
      }
    }
    return out;
  }

  /** Smallest rectangle covering the given cells, expanded over spans. */
  function rectOfCells(grid, cells) {
    var r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1, found = false;
    cells.forEach(function (cell) {
      var info = infoOf(grid, cell);
      if (!info) { return; }
      found = true;
      r1 = Math.min(r1, info.row);
      c1 = Math.min(c1, info.col);
      r2 = Math.max(r2, info.row + info.rowSpan - 1);
      c2 = Math.max(c2, info.col + info.colSpan - 1);
    });
    if (!found) { return null; }
    var changed = true;
    while (changed) {
      changed = false;
      for (var r = r1; r <= r2; r++) {
        for (var c = c1; c <= c2; c++) {
          var info = grid.rows[r] && grid.rows[r][c];
          if (!info) { continue; }
          if (info.row < r1) { r1 = info.row; changed = true; }
          if (info.col < c1) { c1 = info.col; changed = true; }
          if (info.row + info.rowSpan - 1 > r2) { r2 = info.row + info.rowSpan - 1; changed = true; }
          if (info.col + info.colSpan - 1 > c2) { c2 = info.col + info.colSpan - 1; changed = true; }
        }
      }
    }
    r2 = Math.min(r2, grid.height - 1);
    c2 = Math.min(c2, grid.width - 1);
    return { r1: r1, c1: c1, r2: r2, c2: c2 };
  }

  /** First cell that STARTS in row r at a column greater than `col`. */
  function firstCellStartingAfter(grid, r, col) {
    var seen = [];
    for (var c = 0; c < grid.width; c++) {
      var info = grid.rows[r] && grid.rows[r][c];
      if (!info || seen.indexOf(info) !== -1) { continue; }
      seen.push(info);
      if (info.row === r && info.col > col) { return info.cell; }
    }
    return null;
  }

  /* --------------------------------------------- rectangular selection --- */

  /* Selected cells carry ONLY the he-cell-selected class: it is styled by
   * the editor-only stylesheet injected into the iframe below, ignored by
   * the mutation observer (class changes never mark the document dirty)
   * and stripped from the output by HE.serialize. No inline styles, no
   * bookkeeping attributes — nothing to sweep at save time. */

  var cellSelection = [];   // plain array of selected cell elements
  var selectionAnchor = null;

  function selectedCells() {
    return cellSelection.slice();
  }

  function clearCellSelection() {
    cellSelection.forEach(function (cell) {
      if (cell.classList) { HE.unmark(cell, 'he-cell-selected'); }
    });
    cellSelection = [];
  }

  function applyCellSelection(cells) {
    clearCellSelection();
    cells.forEach(function (cell) {
      cellSelection.push(cell);
      cell.classList.add('he-cell-selected');
    });
  }

  function selectRectangle(a, b) {
    var table = closestTable(a);
    if (!table || closestTable(b) !== table) { return; }
    var grid = buildGrid(table);
    var rect = rectOfCells(grid, [a, b]);
    if (!rect) { return; }
    applyCellSelection(uniqueInfosInRect(grid, rect).map(function (i) { return i.cell; }));
  }

  /** Drop dead references and clean stale markers left by undo/redo. */
  function pruneCellSelection() {
    cellSelection = cellSelection.filter(function (cell) { return cell.isConnected; });
    var d = HE.doc();
    if (!d) { return; }
    var live = selectedCells();
    Array.prototype.slice.call(d.querySelectorAll('.he-cell-selected')).forEach(function (cell) {
      if (live.indexOf(cell) !== -1) { return; }
      HE.unmark(cell, 'he-cell-selected');
    });
  }

  /* ------------------------------------------------- caret / selection --- */

  function caretCell() {
    var w = HE.win();
    var d = HE.doc();
    if (!w || !d) { return null; }
    var sel = w.getSelection();
    if (!sel || !sel.rangeCount) { return null; }
    var node = sel.anchorNode;
    if (!node) { return null; }
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !d.body || !d.body.contains(el)) { return null; }
    return closestCell(el);
  }

  function activeTable() {
    var cells = selectedCells();
    if (cells.length && cells[0].isConnected) { return closestTable(cells[0]); }
    var cell = caretCell();
    if (cell) { return closestTable(cell); }
    if (HE.selected && HE.selected.isConnected) { return closestTable(HE.selected); }
    return null;
  }

  /** Cells the next operation should act on: the rectangle, or the caret. */
  function targetCells() {
    var cells = selectedCells().filter(function (c) { return c.isConnected; });
    if (cells.length) { return cells; }
    var cell = caretCell();
    return cell ? [cell] : [];
  }

  function focusCell(cell, selectContents) {
    var d = HE.doc();
    var w = HE.win();
    if (!d || !w || !cell) { return; }
    if (!cell.firstChild) { cell.appendChild(d.createElement('br')); }
    var range = d.createRange();
    var lonelyBr = cell.childNodes.length === 1 && cell.firstChild.nodeName === 'BR';
    range.selectNodeContents(cell);
    if (lonelyBr) { range.collapse(true); }
    else if (!selectContents) { range.collapse(false); }
    var sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (d.body && d.body.focus) { d.body.focus(); }
  }

  /* --------------------------------------------------- structural ops ---- */

  /**
   * Inserts a row at grid row `r` (before or after it). Cells spanning
   * across the insertion line grow their rowspan instead of getting split.
   * Returns the new <tr>.
   */
  function insertRowAt(table, r, before) {
    var grid = buildGrid(table);
    if (!grid.height) { return null; }
    r = Math.max(0, Math.min(r, grid.height - 1));
    var refTr = table.rows[r];
    // "Insert below" on the last header row should land in the body, using
    // the first body row as the style reference.
    if (!before && refTr.parentElement && refTr.parentElement.tagName === 'THEAD' &&
        !refTr.nextElementSibling && table.rows[r + 1]) {
      return insertRowAt(table, r + 1, true);
    }
    var doc = table.ownerDocument;
    var tr = doc.createElement('tr');
    var done = [];
    for (var c = 0; c < grid.width; c++) {
      var cover = grid.rows[r] ? grid.rows[r][c] : null;
      if (!cover) { tr.appendChild(freshCell(doc, 'td')); continue; }
      if (done.indexOf(cover) !== -1) { continue; }
      done.push(cover);
      var spansAcross = before
        ? (cover.row < r)
        : (cover.row + cover.rowSpan - 1 > r);
      if (spansAcross) {
        setSpan(cover.cell, 'rowspan', cover.rowSpan + 1);
      } else {
        for (var k = 0; k < cover.colSpan; k++) { tr.appendChild(freshCellLike(cover.cell)); }
      }
    }
    refTr.parentElement.insertBefore(tr, before ? refTr : refTr.nextSibling);
    return tr;
  }

  /**
   * Inserts a column left/right of the column the cell occupies. Cells
   * spanning across the line grow their colspan; the new cell mirrors the
   * rowspan of its neighbour so the grid stays rectangular.
   */
  function insertColumnAt(table, refInfo, before) {
    var grid = buildGrid(table);
    var c = before ? refInfo.col : refInfo.col + refInfo.colSpan - 1;
    var done = [];
    for (var r = 0; r < grid.height; r++) {
      var cover = grid.rows[r] ? grid.rows[r][c] : null;
      if (!cover) {
        if (table.rows[r]) { table.rows[r].appendChild(freshCell(table.ownerDocument, 'td')); }
        continue;
      }
      if (done.indexOf(cover) !== -1) { continue; }
      done.push(cover);
      var spansAcross = before
        ? (cover.col < c)
        : (cover.col + cover.colSpan - 1 > c);
      if (spansAcross) {
        setSpan(cover.cell, 'colspan', cover.colSpan + 1);
      } else {
        var fresh = freshCellLike(cover.cell);
        if (cover.rowSpan > 1) { setSpan(fresh, 'rowspan', cover.rowSpan); }
        cover.cell.parentElement.insertBefore(fresh, before ? cover.cell : cover.cell.nextSibling);
      }
    }
  }

  function deleteRowAt(table, r) {
    var grid = buildGrid(table);
    if (r < 0 || r >= grid.height) { return; }
    var done = [];
    for (var c = 0; c < grid.width; c++) {
      var info = grid.rows[r] ? grid.rows[r][c] : null;
      if (!info || done.indexOf(info) !== -1) { continue; }
      done.push(info);
      if (info.row < r) {
        setSpan(info.cell, 'rowspan', info.rowSpan - 1);
      } else if (info.rowSpan > 1 && table.rows[r + 1]) {
        // The cell starts here but spans further down: move it to the next
        // row with one less rowspan so its content survives.
        setSpan(info.cell, 'rowspan', info.rowSpan - 1);
        var ref = firstCellStartingAfter(grid, r + 1, info.col);
        table.rows[r + 1].insertBefore(info.cell, ref);
      }
    }
    var tr = table.rows[r];
    var section = tr.parentElement;
    tr.remove();
    if (section && section !== table && !section.children.length) { section.remove(); }
    if (!table.rows.length) { removeTableNode(table); }
  }

  function deleteColumnAt(table, col) {
    var grid = buildGrid(table);
    if (col < 0 || col >= grid.width) { return; }
    if (grid.width === 1) { removeTableNode(table); return; }
    var done = [];
    for (var r = 0; r < grid.height; r++) {
      var info = grid.rows[r] ? grid.rows[r][col] : null;
      if (!info || done.indexOf(info) !== -1) { continue; }
      done.push(info);
      if (info.colSpan > 1) { setSpan(info.cell, 'colspan', info.colSpan - 1); }
      else { info.cell.remove(); }
    }
    Array.prototype.slice.call(table.rows).forEach(function (tr) {
      if (!tr.cells.length) { tr.remove(); }
    });
    if (!table.rows.length) { removeTableNode(table); }
  }

  function removeTableNode(table) {
    clearCellSelection();
    if (HE.selected && table.contains(HE.selected)) { HE.select(null); }
    table.remove();
    hideToolbar();
  }

  function mergeSelection(table) {
    var cells = selectedCells().filter(function (c) { return c.isConnected && closestTable(c) === table; });
    if (cells.length < 2) {
      HE.toast(HE.t('table.selectCells', 'Drag across cells first, then merge'), 'warn');
      return;
    }
    var grid = buildGrid(table);
    var rect = rectOfCells(grid, cells);
    if (!rect) { return; }
    var infos = uniqueInfosInRect(grid, rect);
    var target = null;
    infos.forEach(function (info) {
      if (info.row === rect.r1 && info.col === rect.c1) { target = info.cell; }
    });
    if (!target) { target = infos[0].cell; }
    HE.edit(function () {
      var doc = table.ownerDocument;
      infos.forEach(function (info) {
        if (info.cell === target) { return; }
        if (cellHasContent(info.cell)) {
          target.appendChild(doc.createTextNode(' '));
          while (info.cell.firstChild) { target.appendChild(info.cell.firstChild); }
        }
        info.cell.remove();
      });
      setSpan(target, 'colspan', rect.c2 - rect.c1 + 1);
      setSpan(target, 'rowspan', rect.r2 - rect.r1 + 1);
      if (!target.firstChild) { target.appendChild(doc.createElement('br')); }
    });
    clearCellSelection();
    focusCell(target);
  }

  function splitCell(cell) {
    var table = closestTable(cell);
    if (!table) { return; }
    var grid = buildGrid(table);
    var info = infoOf(grid, cell);
    if (!info || (info.colSpan === 1 && info.rowSpan === 1)) {
      HE.toast(HE.t('table.nothingToSplit', 'This cell is not merged'), 'warn');
      return;
    }
    HE.edit(function () {
      cell.removeAttribute('colspan');
      cell.removeAttribute('rowspan');
      var k, rr;
      var anchor = cell;
      for (k = 1; k < info.colSpan; k++) {
        var extra = freshCellLike(cell);
        insertAfter(extra, anchor);
        anchor = extra;
      }
      for (rr = info.row + 1; rr < info.row + info.rowSpan; rr++) {
        var tr = table.rows[rr];
        if (!tr) { continue; }
        var ref = firstCellStartingAfter(grid, rr, info.col);
        for (k = 0; k < info.colSpan; k++) { tr.insertBefore(freshCellLike(cell), ref); }
      }
    });
    clearCellSelection();
    focusCell(cell);
  }

  function toggleHeaderRow(table) {
    HE.edit(function () {
      var doc = table.ownerDocument;
      var thead = table.tHead;
      if (thead) {
        var tbody = table.tBodies[0];
        if (!tbody) {
          tbody = doc.createElement('tbody');
          insertAfter(tbody, thead);
        }
        var moved = Array.prototype.slice.call(thead.rows);
        for (var i = moved.length - 1; i >= 0; i--) {
          Array.prototype.slice.call(moved[i].cells).forEach(function (cell) {
            var td = convertCellTag(cell, 'td');
            td.style.backgroundColor = '';
            if (!td.getAttribute('style')) { td.removeAttribute('style'); }
          });
          tbody.insertBefore(moved[i], tbody.firstChild);
        }
        thead.remove();
      } else {
        var first = table.rows[0];
        if (!first) { return; }
        Array.prototype.slice.call(first.cells).forEach(function (cell) {
          var th = convertCellTag(cell, 'th');
          if (!th.style.backgroundColor) { th.style.backgroundColor = '#f2f2f2'; }
          if (!th.style.textAlign) { th.style.textAlign = 'left'; }
        });
        var head = doc.createElement('thead');
        head.appendChild(first);
        table.insertBefore(head, table.tBodies[0] || table.rows[0] || null);
      }
    });
  }

  function distributeColumns(table) {
    var grid = buildGrid(table);
    if (!grid.width) { return; }
    var pct = 100 / grid.width;
    HE.edit(function () {
      Array.prototype.slice.call(table.querySelectorAll('col')).forEach(function (colEl) {
        colEl.style.width = '';
        colEl.removeAttribute('width');
      });
      var done = [];
      for (var r = 0; r < grid.height; r++) {
        for (var c = 0; c < grid.width; c++) {
          var info = grid.rows[r] ? grid.rows[r][c] : null;
          if (!info || done.indexOf(info) !== -1) { continue; }
          done.push(info);
          info.cell.style.width = (pct * info.colSpan).toFixed(2) + '%';
          info.cell.removeAttribute('width');
        }
      }
    });
  }

  function setCellStyle(cells, prop, value) {
    if (!cells.length) { return; }
    HE.edit(function () {
      cells.forEach(function (cell) {
        cell.style[prop] = value;
        if (!cell.getAttribute('style')) { cell.removeAttribute('style'); }
      });
    });
  }

  /* -------------------------------------------------------- border modal -- */

  function openBorderDialog(table, cells) {
    var wholeTable = !cells || cells.length < 2;
    var targets = wholeTable ? ownCells(table) : cells;

    var styleSel = HE.el('select', { class: 'ctl ctl--select' }, [
      HE.el('option', { value: 'thin', text: HE.t('table.borderThin', 'Thin') }),
      HE.el('option', { value: 'solid', text: HE.t('table.borderSolid', 'Solid') }),
      HE.el('option', { value: 'none', text: HE.t('common.none', 'None') })
    ]);
    var colorIn = HE.el('input', { type: 'color', value: '#cccccc' });

    var body = HE.el('div', { class: 'table-dialog' }, [
      field(HE.t('table.border', 'Border'), styleSel),
      field(HE.t('table.borderColor', 'Colour'), colorIn)
    ]);

    var modal = HE.modal({
      title: HE.t('table.borders', 'Borders'),
      body: body,
      actions: [
        { label: HE.t('common.cancel', 'Cancel'), onClick: function (close) { close(); } },
        {
          label: HE.t('props.apply', 'Apply'), primary: true,
          onClick: function (close) {
            var style = styleSel.value;
            var css = style === 'none' ? '' :
              (style === 'solid' ? '2px solid ' : '1px solid ') + colorIn.value;
            HE.edit(function () {
              targets.forEach(function (cell) {
                cell.style.border = css;
                if (!cell.getAttribute('style')) { cell.removeAttribute('style'); }
              });
              table.style.borderCollapse = 'collapse';
              if (wholeTable) {
                // he- class: dotted guides in the editor, stripped on save.
                table.classList.toggle('he-empty-borders', style === 'none');
                if (!table.getAttribute('class')) { table.removeAttribute('class'); }
              }
            });
            close();
          }
        }
      ]
    });
    return modal;
  }

  function openTableProperties(table) {
    if (HE.props && typeof HE.props.openElement === 'function') {
      HE.props.openElement(table);
    } else {
      openBorderDialog(table, null);
    }
  }

  /* --------------------------------------------------------- insertion --- */

  function buildTable(doc, rows, cols, o) {
    var table = doc.createElement('table');
    table.style.borderCollapse = 'collapse';
    if (o.width === '100%' || o.width === undefined) { table.style.width = '100%'; }
    else if (o.width !== 'auto') {
      var px = parseInt(o.width, 10);
      if (px > 0) { table.style.width = px + 'px'; }
    }
    var borderCss = o.border === 'none' ? '' :
      (o.border === 'solid' ? '2px solid #333333' : '1px solid #cccccc');
    if (!borderCss) { table.className = 'he-empty-borders'; }

    var pad = parseInt(o.padding, 10);
    if (isNaN(pad) || pad < 0) { pad = 6; }

    function makeCell(tag) {
      var cell = doc.createElement(tag);
      if (borderCss) { cell.style.border = borderCss; }
      cell.style.padding = pad + 'px';
      if (tag === 'th') {
        cell.style.textAlign = 'left';
        cell.style.backgroundColor = '#f2f2f2';
      }
      cell.innerHTML = '<br>';
      return cell;
    }

    if (o.caption) {
      var caption = doc.createElement('caption');
      caption.textContent = o.caption;
      table.appendChild(caption);
    }

    var c, r, tr;
    if (o.headerRow) {
      var thead = doc.createElement('thead');
      tr = doc.createElement('tr');
      for (c = 0; c < cols; c++) { tr.appendChild(makeCell('th')); }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    var tbody = doc.createElement('tbody');
    var bodyRows = o.headerRow ? rows - 1 : rows;
    if (bodyRows < 1) { bodyRows = 1; }
    for (r = 0; r < bodyRows; r++) {
      tr = doc.createElement('tr');
      if (o.striped && r % 2 === 1) { tr.style.backgroundColor = '#f7f7f7'; }
      for (c = 0; c < cols; c++) {
        tr.appendChild(makeCell(o.headerCol && c === 0 ? 'th' : 'td'));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  /** Drops the node near the caret: after the closest block, inside cells. */
  function placeAtCaret(node) {
    var d = HE.doc();
    var w = HE.win();
    var anchorEl = null;
    var range = null;
    var sel = w && w.getSelection();
    if (sel && sel.rangeCount) {
      range = sel.getRangeAt(0);
      var n = range.startContainer;
      anchorEl = n.nodeType === 1 ? n : n.parentElement;
    }
    if (anchorEl && (!d.body.contains(anchorEl))) { anchorEl = null; }

    if (anchorEl === d.body && range) {
      d.body.insertBefore(node, d.body.childNodes[range.startOffset] || null);
      return;
    }
    var block = anchorEl;
    while (block && block !== d.body && !isBlock(block)) { block = block.parentElement; }
    if (!block || block === d.body) {
      d.body.appendChild(node);
    } else if (block.tagName === 'TD' || block.tagName === 'TH' || block.tagName === 'LI') {
      block.appendChild(node);
    } else {
      insertAfter(node, block);
    }
  }

  function doInsert(rows, cols, options) {
    rows = Math.max(1, parseInt(rows, 10) || 1);
    cols = Math.max(1, parseInt(cols, 10) || 1);
    var d = HE.doc();
    if (!d || !d.body) { return null; }
    var table = HE.edit(function () {
      var t = buildTable(d, rows, cols, options || {});
      placeAtCaret(t);
      // Keep a paragraph after a table that lands at the very end of the
      // body, otherwise there is nowhere to click below it.
      if (t.parentElement === d.body && !t.nextElementSibling) {
        var p = d.createElement('p');
        p.innerHTML = '<br>';
        insertAfter(p, t);
      }
      return t;
    });
    if (table) {
      var first = table.querySelector('th, td');
      if (first) { focusCell(first); }
      scheduleToolbarUpdate();
    }
    return table || null;
  }

  /* ------------------------------------------------------ insert dialog -- */

  function field(name, input) {
    return HE.el('label', { class: 'table-dialog__field' }, [
      HE.el('span', { class: 'table-dialog__name', text: name }),
      input
    ]);
  }

  function openInsertDialog() {
    var modal;

    /* Word-style hover grid picker: 10x10, hover highlights n×m, click inserts. */
    var PICKER = 10;
    var label = HE.el('div', { class: 'table-picker__label', text: '3 × 3' });
    var gridEl = HE.el('div', { class: 'table-picker__grid' });
    gridEl.style.display = 'grid';
    gridEl.style.gridTemplateColumns = 'repeat(' + PICKER + ', 16px)';
    gridEl.style.gap = '3px';
    gridEl.style.justifyContent = 'start';
    var pickCells = [];

    function paint(rows, cols) {
      pickCells.forEach(function (n) {
        var on = n.__r < rows && n.__c < cols;
        n.classList.toggle('is-on', on);
        n.style.background = on ? '#7db8ff' : '';
        n.style.borderColor = on ? '#4a90e2' : '#c3c3c8';
      });
      label.textContent = cols + ' × ' + rows;
    }

    var rowsIn = HE.el('input', { type: 'number', min: '1', max: '500', value: '3', class: 'ctl' });
    var colsIn = HE.el('input', { type: 'number', min: '1', max: '100', value: '3', class: 'ctl' });

    for (var r = 0; r < PICKER; r++) {
      for (var c = 0; c < PICKER; c++) {
        (function (r, c) {
          var cellEl = HE.el('div', { class: 'table-picker__cell' });
          cellEl.__r = r;
          cellEl.__c = c;
          cellEl.style.width = '14px';
          cellEl.style.height = '14px';
          cellEl.style.border = '1px solid #c3c3c8';
          cellEl.style.borderRadius = '2px';
          cellEl.style.cursor = 'pointer';
          cellEl.addEventListener('mouseenter', function () {
            rowsIn.value = String(r + 1);
            colsIn.value = String(c + 1);
            paint(r + 1, c + 1);
          });
          cellEl.addEventListener('click', function () { commit(); });
          gridEl.appendChild(cellEl);
          pickCells.push(cellEl);
        })(r, c);
      }
    }
    paint(3, 3);

    var headerRowIn = HE.el('input', { type: 'checkbox', checked: 'checked' });
    var headerColIn = HE.el('input', { type: 'checkbox' });
    var stripedIn = HE.el('input', { type: 'checkbox' });
    var widthSel = HE.el('select', { class: 'ctl ctl--select' }, [
      HE.el('option', { value: '100%', text: '100%' }),
      HE.el('option', { value: 'auto', text: HE.t('common.default', 'Default') }),
      HE.el('option', { value: 'px', text: 'px' })
    ]);
    var widthPx = HE.el('input', { type: 'number', min: '50', max: '4000', value: '600', class: 'ctl' });
    widthPx.style.display = 'none';
    widthSel.addEventListener('change', function () {
      widthPx.style.display = widthSel.value === 'px' ? '' : 'none';
    });
    var widthWrap = HE.el('span', { class: 'table-dialog__width' }, [widthSel, widthPx]);
    var borderSel = HE.el('select', { class: 'ctl ctl--select' }, [
      HE.el('option', { value: 'thin', text: HE.t('table.borderThin', 'Thin') }),
      HE.el('option', { value: 'solid', text: HE.t('table.borderSolid', 'Solid') }),
      HE.el('option', { value: 'none', text: HE.t('common.none', 'None') })
    ]);
    var padIn = HE.el('input', { type: 'number', min: '0', max: '64', value: '6', class: 'ctl' });
    var captionIn = HE.el('input', { type: 'text', value: '', class: 'ctl' });

    var fields = HE.el('div', { class: 'table-dialog__fields' }, [
      field(HE.t('table.rows', 'Rows'), rowsIn),
      field(HE.t('table.columns', 'Columns'), colsIn),
      field(HE.t('table.headerRow', 'Header row'), headerRowIn),
      field(HE.t('table.headerCol', 'Header column'), headerColIn),
      field(HE.t('table.width', 'Width'), widthWrap),
      field(HE.t('table.border', 'Border'), borderSel),
      field(HE.t('table.padding', 'Cell padding'), padIn),
      field(HE.t('table.striped', 'Striped rows'), stripedIn),
      field(HE.t('table.caption', 'Caption'), captionIn)
    ]);
    fields.style.display = 'grid';
    fields.style.gridTemplateColumns = '1fr 1fr';
    fields.style.gap = '8px 16px';
    fields.style.marginTop = '12px';

    var picker = HE.el('div', { class: 'table-picker' }, [gridEl, label]);
    var body = HE.el('div', { class: 'table-dialog' }, [picker, fields]);

    function commit() {
      var options = {
        headerRow: headerRowIn.checked,
        headerCol: headerColIn.checked,
        striped: stripedIn.checked,
        width: widthSel.value === 'px' ? (parseInt(widthPx.value, 10) || 600) : widthSel.value,
        border: borderSel.value,
        padding: padIn.value,
        caption: captionIn.value.replace(/^\s+|\s+$/g, '')
      };
      var rows = parseInt(rowsIn.value, 10) || 3;
      var cols = parseInt(colsIn.value, 10) || 3;
      modal.close();
      doInsert(rows, cols, options);
    }

    modal = HE.modal({
      title: HE.t('table.insert', 'Insert table'),
      body: body,
      width: '460px',
      actions: [
        { label: HE.t('common.cancel', 'Cancel'), onClick: function (close) { close(); } },
        { label: HE.t('table.insert', 'Insert table'), primary: true, onClick: function () { commit(); } }
      ]
    });
    return modal;
  }

  /* ---------------------------------------------------------------- icons -- */

  function svg(content) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + content + '</svg>';
  }

  var ICONS = {
    table: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 9.6h17M3.5 14.3h17M9.8 5v14M15 5v14" stroke-width="1.4"/>'),
    rowAbove: svg('<rect x="4" y="13" width="16" height="7" rx="1"/><path d="M12 10V3M9 6l3-3 3 3"/>'),
    rowBelow: svg('<rect x="4" y="4" width="16" height="7" rx="1"/><path d="M12 14v7M9 18l3 3 3-3"/>'),
    colLeft: svg('<rect x="13" y="4" width="7" height="16" rx="1"/><path d="M10 12H3M6 9l-3 3 3 3"/>'),
    colRight: svg('<rect x="4" y="4" width="7" height="16" rx="1"/><path d="M14 12h7M18 9l3 3-3 3"/>'),
    delRow: svg('<rect x="3" y="9" width="12" height="6" rx="1"/><path d="M17.5 9.5 22 14.5M22 9.5l-4.5 5"/>'),
    delCol: svg('<rect x="9" y="3" width="6" height="12" rx="1"/><path d="M9.5 17.5 14.5 22M9.5 22l5-4.5"/>'),
    delTable: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 10h17M9.5 5v14" stroke-width="1.4"/><path d="m13.5 12.5 5.5 5.5M19 12.5 13.5 18" stroke-width="2.2"/>'),
    merge: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M5.5 12h4M7.5 10l2 2-2 2M18.5 12h-4M16.5 10l-2 2 2 2"/>'),
    split: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 5v14" stroke-dasharray="2.4 2"/><path d="M9.5 12h-4M7.5 10l-2 2 2 2M14.5 12h4M16.5 10l2 2-2 2"/>'),
    header: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 10h17" stroke-width="1.4"/><rect x="4.5" y="6" width="15" height="3" fill="currentColor" stroke="none" opacity=".5"/>'),
    distribute: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M9.17 5v14M14.83 5v14" stroke-width="1.4"/>'),
    alignLeft: svg('<path d="M4 7h16M4 12h9M4 17h16" stroke-width="2"/>'),
    alignCenter: svg('<path d="M4 7h16M7.5 12h9M4 17h16" stroke-width="2"/>'),
    alignRight: svg('<path d="M4 7h16M11 12h9M4 17h16" stroke-width="2"/>'),
    vTop: svg('<path d="M4 4.5h16" stroke-width="2"/><path d="M12 20V8.5M9 11.5l3-3 3 3"/>'),
    vMiddle: svg('<path d="M4 12h16" stroke-width="2"/><path d="M12 3.5V8M9.5 6 12 8.5 14.5 6M12 20.5V16M9.5 18l2.5-2.5L14.5 18"/>'),
    vBottom: svg('<path d="M4 19.5h16" stroke-width="2"/><path d="M12 4v11.5M9 12.5l3 3 3-3"/>'),
    background: svg('<path d="M12 3.5s5.5 6.6 5.5 10a5.5 5.5 0 0 1-11 0c0-3.4 5.5-10 5.5-10z"/><path d="M9 14a3 3 0 0 0 3 3" stroke-width="1.4"/>'),
    borders: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1.5" stroke-dasharray="3 2.4"/><path d="M12 7v10M7 12h10" stroke-width="1.4"/>'),
    props: svg('<circle cx="12" cy="12" r="3.2" stroke-width="2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" stroke-width="2"/>')
  };

  /* --------------------------------------------------- floating toolbar -- */

  var toolbarEl = null;
  var tbTable = null;         // table the toolbar is currently anchored to
  var bgInput = null;         // hidden colour input for cell backgrounds
  var bgTargets = [];

  /** Resolves the table/cell/cells the next toolbar action applies to. */
  function opContext() {
    var table = (tbTable && tbTable.isConnected) ? tbTable : activeTable();
    if (!table) { return null; }
    var cells = targetCells().filter(function (c) { return closestTable(c) === table; });
    var cell = cells[0] || table.querySelector('th, td');
    if (!cell) { return null; }
    return { table: table, cell: cell, cells: cells.length ? cells : [cell] };
  }

  function opRow(ctx, before) {
    var grid = buildGrid(ctx.table);
    var info = infoOf(grid, ctx.cell);
    if (!info) { return; }
    HE.edit(function () {
      insertRowAt(ctx.table, before ? info.row : info.row + info.rowSpan - 1, before);
    });
    clearCellSelection();
  }

  function opCol(ctx, before) {
    var grid = buildGrid(ctx.table);
    var info = infoOf(grid, ctx.cell);
    if (!info) { return; }
    HE.edit(function () { insertColumnAt(ctx.table, info, before); });
    clearCellSelection();
  }

  function opDeleteRow(ctx) {
    var grid = buildGrid(ctx.table);
    var info = infoOf(grid, ctx.cell);
    if (!info) { return; }
    HE.edit(function () { deleteRowAt(ctx.table, info.row); });
    clearCellSelection();
  }

  function opDeleteCol(ctx) {
    var grid = buildGrid(ctx.table);
    var info = infoOf(grid, ctx.cell);
    if (!info) { return; }
    HE.edit(function () { deleteColumnAt(ctx.table, info.col); });
    clearCellSelection();
  }

  function opDeleteTable(ctx) {
    HE.edit(function () { removeTableNode(ctx.table); });
  }

  var BUTTONS = [
    { key: 'table.rowAbove', fallback: 'Insert row above', icon: 'rowAbove', run: function (ctx) { opRow(ctx, true); } },
    { key: 'table.rowBelow', fallback: 'Insert row below', icon: 'rowBelow', run: function (ctx) { opRow(ctx, false); } },
    { key: 'table.colLeft', fallback: 'Insert column left', icon: 'colLeft', run: function (ctx) { opCol(ctx, true); } },
    { key: 'table.colRight', fallback: 'Insert column right', icon: 'colRight', run: function (ctx) { opCol(ctx, false); } },
    { sep: true },
    { key: 'table.merge', fallback: 'Merge cells', icon: 'merge', run: function (ctx) { mergeSelection(ctx.table); } },
    { key: 'table.split', fallback: 'Split cell', icon: 'split', run: function (ctx) { splitCell(ctx.cell); } },
    { sep: true },
    { key: 'table.toggleHeader', fallback: 'Toggle header row', icon: 'header', run: function (ctx) { toggleHeaderRow(ctx.table); } },
    { key: 'table.distribute', fallback: 'Distribute columns evenly', icon: 'distribute', run: function (ctx) { distributeColumns(ctx.table); } },
    { sep: true },
    { key: 'toolbar.alignLeft', fallback: 'Align left', icon: 'alignLeft', run: function (ctx) { setCellStyle(ctx.cells, 'textAlign', 'left'); } },
    { key: 'toolbar.alignCenter', fallback: 'Align centre', icon: 'alignCenter', run: function (ctx) { setCellStyle(ctx.cells, 'textAlign', 'center'); } },
    { key: 'toolbar.alignRight', fallback: 'Align right', icon: 'alignRight', run: function (ctx) { setCellStyle(ctx.cells, 'textAlign', 'right'); } },
    { key: 'table.vTop', fallback: 'Align top', icon: 'vTop', run: function (ctx) { setCellStyle(ctx.cells, 'verticalAlign', 'top'); } },
    { key: 'table.vMiddle', fallback: 'Align middle', icon: 'vMiddle', run: function (ctx) { setCellStyle(ctx.cells, 'verticalAlign', 'middle'); } },
    { key: 'table.vBottom', fallback: 'Align bottom', icon: 'vBottom', run: function (ctx) { setCellStyle(ctx.cells, 'verticalAlign', 'bottom'); } },
    { sep: true },
    { key: 'table.cellBackground', fallback: 'Cell background colour', icon: 'background', run: function (ctx) { pickBackground(ctx.cells); } },
    { key: 'table.borders', fallback: 'Border settings', icon: 'borders', run: function (ctx) { openBorderDialog(ctx.table, ctx.cells); } },
    { key: 'menu.properties', fallback: 'Properties…', icon: 'props', run: function (ctx) { openTableProperties(ctx.table); } },
    { sep: true },
    { key: 'table.delRow', fallback: 'Delete row', icon: 'delRow', run: opDeleteRow },
    { key: 'table.delCol', fallback: 'Delete column', icon: 'delCol', run: opDeleteCol },
    { key: 'table.delTable', fallback: 'Delete table', icon: 'delTable', danger: true, run: opDeleteTable }
  ];

  function pickBackground(cells) {
    if (!bgInput) { return; }
    bgTargets = cells;
    var current = cells[0] && cells[0].style.backgroundColor;
    if (current) {
      // <input type=color> only accepts #rrggbb; best effort conversion.
      var m = current.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (m) {
        bgInput.value = '#' + [m[1], m[2], m[3]].map(function (v) {
          return ('0' + parseInt(v, 10).toString(16)).slice(-2);
        }).join('');
      }
    }
    bgInput.click();
  }

  function ensureToolbar() {
    var layer = document.getElementById('layer');
    if (!layer) { return null; }
    if (toolbarEl && layer.contains(toolbarEl)) { return toolbarEl; }

    toolbarEl = HE.el('div', { class: 'table-toolbar' });
    toolbarEl.style.position = 'absolute';
    toolbarEl.style.zIndex = '40';
    toolbarEl.style.display = 'none';
    toolbarEl.style.pointerEvents = 'auto';
    toolbarEl.style.flexWrap = 'wrap';
    // Keep the iframe selection alive when clicking toolbar buttons.
    toolbarEl.addEventListener('mousedown', function (event) { event.preventDefault(); });

    BUTTONS.forEach(function (def) {
      if (def.sep) {
        toolbarEl.appendChild(HE.el('span', { class: 'table-toolbar__sep' }));
        return;
      }
      var btn = HE.el('button', {
        class: 'btn btn--tool table-toolbar__btn' + (def.danger ? ' table-toolbar__btn--danger' : ''),
        type: 'button',
        title: HE.t(def.key, def.fallback),
        html: ICONS[def.icon] || ''
      });
      btn.addEventListener('click', function () {
        var ctx = opContext();
        if (!ctx) { return; }
        def.run(ctx);
        scheduleToolbarUpdate();
      });
      toolbarEl.appendChild(btn);
    });

    bgInput = HE.el('input', { type: 'color', class: 'table-toolbar__color', value: '#fff3bf' });
    bgInput.style.position = 'absolute';
    bgInput.style.width = '1px';
    bgInput.style.height = '1px';
    bgInput.style.opacity = '0';
    bgInput.style.pointerEvents = 'none';
    bgInput.addEventListener('change', function () {
      var cells = bgTargets.filter(function (c) { return c.isConnected; });
      if (cells.length) { setCellStyle(cells, 'backgroundColor', bgInput.value); }
    });
    toolbarEl.appendChild(bgInput);

    layer.appendChild(toolbarEl);
    return toolbarEl;
  }

  function positionToolbar() {
    if (!toolbarEl || !tbTable) { return; }
    if (!tbTable.isConnected) { hideToolbar(); return; }
    var layer = document.getElementById('layer');
    if (!layer) { return; }
    var lr = layer.getBoundingClientRect();
    var rect = HE.rectInHost(tbTable);
    if (!rect.width && !rect.height) { hideToolbar(); return; }

    toolbarEl.style.display = 'flex';
    var h = toolbarEl.offsetHeight || 36;
    var w = toolbarEl.offsetWidth || 300;
    var top = rect.top - lr.top - h - 8;
    if (top < 4) { top = rect.bottom - lr.top + 8; }
    var left = Math.max(4, Math.min(rect.left - lr.left, lr.width - w - 4));
    toolbarEl.style.top = Math.round(top) + 'px';
    toolbarEl.style.left = Math.round(left) + 'px';
  }

  function hideToolbar() {
    tbTable = null;
    if (toolbarEl) { toolbarEl.style.display = 'none'; }
  }

  var updateQueued = false;
  function scheduleToolbarUpdate() {
    if (updateQueued) { return; }
    updateQueued = true;
    requestAnimationFrame(function () {
      updateQueued = false;
      updateToolbar();
    });
  }

  function updateToolbar() {
    if (HE.readOnly) { hideToolbar(); return; }
    var table = activeTable();
    if (!table || !table.isConnected) { hideToolbar(); return; }
    if (!ensureToolbar()) { return; }
    tbTable = table;
    positionToolbar();
  }

  /* ------------------------------------------------------ column resize -- */

  var EDGE = 5; // px of tolerance around a cell border

  var resizing = null; // {table, col, startX, startWidth, edgeHostX, guide, cells}
  var dragging = null; // {table, anchor, moved}

  /** Detects whether the pointer sits on a column border in the first row. */
  function resizeHitTest(event) {
    var cell = closestCell(event.target);
    if (!cell) { return null; }
    var table = closestTable(cell);
    if (!table || !table.rows.length || cell.parentElement !== table.rows[0]) { return null; }
    var grid = buildGrid(table);
    var info = infoOf(grid, cell);
    if (!info) { return null; }
    var r = cell.getBoundingClientRect();
    if (event.clientX >= r.right - EDGE) {
      return { table: table, col: info.col + info.colSpan - 1 };
    }
    if (event.clientX <= r.left + EDGE && info.col > 0) {
      return { table: table, col: info.col - 1 };
    }
    return null;
  }

  /** Cells whose width defines this column (start at col, no colspan). */
  function columnWidthCells(table, col) {
    var grid = buildGrid(table);
    var out = [];
    var done = [];
    for (var r = 0; r < grid.height; r++) {
      var info = grid.rows[r] ? grid.rows[r][col] : null;
      if (!info || done.indexOf(info) !== -1) { continue; }
      done.push(info);
      if (info.col === col && info.colSpan === 1) { out.push(info.cell); }
    }
    return out;
  }

  function startResize(hit, event) {
    var cells = columnWidthCells(hit.table, hit.col);
    var measure = cells[0];
    if (!measure) {
      var grid = buildGrid(hit.table);
      var info = grid.rows[0] && grid.rows[0][hit.col];
      measure = info && info.cell;
    }
    if (!measure) { return; }
    var layer = document.getElementById('layer');
    var frame = HE.frame();
    if (!layer || !frame) { return; }
    var lr = layer.getBoundingClientRect();
    var cellRect = HE.rectInHost(measure);
    var tableRect = HE.rectInHost(hit.table);

    var guide = HE.el('div', { class: 'table-resize-guide' });
    guide.style.position = 'absolute';
    guide.style.top = Math.round(tableRect.top - lr.top) + 'px';
    guide.style.height = Math.round(tableRect.height) + 'px';
    guide.style.width = '2px';
    guide.style.background = '#4aa3ff';
    guide.style.zIndex = '39';
    guide.style.pointerEvents = 'none';
    layer.appendChild(guide);

    resizing = {
      table: hit.table,
      col: hit.col,
      cells: cells,
      startX: event.clientX,
      startWidth: measure.getBoundingClientRect().width,
      edgeHostX: cellRect.right,
      layerLeft: lr.left,
      frameLeft: frame.getBoundingClientRect().left,
      newWidth: null,
      guide: guide
    };
    resizeMove(event.clientX);
    window.addEventListener('mousemove', onHostResizeMove, true);
    window.addEventListener('mouseup', onHostResizeUp, true);
  }

  function resizeMove(frameClientX) {
    if (!resizing) { return; }
    var dx = frameClientX - resizing.startX;
    var width = Math.max(24, Math.round(resizing.startWidth + dx));
    resizing.newWidth = width;
    var clampedDx = width - resizing.startWidth;
    resizing.guide.style.left =
      Math.round(resizing.edgeHostX + clampedDx - resizing.layerLeft) + 'px';
  }

  function finishResize() {
    if (!resizing) { return; }
    var state = resizing;
    resizing = null;
    window.removeEventListener('mousemove', onHostResizeMove, true);
    window.removeEventListener('mouseup', onHostResizeUp, true);
    state.guide.remove();
    var body = HE.body();
    if (body) { body.classList.remove('he-col-resize'); }
    if (state.newWidth === null || Math.abs(state.newWidth - state.startWidth) < 2) { return; }
    HE.edit(function () {
      var cells = state.cells.filter(function (c) { return c.isConnected; });
      if (!cells.length) {
        var grid = buildGrid(state.table);
        var info = grid.rows[0] && grid.rows[0][state.col];
        if (info) { cells = [info.cell]; }
      }
      cells.forEach(function (cell) {
        cell.style.width = state.newWidth + 'px';
        cell.removeAttribute('width');
      });
    });
    scheduleToolbarUpdate();
  }

  /* Host-page handlers so the drag keeps working when the pointer leaves
   * the iframe. Coordinates are translated back into frame space. */
  function onHostResizeMove(event) {
    if (!resizing) { return; }
    resizeMove(event.clientX - resizing.frameLeft);
    event.preventDefault();
  }
  function onHostResizeUp() { finishResize(); }

  /* ------------------------------------------------------ mouse handlers -- */

  function onFrameMouseDown(event) {
    if (event.button !== 0) { return; }
    if (!HE.readOnly) {
      var hit = resizeHitTest(event);
      if (hit) {
        startResize(hit, event);
        event.preventDefault();
        return;
      }
    }
    var cell = closestCell(event.target);
    if (cell && event.shiftKey && selectionAnchor && selectionAnchor.isConnected &&
        closestTable(selectionAnchor) === closestTable(cell)) {
      selectRectangle(selectionAnchor, cell);
      event.preventDefault();
      scheduleToolbarUpdate();
      return;
    }
    clearCellSelection();
    if (cell) {
      selectionAnchor = cell;
      dragging = { table: closestTable(cell), anchor: cell, moved: false };
    } else {
      dragging = null;
    }
    scheduleToolbarUpdate();
  }

  function onFrameMouseMove(event) {
    if (resizing) {
      resizeMove(event.clientX);
      event.preventDefault();
      return;
    }
    if (dragging) {
      var cell = closestCell(event.target);
      if (cell && closestTable(cell) === dragging.table &&
          (cell !== dragging.anchor || dragging.moved)) {
        dragging.moved = true;
        selectRectangle(dragging.anchor, cell);
        var w = HE.win();
        var sel = w && w.getSelection();
        if (sel) { sel.removeAllRanges(); }
        event.preventDefault();
      }
      return;
    }
    // Hover feedback for the resize grip (he- class: stripped on save).
    var body = HE.body();
    if (!body || HE.readOnly) { return; }
    var hovering = !!resizeHitTest(event);
    if (body.classList.contains('he-col-resize') !== hovering) {
      body.classList.toggle('he-col-resize', hovering);
      if (!hovering && !body.getAttribute('class')) { body.removeAttribute('class'); }
    }
  }

  function onFrameMouseUp() {
    if (resizing) { finishResize(); return; }
    if (dragging) {
      var moved = dragging.moved;
      dragging = null;
      if (moved) { scheduleToolbarUpdate(); }
    }
  }

  /* ---------------------------------------------------------- keyboard --- */

  function onFrameKeyDown(event) {
    if (event.key === 'Escape' && cellSelection.length) {
      clearCellSelection();
      scheduleToolbarUpdate();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && cellSelection.length > 1) {
      event.preventDefault();
      var cells = selectedCells().filter(function (c) { return c.isConnected; });
      HE.edit(function () {
        cells.forEach(function (cell) { cell.innerHTML = '<br>'; });
      });
      return;
    }
    if (event.key !== 'Tab') { return; }
    var cell = caretCell();
    if (!cell) { return; }
    event.preventDefault();
    var table = closestTable(cell);
    var all = ownCells(table);
    var index = all.indexOf(cell);
    if (index === -1) { return; }
    if (event.shiftKey) {
      if (index > 0) { focusCell(all[index - 1], true); }
      return;
    }
    if (index < all.length - 1) {
      focusCell(all[index + 1], true);
      return;
    }
    // Tab on the very last cell grows the table by one row, Word style.
    var newTr = HE.edit(function () {
      return insertRowAt(table, table.rows.length - 1, false);
    });
    if (newTr && newTr.cells.length) { focusCell(newTr.cells[0], true); }
    scheduleToolbarUpdate();
  }

  /* -------------------------------------------- iframe wiring & UI style -- */

  var UI_STYLE_ID = 'he-tables-ui-style';
  var UI_CSS = [
    '.he-cell-selected { outline: 2px solid #4aa3ff !important; outline-offset: -2px;' +
    ' background-color: rgba(74,163,255,.08) !important; }',
    'body.he-col-resize, body.he-col-resize * { cursor: col-resize !important; }'
  ].join('\n');

  function injectUiStyle() {
    var d = HE.doc();
    if (!d || !d.documentElement) { return; }
    if (d.getElementById(UI_STYLE_ID)) { return; }
    var style = d.createElement('style');
    style.id = UI_STYLE_ID;
    style.setAttribute('data-html-editor-ui', '1');
    style.textContent = UI_CSS;
    (d.head || d.documentElement).appendChild(style);
  }

  function bindDoc() {
    var d = HE.doc();
    if (!d || d.__heTablesBound) { return; }
    d.__heTablesBound = true;
    d.addEventListener('mousedown', onFrameMouseDown, true);
    d.addEventListener('mousemove', onFrameMouseMove, true);
    d.addEventListener('mouseup', onFrameMouseUp, true);
    d.addEventListener('keydown', onFrameKeyDown, true);
    d.addEventListener('selectionchange', scheduleToolbarUpdate);
    if (d.defaultView) {
      d.defaultView.addEventListener('scroll', function () {
        positionToolbar();
      }, true);
    }
  }

  /* --------------------------------------------------------- context menu -- */

  function contextEntries(el) {
    var cell = closestCell(el);
    if (!cell) {
      return [{
        label: HE.t('table.insert', 'Insert table') + '…',
        icon: ICONS.table,
        action: function () { openInsertDialog(); }
      }];
    }
    var table = closestTable(cell);
    var multi = selectedCells().filter(function (c) {
      return c.isConnected && closestTable(c) === table;
    }).length > 1;

    function ctx() {
      var cells = targetCells().filter(function (c) { return closestTable(c) === table; });
      return { table: table, cell: cell, cells: cells.length ? cells : [cell] };
    }

    var entries = [
      { label: HE.t('table.rowAbove', 'Insert row above'), icon: ICONS.rowAbove, action: function () { opRow(ctx(), true); } },
      { label: HE.t('table.rowBelow', 'Insert row below'), icon: ICONS.rowBelow, action: function () { opRow(ctx(), false); } },
      { label: HE.t('table.colLeft', 'Insert column left'), icon: ICONS.colLeft, action: function () { opCol(ctx(), true); } },
      { label: HE.t('table.colRight', 'Insert column right'), icon: ICONS.colRight, action: function () { opCol(ctx(), false); } },
      { separator: true }
    ];
    if (multi) {
      entries.push({ label: HE.t('table.merge', 'Merge cells'), icon: ICONS.merge, action: function () { mergeSelection(table); } });
    }
    if ((cell.colSpan || 1) > 1 || (cell.rowSpan || 1) > 1) {
      entries.push({ label: HE.t('table.split', 'Split cell'), icon: ICONS.split, action: function () { splitCell(cell); } });
    }
    entries.push(
      { label: HE.t('table.toggleHeader', 'Toggle header row'), icon: ICONS.header, action: function () { toggleHeaderRow(table); } },
      { label: HE.t('table.distribute', 'Distribute columns evenly'), icon: ICONS.distribute, action: function () { distributeColumns(table); } },
      { separator: true },
      {
        label: HE.t('table.alignment', 'Alignment'),
        submenu: [
          { label: HE.t('toolbar.alignLeft', 'Align left'), icon: ICONS.alignLeft, action: function () { setCellStyle(ctx().cells, 'textAlign', 'left'); } },
          { label: HE.t('toolbar.alignCenter', 'Align centre'), icon: ICONS.alignCenter, action: function () { setCellStyle(ctx().cells, 'textAlign', 'center'); } },
          { label: HE.t('toolbar.alignRight', 'Align right'), icon: ICONS.alignRight, action: function () { setCellStyle(ctx().cells, 'textAlign', 'right'); } },
          { separator: true },
          { label: HE.t('table.vTop', 'Align top'), icon: ICONS.vTop, action: function () { setCellStyle(ctx().cells, 'verticalAlign', 'top'); } },
          { label: HE.t('table.vMiddle', 'Align middle'), icon: ICONS.vMiddle, action: function () { setCellStyle(ctx().cells, 'verticalAlign', 'middle'); } },
          { label: HE.t('table.vBottom', 'Align bottom'), icon: ICONS.vBottom, action: function () { setCellStyle(ctx().cells, 'verticalAlign', 'bottom'); } }
        ]
      },
      { label: HE.t('table.cellBackground', 'Cell background') + '…', icon: ICONS.background, action: function () { ensureToolbar(); pickBackground(ctx().cells); } },
      { label: HE.t('table.borders', 'Borders') + '…', icon: ICONS.borders, action: function () { openBorderDialog(table, ctx().cells); } },
      { label: HE.t('menu.properties', 'Properties…'), icon: ICONS.props, action: function () { openTableProperties(table); } },
      { separator: true },
      { label: HE.t('table.delRow', 'Delete row'), icon: ICONS.delRow, action: function () { opDeleteRow(ctx()); } },
      { label: HE.t('table.delCol', 'Delete column'), icon: ICONS.delCol, action: function () { opDeleteCol(ctx()); } },
      { label: HE.t('table.delTable', 'Delete table'), icon: ICONS.delTable, danger: true, action: function () { opDeleteTable(ctx()); } },
      { separator: true },
      { label: HE.t('table.insert', 'Insert table') + '…', icon: ICONS.table, action: function () { openInsertDialog(); } }
    );
    return entries;
  }

  HE.registerContextProvider(function (el) {
    if (closestCell(el)) {
      return [{ label: HE.t('menu.table', 'Table'), icon: ICONS.table, submenu: contextEntries(el) }];
    }
    return [{
      label: HE.t('table.insert', 'Insert table') + '…',
      icon: ICONS.table,
      action: function () { openInsertDialog(); }
    }];
  });

  /* ------------------------------------------------------------- wiring -- */

  var btnTable = document.getElementById('btn-table');
  if (btnTable) { btnTable.addEventListener('click', openInsertDialog); }

  HE.on('document-loaded', function () {
    injectUiStyle();
    bindDoc();
    cellSelection = [];
    selectionAnchor = null;
    hideToolbar();
  });

  HE.on('frame-prepared', function () {
    injectUiStyle();
    bindDoc();
    // The frame is prepared after the document was replaced wholesale (load,
    // undo, source apply) and core has just swept the interaction marks off
    // it. The cells this array remembers went with the old tree, so keeping
    // it would leave a selection the document no longer shows.
    clearCellSelection();
    selectionAnchor = null;
  });

  HE.on('select', scheduleToolbarUpdate);

  HE.on('mutated', function () {
    pruneCellSelection();
    scheduleToolbarUpdate();
  });

  HE.registerOverlayRefresher(function () { positionToolbar(); });

  window.addEventListener('resize', scheduleToolbarUpdate);
  var canvasScroll = document.getElementById('canvas-scroll');
  if (canvasScroll) { canvasScroll.addEventListener('scroll', positionToolbar, { passive: true }); }

  /* ------------------------------------------------------------- export -- */

  HE.tables = {
    openInsertDialog: openInsertDialog,
    insert: doInsert,
    contextEntries: contextEntries
  };
  HE.modules.tables = HE.tables;

  /* ---------------------------------------------------------------------
   * New CSS class names introduced by this module (for editor.css):
   *
   * Host page (style freely, layout-critical bits are inline):
   *   .table-toolbar               floating table toolbar container (#layer)
   *   .table-toolbar__btn          toolbar button (also has btn btn--tool)
   *   .table-toolbar__btn--danger  destructive button (delete table)
   *   .table-toolbar__sep          separator between toolbar groups
   *   .table-toolbar__color        hidden colour input for cell background
   *   .table-resize-guide          vertical drag guide during column resize
   *   .table-dialog                insert/borders dialog body
   *   .table-dialog__fields        options grid in the insert dialog
   *   .table-dialog__field         one label+input pair
   *   .table-dialog__name          field label text
   *   .table-dialog__width         width select + px input wrapper
   *   .table-picker                hover grid picker wrapper
   *   .table-picker__grid          the 10x10 grid
   *   .table-picker__cell          one picker cell ("is-on" when highlighted)
   *   .table-picker__label         the "4 × 3" readout
   *
   * Inside the edited iframe (he- prefix, stripped on save; already styled
   * by the injected data-html-editor-ui stylesheet):
   *   .he-cell-selected            cell in the rectangular selection
   *   .he-col-resize               body class while hovering a column border
   * ------------------------------------------------------------------- */
})(window.HE);
