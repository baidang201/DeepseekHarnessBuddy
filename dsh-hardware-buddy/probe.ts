// P0 probe plugin (tech.md §6). Run inside a real dsh profile to capture the
// true event payload shapes, dump the real tool-name list (so dangerousTools
// defaults can be finalized), and record the measured VID/PID.
//
// This is a standalone entry, shipped for manual probing — it is intentionally
// NOT wired into the hardware-buddy plugin and is excluded from the tsconfig
// `include` (and from `oxlint src/`). It only needs a real dsh runtime.

import type { Context as CordisContext } from '@deepseek-ai/cordis';

export const name = 'probe';

const PROBE_EVENTS = [
  'tools/pre-execute', 'tools/execute', 'tools/post-execute', 'tools/change',
  'agent/created', 'agent/disposed', 'agent/status', 'agent/error',
  'session/created', 'session/disposed', 'session/event', 'session/flush',
  'approval/request', 'approval/asked', 'approval/decided', 'approval/policy',
  'llm/stream',
];

export function apply(ctx: CordisContext): void {
  const app = ctx as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    logger: (name: string) => { info: (m: string) => void; warn: (m: string) => void };
  };
  const logger = app.logger('probe');

  // 1) Dump the registered tool names (data source for dangerousTools defaults).
  setTimeout(() => {
    const tools = (ctx as unknown as { tools?: unknown }).tools;
    if (tools) {
      try {
        const t = tools as {
          list?: () => unknown[];
          getList?: () => unknown[];
        };
        let names: string[];
        if (typeof t.list === 'function') {
          names = t.list().map((x) => (x as { name?: string })?.name ?? String(x));
        } else if (typeof t.getList === 'function') {
          names = t.getList().map((x) => (x as { name?: string })?.name ?? String(x));
        } else {
          names = Object.keys(t as Record<string, unknown>);
        }
        logger.info('tools: ' + names.sort().join(','));
      } catch (e) {
        logger.warn('tools dump failed: ' + String(e));
      }
    } else {
      logger.warn('tools service not available (check inject)');
    }
  }, 3000);

  // 2) Archive event payload samples.
  for (const name of PROBE_EVENTS) {
    app.on(name, (...args: unknown[]) => {
      logger.info(
        `event ${name} ` +
          args
            .map((a) => (typeof a === 'object' ? JSON.stringify(a).slice(0, 300) : String(a)))
            .join(' | '),
      );
    });
  }
}
