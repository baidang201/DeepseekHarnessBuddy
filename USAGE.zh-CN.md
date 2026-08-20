# StickS3 硬件宠物 × deepseek-harness 使用手册

> 适用范围：本仓库（DeepseekHarnessBuddy）当前 main 分支；deepseek-harness 源码仓（本机 `~/Documents/GitHub.nosync/deepseek-harness`）+ 一台刷好固件的 M5Stack StickS3（USB-C 连接电脑）。
>
> 系统构成一句话：**dsh 跑任务 → 插件把状态实时画到宠物屏幕 → 危险工具弹物理审批屏 → 你按 A/B 决定放行还是拒绝**。deepseek-harness 源码零修改。

---

## 1. 五分钟快速体验

```bash
# 1. 设备插上 USB-C（屏幕没反应？先拿起设备竖一下激活屏幕，见 §6）
# 2. 进入 dsh 源码目录，带上 API key
cd ~/Documents/GitHub.nosync/deepseek-harness
export DEEPSEEK_API_KEY=<你的 key>

# 3. 跑一个会触发危险工具的任务
node apps/cli/lib/bin.js --profile headless "用 bash 工具执行 echo hello，然后告诉我输出"
```

会发生什么：

1. 任务启动 → 宠物**醒来变忙碌**（busy 动画）
2. 模型决定调 `bash` → 设备**滴一声**，屏幕弹出**审批屏**（工具名 + 命令参数）
3. **短按 A**（正面大按钮）→ 命令执行，宠物比心；**短按 B**（机身上边缘小键）→ 拒绝执行
4. 30 秒不按 → 自动拒绝（模型会收到"审批超时"）
5. 任务结束 → 宠物回 idle；累计 token 过 5 万 → 庆祝动画
6. dsh 进程退出 30 秒后 → 宠物睡觉

---

## 2. 启动方式汇总

### 2.1 标准启动（headless 单任务）

```bash
cd ~/Documents/GitHub.nosync/deepseek-harness
export DEEPSEEK_API_KEY=<key>
node apps/cli/lib/bin.js --profile headless "任务描述"
```

- 任务完成后进程自动退出（one-shot 模式），宠物随后入睡
- 默认模型 `deepseek-v4-flash`（省钱）；API key 也可写进 shell 配置文件长期生效

### 2.2 排错模式

```bash
HB_DEBUG=1 node apps/cli/lib/bin.js --profile headless "任务"
```

会在 stderr 打印插件全链路追踪：串口发现/打开、每次心跳字节数、设备回显、审批推送与决策回灌。**报 bug 时请带上这个输出**。

### 2.3 Web UI 模式（尚未配置，选读）

dsh 还有 `--profile web`（浏览器界面）。当前插件只装在了 headless profile；要在 Web 模式用硬件审批，执行一次：

```bash
node apps/cli/lib/bin.js plugin --profile web add ~/Documents/GitHub.nosync/CodeBuddy/dsh-hardware-buddy
```

之后 Web 模式下：设备在线时硬件审批优先，设备拔掉时审批自动回落到浏览器 Web UI。

---

## 3. 宠物功能全览

### 3.1 状态（自动跟随 dsh）

| 宠物状态 | 触发条件 |
|---|---|
| 💤 睡觉（zzz）| 30 秒内没有心跳（dsh 没在跑/进程退了）|
| 🙂 待机 idle | dsh 在跑但没有活动任务 |
| 🔥 忙碌 busy | agent 正在跑（`agent/status: running`）|
| ⚠️ 审批 attention | 有工具在等你按按钮（屏幕显示工具名 + 参数摘要）|
| 🎉 庆祝 celebrate | 累计 token 超过阈值（默认 5 万，可配）或任务快速获批（<5 秒按 A 会比心 ❤️）|
| 😵 头晕 dizzy | **甩一甩设备** |
| ❤️ 比心 | 审批 5 秒内按下 A |

另有原版彩蛋保留：周五下午宠物会自发庆祝。

### 3.2 按键操作

| 操作 | 审批屏显示时 | 平时 |
|---|---|---|
| **A 短按**（<0.6 秒，正面大键）| ✅ 放行（`once`）| 切换显示模式（宠物视图 ↔ 信息页）|
| **A 长按**（≥0.6 秒）| 菜单（不会误放行）| 打开主菜单（设置/WiFi/OTA 等 6 项）|
| **B 短按**（机身上边缘小键）| ❌ 拒绝（`deny`）| 菜单内返回/取消 |
| **甩动** | — | 头晕动画 2 秒 |

⚠️ 最常见的误操作：想放行却**长按**了 A——长按是菜单键，审批不会响应。听到滴声后**短按**即可。

### 3.3 屏幕与横竖屏

- 设备会**自动横竖屏**：竖着拿是宠物+状态，横过来是仪表盘视图（token/事件列表更全）
- 插着 USB 不动时显示**充电时钟**（需要时间：给设备配 WiFi 走 NTP，见 §3.4）
- 设置菜单里可以换宠物（18 个 ASCII 角色）和开关 LED 等

### 3.4 设置菜单（A 长按进入）

- **WiFi 配置**：配网后设备用 NTP 对时（时钟功能需要）；也是未来 WiFi OTA 的前提
- **OTA 更新**：沿用原信任链（当前构建内嵌开发信任材料，日常 USB 使用不受影响；要启用 OTA 推送需重新做正式信任引导，见 Backlog）
- **宠物选择 / LED / auto OTA** 等原版选项保留

### 3.5 拔插行为

- 任务跑着拔掉 USB → 插件不崩溃，dsh 照常跑（审批自动回落）；插回后 5 秒内恢复心跳，宠物醒来
- 设备不在时跑任务：危险工具会被 dsh 以"无可用审批通道"拒绝（这是设计行为——没有人在场就不该放行 shell）

---

## 4. 配置调节

配置文件：`~/.dsh/profiles/headless/cordis.patch.yml`（改完即时生效，无需重装）：

```yaml
- id: hardware-buddy
  config:
    port: null                # 指定串口；null = 按 VID 自动发现
    vendorId: '0x303A'
    approvalTimeout: 30000    # 审批超时（毫秒）
    heartbeatIntervalMs: 3000 # 心跳间隔（须远小于设备 30s 窗口）
    celebrateThreshold: 50000 # 庆祝阈值（累计 token）
    dangerousTools:           # 走硬件审批的工具（正则，实测 25 个工具全小写）
      - '^bash$'
      - '^write$'
      - '^edit$'
      - '^str_replace_editor$'
    excludedTools:            # 不走硬件、回落 Web UI 的工具（正则）
      - '^MCP__danger_.*'
    entriesLimit: 5           # 屏幕事件列表条数
```

常用改法：

- **想更安全**：把 `^web_search$`、`^skill$` 也加进 `dangerousTools`
- **嫌审批烦**：从 `dangerousTools` 里删掉 `^edit$`（编辑类放行）
- **庆祝更频繁**：`celebrateThreshold: 5000`

---

## 5. 故障排查

| 症状 | 原因与解法 |
|---|---|
| 屏幕一直定格（开机后没反应）| 上游防误画设计：开机后**把设备拿起来竖一下**即激活；之后平放也正常 |
| 听到滴声但没看到审批屏 | 已修复（v30f6de4 后不存在）；若复现，用 `HB_DEBUG=1` 跑并检查 `prompt=` 是否持续出现在回显里 |
| dsh 报 `QUOTA: Insufficient Balance` | API key 余额不足，充值 |
| 宠物一直睡觉 | dsh 进程没在跑（心跳 30 秒断即睡）；确认任务还活着 |
| `No StickS3 CDC port found` | 串口没发现：换线/换口；Linux 需 `sudo usermod -aG dialout $USER` 后重新登录 |
| 想看插件在干什么 | `HB_DEBUG=1` 启动（§2.2）|
| 心跳乱了/丢行 | 已修复（CDC 缓冲 1024B）；若复现请提交 issue 附 HB_DEBUG 日志 |

---

## 6. 已知限制（诚实清单）

- **配额显示（5h/7天）未接入**：协议字段在，但 DeepSeek 侧数据源未定（Backlog stretch）
- **设备时间同步**：插件未发 `time` 字段；时钟依赖 WiFi/NTP（§3.4 配网）
- **OTA 推送流程**：开发信任链构建，真机 OTA 推送需正式信任引导（Backlog）
- **多设备/多实例**：单设备单进程假设（Backlog）
- **Windows**：不支持（macOS 主力，Linux 可用）

---

## 7. 日常一句话

> 插上 USB → `dsh --profile headless "干活"` → 宠物替你盯着 → 滴声响起看一眼屏幕 → A 放行 / B 拒绝。
