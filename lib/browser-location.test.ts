import { describe, expect, it } from "vitest"

import { isBrowserUrl, normalizeBrowserUrl } from "@/lib/browser-location"

describe("Browser locations", () => {
  it("accepts explicit HTTP and HTTPS URLs without fetching them", () => {
    expect(isBrowserUrl(" http://127.0.0.1:3000 ")).toBe(true)
    expect(normalizeBrowserUrl("http://192.0.2.20:8080/app")).toBe("http://192.0.2.20:8080/app")
    expect(normalizeBrowserUrl("https://example.com")).toBe("https://example.com/")
  })

  it("rejects non-web schemes, incomplete URLs, and embedded credentials", () => {
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow(/HTTP or HTTPS/)
    expect(() => normalizeBrowserUrl("127.0.0.1:3000")).toThrow(/beginning with/)
    const credentialed = ["http://name:", "secret@127.0.0.1:3000"].join("")
    expect(() => normalizeBrowserUrl(credentialed)).toThrow(/credentials/)
  })
})
