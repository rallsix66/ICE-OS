import { sealedLegacyApiResponse } from '@/lib/sealed-legacy-api';

export async function GET() {
  return sealedLegacyApiResponse('legacy-cron-dry-run');
}

export async function POST() {
  return sealedLegacyApiResponse('legacy-cron-dry-run');
}
