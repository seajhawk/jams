import { QueueServiceClient } from "@azure/storage-queue"
import type { ReceivedMessageItem } from "@azure/storage-queue"

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

export type PoisonQueueMessage = {
  id: string
  dequeueCount: number
  body: string
  insertedAt: string
  expiresAt: string
}

export async function peekAnalysisPoisonMessages(limit = 16) {
  const queue = await queueClient(analysisPoisonQueueName)
  const response = await queue.peekMessages({
    numberOfMessages: Math.min(Math.max(limit, 1), 32),
  })

  return response.peekedMessageItems.map((message): PoisonQueueMessage => ({
    id: message.messageId,
    dequeueCount: message.dequeueCount,
    body: message.messageText,
    insertedAt: message.insertedOn.toISOString(),
    expiresAt: message.expiresOn.toISOString(),
  }))
}

async function receivePoisonMessageById(messageId: string) {
  const queue = await queueClient(analysisPoisonQueueName)
  const response = await queue.receiveMessages({
    numberOfMessages: 32,
    visibilityTimeout: 10,
  })

  let matched: ReceivedMessageItem | null = null
  for (const message of response.receivedMessageItems) {
    if (message.messageId === messageId) {
      matched = message
    } else {
      await queue.updateMessage(
        message.messageId,
        message.popReceipt,
        message.messageText,
        0
      )
    }
  }

  return { queue, matched }
}

export async function requeueAnalysisPoisonMessage(messageId: string) {
  const { queue, matched } = await receivePoisonMessageById(messageId)
  if (!matched) return false

  const mainQueue = await queueClient(analysisJobsQueueName)
  await mainQueue.sendMessage(matched.messageText)
  await queue.deleteMessage(matched.messageId, matched.popReceipt)
  return true
}

export async function deleteAnalysisPoisonMessage(messageId: string) {
  const { queue, matched } = await receivePoisonMessageById(messageId)
  if (!matched) return false

  await queue.deleteMessage(matched.messageId, matched.popReceipt)
  return true
}
