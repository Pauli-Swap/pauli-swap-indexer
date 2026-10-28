// Copies the interface's pure math into src/lib so both repos produce the same
// numbers (docs/INDEXER.md §8.5). The copies are not edited by hand.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repo = path.resolve(process.argv[2] ?? '../pauli-swap-interface');
const FILES = ['src/lib/v3.ts'];

let source = 'working tree';
try {
  source = execSync('git rev-parse --short HEAD', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // The interface is not always a git checkout; the header then says so.
}

fs.mkdirSync('src/lib', { recursive: true });
for (const file of FILES) {
  const body = fs.readFileSync(path.join(repo, file), 'utf8');
  const header = `// Synced from pauli-swap-interface/${file} (${source}) by scripts/sync-lib.mjs. Do not edit.\n`;
  fs.writeFileSync(path.join('src/lib', path.basename(file)), header + body);
}
console.log(`synced ${FILES.length} file(s) from ${repo} (${source})`);
