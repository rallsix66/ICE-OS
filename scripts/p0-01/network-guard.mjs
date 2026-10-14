import net from 'node:net';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function deny(message) {
  const error = new Error(message);
  error.code = 'P0_01_NETWORK_DENIED';
  throw error;
}

export function installNetworkGuard(evidenceDir) {
  const blocked = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return originalFetch(input, init);
    }
    const host = url.hostname;
    if (!ALLOWED_HOSTS.has(host)) {
      blocked.push({ kind: 'fetch', target: url.toString(), code: 'P0_01_NETWORK_DENIED' });
      deny(`网络阻断: fetch ${url.toString()}`);
    }
    return originalFetch(input, init);
  };

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    let host;
    if (typeof args[0] === 'object' && args[0] && 'host' in args[0]) {
      host = args[0].host;
    } else if (typeof args[1] === 'string') {
      host = args[1];
    }
    if (host && !ALLOWED_HOSTS.has(host)) {
      blocked.push({ kind: 'net.connect', target: host, code: 'P0_01_NETWORK_DENIED' });
      deny(`网络阻断: connect ${host}`);
    }
    return originalConnect.apply(this, args);
  };

  return {
    blocked,
    evidenceDir,
    selfTest: async () => {
      let fetchBlocked = false;
      let deniedCode = null;
      try {
        await fetch('https://example.com');
      } catch (error) {
        fetchBlocked = error?.code === 'P0_01_NETWORK_DENIED';
        deniedCode = error?.code ?? null;
      }
      return { fetchBlocked, deniedCode, blockedCount: blocked.length };
    },
  };
}
