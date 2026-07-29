export function terminalRelayUrl(
  location: { protocol: string; host: string; hostname: string },
  ticket: string,
  terminalPort: number
): string {
  const isHttps = location.protocol === "https:"
  const scheme = isHttps ? "wss:" : "ws:"
  const hostPart = isHttps ? location.host : `${location.hostname}:${terminalPort}`
  return `${scheme}//${hostPart}/terminal?ticket=${encodeURIComponent(ticket)}`
}
