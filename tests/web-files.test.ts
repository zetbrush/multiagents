/**
 * The dashboard's read-only file access: paths stay inside the project
 * (symlinks included), agent references resolve to project files, and .docx
 * files render as HTML.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { checkRefs, docxToHtml, findFile, listDir, readZipEntry, resolveInRoot } from "../dashboard/files.ts";

let root = "";
let outside = "";

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "web-files-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "web-files-outside-")));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "src", "lib", "parser.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(root, "docs", "报告.md"), "# 报告\n");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
});

describe("paths stay inside the project", () => {
  test("relative paths resolve inside the root", () => {
    expect(resolveInRoot(root, "src/lib/parser.ts")).toBe(path.join(root, "src", "lib", "parser.ts"));
  });

  test("traversal and absolute paths outside are refused", () => {
    expect(() => resolveInRoot(root, "../" + path.basename(outside) + "/secret.txt")).toThrow("outside");
    expect(() => resolveInRoot(root, path.join(outside, "secret.txt"))).toThrow("outside");
  });

  test("a symlink pointing outside is refused", () => {
    expect(() => resolveInRoot(root, "escape.txt")).toThrow("outside");
  });

  test("listing puts folders first and hides .git", () => {
    const names = listDir(root, "").map((e) => `${e.type}:${e.name}`);
    expect(names.slice(0, 2)).toEqual(["dir:docs", "dir:src"]);
    expect(names).not.toContain("dir:.git");
    expect(names).toContain("file:README.md");
  });
});

describe("file references from agents", () => {
  test("a bare file name finds the file anywhere in the project", () => {
    expect(findFile(root, "parser.ts")).toBe("src/lib/parser.ts");
    expect(findFile(root, "lib/parser.ts")).toBe("src/lib/parser.ts");
    expect(findFile(root, "`README.md`")).toBe("README.md");
    expect(findFile(root, path.join(root, "README.md"))).toBe("README.md");
    expect(findFile(root, "missing.ts")).toBeNull();
    expect(findFile(root, path.join(outside, "secret.txt"))).toBeNull();
  });

  test("a batch of references is answered at once", () => {
    expect(checkRefs(root, ["parser.ts", "./README.md", "报告.md", "Node.js", "escape.txt"])).toEqual({
      "parser.ts": "src/lib/parser.ts",
      "./README.md": "README.md",
      "报告.md": "docs/报告.md",
      "Node.js": null,
      "escape.txt": null,
    });
  });
});

/** A minimal zip archive (deflated entries) for the .docx tests. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(content, "utf8"));
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(content), 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

describe(".docx preview", () => {
  const doc = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>食物过敏论文</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Methods</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> and &lt;plain&gt; &amp; safe</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>first item</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`;

  test("zip entries are read back", () => {
    const z = zip({ "a.txt": "alpha", "word/document.xml": doc });
    expect(readZipEntry(z, "a.txt")?.toString()).toBe("alpha");
    expect(readZipEntry(z, "missing")).toBeNull();
  });

  test("headings, emphasis, lists and tables become HTML, text stays escaped", () => {
    const html = docxToHtml(zip({ "word/document.xml": doc }));
    expect(html).toContain("<h1>食物过敏论文</h1>");
    expect(html).toContain("<h2>Methods</h2>");
    expect(html).toContain("<strong>Bold</strong> and &lt;plain&gt; &amp; safe");
    expect(html).toContain("<ul><li>first item</li>");
    expect(html).toContain("<table><tr><td>A1</td><td>B1</td></tr></table>");
  });

  test("a file that is not a docx is refused", () => {
    expect(() => docxToHtml(Buffer.from("not a zip"))).toThrow("docx");
  });
});
