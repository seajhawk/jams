import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob"

export const videosContainerName = "videos"
export const derivedContainerName = "derived"

const BLOB_REQUEST_TIMEOUT_MS = 20_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const AZURITE_ACCOUNT_NAME = "devstoreaccount1"
const AZURITE_ACCOUNT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="
const AZURITE_BLOB_ENDPOINT = "http://127.0.0.1:10000/devstoreaccount1"

type StorageConfig = {
  accountName: string
  accountKey: string
  blobEndpoint?: string
}

type SasResult = {
  url: string
  expiresAt: string
}

export class BlobFinalizationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    /** True when the uploaded blob broke a size rule and has been deleted. */
    readonly rejected = false
  ) {
    super(message)
    this.name = "BlobFinalizationError"
  }
}

function parseConnectionString(connectionString: string): StorageConfig {
  if (connectionString.includes("UseDevelopmentStorage=true")) {
    return {
      accountName: AZURITE_ACCOUNT_NAME,
      accountKey: AZURITE_ACCOUNT_KEY,
      blobEndpoint: AZURITE_BLOB_ENDPOINT,
    }
  }

  const parts = new Map(
    connectionString
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=")
        return [part.slice(0, separator), part.slice(separator + 1)]
      })
  )

  const accountName = parts.get("AccountName")
  const accountKey = parts.get("AccountKey")

  if (!accountName || !accountKey) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING must include AccountName and AccountKey")
  }

  return {
    accountName,
    accountKey,
    blobEndpoint: parts.get("BlobEndpoint"),
  }
}

function storageConfig() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required")
  }

  return {
    connectionString,
    ...parseConnectionString(connectionString),
  }
}

function sharedKeyCredential(config: StorageConfig) {
  return new StorageSharedKeyCredential(config.accountName, config.accountKey)
}

function blobServiceClient() {
  return BlobServiceClient.fromConnectionString(storageConfig().connectionString)
}

let videosContainerReady: Promise<unknown> | null = null

/**
 * The container is provisioned by infra (and created here for local Azurite), so checking it
 * once per process is enough. Before this, every SAS mint made a PUT to Storage even though
 * signing a SAS is purely local, and it did so inside request transactions.
 */
async function videosContainerClient() {
  const container = blobServiceClient().getContainerClient(videosContainerName)
  if (!videosContainerReady) {
    videosContainerReady = container.createIfNotExists().catch((error: unknown) => {
      // Never cache a failure: the next caller should try again rather than inherit it.
      videosContainerReady = null
      throw error
    })
  }
  await videosContainerReady
  return container
}

/** Test seam: forget the once-per-process container check. */
export function resetBlobContainerCacheForTests() {
  videosContainerReady = null
}

export function isSafeBlobPath(blobPath: string) {
  return (
    blobPath.length > 0 &&
    !blobPath.startsWith("/") &&
    !blobPath.includes("..") &&
    !blobPath.includes("\\")
  )
}

function assertSafeBlobPath(blobPath: string) {
  if (!isSafeBlobPath(blobPath)) {
    throw new Error("Invalid blob path")
  }
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  )
}

function isNotFound(error: unknown): boolean {
  return hasStatusCode(error) && error.statusCode === 404
}

function assertCleanupScope(orgId: string, videoId: string, runIds: readonly string[]): void {
  if (!ORG_ID_PATTERN.test(orgId) || !UUID_PATTERN.test(videoId)) {
    throw new Error("Invalid recording cleanup scope")
  }
  if (!Array.isArray(runIds) || runIds.some((runId) => !UUID_PATTERN.test(runId))) {
    throw new Error("Invalid recording cleanup scope")
  }
}

/**
 * Repeatedly sweeps all server-owned blobs for a recording and its analysis runs.
 * The database deletion must coordinate with this sweep; Blob Storage itself is not
 * atomic across the two containers or across multiple prefixes.
 */
export async function cleanupRecordingBlobs(input: {
  orgId: string
  videoId: string
  runIds: readonly string[]
}): Promise<void> {
  const { orgId, videoId, runIds } = input
  assertCleanupScope(orgId, videoId, runIds)

  const videoPrefix = `${orgId}/${videoId}/`
  const derivedPrefixes = [
    ...new Set([
      ...runIds.map((runId) => `runs/${runId}/`),
      videoPrefix,
    ]),
  ]

  const service = blobServiceClient()
  const abortSignal = AbortSignal.timeout(BLOB_REQUEST_TIMEOUT_MS)
  const containers = [
    { name: videosContainerName, prefixes: [videoPrefix] },
    { name: derivedContainerName, prefixes: derivedPrefixes },
  ]

  for (const { name, prefixes } of containers) {
    const container = service.getContainerClient(name)
    for (const prefix of prefixes) {
      let blobs: AsyncIterable<{ name: string; snapshot?: string; versionId?: string; isCurrentVersion?: boolean }>
      try {
        blobs = container.listBlobsFlat({
          prefix,
          includeSnapshots: true,
          includeVersions: true,
          abortSignal,
        })
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }

      try {
        for await (const item of blobs) {
          if (!item.name.startsWith(prefix)) {
            throw new Error("Storage enumeration escaped cleanup prefix")
          }
          let blob = container.getBlobClient(item.name)
          let deleteOptions: Parameters<typeof blob.deleteIfExists>[0] = {
            abortSignal,
          }
          if (item.versionId) {
            if (item.isCurrentVersion) {
              // A current version must first become a retained historical
              // version through base deletion before its version ID is deleted.
              await blob.deleteIfExists({ deleteSnapshots: "include", abortSignal })
            }
            blob = blob.withVersion(item.versionId)
            deleteOptions = { abortSignal }
          } else if (item.snapshot) {
            blob = blob.withSnapshot(item.snapshot)
            deleteOptions = { abortSignal }
          } else {
            deleteOptions = { deleteSnapshots: "include", abortSignal }
          }
          try {
            await blob.deleteIfExists(deleteOptions)
          } catch (error) {
            if (!isNotFound(error)) throw error
          }
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
  }
}

async function mintBlobSas(
  blobPath: string,
  permissions: string,
  ttlMinutes: number,
  contentType?: string
): Promise<SasResult> {
  assertSafeBlobPath(blobPath)

  const config = storageConfig()
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000)
  const container = await videosContainerClient()
  const blob = container.getBlockBlobClient(blobPath)

  const sas = generateBlobSASQueryParameters(
    {
      blobName: blobPath,
      containerName: videosContainerName,
      contentType,
      expiresOn: expiresAt,
      permissions: BlobSASPermissions.parse(permissions),
    },
    sharedKeyCredential(config)
  ).toString()

  return {
    url: `${blob.url}?${sas}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export function mintUploadSas(blobPath: string, contentType: string) {
  return mintBlobSas(blobPath, "cw", 15, contentType)
}

export function mintReadSas(blobPath: string) {
  return mintBlobSas(blobPath, "r", 60)
}

export async function blobStats(blobPath: string) {
  assertSafeBlobPath(blobPath)

  const container = await videosContainerClient()
  const blob = container.getBlockBlobClient(blobPath)

  try {
    const properties = await blob.getProperties()
    return {
      exists: true,
      sizeBytes: properties.contentLength ?? null,
      contentType: properties.contentType ?? null,
    }
  } catch (error) {
    if (hasStatusCode(error) && error.statusCode === 404) {
      return { exists: false, sizeBytes: null, contentType: null }
    }

    throw error
  }
}

/**
 * Copies an uploaded blob to a fresh server-owned path while pinning the
 * source ETag. The original remains untouched, but the destination is never
 * returned with a client write SAS.
 */
export async function finalizeBlob(
  sourcePath: string,
  expectedSize: number | null,
  options: { maxBytes?: number } = {}
): Promise<{ blobPath: string; sizeBytes: number }> {
  assertSafeBlobPath(sourcePath)

  const container = await videosContainerClient()
  const source = container.getBlockBlobClient(sourcePath)
  let properties: Awaited<ReturnType<typeof source.getProperties>>
  try {
    properties = await source.getProperties()
  } catch (error) {
    if (hasStatusCode(error) && error.statusCode === 404) {
      throw new BlobFinalizationError("Uploaded blob was not found", 409)
    }
    throw error
  }

  // The write SAS cannot cap what a client uploads, so this is the authoritative size check. A
  // blob that breaks it is deleted rather than left to accumulate storage cost.
  const actualSize = properties.contentLength
  const sizeMismatch = expectedSize !== null && actualSize !== expectedSize
  const oversize =
    options.maxBytes !== undefined && (actualSize === undefined || actualSize > options.maxBytes)
  if (sizeMismatch || oversize) {
    await source.deleteIfExists({ deleteSnapshots: "include" })
    throw new BlobFinalizationError(
      sizeMismatch
        ? "Uploaded blob size does not match requested size"
        : "Uploaded blob is larger than the upload limit",
      400,
      true
    )
  }
  if (!properties.etag) {
    throw new BlobFinalizationError("Uploaded blob has no ETag", 409)
  }

  const sourceParts = sourcePath.split("/")
  const sourceName = sourceParts.pop()
  if (!sourceName) {
    throw new BlobFinalizationError("Invalid uploaded blob path", 400)
  }
  const destinationPath = [
    ...sourceParts,
    "finalized",
    crypto.randomUUID(),
    sourceName,
  ].join("/")
  const destination = container.getBlockBlobClient(destinationPath)
  const { url: sourceUrl } = await mintReadSas(sourcePath)

  try {
    const copy = await destination.beginCopyFromURL(sourceUrl, {
      sourceConditions: { ifMatch: properties.etag },
      conditions: { ifNoneMatch: "*" },
    })
    const result = await copy.pollUntilDone()
    if (result.copyStatus !== "success") {
      throw new BlobFinalizationError("Uploaded blob copy did not complete", 409)
    }
  } catch (error) {
    if (hasStatusCode(error) && (error.statusCode === 409 || error.statusCode === 412)) {
      throw new BlobFinalizationError("Uploaded blob changed during finalization", 409)
    }
    throw error
  }

  return { blobPath: destinationPath, sizeBytes: actualSize ?? 0 }
}

/**
 * Deletes one server-known blob (and its snapshots) from the videos container. Returns false if
 * it did not exist. Used to remove client-writable upload paths after their SAS has expired.
 */
export async function deleteVideoBlob(blobPath: string): Promise<boolean> {
  assertSafeBlobPath(blobPath)
  const container = await videosContainerClient()
  const result = await container
    .getBlockBlobClient(blobPath)
    .deleteIfExists({ deleteSnapshots: "include", abortSignal: AbortSignal.timeout(BLOB_REQUEST_TIMEOUT_MS) })
  return result.succeeded
}
