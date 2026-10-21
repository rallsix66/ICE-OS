import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { collectWorkspaceSourceHashes, snapshotWorkspace } from '../../scripts/catalog/prepare.mjs';

describe('preview workspace snapshot', () => {
  it('includes valuation basis JSON in source hashes and isolated copy', () => {
    const hashes = collectWorkspaceSourceHashes();
    expect(hashes['docs/catalog/local-sample-valuation-basis-20261021.json']).toMatch(/^[a-f0-9]{64}$/);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-catalog-ws-'));
    try {
      snapshotWorkspace(workspace);
      const basis = path.join(workspace, 'docs/catalog/local-sample-valuation-basis-20261021.json');
      expect(fs.existsSync(basis)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
