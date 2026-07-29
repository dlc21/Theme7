import { execSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import net from "node:net"
import { fileURLToPath } from "node:url"

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

function dockerCmd(args, stdio = "pipe") {
  const result = execSync(`docker ${args.join(" ")}`, { encoding: "utf8", stdio, windowsHide: true })
  return result ? result.trim() : ""
}

async function waitForHealthy(containerId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const inspect = JSON.parse(dockerCmd(["inspect", containerId]))[0]
      if (inspect.State.Running && inspect.State.Health?.Status === "healthy") {
        return
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Container ${containerId} did not become healthy within ${timeoutMs}ms.`)
}

async function fetchStatus(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) })
    return { status: res.status, ok: res.ok, body: res.status === 200 ? await res.json() : null, headers: res.headers }
  } catch (err) {
    return { status: 0, ok: false, body: null, error: err.message }
  }
}

// Inline the manifest helper script text to mount inside helper containers
const manifestHelperCode = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rootDir = '/data';
const paths = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replaceAll('\\\\', '/');
    paths.push(relPath);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(fullPath);
    }
  }
}

try {
  walk(rootDir);
  paths.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('THEME7-MANIFEST-1\\0', 'utf8'));
  
  let dirCount = 0;
  let fileCount = 0;
  let symlinkCount = 0;
  let totalFileBytes = 0n;
  
  for (const p of paths) {
    const fullPath = path.join(rootDir, p);
    const stat = fs.lstatSync(fullPath);
    let type = 0;
    let data = Buffer.alloc(0);
    
    if (stat.isDirectory()) {
      type = 1;
      dirCount++;
    } else if (stat.isFile()) {
      type = 2;
      fileCount++;
      data = fs.readFileSync(fullPath);
      totalFileBytes += BigInt(data.length);
    } else if (stat.isSymbolicLink()) {
      type = 3;
      symlinkCount++;
      data = Buffer.from(fs.readlinkSync(fullPath), 'utf8');
    } else {
      // Skip/reject devices, FIFOs, and sockets
      continue;
    }
    
    const pathBuf = Buffer.from(p, 'utf8');
    const header = Buffer.alloc(1 + 4 + pathBuf.length + 4 + 4 + 4 + 8);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(pathBuf.length, 1);
    pathBuf.copy(header, 5);
    header.writeUInt32BE(stat.mode, 5 + pathBuf.length);
    header.writeUInt32BE(stat.uid, 5 + pathBuf.length + 4);
    header.writeUInt32BE(stat.gid, 5 + pathBuf.length + 8);
    header.writeBigUInt64BE(BigInt(data.length), 5 + pathBuf.length + 12);
    
    hash.update(header);
    if (data.length > 0) {
      hash.update(data);
    }
  }
  
  console.log(JSON.stringify({
    digest: hash.digest('hex'),
    dirCount,
    fileCount,
    symlinkCount,
    totalFileBytes: totalFileBytes.toString()
  }));
} catch (err) {
  console.error(err);
  process.exit(1);
}
`

function runManifestHelper(volumeName, imageName, suffix) {
  const helperHostPath = path.join(os.tmpdir(), `manifest-helper-${suffix}.js`)
  fs.writeFileSync(helperHostPath, manifestHelperCode)
  try {
    const res = dockerCmd([
      "run", "--rm",
      "-v", `"${helperHostPath}:/manifest-helper.js:ro"`,
      "-v", `"${volumeName}:/data:ro"`,
      "--network=none",
      imageName,
      "node", "/manifest-helper.js"
    ])
    return JSON.parse(res)
  } finally {
    fs.rmSync(helperHostPath, { force: true })
  }
}

function encryptVolume(volumeName, imageName, key, iv, outputPath) {
  return new Promise((resolve, reject) => {
    const dockerProc = spawn("docker", [
      "run", "--rm", "-i",
      "-v", `${volumeName}:/data:ro`,
      "--network=none",
      imageName,
      "tar", "-C", "/data", "-cf", "-", "."
    ], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true })
    
    const writeStream = fs.createWriteStream(outputPath)
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(Buffer.concat([Buffer.from("THEME7-RECOVERY-1\n", "ascii"), iv]))
    
    writeStream.write(Buffer.from("THEME7-RECOVERY-1\n", "ascii"))
    writeStream.write(iv)
    
    dockerProc.stdout.pipe(cipher)
    
    cipher.on("data", (chunk) => {
      writeStream.write(chunk)
    })
    
    cipher.on("end", () => {
      const tag = cipher.getAuthTag()
      writeStream.write(tag)
      writeStream.end()
    })
    
    writeStream.on("finish", () => {
      if (dockerProc.exitCode !== null && dockerProc.exitCode !== 0) {
        reject(new Error(`Docker tar stream failed with code ${dockerProc.exitCode}`))
      } else {
        dockerProc.on("exit", (code) => {
          if (code !== 0) reject(new Error(`Docker tar stream exited with ${code}`))
          else resolve()
        })
        if (dockerProc.exitCode === 0) resolve()
      }
    })
    
    dockerProc.on("error", reject)
    cipher.on("error", reject)
    writeStream.on("error", reject)
  })
}

function decryptVolume(volumeName, imageName, key, encryptedPath) {
  return new Promise((resolve, reject) => {
    const fileBuf = fs.readFileSync(encryptedPath)
    const magic = fileBuf.subarray(0, 18)
    if (magic.toString("ascii") !== "THEME7-RECOVERY-1\n") {
      reject(new Error("Invalid archive magic."))
      return
    }
    const iv = fileBuf.subarray(18, 30)
    const tag = fileBuf.subarray(fileBuf.length - 16)
    const ciphertext = fileBuf.subarray(30, fileBuf.length - 16)
    
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAAD(Buffer.concat([Buffer.from("THEME7-RECOVERY-1\n", "ascii"), iv]))
    decipher.setAuthTag(tag)
    
    let plaintext
    try {
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ])
    } catch (err) {
      reject(new Error(`GCM Auth failed: ${err.message}`))
      return
    }
    
    const dockerProc = spawn("docker", [
      "run", "--rm", "-i",
      "-v", `${volumeName}:/data`,
      "--network=none",
      imageName,
      "tar", "-C", "/data", "-xf", "-"
    ], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true })
    
    dockerProc.stdin.write(plaintext)
    dockerProc.stdin.end()
    
    dockerProc.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Docker tar extract failed with code ${code}`))
      else resolve()
    })
    dockerProc.on("error", reject)
  })
}

function cleanupTemporaryObjects(data) {
  if (data.restoreContainer) {
    try { dockerCmd(["rm", "-f", data.restoreContainer]) } catch {}
  }
  if (data.corruptContainer) {
    try { dockerCmd(["rm", "-f", data.corruptContainer]) } catch {}
  }
  if (data.tempVolume) {
    try { dockerCmd(["volume", "rm", "-f", data.tempVolume]) } catch {}
  }
  if (data.corruptVolume) {
    try { dockerCmd(["volume", "rm", "-f", data.corruptVolume]) } catch {}
  }
  if (data.encryptedArchiveFile) {
    try { fs.rmSync(data.encryptedArchiveFile, { force: true }) } catch {}
  }
  if (data.corruptArchiveFile) {
    try { fs.rmSync(data.corruptArchiveFile, { force: true }) } catch {}
  }
}

function writeFailedInterruptedReceipt(data, reason) {
  const now = new Date()
  const timestamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"
  const receiptDir = path.join(process.cwd(), ".operator-engine", "recovery-proofs")
  fs.mkdirSync(receiptDir, { recursive: true })
  
  const receipt = {
    schemaVersion: "theme7-recovery-proof.v1",
    status: "failed",
    timestamps: {
      startedAt: data.startedAt || now.toISOString(),
      endedAt: now.toISOString()
    },
    phase: data.phase || "unknown",
    failureReason: reason,
    evidence: {
      sourceManifest: null,
      restoredManifest: null,
      encryptedArchive: null,
      sourceIdentity: null,
      restoredIdentity: null
    },
    assertions: {
      sourceHealthy: "failed",
      encryptedCapture: "not-attempted",
      corruptCopyRejected: "not-attempted",
      restoreIdentical: "not-attempted",
      restoreHealthy: "not-attempted"
    }
  }
  fs.writeFileSync(path.join(receiptDir, `${timestamp}.json`), JSON.stringify(receipt, null, 2))
}

export async function runRecoveryProof(args = process.argv.slice(2)) {
  const containerFlagIndex = args.indexOf("--container")
  if (containerFlagIndex === -1 || !args[containerFlagIndex + 1]) {
    throw new Error("Usage: prove-recovery --container theme7-theme7-1")
  }
  const targetContainerName = args[containerFlagIndex + 1]
  if (targetContainerName !== "theme7-theme7-1") {
    throw new Error("Only container theme7-theme7-1 is accepted by this script.")
  }

  const activeFilePath = path.join(process.cwd(), ".operator-engine", "recovery-active.json")
  
  // 1. Recover existing state if active
  if (fs.existsSync(activeFilePath)) {
    const activeData = JSON.parse(fs.readFileSync(activeFilePath, "utf8"))
    const sourceId = activeData.sourceContainerId
    
    let inspect
    try {
      inspect = JSON.parse(dockerCmd(["inspect", sourceId]))[0]
    } catch (err) {
      throw new Error(`Failed to inspect recorded source container ${sourceId}: ${err.message}`)
    }
    
    const isRunning = inspect.State.Running
    const isHealthy = inspect.State.Health?.Status === "healthy"
    
    if (!isRunning) {
      dockerCmd(["compose", "-p", "theme7", "start", "theme7"])
      await waitForHealthy(sourceId)
    } else if (!isHealthy) {
      await waitForHealthy(sourceId)
    }
    
    cleanupTemporaryObjects(activeData)
    writeFailedInterruptedReceipt(activeData, "Drill was interrupted or recovered from a crash.")
    fs.rmSync(activeFilePath, { force: true })
  }

  // 2. Start a new drill
  let sourceInspect
  try {
    sourceInspect = JSON.parse(dockerCmd(["inspect", targetContainerName]))[0]
  } catch (err) {
    throw new Error(`Target container ${targetContainerName} is not running or found.`)
  }

  if (!sourceInspect.State.Running || sourceInspect.State.Health?.Status !== "healthy") {
    throw new Error("Source container must be running and healthy to start a drill.")
  }

  const sourceImageId = sourceInspect.Image
  const sourceContainerId = sourceInspect.Id
  const mount = sourceInspect.Mounts.find(m => m.Destination === "/data")
  if (!mount) throw new Error("Could not resolve /data volume in source container.")
  const sourceVolume = mount.Name

  // Resolve web host and port to checkCapabilities
  const portConfig = sourceInspect.NetworkSettings.Ports["4400/tcp"]
  if (!portConfig || !portConfig[0]) throw new Error("Could not resolve source container ports.")
  const sourceWebPort = portConfig[0].HostPort

  // Log in to source to checkCapabilities and count lanes
  const envText = fs.readFileSync(".env.compose", "utf8")
  const envConfig = {}
  for (const line of envText.split("\n")) {
    const match = line.trim().match(/^([^=]+)=(.*)$/)
    if (match) envConfig[match[1]] = match[2]
  }
  const password = envConfig["OPERATOR_ENGINE_ACCESS_PASSWORD"]
  if (!password) throw new Error("Could not find access password in .env.compose.")

  const loginRes = await fetchStatus(`http://127.0.0.1:${sourceWebPort}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  })
  if (loginRes.status !== 204) {
    throw new Error(`Failed to authenticate with source container: got status ${loginRes.status}`)
  }
  const setCookie = loginRes.headers?.get("Set-Cookie") || ""
  const cookieMatch = setCookie.match(/theme7_access=([^;]+)/)
  if (!cookieMatch) throw new Error("Could not retrieve access session cookie.")
  const authCookie = cookieMatch[0]

  // Verify capabilities and distribution theme-7
  const capRes = await fetchStatus(`http://127.0.0.1:${sourceWebPort}/api/runtime-capabilities`, {
    headers: { "Cookie": authCookie }
  })
  if (!capRes.ok || capRes.body?.distributionId !== "theme-7") {
    throw new Error("Source container runtime distribution is not theme-7.")
  }

  // Capture lane count
  const lanesRes = await fetchStatus(`http://127.0.0.1:${sourceWebPort}/api/lanes`, {
    headers: { "Cookie": authCookie }
  })
  if (!lanesRes.ok) throw new Error("Failed to retrieve source lanes.")
  const sourceLaneCount = lanesRes.body.length

  // Allocate random loopback ports
  const restoreWebPort = await freePort()
  const restoreRelayPort = await freePort()

  const suffix = crypto.randomBytes(8).toString("hex")
  const activeData = {
    schemaVersion: "theme7-recovery-active.v1",
    sourceContainerId,
    sourceImageId,
    sourceVolume,
    suffix,
    tempVolume: `theme7-restore-temp-${suffix}`,
    corruptVolume: `theme7-corrupt-temp-${suffix}`,
    restoreContainer: `theme7-restore-temp-${suffix}`,
    corruptContainer: `theme7-corrupt-temp-${suffix}`,
    encryptedArchiveFile: path.join(os.tmpdir(), `theme7-recovery-${suffix}.tar.aesgcm`),
    corruptArchiveFile: path.join(os.tmpdir(), `theme7-recovery-corrupt-${suffix}.tar.aesgcm`),
    phase: "started",
    startedAt: new Date().toISOString()
  }

  // Atomically write state file
  fs.mkdirSync(path.dirname(activeFilePath), { recursive: true })
  fs.writeFileSync(activeFilePath, JSON.stringify(activeData, null, 2))

  const key = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  let sourceManifest = null
  let restoredManifest = null
  let encryptedArchiveSha = ""
  let restoredImageId = ""

  let assertions = {
    sourceHealthy: "passed",
    encryptedCapture: "failed",
    corruptCopyRejected: "failed",
    restoreIdentical: "failed",
    restoreHealthy: "failed"
  }

  try {
    // 3. Stop compose service
    dockerCmd(["compose", "-p", "theme7", "stop", "theme7"])
    activeData.phase = "stopped"
    fs.writeFileSync(activeFilePath, JSON.stringify(activeData, null, 2))

    // 4. Generate manifest from stopped volume
    sourceManifest = runManifestHelper(sourceVolume, sourceImageId, suffix)

    // 5. Encrypt volume into file
    await encryptVolume(sourceVolume, sourceImageId, key, iv, activeData.encryptedArchiveFile)
    const fileBytes = fs.readFileSync(activeData.encryptedArchiveFile)
    encryptedArchiveSha = crypto.createHash("sha256").update(fileBytes).digest("hex")
    assertions.encryptedCapture = "passed"

    // 6. Start source container again in finally (so it is running while we restore)
    // Wait, the plan says: "In finally, start the source Compose service and require its original container ID healthy before restore"
    // So we do this inside the block, or we let the finally run first?
    // "In finally, start the source Compose service and require its original container ID healthy before restore; zero the key buffer after all decryptions."
    // Ah, this means: in the finally block of the BACKUP step, we start the source Compose service.
    // Let's explicitly do this: start the source Compose service right now, and verify it's healthy, before proceeding to the RESTORE steps!
    // Yes! Let's start the source compose service:
    dockerCmd(["compose", "-p", "theme7", "start", "theme7"])
    await waitForHealthy(sourceContainerId)

    // 7. Decrypt corrupt copy test
    const corruptBuf = Buffer.from(fileBytes)
    corruptBuf[30] ^= 0xff
    fs.writeFileSync(activeData.corruptArchiveFile, corruptBuf)

    dockerCmd(["volume", "create", activeData.corruptVolume])
    let corruptFailed = false
    try {
      await decryptVolume(activeData.corruptVolume, sourceImageId, key, activeData.corruptArchiveFile)
    } catch {
      corruptFailed = true
    }
    if (!corruptFailed) {
      throw new Error("GCM authentication succeeded on corrupted copy but expected failure.")
    }
    assertions.corruptCopyRejected = "passed"

    // 8. Decrypt into temp volume
    dockerCmd(["volume", "create", activeData.tempVolume])
    await decryptVolume(activeData.tempVolume, sourceImageId, key, activeData.encryptedArchiveFile)
    
    restoredManifest = runManifestHelper(activeData.tempVolume, sourceImageId, suffix)
    if (restoredManifest.digest !== sourceManifest.digest) {
      throw new Error("Restored manifest digest mismatch.")
    }
    if (restoredManifest.fileCount !== sourceManifest.fileCount || restoredManifest.dirCount !== sourceManifest.dirCount || restoredManifest.symlinkCount !== sourceManifest.symlinkCount) {
      throw new Error("Restored manifest counts mismatch.")
    }
    assertions.restoreIdentical = "passed"

    // 9. Start restored container directly
    dockerCmd([
      "run", "-d",
      "--name", activeData.restoreContainer,
      "-v", `${activeData.tempVolume}:/data`,
      "--env-file", ".env.compose",
      "-e", "OPERATOR_ENGINE_DISTRIBUTION=theme-7",
      "-e", `OPERATOR_ENGINE_TERMINAL_PORT=${restoreRelayPort}`,
      "-p", `127.0.0.1:${restoreWebPort}:4400`,
      "-p", `127.0.0.1:${restoreRelayPort}:${restoreRelayPort}`,
      sourceImageId
    ])

    await waitForHealthy(activeData.restoreContainer)
    restoredImageId = dockerCmd(["inspect", "--format={{.Image}}", activeData.restoreContainer])

    // Verify restored capability parity and health
    const restCapRes = await fetchStatus(`http://127.0.0.1:${restoreWebPort}/api/runtime-capabilities`, {
      headers: { "Cookie": authCookie }
    })
    if (!restCapRes.ok || restCapRes.body?.distributionId !== "theme-7") {
      throw new Error("Restored capability check failed.")
    }

    const restLanesRes = await fetchStatus(`http://127.0.0.1:${restoreWebPort}/api/lanes`, {
      headers: { "Cookie": authCookie }
    })
    if (!restLanesRes.ok || restLanesRes.body.length !== sourceLaneCount) {
      throw new Error("Restored lane count mismatch.")
    }

    // Verify OMP is available
    const restHarnessesRes = await fetchStatus(`http://127.0.0.1:${restoreWebPort}/api/harnesses`, {
      headers: { "Cookie": authCookie }
    })
    const ompHarness = restHarnessesRes.body?.harnesses?.find(h => h.id === "omp")
    if (!ompHarness || ompHarness.state !== "available") {
      throw new Error("OMP is not available on restored service.")
    }

    // Verify relay healthz
    const relayHealth = await fetchStatus(`http://127.0.0.1:${restoreRelayPort}/healthz`)
    if (relayHealth.status !== 200) {
      throw new Error(`Restored relay healthz failed: got status ${relayHealth.status}`)
    }

    // Create/read/delete writable-volume probe
    const probeFile = "/data/recovery-probe.txt"
    dockerCmd([
      "exec", activeData.restoreContainer,
      "node", "-e",
      `"const fs=require('node:fs'); fs.writeFileSync('${probeFile}','hello'); if(fs.readFileSync('${probeFile}','utf8')!=='hello') throw new Error('probe read mismatch'); fs.unlinkSync('${probeFile}')"`
    ])

    assertions.restoreHealthy = "passed"
  } finally {
    // Zero key buffer
    key.fill(0)

    // In finally, ensure source is started and healthy if stopped
    try {
      const inspect = JSON.parse(dockerCmd(["inspect", sourceContainerId]))[0]
      if (!inspect.State.Running) {
        dockerCmd(["compose", "-p", "theme7", "start", "theme7"])
        await waitForHealthy(sourceContainerId)
      }
    } catch {}

    cleanupTemporaryObjects(activeData)
    fs.rmSync(activeFilePath, { force: true })
  }

  // 10. Write final receipt
  const endedAt = new Date()
  const timestamp = endedAt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"
  const receiptDir = path.join(process.cwd(), ".operator-engine", "recovery-proofs")
  fs.mkdirSync(receiptDir, { recursive: true })

  const isSuccess = Object.values(assertions).every(v => v === "passed")
  const receipt = {
    schemaVersion: "theme7-recovery-proof.v1",
    status: isSuccess ? "succeeded" : "failed",
    timestamps: {
      startedAt: activeData.startedAt,
      endedAt: endedAt.toISOString()
    },
    phase: "completed",
    evidence: {
      sourceManifest,
      restoredManifest,
      encryptedArchive: {
        sha256: encryptedArchiveSha,
        path: activeData.encryptedArchiveFile
      },
      sourceIdentity: {
        containerId: sourceContainerId,
        imageId: sourceImageId
      },
      restoredIdentity: {
        containerId: activeData.restoreContainer,
        imageId: restoredImageId
      }
    },
    assertions
  }

  fs.writeFileSync(path.join(receiptDir, `${timestamp}.json`), JSON.stringify(receipt, null, 2))
  process.stdout.write(`Recovery proof drill completed. Status: ${receipt.status}\n`)
}

if (import.meta.url.startsWith("file:") && path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runRecoveryProof().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
  })
}
