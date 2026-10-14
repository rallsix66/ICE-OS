import 'server-only';

import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Pool } from 'pg';

import { requireP002Config } from './p0-02-config';

type P002Auth = ReturnType<typeof betterAuth<BetterAuthOptions>>;

let authInstance: P002Auth | null = null;
let authPool: Pool | null = null;

export function getP002BetterAuth(): P002Auth {
  if (authInstance) {
    return authInstance;
  }

  const config = requireP002Config();
  authPool = new Pool({
    connectionString: config.authDatabaseUrl,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });

  const created = betterAuth({
    appName: 'iceos',
    baseURL: config.betterAuthUrl,
    basePath: '/api/auth',
    secret: config.betterAuthSecret,
    database: authPool,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    session: {
      cookieCache: {
        enabled: false,
      },
    },
    rateLimit: {
      enabled: process.env.P0_02_DISABLE_AUTH_RATE_LIMIT !== 'true',
      window: 60,
      max: 10,
    },
    trustedOrigins: [config.betterAuthUrl],
    advanced: {
      // loopback HTTP 验收（next start + Playwright）须可写入会话 Cookie；HTTPS 生产仍用 Secure。
      useSecureCookies:
        process.env.NODE_ENV === 'production' &&
        !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.betterAuthUrl),
    },
    plugins: [nextCookies()],
  });
  authInstance = created as unknown as P002Auth;

  return authInstance;
}

export async function closeP002AuthPool(): Promise<void> {
  authInstance = null;
  if (authPool) {
    await authPool.end();
    authPool = null;
  }
}
