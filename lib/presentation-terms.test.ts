import { describe, expect, it } from "vitest"

import type { ActiveEditionPublic } from "@/lib/editions"
import { presentationTerms } from "@/lib/presentation-terms"

describe("presentationTerms", () => {
  it("keeps stock workspace nouns coherent", () => {
    expect(presentationTerms(null)).toEqual({
      workItemSingular: "work lane",
      workItemPlural: "work lanes",
      workItemSingularTitle: "Work Lane",
      workItemPluralTitle: "Work Lanes",
    })
  })

  it("interprets an edition's work-item terms for sentence and title contexts", () => {
    const active = {
      terms: { workItem: { singular: "  job ", plural: " jobs  " } },
    } as ActiveEditionPublic

    expect(presentationTerms(active)).toEqual({
      workItemSingular: "job",
      workItemPlural: "jobs",
      workItemSingularTitle: "Job",
      workItemPluralTitle: "Jobs",
    })
  })

  it("falls back when an edition supplies blank terms", () => {
    const active = {
      terms: { workItem: { singular: "   ", plural: "" } },
    } as ActiveEditionPublic

    expect(presentationTerms(active)).toMatchObject({
      workItemSingular: "work lane",
      workItemPlural: "work lanes",
    })
  })
})
