export function normalizeRuntimeTarget(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Runtime target must be an HTTP or HTTPS origin.")

  let target
  try {
    target = new URL(value)
  } catch {
    throw new Error("Runtime target must be an HTTP or HTTPS origin.")
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Runtime target must use HTTP or HTTPS.")
  if (target.username || target.password) throw new Error("Runtime target must not contain credentials.")
  if (target.pathname !== "/") throw new Error("Runtime target must use the root path.")
  if (target.search) throw new Error("Runtime target must not contain a query string.")
  if (target.hash) throw new Error("Runtime target must not contain a fragment.")

  return target.origin
}

export function evaluateRuntimeTarget({ reportedTarget, attemptedTarget, phase }) {
  const reported = normalizeRuntimeTarget(reportedTarget)
  const attempted = normalizeRuntimeTarget(attemptedTarget)
  if (phase !== "deploy" && phase !== "verify") throw new Error("Runtime target phase must be deploy or verify.")
  return reported === attempted
    ? []
    : [`Runtime target mismatch: reported ${reported}, ${phase} attempted ${attempted}.`]
}

export function evaluateRuntimeTargetState(state) {
  if (state == null) return []

  let reported
  try {
    reported = normalizeRuntimeTarget(state.reportedTarget)
  } catch (error) {
    return [`Runtime target state is invalid: ${error.message}`]
  }

  if (state.schemaVersion !== 1) return ["Runtime target state must use schemaVersion 1."]
  if (state.status !== "verified") return [`Runtime target ${reported} is bound but not verified.`]

  let verified
  try {
    verified = normalizeRuntimeTarget(state.verifiedTarget)
  } catch (error) {
    return [`Runtime target state is invalid: ${error.message}`]
  }
  return verified === reported
    ? []
    : [`Runtime target state mismatch: reported ${reported}, verified ${verified}.`]
}
