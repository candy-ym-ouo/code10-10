import { prisma } from "./prisma.js";
import { deleteObjectsByPrefix } from "./s3.js";

type Log = (level: "info" | "error" | "warn", data: Record<string, unknown>, message: string) => void;

/**
 * 账号注销的最终清理：
 * - 先删除该用户对象存储前缀（音频、导出成品、导出断点），使所有预签名链接立即失效；
 * - 再删除用户行，PostgreSQL 外键级联清除练习、媒体、目标、导出等全部业务数据；
 * - 任一步失败抛出由 BullMQ 重试；用户保持 DELETING，不允许重新登录。
 */
export async function deleteAccountData(userId: string, log: Log): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!user) {
    log("info", { userId }, "account already deleted");
    return;
  }

  const deletedObjects = await deleteObjectsByPrefix(`users/${userId}/`).catch((error) => {
    log("error", { userId, err: error instanceof Error ? error.message : String(error) }, "user object cleanup failed");
    throw error;
  });

  await prisma.user.delete({ where: { id: userId } });
  log("info", { userId, deletedObjects }, "account deletion completed");
}
