export function isLoopbackControlRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const host = forwarded || request.headers.get("host") || ""
  let hostname = ""
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase() } catch { return false }
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1"
}

export function terminalControlToken(request: Request): string {
  return request.headers.get("x-operator-engine-control-token") ?? ""
}
