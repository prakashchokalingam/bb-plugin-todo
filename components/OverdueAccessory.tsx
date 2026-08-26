// bb-plugin-todo — experimental_sidebarAccessory. Mounted by the host in the
// sidebar row, receives NO props, and must be purely presentational: no
// buttons, no portals/tooltips/popovers, clipped to ~4rem x 1.25rem, and
// must never throw (a throw only hides the accessory — still guarded here).
import { useEffect, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";

export default function OverdueAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const [totalOverdue, setTotalOverdue] = useState<number | null>(null);

  const refetch = () => {
    rpc
      .call("getBoard", { listId: null })
      .then((result) => {
        setTotalOverdue(result.totalOverdue);
      })
      .catch(() => {
        // Presentational only — swallow and keep whatever we last knew.
      });
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime("board", () => {
    refetch();
  });

  if (!totalOverdue) return null;

  return (
    <span className="block max-w-[4rem] truncate text-xs leading-5 text-destructive tabular-nums">
      {totalOverdue} overdue
    </span>
  );
}
