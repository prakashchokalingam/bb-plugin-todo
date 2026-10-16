// Browser-side helpers for image attachments: find images on the clipboard,
// validate them against the shared limits, and read them to base64 (the RPC
// transport; the server writes bytes to disk and stores no base64).
import { IMAGE_LIMITS, IMAGE_MIMES, type ImageMime } from "../contract";

/** An image waiting to be sent. `src` is a data URL for the thumbnail. */
export interface PendingImage {
  key: string;
  name: string;
  mime: ImageMime;
  size: number;
  /** Raw base64, no `data:` prefix: exactly what the RPC takes. */
  data: string;
  src: string;
}

const MB = 1024 * 1024;

/** Image files on the clipboard, in order. Empty for a plain text paste. */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) return files;
  return Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * Whether a paste should become an attachment. Text wins when both are on the
 * clipboard (copying cells or rich text often carries a rendered image too),
 * so ordinary text paste is never intercepted.
 */
export function shouldAttachPaste(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (data.getData("text/plain")) return false;
  return imageFilesFromClipboard(data).length > 0;
}

/** The message of a failed call, without the server's `code:` prefix. */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  return err.message.replace(/^[a-z_]+:\s*/, "") || fallback;
}

/** A user-facing reason this file cannot be attached, or null if it can. */
export function imageFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (!(IMAGE_MIMES as readonly string[]).includes(file.type)) {
    return "Attach only PNG, JPEG, GIF, or WebP images.";
  }
  if (file.size > IMAGE_LIMITS.maxBytes) {
    return `This image is larger than ${IMAGE_LIMITS.maxBytes / MB} MB.`;
  }
  if (file.size === 0) return "This image is empty.";
  return null;
}

/** Reads one validated file. Rejects with a readable message on failure. */
export function readImageFile(file: File, key: string): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Cannot read this image."));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      if (comma < 0) {
        reject(new Error("Cannot read this image."));
        return;
      }
      resolve({
        key,
        name: file.name || "image",
        mime: file.type as ImageMime,
        size: file.size,
        data: url.slice(comma + 1),
        src: url,
      });
    };
    reader.readAsDataURL(file);
  });
}
