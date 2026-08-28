// Turning a pasted link into a card.
//
// Two pure pieces, deliberately kept out of both the editor and the route that
// does the fetching: deciding whether a string is a link at all, and reading a
// page's own description of itself out of its HTML. Neither needs a network or
// a browser, which is what makes them checkable.

import type { LinkPreview } from "./jsoncanvas";

/**
 * Smaller than this and an icon is not a picture, it is a postage stamp. A
 * 16px favicon blown up to fill a card is a blurry smear, so a site that
 * declares nothing bigger is better served by its OpenGraph image.
 */
export const ICON_MIN = 64;

/**
 * The size an icon has to reach before it is worth no further trouble.
 *
 * A bookmark card is 168px and can be dragged bigger, on a screen that is
 * almost certainly 2x — so a 180px icon is already being asked for more pixels
 * than it has. Below this it is worth a second request to see whether the site
 * has better art somewhere.
 */
export const ICON_TARGET = 256;

/** What `apple-touch-icon` means when it declares no size. */
const APPLE_DEFAULT = 180;

/** An SVG is whatever size we ask for, so it outranks any fixed bitmap. */
const SCALABLE = 4096;

/** Everything a page says about itself, plus where to look for more. */
export type PageMetadata = LinkPreview & {
  /** A web app manifest to read icons out of, if the page named one. */
  manifest: string | null;
  /** How big the chosen icon is, so the caller can decide whether to look further. */
  iconSize: number;
};

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
 * The size a `sizes` attribute claims, as a single number to sort by.
 *
 * `sizes` may list several ("32x32 16x16") or say `any`, which means an SVG.
 */
function largestSize(value: string | null): number {
  if (!value) return 0;
  if (/(^|\s)any(\s|$)/i.test(value)) return SCALABLE;
  let best = 0;
  for (const token of value.split(/\s+/)) {
    const dims = /^(\d+)x(\d+)$/i.exec(token);
    if (dims) best = Math.max(best, Number(dims[1]));
  }
  return best;
}

type IconCandidate = { url: string; rank: number; size: number };

/** An icon and how big it is, so a caller can tell whether to keep looking. */
export type IconChoice = { url: string; size: number };

/**
 * Best first, and **size leads**.
 *
 * The obvious ordering is Apple's icon first, since that is the one iOS shows.
 * It gives a blurry card: `apple-touch-icon` is 180px by convention, the card
 * is 168 and can be dragged bigger, and the screen is 2x — so the picture is
 * upscaled before it is even touched. A site's manifest usually carries the
 * same artwork at 512, and the sharp copy of the same picture is the better
 * answer to "show me the icon".
 *
 * Maskable icons stay last whatever their size, because they are drawn with
 * bleed for the platform to crop and look wrong shown whole. Among icons of the
 * same size, Apple's is the one iOS would have picked.
 */
function bestIcon(candidates: IconCandidate[]): IconChoice | null {
  const usable = candidates.filter((c) => c.size >= ICON_MIN);
  usable.sort(
    (a, b) => Number(b.rank > 0) - Number(a.rank > 0) || b.size - a.size || b.rank - a.rank,
  );
  const best = usable[0];
  return best ? { url: best.url, size: best.size } : null;
}

/**
 * The icon a web app manifest declares, if it declares one worth using.
 *
 * `maskable` icons are drawn expecting to be cropped to whatever shape the
 * platform likes, so they carry deliberate bleed around the edges and look
 * wrong shown whole. Anything else is preferred, and one is used only if
 * nothing else offered.
 */
export function iconFromManifest(manifest: unknown, baseUrl: string): IconChoice | null {
  if (!manifest || typeof manifest !== "object") return null;
  const icons = (manifest as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return null;

  const candidates: IconCandidate[] = [];
  for (const entry of icons) {
    if (!entry || typeof entry !== "object") continue;
    const { src, sizes, purpose } = entry as Record<string, unknown>;
    if (typeof src !== "string" || !src) continue;
    const url = absoluteImage(src, baseUrl);
    if (!url) continue;
    const maskable = typeof purpose === "string" && /maskable/i.test(purpose);
    candidates.push({
      url,
      rank: maskable ? 0 : 1,
      size: largestSize(typeof sizes === "string" ? sizes : null),
    });
  }
  return bestIcon(candidates);
}

/**
 * What a page says about itself: OpenGraph first, since that is the tag every
 * site maintains for exactly this purpose, then Twitter's, then the plain
 * `<title>`. Parsed with regexes rather than a DOM because this runs on the
 * server, where pulling in a parser to read a handful of tags is not worth the
 * weight.
 *
 * The icon is picked the way iOS picks one for the home screen: an
 * `apple-touch-icon` if there is one, then the manifest (which the caller
 * fetches, since it is a second request), then any declared icon big enough to
 * be worth looking at.
 *
 * `baseUrl` is the URL the HTML actually came from, after redirects, so a
 * relative href resolves against the right host.
 */
export function readMetadata(html: string, baseUrl: string): PageMetadata {
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

  const icons: IconCandidate[] = [];
  let manifest: string | null = null;

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rels = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (!href) continue;

    if (rels.includes("manifest")) {
      manifest = manifest ?? absoluteImage(href, baseUrl);
      continue;
    }

    const apple =
      rels.includes("apple-touch-icon") || rels.includes("apple-touch-icon-precomposed");
    if (!apple && !rels.includes("icon")) continue;

    const url = absoluteImage(href, baseUrl);
    if (!url) continue;
    // An apple-touch-icon with no size is 180px by convention, and is what iOS
    // reaches for first. A plain <link rel=icon> with no size is usually the
    // 16px favicon, and gets no benefit of the doubt.
    icons.push({
      url,
      rank: apple ? 2 : 1,
      size: largestSize(attr(tag, "sizes")) || (apple ? APPLE_DEFAULT : 0),
    });
  }

  const icon = bestIcon(icons);
  return {
    title,
    site: meta.get("og:site_name") || hostOf(baseUrl),
    icon: icon?.url ?? null,
    iconSize: icon?.size ?? 0,
    image: rawImage ? absoluteImage(rawImage, baseUrl) : null,
    manifest,
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
