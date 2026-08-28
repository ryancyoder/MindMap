// What a link looks like, fetched on the server because a browser cannot.
//
// Reading another site's OpenGraph tags from the page itself is a cross-origin
// request no browser will make, so the preview for a bookmark card has to be
// fetched here. That means this route takes a URL from the user and asks the
// network for it, which is the shape of request that reaches things it should
// not — so most of the file is about where it refuses to go.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostOf, normalizeUrl, readMetadata } from "@/lib/bookmark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough for a slow site, short enough that a card is not left waiting. */
const TIMEOUT_MS = 6000;
/** The tags we want are in <head>; a page that hides them past this is on its own. */
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Addresses this server must never be talked into fetching: its own loopback,
 * the private ranges of whatever network it sits on, and the link-local block
 * that cloud providers park their credential endpoints in.
 */
function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    const ipv6 = ip.toLowerCase();
    if (ipv6 === "::" || ipv6 === "::1") return true;
    // IPv4 written as IPv6 is still IPv4; judge it as such.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ipv6)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    if (/^f[cd]/.test(ipv6)) return true; // unique local
    if (/^fe[89ab]/.test(ipv6)) return true; // link-local
    return false;
  }
  return true;
}

/**
 * Whether this URL is safe to fetch.
 *
 * Every hop is checked, not just the first, because a redirect to
 * http://127.0.0.1 is the obvious way past a check that only looks at what the
 * user typed. This resolves the name and judges the address, so a hostname
 * that points at a private range is refused too.
 *
 * It is not airtight: a name that resolves differently between this check and
 * the fetch would slip through. Closing that means pinning the connection to
 * the address checked, which needs a custom agent — worth doing if this route
 * ever fetches anything more sensitive than a preview image.
 */
async function isReachable(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Read at most MAX_BYTES, and stop as soon as <head> is behind us. */
async function readHead(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BYTES || /<\/head\s*>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("url") ?? "";
  const normalized = normalizeUrl(raw);
  if (!normalized) {
    return Response.json({ error: "That is not a link." }, { status: 400 });
  }

  // The card exists either way — the preview is decoration. So a page that
  // refuses, redirects into the weeds, or serves a video answers with the
  // hostname rather than an error, and the card just shows less.
  const fallback = { url: normalized, title: hostOf(normalized), image: null, site: hostOf(normalized) };

  let current = new URL(normalized);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await isReachable(current))) {
        return Response.json({ error: "That address is not reachable." }, { status: 400 });
      }

      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // Honest about who is asking. A site that turns this away gets a
          // hostname card, which is a worse card rather than a broken one.
          "user-agent": "MindMap/1.0 (+bookmark preview)",
          accept: "text/html,application/xhtml+xml",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return Response.json(fallback);
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) return Response.json(fallback);
      const type = response.headers.get("content-type") ?? "";
      if (!/^(text\/html|application\/xhtml\+xml)/i.test(type)) return Response.json(fallback);

      const meta = readMetadata(await readHead(response), current.toString());
      return Response.json({ url: normalized, ...meta });
    }
  } catch {
    // Timeout, DNS failure, refused connection: all the same answer.
    return Response.json(fallback);
  }

  return Response.json(fallback);
}
