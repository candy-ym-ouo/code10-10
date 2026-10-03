import { prisma } from "../lib/prisma.js";
import { abortMultipartUploadsByPrefix, deleteObjectsByPrefix } from "../lib/s3.js";

/**
 * 账号删除清理：用户全部对象（音频、共享对象、导出文件）位于 users/{userId}/ 前缀，
 * 批量删除后级联删除数据库行。删除完成后任何此前签发的预签名链接都会 404。
 * 失败时保留 DELETING 状态与用户行，由 BullMQ 重试。
 */
export async function processAccountDeletion(userId: string): Promise<{ objectsDeleted: number; uploadsAborted: number }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!user) return { objectsDeleted: 0, uploadsAborted: 0 };

  // 正在进行的导出分片不在对象列表里，先中止再删对象，避免账号删除后残留分片
  const uploadsAborted = await abortMultipartUploadsByPrefix(`users/${userId}/`);
  const objectsDeleted = await deleteObjectsByPrefix(`users/${userId}/`);
  await prisma.user.delete({ where: { id: userId } });
  return { objectsDeleted, uploadsAborted };
}
