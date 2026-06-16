# Thought-Process Sheet — Queue Cure '26 (Backend)

This document explains the design reasoning, the concurrency model, and how every edge
case is handled. It maps directly to the 15% "concurrency and edge cases" criterion, and
backs up the other three criteria.

---

## 1. Problem framing

A clinic queue is a tiny dataset (tens of tokens) with a hard real-time requirement: the
moment a receptionist calls the next token, **every** patient and staff screen must agree
on who is being seen — without a refresh. The hard parts aren't data volume; they're
**consistency across screens**, **trustworthy wait estimates**, and **not letting a
mistaken or duplicate click corrupt the queue**.

So the architecture optimizes for *correctness and simplicity*, not throughput.

---

## 2. Single source of truth + full-snapshot broadcast

The server owns all state in one `QueueStore`. On any change it serializes the whole
state and `io.emit("queue:state", snapshot)` to **all** clients. Clients are pure
renderers — they never compute or mutate queue state locally.

**Why this wins the 40% criterion:** there is exactly one place state can change and one
shape clients consume. Two screens cannot disagree, because they render byte-identical
snapshots. Reconnection is automatically correct: the same snapshot that drives live
updates is sent on every `join`, so a client that dropped and reconnected immediately
resyncs (verified by the reconnect test).

The alternative — emitting granular deltas and replaying them client-side — introduces
ordering bugs, missed-event-on-reconnect bugs, and drift. For this data size, deltas buy
nothing.

---

## 3. Concurrency model

### 3.1 Why there are no locks

Node.js runs JavaScript on a single thread. Each Socket.IO event handler runs **to
completion** before the next one starts. Every `QueueStore` mutation
(`addPatient`, `callNext`, `completeCurrent`, `setAvgTime`, `undo`) is **fully
synchronous** — it contains no `await`. Therefore two events can never interleave
mid-mutation, and no two handlers can observe a half-updated queue. This gives us
atomic mutations **without locks, mutexes, or transactions.**

> Important nuance: single-threaded execution prevents *state corruption*. It does **not**
> by itself prevent a *logical* double-action. Those are handled separately below.

### 3.2 Two receptionists / double-click "Call Next"

A real clinic has one consultation room, so "Call Next" should advance exactly once per
patient finished — even if two staff tabs click within the same instant, or one click
registers twice. Defenses, in layers:

1. **Frontend debounce** (already in `queue-companion`): ignores a second `callNext`
   within 500 ms in the same tab.
2. **Server cooldown** (`QueueStore`, default 300 ms): a *consecutive* `callNext`
   arriving within the cooldown window returns `{ changed: false }` with an "Ignored
   rapid Call Next" notice — it does **not** advance the queue. This covers the cross-tab
   case the frontend debounce can't see. Any other action in between (complete, add, undo,
   set-avg) clears the cooldown, so a deliberate `completeCurrent → callNext` is never
   dropped.

This cooldown is a deliberate **heuristic for a single-doctor flow**, not a correctness
guarantee for arbitrary multi-room clinics. It's documented and configurable
(`cooldownMs`). If a clinic genuinely needed N concurrent rooms, the right model would be
per-room queues, not a shorter cooldown — called out as a scope boundary in §6.

### 3.3 Persistence without a race

Persistence happens **inside** the mutation path. We use **synchronous** file writes
(`writeFileSync`) precisely so the handler never yields the event loop between mutating
state and persisting it. An `async` write would insert an `await`, reopening the
interleaving window §3.1 closed. The write is atomic (temp file + `rename`) so a crash
mid-write cannot corrupt the data file, and a persistence failure logs but never takes
down the live queue.

---

## 4. Wait-time computed from real data (25%)

`effectiveAvgMinutes` is **not** the receptionist's number once real data exists:

- Each completed consultation's duration is measured as `now − calledAt` (real elapsed
  time), pushed into a bounded history.
- With **fewer than 3** real samples we fall back to the receptionist's
  `avgConsultMinutes` (a reasonable seed; we don't trust noisy 1–2 sample averages).
- With **3+** samples we use a **rolling average of the last 5** real durations, so the
  estimate adapts to how the clinic is actually running today.

Per-token estimate for the patient at waiting index `i`:

```
remainingCurrent = max(0, effectiveAvg − minutesElapsed(current.calledAt))
estimatedWaitMinutes(i) = round(remainingCurrent + i × effectiveAvg)
tokensAhead(i)          = (current ? 1 : 0) + i
```

This counts the partially-completed current consult *and* everyone ahead, and it
**decreases as the current consult progresses** — even with no new clicks — because the
10 s heartbeat re-broadcasts a freshly computed snapshot. That's what keeps the patient
screen's "Next wait" alive instead of frozen.

**Guarding the average:** a duration is only recorded when `calledAt` exists **and**
elapsed time `> 0`. So accidental instant completions or undo-restored patients never
inject 0-minute garbage that would deflate the estimate.

---

## 5. Edge cases

| Edge case | Handling |
|---|---|
| Call Next on empty queue | No-op; `queue:notice` "No patients waiting"; no broadcast. (Frontend also disables the button.) |
| Complete with nobody in consultation | No-op + notice. |
| Double / rapid Call Next | Cooldown guard drops the second call (§3.2). |
| Receptionist mis-click | Single-level `undo` restores the exact prior snapshot (e.g., un-calls a patient back into waiting). |
| Undo with nothing to undo | No-op + "Nothing to undo" notice; no redo / no undo-of-undo. |
| Patient display tries a staff action | Rejected by role gating with a "Not authorized" notice; state untouched. |
| Invalid `setAvgTime` (NaN, ≤0, >600) | Rejected with an error notice; value unchanged. |
| Malicious / oversized name | Sanitized: control & `< >` chars stripped, trimmed, capped at 60; empty → `null`. |
| Malformed event payload | Every handler is wrapped in `safe()`; an exception emits an error notice instead of crashing the server. |
| Client disconnect / refresh | socket.io auto-reconnects; server sends a fresh snapshot on `join`. |
| Server restart mid-day | State (incl. the monotonic token counter) is reloaded from `queue.json`, so already-issued token numbers are never reused. |
| Last patient finishes | `current` becomes `null`; patient screen shows "Please wait". |
| Two tokens, same name / no name | Tokens are keyed by a monotonic `tokenNumber` (and an internal uuid), never by name; name is purely cosmetic. |

---

## 6. Scope boundaries (explicit decisions, not omissions)

- **Single global queue / one consultation room.** Multi-doctor or multi-clinic routing
  would be modeled as multiple named queues; out of scope for this hackathon.
- **In-memory + local JSON, no database.** Right call for a demo: zero infra, and wait
  times are still computed from real event data. Not for production patient data.
- **Optional shared reception key, no full user auth.** Enough to stop the public display
  from driving the queue; a real deployment needs proper authentication, HTTPS/WSS, and a
  hardened datastore for any PII/PHI.

---

## 7. How correctness is proven

32 evals run under `npm test` (Node's built-in runner):

- **Unit (21):** token monotonicity & no-reuse, name sanitization, all transitions,
  guarded duration recording, rolling-average vs fallback, per-position wait/tokens-ahead,
  remaining-time decay, undo (incl. un-call), empty-queue no-op, cooldown (incl. the
  intervening-action-clears-cooldown case), input validation, serialize/load round-trip.
- **Integration (6, real `socket.io-client`):** snapshot on join; **both a patient and a
  reception client receive the update after Call Next** (the 40% behavior); role gating;
  reconnect resync; persistence-on-change; invalid-input notice.
- **Persistence (4, real file IO):** atomic write, parent-dir creation, corrupt-file
  tolerance, full QueueStore round-trip preserving the token counter.
- **Boot (1):** spawns the real `src/index.js`, drives it over a socket, and confirms
  graceful-shutdown state persistence.

Dependencies audit clean (`npm audit` → 0 vulnerabilities).
