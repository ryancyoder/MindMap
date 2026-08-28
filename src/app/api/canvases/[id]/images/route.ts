import { cloudConfigured, notConfigured, supabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

type ImageRow = { image_key: string; data_url: string };

/**
 * The pictures on a map's cards.
 *
 * They are fetched separately from the document because they are stored
 * separately: the map holds an image id on the card, and the bytes live in a
 * row of their own so reading or rewriting a map does not drag megabytes of
 * photograph along with it.
 */
export async function GET(request: Request, ctx: Context) {
  if (!cloudConfigured) return notConfigured();
  const { id } = await ctx.params;

  // ?keys=1 answers "which pictures are already up there" without sending any
  // of them, which is what makes a push upload only what is missing.
  const keysOnly = new URL(request.url).searchParams.get("keys") === "1";

  const { data, error } = await supabaseServer().rpc(
    keysOnly ? "mindmap_canvas_image_keys" : "mindmap_canvas_images",
    { p_canvas_id: id },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as ImageRow[];
  if (keysOnly) return Response.json({ keys: rows.map((row) => row.image_key) });
  return Response.json({
    images: rows.map((row) => ({ key: row.image_key, dataUrl: row.data_url })),
  });
}

/** Upload pictures for a map. Sending a subset is normal — see the SQL. */
export async function POST(request: Request, ctx: Context) {
  if (!cloudConfigured) return notConfigured();
  const { id } = await ctx.params;

  let body: { images?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!Array.isArray(body.images)) {
    return Response.json({ error: '"images" must be an array.' }, { status: 400 });
  }

  // Anything that isn't a picture is rejected here rather than being written
  // and discovered later: this column is read straight into an <img> src.
  const images = body.images.filter(
    (item): item is { key: string; dataUrl: string } =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { key?: unknown }).key === "string" &&
      typeof (item as { dataUrl?: unknown }).dataUrl === "string" &&
      (item as { dataUrl: string }).dataUrl.startsWith("data:image/"),
  );

  const { data, error } = await supabaseServer().rpc("mindmap_save_images", {
    p_canvas_id: id,
    p_images: images,
    p_updated_by: "app",
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ saved: data ?? 0 });
}
