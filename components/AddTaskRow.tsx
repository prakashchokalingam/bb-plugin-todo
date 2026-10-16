// Borderless quick-capture row. Enter creates and keeps focus so the user
// can fire off several tasks in a row without reaching for the mouse;
// Shift+Enter adds a line to the same task; Escape blurs. No modal, no form
// — a text-only task clears the textarea immediately on submit
// (optimistic-feeling) and the caller's mutation + refetch happen in the
// background.
//
// Pasting an image (and no text) attaches it: thumbnails appear under the
// input and the task is created WITH its images in one call. That path waits
// for the server instead of clearing at once, so a failed upload keeps the
// typed text and the images and shows the error inline.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { GrowingTextarea } from "@/components/GrowingTextarea";
import { ImageThumbs } from "@/components/ImageThumbs";
import { usePendingImages } from "@/hooks/usePendingImages";
import { errorText } from "@/lib/imageFiles";
import { normalizeTitle } from "@/lib/taskText";

/** One image on its way to the server (see `createTask.images`). */
export interface ImageUpload {
  data: string;
}

export interface AddTaskRowProps {
  placeholder: string;
  /** `images` is passed only when the user attached some. Return a promise
   * in that case: a rejection keeps the input and shows its message. */
  onSubmit: (title: string, images?: ImageUpload[]) => void | Promise<void>;
  /** Focuses the input on mount. Callers that need to (re)focus an
   * already-mounted row (e.g. ProjectHeader's "+" affordance) should pair
   * this with a changing `key` so React remounts the input — matching the
   * autoFocus pattern TaskRow/ProjectHeader already use for their own
   * inline-edit inputs. */
  autoFocus?: boolean;
}

export function AddTaskRow({ placeholder, onSubmit, autoFocus = false }: AddTaskRowProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pending = usePendingImages();
  const mountedRef = useRef(true);
  // Set synchronously so a second Enter in the same tick cannot submit twice.
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function submit() {
    if (busyRef.current || pending.reading > 0) return;
    const title = normalizeTitle(value);
    if (title.length === 0) {
      if (pending.images.length > 0) setSubmitError("Type a task title before you add the image.");
      return;
    }

    if (pending.images.length === 0) {
      setValue("");
      setSubmitError(null);
      void onSubmit(title);
      // Keep focus for the next entry — this is the primary capture path.
      inputRef.current?.focus();
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      await onSubmit(
        title,
        pending.images.map((i) => ({ data: i.data })),
      );
      if (!mountedRef.current) return;
      setValue("");
      pending.reset();
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(errorText(err, "Cannot add this task. Your text and images remain here."));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        inputRef.current?.focus();
      }
    }
  }

  const error = submitError ?? pending.error;

  return (
    <div className="group flex min-h-8 items-start gap-2 px-2">
      <Icon
        name="Plus"
        aria-hidden="true"
        className="mt-[9px] size-3.5 shrink-0 text-muted-foreground/50 group-focus-within:text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1" aria-busy={busy}>
        <GrowingTextarea
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            if (submitError) setSubmitError(null);
          }}
          onSubmit={() => void submit()}
          onCancel={() => inputRef.current?.blur()}
          onPaste={busy ? undefined : pending.onPaste}
          readOnly={busy}
          placeholder={placeholder}
          aria-label={placeholder}
          className="py-1.5 text-foreground placeholder:text-muted-foreground/50 focus:placeholder:text-muted-foreground"
        />
        <ImageThumbs
          label={normalizeTitle(value) || "new task"}
          reading={pending.reading}
          items={pending.images.map((img) => ({
            key: img.key,
            src: img.src,
            onRemove: busy ? undefined : () => pending.remove(img.key),
          }))}
          className={busy ? "opacity-60" : undefined}
        />
        {busy && <p className="pb-1 text-xs text-muted-foreground">Adding…</p>}
        {error && (
          <p role="alert" className="pb-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export default AddTaskRow;
