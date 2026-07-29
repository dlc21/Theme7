import path from "node:path"
import { defineConfig } from "@playwright/test"

const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
const terminalPort = process.env.OPERATOR_ENGINE_TEST_TERMINAL_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_TERMINAL_PORT ?? "4401"
const data = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
const baseURL = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  workers: 1,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && npm run start",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      OPERATOR_ENGINE_HOST: "127.0.0.1",
      OPERATOR_ENGINE_PORT: webPort,
      OPERATOR_ENGINE_TERMINAL_PORT: terminalPort,
      OPERATOR_ENGINE_DATA_DIR: data,
      OPERATOR_ENGINE_DB_PATH: path.join(data, "operator-engine.sqlite"),
      OPERATOR_ENGINE_WORKSPACE_ROOT: path.join(data, "workspace"),
      OPERATOR_ENGINE_WORKSPACE_ROOTS: path.join(data, "workspace-two"),
      OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-browser-smoke-secret",
      OPERATOR_ENGINE_ACCESS_MODE: "open",
      OPERATOR_ENGINE_DISTRIBUTION: process.env.OPERATOR_ENGINE_TEST_DISTRIBUTION ?? "stock",
      OPERATOR_ENGINE_CODEX_BIN: process.env.OPERATOR_ENGINE_TEST_CODEX_BIN ?? path.join(process.cwd(), "tests", "fixtures", "fake-codex.mjs"),
      OPERATOR_ENGINE_OMP_PREWARM: "0",
      OPERATOR_ENGINE_OMP_BIN: process.env.OPERATOR_ENGINE_TEST_OMP_BIN ?? process.execPath,
      OPERATOR_ENGINE_T4_URL: process.env.OPERATOR_ENGINE_TEST_T4_URL ?? "",
      OPERATOR_ENGINE_STANDALONE: "0",
    },
  },
})
