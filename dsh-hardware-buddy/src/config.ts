import Schema from '@deepseek-ai/schemastery';

export interface Config {
  port: string | null;
  vendorId: string;
  productId: string | null;
  baudRate: number;
  approvalTimeout: number;
  heartbeatIntervalMs: number;
  dangerousTools: string[];
  excludedTools: string[];
  celebrateThreshold: number;
  entriesLimit: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  // P2-B / FR4: completion chime + 8s merge window
  chimeEnabled: boolean;
  chimeMinIntervalMs: number;
  // P2-B / FR5: host time sync throttling — heartbeat carries time at most this often.
  // FR5 brief says 60s. The plugin throttles to this value; the device is robust
  // to anything from 1s..minutes (data.h:193-249 parses only valid ranges).
  timeSyncIntervalMs: number;
}

// Schemastery config schema. Exposed through the dsh `cordis.patch.yml`
// `config:` block (see §3.10). `dangerousTools` defaults were finalized from
// the P0 runtime dump (25 tools, all lowercase — see probe-report.md):
// the write/execute class is bash / write / edit / str_replace_editor.
export const Config = Schema.object({
  port: Schema.union([Schema.string(), Schema.const(null)])
    .default(null)
    .description('null = auto-discover via VID/PID'),
  vendorId: Schema.string().default('0x303A').description('Espressif VID (calibrated by P0 probe)'),
  productId: Schema.union([Schema.string(), Schema.const(null)])
    .default(null)
    .description('optional PID filter'),
  baudRate: Schema.number().default(115200).description('no-op for USB CDC, kept for serialport API compatibility'),
  approvalTimeout: Schema.number().default(30000).description('ms before an unanswered prompt auto-cancels'),
  heartbeatIntervalMs: Schema.number().default(3000)
    .description('full-snapshot interval; must be far below the device 30s heartbeat window'),
  dangerousTools: Schema.array(Schema.string()).default([
    '^bash$',
    '^write$',
    '^edit$',
    '^str_replace_editor$',
  ]).description('regex list of tools routed to the hardware approval screen (P0-finalized)'),
  excludedTools: Schema.array(Schema.string()).default(['^MCP__danger_.*'])
    .description('regex list of tools routed to the dsh Web UI approval instead'),
  celebrateThreshold: Schema.number().default(50000)
    .description('process-lifetime token sum that triggers the celebrate state'),
  entriesLimit: Schema.number().default(5)
    .description('max number of recent event summaries in the heartbeat entries[]'),
  logLevel: Schema.string().default('info'),
  chimeEnabled: Schema.boolean().default(true)
    .description('FR4: when true, turn/end bumps completion_seq so the device chimes'),
  chimeMinIntervalMs: Schema.number().default(8000)
    .description('FR4: merge window — do not bump completion_seq faster than this (ms)'),
  timeSyncIntervalMs: Schema.number().default(60000)
    .description('FR5: heartbeat carries time at most every N ms; brief defaults to 60s'),
});
