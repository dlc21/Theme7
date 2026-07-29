import { isValidClientIdentityPart } from "./layout-tree-policy.mjs"

const READY_DATABASE_SYMBOL = Symbol.for("operator-engine.terminal-continuity-schema.v1")
const readyDatabases = new WeakSet()
const EXACT_OMP_SESSION_PATTERN = /^[A-Za-z0-9._:-]{6,240}$/
const HARNESS_IDS = new Set(["omp", "codex", "shell"])

function validateIdentity(laneId, paneId) {
  if (!isValidClientIdentityPart(laneId) || !isValidClientIdentityPart(paneId)) {
    throw new Error("Invalid terminal identity.")
  }
}

function validateHarness(harnessId) {
  if (!HARNESS_IDS.has(harnessId)) throw new Error("Invalid terminal harness.")
}

function validateGeneration(generation, name = "generation") {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error(`Invalid terminal ${name}.`)
}

function validateResumeSessionId(resumeSessionId, harnessId) {
  if (resumeSessionId === null) return
  if (harnessId !== "omp" || typeof resumeSessionId !== "string" || !EXACT_OMP_SESSION_PATTERN.test(resumeSessionId)) {
    throw new Error("Invalid resume session identity.")
  }
}

function laneColumns(db) {
  return db.prepare("PRAGMA table_info(lanes)").all().map((column) => column.name)
}

function hasTerminalContinuitySchema(db, columns) {
  if (!columns.includes("layout_revision")) return false
  const bindingColumns = new Set(db.prepare("PRAGMA table_info(terminal_bindings)").all().map((column) => column.name))
  const epochColumns = new Set(db.prepare("PRAGMA table_info(terminal_binding_epochs)").all().map((column) => column.name))
  const bindingIndexes = db.prepare("PRAGMA index_list(terminal_bindings)").all()
  return [
    "lane_id",
    "pane_id",
    "harness_id",
    "resume_session_id",
    "kickoff_sent",
    "generation",
    "updated_at",
  ].every((name) => bindingColumns.has(name))
    && ["lane_id", "pane_id", "last_generation"].every((name) => epochColumns.has(name))
    && bindingIndexes.some((index) => index.name === "terminal_bindings_resume_session" && index.unique === 1)
}

function runImmediate(db, operation) {
  if (db.inTransaction) return operation()
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    db.exec("COMMIT")
    return result
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK")
    throw error
  }
}

function bindingFromRow(row) {
  if (!row) return null
  return {
    laneId: row.lane_id,
    paneId: row.pane_id,
    harnessId: row.harness_id,
    resumeSessionId: row.resume_session_id,
    kickoffSent: row.kickoff_sent === 1,
    generation: row.generation,
    updatedAt: row.updated_at,
  }
}

function getBindingRaw(db, laneId, paneId) {
  return bindingFromRow(db.prepare(`
    SELECT lane_id, pane_id, harness_id, resume_session_id, kickoff_sent, generation, updated_at
    FROM terminal_bindings
    WHERE lane_id = ? AND pane_id = ?
  `).get(laneId, paneId))
}

function epochRaw(db, laneId, paneId) {
  const row = db.prepare(`
    SELECT last_generation
    FROM terminal_binding_epochs
    WHERE lane_id = ? AND pane_id = ?
  `).get(laneId, paneId)
  return row ? row.last_generation : null
}

function setEpochRaw(db, laneId, paneId, generation) {
  db.prepare(`
    INSERT INTO terminal_binding_epochs (lane_id, pane_id, last_generation)
    VALUES (?, ?, ?)
    ON CONFLICT(lane_id, pane_id) DO UPDATE
      SET last_generation = MAX(terminal_binding_epochs.last_generation, excluded.last_generation)
  `).run(laneId, paneId, generation)
}

function invalidLayout(laneId) {
  return new Error(`Invalid lane layout for ${laneId}: pane ids must be valid and unique.`)
}

function terminalClaim(config, fallbackHarness, legacy) {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {}
  const harnessId = HARNESS_IDS.has(source.harnessId) ? source.harnessId : fallbackHarness
  const candidateId = source.resumeSessionId
  return {
    harnessId,
    resumeSessionId: harnessId === "omp" && typeof candidateId === "string" && EXACT_OMP_SESSION_PATTERN.test(candidateId)
      ? candidateId
      : null,
    kickoffSent: legacy || Object.hasOwn(source, "kitId") || source.kickoffSent === true,
    role: source.role === "first" ? "first" : "additional",
  }
}

function migrateLayoutNode(value, laneId, fallbackHarness, legacy, paneIds, claims) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidLayout(laneId)
  if (value.kind === "pane") {
    if (!isValidClientIdentityPart(value.id) || paneIds.has(value.id) || typeof value.pane !== "string" || value.pane.length === 0) {
      throw invalidLayout(laneId)
    }
    paneIds.add(value.id)
    if (value.pane !== "terminal") return { ...value }
    const claim = terminalClaim(value.config, fallbackHarness, legacy)
    claims.push({
      laneId,
      paneId: value.id,
      harnessId: claim.harnessId,
      resumeSessionId: claim.resumeSessionId,
      kickoffSent: claim.kickoffSent,
    })
    return { ...value, config: { role: claim.role } }
  }
  if (value.kind === "tabs") {
    if (!Array.isArray(value.panes) || value.panes.length === 0 || typeof value.activeId !== "string") throw invalidLayout(laneId)
    const panes = value.panes.map((pane) => migrateLayoutNode(pane, laneId, fallbackHarness, legacy, paneIds, claims))
    if (panes.some((pane) => pane.kind !== "pane") || !panes.some((pane) => pane.id === value.activeId)) throw invalidLayout(laneId)
    return { ...value, panes }
  }
  if (value.kind === "split") {
    if ((value.direction !== "horizontal" && value.direction !== "vertical") || !Number.isFinite(value.percentage)) {
      throw invalidLayout(laneId)
    }
    return {
      ...value,
      first: migrateLayoutNode(value.first, laneId, fallbackHarness, legacy, paneIds, claims),
      second: migrateLayoutNode(value.second, laneId, fallbackHarness, legacy, paneIds, claims),
    }
  }
  throw invalidLayout(laneId)
}

function migrateLaneLayout(row) {
  if (row.layout_json === null) return { layoutJson: null, claims: [] }
  let saved
  try {
    saved = JSON.parse(row.layout_json)
  } catch {
    throw invalidLayout(row.id)
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw invalidLayout(row.id)
  const versioned = saved.schemaVersion === 1 && Object.hasOwn(saved, "tree")
  if (Object.hasOwn(saved, "schemaVersion") && !versioned) throw invalidLayout(row.id)
  const paneIds = new Set()
  const claims = []
  const fallbackHarness = HARNESS_IDS.has(row.default_harness) ? row.default_harness : "shell"
  const tree = migrateLayoutNode(versioned ? saved.tree : saved, row.id, fallbackHarness, !versioned, paneIds, claims)
  const migrated = versioned ? { ...saved, schemaVersion: 1, tree } : { schemaVersion: 1, tree }
  return { layoutJson: JSON.stringify(migrated), claims }
}

function inspectVisualPane(layoutJson, paneId) {
  if (layoutJson === null) return "null"
  let saved
  try {
    saved = JSON.parse(layoutJson)
  } catch {
    return "invalid"
  }
  const root = saved && typeof saved === "object" && saved.schemaVersion === 1 ? saved.tree : saved
  const seen = new Set()
  let found = "absent"
  const visit = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false
    if (node.kind === "pane") {
      if (!isValidClientIdentityPart(node.id) || seen.has(node.id) || typeof node.pane !== "string") return false
      seen.add(node.id)
      if (node.id === paneId) found = node.pane === "terminal" ? "terminal" : "nonterminal"
      return true
    }
    if (node.kind === "tabs") return Array.isArray(node.panes) && node.panes.length > 0 && node.panes.every(visit)
    if (node.kind === "split") return visit(node.first) && visit(node.second)
    return false
  }
  return visit(root) ? found : "invalid"
}

function duplicateSessionError(sessionId, first, second) {
  return new Error(`Duplicate terminal session binding for ${sessionId} between ${first.laneId}/${first.paneId} and ${second.laneId}/${second.paneId}.`)
}

function migrateContinuityState(db) {
  const columns = laneColumns(db)
  if (!columns.includes("layout_revision")) {
    db.exec("ALTER TABLE lanes ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0")
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_binding_epochs (
      lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
      pane_id TEXT NOT NULL,
      last_generation INTEGER NOT NULL CHECK (last_generation >= 1),
      PRIMARY KEY (lane_id, pane_id)
    );
    CREATE TABLE IF NOT EXISTS terminal_bindings (
      lane_id TEXT NOT NULL,
      pane_id TEXT NOT NULL,
      harness_id TEXT NOT NULL CHECK (harness_id IN ('omp', 'codex', 'shell')),
      resume_session_id TEXT,
      kickoff_sent INTEGER NOT NULL DEFAULT 0 CHECK (kickoff_sent IN (0, 1)),
      generation INTEGER NOT NULL CHECK (generation >= 1),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lane_id, pane_id),
      FOREIGN KEY (lane_id, pane_id)
        REFERENCES terminal_binding_epochs(lane_id, pane_id) ON DELETE CASCADE,
      CHECK (
        resume_session_id IS NULL OR
        (harness_id = 'omp' AND length(resume_session_id) BETWEEN 6 AND 240)
      )
    );
  `)

  const epochRows = db.prepare(`
    SELECT lane_id, pane_id, last_generation
    FROM terminal_binding_epochs
    ORDER BY lane_id, pane_id
  `).all()
  const epochs = new Map()
  for (const row of epochRows) {
    if (!isValidClientIdentityPart(row.lane_id) || !isValidClientIdentityPart(row.pane_id) || !Number.isSafeInteger(row.last_generation) || row.last_generation < 1) {
      throw new Error(`Invalid terminal binding epoch for ${row.lane_id}/${row.pane_id}.`)
    }
    epochs.set(`${row.lane_id}\u0000${row.pane_id}`, row.last_generation)
  }

  const bindingRows = db.prepare(`
    SELECT lane_id, pane_id, harness_id, resume_session_id, kickoff_sent, generation, updated_at
    FROM terminal_bindings
    ORDER BY lane_id, pane_id
  `).all()
  const bindings = new Map()
  for (const row of bindingRows) {
    const binding = bindingFromRow(row)
    if (!isValidClientIdentityPart(binding.laneId) || !isValidClientIdentityPart(binding.paneId) ||
        !HARNESS_IDS.has(binding.harnessId) || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
        (row.kickoff_sent !== 0 && row.kickoff_sent !== 1) || typeof binding.updatedAt !== "string" || !binding.updatedAt ||
        (binding.resumeSessionId !== null && (binding.harnessId !== "omp" || !EXACT_OMP_SESSION_PATTERN.test(binding.resumeSessionId)))) {
      throw new Error(`Invalid terminal binding for ${binding.laneId}/${binding.paneId}.`)
    }
    const key = `${binding.laneId}\u0000${binding.paneId}`
    const epoch = epochs.get(key)
    if (epoch !== undefined && epoch > binding.generation) {
      throw new Error(`Terminal binding epoch is ahead of ${binding.laneId}/${binding.paneId}.`)
    }
    epochs.set(key, binding.generation)
    bindings.set(key, binding)
  }

  const laneRows = db.prepare(`
    SELECT id, layout_json, default_harness
    FROM lanes
    ORDER BY id
  `).all()
  const migratedLayouts = []
  const claims = []
  for (const row of laneRows) {
    const migrated = migrateLaneLayout(row)
    migratedLayouts.push({ laneId: row.id, layoutJson: migrated.layoutJson, originalLayoutJson: row.layout_json })
    claims.push(...migrated.claims)
  }

  const now = new Date().toISOString()
  const freshKeys = new Set()
  for (const claim of claims) {
    const key = `${claim.laneId}\u0000${claim.paneId}`
    const existing = bindings.get(key)
    if (existing) {
      if (existing.resumeSessionId && claim.resumeSessionId && existing.resumeSessionId !== claim.resumeSessionId) {
        throw new Error(`Conflicting terminal session sources for ${claim.laneId}/${claim.paneId}.`)
      }
      const resumeSessionId = existing.resumeSessionId ?? claim.resumeSessionId
      const merged = {
        ...existing,
        harnessId: resumeSessionId ? "omp" : existing.harnessId,
        resumeSessionId,
        kickoffSent: existing.kickoffSent || claim.kickoffSent,
      }
      if (merged.harnessId !== existing.harnessId || merged.resumeSessionId !== existing.resumeSessionId || merged.kickoffSent !== existing.kickoffSent) {
        merged.updatedAt = now
      }
      bindings.set(key, merged)
      continue
    }
    const generation = (epochs.get(key) ?? 0) + 1
    const binding = {
      laneId: claim.laneId,
      paneId: claim.paneId,
      harnessId: claim.harnessId,
      resumeSessionId: claim.resumeSessionId,
      kickoffSent: claim.kickoffSent,
      generation,
      updatedAt: now,
    }
    epochs.set(key, generation)
    bindings.set(key, binding)
    freshKeys.add(key)
  }

  const sessions = new Map()
  for (const binding of bindings.values()) {
    if (!binding.resumeSessionId) continue
    const previous = sessions.get(binding.resumeSessionId)
    if (previous && (previous.laneId !== binding.laneId || previous.paneId !== binding.paneId)) {
      throw duplicateSessionError(binding.resumeSessionId, previous, binding)
    }
    sessions.set(binding.resumeSessionId, binding)
  }

  for (const binding of bindings.values()) {
    setEpochRaw(db, binding.laneId, binding.paneId, binding.generation)
    const key = `${binding.laneId}\u0000${binding.paneId}`
    if (freshKeys.has(key)) {
      db.prepare(`
        INSERT INTO terminal_bindings (
          lane_id, pane_id, harness_id, resume_session_id, kickoff_sent, generation, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        binding.laneId,
        binding.paneId,
        binding.harnessId,
        binding.resumeSessionId,
        binding.kickoffSent ? 1 : 0,
        binding.generation,
        binding.updatedAt,
      )
    } else {
      db.prepare(`
        UPDATE terminal_bindings
        SET harness_id = ?, resume_session_id = ?, kickoff_sent = ?, generation = ?, updated_at = ?
        WHERE lane_id = ? AND pane_id = ?
      `).run(
        binding.harnessId,
        binding.resumeSessionId,
        binding.kickoffSent ? 1 : 0,
        binding.generation,
        binding.updatedAt,
        binding.laneId,
        binding.paneId,
      )
    }
  }

  for (const layout of migratedLayouts) {
    if (layout.layoutJson !== layout.originalLayoutJson) {
      db.prepare("UPDATE lanes SET layout_json = ? WHERE id = ?").run(layout.layoutJson, layout.laneId)
    }
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS terminal_bindings_resume_session
      ON terminal_bindings(resume_session_id)
      WHERE resume_session_id IS NOT NULL;
  `)
}

export function ensureTerminalContinuitySchema(db) {
  if (readyDatabases.has(db) || db[READY_DATABASE_SYMBOL] === true) {
    readyDatabases.add(db)
    return true
  }
  const columns = laneColumns(db)
  if (!columns.includes("id") || !columns.includes("layout_json") || !columns.includes("default_harness")) return false
  if (db.inTransaction) {
    if (hasTerminalContinuitySchema(db, columns)) return true
    throw new Error("Terminal continuity schema must be initialized before opening a transaction.")
  }
  runImmediate(db, () => migrateContinuityState(db))
  readyDatabases.add(db)
  Object.defineProperty(db, READY_DATABASE_SYMBOL, { value: true, configurable: true })
  return true
}

function requireContinuitySchema(db) {
  if (!ensureTerminalContinuitySchema(db)) throw new Error("Terminal continuity schema is not ready.")
}

export function getTerminalBinding(db, laneId, paneId) {
  validateIdentity(laneId, paneId)
  requireContinuitySchema(db)
  return getBindingRaw(db, laneId, paneId)
}

export function listTerminalBindings(db, laneId) {
  if (laneId !== undefined && !isValidClientIdentityPart(laneId)) throw new Error("Invalid terminal identity.")
  requireContinuitySchema(db)
  const rows = laneId === undefined
    ? db.prepare(`
        SELECT lane_id, pane_id, harness_id, resume_session_id, kickoff_sent, generation, updated_at
        FROM terminal_bindings
        ORDER BY lane_id, pane_id
      `).all()
    : db.prepare(`
        SELECT lane_id, pane_id, harness_id, resume_session_id, kickoff_sent, generation, updated_at
        FROM terminal_bindings
        WHERE lane_id = ?
        ORDER BY pane_id
      `).all(laneId)
  return rows.map(bindingFromRow)
}

export function planTerminalBindingCreation(db, laneId, paneId) {
  validateIdentity(laneId, paneId)
  requireContinuitySchema(db)
  const existing = getBindingRaw(db, laneId, paneId)
  if (existing) return existing
  const expectedLastGeneration = epochRaw(db, laneId, paneId)
  return { expectedLastGeneration, nextGeneration: (expectedLastGeneration ?? 0) + 1 }
}

export function createTerminalBinding(db, input) {
  validateIdentity(input.laneId, input.paneId)
  validateHarness(input.harnessId)
  if (input.kickoffSent !== undefined && typeof input.kickoffSent !== "boolean") throw new Error("Invalid terminal guidance state.")
  const comparesEpoch = Object.hasOwn(input, "expectedLastGeneration")
  if (comparesEpoch && input.expectedLastGeneration !== null) validateGeneration(input.expectedLastGeneration, "binding epoch")
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const existing = getBindingRaw(db, input.laneId, input.paneId)
    if (existing) return comparesEpoch ? "epoch-conflict" : existing
    const currentEpoch = epochRaw(db, input.laneId, input.paneId)
    if (comparesEpoch && currentEpoch !== input.expectedLastGeneration) return "epoch-conflict"
    const generation = (currentEpoch ?? 0) + 1
    const updatedAt = new Date().toISOString()
    setEpochRaw(db, input.laneId, input.paneId, generation)
    db.prepare(`
      INSERT INTO terminal_bindings (
        lane_id, pane_id, harness_id, resume_session_id, kickoff_sent, generation, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(input.laneId, input.paneId, input.harnessId, input.kickoffSent ? 1 : 0, generation, updatedAt)
    return getBindingRaw(db, input.laneId, input.paneId)
  })
}

export function advanceTerminalBinding(db, input) {
  validateIdentity(input.laneId, input.paneId)
  validateHarness(input.harnessId)
  validateGeneration(input.expected?.generation)
  validateHarness(input.expected?.harnessId)
  if (typeof input.expected?.kickoffSent !== "boolean") throw new Error("Invalid terminal guidance state.")
  validateResumeSessionId(input.expected?.resumeSessionId, input.expected?.harnessId)
  validateResumeSessionId(input.resume, input.harnessId)
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const current = getBindingRaw(db, input.laneId, input.paneId)
    if (!current || current.generation !== input.expected.generation || current.harnessId !== input.expected.harnessId ||
        current.resumeSessionId !== input.expected.resumeSessionId || current.kickoffSent !== input.expected.kickoffSent ||
        epochRaw(db, input.laneId, input.paneId) !== current.generation) {
      return null
    }
    const generation = current.generation + 1
    const updatedAt = new Date().toISOString()
    setEpochRaw(db, input.laneId, input.paneId, generation)
    db.prepare(`
      UPDATE terminal_bindings
      SET harness_id = ?, resume_session_id = ?, generation = ?, updated_at = ?
      WHERE lane_id = ? AND pane_id = ?
    `).run(input.harnessId, input.resume, generation, updatedAt, input.laneId, input.paneId)
    return getBindingRaw(db, input.laneId, input.paneId)
  })
}

export function setTerminalBindingIdentity(db, input) {
  validateIdentity(input.laneId, input.paneId)
  validateGeneration(input.generation)
  validateResumeSessionId(input.resumeSessionId, "omp")
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const current = getBindingRaw(db, input.laneId, input.paneId)
    if (!current || current.generation !== input.generation || current.harnessId !== "omp") return null
    if (current.resumeSessionId && current.resumeSessionId !== input.resumeSessionId) {
      throw new Error(`Conflicting terminal session sources for ${input.laneId}/${input.paneId}.`)
    }
    if (current.resumeSessionId === input.resumeSessionId) return current
    const other = db.prepare(`
      SELECT lane_id, pane_id
      FROM terminal_bindings
      WHERE resume_session_id = ? AND NOT (lane_id = ? AND pane_id = ?)
    `).get(input.resumeSessionId, input.laneId, input.paneId)
    if (other) throw duplicateSessionError(input.resumeSessionId, { laneId: other.lane_id, paneId: other.pane_id }, current)
    db.prepare(`
      UPDATE terminal_bindings
      SET resume_session_id = ?, updated_at = ?
      WHERE lane_id = ? AND pane_id = ? AND generation = ? AND resume_session_id IS NULL
    `).run(input.resumeSessionId, new Date().toISOString(), input.laneId, input.paneId, input.generation)
    return getBindingRaw(db, input.laneId, input.paneId)
  })
}

export function markTerminalGuidanceStarted(db, input) {
  validateIdentity(input.laneId, input.paneId)
  validateGeneration(input.generation)
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const current = getBindingRaw(db, input.laneId, input.paneId)
    if (!current || current.generation !== input.generation) return null
    if (current.kickoffSent) return current
    db.prepare(`
      UPDATE terminal_bindings
      SET kickoff_sent = 1, updated_at = ?
      WHERE lane_id = ? AND pane_id = ? AND generation = ?
    `).run(new Date().toISOString(), input.laneId, input.paneId, input.generation)
    return getBindingRaw(db, input.laneId, input.paneId)
  })
}

export function deleteTerminalBinding(db, input) {
  validateIdentity(input.laneId, input.paneId)
  validateGeneration(input.expectedGeneration)
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const current = getBindingRaw(db, input.laneId, input.paneId)
    if (!current || current.generation !== input.expectedGeneration) return null
    const result = db.prepare(`
      DELETE FROM terminal_bindings
      WHERE lane_id = ? AND pane_id = ? AND generation = ?
    `).run(input.laneId, input.paneId, input.expectedGeneration)
    return result.changes === 1 ? current : null
  })
}

export function settleTerminalReservation(db, input) {
  validateIdentity(input.laneId, input.paneId)
  validateGeneration(input.generation)
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const current = getBindingRaw(db, input.laneId, input.paneId)
    if (!current) return { status: "missing", binding: null }
    if (current.generation > input.generation) return { status: "superseded", binding: current }
    if (current.generation < input.generation) return { status: "binding-conflict", binding: current }
    const lane = db.prepare("SELECT layout_json FROM lanes WHERE id = ?").get(input.laneId)
    if (inspectVisualPane(lane?.layout_json ?? null, input.paneId) === "terminal") {
      return { status: "consumed", binding: current }
    }
    db.prepare(`
      DELETE FROM terminal_bindings
      WHERE lane_id = ? AND pane_id = ? AND generation = ?
    `).run(input.laneId, input.paneId, input.generation)
    return { status: "deleted", binding: current }
  })
}

export function deleteAbandonedTerminalBindings(db, relayStartedAt) {
  if (typeof relayStartedAt !== "string" || !Number.isFinite(Date.parse(relayStartedAt))) {
    throw new Error("Invalid relay start time.")
  }
  requireContinuitySchema(db)
  return runImmediate(db, () => {
    const rows = db.prepare(`
      SELECT b.lane_id, b.pane_id, b.harness_id, b.resume_session_id, b.kickoff_sent, b.generation, b.updated_at,
             l.layout_json
      FROM terminal_bindings b
      JOIN lanes l ON l.id = b.lane_id
      WHERE b.updated_at < ?
      ORDER BY b.lane_id, b.pane_id
    `).all(relayStartedAt)
    const deleted = []
    for (const row of rows) {
      const visual = inspectVisualPane(row.layout_json, row.pane_id)
      if (visual === "null" || visual === "invalid" || visual === "terminal") continue
      const binding = bindingFromRow(row)
      const result = db.prepare(`
        DELETE FROM terminal_bindings
        WHERE lane_id = ? AND pane_id = ? AND generation = ?
      `).run(binding.laneId, binding.paneId, binding.generation)
      if (result.changes === 1) deleted.push(binding)
    }
    return deleted
  })
}
