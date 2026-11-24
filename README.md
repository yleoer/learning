# 技术学习手册

「技术学习手册」是一套面向**系统重学至精通、中高级技术面试通关与生产工程实战**的现代中文技术指南，基于 [VitePress](https://vitepress.dev/) 构建，在线站点配置为 [learning.yxuefeng.com](https://learning.yxuefeng.com)。

本项目精选后端、云原生与 AI 工程领域的经典技术著作，严格按**“一书一专题”**重新梳理精编：**删去已被时代淘汰的过时细节，压缩原书冗长铺垫与重复章节，全面对齐最新语言规范、LTS 版本、IETF RFC 与内核源码**，并在每章打通“底层机制 → 工程取舍与排障 → 实战练习与深度面试追问”。目前核心基线 **7 大经典书专题、共 67 章正文**（含 7 篇专题导读与速查索引，总计 74 页）均已完成重编与多轮技术核验，并已规划面向 **Kubernetes 深度研发与 AI Agent 工程转型** 的下一阶段 5 本经典书重编路线。

## 核心重编理念

- **一书一专题，内聚重组、跨书互引**：每本经典书独立成册以保留完整的领域思想脉络，但在单书内部打破零散目录，按因果依赖精简合并模块；跨书交集机制遵循“唯一主场讲透、跨专题稳定锚点互引”，消除重复阅读负担。
- **汰旧纳新，紧贴现代生产基线**：果断剔除生产已废弃机制的原理拆解；仅在有助于理解现代设计演进取舍或属高频面试对比时（如为何移除 MySQL Query Cache、Hash Join 为何取代 BNL）用简明对比交代背景，拒绝背诵过时八股。
- **三位一体：精通底座 · 面试通关 · 项目落地**：正文不止讲“是什么”，更聚焦核心不变量、生产参数权衡、踩坑反例与诊断工具链；章末配套默认折叠的**真实场景实战练习**与**覆盖连环追问（Follow-up）的高频面试题**，读完即可经受面试深挖与线上实战检验。

## 系统重学与复习路线

若计划从头完整精学一遍以建立体系化的精通能力，建议按以下**四阶段自底向上递进路线**通读；日常排障或面试冲刺则可直接从各专题导读页的「高频机制与排障速查索引」切入：

1. **第一阶段：计算机系统与网络底座（共 16 章）**
   先通读 [图解系统](docs/books/system/index.md)（8 章）与 [图解网络](docs/books/network/index.md)（8 章）。打通 CPU 缓存一致性、中断与虚拟内存、EEVDF 调度、`io_uring`/零拷贝、TCP 建连挥手与 RACK-TLP/BBR 拥塞控制、HTTP/3/QUIC 及 TLS 1.3，为理解上层语言运行时、存储引擎 I/O 与分布式网络通信建立统一的底层心智模型。
2. **第二阶段：主力语言、并发建模与运行时诊断（共 24 章）**
   依次攻克 [Go 语言学习指南](docs/books/go-guide/index.md)（19 章）与 [Go 语言并发之道](docs/books/go-concurrency/index.md)（5 章）。从类型系统、接口解耦、泛型、错误处理与模块工程化，深入至 Go 内存模型、通道所有权、有界并发流水线、大规模容错治理，直至逃逸分析、三色 GC、GMP 调度器与 `pprof`/`trace` 线上剖析。
3. **第三阶段：核心数据存储与高并发状态治理（共 18 章）**
   精读 [MySQL 是怎样运行的](docs/books/mysql/index.md)（10 章）与 [Redis 核心技术与实战](docs/books/redis/index.md)（8 章）。吃透 InnoDB 行页结构、Buffer Pool、B+ 树扫描区间推导、Hash Join、`EXPLAIN ANALYZE` 成本优化、Redo/Undo/MVCC 与死锁诊断；掌握 Redis 底层紧凑编码、多文件 AOF/混合持久化、阻塞延迟排查、主从哨兵与切片集群、缓存一致性及秒杀级并发控制。
4. **第四阶段：大型分布式与云原生架构（9 章）**
   收官精读 [凤凰架构：分布式与云原生系统](docs/books/architecture/index.md)（9 章）。将底层、语言与存储能力汇聚到架构演进与模块化单体、RPC/REST 契约、分布式事务（2PC/TCC/SAGA）与 Paxos/Raft 共识、多级透明分流、自适应限流熔断、OAuth 2.0/零信任安全、OpenTelemetry 可观测性以及 Kubernetes 调度、eBPF CNI 与无边车服务网格。

> **高效自测建议**：阅读每章时先看「本章要点」明确问题边界，读完正文后**务必在收起状态下独立推演「练习」与「面试题」**（写出关键判断依据、排障步骤或修复思路），再展开参考答案对照盲区与生产边界。

## 专题书架总览

### 语言与并发

| 专题 | 精编章数 | 核心能力与实战边界 | 参考原书 | 现代核对基线 |
| --- | :---: | --- | --- | --- |
| [Go 语言学习指南](docs/books/go-guide/index.md) | 19 章 | 类型与内存语义、方法与接口解耦、泛型、错误处理、模块与静态检查、并发与 `context`、标准库、模糊/基准测试、逃逸分析/GC 与 `unsafe`/`cgo` | Jon Bodner《Go语言学习指南（原书第 2 版）》 | Go 1.27.4 |
| [Go 语言并发之道](docs/books/go-concurrency/index.md) | 5 章 | 并发缺陷分类与内存模型、CSP 选型权衡、同步原语与通道所有权、词法约束与有界流水线、心跳/限流/自愈治理、GMP 调度与并发剖析 | Katherine Cox-Buday《Go语言并发之道》 | Go 1.27.4 |

### 数据与存储

| 专题 | 精编章数 | 核心能力与实战边界 | 参考原书 | 现代核对基线 |
| --- | :---: | --- | --- | --- |
| [MySQL 是怎样运行的](docs/books/mysql/index.md) | 10 章 | 分层架构与 `utf8mb4` 链路、`DYNAMIC` 行页布局与 Buffer Pool、B+ 树扫描区间与新索引特性、Hash Join、直方图与成本模型、`EXPLAIN ANALYZE`、Redo/Undo、MVCC 与 `data_locks` 死锁诊断 | 小孩子 4919《MySQL是怎样运行的》 | MySQL 8.4 LTS（实测 8.4.13） |
| [Redis 核心技术与实战](docs/books/redis/index.md) | 8 章 | 事件驱动模型与多线程 I/O、底层紧凑编码（`listpack` 等）、多文件 AOF 与 RDB、尾延迟与内存碎片治理、主从哨兵脑裂防护、Redis Cluster 倾斜治理、缓存读写异常与原子秒杀实战 | 蒋德钧《Redis核心技术与实战》 | Redis 8（实测 8.10.3） |

### 系统、网络与架构

| 专题 | 精编章数 | 核心能力与实战边界 | 参考原书 | 现代核对基线 |
| --- | :---: | --- | --- | --- |
| [图解系统](docs/books/system/index.md) | 8 章 | CPU 流水线与缓存一致性、中断与系统调用、虚拟内存与 MGLRU 回收、EEVDF 调度器、并发同步原语、Ext4/blk-mq 存储栈、零拷贝/`io_uring` 与 Linux 性能排障命令 | 小林 coding《图解系统（v1.0）》 | Linux 6.12 LTS |
| [图解网络](docs/books/network/index.md) | 8 章 | 内核协议栈收发全路径、IP/CIDR/IPv6/ICMP、TCP 半/全连接队列与 `TIME_WAIT` 边界、RACK-TLP 与 CUBIC/BBR、HTTP/1.1–3/QUIC 演进、TLS 1.3 安全体系与抓包排障实战 | 小林 coding《图解网络（v4.0）》 | Linux 6.12 LTS、RFC 9110–9846 |
| [凤凰架构：分布式与云原生系统](docs/books/architecture/index.md) | 9 章 | 服务边界与模块化单体、RPC/REST 契约演进、分布式事务与 Paxos/Raft、CDN/四七层均衡/多级缓存、熔断限流、OAuth 2.0（RFC 9700）/零信任、OpenTelemetry、cgroups v2/K8s 调度与 eBPF/无边车网格 | 周志明《凤凰架构：构建可靠的大型分布式系统》 | RFC 9700/9846、K8s 1.32+ |

## 后续重编计划

围绕**持续深耕 Kubernetes 核心研发**与**逐步转型 AI Agent 系统工程**两大进阶目标，下一阶段按以下顺序依次推进 5 个新专题重编（遵循“一书一专题、单一主场互引、剔除淘汰历史包袱”原则）：

| 顺序 | 计划参考原书 | 主场定位与互补边界 | 汰旧纳新与现代核对重点 |
| :---: | --- | --- | --- |
| **1** | Michael Hausenblas & Stefan Schimanski《Programming Kubernetes》 | **K8s 控制器与扩展编码**：主攻 API Machinery、水平触发状态协调、`client-go`（Reflector / DeltaFIFO / Informer / Workqueue）、CRD 与 Operator 开发 | 删去旧版手工代码生成脚手架与废弃 API，全面对齐 **K8s 1.32+、`Kubebuilder v4` / `controller-runtime`、Server-Side Apply 与 CEL 准入策略** |
| **2** | 张磊《深入剖析 Kubernetes》 | **K8s 集群核心组件与基础设施**：与上一专题错位互补，主攻容器隔离底层、Pod 核心抽象、调度器扩展框架以及 CRI / CNI / CSI 运行机制 | 彻底删去 Dockershim、PodSecurityPolicy、旧版 Ingress 等淘汰内容，升级对齐 **containerd、cgroups v2、Gateway API 与 DRA 动态资源分配** |
| **3** | Chip Huyen《AI Engineering》 | **AI 与基础模型系统工程底座**：不绑定速朽框架，建立推理性能与 Token 成本模型（KV Cache、Prefill/Decode）、Context Engineering、混合 RAG、微调边界与生产评测体系（Evals / AI-as-a-Judge） | 结合最新推理栈补充 **Prompt Caching、约束解码结构化输出、推理模型（Reasoning Models）预算控制**与线上延迟吞吐权衡 |
| **4** | Michael Albada《Building Applications with AI Agents》 | **智能体控制流与云原生运行时**：聚焦单/多智能体循环（ReAct / Plan-and-Execute / Reflection）、工具契约、分层记忆、工作流编排、安全护栏（Guardrails）与轨迹排障 | 重点补齐 **MCP（Model Context Protocol）协议、长任务检查点持久化恢复（HITL）及基于 K8s 的代码执行沙箱隔离** |
| **5** | Martin Kleppmann & Chris Riccomini《数据密集型应用系统设计（第 2 版）》 | **分布式存储、共识与数据流天花板**：收束 K8s 控制面状态底座（etcd 线性一致性与共识边界）与大规模 AI/Agent 检索及流式事件驱动底座 | 基于 **2026 第 2 版**梳理现代云原生对象存储、向量与混合检索索引、弱隔离事务边界、Raft/线性一致性及批流一体架构，与 MySQL/Redis/凤凰架构跨书互引 |

## 规范与产品文档

- [AGENTS.md](AGENTS.md)：经典书重编原则、汰旧精简尺度、章节与导读结构、实战练习与深度面试题设计、事实核验与 Git 提交规范
- [PRODUCT.md](PRODUCT.md)：产品定位、目标读者、核心学习闭环与静态站演进边界
- [DESIGN.md](DESIGN.md)：「个人技术书架」视觉设计系统、色彩排版 Token 与响应式组件约定

## 本地开发与部署

环境要求 **Node.js 22.x**（与 CI 一致）及随附 `npm`。在仓库根目录安装依赖并启动本地开发服务器：

```bash
npm ci
npm run docs:dev
```

提交变更前执行生产构建验证（检查 TypeScript 配置、Markdown 渲染与全站内部死链）：

```bash
npm run docs:build
```

如需检查生产构建产物，可启动本地静态预览：

```bash
npm run docs:preview
```

仓库已配置 [GitHub Actions 工作流](.github/workflows/deploy.yml)，推送至 `main` 分支后自动使用 Node.js 22 构建并部署到 GitHub Pages。

## 仓库结构

- `docs/index.md`：站点首页与核心价值说明
- `docs/books/`：各经典书专题的导读速查首页与精编章节正文
- `docs/.vitepress/`：VitePress 站点配置、构建期专题数据加载器与自定义主题组件
- `docs/public/`：无需构建处理的静态资源（`logo.svg`、`CNAME`）
- `AGENTS.md` / `PRODUCT.md` / `DESIGN.md`：内容重编规范、产品定位与视觉设计系统说明
- `package.json`：本地开发、构建验证与预览脚本
- `book/`：本地重编核对时参考的原始书籍与审校材料目录（已被 `.gitignore` 忽略，不随仓库分发）
