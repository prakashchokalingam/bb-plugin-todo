// A due-date popover: a native `datetime-local` input, a plain `date`
// input, and quick presets. No date-picker library — native inputs only.
// Fully controlled (`open`/`onOpenChange`) so it can be triggered from a
// dropdown menu item rather than owning its own trigger button.
import { useEffect, useState } from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export interface DueDatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Anchor element the popover positions against. */
  anchor: React.ReactNode;
  dueAt: number | null;
  hasDueTime: boolean;
  onChange: (dueAt: number | null, hasDueTime: boolean) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toDateTimeLocalValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function toDateOnlyValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateTimeLocal(value: string): number | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function parseDateOnly(value: string): number | null {
  if (!value) return null;
  const [y, m, day] = value.split("-").map(Number);
  if (!y || !m || !day) return null;
  const d = new Date(y, m - 1, day, 0, 0, 0, 0);
  return d.getTime();
}

function atLocalTime(daysFromNow: number, hour: number, minute: number): number {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

export function DueDatePicker({
  open,
  onOpenChange,
  anchor,
  dueAt,
  hasDueTime,
  onChange,
}: DueDatePickerProps) {
  const [dtLocal, setDtLocal] = useState("");
  const [dateOnly, setDateOnly] = useState("");

  useEffect(() => {
    if (!open) return;
    const base = dueAt ?? Date.now();
    setDtLocal(toDateTimeLocalValue(base));
    setDateOnly(toDateOnlyValue(base));
  }, [open, dueAt]);

  function apply(ms: number, withTime: boolean) {
    onChange(ms, withTime);
    onOpenChange(false);
  }

  function clear() {
    onChange(null, false);
    onOpenChange(false);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent className="w-72 space-y-3" align="start">
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => apply(atLocalTime(0, 18, 0), true)}
          >
            Today 6pm
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => apply(atLocalTime(1, 9, 0), true)}
          >
            Tomorrow 9am
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => apply(atLocalTime(7, 9, 0), true)}
          >
            Next week
          </Button>
          {dueAt !== null && (
            <Button type="button" size="sm" variant="ghost" onClick={clear}>
              Clear
            </Button>
          )}
        </div>

        <Separator />

        <div className="space-y-1.5">
          <Label htmlFor="due-datetime" className="text-xs">
            Date &amp; time
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="due-datetime"
              type="datetime-local"
              value={dtLocal}
              onChange={(e) => setDtLocal(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const ms = parseDateTimeLocal(dtLocal);
                if (ms !== null) apply(ms, true);
              }}
            >
              Set
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="due-date" className="text-xs">
            Date only
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="due-date"
              type="date"
              value={dateOnly}
              onChange={(e) => setDateOnly(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const ms = parseDateOnly(dateOnly);
                if (ms !== null) apply(ms, false);
              }}
            >
              Set
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default DueDatePicker;
