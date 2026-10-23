import 'server-only';

import { newItemEnabled } from './new-item/authorization';
import { sourceIdentityEnabled } from './source-identity/authorization';

export type CatalogNavModuleState = 'available' | 'disabled';

export function getCatalogWorkspaceNavState(): {
  intake: CatalogNavModuleState;
  sources: CatalogNavModuleState;
} {
  return {
    intake: newItemEnabled() ? 'available' : 'disabled',
    sources: sourceIdentityEnabled() ? 'available' : 'disabled',
  };
}
