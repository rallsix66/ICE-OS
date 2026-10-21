import 'server-only';
import { z } from 'zod';
import type { DbIdentity } from '@/lib/database/app-db';
import { readPrivateArtifact, storePrivateArtifact } from '../evidence-store';
import { catalogRepository } from '../repository';
import { sourceIdentityRepository } from '../source-identity/repository';
import { buildCandidates } from '../candidate-service';
import type { CatalogItemDto } from '../types';
import { newItemEnabled, requireNewItemActor } from './authorization';
import { listProductFixtures, loadProductFixtureManifest, prepareProductFixture } from './fixture-adapter';
import { confirmationPreview, hashCanonical } from './field-projection';
import { newItemIntent, newItemRepository } from './repository';
import { appendNewItemRevisionSchema, assignNewItemCodeSchema, associateExistingItemSchema, attachSourceIdentitySchema,
  classifyProductObservationSchema, confirmNewItemSchema, importProductCaptureSchema, prepareNewItemConfirmationSchema,
  prepareProductCaptureSchema, prepareSourceSlotSchema, prepareCatalogProofSchema, prepareAttachIdentitySchema, readNewItemSchema, uuidSchema } from './schema';
import { NEW_ITEM_ACTIONS, type AttachIdentityOption, type CatalogProofOption, type NewItemAction, type NewItemWorkspace,
  type NewItemWorkspaceDto, type ProductObservationDto } from './types';

const actionSchema = z.object({ action: z.enum(NEW_ITEM_ACTIONS), input: z.unknown() }).strict();
async function scopeWorkspace(identity: DbIdentity, scopeId: string, publish = false) {
  const workspace = await newItemRepository.read(identity, uuidSchema.parse(scopeId));
  if (!workspace.permissions.read || (publish && (!workspace.permissions.manage || !workspace.permissions.publish))) throw new Error('NEW_ITEM_FORBIDDEN');
  return workspace;
}
function requireObservation(workspace: NewItemWorkspaceDto, observationId: string): ProductObservationDto {
  const observation = workspace.observations.find((entry) => entry.observationId === observationId);
  if (!observation) throw new Error('NEW_ITEM_FORBIDDEN'); return observation;
}
async function scopedOptions(identity: DbIdentity, workspace: NewItemWorkspaceDto) {
  const catalogProofOptions: CatalogProofOption[] = [], attachOptions: AttachIdentityOption[] = [];
  if (!workspace.permissions.manage || !workspace.permissions.publish) return { catalogProofOptions, attachOptions };
  const manifest = await loadProductFixtureManifest();
  const identityWorkspace = await sourceIdentityRepository.workspace(identity, workspace.scope.scopeId);
  for (const capture of manifest.captures.filter((entry) => entry.scopeId === workspace.scope.scopeId)) {
    const savedCapture = workspace.captures.find((entry) => entry.captureKey === capture.captureKey);
    if (!savedCapture) continue;
    for (const proof of capture.associationProofs) {
      const fromCapture = workspace.captures.find((entry) => entry.captureKey === proof.from.captureKey);
      const observation = workspace.observations.find((entry) => entry.captureId === fromCapture?.captureId && entry.recordPointer === proof.from.recordPointer);
      if (!observation?.classification) continue;
      if (proof.semantics === 'same_catalog_item' && proof.to.kind === 'product_observation') {
        const endpoint = proof.to, targetCapture = workspace.captures.find((entry) => entry.captureKey === endpoint.captureKey);
        const target = workspace.observations.find((entry) => entry.captureId === targetCapture?.captureId && entry.recordPointer === endpoint.recordPointer);
        const origin = target?.origin;
        if (!origin) continue;
        const item = await catalogRepository.get(identity, origin.itemId); if (!item) continue;
        const basis = { kind: 'catalog_proof' as const, basisAnchorOrOrigin: { kind: 'origin' as const, originId: origin.originId },
          associationProofRef: { captureId: savedCapture.captureId, proofKey: proof.proofKey }, targetItemId: item.itemId, expectedItemRevision: item.revision };
        catalogProofOptions.push({ label: `已批准同商品证据 ${proof.proofKey}`, observationId: observation.observationId,
          expectedClassificationRevision: observation.classification.revision, expectedSourceDisposition: observation.sourceDisposition.sha256,
          previewId: hashCanonical(['iceos-catalog-proof-preview-v1', workspace.scope.scopeId, observation.observationId, observation.classification.revision,
            observation.sourceDisposition.sha256, basis]), basis });
      }
      if (proof.semantics === 'same_source_record' && proof.to.kind === 'identity_observation' && observation.origin) {
        const endpoint = proof.to, support = identityWorkspace.observations.find((entry) => entry.evidenceId === endpoint.evidenceId && entry.recordPointer === endpoint.recordPointer);
        if (!support) continue;
        const current = identityWorkspace.links.filter((link) => link.originKind === 'identity' && link.originId === support.observationId)
          .sort((a, b) => b.linkRevision - a.linkRevision)[0];
        const record = current?.status === 'linked' ? identityWorkspace.records.find((entry) => entry.recordId === current.recordId && entry.state === 'active') : null;
        const item = await catalogRepository.get(identity, observation.origin.itemId); if (!record || !item) continue;
        attachOptions.push({ label: `已批准来源证据 ${proof.proofKey}`, originId: observation.origin.originId, observationId: observation.observationId,
          itemId: item.itemId, expectedItemRevision: item.revision, sourceRecordId: record.recordId, expectedRecordRevision: record.revision,
          expectedClaimId: record.activeClaimId, supportIdentityObservationId: support.observationId,
          expectedSourceDisposition: observation.sourceDisposition.sha256, associationProofRef: { captureId: savedCapture.captureId, proofKey: proof.proofKey } });
      }
    }
  }
  return { catalogProofOptions, attachOptions };
}
export async function getNewItemWorkspace(scopeId?: string, observationId?: string) {
  const empty: NewItemWorkspace & { catalogProofOptions: CatalogProofOption[]; attachOptions: AttachIdentityOption[] } = {
    enabled: false, scopes: [], scopeId: null, workspace: null, fixtures: [], catalogProofOptions: [], attachOptions: [] };
  if (!newItemEnabled()) return empty;
  const identity = await requireNewItemActor(), scopes = await newItemRepository.scopes(identity);
  const selected = scopeId === undefined ? scopes[0]?.scopeId : uuidSchema.parse(scopeId);
  if (!selected) return { ...empty, enabled: true };
  if (!scopes.some((scope) => scope.scopeId === selected)) throw new Error('NEW_ITEM_FORBIDDEN');
  const workspace = await newItemRepository.read(identity, selected, observationId ? uuidSchema.parse(observationId) : null);
  const readable = new Set(scopes.map((scope) => scope.scopeId));
  const fixtures = (await listProductFixtures()).filter((fixture) => readable.has(fixture.scopeId));
  return { enabled: true, scopes, scopeId: selected, workspace, fixtures, ...await scopedOptions(identity, workspace) };
}
export async function prepareProductCapture(input: unknown) {
  const identity = await requireNewItemActor(), parsed = prepareProductCaptureSchema.parse(input);
  const fixture = (await listProductFixtures()).find((entry) => entry.approvedFixtureId === parsed.approvedFixtureId);
  if (!fixture) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  const workspace = await scopeWorkspace(identity, fixture.scopeId);
  if (!workspace.permissions.manage) throw new Error('NEW_ITEM_FORBIDDEN');
  const { payload } = await prepareProductFixture(parsed.approvedFixtureId);
  return { approvedFixtureId: parsed.approvedFixtureId, previewId: payload.adoptionDigest, scopeId: payload.scopeId,
    observationCount: payload.observations.length, complete: payload.coverage.complete === true };
}
async function mutationInput(identity: DbIdentity, action: NewItemAction, raw: unknown, persistBytes: boolean) {
  if (action === 'import_product_capture') {
    const input = importProductCaptureSchema.parse(raw), fixtures = await listProductFixtures();
    const fixture = fixtures.find((entry) => entry.approvedFixtureId === input.approvedFixtureId);
    if (!fixture) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
    const workspace = await scopeWorkspace(identity, fixture.scopeId);
    if (!workspace.permissions.manage) throw new Error('NEW_ITEM_FORBIDDEN');
    const { payload, bytes } = await prepareProductFixture(input.approvedFixtureId);
    if (payload.adoptionDigest !== input.previewId) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
    const storageHandle = persistBytes ? (await storePrivateArtifact(`${input.approvedFixtureId}.json`, bytes)).storageHandle
      : `${payload.bytesSha256.slice(0, 2)}/${payload.bytesSha256}`;
    return { requestId: input.requestId, scopeId: payload.scopeId, payload: { ...payload, storageHandle } };
  }
  if (action === 'append_nonprice_revision' && raw && typeof raw === 'object' && 'fields' in raw
    && raw.fields && typeof raw.fields === 'object' && 'imageRef' in raw.fields) throw new Error('IMAGE_PUBLICATION_NOT_IMPLEMENTED');
  const schemas = { classify_observation: classifyProductObservationSchema, confirm_new_item: confirmNewItemSchema,
    associate_existing_item: associateExistingItemSchema, attach_source_identity: attachSourceIdentitySchema,
    assign_initial_code: assignNewItemCodeSchema, append_nonprice_revision: appendNewItemRevisionSchema };
  const parsed = schemas[action].parse(raw), { requestId, scopeId, ...payload } = parsed;
  return { requestId, scopeId, payload };
}
async function execute(action: NewItemAction, input: unknown) {
  const identity = await requireNewItemActor(), prepared = await mutationInput(identity, action, input, true);
  return newItemRepository.mutate(identity, prepared.requestId, prepared.scopeId, action, prepared.payload);
}
export async function importProductCapture(input: unknown) { return execute('import_product_capture', input); }
export async function classifyProductObservation(input: unknown) { return execute('classify_observation', input); }
export async function confirmNewItem(input: unknown) { return execute('confirm_new_item', input); }
export async function associateExistingItem(input: unknown) { return execute('associate_existing_item', input); }
export async function attachSourceIdentity(input: unknown) { return execute('attach_source_identity', input); }
export async function assignNewItemCode(input: unknown) { return execute('assign_initial_code', input); }
export async function appendNewItemRevision(input: unknown) { return execute('append_nonprice_revision', input); }
export async function prepareNewItemConfirmation(input: unknown) {
  const identity = await requireNewItemActor(), parsed = prepareNewItemConfirmationSchema.parse(input);
  const workspace = await scopeWorkspace(identity, parsed.scopeId, true), observation = requireObservation(workspace, parsed.observationId);
  return confirmationPreview(parsed.scopeId, observation, parsed.adoptedFieldKeys, parsed.initialCode);
}
export async function prepareSourceSlotAssociation(input: unknown) {
  const identity = await requireNewItemActor(), parsed = prepareSourceSlotSchema.parse(input), workspace = await scopeWorkspace(identity, parsed.scopeId, true);
  const preview = requireObservation(workspace, parsed.observationId).sourceSlotPreview;
  if (!preview) throw new Error('NEW_ITEM_REVIEW_REQUIRED'); return preview;
}
export async function prepareCatalogProofAssociation(input: unknown) {
  const identity = await requireNewItemActor(), parsed = prepareCatalogProofSchema.parse(input);
  const workspace = await scopeWorkspace(identity, parsed.scopeId, true), options = await scopedOptions(identity, workspace);
  const option = options.catalogProofOptions.find((entry) => entry.observationId === parsed.observationId
    && entry.basis.associationProofRef.captureId === parsed.associationProofRef.captureId && entry.basis.associationProofRef.proofKey === parsed.associationProofRef.proofKey);
  if (!option) throw new Error('ASSOCIATION_PROOF_INVALID'); return option;
}
export async function prepareAttachSourceIdentity(input: unknown) {
  const identity = await requireNewItemActor(), parsed = prepareAttachIdentitySchema.parse(input);
  const workspace = await scopeWorkspace(identity, parsed.scopeId, true), options = await scopedOptions(identity, workspace);
  const option = options.attachOptions.find((entry) => entry.observationId === parsed.observationId
    && entry.associationProofRef?.captureId === parsed.associationProofRef.captureId && entry.associationProofRef.proofKey === parsed.associationProofRef.proofKey);
  if (!option) throw new Error('ASSOCIATION_PROOF_INVALID'); return option;
}
export async function recoverNewItemRequest(input: unknown) {
  const identity = await requireNewItemActor(), parsed = actionSchema.parse(input);
  const prepared = await mutationInput(identity, parsed.action, parsed.input, false);
  return newItemRepository.receipt(identity, prepared.requestId, prepared.scopeId, parsed.action,
    newItemIntent(identity, prepared.scopeId, parsed.action, prepared.payload));
}
export async function readNewItemSensitiveHistory(input: unknown) {
  const identity = await requireNewItemActor(), parsed = readNewItemSchema.parse(input);
  if (parsed.projection !== 'sensitive_history') throw new Error('NEW_ITEM_FORBIDDEN');
  return newItemRepository.history(identity, parsed.scopeId, parsed.observationId);
}
export async function getProductEvidence(evidenceId: string) {
  const identity = await requireNewItemActor(), metadata = await newItemRepository.evidence(identity, uuidSchema.parse(evidenceId));
  const bytes = await readPrivateArtifact(metadata);
  return { bytes, metadata: { evidenceId: metadata.evidenceId, scopeId: metadata.scopeId, sha256: metadata.sha256, size: metadata.size, format: metadata.format } };
}
export async function getProductEvidenceExport(evidenceId: string) {
  const identity = await requireNewItemActor(); return newItemRepository.evidenceExport(identity, uuidSchema.parse(evidenceId));
}
/** Only a current authorized scope can supply a private write route for an item. */
export async function getNewItemWriteContext(itemId: string) {
  if (!newItemEnabled()) return null;
  const identity = await requireNewItemActor(), scopes = await newItemRepository.scopes(identity);
  for (const scope of scopes) {
    const workspace = await newItemRepository.read(identity, scope.scopeId);
    if (workspace.permissions.manage && workspace.permissions.publish && workspace.origins.some((origin) => origin.itemId === itemId && origin.originKind === 'created')) return { scopeId: scope.scopeId };
  }
  return null;
}
export async function getNewItemDetailPanel(item: CatalogItemDto) {
  const empty = { enabled: false, canWrite: false, candidates: { bigseller: [] as ReturnType<typeof buildCandidates>, jushuitan: [] as ReturnType<typeof buildCandidates> } };
  if (!newItemEnabled()) return empty;
  const identity = await requireNewItemActor(), scopes = await newItemRepository.scopes(identity);
  const workspaces = await Promise.all(scopes.map((scope) => newItemRepository.read(identity, scope.scopeId)));
  const observations = workspaces.flatMap((workspace) => workspace.scope.system === 'feishu' ? [] : workspace.observations.filter((observation) => {
    const sku = observation.fields.sku;
    return sku?.state === 'observed' && sku.meaning === 'value' && !(observation.origin?.originKind === 'created' && observation.origin.itemId === item.itemId);
  }).map((observation) => ({ observationId: observation.observationId, sourceSystem: workspace.scope.system,
    fields: { ...observation.fields, name: observation.fields.nameCn }, position: {}, rawRef: 'scoped-observation',
    reviewState: observation.classification?.reviewState ?? null, selectedItemId: null, existingDecisionRef: null, conflicts: [] as string[] })));
  return { enabled: true, canWrite: workspaces.some((workspace) => workspace.permissions.manage && workspace.permissions.publish
    && workspace.origins.some((origin) => origin.originKind === 'created' && origin.itemId === item.itemId)),
    candidates: { bigseller: buildCandidates(item, observations, 'bigseller'), jushuitan: buildCandidates(item, observations, 'jushuitan') } };
}
