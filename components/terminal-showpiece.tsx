"use client"

import { useEffect } from "react"
import type React from "react"

import type { TerminalShowpieceExperiencePublicV1, TerminalShowpiecePrimitivePublicV1 } from "@/lib/editions"

type PrimitiveStyle = React.CSSProperties & { "--showpiece-at": string; "--showpiece-duration": string }

function primitiveStyle(primitive: TerminalShowpiecePrimitivePublicV1): PrimitiveStyle {
  return { "--showpiece-at": `${primitive.atMs}ms`, "--showpiece-duration": `${primitive.durationMs}ms` }
}

function toneClass(primitive: TerminalShowpiecePrimitivePublicV1): string {
  return "tone" in primitive ? `showpiece-tone-${primitive.tone}` : "showpiece-tone-strong"
}

export function TerminalShowpiece({ experience, runId, reducedMotion, onComplete }: {
  experience: TerminalShowpieceExperiencePublicV1
  runId: number
  reducedMotion: boolean
  onComplete: (runId: number) => void
}): React.ReactElement {
  useEffect(() => {
    const timer = window.setTimeout(() => onComplete(runId), reducedMotion ? 600 : experience.durationMs)
    return () => window.clearTimeout(timer)
  }, [experience.durationMs, onComplete, reducedMotion, runId])

  const fields = experience.primitives.filter((primitive) => primitive.kind === "field")
  const marks = experience.primitives.filter((primitive) => primitive.kind === "mark")
  const svgPrimitives = experience.primitives.filter((primitive) => primitive.kind !== "field" && primitive.kind !== "mark")

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden bg-[#09090b]"
      data-reduced-motion={reducedMotion ? "true" : undefined}
      data-showpiece-experience={experience.id}
      data-terminal-showpiece
    >
      {fields.map((primitive, index) => (
        <div
          className={`terminal-showpiece-field showpiece-${primitive.pattern}`}
          key={`field-${index}`}
          style={{ ...primitiveStyle(primitive), gridTemplateColumns: `repeat(${primitive.columns}, 1fr)`, gridTemplateRows: `repeat(${primitive.rows}, 1fr)` }}
        >
          {Array.from({ length: primitive.columns * primitive.rows }, (_, cell) => <i key={cell} />)}
        </div>
      ))}
      <svg className="absolute inset-0 size-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 1000 1000">
        {svgPrimitives.map((primitive, index) => {
          const className = `terminal-showpiece-primitive showpiece-${primitive.kind} ${primitive.kind === "node" ? `showpiece-${primitive.motion}` : primitive.kind === "path" ? `showpiece-${primitive.motion}` : ""} ${toneClass(primitive)}`
          const style = primitiveStyle(primitive)
          if (primitive.kind === "path") return <path className={className} d={primitive.points.map(({ x, y }, pointIndex) => `${pointIndex ? "L" : "M"}${x} ${y}`).join(" ")} fill="none" key={`path-${index}`} pathLength={1} style={style} />
          if (primitive.kind === "ring") return <circle className={className} cx={primitive.x} cy={primitive.y} fill="none" key={`ring-${index}`} r={primitive.size / 2} style={style} />
          if (primitive.kind === "text") return <text className={`${className} showpiece-text-${primitive.variant} showpiece-${primitive.motion}`} dominantBaseline="middle" key={`text-${index}`} style={style} textAnchor="middle" x={primitive.x} y={primitive.y}>{primitive.value}</text>
          if (primitive.shape === "circle") return <circle className={className} cx={primitive.x} cy={primitive.y} key={`node-${index}`} r={primitive.size / 2} style={style} />
          if (primitive.shape === "diamond") return <polygon className={className} key={`node-${index}`} points={`${primitive.x},${primitive.y - primitive.size / 2} ${primitive.x + primitive.size / 2},${primitive.y} ${primitive.x},${primitive.y + primitive.size / 2} ${primitive.x - primitive.size / 2},${primitive.y}`} style={style} />
          return <rect className={className} height={primitive.size} key={`node-${index}`} style={style} width={primitive.size} x={primitive.x - primitive.size / 2} y={primitive.y - primitive.size / 2} />
        })}
      </svg>
      {marks.map((primitive, index) => (
        // eslint-disable-next-line @next/next/no-img-element -- reviewed Edition assets can be animated without Next image layout state.
        <img alt="" className={`terminal-showpiece-mark showpiece-${primitive.motion}`} draggable={false} key={`mark-${index}`} src={primitive.assetUrl} style={{ ...primitiveStyle(primitive), left: `${primitive.x / 10}%`, top: `${primitive.y / 10}%`, width: `${primitive.width / 10}%`, height: `${primitive.height / 10}%` }} />
      ))}
    </div>
  )
}
