import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Synchronous JSON persistence.
 *
 * Why synchronous: the save happens inside a Socket.IO mutation handler. Using a
 * synchronous write means no `await` splits the handler, so Node's single-threaded
 * event loop keeps each mutation atomic (no interleaving with another handler).
 * At clinic scale the blocking cost is negligible. See thought-process sheet.
 *
 * Writes are atomic via write-to-temp + rename so a crash mid-write can't corrupt
 * the data file.
 */
export function createPersistence(file) {
  return {
    /** Load persisted state, or null if absent/unreadable. */
    load() {
      try {
        if (!existsSync(file)) return null;
        const raw = readFileSync(file, "utf8");
        if (!raw.trim()) return null;
        return JSON.parse(raw);
      } catch (err) {
        // Corrupt file should not crash boot; start fresh but keep the bad file for inspection.
        console.error(`[persistence] failed to load ${file}:`, err.message);
        return null;
      }
    },

    /** Persist state synchronously and atomically. */
    save(state) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(state), "utf8");
        renameSync(tmp, file);
      } catch (err) {
        // Persistence failure must not take down the live queue; log and continue.
        console.error(`[persistence] failed to save ${file}:`, err.message);
      }
    },
  };
}
