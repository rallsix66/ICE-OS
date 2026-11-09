import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSessionUser, mockProfileUserId, mockQuery } = vi.hoisted(() => ({
  mockSessionUser: vi.fn(),
  mockProfileUserId: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock('@/lib/independent-platform/p0-02-session', () => ({
  getP002AuthSessionUser: mockSessionUser,
  getP002ProfileUserId: mockProfileUserId,
}));

vi.mock('@/lib/database/app-db', () => ({
  withAppDb: async (
    _context: unknown,
    callback: (client: { query: typeof mockQuery }) => Promise<unknown>,
  ) => callback({ query: mockQuery }),
}));

import {
  getCurrentUser,
  getCurrentActiveUser,
  requireAuth,
  requireAdmin,
  requireActiveAuth,
  requireActiveAdmin,
} from '@/lib/auth';

function resetMocks() {
  vi.clearAllMocks();
}

function mockSession(email = 'admin@test.com') {
  mockSessionUser.mockResolvedValue({ id: 'auth-user-1', email });
  mockProfileUserId.mockResolvedValue('user-1');
}

function mockNoSession() {
  mockSessionUser.mockResolvedValue(null);
}

function mockNoProfileUser() {
  mockSessionUser.mockResolvedValue({ id: 'auth-user-1', email: 'admin@test.com' });
  mockProfileUserId.mockResolvedValue(null);
}

function mockProfile(overrides: Record<string, unknown> = {}) {
  mockQuery.mockResolvedValue({
    rowCount: 1,
    rows: [{ display_name: 'Test User', is_active: true, role_name: 'admin', ...overrides }],
  });
}

function mockProfileNotFound() {
  mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
}

function mockProfileError() {
  mockQuery.mockRejectedValue(new Error('db error'));
}

describe('getCurrentUser (Better Auth + 本地 PostgreSQL)', () => {
  beforeEach(resetMocks);

  it('returns user when authenticated and profile exists', async () => {
    mockSession();
    mockProfile();

    const user = await getCurrentUser();

    expect(user).not.toBeNull();
    expect(user!.id).toBe('user-1');
    expect(user!.email).toBe('admin@test.com');
    expect(user!.displayName).toBe('Test User');
    expect(user!.roleName).toBe('admin');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns null when not authenticated', async () => {
    mockNoSession();
    expect(await getCurrentUser()).toBeNull();
  });

  it('returns null when session has no local profile mapping', async () => {
    mockNoProfileUser();
    expect(await getCurrentUser()).toBeNull();
  });

  it('falls back to email prefix when display_name is null', async () => {
    mockSession('test@example.com');
    mockProfile({ display_name: null });

    const user = await getCurrentUser();

    expect(user!.displayName).toBe('test');
  });

  it('defaults roleName to operator when role is missing', async () => {
    mockSession();
    mockProfile({ role_name: null });

    const user = await getCurrentUser();

    expect(user!.roleName).toBe('operator');
  });
});

describe('requireAuth', () => {
  beforeEach(resetMocks);

  it('returns user when authenticated', async () => {
    mockSession();
    mockProfile();

    const user = await requireAuth();

    expect(user.id).toBe('user-1');
  });

  it('throws when not authenticated', async () => {
    mockNoSession();

    await expect(requireAuth()).rejects.toThrow('未登录');
  });
});

describe('requireAdmin', () => {
  beforeEach(resetMocks);

  it('returns user when admin', async () => {
    mockSession();
    mockProfile();

    const user = await requireAdmin();

    expect(user.roleName).toBe('admin');
  });

  it('throws when operator', async () => {
    mockSession();
    mockProfile({ role_name: 'operator' });

    await expect(requireAdmin()).rejects.toThrow('无权限');
  });
});

describe('getCurrentActiveUser', () => {
  beforeEach(resetMocks);

  it('returns user with isActive when authenticated and active', async () => {
    mockSession();
    mockProfile({ is_active: true });

    const user = await getCurrentActiveUser();

    expect(user).not.toBeNull();
    expect(user!.id).toBe('user-1');
    expect(user!.email).toBe('admin@test.com');
    expect(user!.displayName).toBe('Test User');
    expect(user!.roleName).toBe('admin');
    expect(user!.isActive).toBe(true);
  });

  it('returns null when user is not authenticated', async () => {
    mockNoSession();

    expect(await getCurrentActiveUser()).toBeNull();
  });

  it('returns null when is_active is false', async () => {
    mockSession();
    mockProfile({ is_active: false });

    expect(await getCurrentActiveUser()).toBeNull();
  });

  it('throws on profile database error', async () => {
    mockSession();
    mockProfileError();

    await expect(getCurrentActiveUser()).rejects.toThrow('数据库错误');
  });

  it('returns null when profile not found', async () => {
    mockSession();
    mockProfileNotFound();

    expect(await getCurrentActiveUser()).toBeNull();
  });

  it('returns operator role for active operator user', async () => {
    mockSession('operator@test.com');
    mockProfile({ is_active: true, role_name: 'operator' });

    const user = await getCurrentActiveUser();

    expect(user!.roleName).toBe('operator');
    expect(user!.isActive).toBe(true);
  });
});

describe('requireActiveAuth / requireActiveAdmin', () => {
  beforeEach(resetMocks);

  it('requireActiveAuth returns active user', async () => {
    mockSession();
    mockProfile();

    const user = await requireActiveAuth();

    expect(user.isActive).toBe(true);
  });

  it('requireActiveAuth throws when inactive', async () => {
    mockSession();
    mockProfile({ is_active: false });

    await expect(requireActiveAuth()).rejects.toThrow('未登录或账户已停用');
  });

  it('requireActiveAdmin returns active admin', async () => {
    mockSession();
    mockProfile();

    const user = await requireActiveAdmin();

    expect(user.roleName).toBe('admin');
  });

  it('requireActiveAdmin throws for operator', async () => {
    mockSession();
    mockProfile({ role_name: 'operator' });

    await expect(requireActiveAdmin()).rejects.toThrow('无权限');
  });
});
