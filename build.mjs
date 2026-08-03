import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

// Simple ZIP builder using Node.js built-ins (no external dependencies).

function collectFiles(dir, base = dir, files = []) {
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (name === '.DS_Store') continue;
    const full = join(dir, name);
    const rel = relative(base, full).replace(/\\/g, '/');
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(full, base, files);
    } else {
      files.push({ path: rel, data: readFileSync(full), time: st.mtime });
    }
  }
  return files;
}

function dosDateTime(date) {
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const y = date.getFullYear() - 1980;
  const h = date.getHours();
  const mi = date.getMinutes();
  const s = Math.floor(date.getSeconds() / 2);
  const datePart = (y << 9) | (m << 5) | d;
  const timePart = (h << 11) | (mi << 5) | s;
  return { date: datePart, time: timePart };
}

function buildZip(files) {
  const chunks = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.path, 'utf-8');
    const data = file.data;
    const compressed = deflateRawSync(data);
    const crcVal = crc32(data);
    const { date, time } = dosDateTime(file.time || new Date());

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);       // signature
    localHeader.writeUInt16LE(20, 4);               // version needed
    localHeader.writeUInt16LE(0, 6);                // flags
    localHeader.writeUInt16LE(8, 8);                // compression method (deflate)
    localHeader.writeUInt16LE(time, 10);            // last mod time
    localHeader.writeUInt16LE(date, 12);            // last mod date
    localHeader.writeUInt32LE(crcVal, 14);          // CRC32
    localHeader.writeUInt32LE(compressed.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22);     // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);  // filename length
    localHeader.writeUInt16LE(0, 28);               // extra field length
    nameBuf.copy(localHeader, 30);

    chunks.push(localHeader);
    chunks.push(compressed);

    // Central directory entry
    const centralEntry = Buffer.alloc(46 + nameBuf.length);
    centralEntry.writeUInt32LE(0x02014b50, 0);      // signature
    centralEntry.writeUInt16LE(20, 4);              // version made by
    centralEntry.writeUInt16LE(20, 6);              // version needed
    centralEntry.writeUInt16LE(0, 8);               // flags
    centralEntry.writeUInt16LE(8, 10);              // compression method
    centralEntry.writeUInt16LE(time, 12);           // last mod time
    centralEntry.writeUInt16LE(date, 14);           // last mod date
    centralEntry.writeUInt32LE(crcVal, 16);         // CRC32
    centralEntry.writeUInt32LE(compressed.length, 20); // compressed size
    centralEntry.writeUInt32LE(data.length, 24);    // uncompressed size
    centralEntry.writeUInt16LE(nameBuf.length, 28); // filename length
    centralEntry.writeUInt16LE(0, 30);              // extra field length
    centralEntry.writeUInt16LE(0, 32);              // file comment length
    centralEntry.writeUInt16LE(0, 34);              // disk number start
    centralEntry.writeUInt16LE(0, 36);              // internal attributes
    centralEntry.writeUInt32LE(0, 38);              // external attributes
    centralEntry.writeUInt32LE(offset, 42);         // relative offset
    nameBuf.copy(centralEntry, 46);

    centralDir.push(centralEntry);
    offset += localHeader.length + compressed.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of centralDir) {
    chunks.push(entry);
    centralSize += entry.length;
  }

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                // signature
  eocd.writeUInt16LE(0, 4);                         // disk number
  eocd.writeUInt16LE(0, 6);                         // disk with start of central dir
  eocd.writeUInt16LE(files.length, 8);              // entries on this disk
  eocd.writeUInt16LE(files.length, 10);             // total entries
  eocd.writeUInt32LE(centralSize, 12);              // central dir size
  eocd.writeUInt32LE(centralStart, 16);             // offset of central dir
  eocd.writeUInt16LE(0, 20);                        // comment length

  chunks.push(eocd);
  return Buffer.concat(chunks);
}

mkdirSync('build', { recursive: true });
const files = collectFiles('addon');
const zip = buildZip(files);
writeFileSync('build/zotero-dedup.xpi', zip);
console.log('Built build/zotero-dedup.xpi (' + files.length + ' files, ' + zip.length + ' bytes)');
