-- EnumValue: 导出任务支持用户取消
ALTER TYPE "ExportStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable: 分批、断点、取消与去重所需字段
ALTER TABLE "data_exports"
  ADD COLUMN "dedup_key" CHAR(64),
  ADD COLUMN "params" JSONB,
  ADD COLUMN "total_sessions" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processed_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cursor_session" UUID,
  ADD COLUMN "checkpoint_key" TEXT,
  ADD COLUMN "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "started_at" TIMESTAMPTZ(6),
  ADD COLUMN "finished_at" TIMESTAMPTZ(6);

-- 同一去重键只允许存在一个 READY 导出，重复请求复用而不生成副本
CREATE UNIQUE INDEX "data_exports_dedup_ready_key" ON "data_exports"("dedup_key") WHERE "status" = 'READY' AND "dedup_key" IS NOT NULL;

-- Worker 扫描到期导出
CREATE INDEX "data_exports_status_expires_at_idx" ON "data_exports"("status", "expires_at");
