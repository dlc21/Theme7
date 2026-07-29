const MAX_BROWSER_LOCATION = 2_048

export function isBrowserUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function normalizeBrowserUrl(value: string): string {
  const input = value.trim()
  if (!input || input.length > MAX_BROWSER_LOCATION) throw new Error("Enter a valid HTTP or HTTPS URL.")
  let url: URL
  try { url = new URL(input) } catch { throw new Error("Enter a complete URL beginning with http:// or https://.") }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser URLs must use HTTP or HTTPS.")
  if (url.username || url.password) throw new Error("Browser URLs cannot contain credentials.")
  return url.href
}
