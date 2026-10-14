import { afterEach, describe, expect, it } from 'vitest';

import { loadP002Config, validateP002ConnectionContract } from '@/lib/independent-platform/p0-02-config';

import { loadP002InstanceEnv } from './helpers';

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
});

describe('P0-02 runtime connection contract', () => {
  it('loadP002Config accepts the current run sync URL', () => {
    const { envJson, runId } = loadP002InstanceEnv();
    setEnv('P0_02_ENABLED', 'true');
    setEnv('P0_02_RUN_ID', runId);
    for (const [key, value] of Object.entries(envJson)) {
      setEnv(key, value);
    }
    const config = loadP002Config();
    expect(config?.syncDatabaseUrl).toBe(envJson.P0_02_SYNC_DATABASE_URL);
  });

  function applyExpectedEnv(envJson: Record<string, string>) {
    setEnv('P0_02_EXPECTED_HOST', envJson.P0_02_EXPECTED_HOST);
    setEnv('P0_02_EXPECTED_PORT', envJson.P0_02_EXPECTED_PORT);
    setEnv('P0_02_EXPECTED_DATABASE', envJson.P0_02_EXPECTED_DATABASE);
    setEnv('P0_02_EXPECTED_APP_USER', envJson.P0_02_EXPECTED_APP_USER);
    setEnv('P0_02_EXPECTED_AUTH_USER', envJson.P0_02_EXPECTED_AUTH_USER);
    setEnv('P0_02_EXPECTED_SYNC_USER', envJson.P0_02_EXPECTED_SYNC_USER);
  }

  it('validateP002ConnectionContract rejects wrong sync port', () => {
    const { envJson, runId, instance } = loadP002InstanceEnv();
    applyExpectedEnv(envJson);
    const badSync = envJson.P0_02_SYNC_DATABASE_URL.replace(
      `:${instance.port}/`,
      `:${instance.port + 1}/`,
    );
    expect(() =>
      validateP002ConnectionContract(
        runId,
        envJson.P0_02_APP_DATABASE_URL,
        envJson.P0_02_AUTH_DATABASE_URL,
        badSync,
      ),
    ).toThrow(/端口不匹配/);
  });

  it('validateP002ConnectionContract rejects wrong sync database', () => {
    const { envJson, runId } = loadP002InstanceEnv();
    applyExpectedEnv(envJson);
    const badSync = envJson.P0_02_SYNC_DATABASE_URL.replace(
      envJson.P0_02_EXPECTED_DATABASE!,
      'iceos_p0_02_run_other',
    );
    expect(() =>
      validateP002ConnectionContract(
        runId,
        envJson.P0_02_APP_DATABASE_URL,
        envJson.P0_02_AUTH_DATABASE_URL,
        badSync,
      ),
    ).toThrow(/数据库名不匹配/);
  });

  it('validateP002ConnectionContract rejects wrong sync user', () => {
    const { envJson, runId, instance } = loadP002InstanceEnv();
    applyExpectedEnv(envJson);
    const badSync = envJson.P0_02_SYNC_DATABASE_URL.replace(
      `${instance.syncRunnerUser}:`,
      `${instance.appRunnerUser}:`,
    );
    expect(() =>
      validateP002ConnectionContract(
        runId,
        envJson.P0_02_APP_DATABASE_URL,
        envJson.P0_02_AUTH_DATABASE_URL,
        badSync,
      ),
    ).toThrow(/角色不匹配/);
  });

  it('loadP002Config rejects cross-run database name', () => {
    const { envJson, runId } = loadP002InstanceEnv();
    setEnv('P0_02_ENABLED', 'true');
    setEnv('P0_02_RUN_ID', runId);
    for (const [key, value] of Object.entries(envJson)) {
      setEnv(key, value);
    }
    setEnv('P0_02_EXPECTED_DATABASE', 'iceos_p0_02_run_20261014_r1');
    setEnv(
      'P0_02_SYNC_DATABASE_URL',
      envJson.P0_02_SYNC_DATABASE_URL.replace(
        envJson.P0_02_EXPECTED_DATABASE,
        'iceos_p0_02_run_20261014_r1',
      ),
    );
    expect(() => loadP002Config()).toThrow(/数据库名与 run ID 不一致|数据库名不匹配/);
  });
});
