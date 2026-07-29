const KEYS = ["architecture", "builtAt", "checks", "contentSha256", "distribution", "node", "platform", "schemaVersion", "sourceCommit", "theme7Sha256"]
const COMMIT = /^[a-f0-9]{7,64}$/i
const HASH = /^[a-f0-9]{64}$/i

export function validateArtifactManifest(value, { packaged } = { packaged: true }) {
  const valid = value && typeof value === "object"
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(KEYS)
    && value.schemaVersion === 1
    && COMMIT.test(value.sourceCommit)
    && (value.distribution === "stock" || value.distribution === "theme-7")
    && (packaged ? HASH.test(value.contentSha256) : value.contentSha256 === "" || HASH.test(value.contentSha256))
    && (value.theme7Sha256 === null || HASH.test(value.theme7Sha256))
    && typeof value.builtAt === "string"
    && typeof value.platform === "string"
    && typeof value.architecture === "string"
    && typeof value.node === "string"
    && value.checks && typeof value.checks === "object" && !Array.isArray(value.checks)
  if (!valid) throw new Error("Invalid standalone artifact.json.")
  return value
}

export function createArtifactManifest(input) {
  const value = Object.fromEntries(KEYS.map((key) => [key, input[key]]))
  return validateArtifactManifest(value, { packaged: false })
}
