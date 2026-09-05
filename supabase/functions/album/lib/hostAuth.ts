// Host PIN hashing + the custom HMAC console token (PRD §12: "Console tokens
// are HMAC-signed with an 18-hour expiry, verified on every privileged call").
// Not Supabase Auth — a separate, small scheme scoped to one event.

import { supabaseAdmin } from "./supabaseAdmin.ts";

const TOKEN_TTL_MS = 18 * 60 * 60 * 1000;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const te = new TextEncoder();
const td = new TextDecoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
  return toHex(digest);
}

// Stored as "salt:hash" where hash = sha256(salt + pin), both hex.
export async function hashPin(pin: string): Promise<string> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = toHex(saltBytes.buffer);
  const hash = await sha256Hex(salt + pin);
  return `${salt}:${hash}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = await sha256Hex(salt + pin);
  if (candidate.length !== hash.length) return false;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

let cachedSecret: string | null = null;

async function getTokenSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const { data, error } = await supabaseAdmin()
    .from("album_settings")
    .select("value")
    .eq("key", "token_secret")
    .single();
  if (error || !data) throw new Error("token_secret not configured");
  cachedSecret = data.value as string;
  return cachedSecret;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface HostTokenPayload {
  event_id: string;
  slug: string;
  exp: number; // epoch ms
}

export async function mintToken(payload: Omit<HostTokenPayload, "exp">): Promise<string> {
  const secret = await getTokenSecret();
  const full: HostTokenPayload = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const payloadBytes = te.encode(JSON.stringify(full));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64url(payloadBytes)}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(
  token: string | null,
  expectedSlug?: string,
): Promise<HostTokenPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, sigPart] = parts;
  try {
    const secret = await getTokenSecret();
    const payloadBytes = b64urlDecode(payloadPart);
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sigPart),
      payloadBytes,
    );
    if (!ok) return null;
    const payload = JSON.parse(td.decode(payloadBytes)) as HostTokenPayload;
    if (payload.exp < Date.now()) return null;
    if (expectedSlug && payload.slug !== expectedSlug) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
