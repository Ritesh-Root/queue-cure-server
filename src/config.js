/**
 * Environment-driven configuration with safe defaults.
 * All values are read once at boot.
 */

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Like int(), but allows 0 (e.g. PORT=0 for an ephemeral port, HEARTBEAT_MS=0 to disable).
function intMin0(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  return {
    port: intMin0(env.PORT, 3000),
    // Empty string => no key required (matches the provided frontend, which sends none).
    // Set RECEPTION_KEY to require reception clients to present it in reception:join.
    receptionKey: env.RECEPTION_KEY ?? "",
    // CORS allow-list. Vite dev server is 5173; 3000 covers same-origin/proxied setups.
    corsOrigins: list(env.CORS_ORIGINS, ["http://localhost:5173", "http://localhost:3000"]),
    // File the queue state is persisted to (synchronous JSON snapshot).
    dataFile: env.DATA_FILE || "./data/queue.json",
    // Heartbeat re-broadcast cadence so wait estimates stay fresh without client ticking.
    // 0 disables the heartbeat.
    heartbeatMs: intMin0(env.HEARTBEAT_MS, 10000),
    // Seed/default average consultation time before real data accumulates.
    avgConsultMinutes: int(env.AVG_DEFAULT_MINUTES, 8),
  };
}
