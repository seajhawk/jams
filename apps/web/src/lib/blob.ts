import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob"

export const videosContainerName = "videos"

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
    readonly status: 400 | 409
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

async function videosContainerClient() {
  const container = blobServiceClient().getContainerClient(videosContainerName)
  await container.createIfNotExists()
  return container
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
  expectedSize: number | null
): Promise<{ blobPath: string }> {
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

  if (expectedSize !== null && properties.contentLength !== expectedSize) {
    throw new BlobFinalizationError(
      "Uploaded blob size does not match requested size",
      400
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

  return { blobPath: destinationPath }
}
