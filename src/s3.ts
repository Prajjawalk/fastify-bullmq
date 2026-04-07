/**
 * S3 client for storing WhatsApp media (encrypted at rest).
 *
 * Configured via AWS env vars (AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME, AWS_S3_ENDPOINT_URL).
 *
 * isS3Configured() returns false if any required vars are missing — callers
 * should check this before attempting uploads to fail gracefully.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { env } from './env';

let cachedClient: S3Client | null = null;

export function isS3Configured(): boolean {
  return Boolean(
    env.AWS_REGION &&
      env.AWS_ACCESS_KEY_ID &&
      env.AWS_SECRET_ACCESS_KEY &&
      env.AWS_S3_BUCKET_NAME,
  );
}

function getClient(): S3Client {
  if (cachedClient) return cachedClient;

  const config: ConstructorParameters<typeof S3Client>[0] = {
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  };

  if (env.AWS_S3_ENDPOINT_URL) {
    config.endpoint = env.AWS_S3_ENDPOINT_URL;
    config.forcePathStyle = true;
  }

  cachedClient = new S3Client(config);
  return cachedClient;
}

/**
 * Upload a buffer to S3.
 * Returns the S3 object key.
 */
export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType?: string;
}): Promise<string> {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured (missing AWS env vars)');
  }

  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType ?? 'application/octet-stream',
    }),
  );
  return params.key;
}

/**
 * Get the public URL of an S3 object (works for both standard AWS S3
 * and custom-endpoint S3-compatible services).
 */
export function getS3Url(key: string): string {
  if (env.AWS_S3_ENDPOINT_URL) {
    return `${env.AWS_S3_ENDPOINT_URL}/${env.AWS_S3_BUCKET_NAME}/${key}`;
  }
  return `https://${env.AWS_S3_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

/**
 * Download a buffer from S3.
 */
export async function downloadFromS3(key: string): Promise<Buffer> {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured');
  }

  const client = getClient();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
    }),
  );

  if (!result.Body) {
    throw new Error(`S3 object ${key} returned empty body`);
  }

  // result.Body is a ReadableStream — convert to Buffer
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = result.Body as any;
  if (typeof stream.transformToByteArray === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes as Uint8Array);
  }
  // Fallback for stream interface
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Delete an S3 object.
 */
export async function deleteFromS3(key: string): Promise<void> {
  if (!isS3Configured()) return;

  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
    }),
  );
}
