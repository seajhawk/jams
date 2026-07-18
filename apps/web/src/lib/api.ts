import { NextResponse } from "next/server"
import { z } from "zod"

import { isUnauthorized } from "@/lib/with-org"

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
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
  if (isUnauthorized(error)) {
    return jsonError("Authentication required", 401)
  }

  if (error instanceof HttpError) {
    return jsonError(error.message, error.status)
  }

  throw error
}
