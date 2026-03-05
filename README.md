# Codex Session Manager (VS Code Extension)

在 VS Code 内可视化管理 Codex 会话：会话列表、搜索、归档、刷新、复制/执行 `resume`、provider 修改与不一致修正。

## Release 下载

- 最新 VSIX（推荐直接安装）：
  - https://github.com/bimcc/codex-session-man/releases/latest/download/codex-session-manager-vscode.vsix
- 全部版本 Release 页面：
  - https://github.com/bimcc/codex-session-man/releases

## 功能

- 加载 `~/.codex/state_5.sqlite` 中的会话
- 左侧会话列表 + 右侧详情预览（消息内容）
- 关键字搜索会话（按 id/title/cwd/首条用户消息/provider）
- 左侧一键“仅看不一致”筛选（只看 DB/File provider 不一致会话）
- 会话列表右侧高亮显示 DB/File provider 不一致（红色告警）
- 会话刷新（全局刷新 + 单条详情刷新）
- 顶部读取 `~/.codex/config.toml` provider 信息并展示
- 会话归档（移动到 `~/.codex/archived_sessions`）
- 归档列表查看与恢复到正式会话列表
- 一键复制 `codex resume <session_id>`
- 一键复制会话 ID
- 在 VS Code 终端直接执行 `resume`
- 在会话详情顶部行内编辑 provider（点击编辑后保存，同步写入 jsonl + sqlite）
- 行内判断 DB/File provider 是否一致，并支持一键修正不一致
- 按当前筛选结果批量修改 provider
- 高风险操作（批量 provider、归档、恢复）采用 VS Code 模态确认

## 命令

- `Codex Session Manager: Open`

## 配置项

- `codexSessionManager.codexHome`
  - 自定义 `CODEX_HOME`，留空默认使用 `~/.codex`

## 安装方式

可直接拖拽 `.vsix` 到 VS Code 扩展面板安装，或：

```bash
code --install-extension <path-to-vsix>
```

安装后在左侧活动栏会出现 **Codex Sessions** 图标，点击即可打开可视化界面。

## 本地调试

```bash
npm install
npm run check
```

然后在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host。

## VSIX 打包

```bash
npm run build:vsix
```

或 PowerShell 一键脚本：

```powershell
.\build-vsix.ps1
```

默认输出目录：`dist/`

## 内置依赖说明

当前版本使用 VS Code 运行时自带的 `node:sqlite`，不依赖外部 `nodePath` 或系统 SQLite CLI。
