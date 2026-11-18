---
title: 导读与速查索引
description: 基于 MySQL 8.4 LTS 重组精简的 InnoDB 存储、索引优化、执行计划、事务日志、MVCC 与锁机制全景指南。
---

# MySQL 是怎样运行的：导读与速查索引

本指南以小孩子 4919《MySQL是怎样运行的：从根儿上理解 MySQL》的问题脉络与底层拆解为基础，按**知识域与因果依赖**将原书 22 章重组精简为 **3 大模块、10 章**，并基于 **MySQL 8.4 LTS**（实测版本 `8.4.13`）全面更新过时的 5.7 机制、订正原书笔误、补齐现代查询优化与诊断工具。

## 从 MySQL 5.7 到 MySQL 8.4 LTS 的关键演进 {#evolution}

原书基于 MySQL 5.7.22 编写，直接按旧版本记忆指导现代生产环境极易踩坑。本指南在对应主场章节完整覆盖并实测了以下核心变革：

- **架构与元数据**：8.0 彻底移除查询缓存（Query Cache）及 `.frm` / `db.opt` 文件，启用存储在 `mysql.ibd` 中的统一事务数据字典与表空间内嵌 **SDI**（聚簇索引根页由 `Page 3` 顺延至 `Page 4`）；8.4 默认禁用 `mysql_native_password`，移除 `mysqlpump` 与 `default_authentication_plugin`，并将 `binlog_format` 标记弃用（默认固定为 `ROW`）。
- **字符集与配置**：默认字符集升级为 `utf8mb4`、默认比较规则升级为 `utf8mb4_0900_ai_ci`，`utf8`（`utf8mb3`）标记弃用；新增 `SET PERSIST` / `PERSIST_ONLY`（`mysqld-auto.cnf` 优先级高于命令行启动选项）。
- **索引与优化器**：新增降序索引、不可见索引、函数表达式索引、索引跳跃扫描、列直方图、CTE 与窗口函数、反连接（Anti-join）及派生表条件下推；**Hash Join** 全面取代已移除的 BNL 连接；成本模型引入 `memory_block_read_cost = 0.25` 内存命中率加权，并新增 **`EXPLAIN FORMAT=TREE`** 与 **`EXPLAIN ANALYZE`** 真实迭代器采样。
- **缓冲、日志与加锁**：8.4 默认关闭 `innodb_change_buffering` 与 `innodb_flush_neighbors` 以适配现代 SSD；双写缓冲区独立为 `.dblwr` 文件，Undo 默认独立为 `undo_001/002`，Redo 改为 `#innodb_redo/` 动态容量池（`innodb_redo_log_capacity`）；锁观测表改为即时可见的 **`performance_schema.data_locks`**，且 8.0.18+ 优化了主键/唯一索引范围上界锁退化行为。

## 三大模块与十章路线 {#roadmap}

| 模块 | 覆盖章节 | 核心解决的问题 |
| --- | --- | --- |
| **一、架构、存储与缓冲管理** | [第 1 章](./chapter-01)～[第 3 章](./chapter-03) | 厘清连接认证、Server 层与存储引擎边界、`SET PERSIST` 优先级、`utf8mb4` 通信转码链路；拆解 `DYNAMIC` 行记录字节结构、16KB 数据页目录二分查找、SDI 数据目录、段区碎片空间分配及 Buffer Pool 冷热双区 LRU |
| **二、索引原理与查询优化** | [第 4 章](./chapter-04)～[第 7 章](./chapter-07) | 掌握聚簇/二级索引 B+ 树不变量、扫描区间推导、ICP 与 8.0+ 四大索引新特性；打通单表访问方法、Index Merge、内外连接 `ON`/`WHERE` 铁律与 Hash Join；精通列直方图、内存加权成本模型、半连接/反连接重写、`EXPLAIN ANALYZE` 与 `optimizer_trace` |
| **三、事务、日志、MVCC 与锁** | [第 8 章](./chapter-08)～[第 10 章](./chapter-10) | 串联 ACID 底层分工、MTR 物理逻辑 Redo 日志、`#innodb_redo`、双 1 两阶段提交、五步崩溃恢复与 Undo 两阶段删除；吃透版本链、`ReadView` 可见性算法、`RC`/`RR` 差异、五类 InnoDB 行锁、`RR` 范围锁退化与 `data_locks` 死锁诊断 |

## 高频机制与线上排障速查索引 {#quick-index}

| 想查的问题 / 机制 / 排障场景 | 主场位置 |
| --- | --- |
| 查询缓存为何被删、`SET PERSIST` 优先级、跨字符集连接隐式转换导致索引失效 | [1.1 分层架构](./chapter-01#ch1-1) · [1.2 变量与持久化](./chapter-01#ch1-2) · [1.3 字符集转码链路](./chapter-01#ch1-3) |
| 变长字段头 1B/2B 边界、40 位记录头、`VARCHAR` 65535B 上限与 `DYNAMIC` 行溢出 | [2.1 行格式与记录布局](./chapter-02#ch2-1) |
| 16KB 数据页七大组件、`Page Directory` 槽分裂与二分查找、撕裂页校验 | [2.2 数据页七大组件剖析](./chapter-02#ch2-2) |
| `mysql.ibd` 与 `ibd2sdi`、32 碎片页与段区分配、Buffer Pool 冷热 LRU 防全表扫描污染 | [3.1 数据目录与 SDI](./chapter-03#ch3-1) · [3.2 段区与碎片页](./chapter-03#ch3-2) · [3.3 Buffer Pool 与 LRU](./chapter-03#ch3-3) |
| 聚簇 vs 二级索引回表、根页不动窝、联合索引扫描区间（`<` vs `<=`）、ICP、跳跃扫描与降序/函数索引 | [4.1 B+ 树三大不变量](./chapter-04#ch4-1) · [4.2 扫描区间与 ICP](./chapter-04#ch4-2) · [4.3 现代索引特性与规范](./chapter-04#ch4-3) |
| `const`/`eq_ref`/`ref`/`range`/`index`、ROR 索引合并、外连接 `ON` vs `WHERE`、Hash Join 取代 BNL | [5.1 单表访问方法](./chapter-05#ch5-1) · [5.2 索引合并](./chapter-05#ch5-2) · [5.3 内外连接铁律](./chapter-05#ch5-3) · [5.4 Hash Join](./chapter-05#ch5-4) |
| 统计信息 24h 缓存坑、列直方图、`in_memory` 成本常数、`IN` 200 阈值、半连接五策略与 `NOT IN` 空值坑 | [6.1 统计与直方图](./chapter-06#ch6-1) · [6.2 成本模型](./chapter-06#ch6-2) · [6.3 重写、半连接与反连接](./chapter-06#ch6-3) |
| `EXPLAIN` 12 列、`utf8mb4` 下 `key_len` 公式、`Extra` 信号、`EXPLAIN ANALYZE` 与 `optimizer_trace` | [7.1 `EXPLAIN` 12 列与 `key_len`](./chapter-07#ch7-1) · [7.2 `EXPLAIN ANALYZE`](./chapter-07#ch7-2) · [7.3 `optimizer_trace`](./chapter-07#ch7-3) |
| 隐式提交、MTR 原子组、无锁 Log Buffer、双 1 两阶段提交、`#innodb_redo`、崩溃恢复、Undo 两阶段删除 | [8.1 ACID 与隐式提交](./chapter-08#ch8-1) · [8.2 Redo 与崩溃恢复](./chapter-08#ch8-2) · [8.3 Undo 与两阶段删除](./chapter-08#ch8-3) |
| 四类隔离级别、`ReadView` 四字段可见性算法、`RC` vs `RR` 快照时机、长事务膨胀与 `RR` 混合读写幻读 | [9.2 版本链与 `ReadView`](./chapter-09#ch9-2) · [9.3 `RC` 与 `RR` 对比](./chapter-09#ch9-3) · [9.4 长事务与幻读特例](./chapter-09#ch9-4) |
| `MDL` 阻塞、`FOR UPDATE NOWAIT/SKIP LOCKED`、五类行锁、`RR` 范围上界锁退化、`data_locks` 死锁排查 | [10.1 表锁、`MDL` 与自增锁](./chapter-10#ch10-1) · [10.2 五类行锁](./chapter-10#ch10-2) · [10.3 全场景加锁矩阵](./chapter-10#ch10-3) · [10.4 死锁诊断](./chapter-10#ch10-4) |

## 阅读与代码约定 {#conventions}

- **章节结构与自测**：每章统一按“本章要点 → 正文原理、速查表与实测 SQL → 练习 → 面试题 → 参考资料”展开，参考答案默认折叠，建议先独立推演再展开对照。
- **默认版本与建表约定**：除专门对比历史演进外，所有 SQL 示例均在 **MySQL 8.4.13**（InnoDB 引擎、`DYNAMIC` 行格式、`utf8mb4` 字符集、`utf8mb4_0900_ai_ci` 比较规则、`REPEATABLE READ` 隔离级别）下实测核验。
- **公式与图示标记**：字节布局、扫描区间与成本公式统一使用等宽代码块标记，避免依赖外部公式插件；需要标注最低支持版本的特性均在首次出现处注明（如 `MySQL 8.0.18+`）。

## 参考资料

- [MySQL 8.4 Reference Manual（官方文档总入口）](https://dev.mysql.com/doc/refman/8.4/en/)
- [MySQL 8.4 Reference Manual：The InnoDB Storage Engine](https://dev.mysql.com/doc/refman/8.4/en/innodb-storage-engine.html)
- [MySQL 8.4 Reference Manual：Optimization](https://dev.mysql.com/doc/refman/8.4/en/optimization.html)
- [MySQL 8.4 Release Notes（8.4 LTS 演进与移除特性说明）](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/)
