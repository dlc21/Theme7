"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import type { GuidedOnboardingPublic } from "@/lib/distributions"

type Props = {
  onboarding: GuidedOnboardingPublic
  stepId: string | null
  intro: boolean
  unavailable?: boolean
  busy?: boolean
  onIntroAction: () => void
  onAdvance: () => void
  onSkip: () => void
}

export function DistributionOnboarding({ onboarding, stepId, intro, unavailable, busy, onIntroAction, onAdvance, onSkip }: Props) {
  const stepIndex = onboarding.steps.findIndex((candidate) => candidate.id === stepId)
  const step = stepIndex >= 0 ? onboarding.steps[stepIndex] : undefined
  const [cardPosition, setCardPosition] = useState<{ top: number; left: number } | null>(null)
  const [targetRect, setTargetRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  useEffect(() => {
    if (!step) {
      setCardPosition(null)
      setTargetRect(null)
      return
    }
    const targets = Array.from(document.querySelectorAll<HTMLElement>(`[data-distribution-onboarding-target="${step.target}"]`))
    const target = targets.find((candidate) => candidate.getClientRects().length > 0)
    if (!target) return
    target.dataset.distributionOnboardingActive = "true"

    const updatePosition = () => {
      target.scrollIntoView({ block: "nearest", inline: "nearest" })
      const rect = target.getBoundingClientRect()
      setTargetRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
      const cardHeight = 190
      const top = rect.bottom + 16 + cardHeight <= window.innerHeight - 16 ? rect.bottom + 16 : Math.max(16, rect.top - cardHeight - 16)
      setCardPosition({ top, left: Math.min(Math.max(rect.left + rect.width / 2, 220), window.innerWidth - 220) })
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      delete target.dataset.distributionOnboardingActive
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [step])

  if (!intro && !step) return null
  const title = intro ? onboarding.intro.title : step?.title
  const description = intro ? null : unavailable ? "the sample is unavailable, so your files were not changed" : step?.description
  const targetAction = step?.advance === "target-action"
  const progress = intro ? 0 : stepIndex + 1
  const actionLabel = step?.id === "this-is-the-browser" ? "start working" : unavailable ? "back to files" : "continue"
  const cardStyle = !intro && cardPosition ? { top: cardPosition.top, left: cardPosition.left, transform: "translateX(-50%)" } : undefined
  const cardClass = intro || !cardPosition ? "bottom-5 left-1/2 -translate-x-1/2" : ""

  return <div className="fixed inset-0 z-[140] pointer-events-none" role="dialog" aria-modal="false" aria-label={title}>
    {/* Dimmed backdrop */}
    <div className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-300 pointer-events-none z-[140]" />
    <style>{`
      @keyframes onboarding-bounce-x {
        0%, 100% { transform: translateX(0); }
        50% { transform: translateX(6px); }
      }
      .animate-onboarding-bounce-x {
        animation: onboarding-bounce-x 1.2s infinite ease-in-out;
      }
      [data-onboarding-spotlight] {
        border-color: transparent !important;
        border-image: linear-gradient(135deg, var(--omp-magenta) 0%, var(--omp-iris) 45%, var(--omp-cyan) 100%) 1 !important;
        box-shadow: 0 0 20px color-mix(in oklch, var(--omp-cyan) 60%, transparent), 0 0 35px color-mix(in oklch, var(--omp-iris) 40%, transparent) !important;
      }
      [data-onboarding-arrow] {
        color: var(--omp-cyan) !important;
        filter: drop-shadow(0 0 10px color-mix(in oklch, var(--omp-cyan) 80%, transparent)) drop-shadow(0 0 18px color-mix(in oklch, var(--omp-iris) 60%, transparent)) !important;
      }
      [data-onboarding-card] {
        border-color: color-mix(in oklch, var(--omp-cyan) 30%, var(--border)) !important;
        box-shadow: 0 0 0 1px color-mix(in oklch, var(--omp-cyan) 15%, transparent), 0 24px 64px -28px color-mix(in oklch, var(--omp-cyan) 40%, transparent) !important;
      }
      [data-onboarding-step-bar="true"] {
        background: linear-gradient(90deg, var(--omp-cyan) 0%, var(--omp-iris) 50%, var(--omp-magenta) 100%) !important;
      }
      [data-onboarding-badge] {
        background-color: color-mix(in oklch, var(--omp-cyan) 20%, transparent) !important;
        color: var(--omp-cyan) !important;
        border-color: color-mix(in oklch, var(--omp-cyan) 40%, transparent) !important;
      }
    `}</style>

    {/* Unclipped top-level spotlight ring */}
    {!intro && targetRect && step?.target !== "directory-picker" ? (
      <div
        data-onboarding-spotlight
        style={{
          position: "fixed",
          top: targetRect.top - 4,
          left: targetRect.left - 4,
          width: targetRect.width + 8,
          height: targetRect.height + 8,
          pointerEvents: "none",
          zIndex: 160,
        }}
        className="rounded-xl border-2 border-primary shadow-[0_0_20px_var(--ring)]"
      >
        <div className="absolute inset-0 rounded-xl animate-pulse border border-primary/50" />
      </div>
    ) : null}

    {/* Floating bouncing arrow */}
    {!intro && targetRect && step?.target !== "directory-picker" ? (
      <div
        data-onboarding-arrow
        style={{
          position: "fixed",
          top: targetRect.top + targetRect.height / 2 - 14,
          left: targetRect.left + targetRect.width + 12,
          pointerEvents: "none",
          zIndex: 161,
        }}
        className="flex items-center gap-1.5 font-bold text-primary text-sm drop-shadow-[0_0_8px_var(--ring)] animate-onboarding-bounce-x"
      >
        <span className="text-xl leading-none">←</span>
      </div>
    ) : null}

    <section data-onboarding-card style={cardStyle} className={`pointer-events-auto fixed w-[min(92vw,420px)] rounded-xl border border-border bg-background p-5 shadow-2xl z-[210] ${cardClass} ${step?.target === "directory-picker" ? "hidden" : ""}`}>
      {!intro ? <div className="mb-3 flex items-center gap-3" aria-label={`Step ${progress} of ${onboarding.steps.length}`}>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">step {progress} of {onboarding.steps.length}</span>
        <span className="flex h-1 flex-1 gap-1" aria-hidden>{onboarding.steps.map((candidate, index) => <i key={candidate.id} data-onboarding-step-bar={index < progress ? "true" : undefined} className={`h-1 flex-1 rounded-full ${index < progress ? "bg-primary" : "bg-border"}`} />)}</span>
      </div> : null}
      <h2 className="text-base font-semibold lowercase">{title}</h2>
      {intro ? onboarding.intro.lines.length ? <div className="mt-3 space-y-1 text-sm text-muted-foreground">{onboarding.intro.lines.map((line) => <p key={line}>{line}</p>)}</div> : null : <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onSkip}>skip tour</Button>
        {intro ? (
          <Button onClick={onIntroAction}>{onboarding.intro.actionLabel}</Button>
        ) : targetAction && targetRect ? (
          <span data-onboarding-badge className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
            </span>
            click target to continue
          </span>
        ) : (
          <Button disabled={busy} onClick={onAdvance}>{actionLabel}</Button>
        )}
      </div>
    </section>
  </div>
}
