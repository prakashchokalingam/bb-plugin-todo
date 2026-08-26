// bb-plugin-todo — tiny module-level pub/sub bridging the host-rendered
// header (TodoHeaderActions, which receives no props) to the page component
// (TodoPage) that owns the actual state for "open archive" / "create tab".
//
// One module-scoped Set of subscribers; multiple subscribers are supported,
// each unsubscribes independently, and emitting with no listener is a no-op
// (never throws).
import { useEffect, useRef } from "react";

export type BoardCommand = "open-archive" | "create-list" | "open-tag-manager";

type Listener = (cmd: BoardCommand) => void;

const listeners = new Set<Listener>();

export function emitBoardCommand(cmd: BoardCommand): void {
  for (const listener of listeners) {
    listener(cmd);
  }
}

/**
 * Subscribes `handler` to board commands for the lifetime of the calling
 * component. Keeps a ref to the latest `handler` so a stale closure from an
 * earlier render can never fire — only the current one does.
 */
export function useBoardCommand(handler: (cmd: BoardCommand) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener: Listener = (cmd) => {
      handlerRef.current(cmd);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
