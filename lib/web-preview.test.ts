import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { encodeWebPreviewRoot, fingerprintWebPreviewRoot, normalizeWebPreviewEntry, previewResponseHeaders, resolveWebPreviewAsset, validateWebPreviewEntry } from "@/lib/web-preview"

const temporary: string[] = []

async function lane(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-preview-"))
  temporary.push(directory)
  await fs.mkdir(path.join(directory, "demo", "images"), { recursive: true })
  await fs.writeFile(path.join(directory, "demo", "index.html"), "<!doctype html><link rel=stylesheet href=style.css><script src=app.js></script>")
  await fs.writeFile(path.join(directory, "demo", "style.css"), "body { color: green }")
  await fs.writeFile(path.join(directory, "demo", "app.js"), "document.body.dataset.ready = 'yes'")
  await fs.writeFile(path.join(directory, "demo", "data.json"), "{}")
  await fs.writeFile(path.join(directory, "demo", "images", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return directory
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("Web Preview filesystem boundary", () => {
  it("validates an HTML entry and serves supported relative assets", async () => {
    const root = await lane()
    const entry = await validateWebPreviewEntry(root, "demo/index.html")
    expect(entry).toMatchObject({ entryPath: "demo/index.html", entryFile: "index.html" })
    const asset = await resolveWebPreviewAsset(root, entry.encodedRoot, "images/pixel.png")
    expect(asset.contentType).toBe("image/png")
  })

  it.each(["../index.html", "/index.html", "C:/index.html", ".hidden/index.html", "demo/.env", "demo/app.js"])("rejects unsupported entry %s", (entry) => {
    expect(() => normalizeWebPreviewEntry(entry)).toThrow()
  })

  it("rejects traversal, hidden files, credentials, unsupported types, and symlinks", async () => {
    const root = await lane()
    await fs.writeFile(path.join(root, "demo", ".secret.js"), "no")
    await fs.writeFile(path.join(root, "demo", "credentials.json"), "{}")
    await fs.writeFile(path.join(root, "demo", "notes.txt"), "no")
    const encoded = encodeWebPreviewRoot("demo")
    await expect(resolveWebPreviewAsset(root, encoded, "../index.html")).rejects.toThrow()
    await expect(resolveWebPreviewAsset(root, encoded, ".secret.js")).rejects.toThrow("Hidden")
    await expect(resolveWebPreviewAsset(root, encoded, "credentials.json")).rejects.toThrow("Credential")
    await expect(resolveWebPreviewAsset(root, encoded, "notes.txt")).rejects.toThrow("file type")

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-preview-outside-"))
    temporary.push(outside)
    await fs.writeFile(path.join(outside, "outside.js"), "no")
    await fs.symlink(outside, path.join(root, "demo", "linked"), process.platform === "win32" ? "junction" : "dir")
    await expect(resolveWebPreviewAsset(root, encoded, "linked/outside.js")).rejects.toThrow("Symbolic")
  })

  it("returns a restrictive no-store policy for HTML", () => {
    const headers = previewResponseHeaders("text/html; charset=utf-8")
    expect(headers.get("cache-control")).toContain("no-store")
    expect(headers.get("content-security-policy")).toContain("connect-src 'none'")
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
    expect(headers.get("permissions-policy")).toContain("camera=()")
  })

  it("fingerprints supported files beneath the selected entry root", async () => {
    const root = await lane()
    const before = await fingerprintWebPreviewRoot(root, "demo/index.html")
    await fs.writeFile(path.join(root, "demo", "style.css"), "body { color: rebeccapurple; padding: 1rem }")
    const after = await fingerprintWebPreviewRoot(root, "demo/index.html")
    expect(after).not.toBe(before)

    await fs.writeFile(path.join(root, "demo", ".ignored"), "not previewable")
    await fs.mkdir(path.join(root, "demo", "node_modules"))
    await fs.writeFile(path.join(root, "demo", "node_modules", "ignored.js"), "not a preview asset")
    expect(await fingerprintWebPreviewRoot(root, "demo/index.html")).toBe(after)
  })
})
