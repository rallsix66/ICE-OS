import { sealedLegacyApiResponse } from '@/lib/sealed-legacy-api';

export async function GET() {
  return sealedLegacyApiResponse('legacy-inventory-api');
}

export async function POST() {
  return sealedLegacyApiResponse('legacy-inventory-api');
}
