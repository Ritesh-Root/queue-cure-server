import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { io as ioClient } from "socket.io-client";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function nextEvent(socket, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    socket.once(name, (p) => { clearTimeout(timer); resolve(p); });
  });
}

// Boot the real entry point (src/index.js) on an ephemeral port; resolve with the
// child process and the port once it logs the listening URL.
function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/index.js"], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start")); }, 5000);
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { buf += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
  });
}

test("real entry point boots, serves live state, and persists on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qc-boot-"));
  const dataFile = join(dir, "queue.json");
  let child;
  let socket;
  try {
    const booted = await boot({ PORT: "0", DATA_FILE: dataFile, HEARTBEAT_MS: "0" });
    child = booted.child;
    const url = `http://localhost:${booted.port}`;

    socket = ioClient(url, { transports: ["websocket"], forceNew: true });
    await nextEvent(socket, "connect");
    socket.emit("reception:join", {});
    await nextEvent(socket, "queue:state");

    socket.emit("reception:addPatient", { name: "Boot" });
    const snap = await nextEvent(socket, "queue:state");
    assert.equal(snap.stats.waitingCount, 1);
    assert.equal(snap.waiting[0].name, "Boot");

    socket.close();
    socket = null;

    // SIGTERM should trigger the graceful shutdown handler, which persists state.
    await stop(child);
    child = null;

    assert.ok(existsSync(dataFile), "data file should exist after shutdown");
    const persisted = JSON.parse(readFileSync(dataFile, "utf8"));
    assert.equal(persisted.waiting.at(-1).name, "Boot");
  } finally {
    if (socket) socket.close();
    if (child) await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
