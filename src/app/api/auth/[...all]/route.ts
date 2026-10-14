import { toNextJsHandler } from 'better-auth/next-js';

import { noStoreHeaders, toP002ErrorResponse } from '@/features/p0-02-access/http-errors';
import { loadP002Config } from '@/lib/independent-platform/p0-02-config';
import { getP002BetterAuth } from '@/lib/independent-platform/p0-02-auth';

function disabledResponse() {
  return new Response(JSON.stringify({ error: '独立平台未启用' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(noStoreHeaders())) },
  });
}

async function withAuthHandler(request: Request, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') {
  try {
    const config = loadP002Config();
    if (!config) {
      return disabledResponse();
    }
    const handler = toNextJsHandler(getP002BetterAuth());
    try {
      return await handler[method](request);
    } catch (handlerError) {
      return toP002ErrorResponse(handlerError);
    }
  } catch (error) {
    return toP002ErrorResponse(error);
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
