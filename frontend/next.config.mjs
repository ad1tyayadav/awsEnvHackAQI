/** Next.js config: static export (PRD section 10), API base URL baked at build time.
 *  Empty NEXT_PUBLIC_API_URL = demo mode (in-browser fallback, no backend needed).
 *  Set it to the deployed API URL for live mode. */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '',
  },
};

export default nextConfig;
