import { accessConfig } from "../scripts/runtime-config-core.mjs"

export const THEME7_ACCESS_COOKIE = "theme7_access"
export const THEME7_SPECTATOR_COOKIE = "theme7_spectator"
export const THEME7_ACCESS_SESSION_TTL_SECONDS = 43_200

async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyData = encoder.encode(secret)
  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}


export async function signAccessSession(now?: number): Promise<string> {
  const config = accessConfig()
  if (config.mode !== "password") {
    throw new Error("Access mode is not password")
  }
  const currentUnix = Math.floor((now ?? Date.now()) / 1000)
  const exp = currentUnix + THEME7_ACCESS_SESSION_TTL_SECONDS
  const payload = { v: 1, exp }
  const payloadStr = JSON.stringify(payload)
  const encodedPayload = Buffer.from(payloadStr).toString("base64url")

  const key = await getCryptoKey(config.sessionSecret)
  const encoder = new TextEncoder()
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodedPayload)
  )
  const signature = Buffer.from(signatureBytes).toString("base64url")
  return `${encodedPayload}.${signature}`
}

export async function signSpectatorSession(now?: number): Promise<string> {
  const config = accessConfig()
  if (config.mode !== "password") {
    throw new Error("Access mode is not password")
  }
  const currentUnix = Math.floor((now ?? Date.now()) / 1000)
  const exp = currentUnix + THEME7_ACCESS_SESSION_TTL_SECONDS
  const payload = { v: 1, spectator: true, exp }
  const payloadStr = JSON.stringify(payload)
  const encodedPayload = Buffer.from(payloadStr).toString("base64url")

  const key = await getCryptoKey(config.sessionSecret)
  const encoder = new TextEncoder()
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodedPayload)
  )
  const signature = Buffer.from(signatureBytes).toString("base64url")
  return `${encodedPayload}.${signature}`
}

export async function verifySpectatorSession(value: string | undefined | null, now?: number): Promise<boolean> {
  if (!value) return false
  const parts = value.split(".")
  if (parts.length !== 2) return false
  const [encodedPayload, signature] = parts
  if (!encodedPayload || !signature) return false

  const config = accessConfig()
  if (config.mode !== "password") {
    return false
  }

  try {
    const key = await getCryptoKey(config.sessionSecret)
    const encoder = new TextEncoder()
    const data = encoder.encode(encodedPayload)
    const sigBytes = new Uint8Array(Buffer.from(signature, "base64url")) as BufferSource
    
    const isValidSignature = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      data
    )
    if (!isValidSignature) return false

    const payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf8")
    const payload = JSON.parse(payloadJson)
    
    if (payload.v !== 1) return false
    if (!payload.spectator) return false
    if (typeof payload.exp !== "number") return false
    
    const currentUnix = Math.floor((now ?? Date.now()) / 1000)
    if (payload.exp <= currentUnix) {
      return false
    }
    
    return true
  } catch {
    return false
  }
}
export async function verifyAccessSession(value: string | undefined | null, now?: number): Promise<boolean> {
  if (!value) return false
  const parts = value.split(".")
  if (parts.length !== 2) return false
  const [encodedPayload, signature] = parts
  if (!encodedPayload || !signature) return false

  const config = accessConfig()
  if (config.mode !== "password") {
    return false
  }

  try {
    const key = await getCryptoKey(config.sessionSecret)
    const encoder = new TextEncoder()
    const data = encoder.encode(encodedPayload)
    const sigBytes = new Uint8Array(Buffer.from(signature, "base64url")) as BufferSource
    
    const isValidSignature = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      data
    )
    if (!isValidSignature) return false

    const payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf8")
    const payload = JSON.parse(payloadJson)
    
    const keys = Object.keys(payload)
    if (keys.length !== 2) return false
    if (payload.v !== 1) return false
    if (typeof payload.exp !== "number") return false
    
    const currentUnix = Math.floor((now ?? Date.now()) / 1000)
    if (payload.exp <= currentUnix) {
      return false
    }
    
    return true
  } catch {
    return false
  }
}
