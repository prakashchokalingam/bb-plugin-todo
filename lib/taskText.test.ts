import { describe, expect, it } from "vitest";
import {
  firstLine,
  hasLinks,
  isMultiline,
  isUrlOnly,
  normalizeNewlines,
  normalizeTitle,
  parseTaskText,
  singleLineLabel,
} from "./taskText.js";

const links = (title: string) =>
  parseTaskText(title)
    .filter((s) => s.type === "link")
    .map((s) => (s.type === "link" ? s.text : ""));

describe("normalizeTitle", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("keeps internal blank lines and trims only the outside", () => {
    expect(normalizeTitle("  \r\n one\r\n\r\ntwo \n ")).toBe("one\n\ntwo");
  });
});

describe("compact helpers", () => {
  it("firstLine returns the first line only", () => {
    expect(firstLine("Review notes\nCheck API\nhttps://x.dev")).toBe("Review notes");
    expect(firstLine("single")).toBe("single");
  });

  it("singleLineLabel joins every line with one space", () => {
    expect(singleLineLabel("a\n\n  b\r\nc")).toBe("a b c");
    expect(singleLineLabel("plain title")).toBe("plain title");
  });

  it("isMultiline ignores outer whitespace", () => {
    expect(isMultiline("one\ntwo")).toBe(true);
    expect(isMultiline("one\n")).toBe(false);
  });
});

describe("parseTaskText", () => {
  it("round-trips the exact text through its segments", () => {
    const title = "See https://a.dev/x, then www.b.dev.\nDone (https://c.dev/p_(1)).";
    expect(parseTaskText(title).map((s) => s.text).join("")).toBe(title);
  });

  it("finds http, https, and www links", () => {
    expect(links("http://a.dev https://b.dev www.c.dev")).toEqual([
      "http://a.dev",
      "https://b.dev",
      "www.c.dev",
    ]);
  });

  it("gives www links an https href", () => {
    const seg = parseTaskText("www.example.com/x")[0];
    expect(seg).toEqual({ type: "link", text: "www.example.com/x", href: "https://www.example.com/x" });
  });

  it("is case-insensitive on the scheme", () => {
    expect(links("HTTPS://Example.com")).toEqual(["HTTPS://Example.com"]);
  });

  it("excludes sentence punctuation from the target", () => {
    expect(links("go to https://a.dev.")).toEqual(["https://a.dev"]);
    expect(links("is it https://a.dev/x?")).toEqual(["https://a.dev/x"]);
    expect(links("a, https://a.dev, b")).toEqual(["https://a.dev"]);
    expect(links("see https://a.dev; ok")).toEqual(["https://a.dev"]);
  });

  it("keeps parentheses that belong to the URL", () => {
    expect(links("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("drops a closing parenthesis that wraps the URL", () => {
    expect(links("(see https://a.dev/x)")).toEqual(["https://a.dev/x"]);
    expect(links("(see https://a.dev/x).")).toEqual(["https://a.dev/x"]);
  });

  it("stops a link at a newline", () => {
    expect(links("https://a.dev\nhttps://b.dev")).toEqual(["https://a.dev", "https://b.dev"]);
  });

  it("never links other schemes", () => {
    expect(hasLinks("javascript:alert(1)")).toBe(false);
    expect(hasLinks("ftp://a.dev file:///etc/passwd data:text/html,hi")).toBe(false);
    expect(hasLinks("mailto:a@b.dev")).toBe(false);
  });

  it("ignores a bare scheme and mid-word matches", () => {
    expect(hasLinks("http:// alone")).toBe(false);
    expect(hasLinks("awww.example.com")).toBe(false);
    expect(hasLinks("user@www.example.com")).toBe(false);
  });

  it("leaves HTML-like text as plain text", () => {
    const segments = parseTaskText('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(segments).toEqual([{ type: "text", text: '<img src=x onerror=alert(1)> <b>bold</b>' }]);
  });

  it("does not let markup become part of a link target", () => {
    expect(links('https://a.dev"><script>')).toEqual(["https://a.dev"]);
  });
});

describe("isUrlOnly", () => {
  it("is true for one link with only whitespace around it", () => {
    expect(isUrlOnly("https://a.dev")).toBe(true);
    expect(isUrlOnly("\n www.a.dev \n")).toBe(true);
  });

  it("is false with other text or several links", () => {
    expect(isUrlOnly("read https://a.dev")).toBe(false);
    expect(isUrlOnly("https://a.dev https://b.dev")).toBe(false);
    expect(isUrlOnly("no link")).toBe(false);
  });
});
