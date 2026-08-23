import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase access.
//
// Unlike VoiceData, which serves one client with two identities, MindMap never
// talks to Supabase from the browser at all — every read and write goes through
// a route handler in this app. That means no key of any kind ships to the
// client bundle, not even the anon key, and the variables here are deliberately
// NOT prefixed with NEXT_PUBLIC_ so Next.js cannot expose them by accident.
//
// The cloud library is optional. With nothing configured the app is exactly
// what it was before: local-first, fully working, no cloud section.

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const cloudConfigured = Boolean(url && serviceKey);

let client: SupabaseClient | null = null;

/** Throws when unconfigured — callers should check `cloudConfigured` first. */
export function supabaseServer(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("supabaseServer() is server-only.");
  }
  if (!url || !serviceKey) {
    throw new Error(
      "Cloud sync is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  if (!client) {
    // No session persistence: a service-role client must never try to read or
    // write a browser session.
    client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** The 503 every route returns when the cloud simply isn't set up. */
export function notConfigured(): Response {
  return Response.json(
    { error: "Cloud sync is not configured on this deployment." },
    { status: 503 },
  );
}
