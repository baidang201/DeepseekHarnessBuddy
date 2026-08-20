import type { AppContext } from './context.js';
import type { Config } from './config.js';
import type { Heartbeat } from './protocol.js';
import { trimHeartbeat } from './protocol.js';

interface BridgeState {
  total: number; // session-only count (avoid agent+session double counting)
  running: number;
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
        (_session: unknown, ev: { type?: string } & Record<string, unknown>) => {
          if (ev.type === 'tool/result' || ev.type === 'assistant/message') {
            const summary = this.summarizeEvent(ev).slice(0, 80);
            if (summary) {
              this.state.entries.unshift(summary);
              if (this.state.entries.length > this.config.entriesLimit) {
                this.state.entries.length = this.config.entriesLimit;
              }
            }
          }
          if (ev.type === 'assistant/message' && ev.usage) {
            const u = ev.usage as { inputTokens?: number; outputTokens?: number };
            const delta = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
            this.state.tokens += delta;
            this.state.tokensToday += delta;
            if (!this.state.celebrateFired && this.state.tokens >= this.config.celebrateThreshold) {
              this.state.celebrateFired = true;
              this.state.msg = 'milestone!';
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

  /** Push a full snapshot now (called on reconnect and on demand). */
  flush(): void {
    const hb: Heartbeat = {
      total: this.state.total,
      running: this.state.running,
      entries: [...this.state.entries],
      tokens: this.state.tokens,
      tokens_today: this.state.tokensToday,
      msg: this.state.msg,
    };
    this.send(trimHeartbeat(hb));
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
