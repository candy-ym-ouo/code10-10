import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { getConfig } from "../config/env.js";

let client: S3Client | undefined;

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

export async function putObject(objectKey: string, body: string, contentType: string): Promise<void> {
  await getS3().send(
    new PutObjectCommand({
      Bucket: getConfig().S3_BUCKET,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function deleteObject(objectKey: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: getConfig().S3_BUCKET, Key: objectKey }));
}

/** 列举前缀下全部对象键，分页自动翻完。 */
export async function listObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await getS3().send(
      new ListObjectsV2Command({
        Bucket: getConfig().S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** 批量删除前缀下全部对象（DeleteObjects 单批最多 1000 个）。 */
export async function deleteObjectsByPrefix(prefix: string): Promise<number> {
  let deleted = 0;
  const keys = await listObjectKeys(prefix);
  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000).map((Key) => ({ Key }));
    const result = await getS3().send(
      new DeleteObjectsCommand({ Bucket: getConfig().S3_BUCKET, Delete: { Objects: batch, Quiet: true } }),
    );
    deleted += result.Deleted?.length ?? batch.length;
  }
  return deleted;
}

export interface UploadedPart {
  PartNumber: number;
  ETag: string;
}

export async function createMultipartUpload(objectKey: string, contentType: string): Promise<string> {
  const result = await getS3().send(
    new CreateMultipartUploadCommand({ Bucket: getConfig().S3_BUCKET, Key: objectKey, ContentType: contentType }),
  );
  if (!result.UploadId) throw new Error("S3 did not return an upload id");
  return result.UploadId;
}

export async function uploadPart(objectKey: string, uploadId: string, partNumber: number, body: Buffer): Promise<UploadedPart> {
  const result = await getS3().send(
    new UploadPartCommand({ Bucket: getConfig().S3_BUCKET, Key: objectKey, UploadId: uploadId, PartNumber: partNumber, Body: body }),
  );
  if (!result.ETag) throw new Error("S3 did not return an etag for uploaded part");
  return { PartNumber: partNumber, ETag: result.ETag };
}

export async function completeMultipartUpload(objectKey: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
  const ordered: CompletedPart[] = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await getS3().send(
    new CompleteMultipartUploadCommand({
      Bucket: getConfig().S3_BUCKET,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: ordered },
    }),
  );
}

export async function abortMultipartUpload(objectKey: string, uploadId: string): Promise<void> {
  await getS3().send(new AbortMultipartUploadCommand({ Bucket: getConfig().S3_BUCKET, Key: objectKey, UploadId: uploadId }));
}

/** 中止前缀下所有未完成的分片上传（ListObjects 看不到它们，需单独清理）。 */
export async function abortMultipartUploadsByPrefix(prefix: string): Promise<number> {
  let aborted = 0;
  let uploadIdMarker: string | undefined;
  let keyMarker: string | undefined;
  do {
    const page = await getS3().send(
      new ListMultipartUploadsCommand({
        Bucket: getConfig().S3_BUCKET,
        Prefix: prefix,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId) {
        await abortMultipartUpload(upload.Key, upload.UploadId).catch(() => undefined);
        aborted += 1;
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
  return aborted;
}
