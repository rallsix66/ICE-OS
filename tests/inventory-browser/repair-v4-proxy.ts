import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本地反向代理（v4 恢复链验证；从 v3 代理复制并扩展）。
 *
 * v4 的每个写动作有两个 server action POST：
 *   1) register —— `registerInventoryRequestAction({requestId,action,intent,payload})`（先登记）；
 *   2) business —— 原动作（内部同 requestId 幂等 begin）。
 * 代理按 **POST body 内容**区分二者（register body 含 `"action":…,"intent":…,"payload":…` 且不含
 * `"originActorId"`；reconcile/retry 的本地回退 body 含 originActorId，单独归类 unknown）。
 *
 * 模式（只影响下一个匹配的 POST，随后自动恢复 pass）：
 * - pass；
 * - drop-request / drop-response：任意 POST；
 * - drop-request-register / drop-response-register：只匹配“登记”POST；
 * - drop-request-business / drop-response-business：只匹配“业务动作”POST。
 *
 * drop-request：不转发（请求未达服务端）；drop-response：完整转发并等上游响应完成（DB 已提交）后再丢弃，
 * 浏览器只看到网关错误。不使用假回执。
 */
export type DropMode =
  | 'pass'
  | 'drop-request'
  | 'drop-response'
  | 'drop-request-register'
  | 'drop-response-register'
  | 'drop-request-business'
  | 'drop-response-business';

export type PostKind = 'register' | 'business' | 'unknown';

export interface DroppedInfo {
  mode: Exclude<DropMode, 'pass'>;
  kind: PostKind;
  matched: boolean;
  url: string;
  nextAction: string | null;
  at: string;
}

let server: http.Server | null = null;
let dropMode: DropMode = 'pass';
let dropped: DroppedInfo[] = [];

function upstreamTarget(upstreamBase: string): { hostname: string; port: number; protocol: string } {
  const url = new URL(upstreamBase);
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    protocol: url.protocol,
  };
}

function upstreamHeaders(
  req: http.IncomingMessage,
  upstreamBase: string,
): http.OutgoingHttpHeaders {
  const target = upstreamTarget(upstreamBase);
  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: `${target.hostname}:${target.port}`,
  };
  // Better Auth 校验 Origin/Referer；浏览器经代理访问时把代理 origin 改写为上游，避免 Invalid origin。
  const localHost = req.headers.host;
  const localOrigin = localHost ? `http://${localHost}` : '';
  for (const key of ['origin', 'referer'] as const) {
    const value = headers[key];
    if (typeof value === 'string' && localOrigin && value.startsWith(localOrigin)) {
      headers[key] = upstreamBase + value.slice(localOrigin.length);
    }
  }
  return headers;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 按 body 内容判定 POST 是“先登记”还是“原业务动作”（只用内容特征，不依赖 action id）。 */
export function classifyPostBody(body: Buffer | string): PostKind {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  if (!text) return 'unknown';
  // 服务端保存了完整原请求内容：register body 一定带 action/intent/payload 三个键。
  const hasAction = /"action"\s*:/.test(text);
  const hasIntent = /"intent"\s*:/.test(text);
  const hasPayload = /"payload"\s*:/.test(text);
  if (hasAction && hasIntent && hasPayload) {
    // reconcile/retry 的本地回退输入也含 action/intent/payload，但一定带 originActorId。
    if (/"originActorId"\s*:/.test(text)) return 'unknown';
    return 'register';
  }
  return 'business';
}

function modeTargets(mode: Exclude<DropMode, 'pass'>): { action: 'request' | 'response'; kind: 'any' | PostKind } {
  if (mode === 'drop-request') return { action: 'request', kind: 'any' };
  if (mode === 'drop-response') return { action: 'response', kind: 'any' };
  if (mode === 'drop-request-register') return { action: 'request', kind: 'register' };
  if (mode === 'drop-response-register') return { action: 'response', kind: 'register' };
  if (mode === 'drop-request-business') return { action: 'request', kind: 'business' };
  return { action: 'response', kind: 'business' };
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamBase: string,
  body: Buffer,
  onUpstreamResponse?: (upstreamRes: http.IncomingMessage, chunks: Buffer[]) => void,
): void {
  const target = upstreamTarget(upstreamBase);
  const headers = upstreamHeaders(req, upstreamBase);
  if (body.length > 0) headers['content-length'] = String(body.length);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: req.url ?? '/',
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      upstreamRes.on('end', () => {
        if (onUpstreamResponse) {
          onUpstreamResponse(upstreamRes, chunks);
          return;
        }
        const payload = Buffer.concat(chunks);
        const outHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = String(payload.length);
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        res.end(payload);
      });
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy upstream error');
  });
  upstream.end(body);
}

function gatewayError(res: http.ServerResponse, text: string): void {
  res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

export async function startProxy(upstreamBase: string, port: number): Promise<string> {
  if (server) return `http://127.0.0.1:${port}`;
  server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      // GET/HEAD 直接透传（不缓冲）。
      forward(req, res, upstreamBase, Buffer.alloc(0));
      return;
    }
    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        gatewayError(res, 'proxy body read error');
        return;
      }
      const kind = classifyPostBody(body);
      const mode = dropMode;
      if (mode === 'pass') {
        forward(req, res, upstreamBase, body);
        return;
      }
      const target = modeTargets(mode);
      const matched = target.kind === 'any' || target.kind === kind;
      if (!matched) {
        // 不匹配的 POST 正常转发（drop 模式保持武装，等下一个匹配的 POST）。
        forward(req, res, upstreamBase, body);
        return;
      }
      dropMode = 'pass'; // 只影响本次匹配 POST；随后的整页恢复 GET 必须放行。
      const nextAction = typeof req.headers['next-action'] === 'string' ? req.headers['next-action'] : null;
      dropped.push({ mode, kind, matched: true, url: req.url ?? '', nextAction, at: new Date().toISOString() });
      if (target.action === 'request') {
        gatewayError(res, 'LOCAL_PROXY_REQUEST_NOT_FORWARDED');
        return;
      }
      forward(req, res, upstreamBase, body, () => {
        // 已完整收到上游响应（服务端业务/DB 已完成），但代理丢弃它，只回网关错误。
        gatewayError(res, 'LOCAL_PROXY_RESPONSE_WITHHELD');
      });
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

export function setDropMode(mode: DropMode): void {
  dropMode = mode;
}

export function consumeDropped(): DroppedInfo[] {
  const result = dropped;
  dropped = [];
  return result;
}

export async function stopProxy(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  server = null;
}
