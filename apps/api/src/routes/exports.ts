import { createExportSchema, exportParamsFingerprint, isExportCancellable } from "@practice/contracts";
import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/env.js";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { enqueueExport } from "../lib/queue.js";
import { createDownloadUrl } from "../lib/s3.js";
import { parseOrThrow } from "../lib/validation.js";

const exportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // 幂等创建：同一格式/时间范围只复用已有任务或其成品对象，不生成副本
  app.post("/", async (request, reply) => {
    const userId = request.authUser!.id;
    const input = parseOrThrow(createExportSchema, request.body);
    const from = input.from ? input.from.toISOString() : null;
    const to = input.to ? input.to.toISOString() : null;
    const dedupKey = exportParamsFingerprint({ userId, format: input.format, from, to });

    // 可复用：进行中返回同一任务；未过期 READY 直接返回下载信息
    const reusable = await prisma.dataExport.findFirst({
      where: {
        userId,
        dedupKey,
        OR: [{ status: { in: ["PENDING", "PROCESSING"] } }, { status: "READY", expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
    });
    if (reusable) {
      return reply.status(200).send({ export: reusable, reused: true, ...(await downloadPayload(reusable.id)) });
    }
    // 已过期但扫描尚未回收的 READY：先作废再重建，避免对象被两个任务共享
    const staleReady = await prisma.dataExport.findFirst({
      where: { userId, dedupKey, status: "READY" },
      orderBy: { createdAt: "desc" },
    });
    if (staleReady) {
      await prisma.dataExport.updateMany({
        where: { id: staleReady.id, status: "READY" },
        data: { status: "EXPIRED", finishedAt: new Date() },
      });
    }

    const id = randomUUID();
    const objectKey = `users/${userId}/exports/${dedupKey}.${input.format}`;
    const task = prisma.dataExport.create({
      data: {
        id,
        userId,
        format: input.format,
        objectKey,
        dedupKey,
        params: { from, to },
      },
    });
    try {
      const created = await task;
      await enqueueExport(id);
      return reply.status(202).send({ export: created, reused: false });
    } catch (error) {
      // 并发下唯一索引兜底（同 dedupKey 的 READY）：复用而不是报错
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await prisma.dataExport.findFirst({
          where: { userId, dedupKey },
          orderBy: { createdAt: "desc" },
        });
        if (winner) return reply.status(200).send({ export: winner, reused: true, ...(await downloadPayload(winner.id)) });
      }
      throw error;
    }
  });

  app.get("/", async (request) => {
    const exports = await prisma.dataExport.findMany({
      where: { userId: request.authUser!.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { exports };
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const task = await prisma.dataExport.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!task) throw notFound();
    return { export: task, ...(await downloadPayload(task.id)) };
  });

  app.post("/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    const task = await prisma.dataExport.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!task) throw notFound();
    if (task.status === "CANCELLED") return { export: task };
    if (!isExportCancellable(task.status)) {
      throw new AppError(409, "EXPORT_NOT_CANCELLABLE", "当前任务状态无法取消");
    }
    await prisma.dataExport.updateMany({
      where: { id, status: { in: ["PENDING", "PROCESSING"] } },
      data: { cancelRequested: true },
    });
    // 尽力移除 BullMQ 任务；已经在执行的任务由 Worker 在批次边界检查取消标记
    let removedFromQueue = false;
    try {
      const job = await (await import("../lib/queue.js")).getMediaQueue().getJob(`export:${id}`);
      if (job) {
        await job.remove();
        removedFromQueue = true;
      } else {
        removedFromQueue = true;
      }
    } catch {
      // 任务可能正在执行（被 Worker 锁定），remove 失败时取消标记仍然生效
    }
    // 仍未被 Worker 领取的排队任务可直接终结；PROCESSING 交由 Worker 停止
    if (removedFromQueue) {
      await prisma.dataExport.updateMany({
        where: { id, status: "PENDING", cancelRequested: true },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
    }
    const updated = await prisma.dataExport.findUniqueOrThrow({ where: { id } });
    return { export: updated };
  });
};

async function downloadPayload(exportId: string): Promise<{ downloadUrl?: string; expiresIn?: number }> {
  const task = await prisma.dataExport.findUnique({ where: { id: exportId } });
  if (!task || task.status !== "READY" || !task.objectKey || !task.expiresAt || task.expiresAt <= new Date()) {
    return {};
  }
  const url = await createDownloadUrl(
    task.objectKey,
    `practice-export.${task.format}`,
    task.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
  );
  return { downloadUrl: url, expiresIn: getConfig().PLAYBACK_URL_TTL_SECONDS };
}

export default exportRoutes;
