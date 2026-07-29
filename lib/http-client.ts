export async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: unknown }
  if (response.ok) return payload
  throw new Error(typeof payload.error === "string" ? payload.error : fallbackMessage)
}
