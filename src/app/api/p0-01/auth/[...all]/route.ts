import { toNextJsHandler } from 'better-auth/next-js';

import { loadP001Config } from '@/lib/independent-platform/p0-01-config';
import { getP001BetterAuth } from '@/lib/independent-platform/p0-01-auth';
import { noStoreHeaders, toP001ErrorResponse } from '@/features/p0-01-access/http-errors';

function disabledResponse() {
  return new Response(JSON.stringify({ error: 'P0-01 未启用' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(noStoreHeaders())) },
  });
}

async function withAuthHandler(request: Request, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') {
  try {
    const config = loadP001Config();
    if (!config) {
      return disabledResponse();
    }
    const handler = toNextJsHandler(getP001BetterAuth());
    try {
      return await handler[method](request);
    } catch (handlerError) {
      return toP001ErrorResponse(handlerError);
    }
  } catch (error) {
    return toP001ErrorResponse(error);
  }
}

export async function GET(request: Request) {
  return withAuthHandler(request, 'GET');
}

export async function POST(request: Request) {
  return withAuthHandler(request, 'POST');
}

export async function PATCH(request: Request) {
  return withAuthHandler(request, 'PATCH');
}

export async function PUT(request: Request) {
  return withAuthHandler(request, 'PUT');
}

export async function DELETE(request: Request) {
  return withAuthHandler(request, 'DELETE');
}
