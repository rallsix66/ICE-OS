import { sealedLegacyApiResponse } from '@/lib/sealed-legacy-api';

export async function GET() {
  return sealedLegacyApiResponse('legacy-products-api');
}

export async function POST() {
  return sealedLegacyApiResponse('legacy-products-api');
}
