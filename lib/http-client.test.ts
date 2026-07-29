import { describe, expect, it } from "vitest"
import { readJsonResponse } from "@/lib/http-client"

describe("readJsonResponse", () => {
  it("returns successful JSON and tolerates an empty body", async () => { expect(await readJsonResponse<{ ok?: boolean }>(new Response('{"ok":true}'), "fallback")).toEqual({ ok: true }); expect(await readJsonResponse(new Response(null, { status: 204 }), "fallback")).toEqual({}) })
  it("uses API errors before the domain fallback", async () => { await expect(readJsonResponse(new Response('{"error":"specific"}', { status: 400 }), "fallback")).rejects.toThrow("specific"); await expect(readJsonResponse(new Response("bad", { status: 500 }), "fallback")).rejects.toThrow("fallback") })
})
