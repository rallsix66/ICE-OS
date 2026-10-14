import { describe, expect, it } from 'vitest';

import {
  assertP001ConnectionContract,
  assertP001DatabaseUrlMatches,
  parseP001PostgresUrl,
} from '@/lib/independent-platform/p0-01-database-url';

describe('P0-01 database URL guard', () => {
  const base = {
    host: '127.0.0.1',
    port: 55432,
    database: 'iceos_p0_01_run_20261013_r1',
    appUser: 'ice_p0_01_app_runner',
    authUser: 'ice_p0_01_auth_runner',
    runId: 'run-20261013-r1',
  };

  const appUrl = `postgres://${base.appUser}:secret@${base.host}:${base.port}/${base.database}?options=${encodeURIComponent('-c search_path=p0_01_biz,public')}`;
  const authUrl = `postgres://${base.authUser}:secret@${base.host}:${base.port}/${base.database}?options=${encodeURIComponent('-c search_path=p0_01_auth')}`;

  it('拒绝 host 查询参数覆盖', () => {
    const evil = `postgres://${base.appUser}:secret@${base.host}:${base.port}/${base.database}?host=remote.example.invalid`;
    expect(() => parseP001PostgresUrl(evil, 'evil')).toThrow(/不允许的连接参数/);
  });

  it('拒绝 options 内 host/port 覆盖', () => {
    const evil = `postgres://${base.appUser}:secret@${base.host}:${base.port}/${base.database}?options=${encodeURIComponent('-c host=1.2.3.4')}`;
    expect(() => parseP001PostgresUrl(evil, 'evil')).toThrow(/不允许的覆盖项/);
  });

  it('连接契约与 run ID 一致', () => {
    assertP001ConnectionContract(appUrl, authUrl, base);
    assertP001DatabaseUrlMatches(appUrl, { host: base.host, port: base.port, database: base.database, user: base.appUser }, 'app');
  });
});
