import { createHash } from "node:crypto";
import { canonicalExportParams } from "@practice/contracts";
import { prisma } from "./prisma.js";

// BigInt（时长等）以数字写入 JSON 导出，与 API 序列化口径一致
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function toJSON() {
  return Number(this);
};

export type ExportFormat = "json" | "csv";

export interface ExportRange {
  from?: Date | null;
  to?: Date | null;
}

export function hashExportParams(params: { format: ExportFormat; from?: Date | null; to?: Date | null }): string {
  return createHash("sha256").update(canonicalExportParams(params)).digest("hex");
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
};

function sessionDateFilter(range: ExportRange) {
  return {
    ...(range.from ? { gte: range.from } : {}),
    ...(range.to ? { lt: range.to } : {}),
  };
}

/** 统计待导出练习总数，用于进度展示与恢复时校准。 */
export async function countExportSessions(userId: string, range: ExportRange): Promise<number> {
  return prisma.practiceSession.count({
    where: { userId, startedAt: sessionDateFilter(range) },
  });
}

/**
 * 按练习 ID 游标读取一批练习（含音频元数据、标记、目标、进度与复盘）。
 * 游标分页保证分批期间新增数据不影响断点续跑口径。
 */
export async function fetchSessionBatch(
  userId: string,
  range: ExportRange,
  cursorId: string | null,
  take: number,
) {
  return prisma.practiceSession.findMany({
    where: {
      userId,
      startedAt: sessionDateFilter(range),
      ...(cursorId ? { id: { gt: cursorId } } : {}),
    },
    orderBy: { id: "asc" },
    take,
    include: {
      mediaAssets: {
        select: { id: true, originalName: true, durationMs: true, codec: true, sampleRate: true, channels: true, status: true },
      },
      annotations: true,
      goals: { include: { progresses: true } },
      review: true,
    },
  });
}

type SessionBatch = Awaited<ReturnType<typeof fetchSessionBatch>>;

/** 用户档案（导出头，只读取一次，续跑时不再需要）。目标全部挂在练习下，随批次导出。 */
export async function fetchExportHeader(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      defaultInstrument: true,
      timezone: true,
      locale: true,
      createdAt: true,
    },
  });
}

type ExportHeader = Awaited<ReturnType<typeof fetchExportHeader>>;

/**
 * 文件头：JSON 打开 practiceSessions 数组；CSV 写入列表头与用户行。
 * 之后每个批次作为独立文本块缓冲，达到分片阈值才上传 S3 分片。
 */
export function buildHead(format: ExportFormat, header: ExportHeader, range: ExportRange): string {
  if (format === "csv") {
    const rows: string[][] = [["recordType", "id", "sessionId", "data"]];
    rows.push(["user", header.id, header.id, JSON.stringify(header)]);
    return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
  }
  return [
    "{",
    `"format": "practice-journal-export/v1",`,
    `"exportedAt": ${JSON.stringify(new Date().toISOString())},`,
    `"range": ${JSON.stringify({ from: range.from ?? null, to: range.to ?? null })},`,
    `"user": ${JSON.stringify(header, null, 2)},`,
    `"practiceSessions": [`,
  ].join("\n");
}

/** 一批练习序列化为文本块。emittedBefore 决定 JSON 是否需要前导逗号。 */
export function serializeSessionsChunk(format: ExportFormat, sessions: SessionBatch, emittedBefore: number): string {
  if (sessions.length === 0) return "";
  if (format === "csv") {
    const rows: string[][] = [];
    for (const session of sessions) {
      rows.push(["session", session.id, session.id, JSON.stringify(session)]);
      for (const media of session.mediaAssets) rows.push(["media", media.id, session.id, JSON.stringify(media)]);
      for (const annotation of session.annotations) rows.push(["annotation", annotation.id, session.id, JSON.stringify(annotation)]);
      for (const goal of session.goals) rows.push(["goal", goal.id, session.id, JSON.stringify(goal)]);
    }
    return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  }
  const body = sessions.map((session) => JSON.stringify(session, null, 2)).join(",\n");
  return `${emittedBefore > 0 ? ",\n" : "\n"}${body}`;
}

export function buildSuffix(format: ExportFormat, emitted: number): string {
  if (format === "csv") return "";
  return `${emitted > 0 ? "\n" : ""}]}\n`;
}
