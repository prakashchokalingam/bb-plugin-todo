// bb-plugin-todo — rendered by the host in the shared title bar
// (`headerContent`), which passes NO props. It cannot see TodoPage's state
// directly, so it talks to it through the module-level board-bus: "Archive"
// opens the ArchivePanel, "+ Tab" starts creating a new list. Emitting with
// no listener mounted (e.g. the page hasn't mounted yet) is a safe no-op.
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { emitBoardCommand } from "@/lib/board-bus";
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";
import { standaloneUrl } from "@/lib/standalone-url";
import { toast } from "sonner";

export default function TodoHeaderActions({ standalone = false }: { standalone?: boolean; subPath?: string } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const [fallback, setFallback] = useState<string | null>(null);
  const [openingDesktop, setOpeningDesktop] = useState(false);
  const nativeDesktop = (window as Window & { bbDesktop?: { platform?: string } }).bbDesktop?.platform === "macos"
    && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  useEffect(() => {
    if (standalone || /^https?:$/.test(window.location.protocol)) return;
    let active = true;
    void rpc.call("getStandaloneUrl", null).then(({ url }) => {
      if (active) setFallback(url);
    }).catch(() => { /* The link stays unavailable until the server reconnects. */ });
    return () => { active = false; };
  }, [rpc, standalone]);
  const canOpen = /^https?:$/.test(window.location.protocol) || fallback !== null;
  const href = canOpen ? standaloneUrl(new URL(window.location.href), fallback ?? "") : undefined;
  async function openDesktop() {
    if (openingDesktop) return;
    setOpeningDesktop(true);
    try {
      const url = new URL(standaloneUrl(new URL(window.location.href), fallback ?? ""));
      await rpc.call("openDesktopWindow", {
        listId: url.searchParams.get("list"),
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cannot open the Todo desktop window. Retry.");
    } finally { setOpeningDesktop(false); }
  }
  return (
    <div className="flex items-center gap-1">
      {!standalone && nativeDesktop && (
        <Button type="button" variant="ghost" size="sm" disabled={openingDesktop}
          aria-label="Open Todo in a desktop window" onClick={() => void openDesktop()}>
          <Icon name={openingDesktop ? "Spinner" : "AppWindow"} className={openingDesktop ? "animate-spin" : undefined} />
          {openingDesktop ? "Open Todo…" : "Open desktop window"}
        </Button>
      )}
      {!standalone && !nativeDesktop && (
        <Button asChild variant="ghost" size="sm">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Todo in browser"
            aria-disabled={!canOpen}
            onClick={(event) => {
              if (!canOpen) { event.preventDefault(); return; }
              const url = new URL(standaloneUrl(new URL(window.location.href), fallback ?? ""));
              url.searchParams.set("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
              event.currentTarget.href = url.href;
            }}
          >
            <Icon name="ExternalLink" />
            Open in browser
          </a>
        </Button>
      )}
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
