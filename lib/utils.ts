import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function browserStorageGet(key: string): string | null {
  if (typeof window === "undefined") return null
  try { return window.localStorage.getItem(key) } catch { return null }
}


export function browserStorageSet(key: string, value: string): boolean {
  if (typeof window === "undefined") return false
  try { window.localStorage.setItem(key, value); return true } catch { return false }
}
