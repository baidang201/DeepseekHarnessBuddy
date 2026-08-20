// Shared, host-agnostic view of the Cordis context surface this plugin uses.
//
// We intentionally keep this minimal and local: the real `@deepseek-ai/cordis`
// `Context` type is brought in only via `import type` (see index.ts), and the
// runtime object is narrowed to `AppContext` at the plugin boundary. This keeps
// the plugin decoupled from dsh-tools internals so the unit tests do not need a
// real dsh install.

import type { Context } from '@deepseek-ai/cordis';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
  trace: (msg: string) => void;
}

export interface AppContext {
  on(
    event: string,
    listener: (...args: any[]) => any,
    options?: { prepend?: boolean },
  ): () => void;
  emit(event: string, ...args: any[]): void;
  effect(fn: (...args: any[]) => any): void;
  logger(name: string): Logger;
}

export type { Context };
