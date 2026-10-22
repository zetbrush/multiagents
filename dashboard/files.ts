// ============================================================================
// multiagents — Web Dashboard file access
// ============================================================================
// Read-only view of a session's project directory for the explorer and the
// preview pane. Every path is resolved inside the project root (symlinks
// included), so the browser can never read outside it.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { BrokerClient } from "../shared/broker-client.ts";
import { ApiError } from "./control.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".multiagents"]);
const SEARCH_LIMIT = 20_000;
const SCRIPTABLE = /html|svg|xml|javascript|ecmascript/i;

export interface FsEntry {
  name: string;
  /** Path relative to the project root, "/"-separated */
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
}

async function projectRoot(broker: BrokerClient, sessionId: string | null): Promise<string> {
  if (!sessionId) throw new ApiError("session_id is required");
  const session = await broker.getSession(sessionId).catch(() => null);
  if (!session) throw new ApiError(`Session "${sessionId}" not found`, 404);
  try {
    return fs.realpathSync(session.project_dir);
  } catch {
    throw new ApiError(`Project directory ${session.project_dir} does not exist`, 404);
  }
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/** Absolute path of `rel` inside root; refuses anything (even via symlink) outside it. */
export function resolveInRoot(root: string, rel: string): string {
  const candidate = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(root, rel);
  if (!inside(root, candidate)) throw new ApiError("Path is outside the project directory", 403);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new ApiError(`${rel || "."} does not exist`, 404);
  }
  if (!inside(root, real)) throw new ApiError("Path is outside the project directory", 403);
  return real;
}

export function listDir(root: string, rel: string): FsEntry[] {
  const dir = resolveInRoot(root, rel);
  if (!fs.statSync(dir).isDirectory()) throw new ApiError(`${rel} is not a directory`);
  const entries: FsEntry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git") continue;
    const abs = path.join(dir, d.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // dangling symlink
    }
    entries.push({ name: d.name, path: toRel(root, abs), type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs });
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/**
 * Find the file an agent meant: an exact path first (relative or absolute inside
 * the root), else the shortest project path that ends with it ("parser.ts" →
 * "src/lib/parser.ts").
 */
export function findFile(root: string, ref: string): string | null {
  const cleaned = ref.trim().replace(/^["'`(<]+|[)"'`>.,;:]+$/g, "");
  if (!cleaned) return null;
  try {
    const abs = resolveInRoot(root, cleaned);
    if (fs.statSync(abs).isFile()) return toRel(root, abs);
  } catch { /* not a direct hit */ }
  if (path.isAbsolute(cleaned) && !inside(root, path.normalize(cleaned))) return null;

  const suffix = "/" + cleaned.replace(/^\.?\//, "").split(path.sep).join("/");
  let best: string | null = null;
  let seen = 0;
  const queue = [root];
  while (queue.length && seen < SEARCH_LIMIT) {
    const dir = queue.shift()!;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of items) {
      seen++;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) queue.push(abs);
      } else if (("/" + toRel(root, abs)).endsWith(suffix)) {
        const rel = toRel(root, abs);
        if (!best || rel.length < best.length) best = rel;
      }
    }
  }
  return best && readable(root, best) ? best : null;
}

/** A path found by name must pass the same checks as one asked for directly (no symlink escapes). */
function readable(root: string, rel: string): boolean {
  try {
    return fs.statSync(resolveInRoot(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** Project files, walked once and reused briefly: one walk answers a whole batch of references. */
const indexCache = new Map<string, { at: number; files: string[] }>();

function projectFiles(root: string): string[] {
  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.at < 5_000) return cached.files;
  const files: string[] = [];
  const queue = [root];
  while (queue.length && files.length < SEARCH_LIMIT) {
    const dir = queue.shift()!;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of items) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) queue.push(abs);
      } else {
        files.push(toRel(root, abs));
      }
    }
  }
  indexCache.set(root, { at: Date.now(), files });
  return files;
}

/** Resolve the file references found in chat messages: ref → project path, or null. */
export function checkRefs(root: string, refs: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  let files: string[] | null = null;
  for (const ref of refs.slice(0, 200)) {
    const cleaned = ref.trim().replace(/^\.\//, "");
    let hit: string | null = null;
    try {
      const abs = resolveInRoot(root, cleaned);
      if (fs.statSync(abs).isFile()) hit = toRel(root, abs);
    } catch { /* not a direct path */ }
    if (!hit && !path.isAbsolute(cleaned)) {
      files ??= projectFiles(root);
      const suffix = "/" + cleaned;
      for (const f of files) {
        if (("/" + f).endsWith(suffix) && (!hit || f.length < hit.length)) hit = f;
      }
    }
    out[ref] = hit && readable(root, hit) ? hit : null;
  }
  return out;
}

// --- .docx → HTML (paragraphs, headings, emphasis, lists, tables) ---

/** Read one entry of a zip archive (stored or deflated). */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  // End of central directory: scan back over a possible comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function runsToHtml(xml: string): string {
  let out = "";
  for (const run of xml.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? []) {
    const props = run.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? "";
    let text = "";
    for (const piece of run.match(/<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:drawing>|<w:pict>/g) ?? []) {
      if (piece === "<w:tab/>") text += "\t";
      else if (piece === "<w:br/>") text += "\n";
      else if (piece === "<w:drawing>" || piece === "<w:pict>") text += "[image]";
      else text += decodeXml(piece.replace(/<[^>]+>/g, ""));
    }
    if (!text) continue;
    let html = escHtml(text).replace(/\n/g, "<br>");
    if (/<w:b(?: w:val="(?:1|true)")?\/>/.test(props)) html = `<strong>${html}</strong>`;
    if (/<w:i(?: w:val="(?:1|true)")?\/>/.test(props)) html = `<em>${html}</em>`;
    if (/<w:u w:val="(?!none)/.test(props)) html = `<u>${html}</u>`;
    out += html;
  }
  return out;
}

function paragraphToHtml(p: string): string {
  const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
  const inner = runsToHtml(p);
  const heading = style.match(/^(?:Heading|heading|标题)\s?(\d)$/)?.[1];
  if (style === "Title") return `<h1>${inner}</h1>`;
  if (heading) return `<h${Math.min(6, Number(heading) + 1)}>${inner}</h${Math.min(6, Number(heading) + 1)}>`;
  if (/<w:numPr>/.test(p)) return `<li>${inner}</li>`;
  return inner ? `<p>${inner}</p>` : "";
}

export function docxToHtml(buf: Buffer): string {
  const xml = readZipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) throw new ApiError("Not a readable .docx file", 415);
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  const parts: string[] = [];
  // Tables first (as blocks), paragraphs in between keep their order
  for (const block of body.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? []) {
    if (block.startsWith("<w:tbl>")) {
      const rows = (block.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map((tr) =>
        "<tr>" + (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) =>
          `<td>${(tc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(runsToHtml).join("<br>")}</td>`).join("") + "</tr>");
      parts.push(`<table>${rows.join("")}</table>`);
    } else {
      parts.push(paragraphToHtml(block));
    }
  }
  return parts.join("\n").replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
}

// --- HTTP ---

/** GET /api/fs/<op>?session_id=&path= */
export async function handleFs(broker: BrokerClient, op: string, url: URL): Promise<Response> {
  const root = await projectRoot(broker, url.searchParams.get("session_id"));
  const rel = url.searchParams.get("path") ?? "";

  switch (op) {
    case "list":
      return Response.json({ ok: true, result: { root, entries: listDir(root, rel) } });

    case "resolve": {
      const found = findFile(root, rel);
      if (!found) throw new ApiError(`No file matching "${rel}" in the project`, 404);
      const st = fs.statSync(path.join(root, found));
      return Response.json({ ok: true, result: { path: found, size: st.size, mtime: st.mtimeMs } });
    }

    case "check": {
      const refs = url.searchParams.getAll("ref");
      return Response.json({ ok: true, result: checkRefs(root, refs) });
    }

    case "raw": {
      const abs = resolveInRoot(root, rel);
      if (!fs.statSync(abs).isFile()) throw new ApiError(`${rel} is not a file`);
      const file = Bun.file(abs);
      const name = path.basename(abs);
      const type = file.type || "application/octet-stream";
      const headers: Record<string, string> = {
        "Content-Type": type,
        "Content-Disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      };
      // A project file opened from the dashboard must not run scripts in its origin.
      // (Not for PDFs: Chrome refuses to show a PDF in a sandboxed document.)
      if (SCRIPTABLE.test(type)) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
      return new Response(file, { headers });
    }

    case "docx": {
      const abs = resolveInRoot(root, rel);
      return Response.json({ ok: true, result: { html: docxToHtml(fs.readFileSync(abs)) } });
    }

    default:
      throw new ApiError(`Unknown file operation "${op}"`, 404);
  }
}
