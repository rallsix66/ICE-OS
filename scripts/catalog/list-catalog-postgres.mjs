import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './prepare.mjs';

const root = path.join(REPO_ROOT, '.local', 'catalog');
if (!fs.existsSync(root)) { console.log('no catalog runs'); process.exit(0); }
for (const name of fs.readdirSync(root).filter((n) => n.startsWith('run-')).sort()) {
  const inst = path.join(root, name, 'instance', 'catalog-instance.json');
  if (!fs.existsSync(inst)) continue;
  const j = JSON.parse(fs.readFileSync(inst, 'utf8'));
  console.log(`${name}\t127.0.0.1:${j.port}\t${j.label ?? '?'}\tpreviewReady=${Boolean(j.previewReady)}`);
}
