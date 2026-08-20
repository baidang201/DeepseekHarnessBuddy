import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalBridge } from '../src/approval.js';
import type { Config } from '../src/config.js';
import type { ApprovalOutcome } from '../src/protocol.js';

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

interface Harness {
  bridge: ApprovalBridge;
  cdcOnline: ReturnType<typeof vi.fn>;
  sentPrompts: { id: string; tool: string; hint: string }[];
  clearedPrompts: number;
  sentWaiting: number[];
  logs: { level: string; msg: string }[];
}

function makeHarness(config: Config): Harness {
  const sentPrompts: { id: string; tool: string; hint: string }[] = [];
  const sentWaiting: number[] = [];
  const logs: { level: string; msg: string }[] = [];
  let clearedPrompts = 0;
  const cdcOnline = vi.fn(() => true);
  const bridge = new ApprovalBridge(
    config,
    cdcOnline,
    (id, tool, hint) => {
      sentPrompts.push({ id, tool, hint });
    },
    () => {
      clearedPrompts += 1;
    },
    (c) => sentWaiting.push(c),
    {
      info: (m) => logs.push({ level: 'info', msg: m }),
      warn: (m) => logs.push({ level: 'warn', msg: m }),
    },
  );
  return { bridge, cdcOnline, sentPrompts, clearedPrompts, sentWaiting, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('preExecuteHook', () => {
  it('returns ask + caches args for a matching dangerous tool', () => {
    const { bridge } = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    const r = bridge.preExecuteHook(
      { name: 'fs.write', arguments: { path: '/tmp/x' }, callId: 'c1', agent: 'a1' },
      next,
    );
    expect(r).toEqual({ kind: 'ask', reason: 'hardware buddy approval' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns ask for an excluded tool too (routed to Web UI at approval time)', () => {
    const { bridge } = makeHarness(makeConfig());
    const next = vi.fn();
    const r = bridge.preExecuteHook(
      { name: 'MCP__danger_x', callId: 'c', agent: 'a' },
      next,
    );
    expect(r).toEqual({ kind: 'ask', reason: 'hardware buddy approval' });
    expect(next).not.toHaveBeenCalled();
  });

  it('non-matching tool -> next()', () => {
    const { bridge } = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    bridge.preExecuteHook({ name: 'fs.read', callId: 'c2', agent: 'a1' }, next);
    expect(next).toHaveBeenCalled();
  });

  it('missing agent -> next() (avoid runtime downgrade to deny)', () => {
    const { bridge } = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    bridge.preExecuteHook({ name: 'fs.write', callId: 'c3', arguments: {} }, next);
    expect(next).toHaveBeenCalled();
  });

  it('missing callId -> next()', () => {
    const { bridge } = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    bridge.preExecuteHook({ name: 'fs.write', agent: 'a' }, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('approvalRequestHook', () => {
  it('excluded tool -> next(), plugin does NOT take over', async () => {
    const { bridge } = makeHarness(makeConfig());
    const next = vi.fn(() => Promise.resolve('webui' as ApprovalOutcome));
    const p = bridge.approvalRequestHook({ agent: 'a', toolName: 'MCP__danger_x', callId: 'd1' }, next);
    expect(next).toHaveBeenCalled();
    expect(await p).toBe('webui');
  });

  it('device offline -> next(), falls through to Web UI', async () => {
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    h.cdcOnline.mockReturnValue(false);
    const next = vi.fn(() => Promise.resolve('webui' as ApprovalOutcome));
    const p = h.bridge.approvalRequestHook({ agent: 'a', toolName: 'fs.write', callId: 'd2' }, next);
    expect(next).toHaveBeenCalled();
    expect(await p).toBe('webui');
  });

  it('device online + dangerous -> takes over, device A yields allowed-once', async () => {
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    // cache args via pre-execute
    h.bridge.preExecuteHook(
      { name: 'fs.write', arguments: { path: '/tmp/x' }, callId: 'c9', agent: 'a' },
      () => {},
    );
    const next = vi.fn();
    const p = h.bridge.approvalRequestHook({ agent: 'a', toolName: 'fs.write', callId: 'c9' }, next);
    expect(next).not.toHaveBeenCalled();
    expect(h.sentPrompts.length).toBe(1);
    expect(h.sentPrompts[0].tool).toBe('fs.write');
    expect(h.sentPrompts[0].hint).toContain('/tmp/x');

    h.bridge.onDeviceCommand('once', 'c9');
    expect(await p).toBe('allowed-once');
    expect(h.sentWaiting.at(-1)).toBe(0);
  });

  it('device B yields rejected', async () => {
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    const p = h.bridge.approvalRequestHook({ agent: 'a', toolName: 'fs.write', callId: 'cB' }, next);
    h.bridge.onDeviceCommand('deny', 'cB');
    expect(await p).toBe('rejected');
  });

  it('timeout -> cancelled', async () => {
    vi.useFakeTimers();
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'], approvalTimeout: 20 }));
    const next = vi.fn();
    const p = h.bridge.approvalRequestHook({ agent: 'a', toolName: 'fs.write', callId: 'cT' }, next);
    const settled = p.then((o) => o);
    vi.advanceTimersByTime(50);
    expect(await settled).toBe('cancelled');
  });

  it('req.signal abort -> cancelled', async () => {
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const ac = new AbortController();
    const next = vi.fn();
    const p = h.bridge.approvalRequestHook(
      { agent: 'a', toolName: 'fs.write', callId: 'cS', signal: ac.signal },
      next,
    );
    ac.abort();
    expect(await p).toBe('cancelled');
  });

  it('unpair cancels every pending approval', async () => {
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    const p1 = h.bridge.approvalRequestHook({ agent: 'a', toolName: 'fs.write', callId: 'k1' }, next);
    const p2 = h.bridge.approvalRequestHook({ agent: 'a', toolName: 'fs.write', callId: 'k2' }, next);
    h.bridge.onDeviceUnpair();
    expect(await p1).toBe('cancelled');
    expect(await p2).toBe('cancelled');
  });

  it('falls back to req.reason for the hint when no cached args', async () => {
    const h = makeHarness(makeConfig({ dangerousTools: ['fs\\.write'] }));
    const next = vi.fn();
    const p = h.bridge.approvalRequestHook(
      { agent: 'a', toolName: 'fs.write', callId: 'cR', reason: 'manual reason' },
      next,
    );
    expect(h.sentPrompts.at(-1).hint).toBe('manual reason');
    h.bridge.onDeviceCommand('once', 'cR');
    await p;
  });
});

describe('config robustness', () => {
  it('invalid regex -> warn + skip (does not match anything)', () => {
    const { bridge, logs } = makeHarness(
      makeConfig({ dangerousTools: ['['], excludedTools: ['('] }),
    );
    const warns = logs.filter((l) => l.level === 'warn' && l.msg.includes('invalid regex'));
    expect(warns.length).toBe(2);
    const next = vi.fn();
    // 'anything' matches neither broken pattern
    bridge.preExecuteHook({ name: 'anything', callId: 'x', agent: 'a' }, next);
    expect(next).toHaveBeenCalled();
  });

  it('dryRunMatch logs match statistics', () => {
    const { bridge, logs } = makeHarness(
      makeConfig({ dangerousTools: ['fs\\.write'], excludedTools: ['^MCP__danger_.*'] }),
    );
    bridge.dryRunMatch(['fs.write', 'MCP__danger_x', 'other']);
    const info = logs.filter((l) => l.level === 'info').map((l) => l.msg);
    expect(info.some((m) => m.includes('dangerousTools matched 1/3'))).toBe(true);
    expect(info.some((m) => m.includes('excludedTools matched 1/3'))).toBe(true);
  });
});
