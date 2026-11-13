import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { standaloneCss, standaloneJs } from "../standalone/assets.generated.js";

/** Serve the independent UI through BB's existing authenticated HTTP boundary. */
export function registerStandalone(bb: BbPluginApi, connectDesktop: (id: string) => (() => void) = () => () => {}): () => void {
  const base = `/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Todo</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2323262b'/%3E%3Cpath d='m8 16 5 5 11-11' fill='none' stroke='white' stroke-width='3'/%3E%3C/svg%3E"><link rel="stylesheet" href="${base}/app.css"><script type="module" src="${base}/app.js"></script></head><body><div id="root"><p class="boot-message">Load Todo…</p></div></body></html>`;
  const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  bb.http.route("GET", "/app", () => new Response(html, { headers: {
    ...headers,
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  } }));
  bb.http.route("GET", "/app.js", () => new Response(standaloneJs, {
    headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
  }));
  bb.http.route("GET", "/app.css", () => new Response(standaloneCss, {
    headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
  }));

  // Each live page holds one stream. A reconnect always causes a fresh board fetch.
  const clients = new Set<() => void>();
  const closers = new Set<() => void>();
  bb.http.route("GET", "/events", (c) => {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const disconnectDesktop = connectDesktop(c.req.query("desktopSession") ?? "");
        let closed = false;
        const send = () => {
          if (!closed) controller.enqueue(encoder.encode("event: board\ndata: {}\n\n"));
        };
        const timer = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 25_000);
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          disconnectDesktop();
          clients.delete(send);
          closers.delete(close);
          c.req.raw.signal.removeEventListener("abort", close);
          try { controller.close(); } catch { /* A cancelled reader already closes the stream. */ }
        };
        cleanup = close;
        clients.add(send);
        closers.add(close);
        c.req.raw.signal.addEventListener("abort", close, { once: true });
        if (c.req.raw.signal.aborted) close();
        else send();
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    } });
  });
  bb.onDispose(() => { for (const close of closers) close(); });
  return () => { for (const send of clients) send(); };
}
