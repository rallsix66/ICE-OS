'use client';

// 登出按钮 — 清除 session 并跳转登录页
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { clearDetailCache } from '@/features/catalog/shell/catalog-detail-cache';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    const supabase = createClient();
    clearDetailCache();
    await supabase.auth.signOut();
    router.push('/auth/login');
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleLogout}
      disabled={loading}
      className="text-gray-500 hover:text-gray-700"
    >
      <LogOut className="w-4 h-4" />
    </Button>
  );
}
