# 技术学习笔记

本仓库保存技术学习笔记网站的源码、构建配置和整理过程使用的原始材料。站点由 VitePress 生成。

## 本地开发

安装 Node.js 与 npm 后，在仓库根目录执行：

```bash
npm install
npm run docs:dev
```

开发服务器启动后，通过终端输出的本地地址预览。提交变更前执行生产构建：

```bash
npm run docs:build
```

需要检查生产构建结果时，再启动本地预览：

```bash
npm run docs:preview
```

## 仓库结构

- `book/`：整理章节时使用的原始学习材料
- `docs/books/`：发布到网站的专题首页和章节
- `docs/.vitepress/`：VitePress 配置与主题代码
- `docs/public/`：无需构建处理的静态资源
- `AGENTS.md`：章节结构、内容组织和校对规范
- `package.json`：本地开发、构建与预览脚本
