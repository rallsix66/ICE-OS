import 'server-only';

import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';

type P001Auth = ReturnType<typeof betterAuth<BetterAuthOptions>>;
import { nextCookies } from 'better-auth/next-js';
import { Pool } from 'pg';

import { requireP001Config } from './p0-01-config';

let authInstance: P001Auth | null = null;
let authPool: Pool | null = null;

export function getP001BetterAuth(): P001Auth {
  if (authInstance) {
    return authInstance;
  }

  const config = requireP001Config();
  authPool = new Pool({
    connectionString: config.authDatabaseUrl,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });

  const created = betterAuth({
    appName: 'iceos-p0-01',
    baseURL: config.betterAuthUrl,
    basePath: '/api/p0-01/auth',
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
      enabled: process.env.P0_01_DISABLE_AUTH_RATE_LIMIT !== 'true',
      window: 60,
      max: 10,
    },
    trustedOrigins: [config.betterAuthUrl],
    advanced: {
      useSecureCookies: false,
    },
    plugins: [nextCookies()],
  });
  authInstance = created as unknown as P001Auth;

  return authInstance;
}

export async function closeP001AuthPool(): Promise<void> {
  authInstance = null;
  if (authPool) {
    await authPool.end();
    authPool = null;
  }
}
