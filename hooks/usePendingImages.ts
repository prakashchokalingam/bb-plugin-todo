// State for images the user pasted but has not saved yet. Pasted files are
// read asynchronously; every read is tied to a generation so a read that
// finishes after `reset()` (Escape, a successful save) or unmount is dropped
// instead of resurrecting an attachment the user already discarded.
import { useCallback, useEffect, useRef, useState } from "react";
import { IMAGE_LIMITS } from "@/contract";
import {
  imageFileProblem,
  imageFilesFromClipboard,
  readImageFile,
  shouldAttachPaste,
  type PendingImage,
} from "@/lib/imageFiles";

export interface UsePendingImages {
  images: PendingImage[];
  /** Files currently being read. */
  reading: number;
  /** The most recent problem, for an inline alert. Cleared by the next success. */
  error: string | null;
  setError: (message: string | null) => void;
  addFiles: (files: File[]) => Promise<void>;
  remove: (key: string) => void;
  /** Drops every pending image and ignores reads still in flight. */
  reset: () => void;
  /** Paste handler: attaches only when the clipboard holds images and no text. */
  onPaste: (e: React.ClipboardEvent<HTMLElement>) => void;
}

/** `existingCount`: images the task already has (counts toward the cap). */
export function usePendingImages(existingCount = 0): UsePendingImages {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [reading, setReading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const imagesRef = useRef<PendingImage[]>([]);
  const existingRef = useRef(existingCount);
  existingRef.current = existingCount;
  const seq = useRef(0);

  const commit = useCallback((next: PendingImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  useEffect(() => {
    return () => {
      generation.current += 1; // unmount: late reads must not set state
    };
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const gen = generation.current;
      // Validate synchronously so a bad file is reported before any I/O.
      const accepted: File[] = [];
      let problem: string | null = null;
      for (const file of files) {
        const reason = imageFileProblem(file);
        if (reason) {
          problem = reason;
          continue;
        }
        if (existingRef.current + imagesRef.current.length + accepted.length >= IMAGE_LIMITS.maxPerTask) {
          problem = `A task can have at most ${IMAGE_LIMITS.maxPerTask} images.`;
          break;
        }
        accepted.push(file);
      }
      setError(problem);
      if (accepted.length === 0) return;

      setReading((n) => n + accepted.length);
      const results = await Promise.allSettled(accepted.map((f) => readImageFile(f, `pending-${++seq.current}`)));
      if (gen !== generation.current) return; // reset or unmounted meanwhile
      setReading((n) => Math.max(0, n - accepted.length));

      const ok: PendingImage[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") ok.push(r.value);
        else problem = r.reason instanceof Error ? r.reason.message : "Cannot read this image.";
      }
      const room = Math.max(0, IMAGE_LIMITS.maxPerTask - existingRef.current - imagesRef.current.length);
      if (ok.length > room) problem = `A task can have at most ${IMAGE_LIMITS.maxPerTask} images.`;
      commit([...imagesRef.current, ...ok.slice(0, room)]);
      setError(problem);
    },
    [commit],
  );

  const remove = useCallback(
    (key: string) => {
      commit(imagesRef.current.filter((i) => i.key !== key));
      setError(null);
    },
    [commit],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    commit([]);
    setReading(0);
    setError(null);
  }, [commit]);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLElement>) => {
      if (!shouldAttachPaste(e.clipboardData)) return; // plain text paste: untouched
      e.preventDefault();
      void addFiles(imageFilesFromClipboard(e.clipboardData));
    },
    [addFiles],
  );

  return { images, reading, error, setError, addFiles, remove, reset, onPaste };
}
