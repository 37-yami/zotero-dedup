'use strict';

// Zotero Dedup — bootstrap entry (Zotero 7+ / 9, WebExtension bootstrap)
const PLUGIN_ID = 'zotero-dedup@example.com';
const CONTENT_BASE = 'chrome://dedup/content/';
const MENU_ID = 'zotero-dedup-menuitem';

function log(msg) {
  try { Zotero.debug('[Zotero Dedup] ' + msg); } catch (e) {}
}

function startup({ id, version, rootURI }, reason) {
  try {
    const { Services } = ChromeUtils.import('resource://gre/modules/Services.jsm');
    const aomStartup = Components.classes['@mozilla.org/addons/addon-manager-startup;1']
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + 'chrome.manifest');
    aomStartup.registerChrome(manifestURI, [...aomStartup.decodeManifest(manifestURI)]);
  } catch (e) {
    log('chrome registration failed: ' + e);
  }

  try {
    if (Zotero.PreferencePanes && Zotero.PreferencePanes.register) {
      Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        src: CONTENT_BASE + 'options.xhtml',
        label: 'Zotero Dedup',
        helpURL: 'https://github.com/YOUR_GITHUB_USERNAME/zotero-dedup#readme'
      });
    }
  } catch (e) {
    log('pref pane register failed: ' + e);
  }
}

function onMainWindowLoad({ window }) {
  try {
    const doc = window.document;
    // Locate the Tools menu popup.
    let toolsPopup = doc.getElementById('menu_tools');
    if (toolsPopup && toolsPopup.tagName === 'menu') {
      toolsPopup = toolsPopup.menupopup || toolsPopup.querySelector('menupopup');
    } else {
      toolsPopup = doc.getElementById('menu_tools-popup') || toolsPopup;
    }
    if (!toolsPopup) {
      log('Tools menu popup not found');
      return;
    }
    if (doc.getElementById(MENU_ID)) return;

    const menuitem = doc.createXULElement('menuitem');
    menuitem.id = MENU_ID;
    menuitem.setAttribute('label', '开始扫描（去重）');
    menuitem.setAttribute('tooltiptext', '扫描当前范围中的重复文章');
    menuitem.addEventListener('command', () => scan(window));
    toolsPopup.appendChild(menuitem);
    log('menu item added');
  } catch (e) {
    log('add menu failed: ' + e);
  }
}

function onMainWindowUnload({ window }) {
  try {
    const mi = window.document.getElementById(MENU_ID);
    if (mi) mi.remove();
  } catch (e) {}
}

function shutdown() {}
function install() {}
function uninstall() {}

// ---------- helpers ----------

function normalize(s) {
  return (s || '').toString().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function itemKey(item, rule) {
  if (rule === 'doi') {
    const doi = (item.getField('DOI') || '').trim().toLowerCase();
    return doi ? 'doi:' + doi : null;
  }
  const title = normalize(item.getField('title'));
  if (rule === 'title') {
    return title ? 't:' + title : null;
  }
  // title-author-year
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
  const key = [title, authors, year].join('|');
  return key ? key : null;
}

function detectDuplicates(items, rule) {
  const map = new Map();
  for (const item of items) {
    const key = itemKey(item, rule);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  const groups = [];
  for (const arr of map.values()) {
    if (arr.length >= 2) groups.push(arr);
  }
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
    const groups = detectDuplicates(items, rule);

    if (!groups.length) {
      Zotero.alert(window, 'Zotero Dedup', '未发现重复文章（当前规则：' + ruleLabel(rule) + '）。');
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
    : '标题+作者+年份';
}
