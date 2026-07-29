import type { NextConfig } from "next"

import { configuredValue } from "./scripts/runtime-config-core.mjs"

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: configuredValue("NEXT_DIST_DIR") ?? ".next",
  outputFileTracingRoot: process.cwd(),
  ...(process.env.OPERATOR_ENGINE_BUILD_ID ? { generateBuildId: async () => process.env.OPERATOR_ENGINE_BUILD_ID! } : {}),
  serverExternalPackages: ["better-sqlite3", "@lydell/node-pty", "theme-7"],
}

export default nextConfig
