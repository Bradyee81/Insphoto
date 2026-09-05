// The one module that touches R2/S3. Nothing else in the codebase should
// import aws4fetch or know the bucket/account id. PRD §3 / §12: the Edge
// Function chooses every object key; R2 credentials never reach a browser.

import { AwsClient } from "aws4fetch";
import { env } from "./env.ts";

const PRESIGN_TTL_SECONDS = 300; // 5 minutes — PRD §6.4

function client(): AwsClient {
  return new AwsClient({
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
    region: "auto",
    service: "s3",
  });
}

function objectUrl(key: string): URL {
  return new URL(
    `https://${env.r2AccountId}.r2.cloudflarestorage.com/${env.r2Bucket}/${key}`,
  );
}

// Server-chosen key. Guests/consoles never supply their own path.
export function makeKey(
  eventId: string,
  kind: "display" | "thumb" | "video" | "original",
  ext: string,
): string {
  const id = crypto.randomUUID();
  return `${eventId}/${kind}/${id}.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

export async function presignPut(
  key: string,
  contentType: string,
): Promise<{ url: string; expiresAt: number }> {
  const url = objectUrl(key);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signed = await client().sign(url, {
    method: "PUT",
    aws: { signQuery: true },
    headers: { "content-type": contentType },
  });
  return {
    url: signed.url,
    expiresAt: Date.now() + PRESIGN_TTL_SECONDS * 1000,
  };
}

export function publicUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  return `${env.r2PublicBase}/${key}`;
}

export async function remove(keys: (string | null | undefined)[]): Promise<void> {
  const valid = keys.filter((k): k is string => !!k);
  await Promise.all(
    valid.map(async (key) => {
      const res = await client().fetch(objectUrl(key), { method: "DELETE" });
      // R2 returns 204 on success and on already-deleted objects; anything
      // else is logged but not fatal — moderation shouldn't hang on it.
      if (!res.ok && res.status !== 404) {
        console.error(`R2 delete failed for ${key}: ${res.status}`);
      }
    }),
  );
}

// Fetches an object's bytes — used only by the ZIP export.
export async function getObject(key: string): Promise<Uint8Array | null> {
  const res = await client().fetch(objectUrl(key), { method: "GET" });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}
