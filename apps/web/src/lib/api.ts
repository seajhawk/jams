import { NextResponse } from "next/server"
import { z } from "zod"

import { HttpError } from "@/lib/http-error"
import { isUnauthorized } from "@/lib/with-org"
import { PreviewAccessError } from "@/lib/preview-access"

export { HttpError }

export function jsonError(message: string, status: number, retryAfterSeconds?: number) {
  const headers: Record<string, string> = {}
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterSeconds)))
  }
  return NextResponse.json({ error: message }, { status, headers })
}

export async function parseJsonBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, "Invalid JSON body")
  }

  const result = schema.safeParse(body)
  if (!result.success) {
    throw new HttpError(400, z.prettifyError(result.error))
  }

  return result.data
}

export function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}

export function handleRouteError(error: unknown) {
  if (error instanceof PreviewAccessError) {
    return jsonError(error.message, error.status)
  }

  if (isUnauthorized(error)) {
    return jsonError("Authentication required", 401)
  }

  if (error instanceof HttpError) {
    return jsonError(error.message, error.status, error.retryAfterSeconds)
  }

  throw error
}
