import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: process.env.CATALOG_HIDE_DEV_INDICATORS === 'true' ? false : undefined,
  // 本机预览统一用 127.0.0.1 访问 dev server；允许该来源加载 dev 资源与 HMR。
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    webpackMemoryOptimizations: true,
  },
  // Keep tracing inside this application. An unrelated lockfile above the
  // repository otherwise makes Turbopack select the user profile as its root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
