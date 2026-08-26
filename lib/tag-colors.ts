import type { TagColor } from "../contract";

// Tailwind's JIT scanner only sees classes that appear as literal strings in
// source. A template-interpolated `bg-${color}-500` is invisible to it, so
// every record below is a fully spelled-out class per key — never build one
// with string interpolation, and never add a ninth key without adding a row
// to all four records below.

/** Solid dot fill used by the full chip and the compact/tooltip dot. */
export const TAG_DOT_CLASS: Record<TagColor, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

/**
 * Chip text + background. Backgrounds stay near `/10` opacity so a row
 * carrying three chips still reads as quiet, muted UI rather than a wall of
 * color; `dark:` variants are tuned separately because the same lightness
 * that is legible on white washes out on a dark surface.
 */
export const TAG_CHIP_CLASS: Record<TagColor, string> = {
  slate: "text-slate-700 dark:text-slate-300 bg-slate-500/10",
  red: "text-red-700 dark:text-red-400 bg-red-500/10",
  amber: "text-amber-700 dark:text-amber-400 bg-amber-500/10",
  green: "text-green-700 dark:text-green-400 bg-green-500/10",
  teal: "text-teal-700 dark:text-teal-400 bg-teal-500/10",
  blue: "text-blue-700 dark:text-blue-400 bg-blue-500/10",
  violet: "text-violet-700 dark:text-violet-400 bg-violet-500/10",
  pink: "text-pink-700 dark:text-pink-400 bg-pink-500/10",
};

/** Ring drawn around the selected swatch in `ColorSwatchPicker`. */
export const TAG_RING_CLASS: Record<TagColor, string> = {
  slate: "ring-2 ring-slate-500",
  red: "ring-2 ring-red-500",
  amber: "ring-2 ring-amber-500",
  green: "ring-2 ring-green-500",
  teal: "ring-2 ring-teal-500",
  blue: "ring-2 ring-blue-500",
  violet: "ring-2 ring-violet-500",
  pink: "ring-2 ring-pink-500",
};

/** Human label shown under each swatch and used as its `aria-label`. */
export const TAG_COLOR_LABEL: Record<TagColor, string> = {
  slate: "Slate",
  red: "Red",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};
