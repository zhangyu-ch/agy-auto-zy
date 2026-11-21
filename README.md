<div align="center">
  <img src="assets/logo.svg" width="72" height="72" alt="Agy Auto-ZY Logo" />
  <h1>Agy Auto-ZY Permissions</h1>
  <p><strong>Antigravity 2.0 权限自动审核插件（Codex Guardian 策略 + 本机 Magpie DS-Flash Max 思考）</strong></p>
  <p>
    <a href="https://github.com/zhangyu-ch/agy-auto-zy/actions/workflows/ci.yml"><img src="https://github.com/zhangyu-ch/agy-auto-zy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-16a34a" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933" alt="Node.js >= 22.13" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-475569" alt="Platform" />
  </p>
</div>

## 简介

**Agy Auto-ZY** 是面向 Google Antigravity 2.0 的本地权限自动审核插件，完整移植自 [`@mzwing/pi-permission-auto-review`](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review)（OpenAI Codex Guardian 安全审核策略）与 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system)（工作区委托边界机制）。

启用后，插件在聊天输入框底部 **`Local Permissions` 按钮正左侧**新增一个独立的模式切换按钮，并通过官方 `PreToolUse` / `PreInvocation` 生命周期钩子接入本机 [Magpie](https://usemagpie.ai) 的 `group/ds-flash`（`reasoning_effort: "max"`）模型实时评估每一次工具调用：

| 模式 | 对应策略 | 行为说明 |
| --- | --- | --- |
| **`auto-zy`** *(默认)* | `delegationMode: "auto-review"` | **全面自动审核模式**：工作区内命令与跨目录操作统一交由 Codex Guardian 策略与 `ds-flash (max)` 评估；安全且符合用户授权意图的操作自动放行（`allow`），敏感数据外泄/未授权破坏立即拦截（`deny`），超时或异常回退人工确认（`ask`）。 |
| **`auto-workspace-zy`** | `delegationMode: "workspace"` | **工作区边界审核模式**：工作区内命令自动审核；凡涉及跨工作区目录（`external_directory`，不含无落盘纯参数 `nothing-on-disk` 特例）或敏感路径（`.env*`、`~/.ssh/*`、私钥凭证等 `path` 规则）的放行结果强制封顶降级为 `ask` 弹窗由人工确认，高危直接 `deny`。 |
| **`Off`** | 原生透传 | 暂停自动审核钩子（返回 `{}`），完全遵循右侧原生 `Local Permissions` 设置。 |

## 核心特性

1. **原汁原味 Codex Guardian 安全策略**：内置风险四级分类（`low` / `medium` / `high` / `critical`）与可信授权溯源（仅采信 `transcript.jsonl` 中的 `USER_INPUT` 与结构化 `ask_question` 回答），自动拦截凭证探测、敏感外传、安全降级与越权破坏，并对自相矛盾的模型输出做严格校验。
2. **会话增量续审与服务端缓存命中**：携带会话亲和头（`session_id` / `x-session-affinity`）并支持 `followUpReviews: "auto"` 增量发送 `TRANSCRIPT DELTA JSONL`，实测高频复用服务端上下文缓存。
3. **连续拒绝熔断保护（`DenialCircuitBreaker`）**：单轮内连续拒绝 `3` 次或最近 `50` 次内累计拒绝 `10` 次自动熔断阻断重试，下一轮对话开始（`PreInvocation`）自动重置。
4. **多入口实时同步**：支持底部左侧悬浮菜单、右侧官方辅助面板（Aux Pane **Auto-ZY 权限审核**）、`/auto-zy` 斜杠技能及 CLI 命令行实时查看放行/拦截/询问统计与最近裁决理由。
5. **无损安全安装**：零第三方 npm 依赖，纯文件 SHA-256 校验同步，绝不修改 `~/.gemini/config/config.json` 或客户端文件，与 `Agy Powertools`、`Agy Thinking Translator` 零冲突共存。

## 环境要求

- Antigravity 2.0 桌面客户端（或 Antigravity CLI）
- Node.js `>= 22.13`
- 本机运行 [Magpie](https://usemagpie.ai) 网关（默认自动发现 `http://127.0.0.1:3425/v1`，模型 `group/ds-flash`，思考等级 `max`）

## 安装与卸载

### 方式一：复制提示词交给 Agent 自动安装（推荐）

将以下提示词直接发送给 Antigravity 或其他本地 Agent：

> 请帮我安装 Agy Auto-ZY 权限自动审核插件：https://github.com/zhangyu-ch/agy-auto-zy 。先阅读 README.md 和 docs/INSTALL_AGENT.md，使用项目自带的 install.ps1（或 install.sh）完成安装，保留已有插件、账户配置与聊天记录，不要强制退出当前客户端，安装后验证运行状态并告诉我结果。

详细步骤参阅 [Agent 自动安装指南](docs/INSTALL_AGENT.md)。

### 方式二：命令行手动安装

Windows (PowerShell)：

```powershell
git clone https://github.com/zhangyu-ch/agy-auto-zy.git
cd agy-auto-zy
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux：

```sh
git clone https://github.com/zhangyu-ch/agy-auto-zy.git
cd agy-auto-zy
sh ./install.sh
```

### 卸载

Windows (PowerShell)：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

macOS / Linux：

```sh
sh ./uninstall.sh
```

如需保留个人配置与历史审核日志，可在命令末尾附加 `--keep-settings`。

## 命令行与配置项

可通过内置 CLI 或聊天中的 `/auto-zy` 技能随时管理：

```powershell
# 查看当前配置、Magpie 状态与统计计数
node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" show

# 切换模式 (auto-zy | auto-workspace-zy | off)
node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" mode auto-workspace-zy

# 查看最近 15 条审核记录
node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" logs 15

# 实测本机 Magpie ds-flash (max) 连通性与裁决耗时
node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" test
```

配置文件持久化于 `~/.gemini/antigravity/plugin_data/agy-auto-zy/settings.json`：

| 字段名 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `"auto-zy"` | 全局审核模式：`auto-zy` / `auto-workspace-zy` / `off` |
| `workspaceModes` | `{}` | 按工作区路径覆盖模式映射 |
| `baseUrl` | `"http://127.0.0.1:3425/v1"` | 自动从 `~/.config/magpie/gateway.json` 或 `~/.pi/agent/models.json` 发现 |
| `model` | `"group/ds-flash"` | 审核模型 ID（兼容 `magpie/` 前缀） |
| `reasoning` | `"max"` | 思考强度：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `timeoutMs` | `90000` | 单次审核含重试总超时预算（毫秒） |
| `maxRetries` | `2` | 瞬时网络异常或格式校验失败最大重试次数 |
| `followUpReviews` | `"auto"` | 会话增量续审策略：`auto` / `always` / `off` |
| `autoMode` | `{"environment":["$defaults"],...}` | 自定义操作员规则（`environment` / `allow` / `soft_deny` / `hard_deny`） |

## 开发与测试

```bash
node --test test/plugin.test.mjs
```

## 开源协议

基于 [MIT License](LICENSE) 开源。
