import { describe, expect, it } from "vitest";
import { mdToTelegramHtml, splitTelegramHtml, telegramHtmlToPlain } from "./markdown";

describe("mdToTelegramHtml", () => {
  it("converts bold, italic, and inline code", () => {
    expect(mdToTelegramHtml("**bold** and *it* and `x`")).toBe("<b>bold</b> and <i>it</i> and <code>x</code>");
  });

  it("escapes HTML-significant characters in plain text", () => {
    expect(mdToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("escapes inside inline code and does not format its contents", () => {
    expect(mdToTelegramHtml("`a<b> **no**`")).toBe("<code>a&lt;b&gt; **no**</code>");
  });

  it("renders fenced code blocks as <pre> with escaped content", () => {
    expect(mdToTelegramHtml("```\nif (a<b) {}\n```")).toBe("<pre>if (a&lt;b) {}</pre>");
  });

  it("maps headings to bold and bullets to •", () => {
    expect(mdToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(mdToTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  it("converts links to anchor tags", () => {
    expect(mdToTelegramHtml("[xAI](https://x.ai)")).toBe('<a href="https://x.ai">xAI</a>');
  });
});

describe("splitTelegramHtml", () => {
  it("keeps short messages as a single part", () => {
    expect(splitTelegramHtml("<b>hi</b>")).toEqual(["<b>hi</b>"]);
  });

  it("reopens a <pre> block across a split boundary", () => {
    const html = mdToTelegramHtml(`\`\`\`\n${"a\n".repeat(40)}\`\`\``);
    const parts = splitTelegramHtml(html, 40);
    expect(parts.length).toBeGreaterThan(1);
    // Every part that starts inside code must open and close its own <pre>.
    for (const p of parts) {
      expect((p.match(/<pre>/g) || []).length).toBe((p.match(/<\/pre>/g) || []).length);
    }
  });
});

describe("telegramHtmlToPlain", () => {
  it("strips tags and unescapes entities", () => {
    expect(telegramHtmlToPlain('<b>a</b> &lt;x&gt; <a href="u">link</a>')).toBe("a <x> link");
  });
});
