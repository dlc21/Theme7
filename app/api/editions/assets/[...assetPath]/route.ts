import { activeDistributionAsset } from "@/lib/distributions"
import { activeAsset } from "@/lib/editions"

export const dynamic = "force-dynamic"
type Context = { params: Promise<{ assetPath: string[] }> }
export async function GET(request: Request, context: Context) {
  const relative = (await context.params).assetPath.map(decodeURIComponent).join("/")
  const asset = await activeDistributionAsset(relative) ?? await activeAsset(relative)
  if (!asset) return new Response("Not found", { status: 404 })
  if (request.headers.get("if-none-match") === asset.etag) return new Response(null, { status: 304, headers: { ETag: asset.etag } })
  return new Response(new Uint8Array(asset.bytes), { headers: { "content-type": asset.mime, "cache-control": "no-cache", ETag: asset.etag, "x-content-type-options": "nosniff" } })
}
