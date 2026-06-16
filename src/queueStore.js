import { randomUUID } from "node:crypto";

/**
 * Pure, transport-agnostic queue state machine for Queue Cure '26.
 *
 * Design notes:
 *  - No Socket.IO / Express imports here. This module is unit-testable in isolation
 *    and is the single source of truth for queue state.
 *  - All "now" reads go through an injectable clock so wait-time math is deterministic
 *    in tests.
 *  - Every mutating method returns { changed: boolean, notice?: {type, message} }.
 *    The transport layer decides to broadcast a snapshot when changed === true and to
 *    emit a queue:notice to the acting socket when notice is present.
 *  - Mutations are fully synchronous (no awaits) so Node's single-threaded event loop
 *    serializes them atomically — see thought-process sheet.
 */

export const LIMITS = Object.freeze({
  NAME_MAX: 60,
  AVG_MIN: 1,
  AVG_MAX: 600,
  ROLLING_WINDOW: 5, // average of the last N real consultations
  MIN_SAMPLES: 3, // need this many real samples before trusting the rolling average
  DURATION_HISTORY: 50, // cap stored samples to bound memory
  COOLDOWN_MS: 300, // drop a second callNext within this window (anti double-advance)
});

function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  // Strip control chars and angle brackets to reduce XSS risk on the shared display.
  const cleaned = raw.replace(/[\u0000-\u001F\u007F<>]/g, "").trim().slice(0, LIMITS.NAME_MAX);
  return cleaned.length ? cleaned : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export class QueueStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.avgConsultMinutes=8]  receptionist default / seed value
   * @param {() => number} [opts.now]            injectable clock (ms since epoch)
   * @param {number} [opts.cooldownMs]           callNext cooldown window
   */
  constructor({ avgConsultMinutes = 8, now = () => Date.now(), cooldownMs = LIMITS.COOLDOWN_MS } = {}) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this._lastCallAt = 0; // transient (not persisted): cooldown tracking
    this._undo = null; // single-level undo snapshot of prior state
    this.state = {
      waiting: [], // [{ id, tokenNumber, name, enqueuedAt }]
      current: null, // { id, tokenNumber, name, enqueuedAt, calledAt }
      avgConsultMinutes,
      completedDurations: [], // minutes of real (calledAt-based) consultations
      completedCount: 0,
      nextTokenNumber: 1,
    };
  }

  // ----- internal helpers -------------------------------------------------

  _capture() {
    return structuredClone(this.state);
  }

  _effectiveAvg() {
    const d = this.state.completedDurations;
    if (d.length >= LIMITS.MIN_SAMPLES) {
      const window = d.slice(-LIMITS.ROLLING_WINDOW);
      const sum = window.reduce((a, b) => a + b, 0);
      return sum / window.length;
    }
    return this.state.avgConsultMinutes;
  }

  /** Record a real consultation duration, guarding against garbage samples. */
  _recordDuration(patient) {
    this.state.completedCount += 1;
    if (!patient || typeof patient.calledAt !== "number") return; // no real consult time
    const minutes = (this.now() - patient.calledAt) / 60000;
    if (minutes > 0) {
      this.state.completedDurations.push(minutes);
      if (this.state.completedDurations.length > LIMITS.DURATION_HISTORY) {
        this.state.completedDurations.shift();
      }
    }
  }

  // ----- mutations --------------------------------------------------------

  addPatient(rawName) {
    const prev = this._capture();
    const patient = {
      id: randomUUID(),
      tokenNumber: this.state.nextTokenNumber,
      name: sanitizeName(rawName),
      enqueuedAt: this.now(),
    };
    this.state.nextTokenNumber += 1;
    this.state.waiting.push(patient);
    this._lastCallAt = 0; // a non-callNext action clears the consecutive-call cooldown
    this._undo = prev;
    return { changed: true };
  }

  callNext() {
    // Cooldown guard: suppress a rapid *consecutive* Call Next (double-click / two tabs)
    // to avoid skipping a patient. Any other action in between clears it (see _lastCallAt
    // resets in the other mutations), so completeCurrent->callNext is never dropped.
    const t = this.now();
    if (t - this._lastCallAt < this.cooldownMs) {
      return { changed: false, notice: { type: "info", message: "Ignored rapid Call Next" } };
    }

    if (this.state.waiting.length === 0) {
      return { changed: false, notice: { type: "info", message: "No patients waiting" } };
    }

    const prev = this._capture();
    // Complete the in-consultation patient (if any), recording real duration.
    if (this.state.current) this._recordDuration(this.state.current);
    // Promote the next waiting token.
    const next = this.state.waiting.shift();
    next.calledAt = t;
    this.state.current = next;
    this._lastCallAt = t;
    this._undo = prev;
    return { changed: true };
  }

  completeCurrent() {
    if (!this.state.current) {
      return { changed: false, notice: { type: "info", message: "No one is in consultation" } };
    }
    const prev = this._capture();
    this._recordDuration(this.state.current);
    this.state.current = null;
    this._lastCallAt = 0; // clears the consecutive-call cooldown
    this._undo = prev;
    return { changed: true };
  }

  setAvgTime(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < LIMITS.AVG_MIN || m > LIMITS.AVG_MAX) {
      return {
        changed: false,
        notice: { type: "error", message: `Average must be ${LIMITS.AVG_MIN}–${LIMITS.AVG_MAX} minutes` },
      };
    }
    if (m === this.state.avgConsultMinutes) return { changed: false };
    const prev = this._capture();
    this.state.avgConsultMinutes = m;
    this._lastCallAt = 0; // clears the consecutive-call cooldown
    this._undo = prev;
    return { changed: true };
  }

  undo() {
    if (!this._undo) {
      return { changed: false, notice: { type: "info", message: "Nothing to undo" } };
    }
    this.state = this._undo;
    this._undo = null; // single-level: no redo, no undo-of-undo
    this._lastCallAt = 0; // clears the consecutive-call cooldown
    return { changed: true };
  }

  // ----- read model -------------------------------------------------------

  /** Build the QueueState snapshot exactly matching the frontend contract. */
  snapshot() {
    const now = this.now();
    const effAvg = this._effectiveAvg();

    // Remaining time for the patient currently being seen.
    let remainingCurrent = 0;
    if (this.state.current && typeof this.state.current.calledAt === "number") {
      const elapsed = (now - this.state.current.calledAt) / 60000;
      remainingCurrent = Math.max(0, effAvg - elapsed);
    }

    const hasCurrent = this.state.current ? 1 : 0;

    const waiting = this.state.waiting.map((p, i) => ({
      tokenNumber: p.tokenNumber,
      name: p.name ?? null,
      tokensAhead: hasCurrent + i,
      estimatedWaitMinutes: Math.max(0, Math.round(remainingCurrent + i * effAvg)),
    }));

    return {
      current: this.state.current
        ? {
            tokenNumber: this.state.current.tokenNumber,
            name: this.state.current.name ?? null,
            calledAt: new Date(this.state.current.calledAt).toISOString(),
          }
        : null,
      waiting,
      avgConsultMinutes: this.state.avgConsultMinutes,
      effectiveAvgMinutes: round1(effAvg),
      stats: {
        waitingCount: this.state.waiting.length,
        completedCount: this.state.completedCount,
      },
      // Extra field (frontend ignores it): lets any client compute clock-skew offset.
      serverNow: new Date(now).toISOString(),
    };
  }

  // ----- persistence hooks (used by the storage layer, keeps store pure) --

  /** Serializable plain object for JSON persistence. */
  serialize() {
    return structuredClone(this.state);
  }

  /** Restore from a previously serialized state. Resets transient undo/cooldown. */
  load(persisted) {
    if (!persisted || typeof persisted !== "object") return false;
    this.state = {
      waiting: Array.isArray(persisted.waiting) ? persisted.waiting : [],
      current: persisted.current ?? null,
      avgConsultMinutes: Number.isFinite(persisted.avgConsultMinutes) ? persisted.avgConsultMinutes : 8,
      completedDurations: Array.isArray(persisted.completedDurations) ? persisted.completedDurations : [],
      completedCount: Number.isFinite(persisted.completedCount) ? persisted.completedCount : 0,
      nextTokenNumber: Number.isFinite(persisted.nextTokenNumber) ? persisted.nextTokenNumber : 1,
    };
    this._undo = null;
    this._lastCallAt = 0;
    return true;
  }
}
