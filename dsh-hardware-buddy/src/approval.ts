import type { Config } from './config.js';
import type { ApprovalOutcome, DeviceDecision } from './protocol.js';
import { decisionToOutcome, summarizeArgs } from './protocol.js';

// tools/pre-execute exec (ToolExecution, tools/src/index.ts:314-338).
// exec.name holds the tool name; exec.arguments is the already-parsed payload.
interface PreExec {
  name?: string;
  arguments?: unknown;
  callId?: string;
  agent?: unknown;
}

// approval/request req (ApprovalRequest, user-approval/src/index.ts:153-174).
// NOTE: there is no args / id / tool field here; args must be cached at
// pre-execute time keyed by callId.
interface ApprovalReq {
  agent: unknown;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

interface PendingApproval {
  tool: string;
  settle: (outcome: ApprovalOutcome) => void;
}

export interface ApprovalLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

/**
 * Bridges the dsh approval waterfall with the physical device.
 *
 * Core principle (Cordis waterfall semantics: NOT calling `next()` vetoes the
 * whole chain, including the Web UI): the plugin only takes over when the
 * device is online AND the tool is not excluded. In every other case — device
 * offline, excluded tool, missing agent/callId, or any internal error — it
 * returns `next()` so the Web UI / default policy decides. The plugin NEVER
 * produces 'unavailable' or a self-inflicted deny.
 */
export class ApprovalBridge {
  private pending = new Map<string, PendingApproval>();
  /** callId -> arg snapshot. ApprovalRequest carries no args, so we cache at pre-execute. */
  private argCache = new Map<string, { tool: string; hint: string }>();
  private excluded: RegExp[];
  private dangerous: RegExp[];

  constructor(
    private readonly config: Config,
    private readonly cdcOnline: () => boolean,
    private readonly sendPrompt: (id: string, tool: string, hint: string) => boolean,
    private readonly sendWaiting: (count: number) => void,
    private readonly logger: ApprovalLogger,
  ) {
    // FR7: a bad regex must not crash the plugin — warn and skip the rule.
    this.excluded = this.compilePatterns(config.excludedTools, 'excludedTools');
    this.dangerous = this.compilePatterns(config.dangerousTools, 'dangerousTools');
  }

  private compilePatterns(patterns: string[], label: string): RegExp[] {
    const out: RegExp[] = [];
    for (const p of patterns) {
      try {
        out.push(new RegExp(p));
      } catch (e) {
        this.logger.warn(`invalid regex in ${label}, skipped: ${p} (${(e as Error).message})`);
      }
    }
    return out;
  }

  /** Startup dry-run: make "config silently not matching" visible in logs. */
  dryRunMatch(knownToolNames: string[]): void {
    const groups = [
      ['dangerousTools', this.dangerous],
      ['excludedTools', this.excluded],
    ] as const;
    for (const [label, list] of groups) {
      const hit = knownToolNames.filter((n) => list.some((re) => re.test(n)));
      this.logger.info(
        `${label} matched ${hit.length}/${knownToolNames.length}` +
          `${hit.length ? ': ' + hit.join(',') : ' (none!)'}`,
      );
    }
  }

  /**
   * tools/pre-execute waterfall (serial/bail-style decision).
   * Matching tools -> cache args and return {kind:'ask'} (reason optional).
   * Non-matching, or missing agent/callId, -> next() (runtime default allow).
   */
  preExecuteHook = (exec: PreExec, next: () => unknown): unknown => {
    try {
      const toolName = exec?.name || 'unknown';
      const matched =
        this.dangerous.some((re) => re.test(toolName)) ||
        this.excluded.some((re) => re.test(toolName));
      if (!matched) return next();

      // exec.agent missing -> ask would be downgraded to deny by the runtime
      // (tools/src/index.ts:1702). Bail out so the tool is not silently denied.
      if (!exec.agent || !exec.callId) return next();

      this.argCache.set(exec.callId, {
        tool: toolName,
        hint: summarizeArgs(exec.arguments),
      });
      return { kind: 'ask' as const, reason: 'hardware buddy approval' };
    } catch {
      // Any unexpected error must not veto the chain.
      return next();
    }
  };

  /**
   * approval/request waterfall (registered with prepend:true).
   * Take over ONLY when: not excluded AND device online. Otherwise next().
   *
   * On takeover we race three sources: device A/B button, the self-held
   * timeout, and req.signal (runtime abort). req.signal is listened to, never
   * constructed here.
   */
  approvalRequestHook = (
    req: ApprovalReq,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    try {
      // Single-shot consume of the pre-execute arg cache.
      const cached = req.callId ? this.argCache.get(req.callId) : undefined;
      if (req.callId) this.argCache.delete(req.callId);

      if (this.excluded.some((re) => re.test(req.toolName))) {
        this.logger.info(`Excluded tool goes to Web UI: ${req.toolName}`);
        return next();
      }
      if (!this.cdcOnline()) {
        this.logger.info(`CDC offline, falling through to Web UI: ${req.toolName}`);
        return next();
      }

      const id = req.callId ?? `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tool = cached?.tool ?? req.toolName;
      const hint = cached?.hint ?? req.reason ?? '';

      return new Promise<ApprovalOutcome>((resolve) => {
        let done = false;
        const settle = (outcome: ApprovalOutcome) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          this.sendWaiting(this.pending.size);
          resolve(outcome);
        };

        const timer = setTimeout(() => {
          this.logger.info(`Approval timeout: ${id} ${tool}`);
          settle('cancelled');
        }, this.config.approvalTimeout);

        const signal = req.signal as AbortSignal | undefined;
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => settle('cancelled'), { once: true });
        }

        this.pending.set(id, { tool, settle });
        this.sendWaiting(this.pending.size);
        this.sendPrompt(id, tool, hint);
      });
    } catch (e) {
      this.logger.warn(`approval handler error, falling through: ${(e as Error).message}`);
      return next();
    }
  };

  /** Device A/B button decision. */
  onDeviceCommand(decision: DeviceDecision, id?: string): void {
    if (!id) {
      this.logger.warn('permission command missing id');
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger.warn(`No pending approval for id=${id}`);
      return;
    }
    pending.settle(decisionToOutcome(decision));
  }

  /** Device unpair -> cancel every pending approval (xfer.h:108-112). */
  onDeviceUnpair(): void {
    for (const p of this.pending.values()) p.settle('cancelled');
    this.pending.clear();
  }
}
