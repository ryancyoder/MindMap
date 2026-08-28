// Turning a pasted link into a card.
//
// Two pure pieces, deliberately kept out of both the editor and the route that
// does the fetching: deciding whether a string is a link at all, and reading a
// page's own description of itself out of its HTML. Neither needs a network or
// a browser, which is what makes them checkable.

import type { LinkPreview } from "./jsoncanvas";

/**
 * The link a string means, or null if it doesn't mean one.
 *
 * Bare hosts count — pasting `example.com/page` from a mailing list should
 * make a card — but `mailto:` and friends do not, because a bookmark card that
 * cannot be opened in a tab is a dead end.
 */
export function normalizeUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  // A scheme is a leading word with no dot in it. That is what separates
  // "mailto:someone@example.com", which is not a bookmark, from
  // "example.com:8080/path", which is a host and a port.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1];
  if (scheme && !scheme.includes(".") && !/^https?$/i.test(scheme)) return null;
  const schemed = !!scheme && !scheme.includes(".");

  let url: URL;
  try {
    url = new URL(schemed ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A bare word is a word. Requiring a dot keeps "todo" and "ideas" — the
  // things people actually type into cards — from becoming bookmarks.
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return null;
  return url.toString();
}

/** The bit of a link worth showing when nothing else is known about it. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

function decode(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      const code = /^#x/i.test(key)
        ? parseInt(key.slice(2), 16)
        : /^#/.test(key)
          ? parseInt(key.slice(1), 10)
          : NaN;
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(tag);
  if (!match) return null;
  return decode(match[2] ?? match[3] ?? match[4] ?? "");
}

/**
 * What a page says about itself: OpenGraph first, since that is the tag every
 * site maintains for exactly this purpose, then Twitter's, then the plain
 * `<title>`. Parsed with regexes rather than a DOM because this runs on the
 * server, where pulling in a parser to read four tags is not worth the weight.
 *
 * `baseUrl` is the URL the HTML actually came from, after redirects, so a
 * relative `og:image` resolves against the right host.
 */
export function readMetadata(html: string, baseUrl: string): LinkPreview {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }

  const pageTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title =
    meta.get("og:title") ||
    meta.get("twitter:title") ||
    (pageTitle ? decode(pageTitle) : "") ||
    hostOf(baseUrl);

  const rawImage =
    meta.get("og:image") ||
    meta.get("og:image:url") ||
    meta.get("og:image:secure_url") ||
    meta.get("twitter:image") ||
    meta.get("twitter:image:src");

  return {
    title,
    image: rawImage ? absoluteImage(rawImage, baseUrl) : null,
    site: meta.get("og:site_name") || hostOf(baseUrl),
  };
}

/**
 * An `og:image` may be relative, protocol-relative, or a `data:` blob. Only
 * the first two are worth keeping: the card renders the image straight from
 * the source, so anything that isn't a fetchable http(s) URL is not an image.
 */
function absoluteImage(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
