import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueStore, LIMITS } from "../src/queueStore.js";

// A controllable clock so wait-time and duration math are deterministic.
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advanceMinutes = (m) => { t += m * 60000; };
  now.advanceMs = (ms) => { t += ms; };
  return now;
}

// ---------------------------------------------------------------------------
// Unit 2 — addPatient + monotonic token numbering + name sanitization
// ---------------------------------------------------------------------------

test("addPatient appends and assigns monotonic token numbers from 1", () => {
  const s = new QueueStore({ now: makeClock() });
  s.addPatient("Asha");
  s.addPatient("Ravi");
  const snap = s.snapshot();
  assert.equal(snap.waiting.length, 2);
  assert.deepEqual(snap.waiting.map((w) => w.tokenNumber), [1, 2]);
  assert.equal(snap.waiting[0].name, "Asha");
});

test("token numbers are never reused after a patient leaves the queue", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A"); // token 1
  s.addPatient("B"); // token 2
  s.callNext(); // token 1 -> current
  s.addPatient("C"); // must be token 3, never reuse 1
  const snap = s.snapshot();
  assert.equal(snap.current.tokenNumber, 1);
  assert.deepEqual(snap.waiting.map((w) => w.tokenNumber), [2, 3]);
});

test("name is sanitized: trimmed, capped, control/angle chars stripped, empty -> null", () => {
  const s = new QueueStore({ now: makeClock() });
  s.addPatient("  <script>x  ");
  s.addPatient("   "); // whitespace only -> null
  s.addPatient("z".repeat(200)); // capped
  const snap = s.snapshot();
  assert.equal(snap.waiting[0].name, "scriptx");
  assert.equal(snap.waiting[1].name, null);
  assert.equal(snap.waiting[2].name.length, LIMITS.NAME_MAX);
});

// ---------------------------------------------------------------------------
// Unit 3 — callNext / completeCurrent transitions + guarded duration recording
// ---------------------------------------------------------------------------

test("callNext promotes the first waiting token to current and stamps calledAt", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A");
  s.addPatient("B");
  const r = s.callNext();
  assert.equal(r.changed, true);
  const snap = s.snapshot();
  assert.equal(snap.current.tokenNumber, 1);
  assert.ok(typeof snap.current.calledAt === "string"); // ISO string
  assert.deepEqual(snap.waiting.map((w) => w.tokenNumber), [2]);
});

test("callNext completes the previous current and records a real duration", () => {
  const now = makeClock();
  const s = new QueueStore({ now, cooldownMs: 0 });
  s.addPatient("A");
  s.addPatient("B");
  s.callNext(); // A -> current
  now.advanceMinutes(10); // A consulted for 10 min
  s.callNext(); // complete A (10 min), B -> current
  assert.equal(s.state.completedDurations.length, 1);
  assert.ok(Math.abs(s.state.completedDurations[0] - 10) < 0.001);
  assert.equal(s.snapshot().current.tokenNumber, 2);
  assert.equal(s.snapshot().stats.completedCount, 1);
});

test("callNext with no current still promotes the next waiting token", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A");
  const r = s.callNext();
  assert.equal(r.changed, true);
  assert.equal(s.snapshot().current.tokenNumber, 1);
  assert.equal(s.state.completedDurations.length, 0); // nothing completed
});

test("completeCurrent finishes the current consult and records duration", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A");
  s.callNext();
  now.advanceMinutes(6);
  const r = s.completeCurrent();
  assert.equal(r.changed, true);
  assert.equal(s.snapshot().current, null);
  assert.equal(s.snapshot().stats.completedCount, 1);
  assert.ok(Math.abs(s.state.completedDurations[0] - 6) < 0.001);
});

test("completeCurrent with nobody in consultation is a no-op with notice", () => {
  const s = new QueueStore({ now: makeClock() });
  const r = s.completeCurrent();
  assert.equal(r.changed, false);
  assert.ok(r.notice);
});

test("zero/negative-duration consults are not added to the rolling average", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A");
  s.callNext(); // calledAt = t
  // complete immediately (0 minutes elapsed) -> must be discarded as a sample
  const r = s.completeCurrent();
  assert.equal(r.changed, true);
  assert.equal(s.state.completedDurations.length, 0);
  assert.equal(s.snapshot().stats.completedCount, 1); // still counts as completed
});

// ---------------------------------------------------------------------------
// Unit 4 — wait-time computation
// ---------------------------------------------------------------------------

test("effectiveAvg falls back to the receptionist default below MIN_SAMPLES", () => {
  const s = new QueueStore({ avgConsultMinutes: 8, now: makeClock() });
  s.addPatient("A");
  assert.equal(s.snapshot().effectiveAvgMinutes, 8);
});

test("effectiveAvg uses the rolling average once >= MIN_SAMPLES real consults exist", () => {
  const now = makeClock();
  const s = new QueueStore({ avgConsultMinutes: 8, now, cooldownMs: 0 });
  // Produce 3 real consults of 4 minutes each.
  for (let i = 0; i < 3; i++) {
    s.addPatient(`P${i}`);
  }
  for (let i = 0; i < 3; i++) {
    s.callNext();
    now.advanceMinutes(4);
    s.completeCurrent();
  }
  assert.equal(s.state.completedDurations.length, 3);
  assert.equal(s.snapshot().effectiveAvgMinutes, 4);
});

test("estimatedWaitMinutes and tokensAhead grow with queue position", () => {
  const now = makeClock();
  const s = new QueueStore({ avgConsultMinutes: 10, now });
  s.addPatient("A");
  s.addPatient("B");
  s.addPatient("C");
  s.callNext(); // A -> current, calledAt now (0 elapsed) -> remainingCurrent = 10
  const snap = s.snapshot();
  // waiting = [B (idx0), C (idx1)]
  assert.equal(snap.waiting[0].tokensAhead, 1); // current A ahead
  assert.equal(snap.waiting[1].tokensAhead, 2); // current A + B
  // B waits ~ remainingCurrent (10) + 0*avg = 10 ; C waits ~10 + 1*10 = 20
  assert.equal(snap.waiting[0].estimatedWaitMinutes, 10);
  assert.equal(snap.waiting[1].estimatedWaitMinutes, 20);
});

test("remaining time for current decreases as the consult progresses", () => {
  const now = makeClock();
  const s = new QueueStore({ avgConsultMinutes: 10, now });
  s.addPatient("A");
  s.addPatient("B");
  s.callNext();
  now.advanceMinutes(7); // 7 of 10 minutes elapsed
  const snap = s.snapshot();
  assert.equal(snap.waiting[0].estimatedWaitMinutes, 3); // 10 - 7
});

test("snapshot shape matches the frontend QueueState contract", () => {
  const s = new QueueStore({ now: makeClock() });
  s.addPatient("A");
  const snap = s.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    "avgConsultMinutes",
    "current",
    "effectiveAvgMinutes",
    "serverNow",
    "stats",
    "waiting",
  ]);
  assert.deepEqual(Object.keys(snap.waiting[0]).sort(), [
    "estimatedWaitMinutes",
    "name",
    "tokenNumber",
    "tokensAhead",
  ]);
  assert.deepEqual(Object.keys(snap.stats).sort(), ["completedCount", "waitingCount"]);
});

// ---------------------------------------------------------------------------
// Unit 5 — undo + empty-queue no-op + cooldown
// ---------------------------------------------------------------------------

test("undo reverts the last mutation (single level)", () => {
  const s = new QueueStore({ now: makeClock() });
  s.addPatient("A");
  s.addPatient("B"); // last mutation
  assert.equal(s.snapshot().waiting.length, 2);
  const r = s.undo();
  assert.equal(r.changed, true);
  assert.equal(s.snapshot().waiting.length, 1);
  // second undo is a no-op (no redo/multi-level)
  const r2 = s.undo();
  assert.equal(r2.changed, false);
  assert.ok(r2.notice);
});

test("undo restores a called patient back into the waiting list", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A");
  s.addPatient("B");
  s.callNext(); // A -> current
  assert.equal(s.snapshot().current.tokenNumber, 1);
  s.undo();
  assert.equal(s.snapshot().current, null);
  assert.deepEqual(s.snapshot().waiting.map((w) => w.tokenNumber), [1, 2]);
});

test("callNext on an empty queue is a no-op with notice", () => {
  const s = new QueueStore({ now: makeClock() });
  const r = s.callNext();
  assert.equal(r.changed, false);
  assert.ok(r.notice);
  assert.equal(s.snapshot().current, null);
});

test("cooldown suppresses a rapid second callNext", () => {
  const now = makeClock();
  const s = new QueueStore({ now });
  s.addPatient("A");
  s.addPatient("B");
  const r1 = s.callNext();
  assert.equal(r1.changed, true);
  const r2 = s.callNext(); // within cooldown window
  assert.equal(r2.changed, false);
  assert.ok(r2.notice);
  assert.equal(s.snapshot().current.tokenNumber, 1); // did not skip to B
});

test("an intervening action clears the cooldown so completeCurrent->callNext is not dropped", () => {
  const now = makeClock();
  const s = new QueueStore({ now }); // default 300ms cooldown
  s.addPatient("A");
  s.addPatient("B");
  s.callNext(); // A -> current, cooldown armed
  s.completeCurrent(); // intervening action clears cooldown
  const r = s.callNext(); // immediate, same clock tick — must still promote B
  assert.equal(r.changed, true);
  assert.equal(s.snapshot().current.tokenNumber, 2);
});

test("setAvgTime rejects non-numeric / out-of-range values", () => {
  const s = new QueueStore({ now: makeClock() });
  assert.equal(s.setAvgTime("abc").changed, false);
  assert.equal(s.setAvgTime(0).changed, false);
  assert.equal(s.setAvgTime(-5).changed, false);
  assert.equal(s.setAvgTime(99999).changed, false);
  assert.equal(s.setAvgTime(12).changed, true);
  assert.equal(s.snapshot().avgConsultMinutes, 12);
});

// ---------------------------------------------------------------------------
// persistence round-trip (supports Unit 8)
// ---------------------------------------------------------------------------

test("serialize/load round-trips state and preserves the token counter", () => {
  const s = new QueueStore({ now: makeClock() });
  s.addPatient("A");
  s.addPatient("B");
  s.callNext();
  const dump = JSON.parse(JSON.stringify(s.serialize()));

  const s2 = new QueueStore({ now: makeClock() });
  s2.load(dump);
  assert.equal(s2.snapshot().current.tokenNumber, 1);
  s2.addPatient("C");
  assert.equal(s2.snapshot().waiting.map((w) => w.tokenNumber).at(-1), 3); // counter preserved
});
