import { getSourceIdentityEvidence, getSourceIdentityEvidenceExport } from '@/features/catalog/source-identity/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: Request, { params }: { params: Promise<{ evidenceId: string }> }) {
  const { evidenceId } = await params;
  const projection = new URL(request.url).searchParams.get('projection');
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId) || !['raw', 'export'].includes(projection ?? '')) {
    return Response.json({ error: '无效请求' }, { status: 400, headers });
  }
  try {
    if (projection === 'export') {
      const dto = await getSourceIdentityEvidenceExport(evidenceId);
      return Response.json(dto, { headers: { ...headers, 'Content-Disposition': `attachment; filename="source-evidence-${evidenceId}.json"` } });
    }
    const evidence = await getSourceIdentityEvidence(evidenceId);
    return new Response(new Uint8Array(evidence.bytes), { headers: { ...headers, 'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="source-evidence-${evidenceId}.bin"` } });
  } catch {
    return Response.json({ error: '无权读取或来源证据不可用' }, { status: 403, headers });
  }
}
