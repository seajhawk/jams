import { QueueServiceClient } from "@azure/storage-queue"

export const analysisJobsQueueName = "analysis-jobs"
export const analysisPoisonQueueName = "analysis-jobs-poison"

function queueServiceClient() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required")
  }

  return QueueServiceClient.fromConnectionString(connectionString)
}

async function queueClient(name: string) {
  const queue = queueServiceClient().getQueueClient(name)
  await queue.createIfNotExists()
  return queue
}

export async function enqueueAnalysisRun(runId: string) {
  const queue = await queueClient(analysisJobsQueueName)
  await queue.sendMessage(JSON.stringify({ run_id: runId }))
}
