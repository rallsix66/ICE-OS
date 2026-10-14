import { NextResponse } from 'next/server';

function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === '28P01' || candidate.code === 'ECONNREFUSED' || candidate.code === '08006') {
    return true;
  }
  if (typeof candidate.message === 'string') {
    return /password authentication failed|connection terminated|SASL|ECONNREFUSED|database schema/i.test(
      candidate.message,
    );
  }
  return false;
}

export function toP002ErrorResponse(error: unknown): NextResponse {
  if (isDatabaseUnavailable(error)) {
    return NextResponse.json({ error: '服务不可用' }, { status: 503, headers: noStoreHeaders() });
  }
  if (error instanceof Error) {
    if (error.message.includes('独立平台未启用')) {
      return NextResponse.json({ error: '独立平台未启用' }, { status: 404, headers: noStoreHeaders() });
    }
    if (
      error.message.includes('P0-02') ||
      error.message.includes('P0_02') ||
      error.message.includes('缺少') ||
      error.message.includes('无效') ||
      error.message.includes('禁止')
    ) {
      return NextResponse.json({ error: '服务不可用' }, { status: 503, headers: noStoreHeaders() });
    }
  }
  return NextResponse.json(
    { code: 'INTERNAL_SERVER_ERROR', error: '服务不可用' },
    { status: 503, headers: noStoreHeaders() },
  );
}

export function noStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store',
  };
}
