# LocalMind 网页版

LocalMind 是一个**本机 localhost 网页版**的本地学习资料管理器与本地 RAG AI 学习助手。  
React 前端运行在浏览器里，SQLite、向量索引、本地 Embedding、Python Worker 和 LLM 代理都由同一个本机 Node 服务提供。

核心原则：

- 网页里上传的资料会复制到本机数据目录的 `library/`，由本机 Node 服务管理，不会上传到云端。
- 文档解析、文本切分、Embedding、向量索引和相似度检索全部在本机执行。
- 只有你主动使用云端 LLM 时，当前问答需要的检索片段和对话上下文才会发送到你配置的模型服务。
- 「移除索引」只删除 LocalMind 的索引，不会删除上传到 `library/` 的原始副本。

---

## 已实现功能

- **网站收藏**：CRUD、分组、标签、搜索、筛选、拖拽排序、favicon 抓取、浏览器打开。
- **本地资料夹**：浏览器选择文件夹上传、备注、标签、打开目录（服务端资源管理器）、失效检测、重新定位、扫描、移除索引、文档与索引统计。
- **文档阅读**：`.md` `.markdown` `.txt` `.js` `.jsx` `.ts` `.tsx` `.py` `.json` `.css` `.html` `.htm`，代码高亮、搜索、分页、索引状态、当前文档提问。
- **Markdown 笔记**：本地 `.md` 文件、SQLite 元数据、自动保存、冲突保护、预览、搜索、回收站删除、保存后触发索引。
- **本地知识库**：文件扫描、UTF-8/GB18030 解码、标题感知切分、本地 E5 Embedding、SQLite 向量存储、增量索引、重命名识别、删除清理、generation 原子切换、失败保留旧索引、进度与取消。
- **AI 助手**：OpenAI 兼容 API、SSE 流式输出、停止、重试、重新生成、普通问答/资料问答、学习模式、Markdown、代码高亮、引用跳转、导出 Markdown。
- **全局搜索**：网站、资料夹、文档名、文档内容、笔记、聊天记录；SQLite + FTS5，包含中文分词兼容处理。
- **学习计划**：任务 CRUD、优先级、截止日期、完成状态。
- **安全**：服务只监听 `127.0.0.1`，同源校验，API Key 只在服务端用 AES-256-GCM 加密保存，前端拿不到明文，云端传输确认弹窗。

第一版暂不解析 PDF/DOCX，不做内置浏览器、自动文件系统监听和多用户。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 服务端 | Node.js 22.12+（验证使用 Node 24）、原生 `node:http` |
| 前端 | React 19、TypeScript 5.9、Vite 7 |
| 状态 | TanStack Query、Zustand |
| 数据库 | `node:sqlite` 内置 SQLite + FTS5 |
| 校验 | Zod 4 |
| 本地 Embedding | Python 3.12 + ONNX Runtime + tokenizers |
| 模型 | `intfloat/multilingual-e5-small` FP32 ONNX |
| 渲染 | react-markdown、remark-gfm、highlight.js |
| 测试 | Vitest、pytest |

---

## 快速开始

```powershell
pnpm install
pnpm build
pnpm start
```

然后浏览器打开：

```text
http://127.0.0.1:8787
```

也可以直接双击项目根目录的：

```text
启动LocalMind网页版.cmd
```

或双击桌面上的 **LocalMind** 快捷方式。启动脚本会打开一个服务端窗口，再自动打开浏览器；关闭服务端窗口即停止服务。

开发模式（前端热更新 + 服务端）：

```powershell
# 终端 1：服务端
pnpm build:web
node dist/server/index.mjs

# 终端 2：Vite 开发服务器，/api 会代理到 8787
pnpm exec vite --config vite.web.config.ts
```

---

## 环境要求

- Windows 10/11 x64（其他系统只要 Python 环境可用也可运行）
- Node.js 22.12+（`node:sqlite` 需要；验证使用 Node 24）
- pnpm 11+
- Python 3.12，已安装 `onnxruntime`、`tokenizers`、`numpy`

---

## 数据位置

默认使用项目目录下的 `.userdata`，也可以通过环境变量指定：

```powershell
$env:LOCALMIND_USER_DATA = 'F:\LocalMindData'
$env:LOCALMIND_PORT = '8787'
pnpm start
```

目录结构：

```text
.userdata/
  localmind.db          SQLite 数据库
  notes/                Markdown 笔记
  models/               本地 Embedding 模型
  logs/                 服务端日志
  library/              浏览器上传的资料副本
  trash/                笔记回收站
  secret.key            AES-256-GCM 密钥（仅服务端可读）
  secrets.bin           加密后的 API Key
```

服务只监听本机回环地址，不提供登录和多用户隔离；不要把端口暴露到局域网或公网。

---

## 本地模型

首次在「设置」中下载：

- 模型：`intfloat/multilingual-e5-small`
- 许可证：MIT
- 输出维度：384
- 最大输入：512 tokens
- ONNX 文件 SHA-256：`ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665`
- 下载到数据目录的 `models/multilingual-e5-small-ca456c06b3a9/`

Embedding 使用：

- 文档/片段：`passage: ` 前缀
- 查询：`query: ` 前缀
- 池化：attention mask 的 mean pooling
- 归一化：L2 normalize
- 余弦相似度：向量归一化后为点积

模型只从本地加载；Python Worker 没有任何网络请求代码。

手动下载模型：

```powershell
node scripts/download-model.mjs
```

---

## AI 配置

在「设置 → AI 模型服务」配置：

- API Base URL：例如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`http://127.0.0.1:11434/v1`
- 模型名称
- API Key（本地 loopback 服务可不填）
- 超时时间、是否流式、temperature

API Key 只保存在服务端，使用 `secret.key` + AES-256-GCM 加密写入 `secrets.bin`，不会回传到前端、写入 SQLite 或日志。

**隐私边界**：本地 RAG 的解析、切分、Embedding、向量化和检索全部本机完成。云端 LLM 模式下，检索片段和必要对话会发送到你配置的服务；首次使用非 loopback 云端地址会弹出确认，地址改变会重新确认。

---

## HTTP 接口

前端通过三个接口和本机服务通信：

```text
POST /api/invoke            统一调用接口（channel + args）
GET  /api/events            SSE 事件（聊天流、索引进度、模型下载进度）
POST /api/folders/upload    multipart 资料上传
```

浏览器端的 `window.localMind` 由 `src/web/api.ts` 实现，和原来的桌面 API 保持同一套类型和方法，页面组件不需要改。

---

## 数据库与索引

- SQLite 使用 WAL、外键和 `busy_timeout`。
- 迁移记录在 `schema_migrations`，迁移前自动备份；不会在启动时重置数据库。
- FTS5 存储文档正文、笔记和聊天消息；中文通过 CJK 字符间隔规范化解决 `unicode61` 分词问题。
- 向量以 Float32 little-endian BLOB 保存在 `document_chunks`。
- 检索为精确余弦穷举，每批 2,000 条并让出事件循环；适合个人规模资料。10 万级片段会有秒级延迟，后续可替换为 `sqlite-vec`。
- 每个文档使用 generation 安全重建：新向量全部成功后才切换 active generation；失败/取消保留旧索引。

---

## 测试

```powershell
pnpm test                 # Vitest 单元测试
pnpm test:model           # 真实 E5 模型 + 真实本地检索集成测试
python -m pytest python/tests -q
```

真实模型测试默认跳过；设置 `LOCALMIND_RUN_MODEL_TESTS=1` 或在 `pnpm test:model` 中启用。

测试覆盖：切分、哈希与增量扫描、重命名/删除、SQLite 持久化、FTS 中文检索、向量阈值/模型隔离/generation、上下文去重与预算、SSE 解析、API 错误、笔记保存冲突、资料夹移除索引不删除文件、真实模型语义检索。

---

## 项目结构

```text
src/server/           本机 Node HTTP 服务、SSE、上传、接口适配
src/web/              浏览器端 window.localMind 实现与 web 入口
src/main/db/          SQLite、迁移、文档仓储
src/main/services/    网站、资料夹、文档、笔记、搜索、任务、设置、聊天
src/main/indexing/    扫描、切分、增量索引
src/main/model/       模型管理、Python Worker 客户端
src/main/rag/         向量存储、检索、上下文、RAG 服务
src/main/llm/         OpenAI 兼容客户端与 SSE 解析
src/main/platform/    打开本机目录
src/shared/           共享类型、IPC channel、学习模式提示词
src/renderer/src/     React 页面、组件、样式
python/               Embedding Worker 与 pytest
scripts/              模型下载、测试环境变量
tests/                Vitest 单元测试与集成测试
resources/            图标
```

---

## 故障排查

### 浏览器打不开 127.0.0.1:8787

先确认服务端窗口没有报错；如果端口被占用，设置 `LOCALMIND_PORT` 换一个端口。

### 页面显示「网页前端尚未构建」

先执行：

```powershell
pnpm build
```

### 模型已安装但提示「未安装」

打开「设置 → 数据位置」查看实际 `models` 路径，确保模型位于该目录；服务端启动时会打印模型状态。

### 上传后文档没有索引

上传只会先扫描并建立文档记录；请点击资料夹的「更新索引」生成本地向量。

### 旧的 Electron 依赖还在 node_modules

`package.json` 已移除 Electron 相关依赖；执行一次 `pnpm install` 会清理 `node_modules` 中不再使用的 Electron 包。

---

## 已知限制

- 暂不支持 PDF、DOCX 解析和预览。
- 浏览器上传会把文件复制到 `library/`；上传的原目录与网页之间不再保持同步。
- 文件夹选择使用 `webkitdirectory`，推荐 Chrome/Edge。
- 向量检索是精确暴力搜索，未使用专用 ANN/向量数据库。
- 没有自动文件系统监听；需要手动扫描/更新索引。
- 没有登录、HTTPS 和多用户隔离；只适合本机 localhost 使用。
- 云端 LLM 模式不是“全部数据不出本机”；UI 和 README 已明确区分。

## 许可证

应用代码采用 MIT 许可证。Embedding 模型 `intfloat/multilingual-e5-small` 为 MIT 许可证。