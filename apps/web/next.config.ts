import type { NextConfig } from 'next';

const config: NextConfig = {
  // Static export: the EvoBridge server serves these files, so there is one process and one port.
  output: 'export',
  trailingSlash: false,
  images: { unoptimized: true },
  transpilePackages: ['@evobridge/shared'],
  // In development the dashboard runs on :3001 and talks to the API on :3000.
  ...(process.env.NODE_ENV === 'development'
    ? {
        async rewrites() {
          const api = process.env.EVOBRIDGE_API ?? 'http://localhost:3000';
          return [
            { source: '/api/:path*', destination: `${api}/api/:path*` },
            { source: '/hooks/:path*', destination: `${api}/hooks/:path*` },
          ];
        },
      }
    : {}),
};

export default config;
