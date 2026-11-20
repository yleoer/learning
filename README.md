# 技术学习笔记

「技术学习笔记」是一套面向长期学习、系统理解与日常回查的中文技术指南，基于 [VitePress](https://vitepress.dev/) 构建，在线站点配置为 [learning.yxuefeng.com](https://learning.yxuefeng.com)。

目前全部 **7 个专题、共 67 章**（含 7 篇专题导读与速查索引，总计 74 页）均已完成整理与多轮技术核验。各专题以经典技术书籍为主线，按知识域去重重组，结合当前主流语言规范、RFC、源码与本地实测更新过时表述，并在每章提供默认折叠的递进练习、高频面试题与一手参考资料。

## 专题总览

### 语言与并发

| 专题 | 章数 | 核心内容 | 参考原书 | 核对基线 |
| --- | :---: | --- | --- | --- |
| [Go 语言学习指南](docs/books/go-guide/index.md) | 19 章 | 语法基础、复合类型、方法与接口、泛型、错误处理、模块工具链、并发、`context`、标准库、测试与运行时底层 | Jon Bodner《Go语言学习指南（原书第 2 版）》 | Go 1.27.4 |
| [Go 语言并发之道](docs/books/go-concurrency/index.md) | 5 章 | 并发缺陷与内存模型、CSP 选型、同步原语与通道所有权、流水线与有界并发、大规模容错治理、GMP 调度与诊断 | Katherine Cox-Buday《Go语言并发之道》 | Go 1.27.4 |

### 数据与存储

| 专题 | 章数 | 核心内容 | 参考原书 | 核对基线 |
| --- | :---: | --- | --- | --- |
| [MySQL 是怎样运行的](docs/books/mysql/index.md) | 10 章 | 体系架构与字符集、InnoDB 行/页与 Buffer Pool、B+ 树索引、访问方法与 Hash Join、统计成本与执行计划、事务日志、MVCC 与锁诊断 | 小孩子 4919《MySQL是怎样运行的》 | MySQL 8.4 LTS（实测 8.4.13） |
| [Redis 核心技术与实战](docs/books/redis/index.md) | 8 章 | 体系架构与 RESP/ACL/I/O 线程、底层数据结构与多模型、AOF/RDB 持久化、阻塞与延迟诊断、主从哨兵、切片集群、缓存治理与高并发实战 | 蒋德钧《Redis核心技术与实战》 | Redis 8（实测 8.10.3） |

### 系统、网络与架构

| 专题 | 章数 | 核心内容 | 参考原书 | 核对基线 |
| --- | :---: | --- | --- | --- |
| [图解系统](docs/books/system/index.md) | 8 章 | CPU 流水线与缓存一致性、中断与系统调用、虚拟内存与 MGLRU、EEVDF 调度、并发同步、Ext4/blk-mq、零拷贝/`io_uring` 与排障命令 | 小林 coding《图解系统（v1.0）》 | Linux 6.12 LTS |
| [图解网络](docs/books/network/index.md) | 8 章 | 网络分层与协议栈收发、IP/CIDR/IPv6/ICMP、TCP 建连队列与挥手边界、RACK-TLP/CUBIC/BBR、HTTP/1.1–3/QUIC、TLS 1.3 安全演进与排障实战 | 小林 coding《图解网络（v4.0）》 | Linux 6.12 LTS、RFC 9110–9846 |
| [凤凰架构：分布式与云原生系统](docs/books/architecture/index.md) | 9 章 | 架构演进与模块化单体、RPC/REST 契约、分布式事务与 Paxos/Raft、多级分流、容错限流、OAuth/TLS/零信任、OpenTelemetry、K8s 调度与 CNI/CSI/无边车网格 | 周志明《凤凰架构：构建可靠的大型分布式系统》 | RFC 9700/9846、K8s 1.32+ |

## 内容组织与质量约定

- **统一章节结构**：所有章节均遵循 `本章要点与核对环境 → 编号正文 → 练习 → 面试题 → 一手参考资料` 结构，练习与面试题答案默认折叠，保留独立思考空间。
- **单一主场与跨专题联动**：核心机制尽量只在唯一主场章节讲透，跨章节与跨专题通过稳定自定义锚点互相引用，减少重复。
- **有据可查**：正文明确区分标准规范、官方源码与本地实测范围，所有专题整理规范与提交约束详见 [AGENTS.md](AGENTS.md)。

## 本地开发与部署

环境要求 **Node.js 22.x**（与 CI 一致）及随附 `npm`。在仓库根目录安装依赖并启动本地开发服务器：

```bash
npm ci
npm run docs:dev
```

提交变更前执行生产构建验证（检查 TypeScript 配置、Markdown 渲染与内部死链）：

```bash
npm run docs:build
```

如需检查生产构建产物，可启动本地静态预览：

```bash
npm run docs:preview
```

仓库已配置 [GitHub Actions 工作流](.github/workflows/deploy.yml)，推送至 `main` 分支后自动使用 Node.js 22 构建并部署到 GitHub Pages。

## 仓库结构

- `docs/index.md`：网站首页与核心说明
- `docs/books/`：7 个技术专题的导读首页与 67 篇章节正文
- `docs/.vitepress/`：VitePress 站点配置、构建期专题数据加载器与自定义主题组件
- `docs/public/`：无需构建处理的静态资源（`logo.svg`、`CNAME`）
- `AGENTS.md`：章节结构、题目设计、事实核对与 Git 提交规范
- `PRODUCT.md` / `DESIGN.md`：站点产品定位与视觉设计系统说明
- `package.json`：本地开发、构建与预览脚本
- `book/`：本地整理章节时参考的原始材料目录（已被 `.gitignore` 忽略，不随仓库分发）
