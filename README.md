# ReadFlow PDF (顺流阅读助手) 🌊

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue.svg?logo=google-chrome&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)

**ReadFlow PDF (顺流阅读助手)** 是一款专为学术阅读、文献理解与外语学习而设计的 Chrome 浏览器插件。基于 Mozilla 官方 PDF.js 深度二次开发，配备极其优雅的 Kindle 纸质书风格排版设计以及实时上下文翻译功能，让您的论文阅读与单词积累像流水般顺畅。

---

## ✨ 核心特性

### 1. 📖 Kindle 级“明亮纸张”护眼排版与全暗黑模式
- **明亮纸张 (Light Paper)**：复刻经典电子书的暖黄低饱乳白背景（`#fdfaf2`）与高对比度炭灰色文字，极大地缓解长时间盯屏幕的视觉疲劳。
- **暗黑界面 (Dark UI)**：仅对工具栏、菜单与控制台进行暗色渲染，保持 PDF 页面原色。
- **暗黑护眼 (Dark All)**：对 PDF 页面内容应用智能色彩反转算法（`filter: invert(0.92) hue-rotate(180deg)`），实现真正的夜间护眼暗色阅读。

### 2. ⚡ 双击/划选即刻翻译与智能生词本
- **无感取词**：支持配合修饰键（`Alt`/`Ctrl`/`Shift`）或开启**无修饰键直接选词**。
- **划词翻译**：自动过滤杂乱字符，展示词性、发音与释义。
- **Alt+B 快捷键**：一键在“快捷取词”和“直接选词”之间无缝切换，并配备优美的悬浮通知提示。
- **上下文关联**：自动提取生词所在的句子上下文，并在单词卡中对目标词汇进行高亮呈现，帮助在语境中温习生词。

### 3. 🎯 VSCode 式三向弹性控制台面板
- 支持 **左停靠、右停靠、底停靠** 三种布局模式。
- **右/左停靠**：在侧边展示单词卡片与配置参数。
- **底部停靠**：自动切换至 VSCode 双栏网格排版，左侧保留搜索过滤，右侧自适应平铺单词卡片。
- **动态悬浮按钮 (FAB)**：底部的侧边栏切换按钮会根据侧边栏拖拽宽度和停靠位置实时计算像素偏移，永不发生遮挡。

### 4. 🗂️ 单词卡多重密度展示与高效导出
- **三档密度设置**：
  - *极简模式*：只展示生词和翻译，适合快速浏览。
  - *上下文模式*：附带生词出现的原句高亮。
  - *完整模式*：展示原句、页码以及来源 PDF 文件名。
- **一键导出**：支持一键将单词导出为标准 **CSV 格式**，或可直接导入的 **Anki (TSV) 记忆卡格式**。

### 5. 🤖 Gemini AI 上下文翻译 (可选)
- 除了内置的 Google 翻译和英汉词典服务，支持直接接入 Google Gemini 官方大模型 API，结合学术文章上下文进行专业细分语境下的高精准翻译。

---

## 🛠️ 技术栈
- **核心逻辑**：纯 JavaScript / DOM API / Chrome Extension Storage API
- **排版引擎**：Vanilla CSS 3 (包含 HSL 柔和调色板、标准/WebKit 混合滚动条重绘)
- **PDF 渲染**：Mozilla PDF.js (v6.0.227 深度集成)
- **数据存储**：Chrome Local Storage (支持全自动高亮持久化，页面重新载入时自动恢复高亮)

---

## 🚀 快速安装与运行

1. 下载或通过 `git clone` 本仓库代码至本地：
   ```bash
   git clone https://github.com/Littledogewww/PDF_Plugin.git
   ```
2. 打开 Google Chrome 或其他 Chromium 内核浏览器（如 Edge）。
3. 在地址栏输入 `chrome://extensions/` 打开 **扩展程序** 页面。
4. 开启右上角的 **开发者模式 (Developer mode)**。
5. 点击左上角的 **加载已解压的扩展程序 (Load unpacked)**。
6. 选择本项目所在的根目录文件夹。
7. 开启您的 PDF 阅读与顺流积累之旅！

---

## 📄 开源协议
本项目基于 [MIT License](LICENSE) 协议开源。
