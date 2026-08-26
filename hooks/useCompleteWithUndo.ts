// bb-plugin-todo — completes a task and offers an 8s sonner "Undo" that
// restores exactly the ids the server reported it completed (so completing a
// parent also undoes the subtasks the server auto-completed with it). The
// toast is a convenience, not the only way back — Archive always offers
// restore, forever.
import { useCallback } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";

const UNDO_DURATION_MS = 8000;

export function useCompleteWithUndo(
  onChanged: () => void,
): (task: { id: string; title: string }) => void {
  const rpc = useRpc<typeof rpcContract>();

  return useCallback(
    (task: { id: string; title: string }) => {
      void rpc
        .call("completeTask", { id: task.id })
        .then(({ completedIds }) => {
          onChanged();
          toast(`Done · ${task.title}`, {
            duration: UNDO_DURATION_MS,
            action: {
              label: "Undo",
              onClick: () => {
                void rpc
                  .call("restoreTasks", { ids: completedIds })
                  .then(() => {
                    onChanged();
                  })
                  .catch((error: unknown) => {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Couldn't undo — restore it from Archive.",
                    );
                  });
              },
            },
          });
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : "Couldn't complete task.",
          );
        });
    },
    [rpc, onChanged],
  );
}

export default useCompleteWithUndo;
