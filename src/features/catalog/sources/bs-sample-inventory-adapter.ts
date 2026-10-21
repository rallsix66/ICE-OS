import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BASELINE_DIRECTORY } from './baseline-adapter';

export const BS_SAMPLE_XLSX_SHA256 = '53d88779fb10f5269cde58204d262d724d8b2a821c24df6e3c72b0d11fc77020';
export const BS_SAMPLE_EXPORT_LABEL = '2026-10-15导出样表';

export interface BsSampleInventoryRow {
  excelRow: number;
  sourceRowKey: string;
  warehouse: string;
  sku: string;
  onHand: string | null;
  orderLocked: string | null;
  warehouseAvailable: string | null;
  activityReserved: string | null;
  inTransit: string | null;
  formulaOk: boolean | null;
}

export interface PreparedBsSampleInventory {
  exportLabel: string;
  sourceXlsxSha256: string;
  sheetName: string;
  rowCount: number;
  rows: BsSampleInventoryRow[];
  contentSha256: string;
}

function repoPath(...segments: string[]) {
  return path.join(process.cwd(), BASELINE_DIRECTORY, ...segments);
}

export async function loadPreparedBsSampleInventory(extractedJsonPath?: string): Promise<PreparedBsSampleInventory> {
  const file = extractedJsonPath ?? repoPath('coverage', 'inputs', 'bs-sample-inventory.extracted.json');
  const bytes = await fs.readFile(file);
  const parsed = JSON.parse(bytes.toString('utf8')) as Omit<PreparedBsSampleInventory, 'contentSha256'>;
  if (parsed.sourceXlsxSha256 !== BS_SAMPLE_XLSX_SHA256 || parsed.rowCount !== 530 || parsed.rows.length !== 530) {
    throw new Error('BS_SAMPLE_INVENTORY_INVALID');
  }
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');
  return { ...parsed, contentSha256 };
}

export async function ensureBsSampleExtract(extractedPath: string): Promise<PreparedBsSampleInventory> {
  try {
    return await loadPreparedBsSampleInventory(extractedPath);
  } catch {
    const { spawnSync } = await import('node:child_process');
    const xlsx = repoPath('input-1.frozen.xlsx');
    const script = path.join(process.cwd(), 'scripts/catalog/extract-bs-sample-inventory.py');
    const result = spawnSync('python', ['-X', 'utf8', script, xlsx, extractedPath], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('BS_SAMPLE_EXTRACT_FAILED');
    return loadPreparedBsSampleInventory(extractedPath);
  }
}
