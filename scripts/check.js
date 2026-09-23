// Syntax-check every JavaScript file (server, admin, browser modules). Used by CI: `npm run check`.
// Copyright (c) 2026 PacificAI. All rights reserved.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', '.venv', 'data', 'backups']);
function* jsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (/\.(m?js)$/.test(entry.name)) yield path;
  }
}

let failed = 0;
let count = 0;
for (const file of jsFiles('.')) {
  count++;
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${file}\n${r.stderr}`);
  }
}
console.log(`${count - failed}/${count} files OK`);
process.exit(failed ? 1 : 0);
