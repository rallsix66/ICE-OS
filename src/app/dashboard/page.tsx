import { redirect } from 'next/navigation';

/** 工作台默认进入已实现的 ICE 商品库。 */
export default function DashboardRootPage() {
  redirect('/dashboard/catalog');
}
