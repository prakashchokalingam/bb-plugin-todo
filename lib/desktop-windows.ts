import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface WindowInput { listId: string | null; theme: "light" | "dark" }
interface Session {
  child: Pick<ChildProcess, "kill" | "once">;
  profile: string;
  ready: boolean;
  connections: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}
export interface DesktopWindowOptions {
  directory: string;
  serverUrl: () => string;
  pluginId: string;
  platform?: NodeJS.Platform;
  executable?: string;
  launch?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => Pick<ChildProcess, "kill" | "once">;
}

/** Launch the signed BB desktop app on Todo, with an independent window profile. */
export class DesktopWindows {
  private sessions = new Map<string, Session>();
  constructor(private options: DesktopWindowOptions) {}

  async open(input: WindowInput): Promise<void> {
    if ((this.options.platform ?? process.platform) !== "darwin") {
      throw new Error("The Todo desktop window currently requires macOS.");
    }
    const executable = this.options.executable ?? [
      "/Applications/bb.app/Contents/MacOS/bb",
      join(homedir(), "Applications/bb.app/Contents/MacOS/bb"),
    ].find(existsSync);
    if (!executable) throw new Error("Cannot find BB desktop. Install BB in Applications and retry.");
    if (this.sessions.size >= 4) throw new Error("Close a Todo desktop window before you open another one.");

    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    const profile = mkdtempSync(join(this.options.directory, "window-"));
    const sessionId = randomUUID();
    const server = new URL(this.options.serverUrl());
    const url = new URL(`/api/v1/plugins/${encodeURIComponent(this.options.pluginId)}/http/app`, server);
    url.searchParams.set("desktopSession", sessionId);
    url.searchParams.set("theme", input.theme);
    if (input.listId) url.searchParams.set("list", input.listId);

    // Give only system variables to the desktop process, without agent credentials.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.BB_SERVER_PORT = server.port || "80";
    env.BB_DATA_DIR = process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
    env.BB_DESKTOP_APP_URL = url.href;

    let child: Session["child"];
    try {
      child = this.options.launch
        ? this.options.launch(executable, [`--user-data-dir=${profile}`], env)
        : spawn(executable, [`--user-data-dir=${profile}`], { env, stdio: "ignore" });
    } catch (error) {
      rmSync(profile, { recursive: true, force: true });
      throw error;
    }
    return new Promise<void>((resolve, reject) => {
      const session: Session = {
        child, profile, ready: false, connections: 0, resolve, reject,
        timer: setTimeout(() => this.stop(sessionId, "Todo did not open. Keep BB open and retry."), 30_000),
      };
      session.timer.unref?.();
      this.sessions.set(sessionId, session);
      const exited = () => {
        this.sessions.delete(sessionId);
        clearTimeout(session.timer);
        if (!session.ready) reject(new Error("The Todo desktop window closed before it loaded."));
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* Retry through normal data-directory cleanup. */ }
      };
      child.once("exit", exited);
      child.once("error", () => {
        this.stop(sessionId, "Cannot start BB desktop. Check that BB is in Applications.");
        exited();
      });
    });
  }

  /** Keep the process alive while its page is open, including brief reloads. */
  connect(sessionId: string): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};
    clearTimeout(session.timer);
    session.connections++;
    if (!session.ready) { session.ready = true; session.resolve(); }
    let disconnected = false;
    return () => {
      if (disconnected) return;
      disconnected = true;
      session.connections--;
      if (session.connections === 0 && this.sessions.get(sessionId) === session) {
        session.timer = setTimeout(() => this.stop(sessionId), 8_000);
        session.timer.unref?.();
      }
    };
  }

  private stop(sessionId: string, error = "Todo desktop window closed.") {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    if (!session.ready) session.reject(new Error(error));
    try { session.child.kill("SIGTERM"); } catch { /* An exited process needs no signal. */ }
  }
  dispose() { for (const id of this.sessions.keys()) this.stop(id); }
}
