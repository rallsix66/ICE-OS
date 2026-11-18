import { beforeEach, describe, expect, it, vi } from 'vitest';

const withAppDbMock = vi.fn();
const callAppRpcMock = vi.fn();
const setAuthAccountPasswordMock = vi.fn();

vi.mock('@/lib/database/app-db', () => ({
  withAppDb: (...args: unknown[]) => withAppDbMock(...args),
  callAppRpc: (...args: unknown[]) => callAppRpcMock(...args),
}));

vi.mock('./reads', () => ({
  requireAccessAdmin: async () => ({ profileUserId: 'admin-profile' }),
  getAccessAccount: async () => null,
}));

vi.mock('./auth-accounts', () => ({
  setAuthAccountPassword: (...args: unknown[]) => setAuthAccountPasswordMock(...args),
  provisionAuthAccount: vi.fn(),
  deleteAuthAccount: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { resetAccessPasswordAction } from './actions';

const PROFILE = '11111111-1111-4111-8111-111111111104';
const ADMIN_PROFILE = '11111111-1111-4111-8111-111111111101';

function accountTarget(target: { authUserId?: string | null; isSystemAdmin?: boolean } | null) {
  withAppDbMock.mockResolvedValue(target);
}

beforeEach(() => {
  withAppDbMock.mockReset();
  callAppRpcMock.mockReset();
  setAuthAccountPasswordMock.mockReset();
});

describe('resetAccessPasswordAction', () => {
  it('普通成员：改密成功后写入重置留痕（只传目标，不含密码）', async () => {
    accountTarget({ authUserId: 'auth-user-1', isSystemAdmin: false });
    const result = await resetAccessPasswordAction({ profileId: PROFILE, password: 'NewPassword!1' });
    expect(result).toEqual({ success: true });
    expect(setAuthAccountPasswordMock).toHaveBeenCalledWith('auth-user-1', 'NewPassword!1');
    expect(callAppRpcMock).toHaveBeenCalledTimes(1);
    const [identity, spec, params] = callAppRpcMock.mock.calls[0];
    expect(identity).toEqual({ profileUserId: 'admin-profile' });
    expect(spec).toBe('catalog.record_access_password_reset');
    expect(params).toEqual([PROFILE]);
    expect(JSON.stringify(callAppRpcMock.mock.calls)).not.toContain('NewPassword!1');
  });

  it('管理员账号：服务端以现有账号类型标记拒绝，不改密码、不留痕', async () => {
    accountTarget({ authUserId: 'auth-admin', isSystemAdmin: true });
    const result = await resetAccessPasswordAction({ profileId: ADMIN_PROFILE, password: 'NewPassword!1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('管理员');
    expect(setAuthAccountPasswordMock).not.toHaveBeenCalled();
    expect(callAppRpcMock).not.toHaveBeenCalled();
  });

  it('缺少认证账号：按账号不存在处理，不改密码', async () => {
    accountTarget({ authUserId: null, isSystemAdmin: false });
    const result = await resetAccessPasswordAction({ profileId: PROFILE, password: 'NewPassword!1' });
    expect(result.success).toBe(false);
    expect(setAuthAccountPasswordMock).not.toHaveBeenCalled();
  });

  it('短密码在读取目标前就被拒绝', async () => {
    const result = await resetAccessPasswordAction({ profileId: PROFILE, password: 'short' });
    expect(result.success).toBe(false);
    expect(withAppDbMock).not.toHaveBeenCalled();
    expect(setAuthAccountPasswordMock).not.toHaveBeenCalled();
  });
});
