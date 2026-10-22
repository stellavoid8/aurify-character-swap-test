/**
 * Whether `next/image` should serve this stored photo as is. Only Vercel Blob URLs (https) go through
 * the optimizer: the browser's own `blob:` previews have nothing to fetch, and the dev storage fallback's
 * `public/uploads` files appear after the server started, which the optimizer can't read.
 */
export function skipOptimizer(src: string): boolean {
  return !src.startsWith('https://');
}
