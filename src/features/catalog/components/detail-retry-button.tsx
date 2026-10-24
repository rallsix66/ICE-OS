'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * F06-direct：直链读取失败（网络/传输异常）的重试入口。
 * 只触发当前路由的服务器重渲染，不改变 URL，也不吞掉错误信息。
 */
export function DetailRetryButton({ label = '重试' }: { label?: string }) {
  const router = useRouter();
  return (
    <Button type="button" variant="outline" onClick={() => router.refresh()}>
      {label}
    </Button>
  );
}
