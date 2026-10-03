import { Queue } from "bullmq";
import { getConfig } from "../config/env.js";
import { prisma } from "./prisma.js";
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
  const queue = getMediaQueue();
  const jobId = `export:${exportId}`;
  // 断点续跑或重新入队时，先移除可能残留的旧任务，避免 BullMQ 因 jobId 冲突静默跳过
  const existing = await queue.getJob(jobId);
  await existing?.remove();
  const job = await queue.add(
    "export-data",
    { exportId },
    {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
  await prisma.dataExport.updateMany({ where: { id: exportId }, data: { bullJobId: job.id ?? jobId } });
}

export async function removeExportJob(jobId: string | null): Promise<void> {
  if (!jobId) return;
  const job = await getMediaQueue().getJob(jobId);
  if (job) await job.remove();
}

export async function enqueueAccountDeletion(userId: string): Promise<void> {
  const queue = getMediaQueue();
  const jobId = `delete-user:${userId}`;
  const existing = await queue.getJob(jobId);
  await existing?.remove();
  await queue.add(
    "delete-user",
    { userId },
    {
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
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
