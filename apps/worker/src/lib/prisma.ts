import { PrismaClient } from "@prisma/client";

// Prisma 返回 BigInt 字段，写入 JSON 导出前统一降级为 number，与 API 口径一致
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function toJSON() {
  return Number(this);
};

export const prisma = new PrismaClient({ log: ["warn", "error"] });
