import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { getConfig } from "../config/env.js";

let client: S3Client | undefined;

export class ObjectNotFoundError extends Error {}

export function getS3(): S3Client {
  if (!client) {
    const config = getConfig();
    client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }
  return client;
}

export async function getObjectStream(objectKey: string): Promise<Readable> {
  const object = await getS3().send(new GetObjectCommand({ Bucket: getConfig().S3_BUCKET, Key: objectKey }));
  if (!object.Body) throw new Error("object body is empty");
  return object.Body as Readable;
}

export async function putObject(objectKey: string, body: string | Buffer | Uint8Array, contentType: string): Promise<void> {
  await getS3().send(
    new PutObjectCommand({
      Bucket: getConfig().S3_BUCKET,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** 导出断点使用的 JSON 对象；对象不存在时返回 null。 */
export async function getJsonObject<T>(objectKey: string): Promise<T | null> {
  try {
    const stream = await getObjectStream(objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    if (error instanceof ObjectNotFoundError) return null;
    throw error;
  }
}

export async function putJsonObject(objectKey: string, value: unknown): Promise<void> {
  await putObject(objectKey, JSON.stringify(value), "application/json; charset=utf-8");
}

export async function deleteObject(objectKey: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: getConfig().S3_BUCKET, Key: objectKey }));
}

/** 删除一个用户的全部对象前缀（注销账号时使用，分页直到清空）。 */
export async function deleteObjectsByPrefix(prefix: string): Promise<number> {
  const { DeleteObjectsCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const bucket = getConfig().S3_BUCKET;
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const listed = await getS3().send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    const objects = (listed.Contents ?? []).filter((item) => item.Key).map((item) => ({ Key: item.Key! }));
    if (objects.length === 0) break;
    const result = await getS3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    deleted += result.Deleted?.length ?? objects.length;
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}
