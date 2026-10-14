import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  detachedHiddenServerOptions,
  ensureEnvContract,
  newEvidenceSessionDir,
  pgExe,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { captureBizFixture, restoreBizFixture } from './fixture-snapshot.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { installNetworkGuard } from './network-guard.mjs';
import { ensureValidatedIsolatedWorkspace, validateBuildCredential } from './isolated-workspace.mjs';
import { unregisterManagedProcess } from './managed-processes.mjs';
import { guardP001Entry } from './entry-guard.mjs';

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function waitForHttp(url, predicate, attempts = 120) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = async () => {
      i += 1;
      try {
        const res = await fetch(url);
        if (predicate ? predicate(res) : res.status < 500) {
          resolve(undefined);
          return;
        }
      } catch {
        // retry
      }
      if (i >= attempts) {
        reject(new Error('Next.js 启动超时'));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function login(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/api/p0-01/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
    },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, setCookie, body: await res.json().catch(() => ({})) };
}

async function getInventory(baseUrl, cookie, query = '') {
  const res = await fetch(`${baseUrl}/api/p0-01/inventory${query}`, {
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  const text = await res.text();
  return { status: res.status, text, json: safeJson(text) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cookieHeader(setCookies) {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function tamperSessionCookie(cookie) {
  if (!cookie) {
    return 'better-auth.session_token=invalid-tampered';
  }
  const tampered = cookie
    .split('; ')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        return pair;
      }
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!/session|token|auth/i.test(name)) {
        return pair;
      }
      return `${name}=invalid.${value.slice(0, 8)}.tampered`;
    })
    .join('; ');
  return `${tampered}; better-auth.session_token=invalid-tampered`;
}

function psqlRaw(instance, sql, { tupleOnly = false } = {}) {
  const args = [
    '-h',
    instance.host,
    '-p',
    String(instance.port),
    '-U',
    instance.bootstrapUser,
    '-d',
    instance.dbName,
    '-v',
    'ON_ERROR_STOP=1',
  ];
  if (tupleOnly) {
    args.push('-tA');
  }
  args.push('-c', sql);
  return spawnSync(pgExe('psql'), args, withHiddenWindowsSpawnOptions({
    encoding: 'utf8',
    env: { PGPASSWORD: instance.bootstrapPassword },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function psql(instance, sql) {
  const result = psqlRaw(instance, sql);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed');
  }
}

const OPERATOR_ID = '11111111-1111-4111-8111-111111111104';

function hasNoStore(res) {
  return (res.headers.get('cache-control') ?? '').includes('no-store');
}

function responseLeaksAmount(text) {
  if (/unitCost|unit_cost|cost_excl|12\.5000|8\.2500|15\.0000/i.test(text)) {
    return true;
  }
  return false;
}

async function main() {
  const runId = DEFAULT_RUN_ID;
  guardP001Entry(runId);
  const { instance } = guardBeforeMutate(runId);
  const evidenceDir = newEvidenceSessionDir(runId, 'http');

  const guard = installNetworkGuard(evidenceDir);
  const self = await guard.selfTest();
  if (!self.fetchBlocked || self.deniedCode !== 'P0_01_NETWORK_DENIED') {
    throw new Error('父进程网络阻断自检失败');
  }

  const { workspace, validation: workspaceValidation } = ensureValidatedIsolatedWorkspace(runId, {
    validateOnly: true,
  });
  fs.writeFileSync(
    path.join(evidenceDir, 'workspace-validation.json'),
    `${JSON.stringify(workspaceValidation, null, 2)}\n`,
  );
  const buildValidation = validateBuildCredential(runId);
  if (!buildValidation.ok) {
    throw new Error(`隔离构建与源码不一致: ${JSON.stringify(buildValidation)}`);
  }
  const nodeModulesLink = path.join(workspace, 'node_modules');
  if (!fs.existsSync(nodeModulesLink)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'junction');
  }

  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const envFile = path.join(runRoot(runId), 'env.p0-01.json');
  const envJson = ensureEnvContract(instance, envFile);
  envJson.P0_01_BETTER_AUTH_URL = baseUrl;

  const preload = path.join(REPO_ROOT, 'scripts', 'p0-01', 'loopback-network-preload.cjs');
  const allowedPorts = [port, port + 1, instance.port, 5432].join(',');

  const env = buildP001ProcessEnv(
    {
      NODE_ENV: 'production',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      P0_01_ALLOWED_PORTS: allowedPorts,
      P0_01_NETWORK_GUARD_SELF_TEST: 'true',
      P0_01_DISABLE_AUTH_RATE_LIMIT: 'true',
    },
    envJson,
  );

  const nextBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(
    process.execPath,
    [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'],
    withHiddenWindowsSpawnOptions({
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const results = [];
  let childExit = null;
  let restoreFailed = false;
  const fixtureSnapshot = captureBizFixture(instance);
  fs.writeFileSync(
    path.join(evidenceDir, 'fixture-before.json'),
    `${JSON.stringify(fixtureSnapshot, null, 2)}\n`,
  );
  child.on('exit', (code) => {
    childExit = code;
  });

  try {
    await waitForHttp(`${baseUrl}/api/p0-01/inventory`, (res) => res.status === 401);

    const guardProbe = await fetch(`${baseUrl}/api/p0-01/diagnostics/network-guard`);
    const guardJson = await guardProbe.json();
    results.push({
      name: 'child network guard',
      status: guardProbe.status,
      pass:
        guardProbe.status === 200 &&
        guardJson.guardInstalled === true &&
        guardJson.fetchBlocked === true &&
        guardJson.deniedCode === 'P0_01_NETWORK_DENIED',
      detail: guardJson,
    });

    const anon = await getInventory(baseUrl, '');
    results.push({ name: 'anonymous inventory', status: anon.status, pass: anon.status === 401 });

    const badLogin = await login(baseUrl, 'admin@p0-01.test', 'wrong-password');
    results.push({
      name: 'bad password',
      status: badLogin.status,
      pass: badLogin.status === 401 || badLogin.status === 400,
    });

    const goodLogin = await login(baseUrl, 'admin@p0-01.test', 'AdminPass123!');
    const cookie = cookieHeader(goodLogin.setCookie);
    results.push({
      name: 'good login',
      status: goodLogin.status,
      pass: goodLogin.status === 200 && cookie.length > 0,
    });

    const tampered = await getInventory(baseUrl, tamperSessionCookie(cookie));
    results.push({
      name: 'tampered cookie',
      status: tampered.status,
      pass: tampered.status === 401,
    });

    const inv = await getInventory(baseUrl, cookie);
    results.push({
      name: 'admin inventory',
      status: inv.status,
      pass: inv.status === 200 && inv.json?.items?.length === 3,
    });

    const withAmount = await getInventory(baseUrl, cookie, '?includeAmount=true&marketCode=MKT-A');
    results.push({
      name: 'admin amount',
      status: withAmount.status,
      pass:
        withAmount.status === 200 &&
        withAmount.json?.items?.some((row) => row.unitCostExclFreight !== undefined),
    });

    const opLogin = await login(baseUrl, 'operator@p0-01.test', 'OperatorPass123!');
    const opCookie = cookieHeader(opLogin.setCookie);
    results.push({
      name: 'operator login',
      status: opLogin.status,
      pass: opLogin.status === 200 && opCookie.length > 0,
    });
    const opInv = await getInventory(baseUrl, opCookie);
    results.push({
      name: 'operator scoped inventory',
      status: opInv.status,
      pass: opInv.status === 200 && opInv.json?.items?.length === 1,
    });

    const otherMarket = await getInventory(baseUrl, opCookie, '?marketCode=MKT-B');
    results.push({
      name: 'explicit other market',
      status: otherMarket.status,
      pass: otherMarket.status === 403,
    });

    const badWarehouse = await getInventory(baseUrl, opCookie, '?marketCode=MKT-A&warehouseCode=WH-A2');
    results.push({
      name: 'explicit unauthorized warehouse',
      status: badWarehouse.status,
      pass: badWarehouse.status === 403,
    });

    const crossMarketWarehouse = await getInventory(baseUrl, opCookie, '?marketCode=MKT-B&warehouseCode=WH-B1');
    results.push({
      name: 'explicit other-market warehouse',
      status: crossMarketWarehouse.status,
      pass: crossMarketWarehouse.status === 403,
    });

    const opAmount = await getInventory(baseUrl, opCookie, '?includeAmount=true&marketCode=MKT-A');
    const logBeforeAmountDeny = logs.join('');
    results.push({
      name: 'operator amount denied',
      status: opAmount.status,
      pass:
        opAmount.status === 403 &&
        !responseLeaksAmount(opAmount.text) &&
        !responseLeaksAmount(logBeforeAmountDeny),
    });

    psql(
      instance,
      `DELETE FROM p0_01_biz.user_warehouse_grants WHERE user_id = '${OPERATOR_ID}'`,
    );
    const afterRevoke = await getInventory(baseUrl, opCookie);
    results.push({
      name: 'grant revoke next request',
      status: afterRevoke.status,
      pass: afterRevoke.status === 403 && !responseLeaksAmount(afterRevoke.text),
    });

    psql(
      instance,
      `INSERT INTO p0_01_biz.user_warehouse_grants (user_id, warehouse_id)
       SELECT '${OPERATOR_ID}', w.id FROM p0_01_biz.warehouses w WHERE w.code = 'WH-A1'
       ON CONFLICT DO NOTHING`,
    );
    psql(instance, `DELETE FROM p0_01_biz.user_market_grants WHERE user_id = '${OPERATOR_ID}'`);
    psql(
      instance,
      `INSERT INTO p0_01_biz.user_market_grants (user_id, market_id)
       SELECT '${OPERATOR_ID}', m.id FROM p0_01_biz.markets m WHERE m.code = 'MKT-B'
       ON CONFLICT DO NOTHING`,
    );
    const mismatchedGrants = await getInventory(baseUrl, opCookie);
    results.push({
      name: 'mismatched market/warehouse grants',
      status: mismatchedGrants.status,
      pass: mismatchedGrants.status === 403,
    });
    const mgrForEmpty = await login(baseUrl, 'manager@p0-01.test', 'ManagerPass123!');
    const mgrEmptyCookie = cookieHeader(mgrForEmpty.setCookie);
    psql(
      instance,
      `DELETE FROM p0_01_biz.inventory i USING p0_01_biz.warehouses w
       WHERE w.id = i.warehouse_id AND w.code IN ('WH-A1', 'WH-A2')`,
    );
    const authorizedEmpty = await getInventory(baseUrl, mgrEmptyCookie);
    results.push({
      name: 'authorized scope empty inventory',
      status: authorizedEmpty.status,
      pass: authorizedEmpty.status === 200 && authorizedEmpty.json?.items?.length === 0,
    });
    psql(instance, `UPDATE p0_01_biz.ice_users SET is_enabled = false WHERE id = '${OPERATOR_ID}'`);
    const disabledUser = await getInventory(baseUrl, opCookie);
    results.push({
      name: 'disabled user session',
      status: disabledUser.status,
      pass: disabledUser.status === 403,
      body: disabledUser.json?.error,
    });
    const mgrLogin = await login(baseUrl, 'manager@p0-01.test', 'ManagerPass123!');
    const mgrCookie = cookieHeader(mgrLogin.setCookie);
    psql(
      instance,
      `UPDATE p0_01_auth.session SET "expiresAt" = NOW() - INTERVAL '1 hour'
       WHERE "userId" = (SELECT id FROM p0_01_auth."user" WHERE email = 'manager@p0-01.test' LIMIT 1)`,
    );
    const expiredSession = await getInventory(baseUrl, mgrCookie);
    results.push({
      name: 'expired session',
      status: expiredSession.status,
      pass: expiredSession.status === 401,
    });

    const mgrLogin2 = await login(baseUrl, 'manager@p0-01.test', 'ManagerPass123!');
    const mgrCookie2 = cookieHeader(mgrLogin2.setCookie);
    psql(
      instance,
      `DELETE FROM p0_01_auth.session
       WHERE "userId" = (SELECT id FROM p0_01_auth."user" WHERE email = 'manager@p0-01.test' LIMIT 1)`,
    );
    const revokedSession = await getInventory(baseUrl, mgrCookie2);
    results.push({
      name: 'revoked session',
      status: revokedSession.status,
      pass: revokedSession.status === 401,
    });

    const signOut = await fetch(`${baseUrl}/api/p0-01/auth/sign-out`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    results.push({ name: 'sign out', status: signOut.status, pass: signOut.status === 200 });

    const replay = await getInventory(baseUrl, cookie);
    results.push({
      name: 'cookie replay after sign-out',
      status: replay.status,
      pass: replay.status === 401,
    });

    const disabledEnvChild = spawn(
      process.execPath,
      [nextBin, 'start', '-p', String(port + 1), '-H', '127.0.0.1'],
      detachedHiddenServerOptions({
        cwd: workspace,
        env: { ...env, P0_01_ENABLED: 'false' },
        stdio: 'ignore',
      }),
    );
    disabledEnvChild.unref();
    await waitForHttp(`http://127.0.0.1:${port + 1}/api/p0-01/inventory`, (res) => res.status === 404);
    const disabled = await fetch(`http://127.0.0.1:${port + 1}/api/p0-01/inventory`);
    results.push({ name: 'feature flag off', status: disabled.status, pass: disabled.status === 404 });
    const badAuthPort = port + 2;
    const badAuthEnv = buildP001ProcessEnv(
      {
        NODE_ENV: 'production',
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        P0_01_ALLOWED_PORTS: [badAuthPort, instance.port, 5432].join(','),
        P0_01_DISABLE_AUTH_RATE_LIMIT: 'true',
      },
      {
        ...envJson,
        P0_01_AUTH_DATABASE_URL: envJson.P0_01_AUTH_DATABASE_URL.replace(
          /:([^:@/]+)@/,
          ':definitely-wrong-auth-password@',
        ),
        P0_01_BETTER_AUTH_URL: `http://127.0.0.1:${badAuthPort}`,
      },
    );
    const badAuthChild = spawn(
      process.execPath,
      [nextBin, 'start', '-p', String(badAuthPort), '-H', '127.0.0.1'],
      detachedHiddenServerOptions({
        cwd: workspace,
        env: badAuthEnv,
        stdio: 'ignore',
      }),
    );
    badAuthChild.unref();
    await waitForHttp(`http://127.0.0.1:${badAuthPort}/api/p0-01/auth/sign-in/email`, () => true);
    const badAuthRes = await fetch(`http://127.0.0.1:${badAuthPort}/api/p0-01/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${badAuthPort}` },
      body: JSON.stringify({ email: 'admin@p0-01.test', password: 'AdminPass123!' }),
    });
    const badAuthText = await badAuthRes.text();
    results.push({
      name: 'auth database failure',
      status: badAuthRes.status,
      pass:
        badAuthRes.status === 503 &&
        hasNoStore(badAuthRes) &&
        badAuthText.includes('服务不可用') &&
        !/password|postgres|SCRAM|stack/i.test(badAuthText),
    });
    try {
      process.kill(badAuthChild.pid);
    } catch {
      // ignore
    }

    try {
      process.kill(disabledEnvChild.pid);
    } catch {
      // ignore
    }
  } finally {
    try {
      restoreBizFixture(instance, fixtureSnapshot);
      fs.writeFileSync(
        path.join(evidenceDir, 'fixture-after.json'),
        `${JSON.stringify(captureBizFixture(instance), null, 2)}\n`,
      );
    } catch (restoreError) {
      restoreFailed = true;
      logs.push(`fixture-restore-error: ${restoreError}\n`);
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (child.pid) {
      unregisterManagedProcess(runId, child.pid);
    }
    fs.writeFileSync(
      path.join(evidenceDir, 'results.json'),
      `${JSON.stringify({ results, guard: self, childExit, logsTail: logs.slice(-80) }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(evidenceDir, 'server.log'), logs.join(''));
  }

  const failed = results.filter((r) => !r.pass);
  if (typeof restoreFailed !== 'undefined' && restoreFailed) {
    console.error('fixture 恢复失败');
    process.exit(2);
  }
  if (failed.length > 0) {
    console.error(failed);
    process.exit(1);
  }
  console.log(`http tests passed (${results.length})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
