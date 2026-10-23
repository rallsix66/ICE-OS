import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '团队账号 · 已封存' };

export default function UsersAdminSealedPage() {
  return (
    <SealedLegacyRoute title="团队账号管理界面已封存">
      <p>旧账号启用/角色调整页面已退出 Dashboard；登录、停用检查与金额权限仍由服务端鉴权保障。</p>
      <p>账号管理将按新方案单独分包验收后再开放。</p>
    </SealedLegacyRoute>
  );
}
