import { describe, expect, it } from 'vitest';
import { withReadOnlyAppDb } from '@/lib/database/app-db';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const identity = { profileUserId: ADMIN };

describe('withReadOnlyAppDb isolation fixture', () => {
  it('allows read-only select with transaction_read_only=on', async () => {
    const row = await withReadOnlyAppDb(identity, async (client, evidence) => {
      expect(evidence.transactionReadOnly).toBe('on');
      expect(evidence.backendPid).toBeGreaterThan(0);
      expect(evidence.currentUser).toBeTruthy();
      return (await client.query('SELECT 1 AS ok')).rows[0]?.ok;
    });
    expect(row).toBe(1);
  });

  it('rejects writes inside read-only transaction with SQLSTATE 25006', async () => {
    await expect(withReadOnlyAppDb(identity, async (client, evidence) => {
      expect(evidence.transactionReadOnly).toBe('on');
      await client.query('INSERT INTO catalog.catalog_item DEFAULT VALUES');
      return true;
    })).rejects.toMatchObject({ code: '25006' });
  });
});
