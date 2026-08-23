// Talking to this app's own server routes, which hold the Supabase key.
//
// The browser never sees a database credential; it only ever calls /api/canvases
// on the same origin. Cloud sync is optional, so every call here reports
// "unconfigured" as a normal outcome rather than throwing — a deployment
// without Supabase set up is a working app, not a broken one.

import { parseCanvas, type Canvas } from "./jsoncanvas";

export type CloudCanvas = {
  id: string;
  name: string;
  nodes: number;
  edges: number;
  updated_at: string;
  updated_by: string;
};

export type CloudResult<T> =
  | { ok: true; value: T }
  | { ok: false; unconfigured: boolean; error: string };

async function call<T>(input: string, init?: RequestInit): Promise<CloudResult<T>> {
  try {
    const res = await fetch(input, init);
    if (res.status === 503) {
      return { ok: false, unconfigured: true, error: "Cloud sync isn't set up." };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        unconfigured: false,
        error: typeof body?.error === "string" ? body.error : `Request failed (${res.status}).`,
      };
    }
    return { ok: true, value: body as T };
  } catch (err) {
    return {
      ok: false,
      unconfigured: false,
      error: err instanceof Error ? err.message : "Could not reach the server.",
    };
  }
}

export async function listCloudCanvases(): Promise<CloudResult<CloudCanvas[]>> {
  const res = await call<{ canvases: CloudCanvas[] }>("/api/canvases");
  return res.ok ? { ok: true, value: res.value.canvases } : res;
}

export async function pushCanvas(
  doc: Canvas,
  name: string,
  id?: string | null,
): Promise<CloudResult<string>> {
  const res = await call<{ id: string }>("/api/canvases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, name, id: id ?? undefined }),
  });
  return res.ok ? { ok: true, value: res.value.id } : res;
}

export async function pullCanvas(id: string): Promise<CloudResult<Canvas>> {
  const res = await call<{ doc: unknown }>(`/api/canvases/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  try {
    // Parse on the way in as well: what an agent wrote is not guaranteed to be
    // a shape this editor can render, and the parser is where that is decided.
    return { ok: true, value: parseCanvas(JSON.stringify(res.value.doc)).canvas };
  } catch (err) {
    return {
      ok: false,
      unconfigured: false,
      error: err instanceof Error ? err.message : "That map could not be read.",
    };
  }
}

export async function deleteCloudCanvas(id: string): Promise<CloudResult<true>> {
  const res = await call<{ ok: true }>(`/api/canvases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return res.ok ? { ok: true, value: true } : res;
}
