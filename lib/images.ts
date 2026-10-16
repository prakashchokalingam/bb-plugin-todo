// Task image storage: bytes on disk, metadata in SQLite.
//
// Files live in `<plugin data dir>/images/<imageId>.<ext>` — the directory
// that holds the plugin's own data.db, never the plugin source. The DB row
// (`task_images`) is the source of truth for "this file belongs to a task".
// Three mechanisms keep disk and DB from drifting apart:
//
//  1. DELETE TRIGGER. Every delete of a `task_images` row — direct, or via
//     the ON DELETE CASCADE of a task, subtask, list, or clear-archive —
//     inserts the file name into `image_cleanup` in the SAME transaction.
//     No delete path has to remember to queue anything.
//  2. CLEANUP QUEUE. `processCleanup` unlinks queued files and retries
//     failures with backoff. The queue is a table, so it survives restarts.
//  3. RECONCILIATION. `reconcile` removes files that have no row and no
//     queue entry (a crash between "write file" and "insert row"). It skips
//     files that are in flight in this process and files younger than a
//     grace period, so it never deletes an upload that is still committing.
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { IMAGE_LIMITS, type ImageDto, type ImageMime } from "../contract.js";

const EXT_BY_MIME: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const IMAGE_ID_RE = /^img_[a-f0-9]{22}$/;
const FILE_NAME_RE = /^(img_[a-f0-9]{22})\.(png|jpg|gif|webp)$/;
const TMP_NAME_RE = /^\.tmp-img_[a-f0-9]{22}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A file younger than this is never reconciled away. */
export const RECONCILE_GRACE_MS = 10 * 60 * 1000;
const CLEANUP_BATCH = 100;
const RECONCILE_BATCH = 500;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

export function isImageId(value: string): boolean {
  return IMAGE_ID_RE.test(value);
}

export function mintImageId(): string {
  return "img_" + randomUUID().replace(/-/g, "").slice(0, 22);
}

/** Set once at plugin load. The route is exact-match, so the id is a query. */
let urlBase = "/api/v1/plugins/todo/http";
export function configureImageUrls(pluginId: string): void {
  urlBase = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http`;
}
export function imageUrl(id: string): string {
  return `${urlBase}/image?id=${encodeURIComponent(id)}`;
}

/** Magic-byte sniff. The client-declared type is never trusted. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  const at = (i: number) => bytes[i];
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    bytes.length >= 6 &&
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38 &&
    (at(4) === 0x37 || at(4) === 0x39) &&
    at(5) === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** An image that is on disk and not yet (or no longer) in `task_images`. */
export interface StagedImage {
  id: string;
  fileName: string;
  mime: ImageMime;
  size: number;
}

export interface ImageInput {
  /** Raw base64, no `data:` prefix. */
  data: string;
}

export interface ImageStoreOptions {
  /** Test seams for failure injection. */
  unlink?: (path: string) => void;
  writeFile?: (path: string, bytes: Uint8Array) => void;
  rename?: (from: string, to: string) => void;
}

interface CleanupRow {
  file_name: string;
  attempts: number;
}

export class ImageStore {
  readonly dir: string;
  private readonly unlink: (path: string) => void;
  private readonly writeFile: (path: string, bytes: Uint8Array) => void;
  private readonly rename: (from: string, to: string) => void;
  /** File names written by this process whose DB row is not committed yet. */
  private readonly inFlight = new Set<string>();

  constructor(dir: string, options: ImageStoreOptions = {}) {
    this.dir = dir;
    this.unlink = options.unlink ?? unlinkSync;
    this.writeFile = options.writeFile ?? ((path, bytes) => writeFileSync(path, bytes, { mode: 0o600 }));
    this.rename = options.rename ?? renameSync;
    mkdirSync(dir, { recursive: true });
  }

  /** Absolute path for a stored file name. Throws on anything unexpected. */
  pathFor(fileName: string): string {
    if (!FILE_NAME_RE.test(fileName)) throw new Error("invalid_input: bad image file name");
    return join(this.dir, fileName);
  }

  read(fileName: string): Buffer | null {
    try {
      return readFileSync(this.pathFor(fileName));
    } catch {
      return null;
    }
  }

  /**
   * Validates every input, then writes each file (temp name, then rename).
   * Nothing is left on disk if any input is invalid or any write fails.
   */
  stage(inputs: readonly ImageInput[]): StagedImage[] {
    if (inputs.length === 0) return [];
    if (inputs.length > IMAGE_LIMITS.maxPerTask) {
      throw new Error(`invalid_input: at most ${IMAGE_LIMITS.maxPerTask} images per task`);
    }

    const decoded: { bytes: Buffer; mime: ImageMime }[] = [];
    let total = 0;
    for (const [i, input] of inputs.entries()) {
      const label = `image ${i + 1}`;
      const data = input.data;
      if (data.length === 0 || data.length > IMAGE_LIMITS.maxBase64Length) {
        throw new Error(`invalid_input: ${label} is larger than ${IMAGE_LIMITS.maxBytes / (1024 * 1024)} MB`);
      }
      if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
        throw new Error(`invalid_input: ${label} is not valid base64`);
      }
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > IMAGE_LIMITS.maxBytes) {
        throw new Error(`invalid_input: ${label} is larger than ${IMAGE_LIMITS.maxBytes / (1024 * 1024)} MB`);
      }
      const mime = sniffImageMime(bytes);
      if (!mime) throw new Error(`invalid_input: ${label} must be a PNG, JPEG, GIF, or WebP image`);
      total += bytes.length;
      if (total > IMAGE_LIMITS.maxRequestBytes) {
        throw new Error(`invalid_input: images total more than ${IMAGE_LIMITS.maxRequestBytes / (1024 * 1024)} MB`);
      }
      decoded.push({ bytes, mime });
    }

    // Every name is recorded BEFORE its I/O starts, so a failure in the
    // middle of one file still cleans up (and un-protects) that file too.
    const attempted: { id: string; fileName: string }[] = [];
    const staged: StagedImage[] = [];
    try {
      for (const { bytes, mime } of decoded) {
        const id = mintImageId();
        const fileName = `${id}.${EXT_BY_MIME[mime]}`;
        attempted.push({ id, fileName });
        this.inFlight.add(fileName);
        this.inFlight.add(`.tmp-${id}`);
        const tmp = join(this.dir, `.tmp-${id}`);
        this.writeFile(tmp, bytes);
        this.rename(tmp, join(this.dir, fileName));
        staged.push({ id, fileName, mime, size: bytes.length });
      }
    } catch (err) {
      for (const a of attempted) {
        this.removeNow(a.fileName);
        this.removeNow(`.tmp-${a.id}`);
        this.forget(a);
      }
      throw new Error(`upload_failed: cannot save image (${err instanceof Error ? err.message : String(err)})`);
    }
    return staged;
  }

  /**
   * Runs `commit` with freshly staged files. If it throws, the files are
   * queued for deletion and removed; the error is rethrown unchanged.
   */
  withStaged<T>(
    conn: Database.Database,
    inputs: readonly ImageInput[],
    commit: (staged: StagedImage[]) => T,
    now: Date,
  ): T {
    const staged = this.stage(inputs);
    try {
      return commit(staged);
    } catch (err) {
      this.discard(conn, staged, now);
      throw err;
    } finally {
      for (const s of staged) this.forget(s);
    }
  }

  /** Queue staged files for deletion (durable), then try to delete them. */
  discard(conn: Database.Database, staged: readonly StagedImage[], now: Date): void {
    const enqueue = conn.prepare(
      `INSERT OR IGNORE INTO image_cleanup (file_name, queued_at, attempts, next_attempt_at) VALUES (?, ?, 0, 0)`,
    );
    for (const s of staged) enqueue.run(s.fileName, now.getTime());
    this.processCleanup(conn, now);
  }

  /**
   * Unlinks queued files. A missing file counts as done. A failure keeps the
   * row, counts the attempt, and delays the next one (exponential backoff).
   * Never throws: a bad file must not fail the RPC that triggered the drain.
   */
  processCleanup(conn: Database.Database, now: Date): { removed: number; failed: number } {
    let removed = 0;
    let failed = 0;
    let rows: CleanupRow[];
    try {
      rows = conn
        .prepare(
          `SELECT file_name, attempts FROM image_cleanup WHERE next_attempt_at <= ? ORDER BY queued_at LIMIT ?`,
        )
        .all(now.getTime(), CLEANUP_BATCH) as CleanupRow[];
    } catch {
      return { removed, failed };
    }
    const done = conn.prepare(`DELETE FROM image_cleanup WHERE file_name = ?`);
    const retry = conn.prepare(
      `UPDATE image_cleanup SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE file_name = ?`,
    );
    const live = conn.prepare(`SELECT 1 FROM task_images WHERE file_name = ?`);
    for (const row of rows) {
      try {
        // A queued name that a live row owns again must not lose its bytes.
        if (live.get(row.file_name)) {
          done.run(row.file_name);
          continue;
        }
        if (!FILE_NAME_RE.test(row.file_name) && !TMP_NAME_RE.test(row.file_name)) {
          done.run(row.file_name);
          continue;
        }
        try {
          this.unlink(join(this.dir, row.file_name));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        done.run(row.file_name);
        removed++;
      } catch (err) {
        failed++;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(row.attempts, 20));
        retry.run(now.getTime() + delay, String(err instanceof Error ? err.message : err).slice(0, 300), row.file_name);
      }
    }
    return { removed, failed };
  }

  /**
   * Queues files that nothing references: no `task_images` row, no queue
   * entry, not in flight here, and older than the grace period. Then drains.
   */
  reconcile(conn: Database.Database, now: Date): { queued: number } {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { queued: 0 };
    }
    const owned = conn.prepare(`SELECT 1 FROM task_images WHERE file_name = ?`);
    const queued = conn.prepare(`SELECT 1 FROM image_cleanup WHERE file_name = ?`);
    const enqueue = conn.prepare(
      `INSERT OR IGNORE INTO image_cleanup (file_name, queued_at, attempts, next_attempt_at) VALUES (?, ?, 0, 0)`,
    );
    let count = 0;
    for (const name of names) {
      if (count >= RECONCILE_BATCH) break;
      if (!FILE_NAME_RE.test(name) && !TMP_NAME_RE.test(name)) continue;
      if (this.inFlight.has(name)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(join(this.dir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (now.getTime() - mtimeMs < RECONCILE_GRACE_MS) continue;
      // Re-check after the stat so a row committed meanwhile wins.
      if (owned.get(name) || queued.get(name)) continue;
      enqueue.run(name, now.getTime());
      count++;
    }
    this.processCleanup(conn, now);
    return { queued: count };
  }

  /** Startup: finish queued deletions, then sweep abandoned files. */
  start(conn: Database.Database, now: Date): void {
    this.processCleanup(conn, now);
    this.reconcile(conn, now);
  }

  private removeNow(fileName: string): void {
    try {
      this.unlink(join(this.dir, fileName));
    } catch {
      // The reconciler picks up whatever is left once it is old enough.
    }
  }

  /** Stop protecting a file from the reconciler. */
  private forget(s: { id: string; fileName: string }): void {
    this.inFlight.delete(s.fileName);
    this.inFlight.delete(`.tmp-${s.id}`);
  }
}

export function imageDtoFromRow(row: { id: string; mime: string; size: number; created_at: number }): ImageDto {
  return { id: row.id, mime: row.mime as ImageMime, size: row.size, createdAt: row.created_at, url: imageUrl(row.id) };
}
