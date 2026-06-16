import { createServer as createHttpServer } from "node:http";
import express from "express";
import { Server as IOServer } from "socket.io";

/**
 * Build the HTTP + Socket.IO server around a QueueStore.
 *
 * Returns { app, httpServer, io, start, close } so tests can run it on an
 * ephemeral port and shut it down cleanly.
 *
 * @param {object} deps
 * @param {import('./queueStore.js').QueueStore} deps.store
 * @param {object} deps.config            from loadConfig()
 * @param {{save:Function}} [deps.persistence]  optional; called after each change
 */
export function createServer({ store, config, persistence }) {
  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true, ...store.snapshot().stats }));

  const httpServer = createHttpServer(app);
  const io = new IOServer(httpServer, {
    cors: { origin: config.corsOrigins, methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
  });

  // Broadcast the current snapshot to every connected client (both rooms see the
  // same public snapshot). Single source of truth -> no client-side reconciliation.
  const broadcast = () => io.emit("queue:state", store.snapshot());

  // Apply a reception mutation result: persist + broadcast on change, notify on notice.
  const apply = (socket, result) => {
    if (result?.notice) socket.emit("queue:notice", result.notice);
    if (result?.changed) {
      persistence?.save(store.serialize());
      broadcast();
    }
  };

  // Guard: only sockets that joined as reception may drive reception events.
  const requireReception = (socket) => {
    if (socket.data.role === "reception") return true;
    socket.emit("queue:notice", { type: "error", message: "Not authorized for reception actions" });
    return false;
  };

  // Wrap a handler so a malformed payload can never crash the process.
  const safe = (socket, fn) => (payload) => {
    try {
      fn(payload ?? {});
    } catch (err) {
      console.error("[socket] handler error:", err);
      socket.emit("queue:notice", { type: "error", message: "Server error handling that action" });
    }
  };

  io.on("connection", (socket) => {
    socket.data.role = null;

    socket.on("reception:join", safe(socket, (payload) => {
      if (config.receptionKey && payload.key !== config.receptionKey) {
        socket.emit("queue:notice", { type: "error", message: "Invalid reception key" });
        return;
      }
      socket.data.role = "reception";
      socket.join("reception");
      socket.emit("queue:state", store.snapshot());
    }));

    socket.on("patient:join", safe(socket, () => {
      socket.data.role = socket.data.role === "reception" ? "reception" : "patient";
      socket.join("patient");
      socket.emit("queue:state", store.snapshot());
    }));

    socket.on("reception:addPatient", safe(socket, (payload) => {
      if (!requireReception(socket)) return;
      apply(socket, store.addPatient(payload.name));
    }));

    socket.on("reception:callNext", safe(socket, () => {
      if (!requireReception(socket)) return;
      apply(socket, store.callNext());
    }));

    socket.on("reception:completeCurrent", safe(socket, () => {
      if (!requireReception(socket)) return;
      apply(socket, store.completeCurrent());
    }));

    socket.on("reception:setAvgTime", safe(socket, (payload) => {
      if (!requireReception(socket)) return;
      apply(socket, store.setAvgTime(payload.minutes));
    }));

    socket.on("reception:undo", safe(socket, () => {
      if (!requireReception(socket)) return;
      apply(socket, store.undo());
    }));
  });

  // Heartbeat: re-broadcast so estimatedWait/remaining-time stay fresh even when no
  // mutation occurs (the frontend does not tick client-side).
  let heartbeat = null;
  const startHeartbeat = () => {
    if (config.heartbeatMs > 0 && !heartbeat) {
      heartbeat = setInterval(broadcast, config.heartbeatMs);
      heartbeat.unref?.(); // don't keep the process alive solely for the heartbeat
    }
  };

  return {
    app,
    httpServer,
    io,
    broadcast,
    start(port = config.port) {
      return new Promise((resolve) => {
        httpServer.listen(port, () => {
          startHeartbeat();
          resolve(httpServer.address());
        });
      });
    },
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      await io.close();
    },
  };
}
