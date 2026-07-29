import type { TerminalShowpieceExperiencePublicV1, TerminalShowpiecePointV1, TerminalShowpiecePublicV1 } from "@/lib/editions"

const point = (x: number, y: number): TerminalShowpiecePointV1 => ({ x, y })
const pathPrimitive = (points: TerminalShowpiecePointV1[], atMs: number, durationMs: number, motion: "draw" | "signal", tone: "muted" | "accent" | "strong" = "muted") => ({ kind: "path" as const, points, atMs, durationMs, motion, tone })
const node = (x: number, y: number, size: number, atMs: number, durationMs: number, motion: "fade" | "pop" | "settle", tone: "muted" | "accent" | "strong" = "muted", shape: "square" | "circle" | "diamond" = "square") => ({ kind: "node" as const, shape, x, y, size, atMs, durationMs, motion, tone })
const ring = (x: number, y: number, size: number, atMs: number, durationMs: number, tone: "muted" | "accent" | "strong" = "muted") => ({ kind: "ring" as const, x, y, size, atMs, durationMs, tone })
const mirror = (points: TerminalShowpiecePointV1[]) => points.map(({ x, y }) => point(1000 - x, y))

const pipInner = [point(500, 500), point(500, 430), point(340, 430), point(340, 360)]
const pipOuter = [
  [point(340, 360), point(340, 290), point(230, 290), point(230, 220)],
  [point(340, 360), point(430, 360), point(430, 190)],
]
const pipRoutes = [...pipOuter, ...pipOuter.map(mirror)]

export const STOCK_TERMINAL_SHOWPIECES: readonly TerminalShowpieceExperiencePublicV1[] = [
  {
    id: "pip-network", durationMs: 5200, primitives: [
      { kind: "field", pattern: "square-grid", columns: 12, rows: 8, atMs: 0, durationMs: 1200 },
      node(500, 500, 18, 500, 500, "pop", "accent"),
      node(340, 360, 18, 1200, 400, "pop", "accent"), node(660, 360, 18, 1200, 400, "pop", "accent"),
      node(230, 220, 18, 2200, 400, "pop", "accent"), node(430, 190, 18, 2200, 400, "pop", "accent"), node(570, 190, 18, 2200, 400, "pop", "accent"), node(770, 220, 18, 2200, 400, "pop", "accent"),
      pathPrimitive(pipInner, 1100, 700, "draw", "accent"), pathPrimitive(mirror(pipInner), 1100, 700, "draw", "accent"),
      ...pipRoutes.map((points) => pathPrimitive(points, 1900, 900, "draw")),
      ...pipRoutes.map((points) => pathPrimitive(points, 2900, 800, "signal", "strong")),
      ring(500, 500, 72, 3500, 700, "strong"),
    ],
  },
  {
    id: "signal-relay", durationMs: 4600, primitives: [
      ...[[160, 560, 400], [330, 410, 850], [500, 520, 1300], [680, 350, 1750], [840, 470, 2200]].map(([x, y, atMs]) => node(x, y, 16, atMs, 300, "pop", "accent", "circle")),
      pathPrimitive([point(160, 560), point(245, 560), point(245, 410), point(330, 410), point(415, 410), point(415, 520), point(500, 520), point(590, 520), point(590, 350), point(680, 350), point(760, 350), point(760, 470), point(840, 470)], 600, 2400, "signal", "accent"),
      ...[[160, 560, 700], [330, 410, 1150], [500, 520, 1600], [680, 350, 2050], [840, 470, 2500]].map(([x, y, atMs]) => ring(x, y, 58, atMs, 500)),
    ],
  },
  {
    id: "constellation", durationMs: 5000, primitives: [
      node(500, 500, 16, 1200, 400, "pop", "strong"),
      ...[[300, 300, 300], [700, 260, 450], [790, 590, 600], [610, 740, 750], [260, 680, 900]].map(([x, y, atMs]) => node(x, y, 12, atMs, 800, "settle", "muted", "circle")),
      ...[[300, 300], [700, 260], [790, 590], [610, 740], [260, 680]].map(([x, y]) => pathPrimitive([point(500, 500), point(x, y)], 1500, 900, "draw")),
      ...[[[300, 300], [700, 260]], [[700, 260], [790, 590]], [[790, 590], [610, 740]], [[610, 740], [260, 680]]].map((route) => pathPrimitive(route.map(([x, y]) => point(x, y)), 2300, 900, "draw", "accent")),
      ring(500, 500, 80, 3500, 900, "strong"),
    ],
  },
  {
    id: "cascade", durationMs: 4400, primitives: [
      ...[330, 450, 570, 690].flatMap((y, row) => [380, 500, 620].map((x, column) => node(x, y, 34, 200 + row * 200 + column * 120, 700, "settle"))),
      pathPrimitive([point(330, 570), point(670, 570)], 2300, 700, "signal", "strong"),
      ring(380, 570, 52, 2500, 500, "accent"), ring(500, 570, 52, 2600, 500, "accent"), ring(620, 570, 52, 2700, 500, "accent"),
    ],
  },
  {
    id: "handshake", durationMs: 4800, primitives: [
      pathPrimitive([point(180, 500), point(300, 500), point(390, 430), point(470, 500)], 500, 1400, "draw", "accent"),
      pathPrimitive([point(820, 500), point(700, 500), point(610, 570), point(530, 500)], 500, 1400, "draw", "accent"),
      node(180, 500, 18, 300, 400, "pop", "accent"), node(820, 500, 18, 300, 400, "pop", "accent"), node(470, 500, 18, 1600, 400, "pop", "accent"), node(530, 500, 18, 1600, 400, "pop", "accent"),
      pathPrimitive([point(470, 500), point(530, 500)], 2100, 500, "draw", "strong"),
      ring(500, 500, 90, 2600, 900, "strong"), ring(500, 500, 150, 2850, 800), ring(500, 500, 220, 3050, 800),
    ],
  },
  {
    id: "thread-weave", durationMs: 5400, primitives: [
      pathPrimitive([point(80, 280), point(280, 280), point(420, 460), point(620, 460)], 300, 1400, "draw"),
      pathPrimitive([point(80, 500), point(270, 500), point(430, 380), point(620, 380)], 600, 1400, "draw"),
      pathPrimitive([point(80, 720), point(300, 720), point(450, 540), point(620, 540)], 900, 1400, "draw"),
      pathPrimitive([point(620, 460), point(700, 460)], 2100, 900, "draw", "accent"), pathPrimitive([point(620, 380), point(700, 460)], 2100, 900, "draw", "accent"), pathPrimitive([point(620, 540), point(700, 460)], 2100, 900, "draw", "accent"),
      pathPrimitive([point(700, 460), point(850, 460)], 3000, 800, "draw", "strong"), node(850, 460, 20, 3600, 500, "pop", "strong"), ring(850, 460, 64, 3900, 700),
    ],
  },
]

export function terminalShowpieceCatalog(config?: TerminalShowpiecePublicV1 | null): readonly TerminalShowpieceExperiencePublicV1[] {
  if (!config) return STOCK_TERMINAL_SHOWPIECES
  return config.mode === "replace" ? config.experiences : [...STOCK_TERMINAL_SHOWPIECES, ...config.experiences]
}

export function terminalShowpieceAt(catalog: readonly TerminalShowpieceExperiencePublicV1[], rotationIndex: number): TerminalShowpieceExperiencePublicV1 {
  if (!catalog.length) throw new Error("Terminal showpiece catalog must not be empty.")
  const index = Number.isSafeInteger(rotationIndex) && rotationIndex >= 0 ? rotationIndex : 0
  return catalog[index % catalog.length]
}
