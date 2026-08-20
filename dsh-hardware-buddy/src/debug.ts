/**
 * Env-gated integration debugging. The dsh headless profile suppresses plugin
 * logger output, so during hardware bring-up set HB_DEBUG=1 to trace the CDC
 * lifecycle on stderr (apply entry, port discovery, open, device echo lines).
 */
const enabled = process.env.HB_DEBUG === '1';

export function dbg(msg: string): void {
  if (enabled) console.error(msg);
}
