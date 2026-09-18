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
        minReplicas: 0
        maxReplicas: 1
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
      replicaTimeout: 3600
      replicaRetryLimit: 1
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 3
          pollingInterval: 30
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
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'azure-storage-connection-string' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
          ]
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Watchdog scheduler: POSTs /api/admin/watchdog every 10 minutes, per
// docs/OPERATIONS-RUNBOOK.md. Trivial curl-based job, negligible cost.
// ---------------------------------------------------------------------------

resource watchdogScheduler 'Microsoft.App/jobs@2024-03-01' = {
  name: 'jams-watchdog'
  location: location
  tags: tags
  properties: {
    environmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 60
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '*/10 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        { name: 'watchdog-secret', value: watchdogSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'watchdog'
          image: 'curlimages/curl:8.11.1'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          command: [ 'sh', '-c' ]
          args: [
            'curl -fsS -X POST -H "Authorization: Bearer $WATCHDOG_SECRET" https://${webApp.properties.configuration.ingress.fqdn}/api/admin/watchdog'
          ]
          env: [
            { name: 'WATCHDOG_SECRET', secretRef: 'watchdog-secret' }
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
