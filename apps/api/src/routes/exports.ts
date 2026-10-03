import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { createExportSchema, exportListQuerySchema } from "@practice/contracts";
import { getConfig } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { AppError, notFound } from "../lib/errors.js";
import { hashExportParams } from "../lib/export-task.js";
import { prisma } from "../lib/prisma.js";
import { enqueueExport, removeExportJob } from "../lib/queue.js";
import { createExportDownloadUrl, deleteObject } from "../lib/s3.js";
import { parseOrThrow } from "../lib/validation.js";

const ACTIVE_STATUSES = ["PENDING", "PROCESSING", "READY"] as const;

const exportTaskSelect = {
  id: true,
  format: true,
  status: true,
  rangeFrom: true,
  rangeTo: true,
  totalSessions: true,
  processedSessions: true,
  cancelRequestedAt: true,
  failure: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const exportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // 创建导出：同参数的活动任务直接复用，不生成副本；READY 任务刷新文件保留期。
  app.post("/", async (request, reply) => {
    const input = parseOrThrow(createExportSchema, request.body);
    const userId = request.authUser!.id;
    const paramsHash = hashExportParams({ format: input.format, from: input.from ?? null, to: input.to ?? null });
    const ttlMs = getConfig().EXPORT_FILE_TTL_HOURS * 60 * 60 * 1000;

    const reusable = await prisma.dataExport.findFirst({
      where: { userId, paramsHash, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: exportTaskSelect,
    });
    if (reusable) {
      const export_ =
        reusable.status === "READY"
          ? await prisma.dataExport.update({
              where: { id: reusable.id },
              data: { expiresAt: new Date(Date.now() + ttlMs) },
              select: exportTaskSelect,
            })
          : reusable;
      await audit(request, "EXPORT_REUSED", "DATA_EXPORT", reusable.id, "SUCCESS", { format: input.format });
      return reply.status(200).send({ export: export_, reused: true });
    }

    const id = randomUUID();
    // 目标对象键与任务绑定：重新执行/断点续跑始终覆盖同一对象，不会产生重复文件。
    const objectKey = `users/${userId}/exports/${id}.${input.format}`;
    try {
      const task = await prisma.dataExport.create({
        data: {
          id,
          userId,
          format: input.format,
          paramsHash,
          objectKey,
          rangeFrom: input.from ?? null,
          rangeTo: input.to ?? null,
          expiresAt: new Date(Date.now() + ttlMs),
        },
        select: exportTaskSelect,
      });
      await enqueueExport(id);
      await audit(request, "EXPORT_CREATED", "DATA_EXPORT", id, "SUCCESS", { format: input.format });
      return reply.status(202).send({ export: task, reused: false });
    } catch (error) {
      // 并发创建同一参数任务时，唯一索引保证只有一个活动任务，其余请求复用。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await prisma.dataExport.findFirstOrThrow({
          where: { userId, paramsHash, status: { in: [...ACTIVE_STATUSES] } },
          orderBy: { createdAt: "desc" },
          select: exportTaskSelect,
        });
        return reply.status(200).send({ export: winner, reused: true });
      }
      // 队列不可用时不要留下永久占用去重键的 PENDING 行
      await prisma.dataExport.deleteMany({ where: { id } }).catch(() => undefined);
      throw new AppError(503, "PROCESSING_UNAVAILABLE", "导出服务暂不可用，请稍后重试");
    }
  });

  app.get("/", async (request) => {
    const query = parseOrThrow(exportListQuerySchema, request.query);
    const exports = await prisma.dataExport.findMany({
      where: { userId: request.authUser!.id },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      select: exportTaskSelect,
    });
    return { exports };
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const task = await prisma.dataExport.findFirst({
      where: { id, userId: request.authUser!.id },
      select: { ...exportTaskSelect, objectKey: true },
    });
    if (!task) throw notFound();

    // READY 文件已过保留期：惰性回收对象并标记 EXPIRED，下载链接不再签发。
    if (task.status === "READY" && task.expiresAt && task.expiresAt.getTime() < Date.now()) {
      if (task.objectKey) await deleteObject(task.objectKey).catch(() => undefined);
      await prisma.dataExport.updateMany({ where: { id: task.id, status: "READY" }, data: { status: "EXPIRED" } });
      const expired = await prisma.dataExport.findUniqueOrThrow({ where: { id: task.id }, select: exportTaskSelect });
      return { export: expired };
    }

    const { objectKey, ...publicTask } = task;
    if (task.status === "READY" && objectKey) {
      const downloadUrl = await createExportDownloadUrl(
        objectKey,
        `practice-export.${task.format}`,
        task.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      );
      return {
        export: publicTask,
        downloadUrl,
        downloadUrlExpiresIn: getConfig().PLAYBACK_URL_TTL_SECONDS,
      };
    }
    return { export: publicTask };
  });

  // 取消导出：未开始的任务直接终止；处理中的任务在批次边界协作式停止并回滚分片。
  app.post("/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    const task = await prisma.dataExport.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!task) throw notFound();
    if (task.status === "READY") throw new AppError(409, "EXPORT_NOT_CANCELLABLE", "导出已完成，无法取消");
    if (["CANCELLED", "EXPIRED", "FAILED"].includes(task.status)) {
      return { export: await prisma.dataExport.findUniqueOrThrow({ where: { id: task.id }, select: exportTaskSelect }) };
    }

    if (task.status === "PENDING") {
      await removeExportJob(task.bullJobId ?? `export:${task.id}`);
      // 条件更新避免与刚启动的 Worker 竞争：任务已进入 PROCESSING 时改走取消标记。
      const result = await prisma.dataExport.updateMany({
        where: { id: task.id, status: "PENDING" },
        data: { status: "CANCELLED", cancelRequestedAt: new Date(), failure: null },
      });
      if (result.count === 1) {
        const cancelled = await prisma.dataExport.findUniqueOrThrow({ where: { id: task.id }, select: exportTaskSelect });
        await audit(request, "EXPORT_CANCELLED", "DATA_EXPORT", task.id, "SUCCESS");
        return { export: cancelled };
      }
    }

    const updated = await prisma.dataExport.update({
      where: { id: task.id },
      data: { cancelRequestedAt: new Date() },
      select: exportTaskSelect,
    });
    await audit(request, "EXPORT_CANCEL_REQUESTED", "DATA_EXPORT", task.id, "SUCCESS");
    return { export: updated };
  });
};

export default exportRoutes;
