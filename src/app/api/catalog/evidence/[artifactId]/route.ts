import { getCatalogDetail, getCatalogAmounts, getEvidenceArtifact } from '@/features/catalog/service';
import { readPrivateArtifact } from '@/features/catalog/evidence-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) return Response.json({ error: '无效请求' }, { status: 400, headers });
  const projection = new URL(request.url).searchParams.get('projection');
  if (!['raw', 'export', 'amounts'].includes(projection ?? '')) return Response.json({ error: '请选择读取投影' }, { status: 400, headers });
  try {
    if (projection === 'export') {
      const detail = await getCatalogDetail(artifactId);
      return Response.json({ item: detail.item, history: detail.history, decisions: detail.decisions, candidates: detail.candidates, differences: detail.differences }, {
        headers: { ...headers, 'Content-Disposition': `attachment; filename="catalog-${artifactId}.json"` },
      });
    }
    if (projection === 'amounts') return Response.json(await getCatalogAmounts(artifactId), { headers });
    // Metadata is resolved only after evidence+amount authorization. No request path enters the store.
    const artifact = await getEvidenceArtifact(artifactId);
    const bytes = await readPrivateArtifact({ ...artifact, format: '', sensitivity: 'restricted' });
    return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.logicalName.split('/').pop() ?? 'evidence')}` } });
  } catch {
    return Response.json({ error: '无权读取或证据不可用' }, { status: 403, headers });
  }
}
