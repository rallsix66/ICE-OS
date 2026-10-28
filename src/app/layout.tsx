import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from 'sonner';

export const metadata: Metadata = {
  title: 'ICE 经营工作台',
  description: 'ICE v4 本地独立平台 — 商品资料、BigSeller 库存与来源核实',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster position="top-right" duration={3000} />
      </body>
    </html>
  );
}
