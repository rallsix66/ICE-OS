import { safeEnv } from './prepare.mjs';

export const DEFAULT_PREVIEW_PORT = 3010;
export const DEFAULT_PREVIEW_MODE = 'start';

/**
 * Explicit preview port/mode for ensure, start, stop, status and probes.
 * Parent process env is not forwarded wholesale — only these keys are injected via safeEnv.
 */
export function readPreviewOperatingConfig(fromEnv = process.env) {
  const portRaw = fromEnv.CATALOG_PREVIEW_PORT ?? String(DEFAULT_PREVIEW_PORT);
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`CATALOG_PREVIEW_PORT_INVALID:${portRaw}`);
  }
  const modeRaw = (fromEnv.CATALOG_PREVIEW_NEXT_MODE ?? DEFAULT_PREVIEW_MODE).toLowerCase();
  const mode = modeRaw === 'dev' ? 'dev' : 'start';
  const authBaseUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    mode,
    authBaseUrl,
    catalogUrl: `${authBaseUrl}/dashboard/catalog`,
  };
}

export function previewOperatingEnv(config, extra = {}) {
  const resolved = config?.port ? config : readPreviewOperatingConfig();
  return safeEnv({
    CATALOG_PREVIEW_PORT: String(resolved.port),
    CATALOG_PREVIEW_NEXT_MODE: resolved.mode,
    ...extra,
  });
}
