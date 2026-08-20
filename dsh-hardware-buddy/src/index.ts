import type { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CdcBridge } from './cdc.js';
import { ApprovalBridge } from './approval.js';
import { EventBridge } from './bridge.js';
import { Config } from './config.js';
import type { AppContext, Logger } from './context.js';
import { dbg } from './debug.js';
import type { DeviceCommand, Heartbeat } from './protocol.js';

const requireResolve = createRequire(import.meta.url).resolve;

export const name = 'hardware-buddy';

// Cordis service names are tools / approval / agents / sessions (plural!).
// Injecting a wrong name silently hangs the plugin.
export const inject = ['tools', 'approval'];

export function apply(ctx: Context, config: Config): void {
  dbg('[hb] apply enter');
  const app = ctx as unknown as AppContext;
  const logger = app.logger('hardware-buddy') as Logger;

  // FR8: self-check against the anchored dsh-tools version. Drift only warns;
  // it must never throw (rc stage is expected to break compatibility).
  try {
    const pkg = JSON.parse(
      readFileSync(requireResolve('@deepseek-ai/dsh-tools/package.json'), 'utf8'),
    );
    if (pkg.version !== '0.1.0-rc.7') {
      logger.warn(`dsh-tools ${pkg.version} != tested 0.1.0-rc.7, event payloads may differ`);
    }
  } catch {
    // dsh-tools not resolvable in this environment; skip self-check.
  }

  // Late-bound holder that breaks the cdc <-> approval <-> bridge cycle without
  // a temporal-dead-zone hack: approval/cdc are constructed referencing this
  // holder, and `cdc` is assigned immediately after.
  let cdc: CdcBridge | null = null;
  const cdcRef = {
    get isConnected(): boolean {
      return !!cdc?.isConnected;
    },
    send(hb: Heartbeat): boolean {
      return cdc ? cdc.send(hb) : false;
    },
  };

  const approval = new ApprovalBridge(
    config,
    () => cdcRef.isConnected,
    (id, tool, hint) => cdcRef.send({ waiting: 1, prompt: { id, tool, hint } }),
    (count) => cdcRef.send({ waiting: count }),
    logger,
  );

  let bridge: EventBridge | null = null;

  cdc = new CdcBridge(
    config,
    (cmd: DeviceCommand) => {
      if (cmd.cmd === 'permission') {
        if (cmd.decision) approval.onDeviceCommand(cmd.decision, cmd.id);
      } else if (cmd.cmd === 'unpair') {
        approval.onDeviceUnpair();
      }
    },
    (connected) => {
      logger.info(connected ? 'cdc connected' : 'cdc disconnected');
      // FR8: connection-changed hook for a future Web UI status badge.
      app.emit('hardware-buddy/connection-changed', { connected });
      // Reconnect: immediately re-send a full snapshot.
      if (connected && bridge) bridge.flush();
    },
    logger,
  );

  bridge = new EventBridge(ctx as unknown as AppContext, config, (hb) => cdcRef.send(hb));
  const detach = bridge.attach();

  app.on('tools/pre-execute', approval.preExecuteHook);
  app.on('approval/request', approval.approvalRequestHook, { prepend: true });

  // FR7: make config effectiveness visible via a startup dry-run. Enumerate
  // real tool names from the injected tools service when available.
  try {
    const tools = (ctx as unknown as { tools?: unknown }).tools;
    let names: string[] = [];
    if (tools) {
      if (typeof (tools as { list?: () => unknown[] }).list === 'function') {
        names = ((tools as { list: () => unknown[] }).list() as unknown[]).map((t) =>
          (t as { name?: string })?.name ?? String(t),
        );
      } else if (typeof (tools as { getList?: () => unknown[] }).getList === 'function') {
        names = ((tools as { getList: () => unknown[] }).getList() as unknown[]).map((t) =>
          (t as { name?: string })?.name ?? String(t),
        );
      } else {
        names = Object.keys(tools as Record<string, unknown>);
      }
    }
    if (names.length) approval.dryRunMatch(names);
  } catch {
    // tools not ready yet; dry-run is best-effort observability only.
  }

  void cdc.start();

  // Unload cleanup: detach listeners, close the serial port.
  app.effect(() => async () => {
    detach();
    await cdc?.stop();
  });
}
