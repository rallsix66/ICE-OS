import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPROVED_BASELINE_PATH = path.join(__dirname, 'opt6-approved-baseline.json');

export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

const KNOWN_FAILING_TEST =
  'embeds the canonical migration body byte-for-byte and repeats the old-history postcheck';

const KNOWN_FAILING_MESSAGE = 'Target cannot be null or undefined';
const KNOWN_FAILING_LOCATION = 'opt6-production-apply.test.ts:43';

export function parseVitestFailedTestNames(output) {
  const plain = stripAnsi(output);
  const names = [];
  const lineRe = /^\s*[×x✗]\s+(.+?)\s+\d/gim;
  let match = lineRe.exec(plain);
  while (match) {
    names.push(match[1].trim());
    match = lineRe.exec(plain);
  }
  return names;
}

export function computeOpt6FileFingerprint(rawUtf8) {
  const raw = rawUtf8;
  const normalized = raw.replace(/\r\n/g, '\n');
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const withoutCrlf = raw.replace(/\r\n/g, '');
  const loneLfCount = (withoutCrlf.match(/\n/g) ?? []).length;
  const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  const normalizedLfSha256 = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return { sha256, normalizedLfSha256, crlfCount, loneLfCount };
}

export function loadApprovedOpt6Baseline(baselinePath = APPROVED_BASELINE_PATH) {
  const doc = JSON.parse(fs.readFileSync(baselinePath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    throw new Error('opt6 批准基线缺少 files');
  }
  return doc;
}

export function verifyOpt6ApprovedFileFingerprints({
  repoRoot = REPO_ROOT,
  baselinePath = APPROVED_BASELINE_PATH,
} = {}) {
  let baseline;
  try {
    baseline = loadApprovedOpt6Baseline(baselinePath);
  } catch {
    return { ok: false, reason: 'missing-or-invalid-baseline-document' };
  }
  const mismatches = [];
  for (const expected of baseline.files) {
    const abs = path.join(repoRoot, expected.rel);
    if (!fs.existsSync(abs)) {
      mismatches.push({ rel: expected.rel, reason: 'missing-file' });
      continue;
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const actual = computeOpt6FileFingerprint(raw);
    for (const key of ['sha256', 'normalizedLfSha256', 'crlfCount', 'loneLfCount']) {
      if (actual[key] !== expected[key]) {
        mismatches.push({ rel: expected.rel, field: key, expected: expected[key], actual: actual[key] });
      }
    }
  }
  if (mismatches.length > 0) {
    return { ok: false, reason: 'fingerprint-mismatch', mismatches: mismatches.slice(0, 6) };
  }
  return { ok: true, fileCount: baseline.files.length };
}

export function verifyOpt6ApprovedFileFingerprint(options) {
  return verifyOpt6ApprovedFileFingerprints(options).ok;
}

function hasExtraUnhandledFailures(plain) {
  if (/Unhandled\s+(Rejection|Errors?)/i.test(plain)) {
    return true;
  }
  if (/\bRangeError\b/.test(plain)) {
    return true;
  }
  if (/Errors\s+\d+\s+errors?/i.test(plain)) {
    return true;
  }
  if (/\bFAIL\b.*\bsuite\b/i.test(plain) && !/1 failed/i.test(plain)) {
    return true;
  }
  return false;
}

export function isKnownOpt6BaselineFailure(record, fingerprintOptions = {}) {
  if (record.status === 0) {
    return true;
  }
  const output = `${record.stdout ?? ''}\n${record.stderr ?? ''}`;
  const plain = stripAnsi(output);
  if (hasExtraUnhandledFailures(plain)) {
    return false;
  }
  const failedNames = parseVitestFailedTestNames(output);
  if (failedNames.length !== 1) {
    return false;
  }
  if (failedNames[0] !== KNOWN_FAILING_TEST) {
    return false;
  }
  if (/\bTypeError\b/.test(plain)) {
    return false;
  }
  const assertionErrors = plain.match(/AssertionError/g)?.length ?? 0;
  if (assertionErrors !== 1) {
    return false;
  }
  if (!plain.includes(KNOWN_FAILING_MESSAGE) || !plain.includes(KNOWN_FAILING_LOCATION)) {
    return false;
  }
  if (!verifyOpt6ApprovedFileFingerprint(fingerprintOptions)) {
    return false;
  }
  const summaryOk =
    /Tests\s+1 failed\s+\|\s+5 passed\s+\(6\)/i.test(plain) ||
    /1 failed[\s\S]{0,400}5 passed[\s\S]{0,80}\(6\)/i.test(plain);
  return summaryOk;
}

export function isOpt6UnexpectedFailure(record, fingerprintOptions = {}) {
  if (record.status === 0) {
    return false;
  }
  return !isKnownOpt6BaselineFailure(record, fingerprintOptions);
}

export { KNOWN_FAILING_TEST, APPROVED_BASELINE_PATH };
