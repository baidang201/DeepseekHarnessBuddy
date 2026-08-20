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
});
