import { spawnSync } from "node:child_process"

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run this gate through `npm run validate:local`.")
const steps = [
  ["commit identity", ["run", "check:commit-identity"]],
  ["worktree policy", ["run", "check:worktrees"]],
  ["runtime target", ["run", "check:runtime-target"]],
  ["production dependency audit", ["audit", "--omit=dev"]],
  ["recipe validation", ["run", "check:recipes"]],
  ["release surface", ["run", "check:release-surface"]],
  ["stock brand boundary", ["run", "check:public-surface"]],
  ["build surfaces", ["run", "check:build-surface"]],
  ["runtime files", ["run", "check:runtime-files"]],
  ["source package", ["run", "check:source-package"]],
  ["adapter detection", ["run", "check:adapters"]],
  ["native Shell PTY", ["run", "check:shell"]],
  ["terminal lifecycle", ["run", "check:lifecycle"]],
  ["TypeScript", ["run", "typecheck"]],
  ["unit tests", ["test"]],
  ["production build", ["run", "build"]],
]

for (const [label, args] of steps) {
  process.stdout.write(`\n== ${label} ==\n`)
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

process.stdout.write("\nLocal validation passed.\n")
