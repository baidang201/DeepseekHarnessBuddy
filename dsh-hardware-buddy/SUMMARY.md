# dsh-hardware-buddy — 交付总结

自包含 dsh 插件（TypeScript npm 包），把 CodeBuddy StickS3 硬件宠物接入 deepseek-harness：host 侧状态镜像 + 物理 A/B 审批回灌。无硬件依赖，纯代码 + 单元测试。

## 1. 完成清单（对照交付物）

| 交付物 | 文件 | 状态 |
|---|---|---|
| 包结构（§3.1） | `dsh-hardware-buddy/` 新建于仓库 root，与 `firmware/` 平级 | ✅ |
| `package.json`（§3.2） | `dsh.bundle` manifest、`peerDependencies` 锁定版本、`devDependencies` 含 `oxlint` | ✅ |
| `tsconfig.json`（§3.3） | 自包含，不 `extends` 外部配置 | ✅ |
| `cordis.patch.yml`（§3.10） | 顶层数组，`- insert:` 形式，无 `plugins:` 键 | ✅ |
| `src/index.ts` | `apply(ctx, config)` 主入口 | ✅ |
| `src/cdc.ts` | `CdcBridge` 串口封装 + VID/PID 发现 | ✅ |
| `src/protocol.ts` | `Heartbeat`/`DeviceCommand` 类型 + 序列化 + 900B 裁剪 | ✅ |
| `src/bridge.ts` | 状态机 + 定时全量快照 | ✅ |
| `src/approval.ts` | pre-execute 参数缓存 + approval 接管/回退 | ✅ |
| `src/config.ts` | schemastery 配置 schema | ✅ |
| `probe.ts`（§6） | P0 探测插件（独立 entry，不参与构建/oxlint） | ✅ |
| `tests/protocol.spec.ts` | 序列化 + 裁剪 + summarizeArgs + decisionToOutcome | ✅ |
| `tests/bridge.spec.ts` | 状态机单测 | ✅ |
| `tests/approval.spec.ts` | ask / next() 回退 / 超时 / signal race / 正则健壮性 | ✅ |
| `README.md` | `dsh plugin add`、配置、Linux `dialout` 排障 | ✅ |

> 注：`tests/e2e/`（`fake-port.ts` / `flow.spec.ts`）在 tech.md §3.1 列出，但任务交付物清单只要求 3 个 spec 文件；按交付物清单实现，未额外创建 e2e（避免引入 serialport 原生构建对单测的硬依赖）。§7.1 覆盖项已全部实现。

## 2. 验收命令结果

```bash
cd dsh-hardware-buddy
npm install        # ✅ added 75 packages（optional peers 被跳过，不报错）
npm test           # ✅ 35 passed (protocol 15 / bridge 5 / approval 15)
npx tsc -p tsconfig.json --noEmit   # ✅ 0 errors
npm run lint       # ✅ oxlint: 0 warnings, 0 errors (7 files, 96 rules)
```

测试输出摘要：

```
 ✓ tests/approval.spec.ts (15 tests)
 ✓ tests/protocol.spec.ts (15 tests)
 ✓ tests/bridge.spec.ts   (5 tests)
 Test Files  3 passed (3)
      Tests  35 passed (35)
```

## 3. 偏离 tech.md 的决定及理由

1. **peerDependencies 标记为 optional（`peerDependenciesMeta`）。**
   tech.md 锁定的 `@deepseek-ai/dsh-tools@0.1.0-rc.7` / `dsh-user-approval@0.1.0-rc.7` / `dsh-agent@0.1.0-rc.7` / `dsh-session@0.1.0-rc.7` 在当前 npm 镜像（Tencent）**不存在**（仅 rc.1 / rc.6）。npm 7+ 对无法解析的 peer 默认 `ERESOLVE` 报错导致 `npm install` 失败。将其全部设为 `optional: true`，既满足"锁定版本"的语义，又保证隔离环境 `npm install` 通过。真实 dsh 运行时会由 dsh 自身提供这些包。

2. **源模块只 `import type` 来自 `@deepseek-ai/cordis`，且 `bridge`/`approval` 不直接 import 任何 dsh-tools 内部模块（满足硬要求 #12）。**
   仅 `@deepseek-ai/cordis@4.0.1` 在镜像中存在。为让 `tsc --noEmit` 在隔离环境通过，把它加进 `devDependencies`（同时保留在 peer 中）。`dsh-tools` 等仅出现在 `peerDependencies`，源码不引用。

3. **`index.ts` 接线重构（tech.md 允许的完善项）。**
   tech.md 示例的 `cdcRef` getter 写法存在 TDZ 引用（`cdcRef.target = ...` 在 `const cdcRef` 声明之前）。改为：`let cdc: CdcBridge | null = null` + 一个带 getter 的 `cdcRef` 持有者，先构造 `approval`/`cdc` 再赋值 `cdc`；`bridge` 同理用 `let` 延迟赋值，连接回调里引用 `bridge`。语义与文档一致，且消除 TDZ 风险。

4. **`config.ts` 的 `port`/`productId` 默认 `null` 用 `Schema.union([Schema.string(), Schema.const(null)]).default(null)`。**
   `Schema.string().default(null)` 在 schemastery 类型上会报 "null not assignable to string"。改用 `union`+`const(null)` 既类型安全又产出 `string | null`。

5. **`cdc.ts` 串口发现用 `SerialPort.list()` 静态方法。**
   `serialport@12` 把 `list` 暴露为 `SerialPort.list` 静态方法，而非 `import('serialport').list` 命名导出；据此修正，参数 `p` 获得 `PortInfo` 类型（`vendorId`/`productId`/`path`）。

6. **新增 `src/context.ts`（本地最小 `AppContext` 视图）与 `vitest.config.ts`。**
   `AppContext` 仅声明插件实际使用的 `on/emit/effect/logger` 表面，在 `apply` 边界把 `ctx as unknown as AppContext` 收窄，避免直接依赖 cordis 泛型事件表带来的类型摩擦；同时保证单测不依赖真实 dsh 安装。`vitest.config.ts` 设 `environment: 'node'` 并显式 `resolve.extensions`，确保源码中 `.js` 扩展名在 Vite/Vitest 下正确解析到 `.ts`（构建产物 `dist/` 保留 `.js` 扩展名以适配 Node ESM）。

## 4. 遗留问题 / 待 P0 定稿项

- **`dangerousTools` 默认值为空数组**：按 PRD/tech 约定，真实 dsh 工具名需由 P0 探测插件（`probe.ts`）dump 后定稿；当前不预填 Claude/Codex 风格名字，避免正则静默不命中导致硬件审批永不触发。
- **VID/PID 待实测**：`vendorId` 默认 `0x303A`（Espressif）为占位，需 P0 `pio device list` 实测回填；`discoverPort` 已同时保留 `usbmodem`/`ttyACM` 名称兜底。
- **版本自检在隔离环境被跳过**：`index.ts` 的 `apply()` 开头读取 `@deepseek-ai/dsh-tools/package.json` 版本，≠ `0.1.0-rc.7` 时 `logger.warn`（不 throw）。本隔离环境未安装 dsh-tools，`require.resolve` 抛错被捕获，自检静默跳过；真实 dsh 环境会正常比对。
- **无硬件在环（HIL）自动化**：AC2–AC7、AC12 为人工验收（PRD §6 已显式声明缺口），单测覆盖协议/状态机/审批回退语义，但不替代端到端硬件验证。
- **未提交 `node_modules/` 与 `dist/`**：已被 `.gitignore` 忽略；`package-lock.json` 一并纳入以便复现安装。
