import { NextResponse } from 'next/server';

import {
  AuthenticationError,
  AuthorizationError,
  InactiveUserError,
} from './authorization';

function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === '28P01' || candidate.code === 'ECONNREFUSED' || candidate.code === '08006') {
    return true;
  }
  if (typeof candidate.message === 'string') {
    return /password authentication failed|connection terminated|SASL|ECONNREFUSED/i.test(candidate.message);
  }
  return false;
}

export function toP001ErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: 401, headers: noStoreHeaders() });
  }
  if (error instanceof InactiveUserError || error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: 403, headers: noStoreHeaders() });
  }
  if (isDatabaseUnavailable(error)) {
    return NextResponse.json({ error: '服务不可用' }, { status: 503, headers: noStoreHeaders() });
  }
  if (error instanceof Error) {
    if (error.message.includes('P0-01 未启用')) {
      return NextResponse.json({ error: 'P0-01 未启用' }, { status: 404, headers: noStoreHeaders() });
    }
    if (
      error.message.includes('P0-01') ||
      error.message.includes('缺少') ||
      error.message.includes('无效') ||
      error.message.includes('禁止')
    ) {
      return NextResponse.json({ error: '服务不可用' }, { status: 503, headers: noStoreHeaders() });
    }
  }
  return NextResponse.json({ error: '请求失败' }, { status: 500, headers: noStoreHeaders() });
}

export function noStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store',
  };
}
