/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone — компактная самодостаточная сборка для запуска на VPS
  // (node .next/standalone/server.js). Подробности — в DEPLOY.md.
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async redirects() {
    return [
      {
        source: '/catalog/zhguty',
        destination: '/production/zhguty',
        permanent: true,
      },
    ]
  },
}

export default nextConfig
