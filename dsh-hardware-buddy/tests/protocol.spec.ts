import { describe, it, expect } from 'vitest';
import {
  serializeHeartbeat,
  trimHeartbeat,
  summarizeArgs,
  decisionToOutcome,
  HEARTBEAT_MAX_BYTES,
} from '../src/protocol.js';
import type { Heartbeat } from '../src/protocol.js';

describe('serializeHeartbeat', () => {
  it('drops undefined fields', () => {
    const hb: Heartbeat = { total: 1, msg: undefined as unknown as string };
    const s = serializeHeartbeat(hb);
    expect(s).toBe('{"total":1}');
    expect(s).not.toContain('msg');
  });

  it('keeps defined fields', () => {
    const s = serializeHeartbeat({ total: 2, running: 1, waiting: 0, msg: 'hi' });
    expect(s).toBe('{"total":2,"running":1,"waiting":0,"msg":"hi"}');
  });
});

describe('trimHeartbeat', () => {
  it('never exceeds 900 bytes', () => {
    const huge: Heartbeat = {
      entries: Array.from({ length: 20 }, () => 'x'.repeat(300)),
      prompt: { id: 'i', tool: 't', hint: 'y'.repeat(600) },
      msg: 'z'.repeat(1000),
    };
    const out = trimHeartbeat(huge);
    expect(serializeHeartbeat(out).length).toBeLessThanOrEqual(HEARTBEAT_MAX_BYTES);
  });

  it('preserves a small heartbeat untouched', () => {
    const hb: Heartbeat = { total: 1, running: 1, msg: 'ok' };
    expect(trimHeartbeat(hb)).toEqual(hb);
  });

  it('trims entries before touching prompt.hint', () => {
    const hb: Heartbeat = {
      entries: ['a'.repeat(500), 'b'.repeat(500)],
      prompt: { id: 'i', tool: 't', hint: 'c'.repeat(50) },
    };
    const out = trimHeartbeat(hb);
    // entries reduced first; prompt.hint small enough to stay intact
    expect(out.entries!.length).toBe(1);
    expect(out.prompt!.hint.length).toBe(50);
    expect(serializeHeartbeat(out).length).toBeLessThanOrEqual(HEARTBEAT_MAX_BYTES);
  });

  it('trims prompt.hint via 96/72/48/32 step, leaving msg intact', () => {
    const hb: Heartbeat = {
      prompt: { id: 'i', tool: 't', hint: 'z'.repeat(600) },
      msg: 'w'.repeat(600),
    };
    const out = trimHeartbeat(hb);
    expect(out.prompt!.hint.length).toBe(96);
    expect(out.msg!.length).toBe(600);
  });

  it('trims msg via 36/28/20/12 step', () => {
    const hb: Heartbeat = { msg: 'w'.repeat(1000) };
    const out = trimHeartbeat(hb);
    expect(out.msg!.length).toBe(36);
  });

  it('deletes prompt entirely when even hint=32 is still over budget', () => {
    const hb: Heartbeat = {
      prompt: { id: 'i', tool: 't', hint: 'z'.repeat(600) },
      msg: 'w'.repeat(1000),
    };
    const out = trimHeartbeat(hb);
    expect(out.prompt).toBeUndefined();
    expect(out.msg!.length).toBe(36);
    expect(serializeHeartbeat(out).length).toBeLessThanOrEqual(HEARTBEAT_MAX_BYTES);
  });
});

describe('summarizeArgs', () => {
  it('returns empty for nullish', () => {
    expect(summarizeArgs(null)).toBe('');
    expect(summarizeArgs(undefined)).toBe('');
  });

  it('slices long strings to 120', () => {
    expect(summarizeArgs('a'.repeat(200)).length).toBe(120);
  });

  it('prefers the command field for objects', () => {
    expect(summarizeArgs({ command: 'git push origin', other: 1 })).toBe('git push origin');
  });

  it('JSON-stringifies other objects and truncates with ellipsis', () => {
    const big = { a: 'x'.repeat(200) };
    const s = summarizeArgs(big);
    expect(s.endsWith('...')).toBe(true);
    expect(s.length).toBe(120);
  });

  it('keeps small JSON objects whole', () => {
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}');
  });
});

describe('decisionToOutcome', () => {
  it('maps once -> allowed-once', () => {
    expect(decisionToOutcome('once')).toBe('allowed-once');
  });
  it('maps deny -> rejected', () => {
    expect(decisionToOutcome('deny')).toBe('rejected');
  });
});
