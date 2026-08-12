/*
 * mhtml.js — packing the document folder into a single file, and back.
 *
 * An .mhtml is a mail message carrying the page: the HTML plus every image and
 * stylesheet it uses, in one file that Chrome, Edge and Word open and that can
 * be edited again after the trip. The packing happens in the Go process, which
 * is the side that can read the folder; this module is the two commands and
 * the dialogs around them.
 */
(function (HE) {
  'use strict';

  /* ---------------------------------------------------------------- export */

  function post(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) { throw new Error(data.error || res.statusText); }
        return data;
      });
    });
  }

  // The archive is packed from the file on disk, so anything still unsaved has
  // to reach it first or the export would quietly ship the previous version.
  function saveFirst() {
    return HE.dirty && !HE.readOnly ? HE.save() : Promise.resolve(true);
  }

  function saveNextToDocument() {
    return saveFirst().then(function () {
      return post('/api/export-mhtml');
    }).then(function (data) {
      HE.toast(HE.t('mhtml.saved', 'Saved as ') + data.name, 'ok');
      return data;
    }).catch(function (err) {
      HE.toast(HE.t('mhtml.failed', 'Could not export: ') + err.message, 'error');
    });
  }

  function download() {
    return saveFirst().then(function () {
      var link = HE.el('a', { href: '/api/export.mhtml', download: '' });
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  }

  function exportDialog() {
    HE.modal({
      title: HE.t('mhtml.exportTitle', 'Export to .mhtml'),
      width: '520px',
      body: HE.el('div', { class: 'form' }, [
        HE.el('p', { class: 'mhtml__text', text: HE.t('mhtml.exportBody',
          'One file with the document and its images inside, ready to send by mail. Chrome, Edge and Word open it, and this editor can open it again to keep working.') })
      ]),
      actions: [
        {
          label: HE.t('mhtml.download', 'Download'),
          onClick: function (close) { close(); download(); }
        },
        {
          label: HE.t('mhtml.saveHere', 'Save next to the document'), primary: true,
          onClick: function (close) { close(); saveNextToDocument(); }
        }
      ]
    });
  }

  /* ---------------------------------------------------------------- import */

  function readAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('cannot read file')); };
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.readAsDataURL(file);
    });
  }

  function importFile(file) {
    HE.toast(HE.t('mhtml.importing', 'Importing…'), 'info');
    return readAsBase64(file).then(function (data) {
      return post('/api/import-mhtml', { data: data });
    }).then(function (result) {
      HE.markClean();
      HE.reload();
      HE.toast(HE.t('mhtml.imported', 'Imported, with ') + result.assets +
        HE.t('mhtml.importedTail', ' file(s) unpacked next to the document'), 'ok');
      return result;
    }).catch(function (err) {
      HE.toast(HE.t('mhtml.importFailed', 'Could not import: ') + err.message, 'error');
    });
  }

  function chooseFile() {
    var input = HE.el('input', { type: 'file', accept: '.mhtml,.mht,message/rfc822,multipart/related' });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.remove();
      if (file) { importFile(file); }
    });
    input.click();
  }

  // Importing replaces what is open, so it asks first. The previous version is
  // still recoverable: the document writer keeps it as a ".bak" copy.
  function importDialog() {
    if (HE.readOnly) { HE.toast(HE.t('save.readonly'), 'warn'); return; }
    HE.modal({
      title: HE.t('mhtml.importTitle', 'Import an .mhtml'),
      width: '520px',
      body: HE.el('div', { class: 'form' }, [
        HE.el('p', { class: 'mhtml__text', text: HE.t('mhtml.importBody',
          'The archive is unpacked into this document folder: its images land next to the document and its HTML replaces what is open now.') }),
        HE.el('p', { class: 'mhtml__hint', text: HE.t('mhtml.importHint',
          'The version being edited is kept as a .bak copy of the file.') })
      ]),
      actions: [
        {
          label: HE.t('common.cancel', 'Cancel'),
          onClick: function (close) { close(); }
        },
        {
          label: HE.t('mhtml.choose', 'Choose the file…'), primary: true,
          onClick: function (close) { close(); chooseFile(); }
        }
      ]
    });
  }

  HE.mhtml = {
    exportDialog: exportDialog,
    importDialog: importDialog,
    importFile: importFile,
    saveNextToDocument: saveNextToDocument,
    download: download
  };

  /* Both commands belong to the document, so they sit with the other document
   * commands on the background context menu. */
  HE.registerContextProvider(function (element) {
    var d = HE.doc();
    var isBackground = !element || element === d.body || element === d.documentElement;
    if (!isBackground) { return []; }
    return [
      {
        label: HE.t('mhtml.export', 'Export to .mhtml…'),
        group: 'document',
        action: exportDialog
      },
      {
        label: HE.t('mhtml.import', 'Import an .mhtml…'),
        group: 'document',
        action: importDialog
      }
    ];
  });

  /*
   * New CSS class names introduced by this module (for editor.css):
   *   .mhtml__text — the sentence explaining what the command does
   *   .mhtml__hint — the smaller note under it
   */
})(window.HE);
