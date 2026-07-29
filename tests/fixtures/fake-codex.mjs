const args = process.argv.slice(2)
if (args[0] === "--version") {
  process.stdout.write("codex-fixture 1.0.0\n")
  process.exit(0)
}
process.stdout.write(`${JSON.stringify(args)}\n`)
