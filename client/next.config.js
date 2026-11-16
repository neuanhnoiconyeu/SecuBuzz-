const { callingRewrites } = require('./dev/callingProxy.cjs');
const developmentCallingRoutes = callingRewrites();
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep a running dev server's assets separate from `next build` output.
  // This prevents production builds from replacing stylesheets used by `next dev`.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  reactStrictMode: true,
  experimental: { externalDir: true },
  swcMinify: true,
  typescript: {
    // Strict type checking
    tsconfigPath: './tsconfig.json',
  },
  compress: true,
  poweredByHeader: false,
  // Socket.IO requires its trailing slash; redirects can break polling and upgrade requests.
  ...(developmentCallingRoutes.length ? { skipTrailingSlashRedirect: true } : {}),
  async rewrites() {
    return { beforeFiles: developmentCallingRoutes, afterFiles: [], fallback: [] };
  },
  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: wss: ws:",
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
