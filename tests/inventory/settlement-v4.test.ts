import { describe, it, expect } from 'vitest';
import {
  mapSettleRpcResponse,
  settlementMessageSuffix,
  settlementReleasesLock,
  settlementResetsToReconcile,
  settlementTone,
  type SettleRpcResponse,
} from '../../src/features/inventory/settlement';
import type { InventoryActionOutcome } from '../../src/features/inventory/types';

/**
 * v4-final R2 失败收尾的纯逻辑反例：
 * - settle RPC 返回 → 页面语义映射（只有 SWETTLED/NO_PENDING 算结案）；
 * - 本地记录/写锁的清理条件（只有成功解锁或确认结案才清）；
 * - 结案失败/不是原请求/未知一律保留锁。
 *
 * 真实的“错 intent/参数不结案、原 pending 不变”由同组离线探针
 * （.local/inventory-sync-repair-v4-final-20261026/a/settlement-probes.cjs）与隔离库事务断言覆盖。
 */

function outcome(overrides: Partial<InventoryActionOutcome>): Pick<
  InventoryActionOutcome, 'ok' | 'unlockFailed' | 'settlement' | 'outcomeUnknown'
> {
  return {
    ok: false,
    unlockFailed: false,
    outcomeUnknown: false,
    ...overrides,
  };
}

describe('settle RPC response → settlement', () => {
  it('SETTLED is a confirmed settlement (releases the local lock)', () => {
    const decision = mapSettleRpcResponse({ ok: true, settled: true, reason: 'SETTLED' });
    expect(decision).toEqual({ settlement: 'settled', reason: 'SETTLED' });
    expect(settlementReleasesLock(outcome({ settlement: decision.settlement }))).toBe(true);
  });

  it('NO_PENDING means the request never reached the server: settled without a lock', () => {
    const decision = mapSettleRpcResponse({ ok: true, settled: true, reason: 'NO_PENDING' });
    expect(decision).toEqual({ settlement: 'no_pending', reason: 'NO_PENDING' });
    expect(settlementReleasesLock(outcome({ settlement: decision.settlement }))).toBe(true);
    // NO_PENDING is not a “business failure”, so it must not reset to 先核对.
    expect(settlementResetsToReconcile(outcome({ settlement: decision.settlement }))).toBe(false);
  });

  it('wrong intent/parameters (NOT_ORIGINAL) never settles the original request', () => {
    const decision = mapSettleRpcResponse({ ok: false, settled: false, reason: 'NOT_ORIGINAL' });
    expect(decision).toEqual({ settlement: 'not_original', reason: 'NOT_ORIGINAL' });
    expect(settlementReleasesLock(outcome({ settlement: decision.settlement }))).toBe(false);
    expect(settlementResetsToReconcile(outcome({ settlement: decision.settlement }))).toBe(false);
    expect(settlementTone(outcome({ settlement: decision.settlement }))).toBe('error');
  });

  it('an existing success receipt is never re-judged as failed', () => {
    expect(mapSettleRpcResponse({ ok: false, settled: false, reason: 'HAS_RECEIPT' }).settlement)
      .toBe('not_original');
    expect(mapSettleRpcResponse({ ok: false, settled: false, reason: 'FORBIDDEN' }).settlement)
      .toBe('not_original');
    expect(mapSettleRpcResponse({ ok: false, settled: false, reason: 'NOT_PENDING' }).settlement)
      .toBe('not_original');
  });

  it('unconfirmable server answers fall back to settle_failed (keep the lock, never fake a settlement)', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'ok',
      42,
      [],
      {},
      { ok: true, settled: false, reason: 'SETTLED' },
      { ok: false, settled: false, reason: 'INVALID_REQUEST' },
      { ok: true },
    ];
    for (const response of malformed) {
      expect(mapSettleRpcResponse(response).settlement, JSON.stringify(response)).toBe('settle_failed');
    }
    expect(settlementReleasesLock(outcome({ settlement: 'settle_failed' }))).toBe(false);
    expect(settlementResetsToReconcile(outcome({ settlement: 'settle_failed' }))).toBe(true);
    expect(settlementTone(outcome({ settlement: 'settle_failed' }))).toBe('warn');
  });

  it('reason is normalised for evidence and unknown bits are ignored', () => {
    const response: SettleRpcResponse = { ok: true, settled: true, reason: '  settled ' };
    expect(mapSettleRpcResponse(response)).toEqual({ settlement: 'settled', reason: 'SETTLED' });
    expect(mapSettleRpcResponse({ ok: 'true', settled: 'true', reason: 'SETTLED' }).settlement)
      .toBe('settle_failed');
  });
});

describe('local record / write lock release predicate', () => {
  it('ok:true releases only when the unlock was confirmed', () => {
    expect(settlementReleasesLock(outcome({ ok: true }))).toBe(true);
    expect(settlementReleasesLock(outcome({ ok: true, unlockFailed: true }))).toBe(false);
    expect(settlementReleasesLock(outcome({ ok: true, unlockFailed: true, settlement: 'settle_failed' })))
      .toBe(false);
  });

  it('a definite business failure releases only after a confirmed settlement', () => {
    expect(settlementReleasesLock(outcome({ settlement: 'settled' }))).toBe(true);
    expect(settlementReleasesLock(outcome({ settlement: 'no_pending' }))).toBe(true);
    for (const settlement of ['settle_failed', 'not_original', undefined] as const) {
      expect(settlementReleasesLock(outcome({ settlement })), String(settlement)).toBe(false);
    }
  });

  it('unknown outcomes keep the record/lock and go back to “先核对”', () => {
    expect(settlementReleasesLock(outcome({ outcomeUnknown: true }))).toBe(false);
    expect(settlementResetsToReconcile(outcome({ outcomeUnknown: true }))).toBe(true);
    expect(settlementTone(outcome({ outcomeUnknown: true }))).toBe('warn');
  });

  it('tone: success is ok, unconfirmed settlement is warn, a rejected call is error', () => {
    expect(settlementTone(outcome({ ok: true }))).toBe('ok');
    expect(settlementTone(outcome({ settlement: 'settled' }))).toBe('warn');
    expect(settlementTone(outcome({ settlement: 'settle_failed' }))).toBe('warn');
    expect(settlementTone(outcome({ settlement: 'not_original' }))).toBe('error');
  });
});

describe('settlement message suffix', () => {
  it('settled/no_pending say the lock/record is cleared and rework is allowed', () => {
    expect(settlementMessageSuffix('settled')).toContain('结案');
    expect(settlementMessageSuffix('settled')).toContain('重新操作');
    expect(settlementMessageSuffix('no_pending')).toContain('没有登记');
  });

  it('settle_failed/not_original say the original request is preserved', () => {
    expect(settlementMessageSuffix('settle_failed')).toContain('仍保留');
    expect(settlementMessageSuffix('settle_failed')).toContain('不要直接重发');
    expect(settlementMessageSuffix('not_original')).toContain('原请求保持原样');
    expect(settlementMessageSuffix('not_original')).toContain('不能用改过的参数解除原锁');
  });

  it('a successful call has nothing to add', () => {
    expect(settlementMessageSuffix(undefined)).toBeNull();
  });
});
