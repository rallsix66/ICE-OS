import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: process.env.CATALOG_HIDE_DEV_INDICATORS === 'true' ? false : undefined,
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
