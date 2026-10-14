// 登录页反馈测试
//
// 验证登录请求不会无限停留在 loading 状态：
// - signInWithPassword 包裹超时保护
// - 超时/网络异常显示中文提示
// - 失败路径恢复 setLoading(false)
// - 不泄露原始英文错误信息

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const LOGIN_PAGE_PATH = path.resolve(process.cwd(), 'src/app/auth/login/page.tsx');

describe('LoginPage 登录反馈', () => {
  const src = fs.readFileSync(LOGIN_PAGE_PATH, 'utf-8');

  it('定义登录超时常量和中文超时消息，避免无限等待', () => {
    expect(src).toMatch(/const LOGIN_TIMEOUT_MS = 15_000/);
    expect(src).toMatch(/const LOGIN_TIMEOUT_MSG = '登录请求超时，请检查网络或认证服务配置后重试'/);
  });

  it('signInWithPassword 使用超时保护包装', () => {
    expect(src).toMatch(/withLoginTimeout\(/);
    expect(src).toMatch(/Promise\.race/);
    expect(src).toMatch(/supabase\.auth\.signInWithPassword/);
    expect(src).toMatch(/new Error\(LOGIN_TIMEOUT_MSG\)/);
  });

  it('超时和网络异常返回明确中文提示', () => {
    expect(src).toContain('登录请求超时，请检查网络或认证服务配置后重试');
    expect(src).toContain('登录请求失败，请检查网络或认证服务配置后重试');
  });

  it('异常失败路径恢复登录按钮状态', () => {
    const catchBlock = src.match(/catch \(loginError\) \{[\s\S]*?\n    \}/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock?.[0]).toContain('setLoading(false)');
    expect(catchBlock?.[0]).toContain('return;');
  });

  it('catch 块不泄露原始 Error.message，只允许超时消息透出', () => {
    // 不应存在直接透传任意 Error.message 的路径
    expect(src).not.toMatch(/\? loginError\.message/);
    // 超时判定逻辑必须存在
    expect(src).toMatch(/isTimeout/);
    expect(src).toMatch(/LOGIN_TIMEOUT_MSG/);
    // 通用 fallback 消息必须存在
    expect(src).toContain('登录请求失败，请检查网络或认证服务配置后重试');
  });
});
