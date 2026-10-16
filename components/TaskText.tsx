// Renders a task title as plain React text: line breaks kept, long words and
// URLs wrapped, and HTTP/HTTPS/www links turned into real anchors. Nothing is
// ever injected as HTML, so markup in a title shows up literally.
//
// Links are separate interactive elements: a click on one never reaches the
// parent's edit handler. When the host exposes `openUrl`, a plain left click
// goes through it (in-app or external browser, per the user's preference);
// modifier clicks and hosts without it fall back to the anchor's own
// behaviour (`target="_blank"`, `noopener noreferrer`).
import { cn } from "@/lib/utils";
import { parseTaskText } from "@/lib/taskText";

export interface TaskTextProps {
  title: string;
  /** Returns true when the host accepted the URL. */
  onOpenUrl?: (url: string) => boolean;
  className?: string;
}

export function TaskText({ title, onOpenUrl, className }: TaskTextProps) {
  const segments = parseTaskText(title);

  return (
    <span className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>
      {segments.map((segment, i) =>
        segment.type === "text" ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.stopPropagation();
              const plain =
                e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
              if (plain && onOpenUrl?.(segment.href)) e.preventDefault();
            }}
            className="rounded-sm text-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {segment.text}
          </a>
        ),
      )}
    </span>
  );
}

export default TaskText;
