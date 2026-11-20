---
title: 第 5 章 单表访问方法、连接原理与 Hash Join
description: 系统梳理单表访问方法与索引合并 ROR 条件，厘清内外连接 ON/WHERE 铁律，掌握 INLJ 与 MySQL 8.0+ Hash Join 执行机制。
---

# 第 5 章 单表访问方法、连接原理与 Hash Join

## 本章要点

理解 B+ 树索引与扫描区间后，下一步是厘清优化器如何将一条 SQL 落地为具体的物理取数算子与多表连接流水线。本章首先梳理 MySQL 单表访问方法全景及多范围读取（MRR）顺序回表机制，接着剖析索引合并（Index Merge）三大算法背后的主键有序（ROR）前提与《MySQL是怎样运行的》原书勘误，随后从流式探测视角厘清内外连接中 `ON` 与 `WHERE` 子句的语义边界，最后系统拆解从索引嵌套循环连接（INLJ）到 MySQL 8.0+ 全面取代 BNL 的 **Hash Join**——涵盖构建与探测阶段、`join_buffer_size` 内存预算及磁盘分片溢出。读完本章后，读者应能根据表结构与查询谓词准确预判 `EXPLAIN` 的 `type` 列与连接执行策略。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 5.1 单表访问方法全景速查 {#ch5-1}

MySQL 执行查询的本质是对每张表选择一种物理取数路径，在原书与官方文档中统称为**访问方法**（Access Method），对应 `EXPLAIN` 输出的 `type` 列，详见 [7.1 节](./chapter-07#ch7-1)。为统一演示，本章单表示例沿用如下 `10000` 行基准表 `single_table`：

```sql
CREATE TABLE single_table (
    id INT NOT NULL AUTO_INCREMENT,
    key1 VARCHAR(100),
    key2 INT,
    key3 VARCHAR(100),
    key_part1 VARCHAR(100),
    key_part2 VARCHAR(100),
    key_part3 VARCHAR(100),
    common_field VARCHAR(100),
    PRIMARY KEY (id),
    KEY idx_key1 (key1),
    UNIQUE KEY uk_key2 (key2),
    KEY idx_key3 (key3),
    KEY idx_key_part (key_part1, key_part2, key_part3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

常用单表及被驱动表访问方法按单次定位代价由低到高汇总如下：

| 访问方法（`type`） | 核心触发条件 | 索引要求与回表特征 | 典型示例（基于 `single_table`） |
| --- | --- | --- | --- |
| `const` | 主键或唯一二级索引列与**非空常数**等值比较 | 最多匹配 `1` 行；优化阶段直接读取记录并将列值替换为常量 | `WHERE id = 100` 或 `WHERE key2 = 1000` |
| `eq_ref` | 连接查询中，被驱动表通过主键或非空唯一索引与驱动表列等值关联 | 每次探测最多匹配 `1` 行；联合唯一索引须全列等值匹配 | `FROM t1 JOIN single_table s ON t1.id = s.id` |
| `ref` | 普通二级索引列与常数或上游表列等值比较，或唯一索引判 `IS NULL` | 匹配单点区间 `[v, v]` 内连续多条记录，非覆盖时逐条回表 | `WHERE key1 = 'a'` 或 `WHERE key2 IS NULL` |
| `ref_or_null` | 二级索引列同时匹配某常数等值条件与 `IS NULL` | 连续扫描 `[NULL, NULL]` 与 `[v, v]` 两个单点区间 | `WHERE key1 = 'a' OR key1 IS NULL` |
| `index_merge` | 同时扫描多个索引提取主键值，按交集或并集合并后再统一回表 | 仅用于单表多索引扫描特殊路径，详见 [5.2 节](#ch5-2) | `WHERE key1 = 'a' AND key3 = 'b'` |
| `range` | 利用聚簇或二级索引扫描若干单点或范围区间 | 区间越窄代价越低；`IN (...)` 含 2 个及以上常数即归为 `range` | `WHERE key2 IN (10, 20)` 或 `WHERE id > 9500` |
| `index` | 扫描整棵二级覆盖索引树，或按主键顺序扫描整张聚簇索引表 | 免回表或免额外排序，但仍需遍历全部叶子页 | `SELECT key_part1 FROM single_table WHERE key_part2 = 'x'` |
| `ALL` | 直接遍历聚簇索引全部叶子页执行全表扫描 | 逐行评估过滤条件，大表未命中缓冲池时磁盘 I/O 开销最高 | `WHERE common_field = 'cf_1'` |

除上表外，`EXPLAIN` 还存在用于全文检索的 `fulltext`，以及早期版本针对不相关 `IN` 子查询设计的 `unique_subquery` 与 `index_subquery`——在 MySQL 8.0+ 中，后两者已普遍被半连接重写取代，详见 [6.3.2 节](./chapter-06#ch6-3-2)。判读上述访问方法时，需重点留意三处高频边界：

1. **唯一二级索引遇到 `IS NULL` 会从 `const` / `eq_ref` 退化为 `ref`**：SQL 标准与 InnoDB 均允许 `UNIQUE` 索引列存入多个 `NULL` 值。因此 `WHERE key2 = 1000` 保证至多命中 1 行，走 `const`；而 `WHERE key2 IS NULL` 可能命中多行，必退化为 `ref`。同理，连接条件若关联可空唯一索引列且未附加非空约束，也可能退化为 `ref_or_null` 或 `ref`。
2. **`type = index` 涵盖两种截然不同的物理行为**：其一是**二级覆盖索引全扫描**——当查询列与过滤列均含在 `idx_key_part` 中却未约束最左列 `key_part1` 时，`Extra` 显示 `Using where; Using index`，因二级索引记录远窄于聚簇索引，叶子页数显著少于 `ALL`；其二是**按主键排序的全表扫描**——如执行 `SELECT * FROM single_table ORDER BY id`，此时 `key = PRIMARY`、`Extra = NULL`，虽标注为 `index`，物理开销实与 `ALL` 相当。
3. **多范围读取**（MRR）：二级索引按索引列排序，同一范围区间内的主键值 `id` 往往是乱序的，每读一条二级索引记录立即回表会产生大量随机页面访问。当 `optimizer_switch` 开启 `mrr=on` 且成本评估划算时——或显式添加 `/*+ MRR(tbl idx) */` 提示——执行器会先扫描二级索引，收集一批主键值填入由 `read_rnd_buffer_size`（默认 `256 KiB`）控制的内存缓冲区，**将主键值升序排列后再按页序批量回表读取聚簇索引**，`Extra` 列随之输出 `Using MRR`，将随机 I/O 转化为近似顺序读取。

在 MySQL 8.4.13 中对 `single_table`（含 3 行 `key2 IS NULL`）实测上述边界，计划对比如下：

```sql
-- 1. 唯一索引非空等值：type = const，rows = 1
EXPLAIN SELECT * FROM single_table WHERE key2 = 1000;
-- type: const | key: uk_key2 | key_len: 5 | ref: const | rows: 1 | Extra: NULL

-- 2. 唯一索引判空：允许多个 NULL，退化为 type = ref
EXPLAIN SELECT * FROM single_table WHERE key2 IS NULL;
-- type: ref   | key: uk_key2 | key_len: 5 | ref: const | rows: 3 | Extra: Using index condition

-- 3. 启用 MRR 批量顺序回表：Extra 出现 Using MRR
EXPLAIN SELECT /*+ MRR(single_table idx_key1) */ * FROM single_table WHERE key1 > 'k1_100' AND key1 < 'k1_105';
-- type: range | key: idx_key1 | key_len: 403 | rows: 80 | Extra: Using index condition; Using MRR
```

## 5.2 索引合并（Index Merge）与 ROR 主键有序前提 {#ch5-2}

常规情况下，优化器对单张表每次最多只挑一个索引生成扫描区间。但在特殊场景下，MySQL 支持同时扫描同一张表的多个 B+ 树索引，在内存中对各索引产出的主键值集合求交集或并集去重，再统一回表取数，这一机制称为**索引合并**（`type = index_merge`），共含三种具体算法：

| 合并算法 | `Extra` 标识 | 逻辑词 | 是否强制要求 ROR | 合并与去重方式 | 典型触发 SQL |
| --- | --- | --- | --- | --- | --- |
| **Intersection**（交集） | `Using intersect(...)` | `AND` | **是**（`id` 须升序） | 多路归并双指针同步前移，仅保留各路共有的 `id`，复杂度 `O(M + N)` | `WHERE key1 = 'a' AND key3 = 'b'` |
| **Union**（并集） | `Using union(...)` | `OR` | **是**（`id` 须升序） | 多路归并流式合并并即时跳过重复 `id`，复杂度 `O(M + N)` | `WHERE key1 = 'a' OR key3 = 'b'` |
| **Sort-Union**（排序并集） | `Using sort_union(...)` | `OR` | **否**（允许 `id` 乱序） | 先将各分支扫描出的 `id` 各自排序，再执行归并并集去重 | `WHERE key1 < 'k1_0002' OR key3 > 'k3_0498'` |

> [!NOTE]
> 原书勘误说明：《MySQL是怎样运行的》第 10.8.2 节阐述 `Union` 索引合并适用条件时存在复制粘贴笔误，误将连接词写成“`AND`”、将合并类型写成“`Intersection` 索引合并”。实际上，`Union` 与 `Sort-Union` 均专用于合并 **`OR`** 连接的多个索引分支；`Union` 与 `Intersection` 相同的地方仅在于二者都强制要求每个分支满足下述 **ROR** 主键有序条件。

所谓 **ROR**——即 Rowid Ordered Retrieval，按行 ID 有序取回——在 InnoDB 中要求**单个索引分支在扫描区间内吐出的主键值 `id` 天然递增有序**。只有各路输入本身按 `id` 有序，执行器才能像归并排序的合并阶段一样，每次从当前 `id` 最小的一路往前推进，在 `O(M + N)` 线性时间内完成交集或并集。在 MySQL 8.4.13 中实测三类索引合并的输出特征如下：

```sql
-- 1. Intersection：两路单列等值扫描均按 id 升序
EXPLAIN SELECT * FROM single_table WHERE key1 = 'a_1' AND key3 = 'b_1';
-- type: index_merge | key: idx_key1,idx_key3 | Extra: Using intersect(idx_key1,idx_key3); Using where

-- 2. Union：两路等值扫描各自按 id 升序，流式并集去重
EXPLAIN SELECT * FROM single_table WHERE key1 = 'a_1' OR key3 = 'b_1';
-- type: index_merge | key: idx_key1,idx_key3 | Extra: Using union(idx_key1,idx_key3); Using where

-- 3. Sort-Union：两路窄范围扫描各自 id 无序，先对各路 id 排序再归并去重
EXPLAIN SELECT * FROM single_table WHERE key1 < 'k1_0002' OR key3 > 'k3_0498';
-- type: index_merge | key: idx_key1,idx_key3 | Extra: Using sort_union(idx_key1,idx_key3); Using where
```

围绕 ROR 前提，工程上有三项极易踩坑的判定规则：

1. **为什么单列二级索引等值查询满足 ROR，而联合索引仅匹配部分最左前缀不满足 ROR？**
   如 [4.1 节](./chapter-04#ch4-1) 所述，InnoDB 二级索引叶子记录按 `(索引列..., id)` 严格排序。对 `idx_key1(key1)` 执行 `key1 = 'a'` 时，`key1` 固定为常数，区间内记录天然按 `id` 升序排列，满足 ROR。然而对联合索引 `idx_key_part(key_part1, key_part2, key_part3)` 执行如下查询时：

   ```sql
   -- 无法触发 Intersection：key_part1 固定为 'p1' 时，记录先按 key_part2, key_part3 排序，id 乱序！
   SELECT * FROM single_table WHERE key1 = 'a' AND key_part1 = 'p1';
   -- EXPLAIN: type = ref, key = idx_key1, Extra = Using where

   -- 可以触发 Union / Intersection：联合索引三列全部等值固定，同值槽内 id 严格升序，满足 ROR！
   SELECT * FROM single_table
   WHERE key1 = 'a' OR (key_part1 = 'p1' AND key_part2 = 'p2' AND key_part3 = 'p3');
   -- EXPLAIN: type = index_merge, Extra = Using union(idx_key1,idx_key_part); Using where
   ```

   第一条语句中 `idx_key_part` 不满足 ROR，优化器只能放弃交集合并，在 `idx_key1` 与 `idx_key_part` 中挑成本更低的一个执行 `ref` 扫描并回表过滤。

2. **为什么 `WHERE key1 = 'a' AND id > 9000` 物理上无需再扫聚簇索引求交集？**
   由于 `optimizer_switch` 默认开启 `use_index_extensions=on`，优化器深知 `idx_key1` 的物理键结构就是 `(key1, id)`。因此 `key1 = 'a' AND id > 9000` 直接就能在 `idx_key1` 一棵树上构造紧凑范围区间 `(('a', 9000), ('a', +∞))`——其 `key_len = 407`，即 `key1` 的 `403` 字节加上 `id` 的 `4` 字节——根本不必再去聚簇索引扫描 `(9000, +∞)` 求交集。值得补充一个 MySQL 8.4 实测细节：传统表格 `EXPLAIN` 因 `ror_intersect` 估价器将 `PRIMARY` 纳入候选集，表面仍可能打印 `Using intersect(idx_key1,PRIMARY)`；但用 `EXPLAIN FORMAT=TREE` 检视物理执行树可见，执行器已自动裁掉冗余的主键扫描，底层仅执行单路索引范围扫描：

   ```text
   -> Filter: ((single_table.key1 = 'k1_0001') and (single_table.id > 9000))  (cost=4.73 rows=4)
       -> Intersect rows sorted by row ID  (cost=4.73 rows=4.88)
           -> Index range scan on single_table using idx_key1 over (key1 = 'k1_0001' AND 9000 < id)
   ```

3. **为什么提供 `Sort-Union` 兜底，却不实现 `Sort-Intersection`？**
   在 `OR` 查询中，一旦任一分支无法走有序单点扫描，若不支持先排主键再求并集（`Sort-Union`），整条 SQL 只能被迫退化为全表扫描 `ALL`。反之，在 `AND` 交集查询中，只要任选区分度最高的一个索引执行 `range` 或 `ref` 扫描再回表过滤其余条件，代价通常已很低；若两个范围分支各自命成千上万条乱序主键，拉入内存做 `O(K log K)` 排序再求交集的 CPU 与内存开销往往得不偿失。在工程实践中，凡高频出现的 `WHERE key1 = ? AND key3 = ?`，**直接建立联合索引 `(key1, key3)` 永远优于依赖运行期 `Intersection` 合并**——联合索引只需穿透一棵 B+ 树即可精确定位，省去了多棵树重复寻路与归并缓冲成本。

## 5.3 内外连接语义本质：ON 与 WHERE 铁律 {#ch5-3}

两表或多表连接的本质是**驱动表**（Driving Table）流式探测**被驱动表**（Driven Table）：执行器先依据驱动表单表过滤条件选出满足要求的记录；每拿到 1 条驱动表记录，就携带其关联列值去被驱动表中查找匹配记录。若驱动表过滤后的扇出记录数为 `F`，则在嵌套循环模型下**驱动表只访问 `1` 次，而被驱动表会被探测 `F` 次**。

理解连接语义的核心，在于彻底分清**内连接**——MySQL 中 `INNER JOIN`、`JOIN` 与 `CROSS JOIN` 语法等价——与**外连接**（如 `LEFT JOIN`）如何对待“驱动表记录在被驱动表中找不到匹配项”的情形，以及 `ON` 与 `WHERE` 两类过滤子句的执行分工：

| 对比维度 | 内连接（`[INNER / CROSS] JOIN`） | 左/右外连接（`LEFT / RIGHT JOIN`） |
| --- | --- | --- |
| 驱动表记录失配时 | **直接丢弃**该条驱动表记录，不进入结果集 | **保留驱动表记录**，将被驱动表所有列填充为 `NULL` 后输出 |
| `ON` 子句职责 | 与 `WHERE` 完全等价，过滤不满足条件的组合行 | 仅决定“被驱动表行能否与驱动表行配对”；**配对失败只触发补 `NULL`，绝不丢弃驱动表行** |
| `WHERE` 子句职责 | 最终总闸门：求值为 `FALSE` 或 `UNKNOWN` 的行一律丢弃 | **最终总闸门**：对配对行及补 `NULL` 后的行统一筛选，求值非 `TRUE` 一律丢弃 |
| 驱动表可交换性 | 满足交换律与结合律，优化器可自由选扇出更小或有索引优势的表做驱动表 | 语义不对称，左连接以左表为外层基准、右连接以右表为基准，不可随意颠倒语义 |

执行器的单条外连接配对判定可抽象为如下两步状态机：

```text
驱动表产出 1 行 r1
  └─> 扫描被驱动表评估 ON 条件：
        ├─ 至少命中 1 行 r2  ──> 组合 (r1, r2) 送入 WHERE 总闸门筛选
        └─ 0 行命中（失配）  ──> 内连接：直接丢弃 r1
                                外连接：构造 (r1, NULL...) 送入 WHERE 总闸门筛选
```

正是 `ON` 与 `WHERE` 的职责差异，造就了外连接最典型的一条线上故障铁律：**在外连接中，针对被驱动表的过滤条件放在 `ON` 与放在 `WHERE` 会产生完全不同的结果集！** 对比以下两条基于 `t1`（`200` 行）与 `t2`（`5000` 行）的实测查询：

```sql
-- 写法 A（条件在 ON）：返回 200 行！t1 失配的 196 行仍被保留，t2 各列以 NULL 补齐
SELECT * FROM t1 LEFT JOIN t2 ON t1.a = t2.c AND t2.b = 't2_1';

-- 写法 B（条件在 WHERE）：仅返回 4 行！补 NULL 后的 196 行在 WHERE 中算得 NULL = 't2_1' (UNKNOWN)，被全部剔除
SELECT * FROM t1 LEFT JOIN t2 ON t1.a = t2.c WHERE t2.b = 't2_1';
```

在写法 B 中，由于 `NULL = 't2_1'` 求值为 `UNKNOWN`，任何被补 `NULL` 的外连接行都无法通过 `WHERE` 过滤。优化器检测到该空值拒绝条件后，会在重写阶段直接将左外连接**隐式消除为内连接**，详见 [6.3.1 节](./chapter-06#ch6-3-1)。因此编写外连接时必须明确业务意图：若希望“保留全部主表记录，仅关联满足特定状态的从表信息”，从表状态条件**必须写在 `ON` 子句中**；只有确实要剔除失配主表记录时才放入 `WHERE`，且此时应直接改写为语义清晰的 `JOIN`。

## 5.4 连接执行算法演进：从 INLJ 到 Hash Join {#ch5-4}

确定连接语义与表顺序后，MySQL 需要选择具体的物理连接算子。原书基于 MySQL 5.7 重点介绍了块嵌套循环连接（**BNL**）；而在现代 MySQL 中，这一领域迎来了里程碑式的架构升级：**MySQL 8.0.18 正式引入内存与磁盘自适应的 Hash Join，并自 MySQL 8.0.20 起彻底移除了传统 BNL 算法，由 Hash Join 全面接管所有原需 Join Buffer 的连接场景。**

四代核心连接执行算法的复杂度与适用边界对比如下，设驱动表扇出 `M` 行、被驱动表 `N` 行：

| 连接算法 | 被驱动表索引前提 | 内存探测 CPU 复杂度 | 被驱动表扫表/查树次数 | `EXPLAIN` / `FORMAT=TREE` 典型特征 |
| --- | --- | --- | --- | --- |
| **朴素嵌套循环**（Simple NLJ） | 无可用索引且禁用 Join Buffer | `O(M × N)` | 全表扫描 `M` 次 | `FORMAT=TREE` 显示 `Nested loop inner join` 套 `Table scan` |
| **索引嵌套循环**（INLJ） | 连接列具备主键或二级索引 | `O(M × log N)` | B+ 树下潜查找 `M` 次 | 被驱动表 `type` 为 `eq_ref` 或 `ref`；配合 MRR 即 **BKA** |
| **块嵌套循环**（BNL，已移除） | 无可用索引（5.7 时代兜底） | **仍高达 `O(M × N)`** | 全表扫描 `⌈M / B⌉` 次 | 旧版 `Extra` 显示 `Using join buffer (Block Nested Loop)` |
| **哈希连接**（Hash Join，8.0.18+） | 无可用索引，或哈希成本更低 | **降至线性 `O(M + N)`** | 内存充足时仅全表扫描 `1` 次 | `Extra` 显示 `Using join buffer (hash join)`；树计划显示 `Inner/Left hash join` |

当被驱动表连接列建有高效索引且驱动表扇出 `M` 较小时，**INLJ** 直接将每次探测转化为单次 B+ 树下潜（`eq_ref` 或 `ref`）；若开启 `batched_key_access=on`（BKA），还会攒批提取驱动表连接键交由 MRR 顺序回表读取被驱动表。然而一旦连接列无索引或双方扇出均很大，旧版 BNL 虽把驱动表分批装入 `join_buffer_size` 减少了被驱动表磁盘扫描轮次，但被驱动表每读出一行仍须遍历缓冲区内全部 `B` 条记录做两重循环暴力比对，总比较次数依然是 `M × N`，极易打满 CPU。

MySQL 8.0+ 的 **Hash Join** 通过两阶段流水线与分片溢出机制根治了这一瓶颈：

```text
[1. Build 构建阶段] 读取小表有效行与投影列 ──> 计算 hash(join_key) 写入内存哈希表（上限 join_buffer_size）
       │                                          └─ 若内存写满：按另一分区哈希将剩余 Build 行与后续 Probe 行分流至磁盘 Chunk 文件对
[2. Probe 探测阶段] 单遍流式读取大表 ──> 计算 hash(join_key) ──> O(1) 定位内存桶校验匹配并输出（若有溢出文件则逐对载入探测）
```

1. **Build 构建与列裁剪内存优化**：优化器挑选两路输入中字节总量更小的一侧作为 **Build 输入**，顺序读取其满足单表条件的记录，**仅抽取查询实际引用的投影列与连接列**而非整行宽字段，对等值连接键计算哈希值写入内存哈希表。该哈希表内存上限由系统变量 **`join_buffer_size`** 控制，默认 `262144` 字节（`256 KiB`），复杂分析会话可按需调优。
2. **Probe 探测 `O(1)` 匹配**：哈希表构建完毕后，执行器单次流式扫描另一侧较大的 **Probe 输入**，对每行连接键计算同一哈希函数，直接以 `O(1)` 均摊复杂度定位哈希桶并校验等值条件输出连接结果，CPU 比对开销呈数量级下降。
3. **磁盘溢出 Grace Hash Join**：若 Build 表数据量超出 `join_buffer_size` 预算，算子自动切换至磁盘分片模式：使用同一分区哈希函数将超出的 Build 行与后续对应分区的 Probe 行同步路由写入若干对磁盘临时分片文件（Chunk files），文件数受 `open_files_limit` 保护；待首轮扫描结束后，再逐对将单个 Build 分片完整读入内存哈希表，并用对应的单个 Probe 分片完成 `O(1)` 探测。
4. **全场景覆盖（8.0.20+）与开关演进**：8.0.18 初版仅支持至少含一个等值条件的内连接；自 **8.0.20** 起，Hash Join 全面支持**等值/非等值内连接、笛卡尔积、左/右外连接、半连接与反连接**——无等值键时自动将小表装入哈希缓冲块单遍扫描过滤，全面接替旧 BNL。需注意 MySQL 8.4 实测行为：`optimizer_switch` 中的 `hash_join=off` 标志已无禁用效果，控制是否允许使用 Join Buffer 的总开关仍沿用历史名称 **`block_nested_loop`**——唯有设 `block_nested_loop=off` 或使用 `/*+ NO_BNL() */` 提示时，无索引连接才会退回无缓冲的朴素 `NLJ`。

在 MySQL 8.4.13 中对 `t1`（`200` 行，含 `idx_a`）与 `t2`（`5000` 行，仅 `a` 有索引）实测四类代表性连接计划如下：

```sql
-- 1. INLJ：被驱动表 t2.a 有索引，驱动表 t1 扇出 200 次触发 Index lookup
EXPLAIN FORMAT=TREE SELECT * FROM t1 JOIN t2 ON t1.a = t2.a;
-- -> Nested loop inner join  (cost=720 rows=2000)
--     -> Filter: (t1.a is not null)  (cost=20.2 rows=200)
--         -> Table scan on t1  (cost=20.2 rows=200)
--     -> Index lookup on t2 using idx_a (a=t1.a)  (cost=2.5 rows=10)

-- 2. 等值 Inner Hash Join：两侧 b 列均无索引，自动选 200 行小表 t1 做 Hash Build，5000 行大表 t2 流式 Probe
EXPLAIN FORMAT=TREE SELECT * FROM t1 JOIN t2 ON t1.b = t2.b;
-- -> Inner hash join (t2.b = t1.b)  (cost=100025 rows=100000)
--     -> Table scan on t2  (cost=0.272 rows=5000)
--     -> Hash
--         -> Table scan on t1  (cost=20.2 rows=200)

-- 3. 非等值 Hash Join：t1.a < t2.c 无等值连接键，装载小表 t1 后由 t2 单遍扫描完成条件过滤
EXPLAIN FORMAT=TREE SELECT * FROM t1 JOIN t2 ON t1.a < t2.c;
-- -> Filter: (t1.a < t2.c)  (cost=100025 rows=333300)
--     -> Inner hash join (no condition)  (cost=100025 rows=333300)
--         -> Table scan on t2  (cost=0.855 rows=5000)
--         -> Hash
--             -> Table scan on t1  (cost=20.2 rows=200)

-- 4. 左外连接 Left Hash Join：t1.a 有索引但 t2.c 无索引；左连接禁止翻转 t2 为外层驱动表，故采用 Left hash join
EXPLAIN FORMAT=TREE SELECT * FROM t1 LEFT JOIN t2 ON t1.a = t2.c;
-- -> Left hash join (t2.c = t1.a)  (cost=100007 rows=1e+6)
--     -> Table scan on t1  (cost=20.2 rows=200)
--     -> Hash
--         -> Table scan on t2  (cost=2.52 rows=5000)
```

观察第 4 条计划与内连接的对比：若将 `LEFT JOIN` 改为 `JOIN`，优化器会立刻利用内连接交换律翻转表顺序，改由 `t2` 驱动 `t1.idx_a` 执行 `INLJ`（`cost = 6254`）；而左外连接必须保住左表 `t1` 失配补 `NULL` 的语义，无法把 `t1` 变成内层索引查找表，因此自动切换为 `Left hash join` 完成无索引外连接。

## 练习 {#ch5-exercises}

以下 2 道练习分别检验索引合并三大算法与 ROR 主键有序边界判定，以及外连接过滤位置对结果集和物理连接算子的双重影响。表结构沿用 [5.1 节](#ch5-1) 的 `single_table` 与 [5.4 节](#ch5-4) 的 `t1`、`t2`。建议先独立推导，再展开核对参考答案。

### 练习 1：判定五组查询能否触发索引合并及具体算法

针对 [5.1 节](#ch5-1) 定义的 `single_table`——设表含 `10000` 行且各二级索引区分度适中——逐条判断以下 5 条 SQL 能否使用真正的双树 `index_merge` 访问方法；若能，指出属于 `Intersection`、`Union` 还是 `Sort-Union`；若不能，说明底层原因：

```sql
-- Q1
SELECT * FROM single_table WHERE key1 = 'a' AND key3 = 'b';
-- Q2
SELECT * FROM single_table WHERE key1 = 'a' AND key_part1 = 'p1';
-- Q3
SELECT * FROM single_table WHERE key1 > 'k1_0498' AND key3 = 'b';
-- Q4
SELECT * FROM single_table WHERE key1 = 'a' OR (key_part1 = 'p1' AND key_part2 = 'p2' AND key_part3 = 'p3');
-- Q5
SELECT * FROM single_table WHERE key1 < 'k1_0002' OR key3 > 'k3_0498';
```

<details>
<summary>查看参考答案</summary>

1. **Q1：能触发 `Intersection`**，对应 `Using intersect(idx_key1,idx_key3)`。`idx_key1` 与 `idx_key3` 均为单列二级索引等值匹配，各自区间内的记录均按主键 `id` 严格升序排列，满足 ROR，可在 `O(M + N)` 时间内流式求交集后回表。
2. **Q2：不能触发 `Intersection`**。联合索引 `idx_key_part(key_part1, key_part2, key_part3)` 仅固定了首列 `key_part1 = 'p1'`，同值区间内记录先按 `key_part2, key_part3` 排序，主键值 `id` 乱序，违反 ROR 前提；优化器只会选单个代价更低的索引做 `ref` 扫描再回表过滤。
3. **Q3：不能触发 `Intersection`**。`key1 > 'k1_0498'` 是范围区间而非等值单点，不同 `key1` 值之间的主键 `id` 并非全局递增，违反 ROR，且 MySQL 未实现 `Sort-Intersection`，故只选单个区分度更高的索引扫描后回表过滤。
4. **Q4：能触发 `Union`**，对应 `Using union(idx_key1,idx_key_part)`。`OR` 两侧分支中，左侧单列索引等值匹配满足 ROR；右侧联合索引三列全部等值固定，同值槽内亦按末尾附加的 `id` 严格升序排列，同样满足 ROR，故可直接流式归并去重。
5. **Q5：能触发 `Sort-Union`**，对应 `Using sort_union(idx_key1,idx_key3)`。`OR` 两侧均为窄范围扫描，分支内部 `id` 无序，不满足 `Union` 的 ROR 条件，但满足 `Sort-Union`：执行器先对两路扫描出的 `id` 分别排序，再归并去重回表，避免退化为全表扫描 `ALL`。

</details>

### 练习 2：对比左外连接条件置于 ON 与 WHERE 的结果集与算子差异

已知表 `t1(id PK, a, b, INDEX idx_a(a))` 含 `200` 行，表 `t2(id PK, a, c, b, INDEX idx_a(a))` 含 `5000` 行，其中 `t2.c` 与 `t2.b` 均无索引。设 `t2` 满足 `b = 't2_1'` 的记录共 `1` 行，且该行的 `c` 值恰好能在 `t1.a` 中匹配到 `4` 行。请分别推导以下两条 SQL 的**最终返回行数**与 MySQL 8.4 下的**物理连接算子及驱动表顺序**：

```sql
-- SQL 1
SELECT * FROM t1 LEFT JOIN t2 ON t1.a = t2.c AND t2.b = 't2_1';
-- SQL 2
SELECT * FROM t1 LEFT JOIN t2 ON t1.a = t2.c WHERE t2.b = 't2_1';
```

<details>
<summary>查看参考答案</summary>

1. **SQL 1 返回 `200` 行，采用 `Left hash join`**：
   - **结果集**：左外连接保证左表 `t1` 的 `200` 行全部保留；其中 `4` 行与满足 `t2.b = 't2_1'` 的记录配对成功，其余 `196` 行配对失败但仅将 `t2` 各列补 `NULL` 输出，总行数仍为 `4 + 196 = 200` 行。
   - **执行算子**：因必须保留 `t1` 失配行，不能将 `t2` 翻转为外层驱动表去查 `t1.idx_a`，而 `t2.c` 无索引，故优化器选用 **`Left hash join`**——先扫描 `t2` 过滤 `t2.b = 't2_1'` 构建内存哈希表，再扫描 `t1` 探测匹配并补 `NULL`。
2. **SQL 2 返回 `4` 行，被消除为内连接并翻转为 `INLJ`**：
   - **结果集**：`WHERE t2.b = 't2_1'` 是空值拒绝条件，所有补 `NULL` 的 `196` 行算得 `NULL = 't2_1'` 为 `UNKNOWN` 而被剔除，仅剩配对成功的 `4` 行。
   - **执行算子**：优化器自动执行外连接消除将其等价改写为 `INNER JOIN`；随后利用内连接交换律翻转表顺序，改以过滤后的 `t2` 为驱动表，探测 `t1` 上的二级索引 `idx_a(a)` 执行 **`Nested loop inner join`**（INLJ），避免了无索引全量哈希探测。

</details>

## 面试题 {#ch5-interview}

以下 3 道面试题聚焦单表访问方法退化边界、Hash Join 架构演进与连接驱动表选型准则。建议先独立作答，再展开核对参考答案。

### 面试题 1：唯一二级索引等值查询的访问方法边界

对声明了 `UNIQUE KEY uk_code (code)` 的 InnoDB 表执行等值查询，`EXPLAIN` 的 `type` 列一定是 `const` 吗？请给出反例并解释原因。

<details>
<summary>查看参考答案</summary>

**不一定。** 存在两类典型退化反例：

1. **查询 `WHERE code IS NULL` 会退化为 `ref`**：SQL 标准与 InnoDB 均规定 `UNIQUE` 唯一索引不限制 `NULL` 值的重复次数，表中可同时存在多行 `code IS NULL` 的记录。优化器无法在编译期断定最多命中 1 行，故不能使用 `const`，只能按普通单点区间 `[NULL, NULL]` 执行 `ref` 访问；唯有 `PRIMARY KEY` 或声明为 `NOT NULL UNIQUE` 的列永无此退化。
2. **发生隐式类型或字符集转换时退化为 `index` 或 `ALL`**：例如 `code` 为 `VARCHAR` 列却传入整型字面量 `WHERE code = 100`，等价于对索引列套函数 `CAST(code AS DOUBLE) = 100`，破坏了 B+ 树有序性，导致唯一索引无法定位区间。

</details>

### 面试题 2：Hash Join 取代 BNL 的核心原因与 join_buffer_size 职责

为什么 MySQL 8.0.20 彻底移除了沿用多年的 Block Nested-Loop（BNL）算法并用 Hash Join 取而代之？升级到 MySQL 8.4 后，参数 `join_buffer_size` 还起作用吗？

<details>
<summary>查看参考答案</summary>

1. **取代 BNL 的核心原因**：传统 BNL 只优化了被驱动表的磁盘扫描次数——把驱动表分块塞入缓冲区——却没有优化内存比对算法，每读一行被驱动表记录仍需对缓冲区内所有记录做线性遍历，总 CPU 比较次数仍高达 `O(M × N)`。Hash Join 则对小表（Build 端）建立内存哈希表，使大表（Probe 端）每行仅需 `O(1)` 哈希查找即可完成匹配，将总时间复杂度降至 `O(M + N)`；且自 8.0.20 起已全面覆盖等值/非等值内连接、外连接、半连接与反连接。
2. **`join_buffer_size` 依然是核心内存控制参数**：在 MySQL 8.0.18+ / 8.4 中，每个 Hash Join 算子分配的内存哈希表上限直接由 `join_buffer_size`（默认 `256 KiB`）决定。当 Build 端投影列体积可完全装入该预算时，全程纯内存单遍完成；一旦超出该上限，算子便触发 Grace Hash Join 磁盘分片溢出，适当调大复杂分析会话的 `join_buffer_size` 可显著避免临时文件读写。

</details>

### 面试题 3：“小表驱动大表”中“小”的真实度量标准

日常 SQL 调优常说“小表驱动大表”，这里的“小”是指表的总行数 `COUNT(*)` 少，还是磁盘 `.ibd` 文件体积小？请分别针对 INLJ 与 Hash Join 说明准确定义。

<details>
<summary>查看参考答案</summary>

**既不是全表总行数，也不是 `.ibd` 文件总大小，而是指“经过单表 `WHERE` 条件过滤并完成列裁剪后的有效结果集规模”。** 具体因连接算子而异：

1. **在 INLJ 下，“小”指过滤后的扇出记录数（`rows × filtered%`）少**：驱动表扇出 `F` 直接决定被驱动表 B+ 树的下潜查找次数。哪怕一张千万行大表经索引过滤后只剩 `5` 行，而另一张千行小表过滤后剩 `500` 行，也应当由千万行大表（有效扇出 `5`）做驱动表，仅触发 `5` 次 `eq_ref` / `ref` 查找。
2. **在 Hash Join 下，“小”指过滤后参与连接的投影列总字节数小**：即 `有效行数 × 所需列字节宽` 更小。Hash Join 选择有效字节体积更小的一侧作为 Build 输入构建哈希表，以便尽可能完整装入 `join_buffer_size` 内存，避免触发磁盘分片溢出；因此绝不要写 `SELECT *` 把无用的大文本列一并塞进哈希表。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: EXPLAIN Join Types (Single-Table & Join Access Methods)](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html#explain-join-types)
- [MySQL 8.4 Reference Manual: Multi-Range Read Optimization](https://dev.mysql.com/doc/refman/8.4/en/mrr-optimization.html)
- [MySQL 8.4 Reference Manual: Index Merge Optimization](https://dev.mysql.com/doc/refman/8.4/en/index-merge-optimization.html)
- [MySQL 8.4 Reference Manual: Nested-Loop Join Algorithms](https://dev.mysql.com/doc/refman/8.4/en/nested-loop-joins.html)
- [MySQL 8.4 Reference Manual: Hash Join Optimization](https://dev.mysql.com/doc/refman/8.4/en/hash-joins.html)
