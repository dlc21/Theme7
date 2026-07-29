import { randomBytes } from "node:crypto"

import { parseEnvFile } from "./state-io.mjs"

const TERMINAL_SECRET_KEY = "OPERATOR_ENGINE_TERMINAL_SECRET"
const ACCESS_MODE_KEY = "OPERATOR_ENGINE_ACCESS_MODE"
const ACCESS_PASSWORD_KEY = "OPERATOR_ENGINE_ACCESS_PASSWORD"
const ACCESS_SESSION_SECRET_KEY = "OPERATOR_ENGINE_ACCESS_SESSION_SECRET"

export function assertTerminalSecret(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length < 32 || /[\r\n]/.test(value)) {
    throw new Error(`${TERMINAL_SECRET_KEY} must contain at least 32 non-whitespace characters.`)
  }
  return value
}

export function assertAccessPassword(value) {
  if (typeof value !== "string" || value.length < 24) {
    throw new Error(`${ACCESS_PASSWORD_KEY} must be at least 24 characters.`)
  }
  return value
}

export function assertAccessSessionSecret(value) {
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`${ACCESS_SESSION_SECRET_KEY} must be at least 32 characters.`)
  }
  return value
}

export function generatedTerminalSecret() {
  return randomBytes(32).toString("base64url")
}

export function generatedAccessPassword() {
  return randomBytes(24).toString("base64url")
}

export function generatedAccessSessionSecret() {
  return randomBytes(32).toString("base64url")
}

export function terminalSecretFromEnv(source) {
  const parsed = parseEnvFile(source)
  const value = parsed[TERMINAL_SECRET_KEY]
  return value === undefined ? null : assertTerminalSecret(value)
}

export function appendTerminalSecret(source, secret) {
  assertTerminalSecret(secret)
  const normalized = source.replaceAll("\r\n", "\n")
  if (terminalSecretFromEnv(normalized) !== null) throw new Error(`${TERMINAL_SECRET_KEY} is already configured.`)
  return `${normalized}${normalized && !normalized.endsWith("\n") ? "\n" : ""}${TERMINAL_SECRET_KEY}=${secret}\n`
}

export function renderComposeEnvironment(terminalSecret, accessPassword, accessSessionSecret) {
  return [
    `${TERMINAL_SECRET_KEY}=${assertTerminalSecret(terminalSecret)}`,
    `${ACCESS_MODE_KEY}=password`,
    `${ACCESS_PASSWORD_KEY}=${assertAccessPassword(accessPassword)}`,
    `${ACCESS_SESSION_SECRET_KEY}=${assertAccessSessionSecret(accessSessionSecret)}`,
    "",
  ].join("\n")
}
