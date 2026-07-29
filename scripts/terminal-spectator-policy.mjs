const SPECTATOR_ALLOWED_OUTBOUND = new Set(["output", "started", "exit", "error", "missing"])
const GENERIC_SPECTATOR_ERROR_MESSAGE = "Terminal error."

export function isSpectatorAudience(audience) {
  return audience === "spectator"
}

export function isAllowedOutboundFrame(audience, kind) {
  if (isSpectatorAudience(audience)) {
    return SPECTATOR_ALLOWED_OUTBOUND.has(kind)
  }
  return true
}

export function sanitizeOutboundMessage(audience, message) {
  if (!message || typeof message !== "object") return message
  if (isSpectatorAudience(audience)) {
    if (!SPECTATOR_ALLOWED_OUTBOUND.has(message.kind)) {
      return null
    }
    if (message.kind === "error") {
      return {
        ...message,
        message: GENERIC_SPECTATOR_ERROR_MESSAGE,
      }
    }
  }
  return message
}

export function handleInboundFrame(firstArg, secondArg, thirdArg) {
  let audience
  let raw
  let onInput
  let onResize

  if (typeof firstArg === "object" && firstArg !== null && ("audience" in firstArg || "raw" in firstArg)) {
    audience = firstArg.audience
    raw = firstArg.raw
    onInput = firstArg.onInput ?? secondArg?.onInput
    onResize = firstArg.onResize ?? secondArg?.onResize
  } else {
    audience = firstArg
    raw = secondArg
    const callbacks = thirdArg ?? {}
    onInput = callbacks.onInput
    onResize = callbacks.onResize
  }

  if (isSpectatorAudience(audience)) {
    return { ok: false, blocked: true, reason: "Spectator inbound frames strictly disabled." }
  }

  let message
  try {
    message = JSON.parse(String(raw ?? ""))
  } catch {
    return { ok: false, blocked: false, error: "Invalid terminal frame." }
  }

  if (!message || typeof message !== "object") {
    return { ok: false, blocked: false, error: "Invalid terminal frame." }
  }

  if (message.kind === "input" && typeof message.data === "string" && message.data.length <= 16_384) {
    if (typeof onInput === "function") {
      onInput(message.data)
    }
    return { ok: true, kind: "input", data: message.data }
  }

  if (message.kind === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
    const cols = Math.min(400, Math.max(40, message.cols))
    const rows = Math.min(150, Math.max(10, message.rows))
    if (typeof onResize === "function") {
      onResize(cols, rows)
    }
    return { ok: true, kind: "resize", cols, rows }
  }

  return { ok: false, blocked: false, error: "Invalid terminal frame." }
}
