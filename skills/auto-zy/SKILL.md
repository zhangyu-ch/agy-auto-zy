---
name: auto-zy
description: 查看或切换 Auto-ZY 权限自动审核模式（auto-zy / auto-workspace-zy / off），查询 Codex Guardian 审核记录与本机 Magpie ds-flash (max) 状态。
---

# Auto-ZY 权限自动审核管理

当用户希望查看或切换权限自动审核模式（`auto-zy`、`auto-workspace-zy`、`off`）、查询最近自动审核裁决记录或测试本机 Magpie `group/ds-flash` (`max` 思考) 连通性时，运行已安装插件目录中的 CLI 工具：

```powershell
node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" show
```

## 常用子命令

- 查看当前生效配置、Magpie 状态与统计计数：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" show`
- 切换为全面自动审核模式（Codex Guardian 全域审核，含跨目录）：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" mode auto-zy`
- 切换为工作区自动审核模式（工作区内自动审核，跨目录与敏感路径回退 `ask` 人工确认）：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" mode auto-workspace-zy`
- 暂停自动审核（交由原生 Local Permissions 处理）：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" mode off`
- 查看最近 15 条审核裁决明细：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" logs 15`
- 查看内置 Codex Guardian 策略规则摘要：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" defaults`
- 实测本机 Magpie `group/ds-flash` (`max`) 模型裁决：
  `node "$HOME/.gemini/config/plugins/agy-auto-zy/scripts/cli.mjs" test`
