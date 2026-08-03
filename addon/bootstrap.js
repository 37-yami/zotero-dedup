'use strict';

// Zotero Dedup — bootstrap entry (Zotero 7+ / 9, WebExtension bootstrap)
const PLUGIN_ID = 'zotero-dedup@example.com';
const CONTENT_BASE = 'chrome://dedup/content/';
const MENU_ID = 'zotero-dedup-menuitem';
const TOOLS_POPUP_ID = 'menu_ToolsPopup';

function log(msg) {
  try { Zotero.debug('[Zotero Dedup] ' + msg); } catch (e) {}
}

function startup(data, reason) {
  data = data || {};
  const rootURI = data.rootURI;
  try {
    const { Services } = ChromeUtils.import('resource://gre/modules/Services.jsm');
    const aomStartup = Components.classes['@mozilla.org/addons/addon-manager-startup;1']
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + 'chrome.manifest');
    aomStartup.registerChrome(manifestURI, [...aomStartup.decodeManifest(manifestURI)]);
    log('chrome registered');
  } catch (e) {
    log('chrome registration failed: ' + e);
  }

  try {
    if (Zotero.PreferencePanes && Zotero.PreferencePanes.register) {
      Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        src: CONTENT_BASE + 'options.xhtml',
        id: 'zotero-dedup-prefs',
        label: 'Zotero Dedup',
        helpURL: 'https://github.com/37-yami/zotero-dedup#readme'
      })
        .then(() => log('pref pane registered'))
        .catch(e => log('pref pane register failed: ' + e));
    }
  } catch (e) {
    log('pref pane register failed: ' + e);
  }

  // Inject into any main windows that are already open (covers "enabled without restart").
  try {
    if (typeof Zotero.getMainWindows === 'function') {
      for (const win of Zotero.getMainWindows()) {
        if (win && win.document) addMenuItem(win.document);
      }
    }
  } catch (e) {
    log('inject into open windows failed: ' + e);
  }
}

function onMainWindowLoad({ window }) {
  try {
    addMenuItem(window.document);
  } catch (e) {
    log('onMainWindowLoad add failed: ' + e);
  }
}

function onMainWindowUnload({ window }) {
  try {
    removeMenuItem(window.document);
  } catch (e) {}
}

function shutdown() {}
function install() {}
function uninstall() {}

// ---------- menu ----------

function getToolsPopup(doc) {
  let popup = doc.getElementById(TOOLS_POPUP_ID);
  if (popup) return popup;
  const menu = doc.getElementById('menu_Tools');
  if (menu) return menu.menupopup || menu.querySelector('menupopup');
  return null;
}

function addMenuItem(doc) {
  if (!doc) return;
  if (doc.getElementById(MENU_ID)) return;
  const popup = getToolsPopup(doc);
  if (!popup) {
    log('Tools popup not found');
    return;
  }
  const menuitem = doc.createXULElement('menuitem');
  menuitem.id = MENU_ID;
  menuitem.setAttribute('label', '开始扫描（去重）');
  menuitem.setAttribute('tooltiptext', '扫描当前范围中的重复文章');
  menuitem.addEventListener('command', () => scan(doc.defaultView));
  popup.appendChild(menuitem);
  log('menu item added');

  // Re-add on every popup opening in case Zotero rebuilds the menu contents.
  popup.addEventListener('popupshowing', () => {
    if (!doc.getElementById(MENU_ID)) addMenuItem(doc);
  });
}

function removeMenuItem(doc) {
  if (!doc) return;
  const mi = doc.getElementById(MENU_ID);
  if (mi) mi.remove();
}

// ---------- helpers ----------

function normalize(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Get PDF attachments of an item together with their content MD5
// (read from Zotero's stored attachment hash — no file I/O needed).
async function getPdfAttachments(item) {
  const out = [];
  try {
    const ids = await item.getAttachments();
    for (const id of ids) {
      const att = Zotero.Items.get(id);
      if (!att) continue;
      const ct = att.attachmentContentType || att.getField('contentType') || '';
      if (ct !== 'application/pdf') continue;
      let md5 = '';
      try { md5 = (att.attachmentMD5 || att.getField('md5') || '').toString().toLowerCase(); } catch (e) {}
      if (!md5) continue;
      out.push({ id: id, md5: md5 });
    }
  } catch (e) {}
  return out;
}

// Build a set of candidate match-keys for one item.
// Two items are considered duplicates if they share at least one candidate key.
// This is forgiving (the user reviews every group before deleting). PDF content
// hashes are ALWAYS added as an extra signal, so items whose attached PDFs are
// byte-identical (even with different filenames) are matched regardless of the
// selected metadata rule.
async function candidateKeys(item, rule, pdfs) {
  const keys = new Set();
  const title = normalize(item.getField('title'));

  const doi = (item.getField('DOI') || '').trim().toLowerCase();
  if (doi) keys.add('doi:' + doi);

  if (title) {
    if (rule === 'title') {
      keys.add('t:' + title);
    } else if (rule === 'title-author-year') {
      let authors = '';
      try {
        const creators = item.getCreators();
        authors = creators
          .map(c => normalize((c.firstName || '') + ' ' + (c.lastName || '')))
          .filter(Boolean)
          .sort()
          .join(',');
      } catch (e) {}
      const year = (item.getField('date') || '').toString().replace(/\D+/g, '').slice(0, 4);
      if (authors && year) keys.add('tay:' + title + '|' + authors + '|' + year);
      else if (authors) keys.add('ta:' + title + '|' + authors);
      else if (year) keys.add('ty:' + title + '|' + year);
      else keys.add('t:' + title);
    }
    // For 'doi' / 'pdf' rules only those specific keys are used (added below).
  }

  // PDF content hashes — always on (covers identical-PDF duplicates).
  for (const p of pdfs) keys.add('pdf:' + p.md5);

  return keys;
}

async function detectDuplicates(items, rule) {
  // Union-find on items: items sharing any candidate key belong to the same group.
  const parent = new Map();
  const find = x => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const keyOwner = new Map();
  const pdfsByItem = new Map();

  for (const item of items) {
    if (!parent.has(item.id)) parent.set(item.id, item.id);
    const pdfs = await getPdfAttachments(item);
    pdfsByItem.set(item.id, pdfs);
    for (const k of await candidateKeys(item, rule, pdfs)) {
      if (keyOwner.has(k)) {
        union(item.id, keyOwner.get(k));
      } else {
        keyOwner.set(k, item.id);
      }
    }
  }

  const groupsMap = new Map();
  for (const item of items) {
    const root = find(item.id);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root).push(item);
  }

  const groups = [];
  let itemGroups = 0;
  for (const arr of groupsMap.values()) {
    if (arr.length >= 2) { groups.push({ type: 'items', items: arr }); itemGroups++; }
  }

  // Within-item duplicate PDFs: one item carrying two or more byte-identical PDFs.
  let attachGroups = 0;
  for (const [id, pdfs] of pdfsByItem) {
    const byMd5 = new Map();
    for (const p of pdfs) {
      if (!byMd5.has(p.md5)) byMd5.set(p.md5, []);
      byMd5.get(p.md5).push(p.id);
    }
    for (const arr of byMd5.values()) {
      if (arr.length >= 2) { groups.push({ type: 'attachments', itemId: id, dupAttachmentIds: arr }); attachGroups++; }
    }
  }

  log('detect: ' + groups.length + ' group(s) = ' + itemGroups + ' item-group(s) + ' + attachGroups + ' duplicate-PDF group(s)');
  return groups;
}

// ---------- scan ----------

async function scan(window) {
  try {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) {
      Zotero.alert(window, 'Zotero Dedup', '无法获取当前 Zotero 窗口。');
      return;
    }

    const scope = Zotero.Prefs.get('extensions.zotero-dedup.scope', true) || 'collection';
    let items = [];

    if (scope === 'collection') {
      const coll = pane.getSelectedCollection();
      if (!coll) {
        Zotero.alert(window, 'Zotero Dedup', '请先在左侧选择一个收藏夹（分类）。');
        return;
      }
      items = await coll.getChildItems();
    } else {
      const selected = pane.getSelectedItems();
      if (!selected.length) {
        Zotero.alert(window, 'Zotero Dedup', '请先选中至少一条文献，以确定其所在分类。');
        return;
      }
      const collIDs = new Set();
      for (const it of selected) {
        const cols = it.getCollections();
        for (const c of cols) collIDs.add(c.id);
      }
      for (const cid of collIDs) {
        const c = Zotero.Collections.get(cid);
        if (c) {
          const ci = await c.getChildItems();
          for (const x of ci) items.push(x);
        }
      }
      const seen = new Set();
      items = items.filter(i => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });
    }

    if (!items.length) {
      Zotero.alert(window, 'Zotero Dedup', '当前范围内没有可扫描的条目。');
      return;
    }

    const rule = Zotero.Prefs.get('extensions.zotero-dedup.rule', true) || 'title-author-year';
    const groups = await detectDuplicates(items, rule);

    log('scan: ' + items.length + ' item(s) scanned, ' + groups.length + ' duplicate group(s) found (rule=' + rule + ')');

    if (!groups.length) {
      Zotero.alert(
        window,
        'Zotero Dedup',
          '未发现重复文章。\n\n已扫描 ' + items.length + ' 条条目，规则：' + ruleLabel(rule) +
          '。\n\n若重复项是「内容相同的 PDF」，本插件已按 PDF 内容（MD5）自动匹配；如仍未识别，请确认这些 PDF 已真正存入 Zotero 存储（而非仅链接），或把「扫描范围」改为「选中文献所在分类」。'
      );
      return;
    }

    const args = { groups, rule, opener: window };
    window.openDialog(
      CONTENT_BASE + 'dedupDialog.xhtml',
      'zotero-dedup-dialog',
      'chrome,titlebar,centerscreen,modal,resizable=yes,width=720,height=640',
      args
    );
  } catch (e) {
    log('scan failed: ' + e);
    Zotero.alert(window, 'Zotero Dedup', '扫描出错：' + e);
  }
}

function ruleLabel(rule) {
  return rule === 'doi' ? 'DOI'
    : rule === 'title' ? '仅标题'
    : rule === 'pdf' ? '仅 PDF 内容'
    : '标题+作者+年份';
}
