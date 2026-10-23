import { sealedLegacyApiResponse } from '@/lib/sealed-legacy-api';

export async function GET() {
  return sealedLegacyApiResponse('legacy-cron-golucky');
}

export async function POST() {
  return sealedLegacyApiResponse('legacy-cron-golucky');
}
