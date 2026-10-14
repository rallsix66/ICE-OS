import { NextResponse } from 'next/server';

import { noStoreHeaders } from '@/features/p0-01-access/http-errors';

function isNetworkDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P0_01_NETWORK_DENIED'
  );
}

export async function GET() {
  if (process.env.P0_01_NETWORK_GUARD_SELF_TEST !== 'true') {
    return NextResponse.json({ error: '未启用' }, { status: 404, headers: noStoreHeaders() });
  }

  let fetchBlocked = false;
  let deniedCode: string | null = null;
  try {
    await fetch('https://example.com', { redirect: 'error' });
  } catch (error) {
    fetchBlocked = isNetworkDenied(error);
    if (typeof error === 'object' && error !== null && 'code' in error) {
      deniedCode = String((error as { code?: string }).code);
    }
  }

  return NextResponse.json(
    {
      guardInstalled: process.env.P0_01_NETWORK_GUARD_INSTALLED === 'true',
      fetchBlocked,
      deniedCode,
    },
    { headers: noStoreHeaders() },
  );
}
