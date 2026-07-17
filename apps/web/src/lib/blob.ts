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
