// P0-02: provider_token_cache 租约 — sync runner + SECURITY DEFINER RPC（无 Supabase SDK）

import { callSyncRpc } from '@/lib/database/app-db';
import type { TokenCache, TokenLease } from './client';

export class PostgresTokenCache implements TokenCache {
  async acquireLease(provider: string): Promise<TokenLease> {
    const leaseId = globalThis.crypto.randomUUID();

    const result = await callSyncRpc<{
      access_token: string | null;
      expires_at: string | null;
      action: 'reuse' | 'refresh' | 'first_time' | 'lease_held_by_other';
    }>('public.acquire_token_lease', [provider, leaseId]);

    return {
      action: result.action,
      accessToken: result.access_token,
      expiresAt: result.expires_at,
      leaseId,
    };
  }

  async storeToken(
    provider: string,
    accessToken: string,
    expiresAt: string,
    lease: TokenLease,
  ): Promise<void> {
    await callSyncRpc('public.store_token_with_lease', [
      provider,
      accessToken,
      expiresAt,
      lease.leaseId,
    ]);
  }

  async releaseLease(provider: string, lease: TokenLease): Promise<void> {
    try {
      await callSyncRpc('public.release_token_lease', [provider, lease.leaseId]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`释放 Token 租约失败 (${provider}): ${message}`);
    }
  }
}
