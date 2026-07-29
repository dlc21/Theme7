import fs from "node:fs"

export default function ompTheme7Identity(pi) {
  const identityFile = process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE?.trim()
  const nonce = process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE?.trim()
  if (!identityFile || !nonce || nonce.length > 256) return

  let reportedSessionId = null
  const report = (_event, context) => {
    const sessionId = context.sessionManager.getSessionId()
    if (!sessionId || sessionId === reportedSessionId) return
    const sessionFile = context.sessionManager.getSessionFile()
    fs.appendFileSync(identityFile, `${JSON.stringify({
      version: 1,
      nonce,
      sessionId,
      cwd: context.cwd,
      ...(sessionFile ? { sessionFile } : {}),
    })}\n`, "utf8")
    reportedSessionId = sessionId
  }

  pi.on("session_start", report)
  pi.on("session_switch", report)
  pi.on("session_branch", report)
}
