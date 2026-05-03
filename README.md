# Obsidian Sliver

轻量、全功能、全平台的 AI Agent 插件——通过自然语言对话管理你的 Obsidian Vault。

- **轻量** — 纯 TypeScript 实现，零外部服务依赖，安装即用
- **全功能** — 读写搜删、权限管控、技能扩展、思维链、上下文压缩，样样不缺
- **全平台** — 桌面端（Windows / macOS / Linux）和移动端（iOS / Android）均可使用

接入任意 OpenAI 兼容 API（DeepSeek、OpenAI、Ollama 等），即可获得一个能直接操作文件的智能助手。

连接到任何 OpenAI 兼容的 API（DeepSeek、OpenAI、Ollama 等），赋予 AI 直接操作文件的能力，同时提供细粒度的权限控制。

## 功能特性

### 核心能力
- **文件操作** — 读取、创建、编辑、删除、列出和搜索 Vault 中的文件
- **流式响应** — 实时逐字显示 AI 回复
- **思维链 (Thinking Mode)** — 显示模型的推理过程（支持 DeepSeek 等模型）
- **工具调用** — AI 自动选择和调用合适的工具来完成复杂任务
- **上下文压缩** — 长对话自动压缩，避免超出 token 限制

### 权限控制
- **全局模式** — 只读 / 写入前询问 / 完全访问
- **路径规则** — 针对特定目录设置不同权限级别
- **操作确认** — 敏感操作（写入、删除）可弹出确认对话框

### 技能系统
内置技能为 AI 提供 Obsidian 特有格式的专业知识：
- **Obsidian Markdown** — Wikilinks、嵌入、Callouts、Frontmatter 等
- **JSON Canvas** — 创建和编辑 .canvas 白板文件
- **Obsidian Bases** — 创建和编辑 .base 数据库文件
- **Vault Q&A** — 从 Vault 中检索知识回答用户问题，附带 Wikilink 引用

支持通过 `_agents/skills/` 目录添加自定义技能。

### 会话管理
- 对话自动保存为 JSON（恢复状态）和 Markdown（可读记录）
- 支持多轮工具调用循环（最多 20 轮）
- 感知当前活跃文件，AI 知道你在看哪个笔记
- Agent 回复中的 Wikilinks 可直接点击跳转

## 安装

### 手动安装
1. 从 [Releases](https://github.com/Xuyiyang23333/obsidian-sliver/releases) 下载最新版本
2. 解压到 Vault 的 `.obsidian/plugins/obsidian-sliver/` 目录
3. 在 Obsidian 设置 → 社区插件中启用 "Obsidian Sliver"

### 通过 BRAT 安装
1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 在 BRAT 设置中添加此仓库：`Xuyiyang23333/obsidian-sliver`

## 配置

安装后在设置 → Obsidian Sliver 中进行配置：

### API 配置
| 设置 | 说明 | 示例 |
|------|------|------|
| API Endpoint | OpenAI 兼容的 API 地址 | `https://api.deepseek.com/v1` |
| API Key | 你的 API 密钥 | `sk-...` |
| Model | 模型名称 | `deepseek-chat` |

点击「获取」按钮可自动从 API 拉取可用模型列表。

### Thinking Mode
启用后模型会在回复前展示推理过程。可调节推理强度（低/中/高/最大）。

### 上下文管理
- **Context Length** — 模型上下文窗口大小（支持 k/m 后缀，如 `32k`）
- **Reserve Space** — 为 AI 回复预留的 token 空间

### 权限管理
- **Global Permission Mode** — 默认文件访问级别
- **Path Rules** — 按目录设置精细化权限

## 开发

```bash
# 安装依赖
npm install

# 开发模式（自动热重载）
npm run dev

# 生产构建
npm run build
```

将本仓库克隆到 `.obsidian/plugins/obsidian-sliver/` 后，在 Obsidian 中开启插件即可进入开发模式。

### 项目结构

```
src/
├── main.ts              # 插件入口
├── settings.ts          # 设置面板
├── agent/
│   ├── AgentCore.ts     # Agent 主循环（工具调用、流式处理）
│   ├── context.ts       # 会话上下文管理
│   ├── permissions.ts   # 权限检查
│   └── tools.ts         # 工具定义与实现
├── skills/
│   └── SkillManager.ts  # 技能发现、加载与部署
├── utils/
│   └── api.ts           # LLM API 调用（流式 + 重试）
└── views/
    └── AgentView.ts     # 聊天界面视图
```

## License

[Mozilla Public License 2.0](LICENSE)
