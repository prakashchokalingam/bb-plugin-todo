// A row of image thumbnails. Click a thumbnail for the full-size preview.
// Pass `onRemove` per item to show a remove button (the editors do; the
// read-only task row and archive do not).
//
// DOM ids: nothing here uses an image id as an element id. A task renders in
// both columns at once, so two strips can show the same image; keys, labels,
// and the preview dialog's own generated ids stay per-instance.
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface ThumbItem {
  key: string;
  src: string;
  onRemove?: () => void;
}

export interface ImageThumbsProps {
  items: ThumbItem[];
  /** Names the owner in aria-labels, e.g. the task title. */
  label: string;
  /** Files still being read; shown as placeholders. */
  reading?: number;
  /** Fires with true just before the preview opens and false just after it
   * closes, so an editor can ignore the focus loss the dialog causes. */
  onPreviewChange?: (open: boolean) => void;
  className?: string;
}

function Thumb({
  item,
  index,
  total,
  label,
  onOpen,
}: {
  item: ThumbItem;
  index: number;
  total: number;
  label: string;
  onOpen: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const n = `${index + 1} of ${total}`;
  return (
    <div
      data-image-thumb=""
      className="group/thumb relative size-12 shrink-0 overflow-hidden rounded-md border bg-muted"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Preview image ${n} for "${label}"`}
        className="block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {broken ? (
          <span className="flex size-full items-center justify-center px-0.5 text-center text-[9px] leading-tight text-muted-foreground">
            Image unavailable
          </span>
        ) : (
          <img
            src={item.src}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            className="size-full object-cover"
          />
        )}
      </button>
      {item.onRemove && (
        <button
          type="button"
          onClick={item.onRemove}
          aria-label={`Remove image ${n} from "${label}"`}
          className={cn(
            "absolute right-0.5 top-0.5 inline-flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm",
            "hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <Icon name="X" className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ImageThumbs({ items, label, reading = 0, onPreviewChange, className }: ImageThumbsProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);

  if (items.length === 0 && reading === 0) return null;

  function open(index: number) {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    onPreviewChange?.(true);
    setOpenIndex(index);
  }

  function close() {
    setOpenIndex(null);
    // Radix restores focus on the next tick; keep the guard up until then.
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      onPreviewChange?.(false);
    }, 0);
  }

  const current = openIndex !== null ? items[openIndex] : undefined;

  return (
    <>
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      // Keeps focus in the text editor when a thumbnail button is pressed
      // (Safari does not focus buttons on click; Chrome does).
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Thumb key={item.key} item={item} index={i} total={items.length} label={label} onOpen={() => open(i)} />
      ))}
      {Array.from({ length: reading }, (_, i) => (
        <div
          key={`reading-${i}`}
          role="status"
          aria-label="Reading image"
          className="size-12 shrink-0 animate-pulse rounded-md border bg-muted"
        />
      ))}
    </div>

      <Dialog open={current !== undefined} onOpenChange={(next) => (next ? undefined : close())}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              Image {(openIndex ?? 0) + 1} of {items.length}
            </DialogTitle>
            <DialogDescription className="sr-only">Full-size preview for "{label}"</DialogDescription>
          </DialogHeader>
          {current && (
            <img
              src={current.src}
              alt={`Image ${(openIndex ?? 0) + 1} of ${items.length} for "${label}"`}
              className="mx-auto max-h-[70vh] max-w-full rounded-md object-contain"
            />
          )}
          {items.length > 1 && (
            <div className="flex justify-center gap-2 text-xs">
              <button
                type="button"
                disabled={(openIndex ?? 0) === 0}
                onClick={() => setOpenIndex((i) => Math.max(0, (i ?? 0) - 1))}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={(openIndex ?? 0) >= items.length - 1}
                onClick={() => setOpenIndex((i) => Math.min(items.length - 1, (i ?? 0) + 1))}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ImageThumbs;
