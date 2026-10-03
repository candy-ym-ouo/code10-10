import { prisma } from "./prisma.js";

export interface ExportParams {
  format: string;
  from?: string | null;
  to?: string | null;
}

export interface SessionExportRow {
  session: Record<string, unknown>;
  media: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  review: Record<string, unknown> | null;
}

export interface ExportCheckpoint {
  version: 1;
  userId: string;
  format: string;
  params: { from: string | null; to: string | null };
  profile: Record<string, unknown>;
  batches: SessionExportRow[];
}

const sessionInclude = {
  mediaAssets: {
    select: { id: true, originalName: true, durationMs: true, codec: true, sampleRate: true, channels: true, status: true },
  },
  annotations: true,
  goals: { include: { progresses: true } },
  review: true,
} as const;

// Prisma 的 Decimal/BigInt 不保证直接 JSON 序列化的稳定性，这里显式转换
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return Number(value);
  // Prisma Decimal 带有 toJSON/toFixed
  if (typeof value === "object" && value !== null && "toFixed" in value && typeof (value as { toFixed: unknown }).toFixed === "function") {
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = normalize(item);
    return result;
  }
  return value;
}

export function totalSessions(userId: string, params: Pick<ExportParams, "from" | "to">): Promise<number> {
  return prisma.practiceSession.count({ where: { userId, ...sessionDateFilter(params) } });
}

function sessionDateFilter(params: Pick<ExportParams, "from" | "to">) {
  const startedAt: { gte?: Date; lte?: Date } = {};
  if (params.from) startedAt.gte = new Date(params.from);
  if (params.to) startedAt.lte = new Date(params.to);
  return Object.keys(startedAt).length > 0 ? { startedAt } : {};
}

/**
 * 按稳定游标读取一批练习及其关联数据。
 * 游标为上一批最后一个 session id（同 startedAt 并列时仍唯一），保证断点续跑不漏不重。
 */
export async function fetchSessionBatch(
  userId: string,
  params: Pick<ExportParams, "from" | "to">,
  cursor: string | null,
  batchSize: number,
): Promise<{ rows: SessionExportRow[]; nextCursor: string | null }> {
  const sessions = await prisma.practiceSession.findMany({
    where: { userId, ...sessionDateFilter(params) },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: batchSize,
    include: sessionInclude,
  });
  const rows: SessionExportRow[] = sessions.map((session) => ({
    session: normalize(session) as Record<string, unknown>,
    media: session.mediaAssets.map((media) => normalize(media) as Record<string, unknown>),
    annotations: session.annotations.map((annotation) => normalize(annotation) as Record<string, unknown>),
    goals: session.goals.map((goal) => normalize(goal) as Record<string, unknown>),
    review: (session.review ? normalize(session.review) : null) as Record<string, unknown> | null,
  }));
  return { rows, nextCursor: sessions.length === batchSize ? (sessions.at(-1)?.id ?? null) : null };
}

export async function loadProfile(userId: string): Promise<Record<string, unknown>> {
  const profile = await prisma.user.findUniqueOrThrow({
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
  return normalize(profile) as Record<string, unknown>;
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/** 将一批行平铺为 CSV 记录（recordType,id,sessionId,data）。 */
export function batchesToCsv(batches: SessionExportRow[]): string {
  const rows: string[][] = [["recordType", "id", "sessionId", "data"]];
  for (const batch of batches) {
    rows.push(["session", batch.session.id as string, batch.session.id as string, JSON.stringify(batch.session)]);
    for (const media of batch.media) rows.push(["media", media.id as string, batch.session.id as string, JSON.stringify(media)]);
    for (const annotation of batch.annotations) {
      rows.push(["annotation", annotation.id as string, batch.session.id as string, JSON.stringify(annotation)]);
    }
    for (const goal of batch.goals) rows.push(["goal", goal.id as string, batch.session.id as string, JSON.stringify(goal)]);
  }
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function finalizeExport(checkpoint: ExportCheckpoint): { body: string; contentType: string } {
  if (checkpoint.format === "csv") {
    return { body: batchesToCsv(checkpoint.batches), contentType: "text/csv; charset=utf-8" };
  }
  const body = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      range: { from: checkpoint.params.from, to: checkpoint.params.to },
      user: checkpoint.profile,
      practiceSessions: checkpoint.batches,
    },
    null,
    2,
  );
  return { body, contentType: "application/json; charset=utf-8" };
}
