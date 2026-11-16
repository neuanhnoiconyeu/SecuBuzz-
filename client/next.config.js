const { authProxyRewrites, socialProxyRewrites, messagingProxyRewrites, realtimeProxyRewrites } = require('./authProxy.cjs');
const isolatedDist = process.env.CLIENT_TEST_DIST_DIR;
if (isolatedDist && !/^\.next-e2ee-[a-z0-9-]+$/.test(isolatedDist)) throw new Error('Invalid isolated build directory.');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep a running dev server's assets separate from `next build` output.
  // This prevents production builds from replacing stylesheets used by `next dev`.
  distDir: isolatedDist || (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'),
  reactStrictMode: true,
  swcMinify: true,
  typescript: {
    // Strict type checking
    tsconfigPath: isolatedDist ? require('./scripts/e2ee-build-config.cjs').isolatedTsconfig(isolatedDist) : './tsconfig.json',
  },
  compress: true,
  poweredByHeader: false,
  async rewrites() {
    return [...authProxyRewrites(), ...socialProxyRewrites(), ...messagingProxyRewrites(), ...realtimeProxyRewrites()];
  },
  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:",
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
