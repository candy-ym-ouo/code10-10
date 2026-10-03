import { createHash } from "node:crypto";
import { canonicalExportParams } from "@practice/contracts";

export interface ExportParams {
  format: "json" | "csv";
  from?: Date | null;
  to?: Date | null;
}

/**
 * 导出参数指纹。同指纹且任务处于活动状态时复用任务，不生成重复文件副本。
 * Worker 与 API 必须使用同一口径。
 */
export function hashExportParams(params: ExportParams): string {
  return createHash("sha256").update(canonicalExportParams(params)).digest("hex");
}
