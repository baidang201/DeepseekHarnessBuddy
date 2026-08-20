# 📄 第二期 PRD｜StickS3 × deepseek-harness 硬件宠物

> **文档版本**：v2.0-draft（2026-08-20）
> **基线**：一期已交付（main 分支，`USAGE.zh-CN.md` 为当前使用形态；验收记录见 `dsh-hardware-buddy/probe-report.md`）
> **硬件/架构**：不变（StickS3 + USB CDC 单通道 + dsh 插件，deepseek-harness 源码继续零修改）

---

## 1. 一期成果摘要（为什么二期是这些）

一期交付了完整可用的核心闭环：Web 版 dsh 实时状态镜像、A/B 物理审批（双向 live 验证）、超时/离线/excluded 三条回退路径、celebrate 与 token 统计。过程中修复并验证了 7 个真实缺陷（含 256B CDC FIFO、状态式 prompt 协议语义等），25 个真实工具名已定稿进默认配置。

一期**有意留下**的缺口即二期范围：配额显示无数据源、完成提示音未接、token 不持久、设备时钟无来源、Web UI 看不到设备在线状态、多实例会抢串口、品牌仍是 Codex。

## 2. 二期目标

**从「能用」到「日常顺手」。** 三条工作线：

| 线 | 内容 | 判断标准 |
|---|---|---|
| A 体验补全 | 配额显示、完成提示音、时间同步、token 持久化、Web UI 设备状态 | 离开浏览器也能凭设备感知 dsh 全部关键状态 |
| B 工程健壮性 | 多实例串口锁、多设备消歧、冷启动屏幕激活、HIL 冒烟 | 双开不互抢、拔插不丢行、回归有自动化兜底 |
| C 品牌统一 | Codex → DeepSeek Harness 字样清理、Python 旧 host 归档 | 交付物中不再出现 Codex 品牌 |

## 3. 用户场景（新增）

| 场景 | 触发 | 期望 |
|---|---|---|
| **S7 余额预警** | DeepSeek 账户余额/用量临近限额 | 设备状态屏显示配额条（`usage` 字段），低余额转 attention 提醒 |
| **S8 完成提示音** | 一个 turn 跑完（长任务结束）| 设备播放完成音（原版 chime），多 agent 并发不连响 |
| **S9 Web 状态徽标** | 打开浏览器 Web UI | 界面上可见硬件宠物在线/离线状态（离线时提示审批将走浏览器）|
| **S10 跨日统计** | 第二天继续使用 | `tokens_today` 按自然日归零；celebrate 阈值每日重置 |
| **S11 双开** | 误开两个 dsh 实例（web+headless）| 后者明确提示"设备已被占用"并静默退位，不刷错误日志 |
| **S12 开机即显示** | 设备冷启动平放桌面 | N 秒后回退默认竖屏渲染，不再需要"拿起激活" |

## 4. 功能需求

> 优先级：🔴 本期必做 ｜ 🟡 本期尽量 ｜ ⚪ stretch

### FR1（🔴）配额数据源接入与显示
- 调研 DeepSeek 开放平台可查询接口（余额/用量/限额），确定可用数据
- 字段语义决策：若存在 5 小时滚动窗口则沿用 `five_hour_remaining/seven_day_remaining`；若只有余额则新增 `usage.balance_remaining` 并适配设备端显示
- 轮询刷新（默认 15 分钟）、失败静默降级为"不显示"，绝不影响心跳

### FR2（🔴）完成提示音（turn chime）
- 一个 turn 结束（`session/event: turn/end`）时，心跳携带递增的 `completion_seq`
- 固件已有音效路径（`completionChimeObserve`，main.cpp:2251），**零固件改动**
- 配置：开关 + 最小间隔（防多 agent 并发连响）

### FR3（🔴）token 持久化
- 跨进程/跨日：落盘 `$DSH_HOME` 下状态文件；`tokens_today` 恢复自然日语义；celebrate 每日重置
- 写入 debounce（如 30s），进程崩溃最多丢 30s 计数

### FR4（🟡）Web UI 设备状态徽标
- 消费一期预留的 `hardware-buddy/connection-changed` 事件
- ⚠️ 前置调研：web-app 是否提供浏览器侧扩展点（browser-purity 插件）。**若无合法扩展点，降级为"事件已发出 + 文档说明"，不为此修改 dsh 源码**

### FR5（🟡）设备时间同步
- 心跳低频携带 `time:[epoch, tz]`（协议已支持，data.h:193 起解析并校验）
- 解决"不配 WiFi 时钟不对"问题；NTP 路径保留共存

### FR6（🔴）多实例串口锁
- `$DSH_HOME` 下 PID 锁文件：第二个实例识别后**静默退位**（不接管设备、审批走 Web UI），并一次性提示
- 覆盖误开 web+headless 双实例的真实场景

### FR7（🟡）多设备 serialNumber 消歧
- 配置新增可选 `serialNumber`，精确锁定某一台设备

### FR8（🔴）品牌清理
- 固件：蓝牙名 `Codex-*`（main.cpp）、设置/信息屏与注释残留文案
- 文档：README/REFERENCE 措辞
- **Python 旧 host（`src/codex_buddy/` + 32 个 pytest）归档决策**：建议删除（git 历史可追溯），README 标注演进说明

### FR9（🟡）冷启动竖屏回退
- 固件：方向解析 N 秒（默认 8s）无稳定姿态时回退默认竖屏并记住，消除"开机必须拿一下"
- 宏开关可配，保留上游严格模式

### FR10（🔴）补验收 + HIL 雏形
- 补齐 AC5（拔插重连）、AC8（HMR 配置热更）的正式验收记录
- HIL 冒烟脚本：模拟 host 发心跳/审批并断言设备回包（可进 CI 自托管 runner，先手动触发）

### FR11（⚪）stretch（不承诺）
- Windows 支持（`COM*` 枚举）
- WebSocket 远程通道（设备脱离 USB 线）

## 5. 非功能需求

|ID|需求|
|---|---|
|NFR-P2-1|零 dsh 源码修改原则继续维持（FR4 若冲突则降级）|
|NFR-P2-2|新增网络调用（配额查询）必须有超时与失败降级，不阻塞心跳主循环|
|NFR-P2-3|持久化文件损坏时可自动重置，不 crash|
|NFR-P2-4|所有新配置进 schemastery schema 并入 README/USAGE 文档|
|NFR-P2-5|单测覆盖：completion_seq 生成/去重、自然日翻转、锁竞争、serialNumber 匹配|

## 6. 验收标准

|#|用例|通过条件|
|---|---|---|
|AC-P2-1|配额显示|接入数据源后设备状态屏出现配额条；接口失败时屏显优雅降级|
|AC-P2-2|完成提示音|长任务 turn 结束设备响一声；两个 agent 并发结束只响一声（间隔内合并）|
|AC-P2-3|跨日持久化|重启 dsh/跨自然日，`tokens_today` 正确归零、总累计保留|
|AC-P2-4|双开退位|web+headless 同时启动，后者日志一次性提示且不刷屏；拔插后先到者恢复接管|
|AC-P2-5|时间同步|不配 WiFi 时钟正确显示本地时间（±1 分钟）|
|AC-P2-6|冷启动显示|平放冷启动 ≤10 秒内开始渲染，无需拿起|
|AC-P2-7|品牌|固件与文档 grep 无 Codex 品牌残留（注释除外需评审）；Python host 已归档|
|AC-P2-8|HIL|冒烟脚本一键跑通（心跳→审批→A/B 断言），结果可导出报告|

## 7. 里程碑（总计约 7 个工作日 + 1 buffer）

|Phase|内容|工期|可远程分包|
|---|---|---|---|
|P2-0|配额 API 调研 + web-app 扩展点调研（FR1/FR4 前置）|0.5d|本地|
|P2-1|体验包：FR2 提示音 + FR3 持久化 + FR5 时间同步|2d|插件包可指派远程|
|P2-2|健壮性包：FR6 锁 + FR7 消歧 + FR9 冷启动回退|2d|插件+固件各一包|
|P2-3|品牌包：FR8 清理 + Python host 归档|1.5d|固件包可指派远程|
|P2-4|配额接入（依赖 P2-0 结论）+ FR10 补验收与 HIL|1d|—|

## 8. 非目标

- 不恢复 BLE / 不做无线化（WebSocket 为 stretch）
- 不修改 deepseek-harness / web-app 源码（FR4 冲突时降级）
- 不做多宠物/新动画系统
- 不做正式 OTA server（正式信任引导列入三期）

## 9. 风险

|风险|对策|
|---|---|
|DeepSeek 无公开余额/用量接口|FR1 降级：本地按 token 计数折算"自估额度"，字段语义标注 approximate|
|web-app 无浏览器侧扩展点|FR4 降级为事件 + 文档（已预案）|
|持久化与 HMR 热重载交互（重复加载双写）|状态模块单例化 + 文件锁|
|删除 Python host 影响未知使用方|归档前 grep 引用并确认无 CI 依赖|
