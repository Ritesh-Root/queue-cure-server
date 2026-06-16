# Queue Cure '26 — Backend

Real-time clinic token-queue server. Drives two live-synced screens — a **receptionist desk** and a **patient waiting-room display** — over Socket.IO. When the receptionist clicks **Call Next**, every connected screen updates instantly, with no page refresh.

Built for the [Queue Cure '26](https://unstop.com) hackathon. This is the **backend half** of the system — it pairs with the frontend repo **[queue-companion](https://github.com/Ritesh-Root/queue-companion)** (the `/reception` and `/patient` screens).

- **Stack:** Node.js + Express + Socket.IO (ESM)
- **State:** in-memory single source of truth, with synchronous JSON persistence
- **Tests:** 32 evals via Node's built-in `node --test` (no test framework dependency)
- **Dependencies:** audited clean (`npm audit` → 0 vulnerabilities)

---

## Quick start

```bash
npm install
npm start            # listens on http://localhost:3000
```

Then run the frontend (`queue-companion`) on its Vite dev server (port 5173) — it connects to `http://localhost:3000` by default. Open `/reception` and `/patient` in two windows and watch them sync.

```bash
npm run dev          # same, with --watch auto-restart
npm test             # run the full eval suite
```

> **Port note:** if `3000` is busy you'll get a friendly message — start with `PORT=4000 npm start` and point the frontend at it via `VITE_SERVER_URL=http://localhost:4000`.

---

## How it scores against the rubric

| Criteria | Weight | How this backend addresses it |
|---|---|---|
| Live updates across both screens, no refresh | 40% | Server broadcasts a full `queue:state` snapshot to **all** clients on every change; clients also get a snapshot on connect, so reconnects/refreshes resync automatically. Proven by the `CRITICAL` integration test. |
| Wait time computed from real data | 25% | `effectiveAvgMinutes` is a rolling average of **actual** consultation durations (measured from `calledAt`), falling back to the receptionist's setting only until ≥3 real samples exist. `estimatedWaitMinutes` is derived per token. |
| Receptionist screen fast & mistake-proof | 20% | Single-level **undo**, **empty-queue no-op**, **call cooldown** (anti double-advance), and **role gating** so the patient display can never drive the queue. |
| Thought process: concurrency & edge cases | 15% | See [`docs/thought-process.md`](docs/thought-process.md). |

---

## Architecture

```
src/
  queueStore.js   Pure state machine. No Socket.IO imports. Injectable clock.
                  Single source of truth for all queue logic + wait-time math.
  server.js       Socket.IO + Express wiring. Rooms, role gating, broadcast,
                  heartbeat. Built as a factory for testability.
  persistence.js  Synchronous, atomic JSON snapshot (write-temp + rename).
  config.js       Env-driven config with safe defaults.
  index.js        Entry point: hydrate from disk, start, graceful shutdown.
test/
  queueStore.test.js     21 unit evals (transitions, wait-time, undo, cooldown).
  integration.test.js    6 evals over a real socket.io-client.
  persistence.test.js     4 evals over real file IO.
  boot.test.js            1 eval that spawns the real entry point end-to-end.
```

The key design decision is the **split between pure logic (`QueueStore`) and transport (`server.js`)**. The state machine is fully unit-testable without sockets, and the socket layer stays thin.

---

## Socket contract

Connect with `socket.io-client` to the server URL (default `http://localhost:3000`).

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `reception:join` | `{ key? }` | Join the reception room; grants permission to drive the queue. `key` required only if `RECEPTION_KEY` is configured. |
| `patient:join` | `{}` | Join the patient room (read-only display). |
| `reception:addPatient` | `{ name? }` | Add a patient; name is optional, sanitized, capped at 60 chars. |
| `reception:callNext` | `{}` | Complete the current consult (if any) and promote the next token. |
| `reception:completeCurrent` | `{}` | Finish the current consult without promoting anyone. |
| `reception:setAvgTime` | `{ minutes }` | Set the default average consult time (1–600). |
| `reception:undo` | `{}` | Revert the last state-changing action (single level). |

`reception:*` events from a socket that has not joined as reception are rejected with a `queue:notice`.

### Server → Client

| Event | Payload | When |
|---|---|---|
| `queue:state` | `QueueState` (below) | On join, after every change, and every `HEARTBEAT_MS`. |
| `queue:notice` | `{ type, message }` | Non-blocking hint (empty queue, nothing to undo, invalid input, not authorized). |

### `QueueState`

```ts
{
  current: { tokenNumber: number; name: string | null; calledAt: string } | null;
  waiting: Array<{
    tokenNumber: number;
    name: string | null;
    tokensAhead: number;
    estimatedWaitMinutes: number;
  }>;
  avgConsultMinutes: number;     // receptionist's setting
  effectiveAvgMinutes: number;   // adaptive rolling average of real consults
  stats: { waitingCount: number; completedCount: number };
  serverNow: string;             // ISO; extra field, lets clients offset clock skew
}
```

See [`docs/socket-diagram.md`](docs/socket-diagram.md) for the event flow diagram.

---

## Configuration

All optional — see [`.env.example`](.env.example).

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `RECEPTION_KEY` | _(empty)_ | If set, reception clients must present it in `reception:join`. |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Allowed browser origins. |
| `DATA_FILE` | `./data/queue.json` | Persistence file. |
| `HEARTBEAT_MS` | `10000` | State re-broadcast cadence. |
| `AVG_DEFAULT_MINUTES` | `8` | Seed consult time before real data exists. |

---

## Deploy

The server reads `PORT` from the environment (most platforms inject it) and is fully
configured via env vars, so it runs on any container host (Render, Railway, Fly.io, etc.).

### Docker

```bash
docker build -t queue-cure-server .
docker run -p 3000:3000 \
  -e CORS_ORIGINS="https://your-frontend.example" \
  -e RECEPTION_KEY="choose-a-secret" \
  -v queue-data:/app/data \
  queue-cure-server
```

The `-v queue-data:/app/data` volume keeps the queue across restarts (the image is
verified to build and serve `/health` out of the box).

### Connecting the deployed frontend

Two settings must agree:

1. **Backend** `CORS_ORIGINS` must include the frontend's deployed origin (e.g.
   `https://queue-companion.vercel.app`).
2. **Frontend** `VITE_SERVER_URL` must point at the deployed backend URL.

For any public deployment, also set **`RECEPTION_KEY`** so only staff can drive the queue
(the frontend then needs to send `{ key }` in `reception:join`).

---

## Security notes

- **Role gating** prevents the public patient display from emitting receptionist actions. For an open demo no key is required; set `RECEPTION_KEY` to lock down staff actions.
- **Input is sanitized at the boundary:** names are stripped of control/angle characters and length-capped to mitigate XSS on the shared display. **The frontend must still render names as text, never via `innerHTML`.**
- This is a hackathon prototype: state is in-memory + a local JSON file, and there is no user authentication beyond the optional shared reception key. Do not use as-is for real patient data (PII/PHI) without adding proper auth, transport security, and a hardened datastore.

---

## License

MIT
