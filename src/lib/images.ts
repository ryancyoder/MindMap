// Getting a picture out of a camera, a photo library, the clipboard or a drop,
// and into something a card can hold.
//
// Every source lands here as a `File`, and every one leaves as a data URL of a
// bounded size. That single funnel is what keeps the rest of the app from
// having to care where a photo came from.
//
// ─── Why the picture is resized ──────────────────────────────────────────────
//
// A photo taken on an iPad is 12 megapixels and several megabytes. Base64 adds
// a third on top of that, and the cloud library stores the result as a text
// column in Postgres. Uploading originals would put multi-megabyte strings in
// rows the whole point of normalising was to keep small and cheap to update.
//
// So a picture is drawn into a canvas at no more than IMAGE_MAX_DIM on its long
// edge and re-encoded as JPEG at IMAGE_QUALITY. That is roughly 200-400KB for a
// photograph — legible at any zoom this editor reaches, and small enough that a
// map with twenty pictures is still a few megabytes rather than a hundred.
//
// The cap is a cap, not a change of approach: what gets stored is still a
// base64 data URL keyed by the id the card carries.

/** Longest edge, in pixels, that a stored picture may have. */
export const IMAGE_MAX_DIM = 1600;

/** JPEG quality for the re-encode. High enough that skin and text survive. */
export const IMAGE_QUALITY = 0.82;

export type CapturedImage = {
  dataUrl: string;
  /** Dimensions of the stored picture, which is what a card is sized from. */
  width: number;
  height: number;
};

/**
 * Decode, resize and re-encode a picture.
 *
 * Decoding through the browser also normalizes the format: an iPhone HEIC or a
 * PNG screenshot both come out as JPEG, so nothing downstream has to know what
 * the device happened to hand over.
 */
export async function readImageFile(file: File): Promise<CapturedImage> {
  const source = await decode(file);
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser wouldn't give us a canvas to resize with.");

  // JPEG has no alpha, so a transparent screenshot would encode its clear
  // pixels as black. Paint white underneath instead.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source.image, 0, 0, width, height);
  source.release();

  const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
  if (!dataUrl.startsWith("data:image/")) throw new Error("That picture could not be encoded.");
  return { dataUrl, width, height };
}

type Decoded = {
  image: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

async function decode(file: File): Promise<Decoded> {
  // createImageBitmap is the fast path and, on iOS, the one that applies the
  // photo's EXIF orientation for us rather than handing back a sideways image.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through: some formats decode as an <img> but not as a bitmap.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("That file isn't a picture this browser can read."));
      el.src = url;
    });
    return {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * The first picture in a paste or a drop, if there is one.
 *
 * Both arrive as a DataTransfer, so the clipboard and a dragged file are the
 * same code path — a screenshot pasted with ⌘V and a photo dragged in from
 * Files should not behave differently.
 */
export function imageFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}

/** Whether a drag carries something we would accept, for the drop cursor. */
export function transferHasImage(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (Array.from(data.items ?? []).some((i) => i.kind === "file" && i.type.startsWith("image/"))) {
    return true;
  }
  // Mid-drag, browsers withhold the file list and expose only the types, so a
  // plain "there is a file coming" is the most we can know here.
  return Array.from(data.types ?? []).includes("Files");
}
