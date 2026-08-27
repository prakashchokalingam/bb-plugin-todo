// Borderless quick-capture row. Enter creates and keeps focus so the user
// can fire off several tasks in a row without reaching for the mouse;
// Escape blurs. No modal, no form — the input clears immediately on submit
// (optimistic-feeling) and the caller's mutation + refetch happen in the
// background.
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";

export interface AddTaskRowProps {
  placeholder: string;
  onSubmit: (title: string) => void;
  /** Focuses the input on mount. Callers that need to (re)focus an
   * already-mounted row (e.g. ProjectHeader's "+" affordance) should pair
   * this with a changing `key` so React remounts the input — matching the
   * autoFocus pattern TaskRow/ProjectHeader already use for their own
   * inline-edit inputs. */
  autoFocus?: boolean;
}

export function AddTaskRow({ placeholder, onSubmit, autoFocus = false }: AddTaskRowProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const title = value.trim();
      if (title.length === 0) return;
      setValue("");
      onSubmit(title);
      // Keep focus for the next entry — this is the primary capture path.
      inputRef.current?.focus();
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    }
  }

  return (
    <div className="group flex min-h-8 items-center gap-2 px-2">
      <Icon
        name="Plus"
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/50 group-focus-within:text-muted-foreground"
      />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50 focus:placeholder:text-muted-foreground"
      />
    </div>
  );
}

export default AddTaskRow;
