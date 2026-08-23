// Tilt-to-pan.
//
// The mapping from sensor to screen is calibrated by demonstration, so the
// point of these checks is not "does my sign convention match the spec" — it is
// "does ANY device convention end up correct once the user has shown it what
// they mean". So the same behaviour is verified twice, on two simulated devices
// whose sensors work in opposite directions. A hard-coded mapping can pass one
// of those, never both.
//
// The sensor itself and the iOS permission prompt cannot be driven here, and
// whether the gain and dead zone feel right has to be judged in the hand.

import { BASE_URL, launchBrowser, makeChecker } from "./_harness.mjs";

const { check, finish } = makeChecker();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(BASE_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

const view = () =>
  page.evaluate(() => {
    const style = document.querySelector('[class*="world"]').getAttribute("style");
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(style);
    return m ? { x: +m[1], y: +m[2] } : null;
  });

const tilt = (beta, gamma) =>
  page.evaluate(
    ({ beta, gamma }) =>
      window.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma, alpha: 0 })),
    { beta, gamma },
  );

const panelText = async () =>
  (await page.locator('[class*="tiltStepLabel"]').count())
    ? page.locator('[class*="tiltStepLabel"]').innerText()
    : "";

/**
 * Teach it a device. `right` and `down` are the sensor readings that device
 * produces when leaned those ways — deliberately different between the two
 * cases below, including one that is simply inverted.
 */
async function calibrate({ neutral, right, down }) {
  await tilt(neutral.beta, neutral.gamma);
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "This is level" }).click();
  await page.waitForTimeout(200);

  await tilt(right.beta, right.gamma);
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Like this" }).click();
  await page.waitForTimeout(200);

  await tilt(down.beta, down.gamma);
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Like this" }).click();
  await page.waitForTimeout(300);
}

// ── device A: leaning right raises gamma ───────────────────────────────────

await page.getByRole("button", { name: "Tilt", exact: true }).click();
await page.waitForTimeout(300);
check("the first time, it asks to be taught", (await panelText()).includes("however you're comfortable"), true);

const A = {
  neutral: { beta: 40, gamma: 0 },
  right: { beta: 40, gamma: 25 },
  down: { beta: 65, gamma: 0 },
};

// Nothing may move while a direction is being demonstrated.
await tilt(A.neutral.beta, A.neutral.gamma);
await page.waitForTimeout(150);
await page.getByRole("button", { name: "This is level" }).click();
await page.waitForTimeout(200);
const duringSetup = await view();
await tilt(40, 35);
await page.waitForTimeout(400);
check("nothing pans while a direction is being demonstrated", await view(), duringSetup);

await page.getByRole("button", { name: "Like this" }).click();
await page.waitForTimeout(200);
await tilt(A.down.beta, A.down.gamma);
await page.waitForTimeout(150);
await page.getByRole("button", { name: "Like this" }).click();
await page.waitForTimeout(300);
check("after three steps the panel closes", await panelText(), "");

await tilt(40, 0);
await page.waitForTimeout(300);
const restA = await view();
await tilt(40, 0);
await page.waitForTimeout(350);
check("device A: holding level does not pan", await view(), restA);

await tilt(40, 30);
await page.waitForTimeout(420);
const rightA = await view();
check("device A: the demonstrated 'right' lean pans right", rightA.x < restA.x - 5, true);
check("device A: without vertical drift", Math.abs(rightA.y - restA.y) < 2, true);

await tilt(40, 0);
await page.waitForTimeout(300);
const restA2 = await view();
await tilt(70, 0);
await page.waitForTimeout(420);
const downA = await view();
check("device A: the demonstrated 'down' lean pans down", downA.y < restA2.y - 5, true);
check("device A: without horizontal drift", Math.abs(downA.x - restA2.x) < 2, true);

// Leaning the opposite way must reverse it.
await tilt(40, 0);
await page.waitForTimeout(300);
const centre = await view();
await tilt(40, -30);
await page.waitForTimeout(420);
check("device A: leaning the other way pans the other way", (await view()).x > centre.x + 5, true);

// ── device B: the same leans produce opposite readings ─────────────────────
// Axes swapped and both signs inverted — the exact failure reported by hand.

await page.getByRole("button", { name: "Recalibrate tilt" }).click();
await page.waitForTimeout(300);
check("recalibrating reopens the setup", (await panelText()).includes("however you're comfortable"), true);

await calibrate({
  neutral: { beta: 40, gamma: 0 },
  right: { beta: 15, gamma: 0 },   // leaning right shows up on beta, negatively
  down: { beta: 40, gamma: -25 },  // leaning down shows up on gamma, negatively
});

await tilt(40, 0);
await page.waitForTimeout(300);
const restB = await view();
await tilt(15, 0);
await page.waitForTimeout(420);
const rightB = await view();
check("device B: the same gesture still pans right", rightB.x < restB.x - 5, true);
check("device B: without vertical drift", Math.abs(rightB.y - restB.y) < 2, true);

await tilt(40, 0);
await page.waitForTimeout(300);
const restB2 = await view();
await tilt(40, -30);
await page.waitForTimeout(420);
const downB = await view();
check("device B: the inverted 'down' lean still pans down", downB.y < restB2.y - 5, true);
check("device B: without horizontal drift", Math.abs(downB.x - restB2.x) < 2, true);

// ── it must not fight the pointer ──────────────────────────────────────────

await tilt(40, 0);
await page.waitForTimeout(300);
const beforeStroke = await view();
await page.evaluate(() => {
  document.querySelector('[class*="surface"]').dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 77, pointerType: "pen", clientX: 500, clientY: 400,
      pressure: 0.5, bubbles: true, cancelable: true }),
  );
});
await tilt(15, 0);
await page.waitForTimeout(450);
check("the canvas holds still while a stroke is in progress", await view(), beforeStroke);

await page.evaluate(() => {
  const up = new PointerEvent("pointerup", {
    pointerId: 77, pointerType: "pen", clientX: 500, clientY: 400,
    pressure: 0, bubbles: true, cancelable: true });
  window.dispatchEvent(up);
  document.querySelector('[class*="surface"]').dispatchEvent(up);
});
await page.waitForTimeout(450);
check("and resumes once the pen lifts", (await view()).x < beforeStroke.x - 5, true);

// ── it is remembered ───────────────────────────────────────────────────────

await page.getByRole("button", { name: "Tilt", exact: true }).click();
await page.waitForTimeout(200);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Tilt", exact: true }).click();
await page.waitForTimeout(300);
check("a saved calibration is reused rather than re-asked", await panelText(), "");

await tilt(40, 0);
await page.waitForTimeout(300);
const restC = await view();
await tilt(15, 0);
await page.waitForTimeout(420);
check("and still pans the way it was taught", (await view()).x < restC.x - 5, true);

check("no page errors", errors, []);

await browser.close();
process.exit(finish() ? 1 : 0);
