/** Keep the current list when the board opens in a browser tab. */
export function standaloneUrl(page: URL, fallback: string): string {
  const url = /^https?:$/.test(page.protocol)
    ? new URL("/api/v1/plugins/todo/http/app", page.origin)
    : new URL(fallback);
  const match = page.pathname.match(/^\/plugins\/todo\/todo(?:\/(.*))?\/?$/);
  if (match?.[1]) url.searchParams.set("list", decodeURIComponent(match[1]));
  return url.href;
}
