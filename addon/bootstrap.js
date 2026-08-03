'use strict';

// Zotero Dedup — bootstrap entry (Zotero 7+ / 9, WebExtension bootstrap)
const PLUGIN_ID = 'zotero-dedup@example.com';
const CONTENT_BASE = 'chrome://dedup/content/';
const MENU_ID = 'zotero-dedup-menuitem';
const TOOLS_POPUP_ID = 'menu_ToolsPopup';

// Track registered popups and their listeners for cleanup
const popupListeners = new WeakMap();
let chromeHandle = null;

function log(msg) {
  try { Zotero.debug('[Zotero Dedup] ' + msg); } catch (e) {}
}

// Get nsIIOService for creating URIs
function getIOService() {
  return Components.classes['@mozilla.org/network/io-service;1']
    .getService(Components.interfaces.nsIIOService);
}

function startup(data, reason) {
  data = data || {};
  const rootURI = data.rootURI;
  try {
    const aomStartup = Components.classes['@mozilla.org/addons/addon-manager-startup;1']
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = getIOService().newURI(rootURI + 'chrome.manifest', null, null);
    // Register chrome package manually (Zotero 7+ style)
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ['content', 'dedup', rootURI + 'content/']
    ]);
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
  } catch (e) {
    log('onMainWindowUnload remove failed: ' + e);
  }
}

function shutdown(data, reason) {
  log('shutting down (reason=' + reason + ')');

  // Remove menu items from all open windows
  try {
    if (typeof Zotero.getMainWindows === 'function') {
      for (const win of Zotero.getMainWindows()) {
        if (win && win.document) removeMenuItem(win.document);
      }
    }
  } catch (e) {
    log('shutdown menu cleanup failed: ' + e);
  }

  // Unregister Chrome manifest
  try {
    if (chromeHandle) {
      chromeHandle.destruct();
      chromeHandle = null;
      log('chrome unregistered');
    }
  } catch (e) {
    log('shutdown chrome cleanup failed: ' + e);
  }

  // Unregister preference pane
  try {
    if (Zotero.PreferencePanes && Zotero.PreferencePanes.unregister) {
      Zotero.PreferencePanes.unregister(PLUGIN_ID);
      log('pref pane unregistered');
    }
  } catch (e) {
    log('shutdown pref pane cleanup failed: ' + e);
  }
}

function install(data, reason) {
  log('installed (reason=' + reason + ')');
}

function uninstall(data, reason) {
  log('uninstalled (reason=' + reason + ')');
  // Clean up preferences
  try {
    Zotero.Prefs.clear('extensions.zotero-dedup.rule', true);
    Zotero.Prefs.clear('extensions.zotero-dedup.scope', true);
    Zotero.Prefs.clear('extensions.zotero-dedup.includePDF', true);
    log('preferences cleared');
  } catch (e) {
    log('uninstall prefs cleanup failed: ' + e);
  }
}

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
  const listener = () => {
    if (!doc.getElementById(MENU_ID)) addMenuItem(doc);
  };
  popup.addEventListener('popupshowing', listener);
  popupListeners.set(popup, listener);
}

function removeMenuItem(doc) {
  if (!doc) return;
  const mi = doc.getElementById(MENU_ID);
  if (mi) mi.remove();

  // Remove popupshowing listener
  const popup = getToolsPopup(doc);
  if (popup && popupListeners.has(popup)) {
    const listener = popupListeners.get(popup);
    popup.removeEventListener('popupshowing', listener);
    popupListeners.delete(popup);
  }
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

// Extract a 4-digit year from a date string
function extractYear(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.toString().match(/(\d{4})/);
  if (!match) return '';
  const year = parseInt(match[1], 10);
  // Sanity check: year should be between 1800 and 2100
  if (year >= 1800 && year <= 2100) return match[1];
  return '';
}

// Get PDF attachments of an item together with their content MD5
// (read from Zotero's stored attachment hash — no file I/O needed).
// Pure JS MD5 implementation (RFC 1321) for environments where crypto.subtle MD5 is unavailable
function _md5Bytes(bytes) {
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

  const n = bytes.length;
  const state = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476];
  // Pad the input
  const padded = new Uint8Array(Math.ceil((n + 9) / 64) * 64);
  padded.set(bytes);
  padded[n] = 0x80;
  // Append length in bits (little-endian, 64-bit)
  const bitLen = n * 8;
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  for (let i = 0; i < padded.length; i += 64) {
    const x = new Uint32Array(padded.buffer, padded.byteOffset + i, 16);
    let [a, b, c, d] = state;
    a = ff(a, b, c, d, x[ 0],  7, 0xd76aa478);
    d = ff(d, a, b, c, x[ 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, x[ 2], 17, 0x242070db);
    b = ff(b, c, d, a, x[ 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, x[ 4],  7, 0xf57c0faf);
    d = ff(d, a, b, c, x[ 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, x[ 6], 17, 0xa8304613);
    b = ff(b, c, d, a, x[ 7], 22, 0xfd469501);
    a = ff(a, b, c, d, x[ 8],  7, 0x698098d8);
    d = ff(d, a, b, c, x[ 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, x[10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, x[11], 22, 0x895cd7be);
    a = ff(a, b, c, d, x[12],  7, 0x6b901122);
    d = ff(d, a, b, c, x[13], 12, 0xfd987193);
    c = ff(c, d, a, b, x[14], 17, 0xa679438e);
    b = ff(b, c, d, a, x[15], 22, 0x49b40821);

    a = gg(a, b, c, d, x[ 1],  5, 0xf61e2562);
    d = gg(d, a, b, c, x[ 6],  9, 0xc040b340);
    c = gg(c, d, a, b, x[11], 14, 0x265e5a51);
    b = gg(b, c, d, a, x[ 0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, x[ 5],  5, 0xd62f105d);
    d = gg(d, a, b, c, x[10],  9, 0x02441453);
    c = gg(c, d, a, b, x[15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, x[ 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, x[ 9],  5, 0x21e1cde6);
    d = gg(d, a, b, c, x[14],  9, 0xc33707d6);
    c = gg(c, d, a, b, x[ 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, x[ 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, x[13],  5, 0xa9e3e905);
    d = gg(d, a, b, c, x[ 2],  9, 0xfcefa3f8);
    c = gg(c, d, a, b, x[ 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, x[12], 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, x[ 5],  4, 0xfffa3942);
    d = hh(d, a, b, c, x[ 8], 11, 0x8771f681);
    c = hh(c, d, a, b, x[11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, x[14], 23, 0xfde5380c);
    a = hh(a, b, c, d, x[ 1],  4, 0xa4beea44);
    d = hh(d, a, b, c, x[ 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, x[ 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, x[10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, x[13],  4, 0x289b7ec6);
    d = hh(d, a, b, c, x[ 0], 11, 0xeaa127fa);
    c = hh(c, d, a, b, x[ 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, x[ 6], 23, 0x04881d05);
    a = hh(a, b, c, d, x[ 9],  4, 0xd9d4d039);
    d = hh(d, a, b, c, x[12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, x[15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, x[ 2], 23, 0xc4ac5665);

    a = ii(a, b, c, d, x[ 0],  6, 0xf4292244);
    d = ii(d, a, b, c, x[ 7], 10, 0x432aff97);
    c = ii(c, d, a, b, x[14], 15, 0xab9423a7);
    b = ii(b, c, d, a, x[ 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, x[12],  6, 0x655b59c3);
    d = ii(d, a, b, c, x[ 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, x[10], 15, 0xffeff47d);
    b = ii(b, c, d, a, x[ 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, x[ 8],  6, 0x6fa87e4f);
    d = ii(d, a, b, c, x[15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, x[ 6], 15, 0xa3014314);
    b = ii(b, c, d, a, x[13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, x[ 4],  6, 0xf7537e82);
    d = ii(d, a, b, c, x[11], 10, 0xbd3af235);
    c = ii(c, d, a, b, x[ 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, x[ 9], 21, 0xeb86d391);

    state[0] = add32(state[0], a);
    state[1] = add32(state[1], b);
    state[2] = add32(state[2], c);
    state[3] = add32(state[3], d);
  }

  // Convert to hex string (little-endian)
  let hex = '';
  for (let i = 0; i < 4; i++) {
    const val = state[i];
    hex += ((val & 0xFF).toString(16).padStart(2, '0')) +
           (((val >>> 8) & 0xFF).toString(16).padStart(2, '0')) +
           (((val >>> 16) & 0xFF).toString(16).padStart(2, '0')) +
           (((val >>> 24) & 0xFF).toString(16).padStart(2, '0'));
  }
  return hex;
}

// Compute MD5 of a file using best available method
async function md5File(filePath) {
  try {
    // Method 1: Zotero.File.md5() or Zotero.File.hash()
    if (Zotero.File && typeof Zotero.File.md5 === 'function') {
      return (await Zotero.File.md5(filePath)).toLowerCase();
    }
    if (Zotero.File && typeof Zotero.File.hash === 'function') {
      return (await Zotero.File.hash(filePath, 'md5')).toLowerCase();
    }
    // Method 2: crypto.subtle (may not support MD5)
    if (typeof IOUtils !== 'undefined' && IOUtils.read &&
        typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      try {
        const data = await IOUtils.read(filePath);
        const hashBuf = await crypto.subtle.digest('MD5', data);
        const hashArr = Array.from(new Uint8Array(hashBuf));
        return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        // crypto.subtle doesn't support MD5 — fall through to pure JS
      }
    }
    // Method 3: Pure JS MD5
    if (typeof IOUtils !== 'undefined' && IOUtils.read) {
      const data = await IOUtils.read(filePath);
      return _md5Bytes(new Uint8Array(data));
    }
    // Method 4: OS.File (older Zotero versions)
    if (typeof OS !== 'undefined' && OS.File && OS.File.read) {
      const data = await OS.File.read(filePath);
      return _md5Bytes(new Uint8Array(data));
    }
  } catch (e) {
    log('md5File error for ' + filePath + ': ' + e);
  }
  return '';
}

async function getPdfAttachments(item) {
  const out = [];
  // Only regular items have meaningful attachments for dedup
  if (!item || !item.isRegularItem || !item.isRegularItem()) return out;
  try {
    const ids = await item.getAttachments();
    for (const id of ids) {
      const att = Zotero.Items.get(id);
      if (!att) continue;
      // Determine content type
      let ct = '';
      try { ct = att.attachmentContentType || att.getField('contentType') || ''; } catch (e) {}
      if (ct !== 'application/pdf') {
        // Also check by filename extension
        let fn = '';
        try { fn = att.attachmentFilename || att.getField('filename') || ''; } catch (e) {}
        if (!fn.toLowerCase().endsWith('.pdf')) continue;
      }
      // Try multiple ways to get the MD5 hash
      let md5 = '';
      let md5Source = '';

      // Method 1: stored MD5 field
      try {
        const fieldMd5 = att.getField ? (att.getField('md5') || '') : '';
        if (fieldMd5) { md5 = fieldMd5.toString().toLowerCase(); md5Source = 'getField(md5)'; }
      } catch (e) {}

      // Method 2: attachmentMD5 property
      if (!md5) {
        try {
          if (att.attachmentMD5) { md5 = att.attachmentMD5.toString().toLowerCase(); md5Source = 'attachmentMD5'; }
        } catch (e) {}
      }

      // Method 3: try getFilePath and compute MD5 from the file
      if (!md5) {
        try {
          let filePath = '';
          if (typeof att.getFilePath === 'function') {
            filePath = att.getFilePath();
          } else if (att.attachmentPath) {
            filePath = att.attachmentPath;
          }
          if (filePath) {
            // Check if file exists
            let exists = false;
            if (typeof IOUtils !== 'undefined' && IOUtils.exists) {
              exists = await IOUtils.exists(filePath);
            } else if (Zotero.File && Zotero.File.exists) {
              exists = Zotero.File.exists(filePath);
            }
            if (exists) {
              md5 = await md5File(filePath);
              if (md5) md5Source = 'file hash';
            }
          }
        } catch (e) {
          log('getPdfAttachments: file hash method failed for att ' + id + ': ' + e);
        }
      }

      if (!md5) {
        log('getPdfAttachments: no MD5 found for attachment ' + id +
            ' (title=' + (att.getField ? att.getField('title') : '?') + ')');
        continue;
      }
      log('getPdfAttachments: attachment ' + id + ' md5=' + md5 + ' (source: ' + md5Source + ')');
      out.push({ id: id, md5: md5 });
    }
  } catch (e) {
    log('getPdfAttachments error for item ' + (item?.id || '?') + ': ' + e);
  }
  return out;
}

// Build a set of candidate match-keys for one item.
// Two items are considered duplicates if they share at least one candidate key.
//
// Rules:
//   - doi: only DOI matches (strictest)
//   - title-author-year: title + authors + year (recommended)
//   - title: normalized title only
//   - pdf: only PDF content MD5 matches
//
// The "includePDF" preference controls whether PDF hashes are added as an
// EXTRA signal on top of the metadata rule (default: true for backward compat).
async function candidateKeys(item, rule, pdfs, includePDF) {
  const keys = new Set();
  const title = normalize(item.getField('title'));

  const doi = (item.getField('DOI') || '').trim().toLowerCase();
  if (doi && (rule === 'doi' || rule === 'title-author-year' || rule === 'title')) {
    keys.add('doi:' + doi);
  }

  if (title && rule !== 'doi' && rule !== 'pdf') {
    if (rule === 'title') {
      keys.add('t:' + title);
    } else if (rule === 'title-author-year') {
      let authors = '';
      try {
        const creators = item.getCreators();
        authors = creators
          .map(c => '[' + normalize((c.firstName || '') + ' ' + (c.lastName || '')) + ']')
          .filter(s => s !== '[]')
          .sort()
          .join(',');
      } catch (e) {}
      const year = extractYear(item.getField('date'));
      if (authors && year) {
        keys.add('tay:' + title + '|' + authors + '|' + year);
      } else if (authors) {
        keys.add('ta:' + title + '|' + authors);
      } else if (year) {
        keys.add('ty:' + title + '|' + year);
      } else {
        keys.add('t:' + title);
      }
    }
  }

  // PDF content hashes
  if (includePDF || rule === 'pdf') {
    for (const p of pdfs) {
      if (p.md5) keys.add('pdf:' + p.md5);
    }
  }

  return keys;
}

async function detectDuplicates(items, rule, includePDF, onProgress) {
  // Filter to only regular items (exclude attachments, notes, etc.)
  const regularItems = items.filter(item => item.isRegularItem && item.isRegularItem());
  log('detectDuplicates: ' + items.length + ' total items, ' + regularItems.length + ' regular items');

  // Union-find on items with path compression + rank for efficiency
  const parent = new Map();
  const rank = new Map();
  const find = x => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x))); // path halving
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) || 0;
    const rankB = rank.get(rb) || 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else {
      parent.set(rb, ra);
      if (rankA === rankB) rank.set(ra, rankA + 1);
    }
  };

  const keyOwner = new Map();
  const pdfsByItem = new Map();
  const total = regularItems.length;

  // Fetch PDF attachments with progress updates
  const allPdfs = new Array(regularItems.length);
  let processed = 0;
  // Process in batches to allow progress updates
  const batchSize = 5;
  for (let i = 0; i < regularItems.length; i += batchSize) {
    const batch = regularItems.slice(i, i + batchSize);
    const batchPromises = batch.map(item => getPdfAttachments(item));
    const batchResults = await Promise.all(batchPromises);
    for (let j = 0; j < batchResults.length; j++) {
      allPdfs[i + j] = batchResults[j];
    }
    processed += batch.length;
    if (onProgress) {
      try { onProgress(Math.min(processed, total), total); } catch (e) {}
    }
    // Yield to UI thread
    await new Promise(r => setTimeout(r, 0));
  }

  for (let i = 0; i < regularItems.length; i++) {
    const item = regularItems[i];
    if (!parent.has(item.id)) {
      parent.set(item.id, item.id);
      rank.set(item.id, 0);
    }
    const pdfs = allPdfs[i] || [];
    pdfsByItem.set(item.id, pdfs);
    for (const k of await candidateKeys(item, rule, pdfs, includePDF)) {
      if (keyOwner.has(k)) {
        union(item.id, keyOwner.get(k));
      } else {
        keyOwner.set(k, item.id);
      }
    }
  }

  const groupsMap = new Map();
  for (const item of regularItems) {
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
  let totalPdfs = 0;
  let itemsWithPdfs = 0;
  for (const [id, pdfs] of pdfsByItem) {
    if (pdfs.length > 0) {
      itemsWithPdfs++;
      totalPdfs += pdfs.length;
    }
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
  log('detect: ' + itemsWithPdfs + ' items with PDFs, ' + totalPdfs + ' total PDF attachments');
  return groups;
}

// ---------- scan ----------

// Recursively get all child items from a collection and its subcollections
async function getChildItemsRecursive(collection) {
  let items = await collection.getChildItems();
  const childCollections = await collection.getChildCollections();
  for (const childColl of childCollections) {
    const childItems = await getChildItemsRecursive(childColl);
    items = items.concat(childItems);
  }
  // Deduplicate by id
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function scan(window) {
  let progressWin = null;
  try {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) {
      Zotero.alert(window, 'Zotero Dedup', '无法获取当前 Zotero 窗口。');
      return;
    }

    const scope = Zotero.Prefs.get('extensions.zotero-dedup.scope', true) || 'collection-recursive';
    let items = [];

    if (scope === 'collection' || scope === 'collection-recursive') {
      const coll = pane.getSelectedCollection();
      if (!coll) {
        Zotero.alert(window, 'Zotero Dedup', '请先在左侧选择一个收藏夹（分类）。');
        return;
      }
      if (scope === 'collection-recursive') {
        items = await getChildItemsRecursive(coll);
      } else {
        items = await coll.getChildItems();
      }
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

    // Filter to only regular items before counting / showing
    const regularItems = items.filter(item => item.isRegularItem && item.isRegularItem());
    if (!regularItems.length) {
      Zotero.alert(window, 'Zotero Dedup', '当前范围内没有可扫描的文献条目。');
      return;
    }

    // Show progress window immediately so user knows scanning is in progress
    try {
      progressWin = window.openDialog(
        CONTENT_BASE + 'progress.xhtml',
        'zotero-dedup-progress',
        'chrome,titlebar,centerscreen,modal=no,resizable=no,width=360,height=140',
        { total: regularItems.length, title: 'Zotero Dedup — 正在扫描' }
      );
    } catch (e) {
      log('failed to open progress window: ' + e);
    }

    // Small delay to let progress window render before heavy work begins
    await new Promise(r => setTimeout(r, 50));

    const rule = Zotero.Prefs.get('extensions.zotero-dedup.rule', true) || 'title-author-year';
    const includePDF = Zotero.Prefs.get('extensions.zotero-dedup.includePDF', true) !== false; // default true

    // Run detection with progress callback
    const groups = await detectDuplicates(regularItems, rule, includePDF, (current, total) => {
      if (progressWin && !progressWin.closed && progressWin.updateProgress) {
        try { progressWin.updateProgress(current, total); } catch (e) {}
      }
    });

    // Close progress window
    if (progressWin && !progressWin.closed) {
      try { progressWin.close(); } catch (e) {}
    }
    progressWin = null;

    log('scan: ' + regularItems.length + ' item(s) scanned, ' + groups.length + ' duplicate group(s) found (rule=' + rule + ', includePDF=' + includePDF + ')');

    if (!groups.length) {
      Zotero.alert(
        window,
        'Zotero Dedup',
          '未发现重复文章。\n\n已扫描 ' + regularItems.length + ' 条文献，规则：' + ruleLabel(rule) +
          (includePDF ? '（含 PDF 内容匹配）' : '') +
          '。\n\n若重复项是「内容相同的 PDF」，请在设置中开启「同时按 PDF 内容匹配」，并确认这些 PDF 已真正存入 Zotero 存储（而非仅链接）。'
      );
      return;
    }

    const args = { groups, rule, includePDF, opener: window };
    window.openDialog(
      CONTENT_BASE + 'dedupDialog.xhtml',
      'zotero-dedup-dialog',
      'chrome,titlebar,centerscreen,modal,resizable=yes,width=720,height=640',
      args
    );
  } catch (e) {
    // Close progress window on error
    if (progressWin && !progressWin.closed) {
      try { progressWin.close(); } catch (err) {}
    }
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
