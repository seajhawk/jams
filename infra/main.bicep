targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment (used to derive the resource group name and resource names).')
param environmentName string

@minLength(1)
@description('Primary Azure region for all resources. Override with `azd env set AZURE_LOCATION <region>`.')
param location string = 'eastus2'

@secure()
@description('Admin login password for the PostgreSQL Flexible Server. Never committed; azd prompts for this if unset.')
param postgresAdminPassword string

@secure()
@description('Password to set for the jams_web Postgres role. Migration 0007 creates this role with a placeholder password (jams_web); this value must be applied with ALTER ROLE after the first migration run — see docs/OPERATIONS-RUNBOOK.md.')
param jamsWebDbPassword string

@secure()
@description('Password to set for the jams_worker Postgres role. Same caveat as jamsWebDbPassword.')
param jamsWorkerDbPassword string

@description('GitHub Container Registry username that owns the pull token below. Leave empty until CI publishes images to GHCR — the placeholder default image needs no credentials.')
param ghcrUsername string = ''

@secure()
@description('GitHub Container Registry personal access token (read:packages scope) used to pull the private jams-web/jams-worker images. Leave empty until one exists.')
param ghcrToken string = ''

@secure()
@description('Clerk secret key for the deployed Clerk instance.')
param clerkSecretKey string

@description('Clerk publishable key. Also required as a web image build arg (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) per docs/CONTAINERS.md; this runtime value just keeps server and client in sync.')
param clerkPublishableKey string

@secure()
@description('Clerk webhook signing secret (svix) — CLERK_WEBHOOK_SIGNING_SECRET.')
param clerkWebhookSigningSecret string

@secure()
@description('Shared secret the scheduler presents to POST /api/admin/watchdog — WATCHDOG_SECRET.')
param watchdogSecret string

@description('Comma-separated exact Clerk user IDs admitted during preview (JAMS_PREVIEW_USER_IDS). Leave empty until an invited test account is verified — see docs/OPERATIONS-RUNBOOK.md preflight step 3. Setting this to an empty string denies all participant access; omit the app setting entirely (not supported by this template) is the only way to fall back to pre-preview access rules.')
param jamsPreviewUserIds string = ''

@description('JAMS_PREVIEW_MAX_STORAGE_BYTES override.')
param jamsPreviewMaxStorageBytes string = '10737418240'

@description('JAMS_PREVIEW_MAX_ANALYSES override.')
param jamsPreviewMaxAnalyses string = '100'

@description('JAMS_PREVIEW_MAX_ACTIVE_RUNS override.')
param jamsPreviewMaxActiveRuns string = '2'

// Scale-out ceilings and usage limits (docs/design/abuse-and-scale-hardening.md). Strings so azd
// can substitute them from environment values; resources.bicep converts and range-checks them.
@description('WEB_MIN_REPLICAS: 0 (scale to zero) or 1.')
param webMinReplicas string = '0'
@description('WEB_MAX_REPLICAS: 1 or 2 (Postgres connection budget).')
param webMaxReplicas string = '1'
@description('WEB_HTTP_CONCURRENCY: concurrent requests per web replica before scaling out.')
param webHttpConcurrency string = '10'
@description('WORKER_MAX_EXECUTIONS: 0 to 8 concurrent worker executions (0 pauses analysis).')
param workerMaxExecutions string = '3'
@description('WORKER_PARALLELISM: 1 or 2 replicas per execution.')
param workerParallelism string = '1'
@description('WORKER_REPLICA_TIMEOUT_SECONDS: 600 to 7200.')
param workerReplicaTimeoutSeconds string = '3600'
@description('WORKER_POLLING_INTERVAL_SECONDS: 10 to 300.')
param workerPollingIntervalSeconds string = '30'
@description('WORKER_DRAIN_MODE: true makes each execution exit when the queue is empty.')
param workerDrainMode string = 'true'
param jamsLimitUploadMaxBytes string = '2147483648'
param jamsLimitUploadMaxDurationMs string = '1200000'
param jamsLimitOrgStorageBytes string = '10737418240'
param jamsLimitOrgActiveAnalyses string = '5'
param jamsLimitOrgAnalysesPerWindow string = '50'
param jamsLimitGlobalActiveAnalyses string = '30'
param jamsLimitGlobalUploadBytesPerDay string = '214748364800'

@description('Full jams-web image reference, e.g. ghcr.io/<org>/jams-web:<tag>. `azd deploy web` overwrites this after building apps/web/Dockerfile.')
param webImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Full jams-worker image reference, e.g. ghcr.io/<org>/jams-worker:<tag>. Update via `az containerapp job update --image` if `azd deploy worker` does not support Container Apps Jobs on the installed azd version.')
param workerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: {
    'azd-env-name': environmentName
  }
}

module resources 'resources.bicep' = {
  name: 'jams-resources'
  scope: rg
  params: {
    environmentName: environmentName
    location: location
    postgresAdminPassword: postgresAdminPassword
    jamsWebDbPassword: jamsWebDbPassword
    jamsWorkerDbPassword: jamsWorkerDbPassword
    ghcrUsername: ghcrUsername
    ghcrToken: ghcrToken
    clerkSecretKey: clerkSecretKey
    clerkPublishableKey: clerkPublishableKey
    clerkWebhookSigningSecret: clerkWebhookSigningSecret
    watchdogSecret: watchdogSecret
    jamsPreviewUserIds: jamsPreviewUserIds
    jamsPreviewMaxStorageBytes: jamsPreviewMaxStorageBytes
    jamsPreviewMaxAnalyses: jamsPreviewMaxAnalyses
    jamsPreviewMaxActiveRuns: jamsPreviewMaxActiveRuns
    webImage: webImage
    workerImage: workerImage
    webMinReplicas: int(webMinReplicas)
    webMaxReplicas: int(webMaxReplicas)
    webHttpConcurrency: int(webHttpConcurrency)
    workerMaxExecutions: int(workerMaxExecutions)
    workerParallelism: int(workerParallelism)
    workerReplicaTimeoutSeconds: int(workerReplicaTimeoutSeconds)
    workerPollingIntervalSeconds: int(workerPollingIntervalSeconds)
    workerDrainMode: bool(workerDrainMode)
    jamsLimitUploadMaxBytes: jamsLimitUploadMaxBytes
    jamsLimitUploadMaxDurationMs: jamsLimitUploadMaxDurationMs
    jamsLimitOrgStorageBytes: jamsLimitOrgStorageBytes
    jamsLimitOrgActiveAnalyses: jamsLimitOrgActiveAnalyses
    jamsLimitOrgAnalysesPerWindow: jamsLimitOrgAnalysesPerWindow
    jamsLimitGlobalActiveAnalyses: jamsLimitGlobalActiveAnalyses
    jamsLimitGlobalUploadBytesPerDay: jamsLimitGlobalUploadBytesPerDay
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.storageAccountName
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = resources.outputs.environmentName
output AZURE_POSTGRES_SERVER_FQDN string = resources.outputs.postgresFqdn
output SERVICE_WEB_URI string = resources.outputs.webFqdn
output SERVICE_WEB_NAME string = resources.outputs.webAppName
output SERVICE_WORKER_NAME string = resources.outputs.workerJobName
