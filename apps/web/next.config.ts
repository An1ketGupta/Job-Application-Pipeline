import type { NextConfig } from 'next';
const config: NextConfig = {
  devIndicators: false,
  // Isolate local browser tests from an already-running development server.
  distDir: process.env.CAREERLIFT_WEB_DIST_DIR || '.next',
};
export default config;
