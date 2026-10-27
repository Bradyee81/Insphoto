// Sends a Realtime Broadcast message over Supabase's REST broadcast endpoint
// — no persistent socket needed, which matters because an Edge Function
// invocation is short-lived. Used only for the "hide" RLS gap described in
// the plan: an UPDATE that makes a row fail the anon SELECT policy produces
// no postgres_changes event, so we nudge subscribers directly instead.

import { env } from "./env.ts";

export async function sendBroadcast(
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${env.supabaseUrl}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: env.serviceRoleKey,
      authorization: `Bearer ${env.serviceRoleKey}`,
    },
    body: JSON.stringify({
      messages: [{ topic, event, payload, private: false }],
    }),
  });
  if (!res.ok) {
    console.error(`broadcast failed: ${res.status} ${await res.text()}`);
  }
}

// A photo left the public album (deleted, or hidden by the host). Neither
// transition reaches anon subscribers through postgres_changes — DELETE
// events can't be filtered by event_id, and a row that stops passing the
// anon SELECT policy produces no event — so tell the guest feed and the LED
// directly, on the exact channel names they subscribe to.
export async function notifyMediaRemoved(eventId: string, mediaId: string): Promise<void> {
  await Promise.all([
    sendBroadcast(`feed:${eventId}`, "media_removed", { id: mediaId }),
    sendBroadcast(`led:${eventId}`, "media_removed", { id: mediaId }),
  ]);
}
