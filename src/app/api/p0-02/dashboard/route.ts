import { sealedLegacyApiResponse } from '@/lib/sealed-legacy-api';

/** P0-02 旧 Dashboard 聚合 API — 随 legacy 经营页封存；session 诊断路由保留。 */
export async function GET() {
  return sealedLegacyApiResponse('p0-02-legacy-dashboard-api');
}
