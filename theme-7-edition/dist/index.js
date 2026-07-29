const packageRoot = new URL("../", import.meta.url)

const loader = () => ({ kind: "text", value: "OMP // SPAWNING AGENT_", variant: "loader", x: 500, y: 90, atMs: 0, durationMs: 1800, motion: "fade", tone: "accent" })
const node = (x, y, size, atMs, tone = "accent", shape = "circle", motion = "pop") => ({ kind: "node", shape, x, y, size, atMs, durationMs: 700, motion, tone })
const ring = (x, y, size, atMs, tone = "muted") => ({ kind: "ring", x, y, size, atMs, durationMs: 1100, tone })
const path = (points, atMs, tone = "accent", motion = "draw") => ({ kind: "path", points: points.map(([x, y]) => ({ x, y })), atMs, durationMs: 1200, motion, tone })
const text = (value, x, y, atMs, tone = "strong", motion = "settle") => ({ kind: "text", value, variant: value.length <= 3 ? "display" : "caption", x, y, atMs, durationMs: 900, motion, tone })
const experience = (id, primitives) => ({ id, durationMs: 5200, primitives: [loader(), ...primitives] })
const terminalShowpieces = [
  experience("chromatic-aperture", [
    ...[120, 210, 300].map((size, index) => ring(500, 520, size, 500 + index * 240, index === 1 ? "accent" : "muted")),
    ...Array.from({ length: 8 }, (_, index) => {
      const angle = index * Math.PI / 4
      return node(Math.round(500 + Math.cos(angle) * 150), Math.round(520 + Math.sin(angle) * 150), 48, 700 + index * 70, index % 2 ? "accent" : "strong", "diamond")
    }),
    node(500, 520, 18, 1900, "strong"),
  ]),
  experience("particle-magnetism", [
    { kind: "field", pattern: "dot-grid", columns: 18, rows: 10, atMs: 0, durationMs: 1400 },
    ...Array.from({ length: 24 }, (_, index) => node(170 + (index * 137) % 660, 220 + (index * 83) % 560, 10 + index % 3 * 4, 260 + index * 55, index % 3 === 0 ? "accent" : index % 3 === 1 ? "muted" : "strong", "circle", "settle")),
    text("O", 420, 530, 1900, "accent"), text("M", 500, 530, 2050, "strong"), text("P", 580, 530, 2200, "accent"),
  ]),
  experience("pixel-bloom", [
    ...Array.from({ length: 32 }, (_, index) => {
      const ringIndex = Math.floor(index / 8) + 1
      const angle = index % 8 * Math.PI / 4 + ringIndex * .18
      return node(Math.round(500 + Math.cos(angle) * ringIndex * 66), Math.round(520 + Math.sin(angle) * ringIndex * 66), 18 + ringIndex * 5, 350 + ringIndex * 180 + index * 28, index % 3 === 0 ? "accent" : index % 3 === 1 ? "strong" : "muted", "square")
    }),
    node(500, 520, 16, 300, "strong", "square"),
  ]),
  experience("signal-decode", [
    { kind: "field", pattern: "scan-lines", columns: 2, rows: 9, atMs: 0, durationMs: 1200 },
    path([[90, 520], [180, 520], [230, 410], [290, 630], [350, 470], [420, 550], [500, 520]], 450, "accent", "signal"),
    path([[500, 520], [580, 490], [640, 570], [710, 430], [770, 610], [830, 520], [910, 520]], 1250, "strong", "signal"),
    node(500, 520, 18, 1900, "strong"), text("SIGNAL LOCKED", 500, 690, 2500, "accent", "fade"),
  ]),
  experience("type-assembly", [
    text("O", 370, 530, 450, "accent"), text("M", 500, 530, 800, "strong"), text("P", 630, 530, 1150, "accent"),
    path([[300, 620], [700, 620]], 1850, "muted"), text("SESSION ACCEPTED", 500, 690, 2450, "strong", "fade"),
  ]),
  experience("prism-strike", [
    path([[80, 520], [410, 520]], 350, "strong", "signal"),
    path([[500, 300], [650, 650], [350, 650], [500, 300]], 900, "muted"),
    path([[590, 510], [920, 360]], 1650, "accent", "signal"), path([[600, 530], [930, 530]], 1800, "strong", "signal"), path([[590, 550], [920, 700]], 1950, "accent", "signal"),
    node(500, 520, 16, 1450, "strong"),
  ]),
  experience("orbital-slingshot", [
    ring(500, 520, 430, 250, "muted"), ring(500, 520, 250, 650, "muted"),
    node(290, 520, 28, 500, "accent"), node(710, 520, 28, 700, "strong"),
    path([[290, 520], [390, 390], [560, 400], [710, 520]], 1150, "accent", "signal"),
    path([[710, 520], [800, 430], [930, 330]], 2350, "strong", "signal"),
  ]),
  experience("liquid-merge", [
    node(260, 520, 120, 350, "accent"), node(740, 520, 120, 500, "strong"),
    node(390, 520, 100, 1050, "accent"), node(610, 520, 100, 1200, "strong"),
    node(500, 520, 150, 1900, "accent"), ring(500, 520, 230, 2400, "strong"),
  ]),
  experience("glyph-rain", [
    { kind: "field", pattern: "scan-lines", columns: 2, rows: 16, atMs: 0, durationMs: 1700 },
    ...["0 1 / >", "{ } [ ]", "$ # * +", "< O M P >"].map((value, index) => text(value, 500, 300 + index * 90, 350 + index * 250, index === 3 ? "accent" : "muted", "settle")),
    text("❯ omp_", 500, 720, 2150, "strong", "fade"),
  ]),
  experience("mosaic-flip", [
    { kind: "field", pattern: "square-grid", columns: 13, rows: 7, atMs: 0, durationMs: 1000 },
    ...[[350, 410], [430, 410], [510, 410], [590, 410], [670, 410], [350, 500], [510, 500], [670, 500], [350, 590], [430, 590], [510, 590], [590, 590], [670, 590]].map(([x, y], index) => node(x, y, 60, 500 + index * 90, index % 3 === 0 ? "accent" : index % 3 === 1 ? "strong" : "muted", "square")),
    text("READY", 500, 720, 2500, "strong", "fade"),
  ]),
]
export const ompTheme7 = {
  distribution: {
    id: "theme-7",
    edition: {
      schemaVersion: 1,
      id: "theme-7",
      name: "Theme7",
      description: "A terminal-first workspace for keeping multiple jobs separated and ready.",
      brand: { productName: "Theme7", subtitle: "Job Harness", icon: "assets/theme-seven-mark.svg", favicon: "assets/theme-seven-mark.svg" },
      terms: { workItem: { singular: "job", plural: "jobs" } },
      stylesheet: "theme.css",
      surfaces: { "agent-card:omp": { label: "OMP", description: "Open OMP in this folder." } },
      terminalShowpiece: {
        version: 1,
        mode: "replace",
        experiences: terminalShowpieces,
      },
    },
    providerIds: ["omp", "shell"],
    panes: { "t4-code": { label: "T4 Code", description: "Use OMP through T4 Code's graphical session interface." } },
    starter: { id: "browser-showpiece", directoryBase: "omp-tour", entry: "index.html" },
    onboarding: {
      version: "2",
      intro: {
        title: "welcome to Theme7",
        lines: [
          "Theme7 keeps real folders, terminals, and AI-assisted work together in one workspace.",
          "Let's create a job and get started."
        ],
        actionLabel: "start tour"
      },
      steps: [
        { id: "got-a-job", target: "create-lane", title: "got a job", description: "press plus to create a new work lane.", advance: "target-action" },
        { id: "one-job-one-folder", target: "directory-picker", title: "one job one folder", description: "choose the folder that holds the work; nothing will be moved or copied.", advance: "target-action" },
        { id: "give-the-job-an-agent", target: "agent-terminal", secondaryTarget: "pane-palette", title: "give the job an agent", description: "open omp in the terminal when you are ready.", descriptionWhenT4: "open omp in the terminal, or add t4 code for a visual session.", advance: "target-action" },
        { id: "make-the-work-visible", target: "browser", title: "make the work visible", description: "ask your agent for html, and open it in the browser.", advance: "button", onEnter: "open-browser-showpiece" },
        { id: "this-is-the-browser", target: "browser", title: "this is the browser", description: "the sample is a normal html file in this job.", advance: "button" },
      ],
    },
  },
  resources: {
    packageRoot,
    editionRoot: new URL("../edition/", import.meta.url),
    starters: { "browser-showpiece": new URL("../starter/browser-showpiece/", import.meta.url) },
    identityExtension: new URL("./identity-extension.js", import.meta.url),
  },
}
export default ompTheme7
