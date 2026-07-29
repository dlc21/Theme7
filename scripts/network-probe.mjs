import net from "node:net"

export function portAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

export async function fetchOk(url, timeoutMs = 1_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" })
    return response.ok
  } catch {
    return false
  }
}
