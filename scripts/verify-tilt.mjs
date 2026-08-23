// Tilt-to-pan.
//
// The sensor cannot be faked convincingly and the iOS permission prompt cannot
// be driven at all, so this checks the two things that are testable and are
// where the bugs would be: the pan maths, and whether the loop respects the
// rest of the app. Actual hardware behaviour has to be tried on the iPad.
//
// The maths matters most for orientation. beta and gamma are fixed to the
// hardware, not the picture, so in landscape they arrive swapped — get that
// wrong and tilting left pans the canvas upwards.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

// ── the maths, exercised through the shipped bundle ────────────────────────

const view = () =>
  page.evaluate(() => {
    const style = document.querySelector('[class*="world"]').getAttribute("style");
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(style);
    return m ? { x: +m[1], y: +m[2], k: +m[3] } : null;
  });

const tilt = (beta, gamma) =>
  page.evaluate(({ beta, gamma }) => {
    window.dispatchEvent(
      Object.assign(new Event("deviceorientation"), { beta, gamma, alpha: 0 }),
    );
  }, { beta, gamma });

// Turn it on. Chromium has no requestPermission, so the grant is automatic.
await page.getByRole("button", { name: "Tilt", exact: true }).click();
await page.waitForTimeout(200);
check(
  "the toggle turns on where the browser reports orientation",
  await page.evaluate(() =>
    /buttonOn/.test([...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Tilt").className),
  ),
  true,
);

// First reading is the neutral pose — an iPad is held at an angle, and level
// would fling the canvas the moment it switched on.
await tilt(38, 4);
await page.waitForTimeout(260);
const calibrated = await view();
await tilt(38, 4);
await page.waitForTimeout(320);
check("holding the calibrated pose does not pan", await view(), calibrated);

// Inside the dead zone, still nothing.
await tilt(41, 7);
await page.waitForTimeout(320);
check("a small wobble stays inside the dead zone", await view(), calibrated);

// Lean right: the view moves right, so the content moves left.
await tilt(38, 30);
await page.waitForTimeout(420);
const right = await view();
check("leaning right pans the view rightwards", right.x < calibrated.x - 5, true);
check("without drifting vertically", Math.abs(right.y - calibrated.y) < 2, true);

// Lean the other way and it comes back.
await tilt(38, -30);
await page.waitForTimeout(500);
check("leaning left pans back the other way", (await view()).x > right.x + 5, true);

// Lean forward: vertical only.
await tilt(38, 4);
await page.waitForTimeout(200);
const settled = await view();
await tilt(70, 4);
await page.waitForTimeout(420);
const forward = await view();
check("leaning forward pans vertically", forward.y < settled.y - 5, true);
check("without drifting horizontally", Math.abs(forward.x - settled.x) < 2, true);

// ── it must not fight the pointer ──────────────────────────────────────────

await tilt(38, 4);
await page.waitForTimeout(250);
const beforeStroke = await view();

// Hold a pen down and keep the iPad leaned over: the canvas must stay put,
// or the stroke being drawn would be dragged out of shape underneath it.
await page.evaluate(() => {
  const s = document.querySelector('[class*="surface"]');
  s.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 77, pointerType: "pen", clientX: 500, clientY: 400,
    pressure: 0.5, bubbles: true, cancelable: true }));
});
await tilt(38, 35);
await page.waitForTimeout(450);
check("the canvas holds still while a stroke is in progress", await view(), beforeStroke);

await page.evaluate(() => {
  window.dispatchEvent(new PointerEvent("pointerup", {
    pointerId: 77, pointerType: "pen", clientX: 500, clientY: 400,
    pressure: 0, bubbles: true, cancelable: true }));
  const s = document.querySelector('[class*="surface"]');
  s.dispatchEvent(new PointerEvent("pointerup", {
    pointerId: 77, pointerType: "pen", clientX: 500, clientY: 400,
    pressure: 0, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(450);
check("and resumes once the pen lifts", (await view()).x < beforeStroke.x - 5, true);

// ── landscape ──────────────────────────────────────────────────────────────
// The riskiest part of the maths, and the way an iPad is usually held. Device
// beta/gamma are fixed to the hardware, so at 90° they arrive swapped relative
// to the picture: leaning right must still pan right, not up.

await page.evaluate(() => {
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: { angle: 90, type: "landscape-primary" },
  });
});
await tilt(38, 4);
await page.waitForTimeout(300);
const landscapeStart = await view();

// In landscape, leaning the device "right" shows up on beta, not gamma.
await tilt(70, 4);
await page.waitForTimeout(420);
const landscapeLean = await view();
check("in landscape, a beta lean pans horizontally", landscapeLean.x < landscapeStart.x - 5, true);
check("and not vertically", Math.abs(landscapeLean.y - landscapeStart.y) < 2, true);

await tilt(38, 4);
await page.waitForTimeout(300);
const settled2 = await view();
await tilt(38, 35);
await page.waitForTimeout(420);
const gammaLean = await view();
check("in landscape, a gamma lean pans vertically", Math.abs(gammaLean.y - settled2.y) > 5, true);
check("and not horizontally", Math.abs(gammaLean.x - settled2.x) < 2, true);

await page.evaluate(() => {
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: { angle: 0, type: "portrait-primary" },
  });
});
await tilt(38, 4);
await page.waitForTimeout(300);

// ── switching off ──────────────────────────────────────────────────────────

await page.getByRole("button", { name: "Tilt", exact: true }).click();
await page.waitForTimeout(200);
const parked = await view();
await tilt(38, 40);
await page.waitForTimeout(450);
check("turning it off stops the panning", await view(), parked);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
