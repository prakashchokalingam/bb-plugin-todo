import { TAG_COLORS, type TagColor } from "../contract";
import { cn } from "../lib/utils";
import { TAG_DOT_CLASS, TAG_RING_CLASS, TAG_COLOR_LABEL } from "../lib/tag-colors";

export interface ColorSwatchPickerProps {
  value: TagColor;
  onChange: (color: TagColor) => void;
  className?: string;
}

/**
 * The 4x2 swatch grid shared by the inline create row and the tag manager.
 * Every swatch is a real `<button>` (not a div with an onClick) so the grid
 * is keyboard-navigable and screen readers get a proper pressed state —
 * `aria-pressed` is the single source of truth for "which one is selected",
 * matching what the ring visually shows.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  className,
}: ColorSwatchPickerProps) {
  return (
    <div
      role="group"
      aria-label="Tag color"
      className={cn("grid grid-cols-4 gap-2", className)}
    >
      {TAG_COLORS.map((color) => {
        const selected = color === value;
        const label = TAG_COLOR_LABEL[color];
        return (
          <button
            key={color}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            onClick={() => onChange(color)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-md p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected && TAG_RING_CLASS[color],
            )}
          >
            <span
              aria-hidden="true"
              className={cn("size-5 rounded-full", TAG_DOT_CLASS[color])}
            />
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default ColorSwatchPicker;
