import http from "node:http"
import { describe, expect, it } from "vitest"
import { fetchOk, portAvailable } from "./network-probe.mjs"

describe("network probes", () => {
  it("detects listeners and HTTP status", async () => {
    const server = http.createServer((_request, response) => { response.statusCode = 204; response.end() })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    expect(await portAvailable(port)).toBe(false)
    expect(await fetchOk(`http://127.0.0.1:${port}`, 500)).toBe(true)
    await new Promise((resolve) => server.close(resolve))
    expect(await portAvailable(port)).toBe(true)
  })
})
