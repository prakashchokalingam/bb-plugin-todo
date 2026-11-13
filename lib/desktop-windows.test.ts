import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindows } from "./desktop-windows";

const directories: string[] = [];
const managers: DesktopWindows[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "todo-window-test-"));
  directories.push(directory);
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  const launch = vi.fn(() => child as unknown as Pick<ChildProcess, "kill" | "once">);
  const manager = new DesktopWindows({ directory, pluginId: "todo", serverUrl: () => "http://127.0.0.1:38886", platform: "darwin", executable: "/Applications/bb.app/Contents/MacOS/bb", launch });
  managers.push(manager);
  return { manager, launch, child };
}
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
  vi.useRealTimers();
});

describe("native Todo desktop window", () => {
  it("loads the selected list in a separate BB profile and waits for the page", async () => {
    const { manager, launch } = setup();
    const ready = manager.open({ listId: "list_personal", theme: "dark" });
    const [executable, args, env] = launch.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(executable).toBe("/Applications/bb.app/Contents/MacOS/bb");
    expect(args[0]).toMatch(/^--user-data-dir=/);
    expect(env.BB_SERVER_PORT).toBe("38886");
    expect(env.BB_THREAD_ID).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    const url = new URL(env.BB_DESKTOP_APP_URL!);
    expect(url.pathname).toBe("/api/v1/plugins/todo/http/app");
    expect(url.searchParams.get("list")).toBe("list_personal");
    expect(url.searchParams.get("theme")).toBe("dark");
    const disconnect = manager.connect(url.searchParams.get("desktopSession")!);
    await ready;
    disconnect();
  });
  it("keeps a window alive across a reload and stops it after the page closes", async () => {
    vi.useFakeTimers();
    const { manager, launch, child } = setup();
    const ready = manager.open({ listId: null, theme: "light" });
    const env = (launch.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv])[2];
    const id = new URL(env.BB_DESKTOP_APP_URL!).searchParams.get("desktopSession")!;
    const disconnect = manager.connect(id);
    await ready;
    disconnect();
    vi.advanceTimersByTime(2000);
    const disconnectAgain = manager.connect(id);
    vi.advanceTimersByTime(10000);
    expect(child.kill).not.toHaveBeenCalled();
    disconnectAgain();
    vi.advanceTimersByTime(8000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("rejects a failed launch and removes its temporary profile", async () => {
    const { manager, launch, child } = setup();
    const ready = manager.open({ listId: null, theme: "light" });
    const args = (launch.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv])[1];
    const profile = args[0].slice("--user-data-dir=".length);
    expect(existsSync(profile)).toBe(true);
    child.emit("error", new Error("EACCES"));
    await expect(ready).rejects.toThrow("Cannot start BB desktop");
    expect(existsSync(profile)).toBe(false);
  });
  it("stops a window that never loads", async () => {
    vi.useFakeTimers();
    const { manager, child } = setup();
    const ready = manager.open({ listId: null, theme: "light" });
    const failed = expect(ready).rejects.toThrow("Todo did not open");
    vi.advanceTimersByTime(30000);
    await failed;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
