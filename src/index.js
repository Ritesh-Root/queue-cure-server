import { loadConfig } from "./config.js";
import { QueueStore } from "./queueStore.js";
import { createPersistence } from "./persistence.js";
import { createServer } from "./server.js";

const config = loadConfig();
const persistence = createPersistence(config.dataFile);

const store = new QueueStore({ avgConsultMinutes: config.avgConsultMinutes });

// Hydrate from disk so a restart does not wipe the live queue.
const persisted = persistence.load();
if (persisted && store.load(persisted)) {
  console.log(`[boot] restored queue from ${config.dataFile}`);
}

const server = createServer({ store, config, persistence });

server.httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[boot] Port ${config.port} is already in use. Set PORT=<free port> and retry.`);
  } else {
    console.error("[boot] server error:", err.message);
  }
  process.exit(1);
});

server.start().then((addr) => {
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  console.log(`Queue Cure '26 server listening on http://localhost:${port}`);
  console.log(`  CORS allow-list: ${config.corsOrigins.join(", ")}`);
  console.log(`  Reception key: ${config.receptionKey ? "required" : "not required"}`);
  console.log(`  Heartbeat: every ${config.heartbeatMs}ms`);
});

// Graceful shutdown: persist final state.
const shutdown = async (signal) => {
  console.log(`\n[${signal}] shutting down, saving state...`);
  try {
    persistence.save(store.serialize());
    await server.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
