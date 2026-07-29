import { detectHarnesses } from "./harness-adapters.mjs"
import { configuredValue } from "./runtime-config-core.mjs"

const harnesses = await detectHarnesses()
const providerIds = configuredValue("DISTRIBUTION") === "theme-7" ? ["omp", "shell"] : ["codex", "shell"]
const shell = harnesses.find((item) => item.id === "shell")
if (!shell || shell.state !== "available") throw new Error(`Native Shell is not available: ${JSON.stringify(shell)}`)
for (const item of providerIds.map((id) => harnesses.find((candidate) => candidate.id === id)).filter(Boolean)) {
  const safe = { id: item.id, state: item.state, version: item.version }
  process.stdout.write(`${JSON.stringify(safe)}\n`)
}
