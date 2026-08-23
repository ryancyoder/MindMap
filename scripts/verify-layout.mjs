// Chrome layout at real device sizes.
//
// This exists because of a regression that every other suite missed: adding two
// buttons to the bottom bar pushed it under the selection bar in portrait, and
// the selection bar covered the zoom control. Nothing failed — the suites all
// run at one wide desktop viewport, so the collision never happened in them.
//
// Anything added to a bar should be checked here. The rule the bars follow is
// that they are flex children of one wrapping dock, so they stack rather than
// overlap; these checks are what hold that rule in place.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();

const SIZES = [
  ["iPad landscape", 1194, 834],
  ["iPad portrait", 834, 1194],
  ["iPad mini portrait", 744, 1133],
  ["iPhone-ish", 430, 932],
];

const errors = [];

for (const [label, width, height] of SIZES) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // A selected card, so both bottom bars and a toast are all on screen at once
  // — the state the regression appeared in.
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.waitForTimeout(200);
  await page.locator('textarea[aria-label="Canvas JSON"]').fill(
    JSON.stringify({
      nodes: [{ id: "a", type: "text", text: "Card", x: 0, y: 0, width: 220, height: 90 }],
      edges: [],
    }),
  );
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Open as new map" }).click();
  await page.waitForTimeout(700);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(300);

  const report = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const overlaps = (a, b) =>
      !!a && !!b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);

    const bottom = box('[class*="bottomBar"]');
    const inspector = box('[class*="inspector"]');
    const top = box('[class*="topBar"]');
    const toasts = box('[class*="toasts"]');
    const zoom = box('[class*="zoomLabel"]');

    return {
      overflows: document.documentElement.scrollWidth > window.innerWidth,
      barsOverlap: overlaps(bottom, inspector),
      toastOverlapsBars: overlaps(toasts, bottom) || overlaps(toasts, inspector),
      offRight: [top, bottom, inspector].some((b) => b && b.right > window.innerWidth + 1),
      offBottom: [bottom, inspector].some((b) => b && b.bottom > window.innerHeight + 1),
      zoomCovered: overlaps(zoom, inspector),
    };
  });

  check(`${label}: page does not scroll sideways`, report.overflows, false);
  check(`${label}: the two bottom bars never overlap`, report.barsOverlap, false);
  check(`${label}: toasts clear the bars`, report.toastOverlapsBars, false);
  check(`${label}: no bar runs off the right edge`, report.offRight, false);
  check(`${label}: no bar runs off the bottom`, report.offBottom, false);
  check(`${label}: the zoom control stays visible`, report.zoomCovered, false);

  await page.close();
}

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
