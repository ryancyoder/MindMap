import CanvasClient from "./CanvasClient";

// The editor is entirely client-side in v1 — the canvas library lives in the
// browser's IndexedDB, not on a server. This page exists to own the document
// title and hand off to the client component.
export default function Page() {
  return <CanvasClient />;
}
