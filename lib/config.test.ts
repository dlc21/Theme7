import { afterEach, describe, expect, it, vi } from "vitest"

import { configuredValue, t4IntegrationConfig } from "@/lib/config"

afterEach(() => vi.unstubAllEnvs())

describe("t4IntegrationConfig", () => {
  it("keeps the integration absent until a URL is configured", () => {
    vi.stubEnv("OPERATOR_ENGINE_T4_URL", "")
    expect(t4IntegrationConfig()).toEqual({ url: null, error: null })
  })

  it.each([
    ["https://t4.example.test:8445/", "https://t4.example.test:8445/"],
    ["  https://community-node.example.test:8445/  ", "https://community-node.example.test:8445/"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173/"],
    ["http://localhost:5173/t4", "http://localhost:5173/t4"],
    ["http://[::1]:5173/", "http://[::1]:5173/"],
  ])("accepts a credential-free T4 URL: %s", (configured, normalized) => {
    vi.stubEnv("OPERATOR_ENGINE_T4_URL", configured)
    expect(t4IntegrationConfig()).toEqual({ url: normalized, error: null })
  })

  it.each([
    "http://t4.example.com",
    ["https://user@", "t4.example.test"].join(""),
    ["https://t4.example.test?", "token=nope"].join(""),
    "https://t4.example.com/#session",
    "file:///tmp/t4",
  ])("returns a deliberate error without exposing an invalid value: %s", (configured) => {
    vi.stubEnv("OPERATOR_ENGINE_T4_URL", configured)
    expect(t4IntegrationConfig()).toEqual({
      url: null,
      error: "OPERATOR_ENGINE_T4_URL must be HTTPS, or loopback HTTP, with no credentials, query, or fragment.",
    })
  })
})

describe("Operator Engine configuration", () => {
  it("reads canonical keys", () => {
    vi.stubEnv("OPERATOR_ENGINE_PORT", "4401")
    expect(configuredValue("PORT")).toBe("4401")
  })
})
