import { getConfig } from "../config/env.js";
import {
  EXPORT_CONTENT_TYPE,
  buildHead,
  buildSuffix,
  countExportSessions,
  fetchExportHeader,
  fetchSessionBatch,
  hashExportParams,
  serializeSessionsChunk,
  type ExportFormat,
} from "../lib/export.js";
import { prisma } from "../lib/prisma.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  uploadPart,
  type UploadedPart,
} from "../lib/s3.js";

function parseParts(value: unknown): UploadedPart[] {
  return Array.isArray(value) ? (value as UploadedPart[]).filter((part) => part?.PartNumber && part?.ETag) : [];
}

function isNoSuchUpload(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { name?: string; code?: string }).name ?? (error as { code?: string }).code;
  return code === "NoSuchUpload" || code === "NoSuchUploadError" || error.message.includes("NoSuchUpload");
}

/**
 * 异步分批导出。
 * - 分批：按练习 ID 游标每批 EXPORT_BATCH_SIZE 条读取。
 * - 断点续跑：游标、已处理数与已上传 S3 分片持久化，Worker 崩溃/BullMQ 重试后从下一游标继续。
 * - 可取消：批次边界检查 cancelRequestedAt，取消时中止分片上传并落盘 CANCELLED。
 */
export async function processExport(exportId: string): Promise<void> {
  const config = getConfig();
  const task = await prisma.dataExport.findUnique({ where: { id: exportId } });
  if (!task || !task.objectKey) return;
  if (["READY", "CANCELLED", "EXPIRED"].includes(task.status)) return;

  const format = task.format as ExportFormat;
  const range = { from: task.rangeFrom, to: task.rangeTo };
  if (task.paramsHash !== hashExportParams({ format, from: range.from, to: range.to })) {
    await prisma.dataExport.update({ where: { id: exportId }, data: { status: "FAILED", failure: "EXPORT_PARAMS_MISMATCH" } });
    return;
  }

  // 用户已被标记删除时不再产出文件
  const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { status: true } });
  if (!user || user.status !== "ACTIVE") {
    await prisma.dataExport.update({ where: { id: exportId }, data: { status: "FAILED", failure: "USER_UNAVAILABLE" } });
    return;
  }

  const { objectKey } = task;
  const contentType = EXPORT_CONTENT_TYPE[format];
  const ttlMs = config.EXPORT_FILE_TTL_HOURS * 60 * 60 * 1000;
  await prisma.dataExport.update({
    where: { id: exportId },
    data: { status: "PROCESSING", failure: null, expiresAt: new Date(Date.now() + ttlMs) },
  });

  // 从检查点恢复
  let uploadId: string | null = task.multipartUploadId;
  let parts: UploadedPart[] = parseParts(task.uploadedParts);
  let cursor: string | null = task.cursorSessionId;
  let processed = task.processedSessions;
  let total = task.totalSessions;
  let partNumber = parts.length + 1;
  let buffer = Buffer.alloc(0);

  // 分片上传失效（对象存储被清空等）时回到起点重建
  const startOver = async () => {
    uploadId = null;
    parts = [];
    partNumber = 1;
    cursor = null;
    processed = 0;
    const header = await fetchExportHeader(task.userId);
    buffer = Buffer.from(buildHead(format, header, range));
    await prisma.dataExport.update({
      where: { id: exportId },
      data: { multipartUploadId: null, uploadedParts: [], cursorSessionId: null, processedSessions: 0 },
    });
  };

  if (parts.length === 0) {
    const header = await fetchExportHeader(task.userId);
    buffer = Buffer.from(buildHead(format, header, range));
  }

  // 缓冲达到分片阈值（S3 要求除最后一片外 ≥ 5MiB）才上传，并落盘检查点
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    try {
      if (!uploadId) uploadId = await createMultipartUpload(objectKey, contentType);
      const part = await uploadPart(objectKey, uploadId, partNumber, buffer);
      parts = [...parts, part];
      partNumber += 1;
    } catch (error) {
      if (isNoSuchUpload(error) && uploadId) {
        await startOver();
        return;
      }
      throw error;
    }
    await prisma.dataExport.update({
      where: { id: exportId },
      data: { multipartUploadId: uploadId, uploadedParts: parts as never, cursorSessionId: cursor, processedSessions: processed },
    });
    buffer = Buffer.alloc(0);
  };

  try {
    if (total === 0) total = await countExportSessions(task.userId, range);

    while (true) {
      const fresh = await prisma.dataExport.findUnique({
        where: { id: exportId },
        select: { cancelRequestedAt: true },
      });
      if (!fresh || fresh.cancelRequestedAt) {
        if (uploadId) await abortMultipartUpload(objectKey, uploadId).catch(() => undefined);
        await prisma.dataExport.update({
          where: { id: exportId },
          data: { status: "CANCELLED", failure: null, multipartUploadId: null, uploadedParts: [] },
        });
        return;
      }

      const batch = await fetchSessionBatch(task.userId, range, cursor, config.EXPORT_BATCH_SIZE);
      const last = batch[batch.length - 1];
      if (!last) break;

      buffer = Buffer.concat([buffer, Buffer.from(serializeSessionsChunk(format, batch, processed))]);
      processed += batch.length;
      cursor = last.id;

      if (buffer.length >= config.EXPORT_PART_FLUSH_BYTES) await flush();
    }

    buffer = Buffer.concat([buffer, Buffer.from(buildSuffix(format, processed))]);
    if (!uploadId) uploadId = await createMultipartUpload(objectKey, contentType);
    const finalPart = await uploadPart(objectKey, uploadId, partNumber, buffer);
    parts = [...parts, finalPart];
    await completeMultipartUpload(objectKey, uploadId, parts);

    await prisma.dataExport.update({
      where: { id: exportId },
      data: {
        status: "READY",
        failure: null,
        totalSessions: total,
        processedSessions: processed,
        cursorSessionId: cursor,
        uploadedParts: parts as never,
        multipartUploadId: uploadId,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "EXPORT_FAILED";
    await prisma.dataExport.update({ where: { id: exportId }, data: { status: "FAILED", failure: message.slice(0, 500) } });
    throw error;
  }
}

/** 过期清理：READY 超过保留期的文件删除对象并标记 EXPIRED；终态记录超过保留期直接删除。 */
export async function sweepExports(): Promise<{ expired: number; recovered: number; deleted: number }> {
  const config = getConfig();
  const now = new Date();

  const dueReady = await prisma.dataExport.findMany({
    where: { status: "READY", expiresAt: { lt: now } },
    select: { id: true, objectKey: true },
    take: 500,
  });
  let expired = 0;
  for (const item of dueReady) {
    if (item.objectKey) await deleteObject(item.objectKey).catch(() => undefined);
    expired += (
      await prisma.dataExport.updateMany({ where: { id: item.id, status: "READY" }, data: { status: "EXPIRED" } })
    ).count;
  }

  const retentionCutoff = new Date(Date.now() - config.EXPORT_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // 卡死的任务（Worker/队列丢失，长时间没有检查点）回收分片并置为 FAILED，允许用户重新发起
  const stalledCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stalled = await prisma.dataExport.findMany({
    where: { status: { in: ["PENDING", "PROCESSING"] }, updatedAt: { lt: stalledCutoff } },
    select: { id: true, objectKey: true, multipartUploadId: true },
    take: 500,
  });
  let recovered = 0;
  for (const record of stalled) {
    if (record.multipartUploadId && record.objectKey) {
      await abortMultipartUpload(record.objectKey, record.multipartUploadId).catch(() => undefined);
    }
    recovered += (
      await prisma.dataExport.updateMany({
        where: { id: record.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED", failure: "EXPORT_STALLED", multipartUploadId: null, uploadedParts: [] },
      })
    ).count;
  }

  const staleRecords = await prisma.dataExport.findMany({
    where: { status: { in: ["EXPIRED", "CANCELLED", "FAILED"] }, updatedAt: { lt: retentionCutoff } },
    select: { id: true, objectKey: true, multipartUploadId: true },
    take: 500,
  });
  let deleted = 0;
  for (const record of staleRecords) {
    if (record.multipartUploadId && record.objectKey) {
      await abortMultipartUpload(record.objectKey, record.multipartUploadId).catch(() => undefined);
    }
    deleted += (await prisma.dataExport.deleteMany({ where: { id: record.id } })).count;
  }

  return { expired, recovered, deleted };
}
