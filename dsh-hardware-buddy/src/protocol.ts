// Wire protocol shared with the StickS3 firmware.
//
// Field semantics mirror firmware/src/data.h:_applyJson(). The 900-byte cap is
// enforced ONLY here (NFR5) by `trimHeartbeat`, in the exact order specified by
// tech.md §3.5 / prd.md §A. The old Python host `reducer.py` is gone; this is
// the single truncation point in the new chain.

export const HEARTBEAT_MAX_BYTES = 900;

export interface HeartbeatUsage {
  five_hour_remaining: number; // 0-1
  seven_day_remaining: number; // 0-1
}

export interface HeartbeatPrompt {
  id: string;
  tool: string;
  hint: string; // <= 120 chars, summarized from pre-execute args
}

export interface Heartbeat {
  total?: number;
  running?: number;
  waiting?: number;
  msg?: string;
  entries?: string[];
  tokens?: number;
  tokens_today?: number;
  activity20?: number; // uint32, low-20-bits (firmware校验 data.h:290-298)
  token20v1?: string; // base64url 86 chars (token_heartbeat_logic.h:7-10)
  usage?: HeartbeatUsage;
  completion_seq?: number; // uint32 — bridge bumps on turn/end, device chimes (FR4)
  error_seq?: number;     // P2-B: bridge bumps on tool/result.error → device plays Error voice
  time?: [number, number]; // P2-B: [epoch_sec, tz_offset_sec]; throttled to ≤ 60s (FR5);
                            // signed int32 epoch_sec arrives < UINT32 by epochInRange check
                            // on the firmware side (data.h:193-249)
  unread?: number;
  prompt?: HeartbeatPrompt;
}

export type DeviceDecision = 'once' | 'deny';

export interface DeviceCommand {
  cmd: 'permission' | 'unpair';
  id?: string;
  decision?: DeviceDecision;
}

// Approval outcomes follow user-approval/src/types.ts:29. The plugin itself
// only ever produces allowed-once / rejected (device buttons) / cancelled
// (self timeout or req.signal abort). It NEVER produces 'unavailable'.
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export function decisionToOutcome(d: DeviceDecision): ApprovalOutcome {
  return d === 'once' ? 'allowed-once' : 'rejected';
}

export function serializeHeartbeat(hb: Heartbeat): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hb)) {
    if (v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

/**
 * 900-byte trim. Single truncation point in the whole chain (NFR5).
 * Order (must not change):
 *   1. entries: drop entries one-by-one from the tail
 *   2. prompt.hint: slice to 96 / 72 / 48 / 32
 *   3. prompt: delete entirely
 *   4. msg: slice to 36 / 28 / 20 / 12
 * Each step short-circuits as soon as we are under the cap.
 */
export function trimHeartbeat(input: Heartbeat): Heartbeat {
  const h: Heartbeat = { ...input };
  const size = () => serializeHeartbeat(h).length;

  while (size() > HEARTBEAT_MAX_BYTES && h.entries && h.entries.length) {
    h.entries = h.entries.slice(0, -1);
  }

  for (const n of [96, 72, 48, 32]) {
    if (size() <= HEARTBEAT_MAX_BYTES || !h.prompt) break;
    h.prompt = { ...h.prompt, hint: h.prompt.hint.slice(0, n) };
  }

  if (size() > HEARTBEAT_MAX_BYTES && h.prompt) {
    delete h.prompt;
  }

  for (const n of [36, 28, 20, 12]) {
    if (size() <= HEARTBEAT_MAX_BYTES || !h.msg) break;
    h.msg = h.msg.slice(0, n);
  }

  return h;
}

/**
 * Build a <=120 char one-line hint from tool arguments. `ApprovalRequest`
 * carries no args, so this is fed from the pre-execute arg cache.
 */
export function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.slice(0, 120);
  if (typeof args === 'object' && args !== null && 'command' in args) {
    return String((args as { command: unknown }).command).slice(0, 120);
  }
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
