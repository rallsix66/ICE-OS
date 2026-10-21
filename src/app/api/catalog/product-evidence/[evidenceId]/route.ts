import { getProductEvidence, getProductEvidenceExport } from '@/features/catalog/new-item/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request: Request, { params }: { params: Promise<{ evidenceId: string }> }) {
  const { evidenceId } = await params, projection = new URL(request.url).searchParams.get('projection');
  try {
    if (projection === 'export') return Response.json(await getProductEvidenceExport(evidenceId), { headers: privateHeaders });
    if (projection !== 'raw') return Response.json({ error: 'PRODUCT_EVIDENCE_DENIED' }, { status: 403, headers: privateHeaders });
    const { bytes, metadata } = await getProductEvidence(evidenceId);
    return new Response(new Uint8Array(bytes), { headers: { ...privateHeaders, 'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="product-evidence-${metadata.evidenceId}.bin"` } });
  } catch { return Response.json({ error: 'PRODUCT_EVIDENCE_DENIED' }, { status: 403, headers: privateHeaders }); }
}
