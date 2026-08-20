# P0 探测报告（部分）— 真机实测数据

日期：2026-08-20 ｜ 环境：macOS（M 系列）、StickS3 × 1（USB-C 直连）

## 1. USB VID/PID（实测，`pio device list` + `system_profiler SPUSBDataType`）

|项|值|
|---|---|
|VID|`0x303A`（Espressif）|
|PID|`0x1001`（USB JTAG/serial debug unit，即 USB-Serial/JTAG 模式）|
|串口|`/dev/cu.usbmodem14401`（macOS）|
|序列号|`14:C1:9F:D5:C9:40`|

> 结论：`ARDUINO_USB_MODE=1`（USB-Serial/JTAG 外设）下 PID 为 **0x1001**。tech.md 早期版本（v1.1）声称的 0x4001 是 TinyUSB CDC 模式的 PID，不适用本配置。插件 `config.ts` 默认 `vendorId: '0x303A'` 有效；如需更精确可将 `productId` 默认值设为 `'0x1001'`。

## 2. 固件冒烟（P1 合并版 e516ce4，直接 esptool 刷写）

|检查|结果|
|---|---|
|CDC 枚举|✅ 刷写后立即枚举， VID/PID 同上|
|**无 BLE 构建 30s 回滚风险**|✅ 设备连续运行 >10 分钟无回滚（OTA/BLE 解耦生效）|
|心跳解析（host→device）|✅ `_applyJson` 全路径工作：`[data] snapshot total=.. running=.. waiting=.. prompt=.. msg=..` 逐字段回显|
|审批屏触发|✅ `prompt` 字段触发 `[prompt] show id=t-003 tool=Bash mode=0` + 蜂鸣 + 唤屏|
|token/usage 字段下发|✅ tokens/tokens_today 下发无解析错误|
|设备→host 串口日志通道|✅ 同口日志正常回传|
|idle→busy→attention→celebrate 状态切换|✅（屏幕侧，肉眼确认）|
|A 键 → `{"cmd":"permission",...,"decision":"once"}`|✅ 三次实证（t-004 / t-002 / t-005）；注意 A 键需**短按 <600ms**，长按是菜单键|
|B 键 → `{"cmd":"permission",...,"decision":"deny"}`|✅ 实证（t-005）；B 键在机身上边缘，非正面大键|
|shake → dizzy 日志|⏳ 未触发（窗口内无人摇动；代码路径与按键同源，风险低）|

## 3. dsh 真机集成（2026-08-20 补充）

环境：本机 deepseek-harness 源码仓（`node apps/cli/lib/bin.js`）、`headless` profile（`dsh plugin add` 本地 link 安装）、DEEPSEEK_API_KEY。

### 3.1 真实工具清单（25 个，来自 request/header 事件，全小写）

`bash` `create_goal` `edit` `exit_plan_mode` `get_goal` `glob` `grep` `interrupt_agent` `job_kill` `job_list` `job_output` `list_agents` `ralph` `read` `read_image` `send_message` `skill` `str_replace_editor` `subagent` `subagent_fork` `todo_write` `update_goal` `web_search` `workflow` `write`

**dangerousTools 默认值定稿**：`^bash$` `^write$` `^edit$` `^str_replace_editor$`（写入/执行类）。v1.1 文档预填的 `Bash/Edit/Write`（首字母大写）不会命中任何真实工具名。

### 3.2 集成中发现并修复的 bug

|bug|症状|修复|
|---|---|---|
|macOS `tty.`/`cu.` 陷阱|`SerialPort.list()` 返回 `/dev/tty.usbmodem*`；打开 tty.* 会永久等待 DCD，open 静默挂起|`withCuPath()`：darwin 上映射为 `/dev/cu.*`|
|open 竞态|`port.on('open')` 触发连接回调 → 立即 flush，但 `this.port` 在 `await open` 之后才赋值，首条心跳被 send() 静默丢弃|`this.port/parser` 赋值挪到 `port.open()` 之前|
|插件日志不可见|dsh headless 抑制插件 logger 输出，info/warn 全部沉默|新增 `src/debug.ts`：`HB_DEBUG=1` 时 stderr 输出 CDC 生命周期追踪|

### 3.3 已验证（真实 dsh 进程内）

- 插件经 `dsh plugin add` 进入 profile 层栈，`--dump-config` 确认配置默认值生效（**dsh 源码零修改**）
- `apply()` 执行、VID/PID 发现（303a:1001）、串口打开
- **心跳双向闭环**：dsh 事件（`session/created` → total=1、`agent/status` → running=1）→ 插件心跳 → 设备解析 → 设备回显 `[data] snapshot total=1 running=1` → 插件接收
- 断连文案 `"No DSH host"` 在运行间隔超时后生效（回显中可见）
- `npm test` 35/35 保持全绿（修复后）

### 3.4 当前阻塞

- **AC4 全链路**（工具触发 → 设备审批 → A/B 决策 → dsh 继续）：被 `QUOTA: Insufficient Balance` 阻塞，需给 DeepSeek API key 充值后重跑
- 设备屏幕渲染（IMU 方向解析门控）问题独立跟踪中，不影响协议链路

## 4. 待完成 P0 项（需真实 dsh 环境）

- [ ] runtime probe（`probe.ts`）：事件 payload 样例留档
- [ ] 真实工具名清单 dump → 定稿 `dangerousTools` 默认正则
- [ ] `npm test` 在真实 dsh profile 中的插件加载验证（HMR / inject 行为）
