-- AlterEnum
-- 新增可取消导出状态。ADD VALUE 不能与其他 DDL 放在同一事务，单独成迁移。
ALTER TYPE "ExportStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
