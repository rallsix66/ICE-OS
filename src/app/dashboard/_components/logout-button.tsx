'use client';

// 登出按钮 — 清除 session 并跳转登录页
// 可访问名称由 aria-label 提供；退出失败必须可见（role=alert），不能静默失败。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { clearDetailCache } from '@/features/catalog/shell/catalog-detail-cache';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import shellStyles from '@/ui/ice-v4/shell.module.css';

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    setLoading(true);
    setError(null);
    try {
      clearDetailCache();
      const supabase = createClient();
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) throw signOutError;
      router.push('/auth/login');
      router.refresh();
    } catch {
      setError('退出登录失败，请重试；如仍失败，请刷新页面后重新登录。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className={shellStyles.logoutGroup}>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleLogout}
        disabled={loading}
        aria-label={loading ? '正在退出登录' : '退出登录'}
        title="退出登录"
        className="text-gray-500 hover:text-gray-700"
      >
        <LogOut className="w-4 h-4" aria-hidden />
      </Button>
      {error && (
        <span role="alert" data-testid="logout-error" className={shellStyles.logoutError}>
          {error}
        </span>
      )}
    </span>
  );
}
