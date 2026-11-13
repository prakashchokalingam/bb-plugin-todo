import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
async function setup() {
  const host = createFakePluginHost({ pluginId: "todo" });
  hosts.push(host);
  await plugin(host.bb);
  return host.harness;
}
afterEach(async () => {
  for (const { harness } of hosts.splice(0)) await harness.dispose();
});

describe("standalone Todo", () => {
  it("serves a dedicated document and independent browser assets", async () => {
    const harness = await setup();
    const page = await harness.fetchHttp("GET", "/app");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('/api/v1/plugins/todo/http/app.js');
    const js = await harness.fetchHttp("GET", "/app.js");
    expect(js.headers.get("Content-Type")).toContain("text/javascript");
    expect((await js.text()).length).toBeGreaterThan(1000);
    const css = await harness.fetchHttp("GET", "/app.css");
    expect(await css.text()).toContain("standalone-header");
    for (const route of harness.registrations.httpRoutes.filter((route) => ["/app", "/app.js", "/app.css", "/events"].includes(route.path))) {
      expect(route.auth).toBe("local");
    }
  });

  it("sends an initial refresh and a mutation event from the same database", async () => {
    const harness = await setup();
    const response = await harness.fetchHttp("GET", "/events");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const text = new TextDecoder();
    expect(text.decode((await reader.read()).value)).toContain("event: board");
    const created = await harness.callRpc("createList", { name: "Shared screen" }) as { list: { id: string } };
    expect(text.decode((await reader.read()).value)).toContain("event: board");
    const board = await harness.callRpc("getBoard", { listId: created.list.id }) as { activeListId: string };
    expect(board.activeListId).toBe(created.list.id);
    await reader.cancel();
  });

  it("closes event streams when the plugin reloads", async () => {
    const harness = await setup();
    const response = await harness.fetchHttp("GET", "/events");
    const reader = response.body!.getReader();
    await reader.read();
    await harness.dispose();
    expect((await reader.read()).done).toBe(true);
  });
});
