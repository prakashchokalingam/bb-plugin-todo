// Shared multiline editor for AddTaskRow and TaskRow. Grows with its text up
// to a capped height, then scrolls. Enter submits, Shift+Enter inserts a
// newline, Escape cancels. Keys pressed while an IME composition is active
// belong to the IME and never submit or cancel. Pasted lines stay in the
// value; CRLF is normalised to LF. `onPaste` lets a caller claim a paste
// (images); a paste it does not claim behaves as normal text paste.
import { forwardRef, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { normalizeNewlines } from "@/lib/taskText";

export interface GrowingTextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  onBlur?: () => void;
  /** Called before the browser handles the paste; call `preventDefault()` to take it over. */
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  "aria-label": string;
  autoFocus?: boolean;
  /** Blocks typing and paste (used while a save is in flight). */
  readOnly?: boolean;
  className?: string;
}

export const SHORTCUT_HINT = "Enter: add/save · Shift+Enter: new line";

/** Tailwind `max-h-48` (12rem). Kept in sync with the class below. */
const MAX_HEIGHT_PX = 192;

export const GrowingTextarea = forwardRef<HTMLTextAreaElement, GrowingTextareaProps>(
  function GrowingTextarea(
    {
      value,
      onValueChange,
      onSubmit,
      onCancel,
      onBlur,
      onPaste,
      placeholder,
      "aria-label": ariaLabel,
      autoFocus,
      readOnly,
      className,
    },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const hintId = useId();
    const [focused, setFocused] = useState(false);

    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    // Resize to fit. Reset to `auto` first so the box can also shrink.
    const fit = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      const next = Math.min(el.scrollHeight, MAX_HEIGHT_PX);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
    }, []);

    useLayoutEffect(fit, [value, fit]);

    // Wrapping changes with width (narrow panel, window resize), not only
    // with text. Refit when the WIDTH changes. Our own height writes fire the
    // observer too, so height-only notifications are ignored; without that
    // guard each refit would trigger another one.
    useLayoutEffect(() => {
      const el = innerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.clientWidth;
      const observer = new ResizeObserver((entries) => {
        const width = Math.round(entries[0]?.contentRect.width ?? el.clientWidth);
        if (width === lastWidth) return;
        lastWidth = width;
        fit();
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [fit]);

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      // keyCode 229 covers browsers that report the composition-ending key
      // after `isComposing` has already flipped back to false.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel?.();
      }
    }

    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <textarea
          ref={setRefs}
          rows={1}
          autoFocus={autoFocus}
          readOnly={readOnly}
          value={value}
          onChange={(e) => onValueChange(normalizeNewlines(e.target.value))}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-describedby={hintId}
          className={cn(
            "block max-h-48 w-full min-w-0 resize-none border-0 bg-transparent p-0 text-sm leading-5 outline-none [overflow-wrap:anywhere]",
            className,
          )}
        />
        {/* Always in the DOM so `aria-describedby` resolves. Visually hidden
         * (`sr-only` is out of flow, so it adds no height) until the editor
         * has focus. */}
        <span
          id={hintId}
          className={cn(
            focused
              ? "pb-1 text-[10px] leading-4 text-muted-foreground/70"
              : "sr-only",
          )}
        >
          {SHORTCUT_HINT}
        </span>
      </div>
    );
  },
);

export default GrowingTextarea;
