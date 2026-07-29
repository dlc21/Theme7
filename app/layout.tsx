import type { Metadata } from "next"
import type { ReactNode } from "react"
import { runtimeCapabilities } from "@/lib/distributions"

import "./globals.css"

export async function generateMetadata(): Promise<Metadata> {
  const { edition } = await runtimeCapabilities()
  if (edition.locked && !edition.active) {
    return { title: "Product unavailable", description: "The required product presentation could not be loaded." }
  }
  return {
    title: edition.active?.brand?.productName ?? "Theme7",
    description: edition.active?.description ?? "One operator, real directories, Git, and terminal-first AI harnesses.",
  }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="/api/editions/assets/theme.css" />
      </head>
      <body>{children}</body>
    </html>
  )
}
