import { redirect } from "next/navigation"

import { Workbench } from "@/components/workbench"
import { DistributionProvider } from "@/components/distribution-provider"
import { t4IntegrationConfig } from "@/lib/config"
import { listLanes } from "@/lib/db"
import { runtimeCapabilities } from "@/lib/distributions"

export const dynamic = "force-dynamic"

export default async function Home() {
  const lanes = listLanes()
  if (lanes[0]) redirect(`/lanes/${encodeURIComponent(lanes[0].id)}`)
  return <DistributionProvider initial={await runtimeCapabilities()}><Workbench initialLanes={lanes} initialSelectedLaneId="" t4Integration={t4IntegrationConfig()} /></DistributionProvider>
}
