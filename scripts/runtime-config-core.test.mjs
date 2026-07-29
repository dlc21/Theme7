import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  accessConfig,
  configuredValue,
  parseWorkspaceRoots,
  resolveRuntimeHosts,
  resolveRuntimePaths,
  resolveRuntimePorts,
  terminalLoopbackOrigin,
  terminalSecret,
  webControlOrigin,
} from "./runtime-config-core.mjs"

describe("runtime configuration", () => {
  it("reads only canonical values", () => {
    expect(configuredValue("PORT", { OPERATOR_ENGINE_PORT: "1" })).toBe("1")
    expect(configuredValue("PORT", { PORT: "2" })).toBeUndefined()
  })

  it("uses canonical runtime paths", () => {
    const paths = resolveRuntimePaths({ OPERATOR_ENGINE_DATA_DIR: "data", OPERATOR_ENGINE_DB_PATH: "db.sqlite", OPERATOR_ENGINE_WORKSPACE_ROOT: "work" }, { homeDirectory: "home" })
    expect(paths.dataDirectory).toBe(path.resolve("data"))
    expect(paths.databasePath).toBe(path.resolve("db.sqlite"))
    expect(paths.workspaceRoot).toBe(path.resolve("work"))
  })

  it("uses only the canonical home directory", () => {
    const home = path.resolve("home")
    expect(resolveRuntimePaths({}, { homeDirectory: home }).dataDirectory).toBe(path.join(home, ".operator-engine"))
  })

  it("validates canonical ports and ignores framework variables", () => {
    expect(resolveRuntimePorts({ OPERATOR_ENGINE_PORT: "4500", OPERATOR_ENGINE_TERMINAL_PORT: "4501" })).toEqual({ webPort: 4500, terminalPort: 4501 })
    expect(resolveRuntimePorts({ PORT: "5500" })).toEqual({ webPort: 4400, terminalPort: 4401 })
    for (const value of ["0", "65536", "1.5", "nope"]) expect(() => resolveRuntimePorts({ OPERATOR_ENGINE_PORT: value })).toThrow("Invalid OPERATOR_ENGINE_PORT")
  })

  it("uses the web host as the terminal host fallback", () => {
    expect(resolveRuntimeHosts({ OPERATOR_ENGINE_HOST: "0.0.0.0" })).toEqual({ webHost: "0.0.0.0", terminalHost: "0.0.0.0" })
  })

  it("keeps internal origins on loopback regardless of bind hosts", () => {
    const env = { OPERATOR_ENGINE_HOST: "0.0.0.0", OPERATOR_ENGINE_TERMINAL_HOST: "::", OPERATOR_ENGINE_PORT: "4500", OPERATOR_ENGINE_TERMINAL_PORT: "4501" }
    expect(webControlOrigin(env)).toBe("http://127.0.0.1:4500")
    expect(terminalLoopbackOrigin(env)).toBe("http://127.0.0.1:4501")
  })

  it("uses one development secret and fails closed in production", () => {
    expect(terminalSecret({})).toBe("operator-engine-local-terminal")
    expect(terminalSecret({ OPERATOR_ENGINE_TERMINAL_SECRET: " fixture-canonical-secret " })).toBe("fixture-canonical-secret")
    expect(() => terminalSecret({ NODE_ENV: "production" })).toThrow("OPERATOR_ENGINE_TERMINAL_SECRET is required in production.")
  })

  it("honors delimiters, order, and Windows case folding", () => {
    const roots = parseWorkspaceRoots("C:\\Primary", "c:\\primary;D:\\Projects", ";")
    expect(roots[0]).toMatch(/Primary$/i)
    expect(roots.at(-1)).toMatch(/Projects$/i)
    expect(roots).toHaveLength(process.platform === "win32" ? 2 : 3)
  })
})

  describe("accessConfig", () => {
    it("handles absent development access mode as open", () => {
      expect(accessConfig({ NODE_ENV: "development" })).toEqual({ mode: "open" })
    })

    it("throws on absent production access mode", () => {
      expect(() => accessConfig({ NODE_ENV: "production" })).toThrow(
        "production requires explicit OPERATOR_ENGINE_ACCESS_MODE=open|password"
      )
    })

    it("handles explicit open access mode in production", () => {
      expect(accessConfig({ NODE_ENV: "production", OPERATOR_ENGINE_ACCESS_MODE: "open" })).toEqual({ mode: "open" })
    })

    it("handles valid password access mode", () => {
      const password = "fixture-password-" + "a".repeat(12)
      const sessionSecret = "fixture-session-secret-" + "b".repeat(12)
      expect(
        accessConfig({
          OPERATOR_ENGINE_ACCESS_MODE: "password",
          OPERATOR_ENGINE_ACCESS_PASSWORD: password,
          OPERATOR_ENGINE_ACCESS_SESSION_SECRET: sessionSecret,
        })
      ).toEqual({ mode: "password", password, sessionSecret })
    })

    it("rejects password shorter than 24 characters", () => {
      const password = "fixture-short"
      const sessionSecret = "fixture-session-secret-" + "b".repeat(12)
      expect(() =>
        accessConfig({
          OPERATOR_ENGINE_ACCESS_MODE: "password",
          OPERATOR_ENGINE_ACCESS_PASSWORD: password,
          OPERATOR_ENGINE_ACCESS_SESSION_SECRET: sessionSecret,
        })
      ).toThrow("OPERATOR_ENGINE_ACCESS_PASSWORD must be at least 24 characters.")
    })

    it("rejects session secret shorter than 32 characters", () => {
      const password = "fixture-password-" + "a".repeat(12)
      const sessionSecret = "fixture-short"
      expect(() =>
        accessConfig({
          OPERATOR_ENGINE_ACCESS_MODE: "password",
          OPERATOR_ENGINE_ACCESS_PASSWORD: password,
          OPERATOR_ENGINE_ACCESS_SESSION_SECRET: sessionSecret,
        })
      ).toThrow("OPERATOR_ENGINE_ACCESS_SESSION_SECRET must be at least 32 characters.")
    })
  })
