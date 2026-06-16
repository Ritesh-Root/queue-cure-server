import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { io as ioClient } from "socket.io-client";
import { QueueStore } from "../src/queueStore.js";
import { createServer } from "../src/server.js";

// --- test harness -----------------------------------------------------------

const config = {
  port: 0, // ephemeral
  receptionKey: "",
  corsOrigins: ["http://localhost:5173"],
  dataFile: "./data/test-ignored.json",
  heartbeatMs: 0, // disable heartbeat noise in tests
  avgConsultMinutes: 8,
};

let store;
let server;
let url;
const saved = []; // capture persistence.save calls
const persistence = { save: (s) => saved.push(s) };

before(async () => {
  store = new QueueStore({ avgConsultMinutes: 8 });
  server = createServer({ store, config, persistence });
  const addr = await server.start(0);
  url = `http://localhost:${addr.port}`;
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  // fresh queue state per test
  store.load({ avgConsultMinutes: 8 });
  saved.length = 0;
});

function connect(role, opts = {}) {
  const socket = ioClient(url, { transports: ["websocket"], forceNew: true, ...opts });
  return socket;
}

// Wait for the next event of a given name (with timeout).
function nextEvent(socket, name, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    socket.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// --- tests ------------------------------------------------------------------

test("on join, a client immediately receives the current snapshot", async () => {
  const patient = connect("patient");
  await nextEvent(patient, "connect");
  patient.emit("patient:join", {});
  const snap = await nextEvent(patient, "queue:state");
  assert.ok(snap);
  assert.equal(snap.current, null);
  assert.equal(snap.stats.waitingCount, 0);
  patient.close();
});

test("CRITICAL (40%): both a patient and a reception client receive the update after callNext", async () => {
  const reception = connect("reception");
  const patient = connect("patient");
  await Promise.all([nextEvent(reception, "connect"), nextEvent(patient, "connect")]);

  reception.emit("reception:join", {});
  patient.emit("patient:join", {});
  await Promise.all([nextEvent(reception, "queue:state"), nextEvent(patient, "queue:state")]);

  // Seed a patient, then call next; both clients must see token #1 in consultation.
  reception.emit("reception:addPatient", { name: "Asha" });
  await Promise.all([nextEvent(reception, "queue:state"), nextEvent(patient, "queue:state")]);

  const receptionUpdate = nextEvent(reception, "queue:state");
  const patientUpdate = nextEvent(patient, "queue:state");
  reception.emit("reception:callNext", {});
  const [rSnap, pSnap] = await Promise.all([receptionUpdate, patientUpdate]);

  assert.equal(rSnap.current.tokenNumber, 1);
  assert.equal(pSnap.current.tokenNumber, 1);
  assert.equal(pSnap.current.name, "Asha");

  reception.close();
  patient.close();
});

test("role gating: a patient-only socket cannot drive reception actions", async () => {
  const patient = connect("patient");
  await nextEvent(patient, "connect");
  patient.emit("patient:join", {});
  await nextEvent(patient, "queue:state");

  // Attempt a privileged action without joining as reception.
  patient.emit("reception:addPatient", { name: "Mallory" });
  const notice = await nextEvent(patient, "queue:notice");
  assert.equal(notice.type, "error");
  assert.match(notice.message, /not authorized/i);
  assert.equal(store.snapshot().stats.waitingCount, 0); // state untouched
  patient.close();
});

test("reconnect resync: a reconnecting client gets fresh state reflecting changes made while away", async () => {
  // Reception adds a patient.
  const reception = connect("reception");
  await nextEvent(reception, "connect");
  reception.emit("reception:join", {});
  await nextEvent(reception, "queue:state");
  reception.emit("reception:addPatient", { name: "Ravi" });
  await nextEvent(reception, "queue:state");

  // A brand-new patient client connects later and must see the already-queued patient.
  const patient = connect("patient");
  await nextEvent(patient, "connect");
  patient.emit("patient:join", {});
  const snap = await nextEvent(patient, "queue:state");
  assert.equal(snap.stats.waitingCount, 1);
  assert.equal(snap.waiting[0].name, "Ravi");

  reception.close();
  patient.close();
});

test("persistence.save is called after a state-changing reception action", async () => {
  const reception = connect("reception");
  await nextEvent(reception, "connect");
  reception.emit("reception:join", {});
  await nextEvent(reception, "queue:state");

  reception.emit("reception:addPatient", { name: "Sara" });
  await nextEvent(reception, "queue:state");
  assert.ok(saved.length >= 1, "expected persistence.save to be called");
  assert.equal(saved.at(-1).waiting.at(-1).name, "Sara");
  reception.close();
});

test("setAvgTime with invalid payload returns a notice and does not change state", async () => {
  const reception = connect("reception");
  await nextEvent(reception, "connect");
  reception.emit("reception:join", {});
  await nextEvent(reception, "queue:state");

  reception.emit("reception:setAvgTime", { minutes: "not-a-number" });
  const notice = await nextEvent(reception, "queue:notice");
  assert.equal(notice.type, "error");
  assert.equal(store.snapshot().avgConsultMinutes, 8);
  reception.close();
});
