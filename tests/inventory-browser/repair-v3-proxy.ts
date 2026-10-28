import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本地反向代理（只用于 v3 恢复链验证）：
 * - pass：正常转发；
 * - drop-response：把下一个 POST 完整转发给上游并等上游响应完成（业务/DB 已落库），
 *   但**不把响应返回浏览器**，浏览器侧表现为连接中断（“响应丢失”）；
 * - drop-request：直接销毁下一个 POST 的浏览器连接，**不转发**（请求未达服务端）。
 *
 * 只影响一个 POST，随后自动恢复 pass；只做 HTTP，不代理 WebSocket/HMR（生产 BUILD 不需要）。
 * 不使用假回执：A 的回执由上游真实数据库产生，再由服务端 reconcile 读回。
 */
export type DropMode = 'pass' | 'drop-response' | 'drop-request';

interface DroppedInfo {
  mode: Exclude<DropMode, 'pass'>;
  url: string;
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
  // Better Auth 校验 Origin/Referer；浏览器经代理访问时把 3044 改写为上游 3033，避免 Invalid origin。
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

function proxyPass(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamBase: string,
): void {
  const target = upstreamTarget(upstreamBase);
  const headers = upstreamHeaders(req, upstreamBase);
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
        const body = Buffer.concat(chunks);
        const headers: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
        delete headers['transfer-encoding'];
        headers['content-length'] = String(body.length);
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        res.end(body);
      });
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy upstream error');
  });
  req.pipe(upstream);
}

export async function startProxy(upstreamBase: string, port: number): Promise<string> {
  if (server) return `http://127.0.0.1:${port}`;
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && dropMode !== 'pass') {
      const mode = dropMode;
      dropMode = 'pass'; // 只影响本次 POST；随后的整页恢复 GET 必须放行。
      dropped.push({ mode, url: req.url ?? '', at: new Date().toISOString() });
      if (mode === 'drop-request') {
        // 不转发：请求没有到达服务端；代理只返回网关错误，浏览器拿不到任何业务回执。
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('LOCAL_PROXY_REQUEST_NOT_FORWARDED');
        return;
      }
      // drop-response：完整转发并消费上游响应（确保 DB 已提交），然后销毁浏览器连接。
      const target = upstreamTarget(upstreamBase);
      const headers = upstreamHeaders(req, upstreamBase);
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url ?? '/',
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          upstreamRes.resume();
          upstreamRes.on('end', () => {
            // 已完整收到上游响应（服务端业务/DB 已完成），但代理丢弃它，只回网关错误：
            // 浏览器拿不到真实回执，也不会把“响应丢失”误判成明确未生效。
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('LOCAL_PROXY_RESPONSE_WITHHELD');
          });
        },
      );
      upstream.on('error', () => {
        res.destroy();
        req.socket.destroy();
      });
      req.pipe(upstream);
      return;
    }
    proxyPass(req, res, upstreamBase);
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
