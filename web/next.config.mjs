import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A static export: Vercel serves it from its CDN, and the GOAT server can serve the same out/
// folder offline (GOAT_SITE_DIR=web/out). The root is pinned to web/ because the repo above
// has its own package-lock.json.
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};

export default nextConfig;
