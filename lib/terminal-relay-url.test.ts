import { describe, expect, it } from "vitest"
import { terminalRelayUrl } from "./terminal-relay-url"

describe("terminalRelayUrl", () => {
  it("uses wss and location.host in HTTPS (same-origin HTTPS)", () => {
    const loc = {
      protocol: "https:",
      host: "theme7.example.invalid:8447",
      hostname: "theme7.example.invalid",
    }
    const ticket = "my-ticket-abc-123"
    const url = terminalRelayUrl(loc, ticket, 4401)
    expect(url).toBe("wss://theme7.example.invalid:8447/terminal?ticket=my-ticket-abc-123")
  })

  it("uses ws and terminalPort in HTTP (non-adjacent HTTP ports)", () => {
    const loc = {
      protocol: "http:",
      host: "localhost:44003",
      hostname: "localhost",
    }
    const ticket = "my-ticket"
    const url = terminalRelayUrl(loc, ticket, 44001)
    expect(url).toBe("ws://localhost:44001/terminal?ticket=my-ticket")
  })

  it("encodes the ticket parameter correctly", () => {
    const loc = {
      protocol: "https:",
      host: "theme7.example.invalid",
      hostname: "theme7.example.invalid",
    }
    const ticket = "ticket+with/special=chars"
    const url = terminalRelayUrl(loc, ticket, 4401)
    expect(url).toBe("wss://theme7.example.invalid/terminal?ticket=ticket%2Bwith%2Fspecial%3Dchars")
  })
})
