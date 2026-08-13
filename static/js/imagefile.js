/*
 * imagefile.js — the rules every tool that rewrites a picture has to obey.
 *
 * Cropping and annotating are two different jobs with the same ending: a canvas
 * that has to become a file next to the document, under a policy that is easy
 * to get subtly wrong. Which pictures can be touched at all, what the browser
 * is allowed to read into a canvas, which format comes back out, what happens
 * to the file that was there before — all of that lives here once, so the two
 * dialogs cannot drift into disagreeing about it.
 *
 * The policy itself, in one sentence: the original file is never overwritten.
 * The result is written beside it under a new name, which is what makes Ctrl+Z
 * an honest undo — the address goes back and the pixels it points at are still
 * on disk.
 */
(function (HE) {
  'use strict';

  var JPEG_QUALITY = 0.92;

  function isRemote(value) {
    return /^(https?:)?\/\//i.test((value || '').trim());
  }

  function isVector(value) {
    return /\.svgz?(\?|#|$)/i.test((value || '').split('?')[0]);
  }

  /** The address the browser actually painted, resolved against the document. */
  function sourceOf(img) {
    if (img.currentSrc) { return img.currentSrc; }
    try {
      return new URL(img.getAttribute('src') || '', HE.win().location.href).href;
    } catch (err) {
      return img.getAttribute('src') || '';
    }
  }

  /**
   * JPEG survives as JPEG so a photograph does not quadruple in size on its way
   * through the editor; everything else comes out as PNG.
   */
  function outputMime(src) {
    return /\.jpe?g(\?|#|$)/i.test(src.split('?')[0]) ? 'image/jpeg' : 'image/png';
  }

  /** `photo.png` edited as a crop becomes `photo-crop.png`; the server makes it unique. */
  function suggestedName(img, mime, suffix) {
    var src = (img.getAttribute('src') || 'image').split(/[?#]/)[0];
    var base = src.substring(src.lastIndexOf('/') + 1) || 'image';
    var dot = base.lastIndexOf('.');
    var stem = dot > 0 ? base.slice(0, dot) : base;
    if (stem.slice(-suffix.length - 1) !== '-' + suffix) { stem += '-' + suffix; }
    return stem + (mime === 'image/jpeg' ? '.jpg' : '.png');
  }

  /** Loads the picture at its natural size, outside the edited document. */
  function loadBitmap(src) {
    return new Promise(function (resolve, reject) {
      var bitmap = new Image();
      bitmap.onload = function () {
        if (!bitmap.naturalWidth || !bitmap.naturalHeight) {
          reject(new Error('empty image'));
          return;
        }
        resolve(bitmap);
      };
      bitmap.onerror = function () { reject(new Error('could not load ' + src)); };
      bitmap.src = src;
    });
  }

  function toBlob(canvas, mime) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) {
          if (blob) { resolve(blob); } else { reject(new Error('empty result')); }
        }, mime, JPEG_QUALITY);
      } catch (err) {
        reject(err);   // a tainted canvas throws here rather than calling back
      }
    });
  }

  /**
   * Refuses the pictures that cannot honestly be edited and says why. A vector
   * would have to be rasterised, which is a downgrade wearing the clothes of an
   * edit; a picture still hosted elsewhere taints the canvas, and the editor
   * already knows how to bring it home first.
   *
   * `retry` is called after a successful download, so the tool the user asked
   * for opens on the picture that has just landed in the folder.
   */
  function canEdit(img, retry) {
    if (HE.readOnly) { HE.toast(HE.t('save.readonly'), 'warn'); return false; }
    var src = img.getAttribute('src') || '';
    if (isVector(src)) {
      HE.toast(HE.t('image.vector', 'An SVG is drawn from shapes: editing it here would turn it into a bitmap'), 'warn');
      return false;
    }
    if (isRemote(src)) { offerToLocalize(img, retry); return false; }
    return true;
  }

  function offerToLocalize(img, retry) {
    HE.modal({
      title: HE.t('image.remoteTitle', 'The image is on another site'),
      width: '460px',
      body: HE.el('div', { class: 'form' }, [
        HE.el('p', { class: 'assets-ask__text',
          text: HE.t('image.remoteBody', 'It has to be stored next to the document before it can be edited.') }),
        HE.el('p', { class: 'assets-ask__hint',
          text: HE.t('image.remoteHint', 'The file lands in this folder and the document links it relatively, which is the same thing the paste dialog offers.') })
      ]),
      actions: [
        { label: HE.t('common.cancel'), onClick: function (close) { close(); } },
        {
          label: HE.t('image.download', 'Download it'), primary: true,
          onClick: function (close) {
            close();
            img.setAttribute('data-he-localize', '0');
            HE.assets.localizeMarked(HE.doc().documentElement).then(function (count) {
              if (count && retry) { retry(img); }
            });
          }
        }
      ]
    });
  }

  /**
   * Opens a picture for editing: checks it can be touched, loads it at its
   * natural size and hands both the bitmap and the address it came from.
   */
  function open(img, retry) {
    if (!canEdit(img, retry)) { return Promise.resolve(null); }
    var src = sourceOf(img);
    return loadBitmap(src).then(function (bitmap) {
      return { bitmap: bitmap, src: src, mime: outputMime(src) };
    }).catch(function (err) {
      HE.toast(HE.t('image.loadFailed', 'Could not read the image: ') + err.message, 'error');
      return null;
    });
  }

  /**
   * Writes what a tool painted as a new file beside the document and points the
   * element at it, in a single undoable step.
   */
  function write(img, canvas, mime, suffix) {
    HE.toast(HE.t('image.uploading'), 'info');
    return toBlob(canvas, mime).then(function (blob) {
      return HE.storeAsset(blob, suggestedName(img, mime, suffix));
    }).then(function (asset) {
      HE.edit(function () {
        img.setAttribute('src', asset.name);
        // A srcset left over from a paste would keep winning over the new src.
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
        if (img.hasAttribute('width')) { img.setAttribute('width', canvas.width); }
        if (img.hasAttribute('height')) { img.setAttribute('height', canvas.height); }
        // An explicit height belonged to the shape the picture may no longer have.
        if (img.style.height && img.style.height !== 'auto') { img.style.height = 'auto'; }
      });
      // The handles are drawn from the old box until the new file has been
      // decoded, so they are placed again once it is on screen.
      img.addEventListener('load', function () { HE.refreshOverlays(); }, { once: true });
      HE.select(img);
      HE.toast(HE.t('image.stored') + asset.name, 'ok');
      return asset;
    }).catch(function (err) {
      HE.toast(HE.t('image.writeFailed', 'Could not write the image: ') + err.message, 'error');
      return null;
    });
  }

  HE.imagefile = {
    open: open,
    write: write,
    canEdit: canEdit,
    sourceOf: sourceOf,
    outputMime: outputMime
  };
})(window.HE);
