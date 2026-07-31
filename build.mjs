import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('build', { recursive: true });
execSync('cd addon && zip -r -D ../build/zotero-dedup.xpi . -x "*.DS_Store"', { stdio: 'inherit' });
console.log('Built build/zotero-dedup.xpi');
