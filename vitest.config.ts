import path from "node:path"
import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: { "@": root } },
  test: {
    include: ["**/*.test.ts", "**/*.test.mjs"],
    exclude: [...configDefaults.exclude, "client-workspace/**", "theme-7-edition/**"],
  },
})
