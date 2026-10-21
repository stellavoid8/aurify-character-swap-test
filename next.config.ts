import type { NextConfig } from 'next';

const ORT_BIN = 'node_modules/onnxruntime-node/bin/napi-v*';

const nextConfig: NextConfig = {
  // Native modules: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ['sharp', 'heic-convert', 'onnxruntime-node'],
  // The face models are read from disk at runtime, so tracing cannot see them.
  outputFileTracingIncludes: {
    '/**': ['./models/**'],
  },
  // Vercel functions run on linux x64 CPU: drop the other platforms' onnxruntime builds and the GPU providers
  // (only present if installed without .npmrc's onnxruntime-node-install=skip).
  outputFileTracingExcludes: {
    '/**': [
      `${ORT_BIN}/darwin/**`,
      `${ORT_BIN}/win32/**`,
      `${ORT_BIN}/linux/arm64/**`,
      `${ORT_BIN}/linux/x64/libonnxruntime_providers_*.so`,
    ],
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
};

export default nextConfig;
