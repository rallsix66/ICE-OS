import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { appPoolFromEnv, hasFunctionPrivilege, loadP002InstanceEnv, syncPoolFromEnv } from './helpers';

describe('P0-02 effective ACL', () => {
  let appPool: Pool;
  let syncPool: Pool;
  let appUser: string;
  let syncUser: string;

  beforeAll(() => {
    const { instance } = loadP002InstanceEnv();
    appUser = instance.appRunnerUser;
    syncUser = instance.syncRunnerUser;
    appPool = appPoolFromEnv();
    syncPool = syncPoolFromEnv();
  });

  afterAll(async () => {
    await appPool.end();
    await syncPool.end();
  });

  it('anon/authenticated cannot execute sealed warehouse_shipment_transactional', async () => {
    const client = await appPool.connect();
    try {
      expect(
        await hasFunctionPrivilege(client, 'anon', 'public.warehouse_shipment_transactional(uuid,text)'),
      ).toBe(false);
      expect(
        await hasFunctionPrivilege(client, 'authenticated', 'public.warehouse_shipment_transactional(uuid,text)'),
      ).toBe(false);
      expect(await hasFunctionPrivilege(client, appUser, 'public.warehouse_shipment_transactional(uuid,text)')).toBe(
        false,
      );
      expect(
        await hasFunctionPrivilege(client, syncUser, 'public.warehouse_shipment_transactional(uuid,text)'),
      ).toBe(false);
    } finally {
      client.release();
    }
  });

  it('app cannot execute system/token functions', async () => {
    const client = await appPool.connect();
    try {
      expect(
        await hasFunctionPrivilege(client, appUser, 'public.claim_sync_run_system(uuid,text,uuid,integer,uuid,text,text)'),
      ).toBe(false);
      expect(await hasFunctionPrivilege(client, appUser, 'public.acquire_token_lease(text,uuid)')).toBe(false);
      expect(await hasFunctionPrivilege(client, appUser, 'public.store_token_with_lease(text,text,timestamp with time zone,uuid)')).toBe(false);
      expect(await hasFunctionPrivilege(client, appUser, 'public.release_token_lease(text,uuid)')).toBe(false);
    } finally {
      client.release();
    }
  });

  it('sync can execute token lease RPCs', async () => {
    const client = await syncPool.connect();
    try {
      expect(await hasFunctionPrivilege(client, syncUser, 'public.acquire_token_lease(text,uuid)')).toBe(true);
    } finally {
      client.release();
    }
  });

  it('app can execute retained business RPC get_low_stock', async () => {
    const client = await appPool.connect();
    try {
      expect(await hasFunctionPrivilege(client, appUser, 'public.get_low_stock(uuid,integer)')).toBe(true);
    } finally {
      client.release();
    }
  });

  it('app runner cannot SELECT auth.users directly', async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query(`SELECT 1 FROM auth.users LIMIT 1`)).rejects.toThrow(
        /permission denied|42501/i,
      );
    } finally {
      client.release();
    }
  });

  it('app cannot DML identity map table', async () => {
    const client = await appPool.connect();
    try {
      const insert = await client.query(
        `SELECT has_table_privilege($1, 'p0_02_meta.ice_auth_user_map', 'INSERT') AS ok`,
        [appUser],
      );
      expect(insert.rows[0]?.ok).toBe(false);
    } finally {
      client.release();
    }
  });
});
