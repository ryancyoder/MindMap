// Panning the canvas by tilting the iPad.
//
// The point of this is hands-free: while you are holding a Pencil, the hand
// that would pan is busy. Tilting nudges the view without putting the pen down.
//
// Two things make it usable rather than maddening. It is calibrated on the pose
// you are already holding — nobody holds an iPad flat, so treating level as
// neutral would fling the canvas the moment it switched on. And it has a dead
// zone, because a hand that is merely alive is never perfectly still.

export type TiltReading = { beta: number; gamma: number };

export const TILT = {
  /** Degrees of slop before anything moves at all. */
  deadzoneDeg: 7,
  /** Pixels per second, per degree past the dead zone. */
  gain: 26,
  /** However far you lean it, it will not run away. */
  maxSpeed: 900,
  /** Beyond this the device is being carried, not aimed. */
  maxUsefulDeg: 45,
} as const;

/**
 * Screen-space pan velocity, in pixels per second, for a tilt away from
 * neutral.
 *
 * `screenAngle` is `screen.orientation.angle`. Device beta/gamma are fixed to
 * the hardware, not the picture, so in landscape they arrive swapped — without
 * this rotation, tilting the iPad left would pan the canvas up.
 */
export function tiltPan(
  reading: TiltReading,
  neutral: TiltReading,
  screenAngle = 0,
): { vx: number; vy: number } {
  const dGamma = clampDeg(reading.gamma - neutral.gamma);
  const dBeta = clampDeg(reading.beta - neutral.beta);

  const theta = (screenAngle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const sx = dGamma * cos + dBeta * sin;
  const sy = -dGamma * sin + dBeta * cos;

  return { vx: speedFor(sx), vy: speedFor(sy) };
}

function clampDeg(delta: number): number {
  // Angles wrap; a reading either side of the flip should not read as a lurch.
  let d = delta;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.max(-TILT.maxUsefulDeg, Math.min(TILT.maxUsefulDeg, d));
}

function speedFor(degrees: number): number {
  const past = Math.abs(degrees) - TILT.deadzoneDeg;
  if (past <= 0) return 0;
  const speed = Math.min(past * TILT.gain, TILT.maxSpeed);
  return Math.sign(degrees) * speed;
}

/** Whether this browser exposes device orientation at all. */
export function tiltSupported(): boolean {
  return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
}

type PermissionCapable = {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
};

/**
 * iOS requires an explicit grant, asked for from a user gesture — which is why
 * this is only ever called from the toggle's click handler. Everywhere else
 * there is nothing to ask.
 */
export async function requestTiltPermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (!tiltSupported()) return "unsupported";
  const ctor = window.DeviceOrientationEvent as unknown as PermissionCapable;
  if (typeof ctor.requestPermission !== "function") return "granted";
  try {
    return (await ctor.requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
