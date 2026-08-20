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
    const hb: Heartbeat = {
      total: this.state.total,
      running: this.state.running,
      waiting: this.state.waiting,
      prompt: this.state.prompt,
      entries: [...this.state.entries],
      tokens: this.state.tokens,
      tokens_today: this.state.tokensToday,
      msg: this.state.msg,
    };
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
}
