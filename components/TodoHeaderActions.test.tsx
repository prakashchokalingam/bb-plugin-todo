// @vitest-environment jsdom
import { fireEvent, render, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TodoHeaderActions from "./TodoHeaderActions";

const call = vi.hoisted(() => vi.fn());
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call }) }));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  delete (window as Window & { bbDesktop?: unknown }).bbDesktop;
  call.mockReset();
});

describe("Open Todo in browser", () => {
  it("opens the current list even after a list change without a header remount", () => {
    window.history.replaceState(null, "", "/plugins/todo/todo/list_work");
    const page = render(<TodoHeaderActions />);
    const link = page.getByRole("link", { name: "Open Todo in browser" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    window.history.replaceState(null, "", "/plugins/todo/todo/list_personal");
    document.documentElement.classList.add("dark");
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    const url = new URL(link.getAttribute("href")!);
    expect(url.searchParams.get("list")).toBe("list_personal");
    expect(url.searchParams.get("theme")).toBe("dark");
  });
  it("keeps the standalone header free of a duplicate open button", () => {
    const page = render(<TodoHeaderActions standalone />);
    expect(page.queryByRole("link", { name: "Open Todo in browser" })).toBeNull();
    expect(page.getByRole("button", { name: "Open archive" })).toBeTruthy();
    expect(page.getByRole("button", { name: "Create a new tab" })).toBeTruthy();
  });
  it("launches Todo in a native desktop window with the selected list", async () => {
    Object.assign(window, { bbDesktop: { platform: "macos" } });
    window.history.replaceState(null, "", "/plugins/todo/todo/list_personal");
    document.documentElement.classList.add("dark");
    call.mockResolvedValue({ ok: true });
    const page = render(<TodoHeaderActions />);
    expect(page.queryByRole("link", { name: "Open Todo in browser" })).toBeNull();
    fireEvent.click(page.getByRole("button", { name: "Open Todo in a desktop window" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("openDesktopWindow", { listId: "list_personal", theme: "dark" }));
    await waitFor(() => expect(page.getByText("Open desktop window")).toBeTruthy());
  });
});
