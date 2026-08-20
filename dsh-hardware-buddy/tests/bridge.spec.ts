import { describe, it, expect, vi } from 'vitest';
import { EventBridge } from '../src/bridge.js';
import type { AppContext } from '../src/context.js';
import type { Config } from '../src/config.js';
import type { Heartbeat } from '../src/protocol.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: null,
    vendorId: '0x303A',
    productId: null,
    baudRate: 115200,
    approvalTimeout: 30000,
    heartbeatIntervalMs: 3000,
    dangerousTools: [],
    excludedTools: ['^MCP__danger_.*'],
    celebrateThreshold: 50000,
    entriesLimit: 5,
    // P2-B: chime / time-sync knobs (defaults match config.ts)
    chimeEnabled: true,
    chimeMinIntervalMs: 8000,
    timeSyncIntervalMs: 60000,
    logLevel: 'info',
    ...overrides,
  };
}

function makeCtx() {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  const ctx = {
    on(event: string, listener: (...args: any[]) => void) {
      (handlers[event] ??= []).push(listener);
      return () => {};
    },
    emit() {},
    effect() {},
    logger() {
      return { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as any;
    },
  } as unknown as AppContext;
  return { ctx, handlers };
}

function emit(handlers: Record<string, ((...args: any[]) => void)[]>, ev: string, ...args: any[]) {
  for (const h of handlers[ev] ?? []) h(...args);
}

describe('EventBridge', () => {
  it('session/created and session/disposed drive total', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig(), (hb) => sent.push(hb));
    bridge.attach();

    emit(handlers, 'session/created');
    emit(handlers, 'session/created');
    emit(handlers, 'session/disposed');
    bridge.flush();

    expect(sent.at(-1)!.total).toBe(1);
  });

  it('agent/status handles both running and idle', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig(), (hb) => sent.push(hb));
    bridge.attach();

    emit(handlers, 'agent/status', { agent: 'a', status: 'running' });
    bridge.flush();
    expect(sent.at(-1)!.running).toBe(1);

    emit(handlers, 'agent/status', { agent: 'a', status: 'idle' });
    bridge.flush();
    expect(sent.at(-1)!.running).toBe(0);
  });

  it('caps entries at entriesLimit', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig({ entriesLimit: 3 }), (hb) => sent.push(hb));
    bridge.attach();

    for (let i = 0; i < 5; i++) {
      emit(handlers, 'session/event', undefined, {
        type: 'tool/result',
        message: { content: `cmd-${i}` },
      });
    }
    bridge.flush();
    expect(sent.at(-1)!.entries!.length).toBe(3);
  });

  it('fires celebrate once tokens cross the threshold', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig({ celebrateThreshold: 100 }), (hb) => sent.push(hb));
    bridge.attach();

    emit(handlers, 'session/event', undefined, {
      type: 'assistant/message',
      usage: { inputTokens: 60, outputTokens: 60 },
    });
    bridge.flush();

    const hb = sent.at(-1)!;
    expect(hb.tokens).toBe(120);
    expect(hb.tokens_today).toBe(120);
    expect(hb.msg).toBe('milestone!');
  });

  it('throttles: events do not send, only flush() does', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig(), (hb) => sent.push(hb));
    bridge.attach();

    emit(handlers, 'agent/status', { status: 'running' });
    expect(sent.length).toBe(0);

    bridge.flush();
    expect(sent.length).toBe(1);
    expect(sent.at(-1)!.running).toBe(1);
  });

  // Regression (live-verified): the firmware CLEARS the approval screen when a
  // heartbeat omits the prompt field (data.h: absent key => promptId[0]=0).
  // The pending prompt is state — every flush must re-carry it until cleared.
  it('flush carries the pending prompt and waiting count until cleared', () => {
    const { ctx } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig(), (hb) => sent.push(hb));
    bridge.attach();

    bridge.setPendingPrompt({ id: 'call_1', tool: 'bash', hint: 'echo hi' });
    bridge.setPendingWaiting(1);
    bridge.flush();
    bridge.flush();
    bridge.flush();
    for (const hb of sent.slice(-3)) {
      expect(hb.prompt).toEqual({ id: 'call_1', tool: 'bash', hint: 'echo hi' });
      expect(hb.waiting).toBe(1);
    }

    bridge.setPendingPrompt(undefined);
    bridge.setPendingWaiting(0);
    bridge.flush();
    expect(sent.at(-1)!.prompt).toBeUndefined();
    expect(sent.at(-1)!.waiting).toBe(0);
  });
});

  // -----------------------------------------------------------------------
  // P2-B / FR4: completion_seq merging + chimeEnabled toggle
  // -----------------------------------------------------------------------

  it('turn/end bumps completion_seq and emits it on the next flush', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    let fakeNow = 1_000_000;
    const bridge = new (class extends EventBridge {
      protected override now() { return fakeNow; }
    })(ctx, makeConfig({ chimeMinIntervalMs: 0 }), (hb) => sent.push(hb));
    bridge.attach();

    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    bridge.flush();
    expect(sent.at(-1)!.completion_seq).toBe(1);

    fakeNow += 100;  // well clear of the merge window (0 ms here)
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    bridge.flush();
    expect(sent.at(-1)!.completion_seq).toBe(2);
  });

  it('coalesces turn/end bursts within chimeMinIntervalMs (8s default)', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    let fakeNow = 1_000_000;
    const bridge = new (class extends EventBridge {
      protected override now() { return fakeNow; }
    })(ctx, makeConfig(), (hb) => sent.push(hb));  // 8000 ms default
    bridge.attach();

    // Back-to-back turn/end inside the merge window should bump once.
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    fakeNow += 1000;
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    fakeNow += 1000;
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    bridge.flush();
    expect(sent.at(-1)!.completion_seq).toBe(1);

    // After the window, a second burst bumps to 2.
    fakeNow += 10_000;
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    bridge.flush();
    expect(sent.at(-1)!.completion_seq).toBe(2);
  });

  it('chimeEnabled=false suppresses all completion_seq bumps', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    let fakeNow = 1_000_000;
    const bridge = new (class extends EventBridge {
      protected override now() { return fakeNow; }
    })(ctx, makeConfig({ chimeEnabled: false }), (hb) => sent.push(hb));
    bridge.attach();

    fakeNow += 100;
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    fakeNow += 100;
    emit(handlers, 'session/event', undefined, { type: 'turn/end' });
    bridge.flush();
    expect(sent.at(-1)!.completion_seq).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // P2-B: error_seq — bumped on every tool/result with an error field
  // -----------------------------------------------------------------------

  it('tool/result with ev.error bumps error_seq', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig(), (hb) => sent.push(hb));
    bridge.attach();

    // live envelope shape: {type, seq, time, data} — `.error` lives under data
    emit(handlers, 'session/event', undefined, {
      type: 'tool/result',
      seq: 1,
      time: 0,
      data: { error: { message: 'exit 1' } },
    });
    emit(handlers, 'session/event', undefined, {
      type: 'tool/result',
      seq: 2,
      time: 0,
      data: { message: { error: true } },  // legacy nested path
    });
    emit(handlers, 'session/event', undefined, {
      type: 'tool/result',
      seq: 3,
      time: 0,
      data: { error: false },  // explicit no-error — must NOT bump
    });

    bridge.flush();
    expect(sent.at(-1)!.error_seq).toBe(2);
  });

  it('error_seq bumps ignore the chimeEnabled knob (AC-P2-2 invariant)', () => {
    const { ctx, handlers } = makeCtx();
    const sent: Heartbeat[] = [];
    const bridge = new EventBridge(ctx, makeConfig({ chimeEnabled: false }), (hb) => sent.push(hb));
    bridge.attach();

    emit(handlers, 'session/event', undefined, {
      type: 'tool/result', data: { error: true },
    });
    bridge.flush();
    expect(sent.at(-1)!.error_seq).toBe(1);
  });

  // -----------------------------------------------------------------------
  // P2-B / FR5: time sync throttling (default 60s)
  // -----------------------------------------------------------------------

  it('first heartbeat carries time; subsequent flushes within 60s omit it', () => {
    const { ctx } = makeCtx();
    const sent: Heartbeat[] = [];
    let fakeNow = 1_700_000_000_000;  // 2023-11-14-ish
    const bridge = new (class extends EventBridge {
      protected override now() { return fakeNow; }
    })(ctx, makeConfig({ timeSyncIntervalMs: 60_000 }), (hb) => sent.push(hb));
    bridge.attach();

    bridge.flush();
    expect(sent.at(-1)!.time).toBeDefined();
    const firstEpoch = sent.at(-1)!.time![0];

    fakeNow += 5_000;
    bridge.flush();
    expect(sent.at(-1)!.time).toBeUndefined();

    fakeNow += 60_000;
    bridge.flush();
    expect(sent.at(-1)!.time).toBeDefined();
    expect(sent.at(-1)!.time![0]).toBeGreaterThan(firstEpoch);
  });

  it('time payload shape is [epoch_sec_int, tz_offset_sec_int]', () => {
    const { ctx } = makeCtx();
    const sent: Heartbeat[] = [];
    let fakeNow = 1_700_000_000_000;
    const bridge = new (class extends EventBridge {
      protected override now() { return fakeNow; }
    })(ctx, makeConfig({ timeSyncIntervalMs: 0 }), (hb) => sent.push(hb));
    bridge.attach();

    bridge.flush();
    const t = sent.at(-1)!.time!;
    expect(Array.isArray(t)).toBe(true);
    expect(t).toHaveLength(2);
    expect(Number.isInteger(t[0])).toBe(true);
    expect(Number.isInteger(t[1])).toBe(true);
    // epoch ≈ now/1000 — within ±2s of the fake clock
    expect(Math.abs(t[0] - Math.floor(fakeNow / 1000))).toBeLessThanOrEqual(2);
  });
