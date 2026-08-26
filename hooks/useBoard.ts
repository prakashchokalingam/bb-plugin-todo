// Board data hook: fetches getBoard, refetches on the "board" realtime
// channel (debounced so a burst of mutations doesn't storm the server), and
// exposes an imperative `refetch()` for callers that want an immediate
// re-sync after their own mutation lands.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ListDto, TagDto, TaskDto, rpcContract } from "@/contract";

// Mirrors getBoard's output shape (contract.ts / SPEC.md) directly, rather
// than fighting generic inference through the RPC client's call<Method>
// signature for a value we need to hold in state.
export interface BoardData {
  lists: ListDto[];
  activeListId: string;
  today: { day: string; planned: number; completed: number; tasks: TaskDto[] };
  backlog: { total: number; overdue: number; tasks: TaskDto[] };
  totalOverdue: number;
  serverNow: number;
  /** The full tag catalog with usage counts — see getBoard's output in contract.ts. */
  tags: TagDto[];
}

const REALTIME_DEBOUNCE_MS = 250;

export interface UseBoardResult {
  board: BoardData | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /**
   * Replaces `board` immediately with a locally-computed projection (e.g.
   * the output of `lib/drag.ts`'s `applyMoveToBoard`, folded into a full
   * `BoardData`) for optimistic UI, and also invalidates any `getBoard`
   * request already in flight — bumping the same request-id guard `refetch`
   * uses means a response that was launched before this call can no longer
   * land on top of it, even though it hasn't resolved yet. A `refetch()`
   * called *after* this still gets a fresh, higher id, so it can still
   * reconcile normally; only strictly older in-flight responses are
   * silenced.
   *
   * Only safe when `next` is derived from a snapshot that is still current
   * (e.g. a single in-flight drag, where nothing else can have mutated the
   * board underneath it). Whenever several optimistic patches can be in
   * flight concurrently for *independent* pieces of the board (e.g. tag
   * toggles on two different tasks, or two toggles on the same task in
   * quick succession), use `patchBoard` instead — closing over a `board`
   * captured before an `await`/RPC and swapping it back in wholesale on
   * failure will silently discard any other update that landed in between.
   */
  setOptimisticBoard: (next: BoardData) => void;
  /**
   * Same request-id invalidation as `setOptimisticBoard`, but `updater`
   * receives the CURRENT board (via React's functional `setState` form)
   * instead of a value the caller closed over earlier. Use this for
   * per-task/per-field optimistic patches and their rollbacks, so a patch
   * (or its failure-triggered revert) is always applied on top of whatever
   * is latest — including other concurrent optimistic patches — rather than
   * stomping on them by reverting to a stale whole-board snapshot.
   */
  patchBoard: (updater: (current: BoardData) => BoardData) => void;
}

/**
 * `listId` is the active list requested from the server (null falls back to
 * the first list, per `getBoard`'s contract). Pass the panel's `subPath`.
 */
export function useBoard(listId: string | null): UseBoardResult {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Guards against an in-flight response landing after a newer request has
  // already superseded it (fast list switching, or a refetch racing the
  // realtime-triggered one).
  const requestIdRef = useRef(0);

  const fetchBoard = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const result = await rpc.call("getBoard", { listId });
      if (requestId !== requestIdRef.current) return;
      setBoard(result);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [rpc, listId]);

  useEffect(() => {
    setLoading(true);
    void fetchBoard();
  }, [fetchBoard]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useRealtime("board", () => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void fetchBoard();
    }, REALTIME_DEBOUNCE_MS);
  });

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  const setOptimisticBoard = useCallback((next: BoardData) => {
    // Bump the guard *before* setting state so any `getBoard` call already
    // in flight — issued before this optimistic update — is discarded when
    // it eventually resolves, instead of clobbering it.
    requestIdRef.current += 1;
    setBoard(next);
  }, []);

  const patchBoard = useCallback((updater: (current: BoardData) => BoardData) => {
    // Same guard-bump as `setOptimisticBoard`, but the update itself is
    // computed from the current state at apply time (functional `setState`)
    // rather than a value the caller captured earlier — see the doc comment
    // on `patchBoard` in `UseBoardResult` for why that distinction matters.
    requestIdRef.current += 1;
    setBoard((prev) => (prev ? updater(prev) : prev));
  }, []);

  return { board, loading, error, refetch: fetchBoard, setOptimisticBoard, patchBoard };
}

export default useBoard;
