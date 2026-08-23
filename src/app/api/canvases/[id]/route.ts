import { cloudConfigured, notConfigured, supabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** One map, as a JSON Canvas document. */
export async function GET(_request: Request, ctx: Context) {
  if (!cloudConfigured) return notConfigured();
  const { id } = await ctx.params;

  const { data, error } = await supabaseServer().rpc("mindmap_canvas_doc", {
    p_canvas_id: id,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "No such map." }, { status: 404 });
  return Response.json({ doc: data });
}

/** Soft delete: it leaves every listing, but its cards are still there. */
export async function DELETE(_request: Request, ctx: Context) {
  if (!cloudConfigured) return notConfigured();
  const { id } = await ctx.params;

  const { error } = await supabaseServer().rpc("mindmap_delete_canvas", {
    p_canvas_id: id,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
