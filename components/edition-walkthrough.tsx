"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { Dialog } from "radix-ui"

import { Button } from "@/components/ui/button"
import type { EditionWalkthroughPublic, EditionWalkthroughTarget } from "@/lib/editions"

type Placement = "left" | "right" | "top" | "bottom"
type CoachmarkLayout = {
  target: { left: number; top: number; width: number; height: number }
  card: { left: number; top: number; width: number; height: number }
  placement: Placement
  arrowOffset: number
}

const EDGE_GAP = 12
const TARGET_GAP = 14
const TARGET_PADDING = 6
const MAX_CARD_WIDTH = 360
const MIN_SIDE_WIDTH = 280

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function visibleTarget(selector: string): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(selector)
  for (const element of elements) {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    if (style.display === "none" || style.visibility === "hidden" || rect.width < 1 || rect.height < 1) continue
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue
    return element
  }
  return null
}

function walkthroughTarget(target?: EditionWalkthroughTarget): HTMLElement | null {
  if (!target) return visibleTarget('[data-operator-engine-slot="onboarding"]')
  return visibleTarget(`[data-operator-engine-walkthrough-target="${target}"]`)
    ?? visibleTarget(`[data-operator-engine-walkthrough-fallback="${target}"]`)
}


const ARROW_CLASSES: Record<Placement, string> = {
  left: "-right-2 border-r border-t",
  right: "-left-2 border-b border-l",
  top: "-bottom-2 border-b border-r",
  bottom: "-top-2 border-l border-t",
}

export function EditionWalkthrough({ walkthrough, hasLanes, onClose, onChooseFolder, onTargetChange }: {
  walkthrough: EditionWalkthroughPublic
  hasLanes: boolean
  onClose: () => void
  onChooseFolder: () => void
  onTargetChange?: (target?: EditionWalkthroughTarget) => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [layout, setLayout] = useState<CoachmarkLayout | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const step = walkthrough.steps[stepIndex]
  const finalStep = stepIndex === walkthrough.steps.length - 1

  useEffect(() => onTargetChange?.(step.target), [onTargetChange, step.target])

  const updateLayout = useCallback(() => {
    const element = walkthroughTarget(step.target)
    if (!element) {
      setLayout(null)
      return
    }

    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const raw = element.getBoundingClientRect()
    const target = {
      left: Math.max(0, Math.round(raw.left - TARGET_PADDING)),
      top: Math.max(0, Math.round(raw.top - TARGET_PADDING)),
      width: Math.round(Math.min(viewportWidth, raw.right + TARGET_PADDING) - Math.max(0, raw.left - TARGET_PADDING)),
      height: Math.round(Math.min(viewportHeight, raw.bottom + TARGET_PADDING) - Math.max(0, raw.top - TARGET_PADDING)),
    }
    const measuredCard = cardRef.current?.getBoundingClientRect()
    const cardHeight = Math.min(measuredCard?.height ?? 360, viewportHeight - EDGE_GAP * 2)
    const available = {
      right: viewportWidth - (target.left + target.width) - TARGET_GAP - EDGE_GAP,
      left: target.left - TARGET_GAP - EDGE_GAP,
      bottom: viewportHeight - (target.top + target.height) - TARGET_GAP - EDGE_GAP,
      top: target.top - TARGET_GAP - EDGE_GAP,
    }

    let placement: Placement
    if (available.right >= MIN_SIDE_WIDTH) placement = "right"
    else if (available.left >= MIN_SIDE_WIDTH) placement = "left"
    else if (available.bottom >= cardHeight) placement = "bottom"
    else if (available.top >= cardHeight) placement = "top"
    else placement = (Object.entries(available).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "bottom") as Placement

    const horizontal = placement === "left" || placement === "right"
    const cardWidth = Math.round(horizontal
      ? Math.min(MAX_CARD_WIDTH, Math.max(240, available[placement]))
      : Math.min(MAX_CARD_WIDTH, viewportWidth - EDGE_GAP * 2))
    const cardLeft = placement === "right"
      ? target.left + target.width + TARGET_GAP
      : placement === "left"
        ? target.left - TARGET_GAP - cardWidth
        : raw.left + raw.width / 2 - cardWidth / 2
    const cardTop = placement === "bottom"
      ? target.top + target.height + TARGET_GAP
      : placement === "top"
        ? target.top - TARGET_GAP - cardHeight
        : raw.top + raw.height / 2 - cardHeight / 2
    const left = Math.round(clamp(cardLeft, EDGE_GAP, viewportWidth - cardWidth - EDGE_GAP))
    const top = Math.round(clamp(cardTop, EDGE_GAP, viewportHeight - cardHeight - EDGE_GAP))
    const arrowOffset = horizontal
      ? clamp(raw.top + raw.height / 2 - top, 24, cardHeight - 24)
      : clamp(raw.left + raw.width / 2 - left, 24, cardWidth - 24)

    const nextLayout = {
      target,
      card: { left, top, width: cardWidth, height: Math.round(cardHeight) },
      placement,
      arrowOffset: Math.round(arrowOffset),
    }
    setLayout((current) => current
      && current.target.left === nextLayout.target.left
      && current.target.top === nextLayout.target.top
      && current.target.width === nextLayout.target.width
      && current.target.height === nextLayout.target.height
      && current.card.left === nextLayout.card.left
      && current.card.top === nextLayout.card.top
      && current.card.width === nextLayout.card.width
      && current.card.height === nextLayout.card.height
      && current.placement === nextLayout.placement
      && current.arrowOffset === nextLayout.arrowOffset
      ? current
      : nextLayout)
  }, [step.target])

  useLayoutEffect(() => {
    let frame = 0
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateLayout)
    }
    schedule()
    window.addEventListener("resize", schedule)
    window.addEventListener("scroll", schedule, true)
    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.body, { attributes: true, attributeFilter: ["aria-hidden", "class"], childList: true, subtree: true })
    const resizeObserver = new ResizeObserver(schedule)
    if (cardRef.current) resizeObserver.observe(cardRef.current)
    const target = walkthroughTarget(step.target)
    if (target) resizeObserver.observe(target)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [step.target, updateLayout])

  const cardStyle: CSSProperties = layout
    ? { left: layout.card.left, top: layout.card.top, width: layout.card.width }
    : { left: "50%", top: "50%", width: `min(${MAX_CARD_WIDTH}px, calc(100vw - ${EDGE_GAP * 2}px))`, transform: "translate(-50%, -50%)" }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[110] bg-transparent" />
      {layout ? <div
        data-operator-engine-walkthrough-spotlight={step.target ?? "onboarding"}
        aria-hidden="true"
        className="pointer-events-none fixed z-[111] rounded-xl ring-2 ring-primary/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.74),0_0_28px_4px_rgb(0_0_0/0.28)] transition-[left,top,width,height] duration-200 motion-reduce:transition-none"
        style={layout.target}
      /> : <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[111] bg-black/75" />}
      <Dialog.Content
        data-operator-engine-walkthrough-placement={layout?.placement}
        className="fixed z-[112] max-h-[calc(100svh-1.5rem)] outline-none transition-[left,top,width] duration-200 motion-reduce:transition-none"
        style={cardStyle}
      >
        {layout ? <div aria-hidden="true" className={`absolute size-4 rotate-45 bg-background ${ARROW_CLASSES[layout.placement]}`} style={layout.placement === "left" || layout.placement === "right" ? { top: layout.arrowOffset - 8 } : { left: layout.arrowOffset - 8 }} /> : null}
        <div ref={cardRef} data-operator-engine-slot="onboarding-walkthrough" className="relative flex max-h-[calc(100svh-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <div key={step.id} data-operator-engine-walkthrough-scene={step.id} className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="flex items-center">
              <span className="flex gap-1" aria-label={`Step ${stepIndex + 1} of ${walkthrough.steps.length}`}>{walkthrough.steps.map((item, index) => <span key={item.id} aria-hidden="true" className={`h-1.5 rounded-full ${index === stepIndex ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30"}`} />)}</span>
              <button type="button" aria-label="Skip walkthrough" onClick={onClose} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Skip</button>
            </div>
            <Dialog.Title className="mt-5 text-lg font-semibold tracking-tight">{step.title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">{step.description}</Dialog.Description>
          </div>
          <footer className="flex shrink-0 items-center gap-2 border-t border-border/70 bg-background/70 px-5 py-3">
            {stepIndex > 0 ? <Button type="button" variant="ghost" onClick={() => setStepIndex((current) => Math.max(0, current - 1))}>Back</Button> : null}
            {finalStep
              ? <Button className="ml-auto" type="button" onClick={onChooseFolder}>{hasLanes ? "Add another job" : "Add your first job"}</Button>
              : <Button className="ml-auto" type="button" onClick={() => setStepIndex((current) => Math.min(walkthrough.steps.length - 1, current + 1))}>Next</Button>}
          </footer>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
