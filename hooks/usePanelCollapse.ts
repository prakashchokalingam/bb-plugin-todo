// Phase 4 (the-todo-plugin-feels-stateful-valley.md): per-device collapse
// state for the two board panels (Backlog / In Progress). This is a
// deliberately separate, client-only layer ABOVE the existing per-project
// collapse (`ProjectDto.collapsed`/`inProgressCollapsed`, server-persisted
// via the `setProjectCollapsed` RPC, owned by `TodoPage.tsx`'s
// `toggleProjectCollapsed`) — that feature collapses one project's rows
// inside a column; this one collapses an entire column. Never conflate the
// two: this hook knows nothing about projects, and `toggleProjectCollapsed`
// knows nothing about this.
//
// Deliberately NOT server-persisted: which panel you like collapsed on THIS
// device is view state, not board data — a round trip to the server before
// the UI could reflect it would make the collapse animate late for no
// benefit (nobody needs the layout in sync across devices/collaborators).
// `localStorage`, keyed per list (`todo.panel.<listId>`), is enough.
import { useCallback, useEffect, useState } from "react";
import type { Column } from "@/lib/drag";

/**
 * Storage/state encoding — one value, not two independent booleans, so
 * "both collapsed at once" (rule 3 below) is unrepresentable rather than
 * merely disallowed:
 *   - "backlog"     — the Backlog panel is collapsed; In Progress is full width.
 *   - "in_progress" — the In Progress panel is collapsed; Backlog is full width.
 *   - "both"        — neither panel is collapsed (both are shown side by
 *                      side/stacked normally). Read this as short for "both
 *                      panels visible", not "both collapsed" — it's the
 *                      value when there is no collapsed panel to name.
 */
export type PanelCollapseState = "both" | "backlog" | "in_progress";

function storageKey(listId: string): string {
  return `todo.panel.${listId}`;
}

/** Best-effort localStorage read: SSR/first-paint safe (no `window` yet ⇒
 * falls back to "both") and crash-safe if storage is unavailable (private
 * browsing, disabled, quota errors) — a broken/absent localStorage should
 * never take the board down, just mean the choice doesn't persist. */
function readStored(listId: string): PanelCollapseState {
  if (typeof window === "undefined") return "both";
  try {
    const raw = window.localStorage.getItem(storageKey(listId));
    if (raw === "backlog" || raw === "in_progress" || raw === "both") return raw;
  } catch {
    // localStorage unavailable — fall through to the default below.
  }
  return "both";
}

function writeStored(listId: string, value: PanelCollapseState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(listId), value);
  } catch {
    // Best-effort only; nothing to reconcile if the write fails.
  }
}

export interface UsePanelCollapseResult {
  /** The raw encoded value, exposed for tests/debugging; prefer `isCollapsed`. */
  collapsed: PanelCollapseState;
  isCollapsed: (column: Column) => boolean;
  /**
   * Toggles `column`'s collapse. Collapsing a panel while the OTHER one is
   * already collapsed automatically restores that other one — enforced
   * here (not in the view) by the encoding itself: the state can only ever
   * name ONE collapsed column at a time, so setting a new one always
   * replaces whatever was there before.
   */
  toggle: (column: Column) => void;
}

export function usePanelCollapse(listId: string): UsePanelCollapseResult {
  // Lazy initializer: reads localStorage synchronously on first render
  // (once per mount) rather than defaulting to "both" and correcting in an
  // effect — the latter would paint expanded-then-collapsed on every load,
  // which is exactly the "animates late" problem server persistence would
  // have caused. `readStored` itself is what keeps this SSR-safe.
  const [collapsed, setCollapsed] = useState<PanelCollapseState>(() => readStored(listId));

  // Switching lists (tabs) re-reads that list's own independent choice.
  useEffect(() => {
    setCollapsed(readStored(listId));
  }, [listId]);

  const toggle = useCallback(
    (column: Column) => {
      setCollapsed((current) => {
        const next: PanelCollapseState = current === column ? "both" : column;
        writeStored(listId, next);
        return next;
      });
    },
    [listId],
  );

  const isCollapsed = useCallback((column: Column) => collapsed === column, [collapsed]);

  return { collapsed, isCollapsed, toggle };
}
