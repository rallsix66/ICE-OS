'use client';

// 登录页 — Email + Password 登录
// 已登录用户由 middleware 自动重定向到 /dashboard
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Package } from 'lucide-react';

const LOGIN_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MSG = '登录请求超时，请检查网络或认证服务配置后重试';

function withLoginTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(LOGIN_TIMEOUT_MSG)), LOGIN_TIMEOUT_MS)
  );
  return Promise.race([promise, timeout]);
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError('请输入邮箱和密码');
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await withLoginTimeout(
        supabase.auth.signInWithPassword({ email, password })
      );

      if (authError) {
        // 映射常见错误为用户友好的提示
        if (authError.message.includes('Invalid login credentials')) {
          setError('邮箱或密码错误');
        } else if (authError.message.includes('Email not confirmed')) {
          setError('邮箱未验证，请检查收件箱');
        } else {
          setError(authError.message);
        }
        setLoading(false);
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch (loginError) {
      // 只允许超时错误透出特定中文提示；其他网络/未知异常统一使用通用提示，防止泄露原始英文错误
      const isTimeout = loginError instanceof Error && loginError.message === LOGIN_TIMEOUT_MSG;
      setError(
        isTimeout
          ? LOGIN_TIMEOUT_MSG
          : '登录请求失败，请检查网络或认证服务配置后重试'
      );
      setLoading(false);
      return;
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm">
        {/* Logo + 标题 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gray-900 text-white mb-4">
            <Package className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">库存看板系统</h1>
          <p className="text-sm text-gray-500 mt-1">登录以继续</p>
        </div>

        {/* 登录表单 */}
        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </Button>
        </form>
      </div>
    </div>
  );
}
