// The cloud canvas library, end to end through the app's own routes.
//
// This one needs credentials, so it skips cleanly when the deployment has no
// Supabase configured — a MindMap without cloud sync is a working app, not a
// broken one, and the suite should say so rather than fail.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run start &
//   node scripts/verify-cloud.mjs
//
// It writes and then removes its own map. It never touches anything else.

import { BASE_URL, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();

const probe = await fetch(`${BASE_URL}/api/canvases`).catch(() => null);
if (!probe) {
  console.log(`Could not reach ${BASE_URL}. Is the app running?`);
  process.exit(1);
}
if (probe.status === 503) {
  console.log("Cloud sync is not configured on this deployment — skipping.");
  console.log("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run these checks.");
  process.exit(0);
}

const api = async (path, init) => {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

// Every part of the spec, plus keys this schema does not model.
const DOC = {
  nodes: [
    { id: "c1", type: "text", text: "Root", x: -260, y: -180, width: 260, height: 80, color: "4" },
    { id: "c2", type: "link", url: "https://jsoncanvas.org", x: 120, y: -140, width: 240, height: 70, color: "#8b5cf6" },
    { id: "c3", type: "group", label: "Later", x: -300, y: 40, width: 700, height: 220, backgroundStyle: "cover" },
    { id: "c4", type: "file", file: "notes/Ideas.md", subpath: "#Open", x: -260, y: 90, width: 260, height: 80, obsidianOnlyKey: { nested: true } },
  ],
  edges: [
    { id: "ce1", fromNode: "c1", fromSide: "right", toNode: "c2", toSide: "left", label: "how" },
    { id: "ce2", fromNode: "c1", toNode: "c3", toEnd: "none", color: "3" },
  ],
  someFutureTopLevelKey: 42,
};

const created = await api("/api/canvases", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ doc: DOC, name: "Cloud check (safe to delete)" }),
});
check("pushing a map succeeds", created.status, 200);
const id = created.body.id;
check("and returns an id", typeof id === "string" && id.length > 0, true);

const listed = await api("/api/canvases");
check("the map appears in the listing", listed.body.canvases.some((c) => c.id === id), true);
const row = listed.body.canvases.find((c) => c.id === id);
check("with its card and link counts", [row?.nodes, row?.edges], [4, 2]);

const pulled = await api(`/api/canvases/${id}`);
check("pulling it back succeeds", pulled.status, 200);
const doc = pulled.body.doc;
const byId = Object.fromEntries(doc.nodes.map((n) => [n.id, n]));

check("all four node types survived", doc.nodes.length, 4);
check("node order is preserved", doc.nodes.map((n) => n.id).join(), "c1,c2,c3,c4");
check("preset colour survived", byId.c1.color, "4");
check("hex colour survived", byId.c2.color, "#8b5cf6");
check("group label and style survived", [byId.c3.label, byId.c3.backgroundStyle], ["Later", "cover"]);
check("file path and subpath survived", [byId.c4.file, byId.c4.subpath], ["notes/Ideas.md", "#Open"]);
check("an unknown node key survived the database", byId.c4.obsidianOnlyKey, { nested: true });
check("an unknown top-level key survived too", doc.someFutureTopLevelKey, 42);
check("edge label survived", doc.edges.find((e) => e.id === "ce1")?.label, "how");
check("edge end and colour survived", [
  doc.edges.find((e) => e.id === "ce2")?.toEnd,
  doc.edges.find((e) => e.id === "ce2")?.color,
], ["none", "3"]);

// Pushing again with the same id updates rather than duplicating.
const updated = await api("/api/canvases", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    doc: { ...DOC, nodes: DOC.nodes.slice(0, 2), edges: [DOC.edges[0]] },
    name: "Cloud check (safe to delete)",
    id,
  }),
});
check("pushing again with the same id succeeds", updated.status, 200);
check("and updates in place rather than duplicating", updated.body.id, id);
const after = await api(`/api/canvases/${id}`);
check("the update replaced the contents", after.body.doc.nodes.length, 2);

// Malformed input must be refused, not stored.
const bad = await api("/api/canvases", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ doc: "{ not json at all", name: "nope" }),
});
check("malformed input is rejected", bad.status, 400);

const gone = await api(`/api/canvases/${id}`, { method: "DELETE" });
check("deleting succeeds", gone.status, 200);
const afterDelete = await api("/api/canvases");
check("and it leaves the listing", afterDelete.body.canvases.some((c) => c.id === id), false);

check("a missing map reads as 404", (await api(`/api/canvases/${id}`)).status, 404);

process.exit(finish() ? 1 : 0);
