import { NextResponse } from 'next/server';

/** Legacy business HTTP surface — archived 2026-10-22; do not re-enable without restore procedure. */
export function sealedLegacyApiResponse(feature: string) {
  return NextResponse.json(
    {
      ok: false,
      status: 'sealed',
      feature,
      message: '该业务能力已封存，尚未按现行方案开放。现役入口请使用 ICE 商品库及相关已验收模块。',
    },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
