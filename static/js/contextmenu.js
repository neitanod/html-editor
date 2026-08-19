/*
 * contextmenu.js — right-click menu over the document.
 *
 * The base entries (copy, delete, view in source, properties, and the
 * body/head/html shortcuts when clicking the background) live here; every
 * other module contributes its own through HE.registerContextProvider.
 */
(function (HE) {
  'use strict';

  var host = document.getElementById('context-menu');
  var openSubmenus = [];

  /* ------------------------------------------------------- base entries -- */

  HE.registerContextProvider(function (element, ctx) {
    var d = HE.doc();
    var isBackground = !element || element === d.body || element === d.documentElement;
    var entries = [];

    entries.push({
      label: HE.t('menu.copy'), group: 'clipboard', shortcut: 'Ctrl+C',
      action: function () { HE.exec('copy'); }
    });
    entries.push({
      label: HE.t('menu.cut'), group: 'clipboard', shortcut: 'Ctrl+X',
      action: function () { HE.edit(function () { HE.exec('cut'); }); }
    });
    entries.push({
      label: HE.t('menu.paste'), group: 'clipboard', shortcut: 'Ctrl+V',
      action: function () { pasteFromClipboard(); }
    });
    entries.push({
      label: HE.t('menu.copyHtml'), group: 'clipboard',
      action: function () {
        var target = isBackground ? d.body : element;
        navigator.clipboard.writeText(target.outerHTML).then(function () {
          HE.toast(HE.t('menu.copyHtml'), 'ok');
        });
      }
    });

    if (!isBackground) {
      entries.push({
        label: HE.t('menu.duplicate'), group: 'element',
        action: function () {
          HE.edit(function () {
            var copy = element.cloneNode(true);
            HE.unmark(copy, 'he-selected');
            HE.unmark(copy, 'he-hover');
            element.parentNode.insertBefore(copy, element.nextSibling);
            HE.select(copy);
          });
        }
      });
      entries.push({
        label: HE.t('menu.delete'), group: 'element', danger: true, shortcut: 'Del',
        action: function () {
          HE.edit(function () {
            var parent = element.parentElement;
            element.remove();
            HE.select(parent);
          });
        }
      });
      entries.push({
        label: HE.t('menu.wrap'), group: 'element',
        submenu: ['div', 'section', 'article', 'aside', 'figure', 'blockquote', 'span'].map(function (tag) {
          return {
            label: '<' + tag + '>',
            action: function () {
              HE.edit(function () {
                var wrapper = d.createElement(tag);
                element.parentNode.insertBefore(wrapper, element);
                wrapper.appendChild(element);
                HE.select(wrapper);
              });
            }
          };
        })
      });
      if (element.parentElement && element.parentElement !== d.documentElement) {
        entries.push({
          label: HE.t('menu.selectParent') + ' <' + element.parentElement.tagName.toLowerCase() + '>',
          group: 'element',
          action: function () { HE.select(element.parentElement); }
        });
      }
    }

    entries.push({
      label: HE.t('menu.viewSource'), group: 'inspect',
      action: function () {
        var target = isBackground ? d.body : element;
        if (HE.source) { HE.source.revealElement(target); }
      }
    });

    if (isBackground) {
      entries.push({
        label: HE.t('menu.body'), group: 'document',
        action: function () { HE.props && HE.props.openElement(d.body); }
      });
      entries.push({
        label: HE.t('menu.head'), group: 'document',
        action: function () { HE.props && HE.props.openDocument(); }
      });
      entries.push({
        label: HE.t('menu.html'), group: 'document',
        action: function () { HE.props && HE.props.openElement(d.documentElement); }
      });
    }

    return entries;
  });

  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      HE.exec('paste');
      return;
    }
    navigator.clipboard.read().then(function (items) {
      var chain = Promise.resolve();
      items.forEach(function (item) {
        if (item.types.indexOf('text/html') !== -1) {
          chain = chain.then(function () {
            return item.getType('text/html').then(function (blob) {
              return blob.text().then(function (html) {
                HE.edit(function () { HE.exec('insertHTML', html); });
              });
            });
          });
        } else if (item.types.indexOf('text/plain') !== -1) {
          chain = chain.then(function () {
            return item.getType('text/plain').then(function (blob) {
              return blob.text().then(function (text) {
                HE.edit(function () { HE.exec('insertText', text); });
              });
            });
          });
        }
      });
      return chain;
    }).catch(function () {
      HE.toast(HE.t('menu.pasteHint', 'Use Ctrl+V to paste'), 'info');
    });
  }

  /* ------------------------------------------------------------ rendering */

  var GROUP_ORDER = ['element', 'insert', 'table', 'clipboard', 'inspect', 'document', 'other'];

  function collect(element, ctx) {
    var all = [];
    HE.contextProviders.forEach(function (provider) {
      var produced;
      try { produced = provider(element, ctx) || []; }
      catch (err) { console.error('[html-editor] context provider', err); produced = []; }
      produced.forEach(function (entry) { all.push(entry); });
    });

    var grouped = {};
    all.forEach(function (entry) {
      var key = entry.group || 'other';
      (grouped[key] = grouped[key] || []).push(entry);
    });

    var ordered = [];
    GROUP_ORDER.forEach(function (key) {
      if (!grouped[key] || !grouped[key].length) { return; }
      if (ordered.length) { ordered.push({ separator: true }); }
      grouped[key].forEach(function (entry) { ordered.push(entry); });
      delete grouped[key];
    });
    Object.keys(grouped).forEach(function (key) {
      if (ordered.length) { ordered.push({ separator: true }); }
      grouped[key].forEach(function (entry) { ordered.push(entry); });
    });
    return ordered;
  }

  function buildMenu(entries, level) {
    var menu = HE.el('div', { class: 'menu__panel', 'data-level': level || 0 });
    entries.forEach(function (entry) {
      if (entry.separator) {
        menu.appendChild(HE.el('div', { class: 'menu__sep' }));
        return;
      }
      var item = HE.el('button', {
        class: 'menu__item' + (entry.danger ? ' menu__item--danger' : '') +
          (entry.submenu ? ' menu__item--parent' : ''),
        type: 'button'
      }, [HE.el('span', { class: 'menu__label', text: entry.label })]);

      if (entry.shortcut) {
        item.appendChild(HE.el('span', { class: 'menu__shortcut', text: entry.shortcut }));
      }
      if (entry.submenu) {
        item.appendChild(HE.el('span', { class: 'menu__arrow', text: '›' }));
        item.addEventListener('mouseenter', function () {
          openSubmenu(item, entry.submenu, (level || 0) + 1);
        });
        item.addEventListener('click', function (event) {
          event.stopPropagation();
          openSubmenu(item, entry.submenu, (level || 0) + 1);
        });
      } else {
        item.addEventListener('mouseenter', function () { closeSubmenusAbove(level || 0); });
        item.addEventListener('click', function () {
          closeMenu();
          if (entry.action) { entry.action(); }
        });
      }
      menu.appendChild(item);
    });
    return menu;
  }

  function openSubmenu(anchorItem, entries, level) {
    closeSubmenusAbove(level - 1);
    var panel = buildMenu(entries, level);
    panel.classList.add('menu__panel--sub');
    host.appendChild(panel);

    var rect = anchorItem.getBoundingClientRect();
    var width = panel.offsetWidth;
    var left = rect.right - host.getBoundingClientRect().left;
    if (rect.right + width > window.innerWidth - 8) {
      left = rect.left - host.getBoundingClientRect().left - width;
    }
    panel.style.left = left + 'px';
    panel.style.top = (rect.top - host.getBoundingClientRect().top) + 'px';

    var overflow = panel.getBoundingClientRect().bottom - (window.innerHeight - 10);
    if (overflow > 0) {
      panel.style.top = (parseFloat(panel.style.top) - overflow) + 'px';
    }
    openSubmenus.push(panel);
  }

  function closeSubmenusAbove(level) {
    while (openSubmenus.length > level) {
      var panel = openSubmenus.pop();
      if (panel && panel.parentNode) { panel.remove(); }
    }
  }

  /** Opens the menu for `element` at host viewport coordinates {x, y}. */
  HE.openContextMenu = function (element, point) {
    closeMenu();
    var entries = collect(element, { point: point });
    if (!entries.length) { return; }

    host.innerHTML = '';
    host.hidden = false;
    host.style.left = '0px';
    host.style.top = '0px';

    var panel = buildMenu(entries, 0);
    host.appendChild(panel);

    var width = panel.offsetWidth;
    var height = panel.offsetHeight;
    var x = Math.min(point.x, window.innerWidth - width - 8);
    var y = point.y;
    if (y + height > window.innerHeight - 8) {
      y = Math.max(8, point.y - height);
    }
    host.style.left = Math.max(8, x) + 'px';
    host.style.top = Math.max(8, y) + 'px';

    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    var d = HE.doc();
    if (d) { d.addEventListener('mousedown', closeMenu, true); }
  };

  function onOutside(event) {
    if (!host.contains(event.target)) { closeMenu(); }
  }

  function onKey(event) {
    if (event.key === 'Escape') { closeMenu(); }
  }

  function closeMenu() {
    closeSubmenusAbove(0);
    host.hidden = true;
    host.innerHTML = '';
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    var d = HE.doc();
    if (d) { d.removeEventListener('mousedown', closeMenu, true); }
  }

  HE.closeContextMenu = closeMenu;

  // Right-clicking the editor chrome keeps the browser menu; only the document
  // area is taken over, and that is wired from boot.js.
  window.addEventListener('blur', closeMenu);
})(window.HE);
