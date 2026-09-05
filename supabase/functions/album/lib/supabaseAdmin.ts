import { createClient } from "@supabase/supabase-js";
import { env } from "./env.ts";

let client: ReturnType<typeof createClient> | null = null;

// Service-role client — server-side only, never exposed to a browser.
// Bypasses RLS, so every call site is responsible for its own checks.
export function supabaseAdmin() {
  if (!client) {
    client = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}
