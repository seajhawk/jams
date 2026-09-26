/**
 * Reads a request body as UTF-8 text, giving up (null) as soon as it exceeds `maxBytes`, so an
 * unauthenticated caller cannot make the server buffer an arbitrarily large body. A declared
 * `Content-Length` over the limit is refused without reading anything.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return ""

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
