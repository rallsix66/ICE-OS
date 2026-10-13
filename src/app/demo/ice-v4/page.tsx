import type { Metadata } from 'next';
import { IceDemoApp } from '@/features/ice-demo/demo-app';

export const metadata: Metadata = {
  title: 'ICE · 库存经营工作台 | 虚构演示',
  description: 'ICE v4 独立交互原型。全部为虚构数据，不连接或修改业务系统。',
  robots: { index: false, follow: false },
};

export default function IceDemoPage() {
  return <IceDemoApp />;
}
