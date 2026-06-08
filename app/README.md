# 小说阅读助理

All-in-One macOS 小说阅读助理，基于 Tauri + React + Python Sidecar 架构。

## 功能特性
- 📚 支持 txt / epub / pdf 格式导入
- 🔗 自动抽取人物、派系、功法、道具实体，构建知识图谱
- 🔍 本地 RAG 语义检索，快速定位原文
- 💬 基于 LLM 的智能问答（限定小说内容范围）
- 📊 Cytoscape.js 交互式关系图谱可视化
- 🔒 Embedding 完全本地运行，隐私优先

## 技术栈
| 层级 | 技术 |
|---|---|
| UI | React 19 + TypeScript + TailwindCSS + Cytoscape.js |
| App Shell | Tauri v2 (Rust) |
| 数据层 | SQLite + KuzuDB + LanceDB |
| AI 引擎 | Python 3.11 + FastAPI + ONNX Runtime + OpenAI SDK |

## 开发

```bash
# 1. 安装前端依赖
cd app
npm install

# 2. 安装 Python sidecar 依赖
cd sidecar
pip install -r requirements.txt

# 3. 启动开发模式（需先启动 sidecar）
cd sidecar/src
python server.py /tmp/novel-reader-sidecar.sock

# 另一个终端
cd app
npm run tauri dev
```

## 构建
```bash
cd app
npm run tauri build
```

## 配置
首次启动后，在"设置"面板配置 LLM：
- Base URL: OpenAI 兼容端点（如 `https://api.openai.com/v1` 或本地 Ollama）
- Model Name: 如 `gpt-4o` / `llama3:8b`
- API Key: 自动存入 macOS Keychain
