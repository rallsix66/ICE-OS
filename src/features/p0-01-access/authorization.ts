import type { IceBusinessRole } from './types';

export type InventoryAction = 'inventory:read' | 'amount:read' | 'access:admin';

const ROLE_ACTIONS: Record<IceBusinessRole, ReadonlySet<InventoryAction>> = {
  admin: new Set(['inventory:read', 'amount:read', 'access:admin']),
  manager: new Set(['inventory:read', 'amount:read']),
  operator: new Set(['inventory:read']),
};

export function isKnownRole(role: string): role is IceBusinessRole {
  return role === 'admin' || role === 'manager' || role === 'operator';
}

export function canPerformAction(role: IceBusinessRole, action: InventoryAction): boolean {
  return ROLE_ACTIONS[role].has(action);
}

export function assertActionAllowed(role: IceBusinessRole, action: InventoryAction): void {
  if (!canPerformAction(role, action)) {
    throw new AuthorizationError('当前角色不允许此操作');
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class InactiveUserError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'InactiveUserError';
  }
}
