import { getConfig } from "../config/env.js";
import type { ExportCheckpoint, ExportParams } from "./export.js";
import { fetchSessionBatch, finalizeExport, loadProfile, totalSessions } from "./export.js";
import { prisma } from "./prisma.js";
import { deleteObject, getJsonObject, putJsonObject, putObject } from "./s3.js";
type Log = (level: "info" | "error" | "warn", data: Record<string, unknown>, message: string) => void;

const checkpointKeyFor = (userId: string, exportId: string) => `users/${userId}/exports/_checkpoints/${exportId}.json`;

interface ExportRowState {
  id: string;
  userId: string;
  format: string;
  status: string;
  objectKey: string | null;
  checkpointKey: string | null;
  params: unknown;
  cursorSession: string | null;
  processedCount: number;
  totalSessions: number;
  cancelRequested: boolean;
}

function parseParams(raw: unknown): { from: string | null; to: string | null } {
  if (raw && typeof raw === "object") {
    const params = raw as Partial<ExportParams>;
    return { from: params.from ?? null, to: params.to ?? null };
  }
  return { from: null, to: null };
}

/**
 * 分批执行导出：
 * - 每批读取 EXPORT_BATCH_SIZE 个练习，断点写入对象存储；
 * - 每批前后检查 cancel_requested，已取消立即停止并清理半成品；
 * - 任务重试/Worker 重启后从最后一个已提交批次继续，不从头重跑；
 * - 只有整批成功后才推进游标，崩溃在批次中间不会产生重复记录。
 */
export async function runExport(exportId: string, log: Log): Promise<void> {
  const config = getConfig();
  const task = (await prisma.dataExport.findUnique({ where: { id: exportId } })) as ExportRowState | null;
  if (!task || !task.objectKey) return;
  if (task.status === "READY" || task.status === "CANCELLED" || task.status === "EXPIRED") return;
  if (task.cancelRequested) {
    await cleanupCheckpoint(task.checkpointKey).catch(() => undefined);
    if (task.objectKey) await deleteObject(task.objectKey).catch(() => undefined);
    await markCancelled(exportId);
    return;
  }

  const params = parseParams(task.params);
  let checkpoint: ExportCheckpoint | null = task.checkpointKey
    ? await getJsonObject<ExportCheckpoint>(task.checkpointKey).catch(() => null)
    : null;

  // 条件领取：只有 PENDING 或本人未推进过的 PROCESSING 可以继续
  const claimed = await prisma.dataExport.updateMany({
    where: { id: exportId, status: { in: ["PENDING", "PROCESSING"] }, cancelRequested: false },
    data: {
      status: "PROCESSING",
      startedAt: new Date(),
      checkpointKey: task.checkpointKey ?? checkpointKeyFor(task.userId, exportId),
    },
  });
  if (claimed.count === 0) return;

  const live = (await prisma.dataExport.findUniqueOrThrow({ where: { id: exportId } })) as ExportRowState;
  // 断点对象丢失（被生命周期策略清理等）：重置游标从头重建，避免漏数据
  if (!checkpoint && live.cursorSession) {
    checkpoint = null;
    await prisma.dataExport.update({
      where: { id: exportId },
      data: { cursorSession: null, processedCount: 0, totalSessions: 0 },
    });
    live.cursorSession = null;
    live.processedCount = 0;
    live.totalSessions = 0;
  }
  if (!checkpoint) {
    const count = await totalSessions(live.userId, params);
    checkpoint = {
      version: 1,
      userId: live.userId,
      format: live.format,
      params,
      profile: await loadProfile(live.userId),
      batches: [],
    };
    await prisma.dataExport.update({ where: { id: exportId }, data: { totalSessions: count, processedCount: 0 } });
  }

  let cursor = live.cursorSession;
  // 已提交批次计数以数据库为准；checkpoint 中保存完整数据，二者在提交时同步
  let processed = live.processedCount;
  if (checkpoint.batches.length > 0 && processed === 0) processed = checkpoint.batches.length;
  try {
    for (;;) {
      const requested = await prisma.dataExport.findUnique({
        where: { id: exportId },
        select: { cancelRequested: true, objectKey: true },
      });
      if (requested?.cancelRequested) {
        await cleanupCheckpoint(live.checkpointKey);
        if (requested.objectKey) await deleteObject(requested.objectKey).catch(() => undefined);
        await markCancelled(exportId);
        log("info", { exportId }, "export cancelled by user");
        return;
      }

      const { rows, nextCursor } = await fetchSessionBatch(live.userId, params, cursor, config.EXPORT_BATCH_SIZE);
      if (rows.length === 0) break;

      checkpoint.batches.push(...rows);
      checkpoint.params = params;
      const checkpointKey = live.checkpointKey ?? checkpointKeyFor(live.userId, exportId);
      // 先持久化断点，再推进数据库游标；任何一侧失败都可从上一批恢复
      await putJsonObject(checkpointKey, checkpoint);
      processed += rows.length;
      await prisma.dataExport.update({
        where: { id: exportId },
        data: { cursorSession: nextCursor, processedCount: processed, checkpointKey },
      });
      cursor = nextCursor;
      log("info", { exportId, processed, total: live.totalSessions }, "export batch committed");

      if (!nextCursor) break;
    }

    const output = finalizeExport(checkpoint);
    const objectKey = live.objectKey ?? task.objectKey;
    if (!objectKey) return;
    await putObject(objectKey, output.body, output.contentType);
    const expiresAt = new Date(Date.now() + config.EXPORT_FILE_TTL_HOURS * 60 * 60_000);
    // 只有仍处于 PROCESSING 且未被取消时才能 READY，避免取消与完成竞态
    const finalized = await prisma.dataExport.updateMany({
      where: { id: exportId, status: "PROCESSING", cancelRequested: false },
      data: { status: "READY", failure: null, finishedAt: new Date(), expiresAt },
    });
    await cleanupCheckpoint(live.checkpointKey).catch(() => undefined);
    if (finalized.count === 0) {
      // 完成期间被取消：删除刚上传的对象并落为 CANCELLED
      await deleteObject(objectKey).catch(() => undefined);
      await markCancelled(exportId);
      log("warn", { exportId }, "export finalized after cancellation, object removed");
      return;
    }
    log("info", { exportId, sessions: processed }, "export completed");
  } catch (error) {
    // 保留断点与 PROCESSING 状态，BullMQ 重试时从游标继续；最终失败由 handleExportAttemptEnd 落 FAILED
    log("error", { exportId, err: error instanceof Error ? error.message : String(error) }, "export batch failed");
    throw error;
  }
}

/** BullMQ 尝试结束后调用：仅在确认没有剩余尝试时落 FAILED。 */
export async function handleExportAttemptEnd(exportId: string, willRetry: boolean, error: unknown): Promise<void> {
  if (willRetry) return;
  await cleanupCheckpoint(await checkpointKeyOf(exportId)).catch(() => undefined);
  await prisma.dataExport.updateMany({
    where: { id: exportId, status: "PROCESSING" },
    data: {
      status: "FAILED",
      failure: error instanceof Error ? error.message.slice(0, 500) : "EXPORT_FAILED",
      finishedAt: new Date(),
    },
  });
}

export async function cancelExportArtifacts(exportId: string): Promise<void> {
  const key = await checkpointKeyOf(exportId);
  await cleanupCheckpoint(key).catch(() => undefined);
  const task = await prisma.dataExport.findUnique({ where: { id: exportId }, select: { status: true, objectKey: true } });
  if (task?.status === "CANCELLED" && task.objectKey) await deleteObject(task.objectKey).catch(() => undefined);
}

async function checkpointKeyOf(exportId: string): Promise<string | null> {
  const task = await prisma.dataExport.findUnique({ where: { id: exportId }, select: { checkpointKey: true } });
  return task?.checkpointKey ?? null;
}

async function cleanupCheckpoint(key: string | null): Promise<void> {
  if (key) await deleteObject(key);
}

async function markCancelled(exportId: string): Promise<void> {
  await prisma.dataExport.updateMany({
    where: { id: exportId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
}

/**
 * 扫描到期导出：READ 过期后对象删除并置 EXPIRED。
 * 链接签发前也会做即时检查，此扫描负责回收对象存储与修正状态。
 */
export async function sweepExpiredExports(log: Log): Promise<number> {
  const now = new Date();
  const expired = await prisma.dataExport.findMany({
    where: { status: "READY", expiresAt: { lte: now } },
    select: { id: true, objectKey: true, checkpointKey: true },
    take: 200,
  });
  let removed = 0;
  for (const item of expired) {
    if (item.objectKey) await deleteObject(item.objectKey).catch(() => undefined);
    if (item.checkpointKey) await deleteObject(item.checkpointKey).catch(() => undefined);
    const result = await prisma.dataExport.updateMany({
      where: { id: item.id, status: "READY", expiresAt: { lte: now } },
      data: { status: "EXPIRED", finishedAt: now },
    });
    removed += result.count;
  }
  if (removed > 0) log("info", { removed }, "expired exports swept");
  return removed;
}
