/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');

const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const allowedPorts = new Set(
  (process.env.P0_01_ALLOWED_PORTS ?? '5432')
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isFinite(port)),
);

function deny(message) {
  const error = new Error(message);
  error.code = 'P0_01_NETWORK_DENIED';
  throw error;
}

function checkHostPort(host, port) {
  const normalizedHost = host || 'localhost';
  if (!allowedHosts.has(normalizedHost)) {
    deny(`P0_01 网络阻断: 主机 ${normalizedHost}`);
  }
  if (port !== undefined && !allowedPorts.has(Number(port))) {
    deny(`P0_01 网络阻断: 端口 ${port}`);
  }
}

function connectOptions(args) {
  let current = args;
  if (Array.isArray(current[0])) {
    current = current[0];
  }
  if (typeof current[0] === 'object' && current[0] !== null) {
    return current[0];
  }
  return {
    port: current[0],
    host: typeof current[1] === 'string' ? current[1] : 'localhost',
  };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const options = connectOptions(args);
  if (options.path) {
    deny('P0_01 网络阻断: Unix socket');
  }
  checkHostPort(options.host, options.port);
  return originalConnect.apply(this, args);
};

const originalTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  const options = connectOptions(args);
  checkHostPort(options.host, options.port);
  return originalTlsConnect.apply(this, args);
};

const originalLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  checkHostPort(hostname, undefined);
  return originalLookup.call(this, hostname, ...rest);
};

const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function patchedPromiseLookup(hostname, ...rest) {
  checkHostPort(hostname, undefined);
  return originalPromiseLookup.call(this, hostname, ...rest);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === 'https:'
      ? 443
      : 80;
  checkHostPort(url.hostname, port);
  return originalFetch(input, { ...init, redirect: 'error' });
};

try {
  require('node:module').syncBuiltinESMExports();
} catch {
  // ignore
}

process.env.P0_01_NETWORK_GUARD_INSTALLED = 'true';
