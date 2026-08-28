// Pasting a link, and the card it becomes.
//
// Two halves, checked differently. The card itself is checked in the browser
// with the preview route stubbed, because a suite that reaches out to a real
// website fails on the day that website is slow rather than on the day this
// code is wrong.
//
// The route's own checks are the ones that matter more, and they are the
// refusals. It takes a URL from whoever is holding the iPad and asks the
// network for it, from a server that sits next to a service-role key — so the
// addresses it must never be talked into fetching are asserted here: loopback,
// the private ranges, the link-local block cloud providers keep credentials
// on, and a redirect into any of them.

import { BASE_URL, launchBrowser, makeChecker, readPersistedCanvas } from "./_harness.mjs";
import { iconFromManifest, readMetadata } from "../src/lib/bookmark.ts";

const { check, finish } = makeChecker();

// ── which icon a page's markup means ───────────────────────────────────────
//
// The card wants the icon iOS would put on the home screen, and a page can
// declare half a dozen. This is the ordering, checked against the module
// directly — node strips the types, so the real code runs with no build step
// and no browser in the way.

const markup = (head) => `<html><head>${head}</head><body></body></html>`;
const iconOf = (head, base = "https://example.com/a/b") => readMetadata(markup(head), base).icon;

check(
  "an apple-touch-icon is what gets used",
  iconOf(`<link rel="apple-touch-icon" href="/touch.png">`),
  "https://example.com/touch.png",
);
check(
  "even when a bigger plain icon is offered, because iOS prefers Apple's",
  iconOf(
    `<link rel="icon" sizes="512x512" href="/big.png">` +
      `<link rel="apple-touch-icon" href="/touch.png">`,
  ),
  "https://example.com/touch.png",
);
check(
  "the largest apple-touch-icon wins among its own",
  iconOf(
    `<link rel="apple-touch-icon" sizes="120x120" href="/small.png">` +
      `<link rel="apple-touch-icon" sizes="180x180" href="/large.png">`,
  ),
  "https://example.com/large.png",
);
check(
  "apple-touch-icon-precomposed counts too",
  iconOf(`<link rel="apple-touch-icon-precomposed" href="/pre.png">`),
  "https://example.com/pre.png",
);
check(
  "a 16px favicon is not a picture, so it is refused",
  iconOf(`<link rel="shortcut icon" sizes="16x16" href="/favicon.ico">`),
  null,
);
check(
  "a favicon with no size at all is refused for the same reason",
  iconOf(`<link rel="icon" href="/favicon.ico">`),
  null,
);
check(
  "a big enough plain icon is used when Apple's is absent",
  iconOf(`<link rel="icon" sizes="192x192" href="/icon-192.png">`),
  "https://example.com/icon-192.png",
);
check(
  "an SVG icon outranks a bitmap, since it is whatever size we ask",
  iconOf(
    `<link rel="icon" sizes="192x192" href="/icon.png">` +
      `<link rel="icon" sizes="any" type="image/svg+xml" href="/icon.svg">`,
  ),
  "https://example.com/icon.svg",
);
check(
  "a relative href resolves against the page, not the site root",
  iconOf(`<link rel="apple-touch-icon" href="touch.png">`),
  "https://example.com/a/touch.png",
);
check(
  "a protocol-relative href keeps the page's scheme",
  iconOf(`<link rel="apple-touch-icon" href="//cdn.example.net/t.png">`),
  "https://cdn.example.net/t.png",
);
check(
  "an entity-escaped href is unescaped",
  iconOf(`<link rel="apple-touch-icon" href="/t.png?a=1&amp;b=2">`),
  "https://example.com/t.png?a=1&b=2",
);
check(
  "a manifest is reported so the route can go and read it",
  readMetadata(markup(`<link rel="manifest" href="/site.webmanifest">`), "https://example.com/").manifest,
  "https://example.com/site.webmanifest",
);

const manifest = (icons) => iconFromManifest({ icons }, "https://example.com/");
check(
  "the manifest's largest icon is the one taken",
  manifest([
    { src: "/m-192.png", sizes: "192x192" },
    { src: "/m-512.png", sizes: "512x512" },
  ]),
  "https://example.com/m-512.png",
);
check(
  "a maskable icon loses to a plain one, since it is drawn to be cropped",
  manifest([
    { src: "/mask.png", sizes: "512x512", purpose: "maskable" },
    { src: "/plain.png", sizes: "192x192" },
  ]),
  "https://example.com/plain.png",
);
check(
  "but a maskable icon is better than nothing",
  manifest([{ src: "/mask.png", sizes: "512x512", purpose: "maskable" }]),
  "https://example.com/mask.png",
);
check("a manifest with no icons says so", manifest(undefined), null);

// The OpenGraph picture is still read, as the fallback for a site with no icon.
check(
  "the banner is still picked up",
  readMetadata(markup(`<meta property="og:image" content="/banner.jpg">`), "https://example.com/").image,
  "https://example.com/banner.jpg",
);

// ── the route refuses to go anywhere private ───────────────────────────────

const blocked = [
  ["loopback by name", "http://localhost/"],
  ["loopback by address", "http://127.0.0.1:3000/"],
  ["another loopback address", "http://127.63.1.9/"],
  ["the link-local metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
  ["a private range", "http://192.168.1.1/"],
  ["another private range", "http://10.0.0.1/admin"],
  ["a carrier-grade NAT address", "http://100.100.100.200/"],
  ["IPv6 loopback", "http://[::1]/"],
  ["IPv4 dressed as IPv6", "http://[::ffff:127.0.0.1]/"],
];

for (const [label, url] of blocked) {
  const res = await fetch(`${BASE_URL}/api/bookmark?url=${encodeURIComponent(url)}`);
  check(`refuses ${label}`, res.status, 400);
}

const rejected = [
  ["a file path", "file:///etc/passwd"],
  ["a mail address", "mailto:someone@example.com"],
  ["javascript", "javascript:alert(1)"],
  ["a bare word", "ideas"],
  ["nothing at all", ""],
];

for (const [label, url] of rejected) {
  const res = await fetch(`${BASE_URL}/api/bookmark?url=${encodeURIComponent(url)}`);
  check(`rejects ${label}`, res.status, 400);
}

// A public name is allowed through the guard. Whether the fetch itself
// succeeds depends on the network, so this only asserts it was not refused.
const allowed = await fetch(
  `${BASE_URL}/api/bookmark?url=${encodeURIComponent("https://example.com/page")}`,
);
check("lets a public address through the guard", allowed.status, 200);

// ── the card, with the route stubbed ───────────────────────────────────────

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// A 1x1 PNG, so the <img> really loads rather than only being asked to.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let previewRequests = 0;
await page.route("**/api/bookmark**", async (route) => {
  previewRequests++;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      url: "https://jsoncanvas.org/spec/1.0/",
      title: "JSON Canvas Spec 1.0",
      icon: `${BASE_URL}/__stub-icon.png`,
      image: `${BASE_URL}/__stub.png`,
      site: "jsoncanvas.org",
    }),
  });
});
await page.route("**/__stub*.png", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PIXEL, "base64") }),
);

await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

/** Paste as the browser delivers it, rather than by typing into a field. */
const pasteOnCanvas = (text) =>
  page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

const nodes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-node-id]")].map((n) => ({
      w: Math.round(parseFloat(n.style.width)),
      h: Math.round(parseFloat(n.style.height)),
    })),
  );

await pasteOnCanvas("https://jsoncanvas.org/spec/1.0/");
await page.waitForTimeout(500);

const made = await nodes();
check("pasting a link makes one card", made.length, 1);
check("the card is square", made[0] && made[0].w === made[0].h, true);
check("the preview was asked for", previewRequests, 1);
check(
  "the card shows one picture",
  await page.locator("[data-node-id] img").count(),
  1,
);
// The icon is the point: a bookmark says which site this is, and a banner says
// which article. Given both, the icon is what shows.
check(
  "and it is the site's icon, not the OpenGraph banner",
  await page.locator("[data-node-id] img").getAttribute("src"),
  `${BASE_URL}/__stub-icon.png`,
);
// Filling the card is the whole point of showing an icon rather than a photo.
check(
  "the icon fills the card, edge to edge",
  await page.evaluate(() => {
    const card = document.querySelector("[data-node-id]");
    const img = card.querySelector("img");
    const a = card.getBoundingClientRect();
    const b = img.getBoundingClientRect();
    const fills = Math.abs(a.width - b.width) < 4 && Math.abs(a.height - b.height) < 4;
    return { fills, fit: getComputedStyle(img).objectFit };
  }),
  { fills: true, fit: "cover" },
);
check(
  "and its title",
  await page.locator('[class*="bookmarkTitle"]').innerText(),
  "JSON Canvas Spec 1.0",
);
check(
  "with somewhere to open it",
  await page.locator('[data-card-action="open"]').getAttribute("href"),
  "https://jsoncanvas.org/spec/1.0/",
);

// Pasting something that is not a link must leave the canvas alone — the app
// is for writing on, and most of what gets pasted is words.
await pasteOnCanvas("just some words about the map");
await page.waitForTimeout(300);
check("pasting plain text makes no card", (await nodes()).length, 1);

// ── what reaches the file ──────────────────────────────────────────────────

await page.waitForTimeout(800);
const doc = await readPersistedCanvas(page);
const link = doc.nodes.find((n) => n.type === "link");
check("it is saved as a spec link node", !!link, true);
check("with the url it was given", link.url, "https://jsoncanvas.org/spec/1.0/");
check("and the preview cached beside it", link["x-mindmap-preview"].title, "JSON Canvas Spec 1.0");
check(
  "the icon is what the card remembers",
  link["x-mindmap-preview"].icon,
  `${BASE_URL}/__stub-icon.png`,
);
check("nothing invented at the top level", Object.keys(doc).sort().join(), "edges,nodes");

// ── the sheet, which is the path without a keyboard ────────────────────────

await page.getByRole("button", { name: "Link", exact: true }).click();
await page.waitForTimeout(250);
const addButton = page.getByRole("button", { name: "Add card" });
check("Add is refused until it is a link", await addButton.isDisabled(), true);

await page.locator('input[aria-label="Link address"]').fill("obsidian.md/canvas");
await page.waitForTimeout(200);
check("a bare host counts as a link", await addButton.isDisabled(), false);
await addButton.click();
await page.waitForTimeout(500);
check("the sheet adds a second card", (await nodes()).length, 2);

await page.waitForTimeout(800);
const after = await readPersistedCanvas(page);
check(
  "a bare host is stored with a scheme",
  after.nodes.filter((n) => n.type === "link").map((n) => n.url).sort().join(" "),
  "https://jsoncanvas.org/spec/1.0/ https://obsidian.md/canvas",
);

// Two cards added one after another both aim at the middle of the view, so
// the second has to step off the first rather than hide underneath it.
const placed = await page.evaluate(() =>
  [...document.querySelectorAll("[data-node-id]")].map((n) => `${n.style.left},${n.style.top}`),
);
check("the second card does not land on top of the first", new Set(placed).size, 2);

// ── a card is still a card ─────────────────────────────────────────────────

// The Open button is exempt from the surface's pointer capture, but the rest
// of the card must not be, or a bookmark could never be dragged. The cards
// cascade, so this grabs the topmost one — the one a finger would actually get.
const topmost = () =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll("[data-node-id]")];
    const el = els[els.length - 1];
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
  });
const before = await topmost();
const box = await page.locator("[data-node-id]").last().boundingBox();
await page.evaluate(
  ({ x, y }) => {
    const surface = document.querySelector('[class*="surface"]');
    const at = (type, cx, cy) =>
      surface.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 77, pointerType: "touch", isPrimary: true,
          clientX: cx, clientY: cy, width: 50, height: 50,
          pressure: type === "pointerup" ? 0 : 0.5, bubbles: true, cancelable: true,
        }),
      );
    at("pointerdown", x, y);
    for (let i = 1; i <= 8; i++) at("pointermove", x + i * 10, y + i * 5);
    at("pointerup", x + 80, y + 40);
  },
  { x: box.x + box.width / 2, y: box.y + box.height / 2 },
);
await page.waitForTimeout(350);
const moved = await topmost();
check("a bookmark card still drags", [moved.x - before.x, moved.y - before.y], [80, 40]);

// ── where bookmarks meet pictures ──────────────────────────────────────────
//
// Both features put a picture on a card and both answer a paste, so these are
// the two places the merge could go wrong without either suite noticing.

/** A JPEG, made in the page, of the sort a camera or a screenshot produces. */
const makePhoto = () =>
  page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#7a1f1f";
    ctx.fillRect(0, 0, 600, 400);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360} 60% ${30 + (i % 50)}%)`;
      ctx.fillRect((i * 97) % 600, (i * 211) % 400, 30, 30);
    }
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
  });

const photo = await makePhoto();

// A photo put on a bookmark card is the one that shows: it was chosen, where
// the fetched one was only offered.
await page.locator("[data-node-id]").last().click();
await page.waitForTimeout(250);
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.getByRole("button", { name: "Photo", exact: true }).click(),
]);
await chooser.setFiles({ name: "chosen.jpg", mimeType: "image/jpeg", buffer: Buffer.from(photo, "base64") });
await page.waitForTimeout(1800);

check("a photo on a bookmark card makes no second card", (await nodes()).length, 2);
const shown = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("[data-node-id]")];
  const card = cards[cards.length - 1];
  return {
    images: card.querySelectorAll("img").length,
    chosen: (card.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:"),
    stillABookmark: !!card.querySelector('[class*="bookmarkTitle"]'),
  };
});
check("the card shows one picture, not two", shown.images, 1);
check("and it is the one that was chosen", shown.chosen, true);
check("the card is still a bookmark", shown.stillABookmark, true);

// A copy made from a web page carries the picture *and* its address. One paste
// must leave one card behind, not one of each. Nothing selected, so the picture
// makes a card of its own rather than landing on the card that was.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const beforeBoth = (await nodes()).length;
await page.evaluate((b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const data = new DataTransfer();
  data.items.add(new File([bytes], "copied.jpg", { type: "image/jpeg" }));
  data.setData("text/plain", "https://example.net/an-article");
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, photo);
await page.waitForTimeout(1800);
check("a paste carrying both a picture and a link makes one card", (await nodes()).length - beforeBoth, 1);

const both = await readPersistedCanvas(page);
check(
  "and the picture is what it made",
  both.nodes.filter((n) => n.url === "https://example.net/an-article").length,
  0,
);

// A site that declares no icon at all falls back to its OpenGraph picture,
// rather than to nothing.
await page.route("**/api/bookmark**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      title: "An article somewhere",
      icon: null,
      image: `${BASE_URL}/__stub.png`,
      site: "example.org",
    }),
  }),
);
const beforeIconless = (await nodes()).length;
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await pasteOnCanvas("https://example.org/an-article");
await page.waitForTimeout(700);
check("a site with no icon still makes a card", (await nodes()).length - beforeIconless, 1);
check(
  "and falls back to its banner",
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-node-id]")];
    return cards[cards.length - 1].querySelector("img")?.getAttribute("src") ?? null;
  }),
  `${BASE_URL}/__stub.png`,
);

// ── titles over the icon, which is a setting ───────────────────────────────

const titlesOn = () => page.locator('[class*="bookmarkTitle"]').count();
check("titles are on to begin with", (await titlesOn()) > 0, true);

await page.getByRole("button", { name: "Settings" }).click();
await page.waitForTimeout(250);
const titleSwitch = page.getByRole("switch", { name: "Titles on link cards" });
check("the setting reads as on", await titleSwitch.innerText(), "On");
await titleSwitch.click();
await page.waitForTimeout(250);
check("turning it off reads as off", await titleSwitch.innerText(), "Off");
await page.getByRole("button", { name: "Close" }).click();
await page.waitForTimeout(300);

check("no card writes over its icon any more", await titlesOn(), 0);
check(
  "and the icon is still there, filling the card",
  await page.locator("[data-node-id] img").count() > 0,
  true,
);
check(
  "the picture carries the name instead, for anything reading the page",
  (await page.locator("[data-node-id] img").first().getAttribute("alt")) !== "",
  true,
);

// A card with no picture has nothing else to say what it is, so it keeps its
// words whatever the setting says.
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.route("**/api/bookmark**", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
);
await pasteOnCanvas("https://nothing.example/here");
await page.waitForTimeout(700);
check("a link with no picture keeps its words", (await titlesOn()) > 0, true);

// The setting is a preference, so it has to outlive the page.
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
check("and the setting survives a reload", await titlesOn(), 1);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
