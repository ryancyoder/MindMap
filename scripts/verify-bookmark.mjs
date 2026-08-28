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

const { check, finish } = makeChecker();

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
      image: `${BASE_URL}/__stub.png`,
      site: "jsoncanvas.org",
    }),
  });
});
await page.route("**/__stub.png", (route) =>
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
  "the card shows the page's picture",
  await page.locator('[data-node-id] img').count(),
  1,
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

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
