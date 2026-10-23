import type { Page, Request } from '@playwright/test';

export type CatalogActionProbe = {
  actionId: string;
  contentType: string;
  bodyIncludes: string;
};

/** Capture the Next-Action id for a server action whose POST body contains `needle`. */
export async function captureCatalogAction(
  page: Page,
  run: () => Promise<void>,
  needle: string,
): Promise<CatalogActionProbe> {
  let probe: CatalogActionProbe | null = null;
  const onRequest = (request: Request) => {
    if (probe) return;
    if (request.method() !== 'POST') return;
    const actionId = request.headers()['next-action'];
    if (!actionId) return;
    const body = request.postData() ?? '';
    if (!body.includes(needle)) return;
    probe = {
      actionId,
      contentType: request.headers()['content-type'] ?? 'text/plain;charset=UTF-8',
      bodyIncludes: needle,
    };
  };
  page.on('request', onRequest);
  try {
    await run();
  } finally {
    page.off('request', onRequest);
  }
  if (!probe) throw new Error(`CATALOG_ACTION_PROBE_MISS:${needle}`);
  return probe;
}

/** Replace only JSON payloads that look like catalog action results for the targeted action id. */
export function patchCatalogActionFailure(body: string, message: string): string {
  return body.split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]+):(\{.*"success".*\})$/i);
    if (!match) return line;
    try {
      const parsed = JSON.parse(match[2]) as { success?: boolean };
      if (typeof parsed.success !== 'boolean') return line;
      return `${match[1]}:${JSON.stringify({ success: false, error: message })}`;
    } catch {
      return line;
    }
  }).join('\n');
}
