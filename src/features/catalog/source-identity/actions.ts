'use server';

import { revalidatePath } from 'next/cache';
import type { SourceIdentityActionResult } from './types';
import { prepareSourceFixtureCapturePreview, importSourceFixtureCapture, registerSourceIdentity, reviseSourceIdentity,
  linkSourceObservation, recoverSourceIdentityRequest } from './service';

async function perform<T>(operation: () => Promise<T>, mutation = false): Promise<SourceIdentityActionResult<T>> {
  try {
    const data = await operation();
    if (mutation) { try { revalidatePath('/dashboard/catalog', 'layout'); } catch { /* a committed fact is still committed */ } }
    return { status: 'success', data };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (message === 'IDENTITY_REQUEST_OUTCOME_UNKNOWN') return { status: 'unknown', code: 'IDENTITY_REQUEST_OUTCOME_UNKNOWN' };
    const conflicts = ['IDENTITY_REQUEST_CONFLICT', 'CAPTURE_CONFLICT', 'IDENTITY_REVISION_CONFLICT', 'IDENTITY_MATCH_CONFLICT',
      'IDENTITY_KEY_CONFLICT', 'IDENTITY_KEY_RESERVED', 'IDENTITY_STATE_REQUIRES_REVERIFY', 'SCOPE_CROSSWALK_REQUIRED',
      'CONTRACT_UPGRADE_CROSSWALK_REQUIRED', 'IDENTITY_DUPLICATE_KEY', 'IDENTITY_LINK_CONFLICT', 'IDENTITY_PREVIEW_CHANGED',
      'IDENTITY_PROOF_COVERAGE_REQUIRED', 'IDENTITY_FROZEN_SCOPE_CONTRADICTION'];
    if (conflicts.includes(message)) return { status: 'conflict', code: message };
    if (['23505', '40001'].includes(code)) return { status: 'conflict', code: 'IDENTITY_CONFLICT' };
    return { status: 'denied', code: 'IDENTITY_OPERATION_DENIED' };
  }
}
export async function prepareSourceFixtureCaptureAction(input: unknown) { return perform(() => prepareSourceFixtureCapturePreview(input)); }
export async function importSourceFixtureCaptureAction(input: unknown) { return perform(() => importSourceFixtureCapture(input), true); }
export async function registerSourceIdentityAction(input: unknown) { return perform(() => registerSourceIdentity(input), true); }
export async function reviseSourceIdentityAction(input: unknown) { return perform(() => reviseSourceIdentity(input), true); }
export async function linkSourceObservationAction(input: unknown) { return perform(() => linkSourceObservation(input), true); }
export async function recoverSourceIdentityRequestAction(input: unknown) { return perform(() => recoverSourceIdentityRequest(input)); }
