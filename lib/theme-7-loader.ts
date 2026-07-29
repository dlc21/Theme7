import type { ReviewedDistributionPackage } from "@/lib/distributions"

const MISSING_THEME_MESSAGE = "Theme 7 was selected but is not installed."
const THEME_PACKAGE = ["theme", "7"].join("-")
const nativeImport = (specifier: string): Promise<unknown> => import(/* webpackIgnore: true */ specifier)

function missingTheme(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" && error.message.includes("theme-7")
}

export function loadTheme7Distribution(options: { required: true }): Promise<ReviewedDistributionPackage>
export function loadTheme7Distribution(options: { required: false }): Promise<ReviewedDistributionPackage | null>
export async function loadTheme7Distribution({ required }: { required: boolean }): Promise<ReviewedDistributionPackage | null> {
  try {
    // Theme 7 is an optional runtime package and is intentionally absent from stock artifacts.
    const module = await nativeImport(THEME_PACKAGE) as { ompTheme7: ReviewedDistributionPackage }
    return module.ompTheme7
  } catch (error) {
    if (!missingTheme(error)) throw error
    if (required) throw new Error(MISSING_THEME_MESSAGE)
    return null
  }
}
