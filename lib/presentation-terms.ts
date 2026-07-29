import type { ActiveEditionPublic } from "@/lib/editions"

export type PresentationTerms = {
  workItemSingular: string
  workItemPlural: string
  workItemSingularTitle: string
  workItemPluralTitle: string
}


export function presentationTerms(active: ActiveEditionPublic | null): PresentationTerms {
  const workItemSingular = active?.terms?.workItem?.singular?.trim().replace(/\s+/g, " ") || "work lane"
  const workItemPlural = active?.terms?.workItem?.plural?.trim().replace(/\s+/g, " ") || "work lanes"
  return {
    workItemSingular,
    workItemPlural,
    workItemSingularTitle: workItemSingular.replace(/(^|\s)\S/g, (character) => character.toUpperCase()),
    workItemPluralTitle: workItemPlural.replace(/(^|\s)\S/g, (character) => character.toUpperCase()),
  }
}
