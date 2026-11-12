/**
 * 启动/采集链的运行位置解析（仅路径与可执行文件，不启动任何东西）。
 *
 * 现役平台是 Windows，本文件在 Windows 上的解析结果必须与改动前完全一致：
 *   - PostgreSQL 工具：优先 instance.pgBinDir，其次旧的 .local/p0-02 二进制目录；
 *   - Python：Windows 用 `python`；
 *   - lark-cli：优先环境变量，其次 %APPDATA%\npm 下的 run.js。
 *
 * 为 Mac mini 迁移预留的是“配置项”，不是另一套运行体系：
 *   - ICEOS_PG_BIN_DIR / ICEOS_PYTHON_BIN / SHIPMENT_LARK_CLI_RUNNER / BIGSELLER_CHROME_PATH
 *   都可以在新机器上指定，不需要改代码；
 *   - macOS 默认值（python3、Homebrew/usr-local 全局 node_modules、/Applications 下的 Chrome）
 *   只是候选，**必须 Mac 实机验证**（见 docs/deploy/mac-mini-cloudflare-nas-v1.md）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WINDOWS = process.platform === 'win32';

/** 现役实例使用的 PostgreSQL 17.11 Windows 二进制目录（历史布局，仅作默认值）。 */
export const DEFAULT_PG_BIN_DIR = path.join(
  REPO_ROOT, '.local', 'p0-02', 'run-20261014-r2', 'pg', 'pgsql', 'bin',
);

function envAbsolutePath(name, env) {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) throw new Error(`${name}_MUST_BE_ABSOLUTE:${raw}`);
  return raw;
}

/** PostgreSQL bin 目录：ICEOS_PG_BIN_DIR > instance.pgBinDir > 历史默认目录。 */
export function pgBinDir({ instance, env = process.env } = {}) {
  return envAbsolutePath('ICEOS_PG_BIN_DIR', env)
    ?? instance?.pgBinDir
    ?? DEFAULT_PG_BIN_DIR;
}

/** PostgreSQL 工具完整路径（按平台补 .exe）。 */
export function pgTool(name, { instance, env } = {}) {
  return path.join(pgBinDir({ instance, env }), `${name}${IS_WINDOWS ? '.exe' : ''}`);
}

/** 库存 worker 的 Python 解释器：ICEOS_PYTHON_BIN > 平台默认值。 */
export function pythonExecutable(env = process.env) {
  return env.ICEOS_PYTHON_BIN?.trim() || (IS_WINDOWS ? 'python' : 'python3');
}

/** lark-cli run.js 的候选路径（不含显式环境变量；显式覆盖见 resolveLarkCliRunner）。 */
export function larkCliCandidates(env = process.env) {
  const candidates = [];
  if (env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  }
  const home = env.HOME || os.homedir();
  candidates.push(
    '/opt/homebrew/lib/node_modules/@larksuite/cli/scripts/run.js',
    '/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js',
    path.join(home, '.npm-global', 'lib', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'),
  );
  return candidates;
}

/**
 * 解析 lark-cli 入口。显式 SHIPMENT_LARK_CLI_RUNNER 是权威配置：
 * 指向不存在的文件直接报错，不静默回退到别的 CLI；未设置时按候选路径找，找不到返回 null。
 */
export function resolveLarkCliRunner(env = process.env) {
  const override = env.SHIPMENT_LARK_CLI_RUNNER?.trim();
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`SHIPMENT_LARK_CLI_RUNNER_NOT_FOUND:${override}`);
    return override;
  }
  for (const candidate of larkCliCandidates(env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Chrome 候选路径（BigSeller 登录用真实 Chrome；Playwright 自带 chromium 不算）。 */
export function chromeCandidates(env = process.env) {
  const candidates = IS_WINDOWS
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    : [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];
  const override = env.BIGSELLER_CHROME_PATH?.trim();
  return override ? [override, ...candidates] : candidates;
}

/** 解析 Chrome：显式 BIGSELLER_CHROME_PATH 不存在时直接报错，避免静默用错浏览器。 */
export function resolveChrome(env = process.env) {
  const override = env.BIGSELLER_CHROME_PATH?.trim();
  if (override && !fs.existsSync(override)) throw new Error(`BIGSELLER_CHROME_PATH_NOT_FOUND:${override}`);
  for (const candidate of chromeCandidates(env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 供运行依赖自检脚本输出的一份只读视图。 */
export function describeRuntime({ instance, env = process.env } = {}) {
  return {
    platform: process.platform,
    node: process.version,
    pgBinDir: pgBinDir({ instance, env }),
    pgTools: Object.fromEntries(
      ['postgres', 'initdb', 'psql', 'pg_dump', 'createdb', 'dropdb']
        .map((name) => [name, pgTool(name, { instance, env })]),
    ),
    python: pythonExecutable(env),
    chrome: resolveChrome(env),
    larkCli: resolveLarkCliRunner(env),
  };
}
