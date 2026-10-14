import 'server-only';

import { loadP002Config } from '@/lib/independent-platform/p0-02-config';

export function isIndependentPlatformRuntime(): boolean {
  return loadP002Config() !== null;
}
