import type { AppContext } from './context.js';
import type { Config } from './config.js';
import type { Heartbeat, HeartbeatPrompt } from './protocol.js';
import { trimHeartbeat } from './protocol.js';
import { dbg } from './debug.js';

interface BridgeState {
  total: number; // session-only count (avoid agent+session double counting)
  running: number;
  waiting: number; // pending hardware approvals (state-based, carried every flush)
  prompt?: HeartbeatPrompt; // pending approval screen; carried EVERY flush —
  // the firmware clears the screen when a heartbeat omits the field
  entries: string[];
  tokens: number; // process-lifetime cumulative; reset on restart/HMR
  tokensToday: number; // "process alive" cumulative, not calendar day
  celebrateFired: boolean; // resets with the process (intentional)
  msg?: string;
  // P2-B / FR4: monotonically increasing completion sequence (bridge → firmware chime).
  // Bumped on `turn/end` only when chimeEnabled AND chimeMinIntervalMs has elapsed since
  // the last bump; the threshold merge is what makes a 1-msg burst into 1 chime.
  completionSeq: number;
  // P2-B: monotonically increasing tool-error sequence. Bumped on every `tool/result`
  // whose data payload contains an `error` field (regardless of chimeEnabled — errors
  // must always reach the device, FR1 AC-P2-2).
  errorSeq: number;
  // P2-B / FR4: epoch ms of the last completionSeq bump, used to enforce chimeMinIntervalMs.
  lastChimeMs: number;
  // P2-B / FR5: epoch ms of the last heartbeat that carried a `time` sync payload.
  lastTimeSyncMs: number;
}

/**
 * dsh event bus -> state machine. transmission is driven ONLY by the periodic
 * full-snapshot timer (heartbeatIntervalMs, default 3s), never per-event (e.g.
 * assistant/chunk is high-frequency). This keeps the device's 30s heartbeat
 * window satisfied and avoids flooding the CDC line.
 */
export class EventBridge {
  private state: BridgeState;
  private disposers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly config: Config,
    private readonly send: (hb: Heartbeat) => void,
  ) {
    this.state = {
      total: 0,
      running: 0,
      waiting: 0,
      entries: [],
      tokens: 0,
      tokensToday: 0,
      celebrateFired: false,
      completionSeq: 0,
      errorSeq: 0,
      lastChimeMs: 0,
      lastTimeSyncMs: 0,
    };
  }

  attach(): () => void {
    this.disposers.push(
      this.ctx.on('session/created', () => this.bumpTotal(+1)),
    );
    this.disposers.push(
      this.ctx.on('session/disposed', () => this.bumpTotal(-1)),
    );

    // payload { agent, status: 'idle' | 'running' }, both directions.
    this.disposers.push(
      this.ctx.on('agent/status', (payload: { status?: string }) => {
        this.state.running = payload?.status === 'running' ? 1 : 0;
      }),
    );

    this.disposers.push(
      this.ctx.on(
        'session/event',
        (_session: unknown, rawEv: { type?: string } & Record<string, unknown>) => {
          // Live session/event payloads are WRAPPED: {type, seq, time, data}.
          // Unit tests (and the persisted SessionEventMap types) use the
          // unwrapped data shape. Normalize once; everything below reads `ev.*`.
          const ev = ((rawEv as { data?: Record<string, unknown> }).data ?? rawEv) as
            Record<string, unknown>;
          const type = rawEv.type;
          dbg(`[hb] event ${type ?? '?'}${ev.usage ? ' +usage' : ''}`);
          // P2-B / FR4: `turn/end` bumps completion_seq so the device plays a soft chime
          // (data.h:_applyJson → completionChimeObserve → playCompletionSound). We coalesce
          // rapid bursts within chimeMinIntervalMs so a multi-message turn yields one chime,
          // not a chatterbox. Errors ALWAYS reach the device (AC-P2-2) regardless of the
          // chime knob — the chip-side observer bumps on every transition.
          if (type === 'turn/end') {
            this.maybeBumpCompletionSeq(ev);
          }
          // P2-B: any tool/result carrying an error bumps error_seq (no throttle — the
          // user must hear each failure). The firmware fires playClip(Error) on every
          // transition (main.cpp:errorSeqObserve). Live dsh emits a wrapped envelope
          // {type, seq, time, data} where `data` may carry `error` directly OR
          // `message.error` for older agent versions — accept either.
          if (type === 'tool/result' && this.eventHasError(ev)) {
            this.state.errorSeq += 1;
            dbg(`[hb] errorSeq=${this.state.errorSeq}`);
          }
          if (type === 'tool/result' || type === 'assistant/message') {
            const summary = this.summarizeEvent(ev).slice(0, 80);
            if (summary) {
              this.state.entries.unshift(summary);
              if (this.state.entries.length > this.config.entriesLimit) {
                this.state.entries.length = this.config.entriesLimit;
              }
            }
          }
          // Live usage rides on assistant/chunk (chunk.type === 'usage').
          // The persisted assistant/message record also carries usage, but the
          // live emit does NOT — counting only the message event yields zero.
          const chunk = ev.chunk as { type?: string; usage?: Record<string, number> } | undefined;
          const usage = chunk?.type === 'usage'
            ? chunk.usage
            : type === 'assistant/message'
              ? (ev.usage as Record<string, number> | undefined)
              : undefined;
          if (usage) {
            const delta =
              (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
              (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) +
              (usage.reasoningTokens ?? 0);
            this.state.tokens += delta;
            this.state.tokensToday += delta;
            dbg(`[hb] usage +${delta} total=${this.state.tokens}`);
            if (!this.state.celebrateFired && this.state.tokens >= this.config.celebrateThreshold) {
              this.state.celebrateFired = true;
              this.state.msg = 'milestone!';
              dbg('[hb] CELEBRATE fired');
            }
          }
        },
      ),
    );

    // Periodic full snapshot (keep-alive + mirror).
    this.timer = setInterval(() => this.flush(), this.config.heartbeatIntervalMs);
    this.disposers.push(() => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    });

    return () => this.disposers.forEach((d) => d());
  }

  /** Set/clear the pending approval screen (carried by every flush). */
  setPendingPrompt(prompt: HeartbeatPrompt | undefined): void {
    this.state.prompt = prompt;
  }

  setPendingWaiting(count: number): void {
    this.state.waiting = count;
  }

  /** Push a full snapshot now (called on reconnect and on demand). */
  flush(): void {
    const hb: Heartbeat = this.buildHeartbeat(this.now());
    this.send(trimHeartbeat(hb));
    // Celebrate msg is one-shot: delivered on the next flush, then cleared so
    // it does not squat on the device status line forever.
    if (this.state.msg === 'milestone!') this.state.msg = undefined;
  }

  private summarizeEvent(ev: Record<string, unknown>): string {
    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) return String(ev.type ?? '');
    const s = JSON.stringify(message);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  }

  private bumpTotal(delta: number): void {
    this.state.total = Math.max(0, this.state.total + delta);
  }

  /** P2-B / FR4: bump completion_seq under the merge window. Errors and chimes are
   * orthogonal — the chip-side observer uses a fresh number each turn the threshold
   * passes, so a single chime happens. The host side (this method) is the only place
   * where the merge lives; the firmware is dumb and just bumps on transition. */
  private maybeBumpCompletionSeq(_ev: Record<string, unknown>): void {
    if (!this.config.chimeEnabled) return;
    const now = this.now();
    if (now - this.state.lastChimeMs < this.config.chimeMinIntervalMs) {
      dbg('[hb] turn/end suppressed (merge window)');
      return;
    }
    this.state.lastChimeMs = now;
    this.state.completionSeq += 1;
    dbg(`[hb] completionSeq=${this.state.completionSeq}`);
  }

  /** P2-B: detect a tool/result payload carrying an `error` field. The dsh live bus
   * wraps events as `{type, seq, time, data}`, so we look at the data both at the
   * top level (newer agents) and inside `message` (one compat layer down). Plain
   * `boolean true` counts — many tool errors emit `{error: true, message: '...'}`. */
  private eventHasError(ev: Record<string, unknown>): boolean {
    if (ev.error !== undefined && ev.error !== null && ev.error !== false) return true;
    const message = ev.message as Record<string, unknown> | undefined;
    if (message && message.error !== undefined && message.error !== null && message.error !== false) {
      return true;
    }
    return false;
  }

  /** Build a Heartbeat from state, attaching completion_seq / error_seq / time. The
   * `time` field is throttled to config.timeSyncIntervalMs (default 60s — FR5). */
  private buildHeartbeat(now: number): Heartbeat {
    const hb: Heartbeat = {
      total: this.state.total,
      running: this.state.running,
      waiting: this.state.waiting,
      prompt: this.state.prompt,
      entries: [...this.state.entries],
      tokens: this.state.tokens,
      tokens_today: this.state.tokensToday,
      msg: this.state.msg,
      completion_seq: this.state.completionSeq || undefined,
      error_seq: this.state.errorSeq || undefined,
    };
    // Only carry time when the throttle says so. `localTimeEpochTz` returns
    // seconds since epoch (integer) and the host's local timezone offset (seconds);
    // the device parses [epoch_sec, tz_offset_sec] via data.h:193-249.
    if (now - this.state.lastTimeSyncMs >= this.config.timeSyncIntervalMs) {
      hb.time = this.localTimeEpochTz();
      this.state.lastTimeSyncMs = now;
      dbg(`[hb] time sync epoch=${hb.time[0]} tz=${hb.time[1]}`);
    }
    return hb;
  }

  /** Wrapping for testability (override in tests). Monotonic ms from epoch. */
  protected now(): number {
    return Date.now();
  }

  /** [epoch_sec, tz_offset_sec] for the current wall time.
   * The tz offset follows POSIX convention: positive east of UTC (JS Date returns
   * the opposite sign, so we negate). The firmware parser (data.h:255-260) is
   * agnostic about the sign convention only inside the epicInRange check —
   * any 16-bit +/- offset is accepted. */
  private localTimeEpochTz(): [number, number] {
    const epochSec = Math.floor(this.now() / 1000);
    const tzSec = -new Date().getTimezoneOffset() * 60;
    return [epochSec, tzSec];
  }
}
