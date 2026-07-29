import { notFound } from "next/navigation"

import { DistributionProvider } from "@/components/distribution-provider"
import { Workbench } from "@/components/workbench"
import { t4IntegrationConfig } from "@/lib/config"
import { getLane, listLanes } from "@/lib/db"
import { runtimeCapabilities } from "@/lib/distributions"

export const dynamic = "force-dynamic"

export default async function LanePage({ params }: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await params
  if (!getLane(laneId)) notFound()
  return <DistributionProvider initial={await runtimeCapabilities()}><Workbench initialLanes={listLanes()} initialSelectedLaneId={laneId} t4Integration={t4IntegrationConfig()} /></DistributionProvider>
}
