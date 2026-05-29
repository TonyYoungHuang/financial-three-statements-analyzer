# 财务三表分析器 PWA

面向非财务人员的财务三表分析 PWA。用户可以上传资产负债表、损益表和现金流量表，系统会辅助提取报表数据、计算关键财务指标、生成风险提示，并导出 PDF 分析报告。

> 本项目用于辅助理解财务报表，不构成投资建议、审计意见、授信建议或任何形式的决策结论。

## 功能特性

- 激活码登录与会话限制
- 资产负债表、损益表、现金流量表上传
- 支持单期分析和两期对比
- PDF 报表解析，包含电子 PDF 和基础扫描件解析流程
- 人工校对与数据修复流程
- 42 个财务指标注册表
- 盈利能力、现金流质量、偿债能力、运营效率、成长性等指标分析
- 风险提示、事实引用、指标说明和学习化解读
- DeepSeek 大模型结构化解读，可配置 API Key
- PDF 报告导出
- PWA 安装与离线外壳缓存

## 技术栈

- Node.js 24
- 原生 Node HTTP Server
- SQLite `node:sqlite`
- PDF.js / `pdfjs-dist`
- PDFKit
- 可选 Python 解析链：`pdfplumber`、`camelot-py`、`docling`、`pytesseract`、`Pillow`

## 快速开始

```bash
npm install
cp .env.example .env
npm run check
npm run test:metrics
npm start
```

默认服务地址：

```text
http://127.0.0.1:4173/
```

## 环境变量

复制 `.env.example` 后按需配置：

```bash
PORT=4173
NODE_ENV=production
ADMIN_TOKEN=replace-with-a-long-random-admin-token
DEEPSEEK_API_KEY=
SOURCE_PDF_RETENTION_HOURS=24
MAX_UPLOAD_BYTES=26214400
SESSION_WINDOW_MINUTES=30
```

注意：

- 不要把真实 `.env`、API Key、后台令牌提交到 GitHub。
- 生产环境必须设置 `ADMIN_TOKEN`。
- `DEEPSEEK_API_KEY` 可以通过环境变量或后台系统配置提供。

## PDF 与隐私说明

- 上传 PDF 用于报表解析、人工校对和报告生成。
- 默认源 PDF 保留时间为 24 小时，可通过 `SOURCE_PDF_RETENTION_HOURS` 配置。
- 生成的报告建议用户及时下载。
- 复杂扫描件可能需要人工校对，系统提供数据修复流程。

## 常用脚本

```bash
npm run check
npm run test:metrics
npm run test:e2e
npm run test:parser-samples
```

## 部署提示

建议使用项目内 Node 24 运行：

```bash
npm install node@24.15.0 --save-exact
PORT=4173 pm2 start ./node_modules/node/bin/node --name financial-three-statements -- server/server.js
```

Nginx 可反向代理到：

```text
http://127.0.0.1:4173/
```

如果部署在子路径，例如 `/financial/`，需要同步配置 Nginx，并在更新前端文件后提升 `sw.js` 中的缓存版本。

## 开源许可

MIT License
