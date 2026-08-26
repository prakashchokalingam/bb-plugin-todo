// bb-plugin-todo — rendered by the host in the shared title bar
// (`headerContent`), which passes NO props. It cannot see TodoPage's state
// directly, so it talks to it through the module-level board-bus: "Archive"
// opens the ArchivePanel, "+ Tab" starts creating a new list. Emitting with
// no listener mounted (e.g. the page hasn't mounted yet) is a safe no-op.
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { emitBoardCommand } from "@/lib/board-bus";

export default function TodoHeaderActions() {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Open archive"
        onClick={() => emitBoardCommand("open-archive")}
      >
        <Icon name="Archive" />
        Archive
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Create a new tab"
        onClick={() => emitBoardCommand("create-list")}
      >
        <Icon name="Plus" />
        Tab
      </Button>
    </div>
  );
}
