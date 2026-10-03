-- 数据导出扩展：分批断点续跑、取消标记、去重键、任务关联与到期索引。

-- AlterTable
ALTER TABLE "data_exports"
  ADD COLUMN "params_hash" CHAR(64),
  ADD COLUMN "range_from" TIMESTAMPTZ(6),
  ADD COLUMN "range_to" TIMESTAMPTZ(6),
  ADD COLUMN "total_sessions" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cursor_session_id" UUID,
  ADD COLUMN "processed_sessions" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "multipart_upload_id" VARCHAR(255),
  ADD COLUMN "uploaded_parts" JSONB,
  ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "bull_job_id" VARCHAR(120);

-- 历史行没有参数信息，用填充哈希补默认值，之后再收紧 NOT NULL
UPDATE "data_exports" SET "params_hash" = CONCAT(MD5("id"::text), RPAD('', 32, '0')) WHERE "params_hash" IS NULL;
ALTER TABLE "data_exports" ALTER COLUMN "params_hash" SET NOT NULL;

-- 同一用户、同一参数只允许存在一个活动任务（PENDING/PROCESSING/READY）。
-- READY 任务在过期清理后转为 EXPIRED，届时可再次发起。
DROP INDEX IF EXISTS "data_exports_active_user_params_idx";
CREATE UNIQUE INDEX "data_exports_active_user_params_idx"
  ON "data_exports" ("user_id", "params_hash")
  WHERE "status" IN ('PENDING', 'PROCESSING', 'READY');

-- 过期清理扫描索引
CREATE INDEX "data_exports_status_expires_at_idx" ON "data_exports" ("status", "expires_at");
