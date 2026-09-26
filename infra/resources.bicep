@minLength(1)
@maxLength(64)
param environmentName string

param location string = resourceGroup().location

@secure()
param postgresAdminPassword string
@secure()
param jamsWebDbPassword string
@secure()
param jamsWorkerDbPassword string

@description('Leave empty until a GHCR pull token exists (no publish-to-GHCR step is wired into CI yet). The placeholder default image is public and needs no registry credentials.')
param ghcrUsername string = ''
@secure()
param ghcrToken string = ''

@secure()
param clerkSecretKey string
param clerkPublishableKey string
@secure()
param clerkWebhookSigningSecret string
@secure()
param watchdogSecret string

param jamsPreviewUserIds string
param jamsPreviewMaxStorageBytes string
param jamsPreviewMaxAnalyses string
param jamsPreviewMaxActiveRuns string

param webImage string
param workerImage string

// ---------------------------------------------------------------------------
// Scale-out ceilings (docs/design/abuse-and-scale-hardening.md). Defaults are the values this
// template shipped with. The bounds keep a typo from deploying an unbounded fleet, and they are
// sized to the B1ms Postgres budget of 35 user connections: each web replica holds up to 13
// (web pool 10 + admin pool 3) and each worker replica about 2, so keep
// 13 x webMaxReplicas + 2 x workerMaxExecutions x workerParallelism <= 35.
// ---------------------------------------------------------------------------

@minValue(0)
@maxValue(1)
@description('Web replicas kept warm. 0 scales to zero (cold starts); 1 removes them for about $10-15/month.')
param webMinReplicas int = 0

@minValue(1)
@maxValue(2)
@description('Hard ceiling on web replicas. Capped at 2 by the Postgres connection budget.')
param webMaxReplicas int = 1

@minValue(1)
@maxValue(100)
@description('Concurrent HTTP requests per web replica before another replica is added (the Container Apps default is 10).')
param webHttpConcurrency int = 10

@minValue(0)
@maxValue(8)
@description('Hard ceiling on concurrent worker executions, which bounds worker spend at about $0.43 per execution-hour. 0 pauses analysis (messages wait in the queue).')
param workerMaxExecutions int = 3

@minValue(1)
@maxValue(2)
@description('Replicas per worker execution. Each replica drains the same queue, so this multiplies concurrency like workerMaxExecutions does.')
param workerParallelism int = 1

@minValue(600)
@maxValue(7200)
@description('Seconds before a worker execution is killed. A 20-minute recording takes up to about 40 minutes.')
param workerReplicaTimeoutSeconds int = 3600

@minValue(10)
@maxValue(300)
@description('Seconds between KEDA queue checks when the worker is scaled to zero.')
param workerPollingIntervalSeconds int = 30

@description('Run the worker with --drain so an execution exits once the queue is empty instead of polling until replicaTimeout (and billing) runs out.')
param workerDrainMode bool = true

// Usage limits read by apps/web/src/lib/limits.ts (and the shared media limits by the worker).
// Strings, like the preview limits above, because they are passed through as env values.
param jamsLimitUploadMaxBytes string = '2147483648'
param jamsLimitUploadMaxDurationMs string = '1200000'
param jamsLimitOrgStorageBytes string = '10737418240'
param jamsLimitOrgActiveAnalyses string = '5'
param jamsLimitOrgAnalysesPerWindow string = '50'
param jamsLimitGlobalActiveAnalyses string = '30'
param jamsLimitGlobalUploadBytesPerDay string = '214748364800'

// Short, readable names for anything scoped only to this resource group.
// A short uniqueness suffix is added only to the two resources with
// globally-unique naming requirements (storage account, Postgres server).
var shortEnv = replace(environmentName, '-', '')
var uniqueSuffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 4)
// Bounded copy of environmentName for resources with tight name-length limits
// (Postgres/Log Analytics/ACA env allow 63 or fewer chars) — keeps names
// readable while guaranteeing the uniqueness suffix never gets truncated off.
var envForNaming = take(environmentName, 40)
// No GHCR publish step exists in CI yet; skip registry credentials entirely
// until a real pull token is supplied, so the placeholder public image can
// deploy without one.
var hasGhcrCredentials = !empty(ghcrUsername)
var tags = {
  'azd-env-name': environmentName
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${envForNaming}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: 1
    }
  }
}

// ---------------------------------------------------------------------------
// Storage: blobs (videos, derived) + queues (analysis-jobs, analysis-jobs-poison)
// ---------------------------------------------------------------------------

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: toLower('st${take(shortEnv, 14)}${uniqueSuffix}')
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    networkAcls: {
      defaultAction: 'Allow'
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    // The browser uploads straight to Blob with a SAS URL and streams playback from one, so the
    // account must allow the web origin. Without this every browser upload fails with a bare
    // "Failed to fetch": CORS is enforced by the browser, so curl-based tests pass regardless.
    // Derived from the environment's default domain rather than the web app resource to avoid a
    // dependency cycle through the storage connection string the app consumes.
    cors: {
      corsRules: [
        {
          allowedOrigins: [ 'https://jams-web.${managedEnvironment.properties.defaultDomain}' ]
          allowedMethods: [ 'GET', 'HEAD', 'OPTIONS', 'PUT' ]
          allowedHeaders: [ '*' ]
          exposedHeaders: [ '*' ]
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource videosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobServices
  name: 'videos'
  properties: {
    publicAccess: 'None'
  }
}

resource derivedContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobServices
  name: 'derived'
  properties: {
    publicAccess: 'None'
  }
}

resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'videos-to-cool-after-30-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ 'videos/' ]
            }
            actions: {
              baseBlob: {
                tierToCool: {
                  daysAfterModificationGreaterThan: 30
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource queueServices 'Microsoft.Storage/storageAccounts/queueServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource analysisJobsQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-01-01' = {
  parent: queueServices
  name: 'analysis-jobs'
}

resource analysisPoisonQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-01-01' = {
  parent: queueServices
  name: 'analysis-jobs-poison'
}

var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server (B1ms) + jams database
// ---------------------------------------------------------------------------

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: toLower('psql-${envForNaming}-${uniqueSuffix}')
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'jamsadmin'
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgresServer
  name: 'jams'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// No VNet integration in this slice — allow Azure services (ACA) to reach the
// server. Tighten with VNet/Private Link before accepting real customer data;
// see docs/OPERATIONS-RUNBOOK.md.
resource postgresFirewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: postgresServer
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

var databaseUrlWeb = 'postgresql://jams_web:${jamsWebDbPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/jams?sslmode=require'
var databaseUrlWorker = 'postgresql://jams_worker:${jamsWorkerDbPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/jams?sslmode=require'

// ---------------------------------------------------------------------------
// Container Apps environment
// ---------------------------------------------------------------------------

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${envForNaming}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// jams-web: Container App, Consumption, min-replicas 0
// ---------------------------------------------------------------------------

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'jams-web'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: hasGhcrCredentials ? [
        {
          server: 'ghcr.io'
          username: ghcrUsername
          passwordSecretRef: 'ghcr-token'
        }
      ] : []
      secrets: concat(hasGhcrCredentials ? [
        { name: 'ghcr-token', value: ghcrToken }
      ] : [], [
        { name: 'azure-storage-connection-string', value: storageConnectionString }
        { name: 'database-url-web', value: databaseUrlWeb }
        { name: 'database-url', value: databaseUrlWorker }
        { name: 'clerk-secret-key', value: clerkSecretKey }
        { name: 'clerk-webhook-signing-secret', value: clerkWebhookSigningSecret }
        { name: 'watchdog-secret', value: watchdogSecret }
      ])
    }
    template: {
      containers: [
        {
          name: 'jams-web'
          image: webImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'azure-storage-connection-string' }
            { name: 'DATABASE_URL_WEB', secretRef: 'database-url-web' }
            // admin-client.server.ts needs an RLS-bypass connection for
            // Clerk webhook mirroring and dispatch-outbox reads; jams_worker
            // already has BYPASSRLS + full grants (migration 0007), so reuse
            // it instead of provisioning a fourth Postgres role.
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'CLERK_SECRET_KEY', secretRef: 'clerk-secret-key' }
            { name: 'CLERK_WEBHOOK_SIGNING_SECRET', secretRef: 'clerk-webhook-signing-secret' }
            { name: 'WATCHDOG_SECRET', secretRef: 'watchdog-secret' }
            { name: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', value: clerkPublishableKey }
            { name: 'JAMS_PREVIEW_USER_IDS', value: jamsPreviewUserIds }
            { name: 'JAMS_PREVIEW_MAX_STORAGE_BYTES', value: jamsPreviewMaxStorageBytes }
            { name: 'JAMS_PREVIEW_MAX_ANALYSES', value: jamsPreviewMaxAnalyses }
            { name: 'JAMS_PREVIEW_MAX_ACTIVE_RUNS', value: jamsPreviewMaxActiveRuns }
            { name: 'JAMS_LIMIT_UPLOAD_MAX_BYTES', value: jamsLimitUploadMaxBytes }
            { name: 'JAMS_LIMIT_UPLOAD_MAX_DURATION_MS', value: jamsLimitUploadMaxDurationMs }
            { name: 'JAMS_LIMIT_ORG_STORAGE_BYTES', value: jamsLimitOrgStorageBytes }
            { name: 'JAMS_LIMIT_ORG_ACTIVE_ANALYSES', value: jamsLimitOrgActiveAnalyses }
            { name: 'JAMS_LIMIT_ORG_ANALYSES_PER_WINDOW', value: jamsLimitOrgAnalysesPerWindow }
            { name: 'JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES', value: jamsLimitGlobalActiveAnalyses }
            { name: 'JAMS_LIMIT_GLOBAL_UPLOAD_BYTES_PER_DAY', value: jamsLimitGlobalUploadBytesPerDay }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health/live'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: webMinReplicas
        maxReplicas: webMaxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(webHttpConcurrency)
              }
            }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// jams-worker: Container Apps Job, Consumption, KEDA azure-queue trigger
// ---------------------------------------------------------------------------

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'jams-worker'
  location: location
  tags: union(tags, { 'azd-service-name': 'worker' })
  properties: {
    environmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: workerReplicaTimeoutSeconds
      replicaRetryLimit: 1
      eventTriggerConfig: {
        parallelism: workerParallelism
        replicaCompletionCount: workerParallelism
        scale: {
          minExecutions: 0
          maxExecutions: workerMaxExecutions
          pollingInterval: workerPollingIntervalSeconds
          rules: [
            {
              name: 'analysis-jobs-queue'
              type: 'azure-queue'
              metadata: {
                queueName: 'analysis-jobs'
                queueLength: '1'
                accountName: storageAccount.name
              }
              auth: [
                {
                  secretRef: 'azure-storage-connection-string'
                  triggerParameter: 'connection'
                }
              ]
            }
          ]
        }
      }
      registries: hasGhcrCredentials ? [
        {
          server: 'ghcr.io'
          username: ghcrUsername
          passwordSecretRef: 'ghcr-token'
        }
      ] : []
      secrets: concat(hasGhcrCredentials ? [
        { name: 'ghcr-token', value: ghcrToken }
      ] : [], [
        { name: 'azure-storage-connection-string', value: storageConnectionString }
        { name: 'database-url', value: databaseUrlWorker }
      ])
    }
    template: {
      containers: [
        {
          name: 'jams-worker'
          image: workerImage
          args: workerDrainMode ? [ '--drain' ] : []
          resources: {
            cpu: json('4.0')
            memory: '8Gi'
          }
          env: [
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'azure-storage-connection-string' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'JAMS_LIMIT_UPLOAD_MAX_BYTES', value: jamsLimitUploadMaxBytes }
            { name: 'JAMS_LIMIT_UPLOAD_MAX_DURATION_MS', value: jamsLimitUploadMaxDurationMs }
          ]
        }
      ]
    }
  }
}

output storageAccountName string = storageAccount.name
output environmentName string = managedEnvironment.name
output postgresFqdn string = postgresServer.properties.fullyQualifiedDomainName
output webFqdn string = webApp.properties.configuration.ingress.fqdn
output webAppName string = webApp.name
output workerJobName string = workerJob.name
output postgresAdminConnectionStringHint string = 'Build the admin migration URL as postgresql://jamsadmin:<postgresAdminPassword>@${postgresServer.properties.fullyQualifiedDomainName}:5432/jams?sslmode=require -- never emit the real password as a plain output.'
