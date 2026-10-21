import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native modules: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ['sharp', 'onnxruntime-node'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
};

export default nextConfig;
