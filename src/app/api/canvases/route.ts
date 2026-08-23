import { cloudConfigured, notConfigured, supabaseServer } from "@/lib/supabaseServer";
import { parseCanvas, serializeCanvas, type Canvas } from "@/lib/jsoncanvas";

export const dynamic = "force-dynamic";

/** Every map in the cloud library, newest first. */
export async function GET() {
  if (!cloudConfigured) return notConfigured();

  const { data, error } = await supabaseServer().rpc("mindmap_canvas_list");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ canvases: data ?? [] });
}

/**
 * Push a map up. Creating and updating are the same call: pass an id to
 * overwrite that map, omit it to make a new one.
 */
export async function POST(request: Request) {
  if (!cloudConfigured) return notConfigured();

  let body: { id?: string; name?: string; doc?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  // Run the document through the same parser the editor and the file picker
  // use, so anything that reaches the database has already been validated once
  // by the code that owns the format.
  let canvas: Canvas;
  try {
    canvas = parseCanvas(
      typeof body.doc === "string" ? body.doc : JSON.stringify(body.doc ?? {}),
    ).canvas;
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Not a valid canvas." },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseServer().rpc("mindmap_save_canvas", {
    p_doc: JSON.parse(serializeCanvas(canvas)),
    p_name: body.name ?? null,
    p_canvas_id: body.id ?? null,
    p_updated_by: "app",
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ id: data });
}
