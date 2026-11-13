import { describe, expect, it } from "vitest";
import { standaloneUrl } from "./standalone-url";

describe("standalone Todo URL", () => {
  const fallback = "http://127.0.0.1:38886/api/v1/plugins/todo/http/app";
  it("keeps the browser origin and the selected list", () => {
    const url = new URL(standaloneUrl(new URL("https://my.getbb.app/plugins/todo/todo/list_work"), fallback));
    expect(url.origin).toBe("https://my.getbb.app");
    expect(url.pathname).toBe("/api/v1/plugins/todo/http/app");
    expect(url.searchParams.get("list")).toBe("list_work");
  });
  it("uses the server URL when the desktop shell has a private URL scheme", () => {
    const url = new URL(standaloneUrl(new URL("bb-app://desktop/plugins/todo/todo/list_personal"), fallback));
    expect(url.origin).toBe("http://127.0.0.1:38886");
    expect(url.searchParams.get("list")).toBe("list_personal");
  });
  it("does not treat another app route as a list", () => {
    const url = new URL(standaloneUrl(new URL("https://my.getbb.app/threads/thread_1"), fallback));
    expect(url.searchParams.has("list")).toBe(false);
  });
});
