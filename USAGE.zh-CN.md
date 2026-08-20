# StickS3 硬件宠物 × deepseek-harness 使用手册（Web 版）

> 适用范围：本仓库（DeepseekHarnessBuddy）main 分支；deepseek-harness（本机 `~/Documents/GitHub.nosync/deepseek-harness` 源码或 npm 包 `@deepseek-ai/dsh`）+ 一台刷好固件的 M5Stack StickS3（USB-C 连电脑）。
>
> 一句话：**浏览器里用 dsh 干活，宠物屏幕实时反映状态；危险工具在设备上滴一声等你按 A/B**。deepseek-harness 源码零修改。

---

## 1. 启动（日常唯一入口）

```bash
cd ~/Documents/GitHub.nosync/deepseek-harness
export DEEPSEEK_API_KEY=<你的 key>
node apps/cli/lib/bin.js web
```

看到 `dsh web: http://127.0.0.1:3080` 后，**浏览器打开这个地址**，界面里正常发任务即可。

等价写法（用 npm 发布版，不依赖源码仓，两者共用同一套配置和设备）：

```bash
npx @deepseek-ai/dsh web
```

启动后设备侧自动发生：插件发现串口（按 VID 0x303A）→ 打开 → 每 3 秒心跳 → 宠物醒来进入 idle。

排错模式（打印串口/心跳/审批全链路到 stderr，报 bug 必带）：

```bash
HB_DEBUG=1 node apps/cli/lib/bin.js web
```

停止：终端 Ctrl-C。进程停了 30 秒后宠物会睡着（正常）。

---

## 2. 第一次上手：5 分钟体验全流程

1. **开机激活屏幕**：设备刚上电时如果屏幕定格不动，把它**拿起来竖一下**（方向感应需要一次明确姿态），之后平放也正常显示
2. 浏览器发任务：*「用 bash 执行 echo hi，然后告诉我结果」*
3. 宠物变 🔥 **忙碌** → 模型调 `bash` → 设备**滴一声** + 弹出**审批屏**（工具名 + 命令参数，持续显示直到你按键）
4. **A 短按**（正面大键）放行 / **B**（机身上边缘小键）拒绝 / 30 秒不按自动拒
5. 放行成功且 5 秒内按键 → 宠物 ❤️ 比心；任务结束回 idle
6. **拔线实验**：任务中途拔掉 USB → 下一次审批自动弹在**浏览器里**（Web UI 接管）；插回 5 秒内恢复，审批又回到设备

---

## 3. 宠物功能对照表

### 3.1 状态（自动跟随 dsh，无需操作）

| 状态 | 触发 |
|---|---|
| 💤 睡觉 | 30 秒无心跳（web 进程停了/设备拔了）|
| 🙂 待机 | web 在跑、无活动任务 |
| 🔥 忙碌 | agent 正在执行 |
| ⚠️ 审批等待 | 有工具在等你按键（屏显工具名+参数）|
| 🎉 庆祝 | 累计 token 过阈值（默认 5 万）|
| ❤️ 比心 | 审批 5 秒内按了 A |
| 😵 头晕 | 甩一甩设备（彩蛋）|

另有原版彩蛋：周五下午宠物自发庆祝。

### 3.2 按键

| 操作 | 审批屏时 | 平时 |
|---|---|---|
| **A 短按**（<0.6s，正面大键）| ✅ 放行 | 切换显示模式 |
| **A 长按**（≥0.6s）| 菜单（不会误放行）| 主菜单（设置/WiFi/OTA 等 6 项）|
| **B 短按**（上边缘小键）| ❌ 拒绝 | 菜单内返回/取消 |
| **✋ 画圆**（屏幕面画圈，1s 内）| ✅ 放行（与 A 同效）| — |
| **❌ 画 X**（屏幕面上两道斜线）| ❌ 拒绝（与 B 同效）| — |
| 甩动 | — | 头晕 2 秒 |

⚠️ 最常见误操作：想放行却**长按**了 A（长按是菜单）。听到滴声后**短按**，或**在屏幕面上画一个圆**。

手势细节（已真机验证）：固件会**自动适配握持方向**——竖直握持（重力在 Y 轴）用屏幕面 XZ 坐标系（X 左右、Z 前后），平放桌面用 XY（都在桌面上）。平放但设备完全静止会被抑制（不会被误触）。识别成功有 1.5 秒锁定窗，防重复触发。

### 3.3 屏幕形态

- **竖拿**：宠物 + 状态文字；**横拿**：仪表盘视图（token、事件列表更全）——自动旋转
- **插着 USB 不动**：充电时钟（需要对时：A 长按进菜单 → WiFi 配网，设备走 NTP）
- **设置菜单**：可换 18 个 ASCII 宠物角色、LED 开关、WiFi、OTA 等

### 3.4 设备离线/拔插行为

- 拔掉 → 插件不崩溃、web 照常跑，审批回落到浏览器弹窗；插回 5 秒内恢复
- 设备不在时跑危险工具 → dsh 以「无可用审批通道」拒绝（设计行为：没人在场不放行 shell）

---

## 4. 配置调节（改完即时生效，不用重启）

配置文件（**web 和 headless 各一份，保持一致**）：

```
~/.dsh/profiles/web/cordis.patch.yml      ← Web 版用这份
~/.dsh/profiles/headless/cordis.patch.yml ← 单任务模式用这份
```

```yaml
- id: hardware-buddy
  config:
    port: null                # 指定串口；null = 自动发现
    vendorId: '0x303A'
    approvalTimeout: 30000    # 审批超时（毫秒）
    heartbeatIntervalMs: 3000 # 心跳间隔
    celebrateThreshold: 50000 # 庆祝阈值（累计 token）
    dangerousTools:           # 走硬件审批的工具（正则；实测 25 个工具全小写）
      - '^bash$'
      - '^write$'
      - '^edit$'
      - '^str_replace_editor$'
    excludedTools:            # 不走硬件、由浏览器审批的工具
      - '^MCP__danger_.*'
    entriesLimit: 5           # 屏幕事件条数
```

常用改法：

- **更安全**：`dangerousTools` 加 `^web_search$`、`^skill$`
- **嫌烦**：从 `dangerousTools` 删 `^edit$`
- **庆祝更频繁**：`celebrateThreshold: 5000`

⚠️ **web 和 headless 不要同时跑**（抢串口）。

---

## 5. 单任务模式（脚本用，选读）

```bash
node apps/cli/lib/bin.js --profile headless "任务描述"   # 一次性跑完退出
```

适合自动化、CI、验收脚本；日常体验用 Web 版。

---

## 6. 故障排查

| 症状 | 解法 |
|---|---|
| 屏幕定格不动 | 开机后拿起设备竖一下（§2.1）；一次即激活 |
| 听到滴声没看到审批屏 | 已修复；若复现，`HB_DEBUG=1` 跑并看回显里 `prompt=` 是否持续 |
| `QUOTA: Insufficient Balance` | API key 余额不足 |
| 宠物一直睡 | web 进程没在跑（30 秒断心跳即睡）|
| `No StickS3 CDC port found` | 换线/换 USB 口；Linux 需 `sudo usermod -aG dialout $USER` 重新登录 |
| 心跳丢行/画面错乱 | 已修复（CDC 缓冲 1024B）；复现请附 `HB_DEBUG=1` 日志提 issue |
| web 和设备都卡 | 确认没有两个 dsh 进程同时跑：`pkill -f "profile headless"` |

---

## 7. 已知限制

- 配额显示（5 小时/7 天进度条）未接入（第二期规划中）
- 设备时钟依赖 WiFi/NTP 配网（插件暂不发 time 字段，第二期）
- OTA 推送为开发信任链（第二期做正式信任引导）
- 单设备单进程；Windows 不支持

---

## 8. 一句话总结

> 起 web → 开浏览器 → 正常干活 → 滴声看设备 → **A 放行 / B 拒绝** → 拔线了浏览器接管审批。
