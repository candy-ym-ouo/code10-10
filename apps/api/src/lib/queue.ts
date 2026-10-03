import { Queue } from "bullmq";
import { getConfig } from "../config/env.js";
import { getRedis } from "./redis.js";

let queue: Queue | undefined;

export function getMediaQueue(): Queue {
  if (!queue) {
    queue = new Queue("media-processing", { connection: getRedis().duplicate() });
  }
  return queue;
}

export async function enqueueProbe(mediaId: string): Promise<void> {
  await getMediaQueue().add(
    "probe-media",
    { mediaId },
    {
      jobId: `probe:${mediaId}:${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueCleanup(sessionId: string): Promise<void> {
  await getMediaQueue().add(
    "cleanup-session",
    { sessionId },
    {
      jobId: `cleanup:${sessionId}:${Date.now()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueExport(exportId: string): Promise<void> {
  // 同一任务 ID 复用 BullMQ job：用户在取消/失败后重新发起会创建新的导出行与新 ID
  await getMediaQueue().add(
    "export-data",
    { exportId },
    {
      jobId: `export:${exportId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueAccountDeletion(userId: string): Promise<void> {
  await getMediaQueue().add(
    "delete-account",
    { userId },
    {
      jobId: `delete-account:${userId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
