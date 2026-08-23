// Panning the canvas by tilting the iPad.
//
// The point is hands-free: while you are holding a Pencil, the hand that would
// pan is busy.
//
// The mapping from sensor to screen is CALIBRATED BY DEMONSTRATION rather than
// derived from the spec, and that is the whole design. Getting it from first
// principles means being right about all of: the sign of `beta`, the sign of
// `gamma`, how both rotate with `screen.orientation.angle`, how the device is
// being held, and whether "tilt right" ought to mean the view moves right or
// the content does. Each is a coin flip, and a first attempt got several wrong
// at once — axes swapped and signs inverted.
//
// Asking the user to tilt once per direction collapses all of it. Whatever they
// do becomes the definition, so there is nothing left to be wrong about.

export type TiltReading = { beta: number; gamma: number };

/** A sensor-space direction, as (gamma, beta). */
export type TiltAxis = { g: number; b: number };

export type TiltCalibration = {
  neutral: TiltReading;
  /** Sensor direction the user demonstrated for "move right". */
  right: TiltAxis;
  /** Sensor direction the user demonstrated for "move down". */
  down: TiltAxis;
};

export const TILT = {
  /** Degrees of slop before anything moves at all. */
  deadzoneDeg: 6,
  /** Pixels per second, per degree past the dead zone. */
  gain: 26,
  /** However far you lean it, it will not run away. */
  maxSpeed: 900,
  /** Beyond this the device is being carried, not aimed. */
  maxUsefulDeg: 45,
  /** A demonstration smaller than this is indistinguishable from holding still. */
  minCalibrationDeg: 8,
} as const;

/** Shortest signed difference between two angles, in degrees. */
export function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** The sensor-space offset of a reading from neutral. */
export function tiltOffset(reading: TiltReading, neutral: TiltReading): TiltAxis {
  return {
    g: clampDeg(angleDelta(reading.gamma, neutral.gamma)),
    b: clampDeg(angleDelta(reading.beta, neutral.beta)),
  };
}

function clampDeg(d: number): number {
  return Math.max(-TILT.maxUsefulDeg, Math.min(TILT.maxUsefulDeg, d));
}

export function axisLength(a: TiltAxis): number {
  return Math.hypot(a.g, a.b);
}

/** Normalise a demonstrated direction; a too-small demo returns null. */
export function normalizeAxis(a: TiltAxis): TiltAxis | null {
  const len = axisLength(a);
  if (len < TILT.minCalibrationDeg) return null;
  return { g: a.g / len, b: a.b / len };
}

/**
 * Pan velocity in screen pixels per second.
 *
 * The offset from neutral is projected onto each demonstrated axis, so the
 * result is in the user's own terms: how far they have leaned toward "right",
 * and how far toward "down". Orientation, sensor sign conventions and holding
 * style are all already baked into those two vectors.
 */
export function tiltPan(
  reading: TiltReading,
  calibration: TiltCalibration,
): { vx: number; vy: number } {
  const d = tiltOffset(reading, calibration.neutral);
  const along = (axis: TiltAxis) => d.g * axis.g + d.b * axis.b;
  return { vx: speedFor(along(calibration.right)), vy: speedFor(along(calibration.down)) };
}

function speedFor(degrees: number): number {
  const past = Math.abs(degrees) - TILT.deadzoneDeg;
  if (past <= 0) return 0;
  return Math.sign(degrees) * Math.min(past * TILT.gain, TILT.maxSpeed);
}

export function tiltSupported(): boolean {
  return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
}

type PermissionCapable = {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
};

/**
 * iOS only grants motion access from a user gesture, which is why this is
 * called from the toggle's click handler and nowhere else.
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

const STORE_KEY = "mindmap_tilt_calibration";

export function saveCalibration(cal: TiltCalibration): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cal));
  } catch {
    // Losing it only costs one recalibration.
  }
}

export function loadCalibration(): TiltCalibration | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TiltCalibration;
    if (
      typeof parsed?.neutral?.beta !== "number" ||
      typeof parsed?.right?.g !== "number" ||
      typeof parsed?.down?.g !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
