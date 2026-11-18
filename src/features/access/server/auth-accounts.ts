import 'server-only';

import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { Pool } from 'pg';

import { requireP002Config } from '@/lib/independent-platform/p0-02-config';

/**
 * 账户开通/改密沿用现有 Better Auth（同一个库、同一个 secret、同一套密码哈希）。
 *
 * - 现役登录实例关闭了自助注册（disableSignUp=true），所以这里单独建一个「只用于开通」的实例：
 *   它不挂 nextCookies，不会被管理员会话复用，也不暴露对外路由；
 * - 建号只创建认证用户与凭据账号，业务行（profiles / 映射 / 角色 / 范围）由 catalog RPC 写；
 * - 改密走 Better Auth 的 internalAdapter.updatePassword（内部会用同一套哈希写 account 行），
 *   失败时回退为「ctx.password.hash + account 行更新」，两步产生的哈希格式一致；
 * - 建号失败需要补偿：调用方在业务写失败时调用 deleteAuthAccount 删掉刚建的认证用户。
 */

type AuthInstance = ReturnType<typeof betterAuth<BetterAuthOptions>>;

let provisionAuth: AuthInstance | null = null;
let provisionPool: Pool | null = null;

function getProvisionAuth(): AuthInstance {
  if (provisionAuth) return provisionAuth;
  const config = requireP002Config();
  provisionPool = new Pool({
    connectionString: config.authDatabaseUrl,
    max: 3,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  provisionAuth = betterAuth({
    appName: 'iceos',
    baseURL: config.betterAuthUrl,
    basePath: '/api/auth',
    secret: config.betterAuthSecret,
    database: provisionPool,
    emailAndPassword: { enabled: true, disableSignUp: false },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: false },
    trustedOrigins: [config.betterAuthUrl],
  }) as unknown as AuthInstance;
  return provisionAuth;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

/** 新建认证账号；邮箱已存在时抛出 ACCESS_ACCOUNT_EMAIL_TAKEN（不泄露其它账号信息以外的内容）。 */
export async function provisionAuthAccount(input: {
  email: string;
  password: string;
  name: string;
}): Promise<{ authUserId: string }> {
  const auth = getProvisionAuth();
  try {
    const created = await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    const authUserId = created?.user?.id;
    if (!authUserId) throw new Error('ACCESS_ACCOUNT_AUTH_USER_MISSING');
    return { authUserId };
  } catch (error) {
    const message = errorMessageOf(error);
    if (/already exists|USER_ALREADY_EXISTS|user_already_exists|duplicate/i.test(message)) {
      throw new Error('ACCESS_ACCOUNT_EMAIL_TAKEN');
    }
    if (/invalid email|email/i.test(message) && /invalid/i.test(message)) {
      throw new Error('ACCESS_ACCOUNT_EMAIL_INVALID');
    }
    if (/password/i.test(message)) throw new Error('ACCESS_ACCOUNT_PASSWORD_INVALID');
    throw new Error(`ACCESS_ACCOUNT_AUTH_FAILED:${message.slice(0, 160)}`);
  }
}

/**
 * 改密：先用 Better Auth 的同一套哈希把新密码哈希，再写凭据账号行。
 *
 * 注意 internalAdapter.updatePassword(userId, password) 期望的是**已哈希**的值（它直接写
 * account.password），不是明文；所以这里必须先 hash，否则写进去的是明文、登录会失败。
 */
export async function setAuthAccountPassword(authUserId: string, password: string): Promise<void> {
  const auth = getProvisionAuth();
  const context = await auth.$context;
  const hasher = (context as unknown as { password?: { hash?: (password: string) => Promise<string> } }).password;
  if (!hasher?.hash) throw new Error('ACCESS_ACCOUNT_PASSWORD_UNAVAILABLE');
  const hash = await hasher.hash(password);
  const internal = (context as unknown as {
    internalAdapter?: { updatePassword?: (userId: string, hashedPassword: string) => Promise<void> };
  }).internalAdapter;
  if (internal?.updatePassword) {
    await internal.updatePassword(authUserId, hash);
    return;
  }
  const pool = provisionPool;
  if (!pool) throw new Error('ACCESS_ACCOUNT_PASSWORD_UNAVAILABLE');
  const result = await pool.query(
    `UPDATE p0_02_auth.account SET password=$1, "updatedAt"=now()
      WHERE "userId"=$2 AND "providerId"='credential'`,
    [hash, authUserId],
  );
  if (result.rowCount === 0) throw new Error('ACCESS_ACCOUNT_PASSWORD_UNAVAILABLE');
}

/** 建号补偿：业务行写失败时删掉刚创建的认证用户（best effort，失败不掩盖原始错误）。 */
export async function deleteAuthAccount(authUserId: string): Promise<void> {
  try {
    const auth = getProvisionAuth();
    const context = await auth.$context;
    const internal = (context as unknown as {
      internalAdapter?: { deleteUser?: (userId: string) => Promise<void> };
    }).internalAdapter;
    if (internal?.deleteUser) await internal.deleteUser(authUserId);
  } catch {
    /* 补偿失败不影响主错误上报；孤儿账号不影响登录（没有 profiles / 映射即无任何权限）。 */
  }
}
