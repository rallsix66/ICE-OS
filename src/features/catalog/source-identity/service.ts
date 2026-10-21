import 'server-only';
import { z } from 'zod';
import { requireCatalogAdmin } from '../authorization';
import { readPrivateArtifact } from '../evidence-store';
import { sourceIdentityEnabled, requireSourceIdentityActor } from './authorization';
import { SOURCE_FIXTURE_MANIFEST, sourceFixtureManifest, prepareSourceFixtureCapture } from './fixture-adapter';
import { sourceIdentityRepository, sourceIdentityIntent } from './repository';
import { importSourceFixtureCaptureSchema, prepareSourceFixtureCaptureSchema, registerSourceIdentitySchema,
  reviseSourceIdentitySchema, linkSourceObservationSchema } from './schema';
import type { IdentityAction, IdentityWorkspaceDto, SourceIdentityPanelDto } from './types';
import type { DbIdentity } from '@/lib/database/app-db';

const uuid = z.string().uuid();
async function scopeAccess(identity: DbIdentity, scopeId: string, manage = false) {
  const workspace = await sourceIdentityRepository.workspace(identity, uuid.parse(scopeId));
  if (!workspace.permissions.read || (manage && !workspace.permissions.manage)) throw new Error('IDENTITY_FORBIDDEN');
  return workspace;
}
export async function getSourceIdentityWorkspace(scopeId?: string) {
  if (!sourceIdentityEnabled()) return { enabled: false as const, scopes: [], scopeId: null, workspace: null, fixtures: [] };
  const identity = await requireSourceIdentityActor();
  const scopes = await sourceIdentityRepository.scopes(identity);
  const selected = scopeId === undefined ? scopes[0]?.scopeId ?? null : uuid.parse(scopeId);
  if (selected !== null && !scopes.some((scope) => scope.scopeId === selected)) throw new Error('IDENTITY_FORBIDDEN');
  const workspace = selected ? await scopeAccess(identity, selected) : null;
  const visible = new Set(scopes.map((scope) => scope.scopeId));
  const fixtures = Object.entries(SOURCE_FIXTURE_MANIFEST).filter(([, manifest]) => visible.has(manifest.scopeId))
    .map(([fixtureId, manifest]) => ({ fixtureId, scopeId: manifest.scopeId, label: `隔离fixture · ${fixtureId}` }));
  return { enabled: true as const, scopes, scopeId: selected, workspace, fixtures };
}

export async function prepareSourceFixtureCapturePreview(input: unknown) {
  const parsed = prepareSourceFixtureCaptureSchema.parse(input), manifest = sourceFixtureManifest(parsed.fixtureId);
  const identity = await requireSourceIdentityActor(); await scopeAccess(identity, manifest.scopeId, true);
  const prepared = await prepareSourceFixtureCapture(parsed.fixtureId);
  return { fixtureId: prepared.fixtureId, scopeId: prepared.scopeId, previewId: prepared.capture.adoptionDigest,
    observationCount: prepared.capture.observations.length, captureKey: prepared.capture.captureKey,
    coverage: prepared.capture.coverage, verificationEnvironment: 'fixture' as const };
}
export async function importSourceFixtureCapture(input: unknown) {
  const parsed = importSourceFixtureCaptureSchema.parse(input), manifest = sourceFixtureManifest(parsed.fixtureId);
  const identity = await requireSourceIdentityActor(); await scopeAccess(identity, manifest.scopeId, true);
  const prepared = await prepareSourceFixtureCapture(parsed.fixtureId);
  if (parsed.previewId !== prepared.capture.adoptionDigest) throw new Error('IDENTITY_PREVIEW_CHANGED');
  return sourceIdentityRepository.mutate(identity, parsed.requestId, prepared.scopeId, 'import_capture', prepared.capture);
}
export async function registerSourceIdentity(input: unknown) {
  const parsed = registerSourceIdentitySchema.parse(input), identity = await requireSourceIdentityActor();
  await scopeAccess(identity, parsed.scopeId, true);
  const { requestId, scopeId, ...payload } = parsed;
  return sourceIdentityRepository.mutate(identity, requestId, scopeId, 'register', payload);
}
export async function reviseSourceIdentity(input: unknown) {
  const parsed = reviseSourceIdentitySchema.parse(input), identity = await requireSourceIdentityActor();
  await scopeAccess(identity, parsed.scopeId, true);
  const { requestId, scopeId, ...payload } = parsed;
  return sourceIdentityRepository.mutate(identity, requestId, scopeId, 'revise', payload);
}
export async function linkSourceObservation(input: unknown) {
  const parsed = linkSourceObservationSchema.parse(input), identity = await requireSourceIdentityActor();
  await scopeAccess(identity, parsed.scopeId, true);
  const { requestId, scopeId, ...payload } = parsed;
  return sourceIdentityRepository.mutate(identity, requestId, scopeId, 'link', payload);
}

const recoverySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import_capture'), input: importSourceFixtureCaptureSchema }).strict(),
  z.object({ action: z.literal('register'), input: registerSourceIdentitySchema }).strict(),
  z.object({ action: z.literal('revise'), input: reviseSourceIdentitySchema }).strict(),
  z.object({ action: z.literal('link'), input: linkSourceObservationSchema }).strict(),
]);
/** Independent read-only receipt path; no current form fields or new request IDs. */
export async function recoverSourceIdentityRequest(input: unknown) {
  const recovery = recoverySchema.parse(input), identity = await requireSourceIdentityActor();
  let requestId: string, scopeId: string, payload: unknown;
  if (recovery.action === 'import_capture') {
    const manifest = sourceFixtureManifest(recovery.input.fixtureId);
    await scopeAccess(identity, manifest.scopeId, true);
    const prepared = await prepareSourceFixtureCapture(recovery.input.fixtureId);
    if (prepared.capture.adoptionDigest !== recovery.input.previewId) throw new Error('IDENTITY_PREVIEW_CHANGED');
    requestId = recovery.input.requestId; scopeId = prepared.scopeId; payload = prepared.capture;
  } else {
    const { requestId: request, scopeId: scope, ...rest } = recovery.input; requestId = request; scopeId = scope; payload = rest;
  }
  await scopeAccess(identity, scopeId, true);
  return sourceIdentityRepository.receipt(identity, requestId, scopeId, recovery.action as IdentityAction, sourceIdentityIntent(identity, scopeId, recovery.action, payload));
}

export async function getSourceIdentityHistory(scopeId: string, recordId: string) {
  const identity = await requireSourceIdentityActor(), workspace = await scopeAccess(identity, scopeId);
  const record = workspace.records.find((entry) => entry.recordId === uuid.parse(recordId));
  if (!record) throw new Error('IDENTITY_FORBIDDEN');
  return { record, history: workspace.history.filter((entry) => entry.recordId === recordId),
    links: workspace.links.filter((entry) => entry.recordId === recordId), verificationEnvironment: 'fixture' as const };
}
export async function getSourceIdentityPanel(itemId: string): Promise<SourceIdentityPanelDto & { enabled: boolean; realVerifiedCount: 0 }> {
  uuid.parse(itemId);
  const empty: SourceIdentityPanelDto & { enabled: boolean; realVerifiedCount: 0 } = { enabled: false, realVerifiedCount: 0,
    verificationEnvironment: 'fixture', scopes: [], frozenHumanChoice: [], sourceIdentity: [], observations: [], links: [],
    catalogTargetDecision: 'not_implemented', formalRelationship: { usable: false, reason: 'N2_NOT_IMPLEMENTED' } };
  if (!sourceIdentityEnabled()) return empty;
  const identity = await requireSourceIdentityActor(), scopes = await sourceIdentityRepository.scopes(identity);
  const workspaces = await Promise.all(scopes.map((scope) => scopeAccess(identity, scope.scopeId)));
  const relevant = workspaces.map((workspace) => {
    const choices = workspace.frozenHumanChoice.filter((choice) => choice.selectedItemId === itemId);
    const oldIds = new Set(choices.map((choice) => choice.observationId));
    const currentLinks = new Map<string, IdentityWorkspaceDto['links'][number]>();
    for (const link of workspace.links) if ((currentLinks.get(link.observationKey)?.linkRevision ?? 0) < link.linkRevision) currentLinks.set(link.observationKey, link);
    const initialLinks = [...currentLinks.values()].filter((link) => link.status === 'linked' && link.originKind === 'frozen' && oldIds.has(link.originId));
    const recordIds = new Set(initialLinks.map((link) => link.recordId));
    const links = workspace.links.filter((link) => (link.originKind === 'frozen' && oldIds.has(link.originId)) || recordIds.has(link.recordId));
    const observationIds = new Set([...currentLinks.values()].filter((link) => link.status === 'linked' && link.originKind === 'identity' && recordIds.has(link.recordId)).map((link) => link.originId));
    return { workspace, choices, links, records: workspace.records.filter((record) => recordIds.has(record.recordId)),
      observations: workspace.observations.filter((observation) => observationIds.has(observation.observationId)) };
  }).filter((entry) => entry.choices.length > 0 || entry.links.length > 0);
  return { ...empty, enabled: true, scopes: relevant.map((entry) => entry.workspace.scope),
    frozenHumanChoice: relevant.flatMap((entry) => entry.choices), sourceIdentity: relevant.flatMap((entry) => entry.records),
    observations: relevant.flatMap((entry) => entry.observations), links: relevant.flatMap((entry) => entry.links) };
}

export async function getSourceIdentityEvidence(evidenceId: string) {
  const identity = await requireSourceIdentityActor();
  await requireCatalogAdmin('evidence:read'); await requireCatalogAdmin('amount:read');
  const metadata = await sourceIdentityRepository.evidence(identity, uuid.parse(evidenceId));
  if (!metadata) throw new Error('IDENTITY_FORBIDDEN');
  const bytes = await readPrivateArtifact(metadata);
  return { bytes, metadata: { evidenceId: metadata.evidenceId, scopeId: metadata.scopeId, sha256: metadata.sha256, size: metadata.size, format: metadata.format } };
}
export async function getSourceIdentityEvidenceExport(evidenceId: string) {
  const identity = await requireSourceIdentityActor();
  return sourceIdentityRepository.evidenceExport(identity, uuid.parse(evidenceId));
}
export async function getSourceIdentityExport(scopeId: string): Promise<IdentityWorkspaceDto> {
  const identity = await requireSourceIdentityActor(); return scopeAccess(identity, scopeId);
}
