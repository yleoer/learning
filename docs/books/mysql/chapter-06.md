---
title: 第 6 章 统计信息、成本模型与查询重写优化
description: 剖析 InnoDB 持久化统计与列直方图，掌握内存命中率加权成本模型、多表连接剪枝及子查询半连接与反连接重写规则。
---

# 第 6 章 统计信息、成本模型与查询重写优化

## 本章要点

同一条 SQL 往往同时具备全表扫描、二级索引范围扫描与多种连接顺序等数十种可行执行方案，决定最终胜出计划的是 MySQL 查询优化器的两大核心引擎——**基于成本的优化**（CBO）与**基于规则的重写**（RBO）。本章首先剖析 InnoDB 持久化统计信息、MySQL 8.0+ 字典统计缓存陷阱与无索引列直方图（Histograms），接着对比 MySQL 5.7 与 8.0/8.4 的成本常数演进，推演基于 Buffer Pool 内存命中率加权的单表及连接成本公式与 `eq_range_index_dive_limit` 退化边界，最后系统梳理外连接消除、派生表条件下推、半连接（Semi-join）五大物理策略、反连接（Anti-join）以及生产高频踩坑的 `NOT IN` 空值陷阱。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 6.1 InnoDB 持久化统计信息与列直方图 {#ch6-1}

优化器不可能在编译 SQL 时把整张表扫一遍来计算行数，而是依赖存储引擎维护的统计数据。InnoDB 默认启用 `innodb_stats_persistent = ON`，将表级与索引级统计持久化保存在 `mysql` 系统库的两张 InnoDB 表中：

| 持久化统计表 | 核心统计项（`stat_name` / 列名） | 物理含义与估算用途 |
| --- | --- | --- |
| `mysql.innodb_table_stats` | `n_rows` | 按随机采样叶子页推算的全表估计总行数 |
| `mysql.innodb_table_stats` | `clustered_index_size` | 聚簇索引占用的总页面数，包含叶子页与内节点页 |
| `mysql.innodb_table_stats` | `sum_of_other_index_sizes` | 除聚簇索引外其余全部二级索引占用的总页面数之和 |
| `mysql.innodb_index_stats` | `size` / `n_leaf_pages` | 单个索引占用的总页数 / 叶子节点页数 |
| `mysql.innodb_index_stats` | `n_diff_pfx01`、`n_diff_pfx02`... | 索引前 `1` 列、前 `2` 列……组合的不重复键值基数（Cardinality） |

查看 `mysql.innodb_index_stats` 时有一处关键结构细节：**普通二级索引比同列数的唯一二级索引多出一项主键后缀 `n_diff_pfx`**，因为普通二级索引必须拼接主键 `id` 才能唯一确定记录，详见 [4.1 节](./chapter-04#ch4-1)。在 MySQL 8.4.13 中查询 [5.1 节](./chapter-05#ch5-1) 的 `single_table` 可直接印证：

```sql
SELECT index_name, stat_name, stat_value, stat_description
FROM mysql.innodb_index_stats
WHERE database_name = 'verify_ch05_06' AND table_name = 'single_table'
  AND index_name IN ('uk_key2', 'idx_key1') AND stat_name LIKE 'n_diff%';
-- uk_key2  | n_diff_pfx01 | 9998  | key2       （唯一索引仅统计索引列自身）
-- idx_key1 | n_diff_pfx01 | 20    | key1       （普通索引第 1 前缀为 key1）
-- idx_key1 | n_diff_pfx02 | 10000 | key1,id    （普通索引自动追加 id 作为第 2 前缀）
```

此外，参数 `innodb_stats_method` 控制统计基数时如何对待 `NULL` 值：默认 `nulls_equal` 将所有 `NULL` 视为同一个值，避免大量空值虚增基数误导优化器选错索引；`nulls_unequal` 将每个 `NULL` 视为独立值；`nulls_ignored` 则直接忽略 `NULL`。

统计信息的采样精度、更新时机与 MySQL 8.0+ 字典缓存行为遵循以下规则：

1. **采样页数与更新触发**：`innodb_stats_persistent_sample_pages` 默认为 `20` 页，随机抽取 20 个叶子页估算均值；当 `innodb_stats_auto_recalc` 保持默认 `ON` 且表自上次统计以来增删改行数超过总行数的 **`10%`** 时，后台线程**异步**重算统计表。若需在批量导入数据后**同步立即**刷新，应显式执行 `ANALYZE TABLE tbl`。
2. **MySQL 8.0+ / 8.4 的 24 小时统计缓存陷阱**：自 MySQL 8.0 起新增系统变量 **`information_schema_stats_expiry`**，默认值为 **`86400` 秒**（即 24 小时）。查询 `information_schema.TABLES`、`STATISTICS` 或执行 `SHOW TABLE STATUS`、`SHOW INDEX` 时，Server 层会直接返回内存缓存快照，即使刚插入百万行数据也显示旧行数！排障时须先运行 `ANALYZE TABLE tbl` 使缓存失效，或在当前会话执行 `SET SESSION information_schema_stats_expiry = 0` 直读最新引擎统计。

持久化索引统计只能描述**已建索引列前缀**的平均重复度，面对**无索引过滤列**或**严重数据倾斜列**，优化器过去只能盲猜固定选择率——例如等值条件一律按 `10%` 估算、开区间范围按 `33.33%` 估算，极易在大表连接中选错驱动表。为此，MySQL 8.0 引入了轻量级的**列直方图**（Column Histograms）：

```sql
-- 创建 5000 行倾斜表：status = 9 仅 10 行（占 0.20%），其余 4990 行全为 status = 1
-- 未建直方图前，EXPLAIN 盲猜 filtered = 10.00（严重高估为 500 行）
EXPLAIN SELECT * FROM orders_skew WHERE status = 9;
-- rows: 5000 | filtered: 10.00

-- 为无索引列构建 16 桶直方图；AUTO UPDATE（MySQL 8.4.0+ 新增）使其随常规 ANALYZE TABLE 或后台统计重算自动更新
ANALYZE TABLE orders_skew UPDATE HISTOGRAM ON status, amount WITH 16 BUCKETS AUTO UPDATE;

-- 构建直方图后，优化器算出 filtered = 0.20（5000 × 0.20% = 10 行）
EXPLAIN SELECT * FROM orders_skew WHERE status = 9;
-- rows: 5000 | filtered: 0.20
```

直方图统计以 JSON 格式存储在字典视图 `information_schema.COLUMN_STATISTICS` 中，桶数范围 `1..1024`（默认 `100`），引擎根据列不同值个数 `D` 与指定桶数 `B` 的关系自动选择以下两种物理形态之一：

| 直方图类型 | 自动选型条件 | 桶内数据结构与估算精度 | 上例实测对应列 |
| --- | --- | --- | --- |
| **单值直方图**（`singleton`） | `D ≤ B` | 每个桶对应 1 个离散值及其累积频率；全量采样且数据未漂移时点查估算精度很高，但大表超内存上限时会抽样构建且可能随写入过时，**不保证绝对精确** | `status`（`2 ≤ 16`） |
| **等高直方图**（`equi-height`） | `D > B` | 将排序后的数据按大致相等行数切进 `B` 个闭区间桶，记录桶上下界与不同值数，桶内按均匀分布近似 | `amount`（`1000 > 16`） |

与 B+ 树索引相比，直方图**不加速物理查找，但对日常 `INSERT`/`UPDATE`/`DELETE` 零实时维护开销**，专为高频过滤却不宜建索引的倾斜列修正扇出估算。需要注意两点精度边界：① 构建直方图的内存上限受 `histogram_generation_max_mem_size`（默认 `20 MiB`）限制，大表超出上限时会自动降级为抽样统计（`COLUMN_STATISTICS` 中 `"sampling-rate" < 1`），可能遗漏低频值或产生抽样误差；② 直方图不会随每次 DML 实时同步，数据持续变更后会逐渐过时。若创建时未指定 **MySQL 8.4.0+** 新增的 `AUTO UPDATE`，默认 `MANUAL UPDATE` 直方图不会随常规 `ANALYZE TABLE` 或 InnoDB 后台统计自动重算，须手动再次执行 `UPDATE HISTOGRAM` 刷新；废弃时通过 `ANALYZE TABLE tbl DROP HISTOGRAM ON col` 删除。

## 6.2 基于成本的优化模型（CBO）与连接剪枝 {#ch6-2}

### 6.2.1 现代成本常数（内存命中率加权）与单表成本估算 {#ch6-2-1}

MySQL 将一条 SQL 的执行开销拆解为 **I/O 成本**（页面读取）与 **CPU 成本**（记录条件评估、键值比较、临时表读写），由 `mysql.server_cost` 与 `mysql.engine_cost` 两张配置表量化。原书基于 MySQL 5.7 展开手算；而在 **MySQL 8.0 与 8.4 LTS** 中，默认成本常数与页面计费模型发生了本质升级：

| 所属成本表 | 成本常数名称（`cost_name`） | MySQL 5.7 默认值 | MySQL 8.0 / 8.4 默认值 | 物理含义 |
| --- | --- | --- | --- | --- |
| `server_cost` | `row_evaluate_cost` | `0.2` | **`0.1`** | 检测 1 条记录是否满足 `WHERE` 条件的 CPU 成本 |
| `server_cost` | `key_compare_cost` | `0.1` | **`0.05`** | 排序或归并时比较 2 个键值的 CPU 成本 |
| `server_cost` | `memory_temptable_create_cost` | `2.0` | **`1.0`** | 创建 1 张内存临时表的固定成本 |
| `server_cost` | `memory_temptable_row_cost` | `0.2` | **`0.1`** | 内存临时表读写 1 条记录的成本 |
| `server_cost` | `disk_temptable_create_cost` | `40.0` | **`20.0`** | 创建 1 张磁盘临时表的固定成本 |
| `server_cost` | `disk_temptable_row_cost` | `1.0` | **`0.5`** | 磁盘临时表读写 1 条记录的成本 |
| `engine_cost` | `io_block_read_cost` | `1.0` | **`1.0`** | 从磁盘读取 1 个 16KB 页的 I/O 成本 |
| `engine_cost` | `memory_block_read_cost` | `1.0` | **`0.25`** | 从 Buffer Pool 内存读取 1 个 16KB 页的成本 |

最核心的架构进步在于 **`memory_block_read_cost` 从 `1.0` 降至 `0.25`**。MySQL 5.7 无法区分页面在内存还是磁盘，一律按 `1.0` 计费；而在 MySQL 8.0 / 8.4 中，InnoDB 会实时向优化器上报目标索引页驻留在 Buffer Pool 中的比例 `in_memory ∈ [0, 1]`，详见 [3.3 节](./chapter-03#ch3-3)，单页综合读取成本按如下加权公式动态计算：

```text
单页读取成本 = in_memory × 0.25 + (1 - in_memory) × 1.0
全表扫描总成本 ≈ 聚簇索引页数 × 单页读取成本 + 估计总行数 × 0.1
```

以 [6.1 节](#ch6-1) 刚写入内存的 `orders_skew` 表为例，`innodb_table_stats` 记录其 `clustered_index_size = 14` 页、`n_rows = 5000` 行，且页面 100% 驻留 Buffer Pool（`in_memory = 1.0`）：此时页面读取成本为 `14 × 0.25 = 3.50`，全表行评估成本为 `5000 × 0.1 = 500.00`，合计 **`503.50`**——在 MySQL 8.4.13 中执行 `EXPLAIN FORMAT=JSON` 实测输出的 `query_cost` 恰好就是 `"503.50"`，分毫不差。

估算二级索引 `range` 或 `ref` 扫描成本时，最关键的一步是预估扫描区间内的记录条数，以推算需回表读取多少个聚簇索引页。针对非唯一索引上的等值范围比较（如 `IN (v1, v2, ...)` 或多个等值 `OR` 条件），优化器按参数 **`eq_range_index_dive_limit`**（默认 **`200`**，设为 `0` 表示始终下潜）切分两条估算路径：

1. **索引下潜估算**（Index Dive）：对于普通范围区间（如 `a > 10 AND a < 50`）或等值范围个数 **`< 200`** 的 `IN` 列表，优化器沿着 B+ 树对每个区间分别定位左、右边界记录，据此**估算**区间内包含的记录数（InnoDB 通过 `btr_estimate_n_rows_in_range` 推算，并非逐行精确计数；但在数据倾斜时仍远比表级索引均值贴近真实分布）。
2. **切换为索引统计信息估算**：一旦非唯一索引上的等值范围达到或超过 **`200` 个**，逐一做数百次 B+ 树下潜的编译期开销过高，优化器便跳过 Index Dive，改用索引统计信息（如基于 `n_rows ÷ n_diff_pfx01` 推算的平均单值行数乘以等值范围个数）进行近似估算。注意：**超过 200 并不必然导致全表扫描**——最终选择索引还是全表扫描仍由优化器成本模型比较决定；只是当列数据严重倾斜或统计信息失真时（例如 `orders_skew.status` 共 `5000` 行但仅 `2` 个不同值，统计均值高达 `2500` 行，查询 `200` 个冷门状态码实际仅命中寥寥数行），估算出的回表成本会被大幅高估，**退化为全表扫描 `ALL` 的风险随之剧增**。此外，针对单点 `ref` 回表成本，优化器设有页面上限保护：估算回表读取的聚簇索引页数最多不超过全表聚簇索引总页数，防止极端重复值算出的回表 I/O 失真。

### 6.2.2 连接查询总成本公式与多表搜索剪枝 {#ch6-2-2}

对于两表嵌套循环连接，驱动表只访问 `1` 次，而被驱动表会被重复探测“驱动表有效输出行数”次。因此优化器评估特定连接顺序的总成本公式为：

```text
驱动表扇出数（Fanout） = 驱动表扫描行数 rows × 条件过滤比 filtered%
两表连接总成本 = 单次访问驱动表成本 + 驱动表扇出数 × 单次访问被驱动表成本
```

公式中的 **扇出**（Fanout）由两部分共同决定：先由选定索引的扫描区间估算出 `rows`，再由条件过滤机制——默认开启 `condition_fanout_filter=on`——综合驱动表上其余未走索引的 `WHERE` 条件，依次尝试利用其他索引基数、列直方图或启发式规则折算出存活比例 `filtered%`。可见连接优化的重心有两个：**尽量压低驱动表扇出数**，以及**在被驱动表连接列上建立高区分度索引压低单次被驱动访问成本**。

当 `N` 张表做内连接时，理论连接顺序多达 `N!` 种：`5` 张表有 `120` 种，`10` 张表则暴涨至 `3,628,800` 种。为防止优化器耗尽编译时间，MySQL 设有两项关键剪枝参数：

- **`optimizer_search_depth`**（默认 `62`）：控制贪心搜索每次向下前瞻的表数上限。当连接表数小于该值时按完整深度搜索，当表数极多时适当调小可避免优化耗时失控。
- **`optimizer_prune_level`**（默认 `1`，开启剪枝）：搜索过程中一旦发现某条局部连接路径的累计前缀成本，已经大于当前找到的某条完整连接方案成本，立即剪除该分支下的整棵排列子树，在毫秒级内收敛出近似最优解。若极个别复杂 SQL 需要人工锁死连接顺序，可使用 `STRAIGHT_JOIN` 或优化器提示 `/*+ JOIN_ORDER(t1, t2, t3) */`，详见 [7.3 节](./chapter-07#ch7-3)。

## 6.3 基于规则的重写、半连接与反连接优化 {#ch6-3}

### 6.3.1 条件化简、外连接消除与派生表条件下推 {#ch6-3-1}

在投入成本计算前，优化器会先依据关系代数等价律改写查询树，剥离低效语法外壳：

1. **条件化简与常量传递**：自动剥离多余嵌套括号；对 `a = 5 AND b > a` 执行**常量传递**（Constant Propagation）改写为 `a = 5 AND b > 5`，使列 `b` 也能顺利构造索引范围区间；对 `1 = 0` 或超出列类型上限的死条件直接短路返回空集，免除存储引擎访问。
2. **外连接消除**（Outer-Join Elimination）：如 [5.3 节](./chapter-05#ch5-3) 实测所示，只要 `WHERE` 子句中含有使被驱动表全 `NULL` 行必然不为 `TRUE` 的**空值拒绝**（`reject-NULL`）条件——例如 `t2.b = 'x'` 或 `t2.id IS NOT NULL`——外连接在语义上就与内连接严格等价。优化器会自动将其消除为内连接，从而自由交换表顺序挑选更小驱动表或可用索引。
3. **派生表合并与派生表条件下推**（MySQL 8.0.22+）：`FROM (SELECT ...) AS dt` 定义的子查询称为派生表。默认开启 `derived_merge=on` 时，不含聚合操作、简单投影过滤的派生表或视图会直接合并进外层查询，省去临时表物化开销。一旦派生表内含 **`GROUP BY`、聚合函数、`DISTINCT`、`LIMIT`、`UNION` 或窗口函数**，就无法直接合并。在旧版本中，引擎只能先把整张底表全部扫描聚合塞进临时表，再应用外层 `WHERE` 过滤；自 **MySQL 8.0.22** 起默认开启 `derived_condition_pushdown=on`，可将外层过滤条件自动穿透进未合并派生表：引用分组列的条件直接下推至内层 **`WHERE`**，引用聚合计算结果的条件则下推至内层 **`HAVING`**——但若派生表内含 `LIMIT`，提前过滤会改变截取集合，优化器将自动阻止下推。在 MySQL 8.4.13 中对 `5000` 行表 `t2` 实测效果如下：

```sql
-- 外层同时过滤分组列 dt.a 与聚合列 dt.total_c：
EXPLAIN FORMAT=TREE
SELECT * FROM (SELECT a, SUM(c) AS total_c FROM t2 GROUP BY a) AS dt
WHERE dt.a > 490 AND dt.total_c > 1000;

-- MySQL 8.4 实测执行树（dt.a > 490 穿透为内层索引范围扫描，dt.total_c > 1000 穿透为聚合后 Filter）：
-- -> Table scan on dt  (cost=58.8..62.4 rows=90)
--     -> Materialize  (cost=58.8..58.8 rows=90)
--         -> Filter: (sum(t2.c) > 1000)  (cost=49.8 rows=90)
--             -> Group aggregate: sum(t2.c)  (cost=49.8 rows=90)
--                 -> Index range scan on t2 using idx_a over (490 < a), with index condition: (t2.a > 490)
```

对比关闭下推时全表扫 `5000` 行聚合 `500` 组的高昂代价（实测 `cost = 1054`），条件下推直接解锁内层 `idx_a` 范围扫描，总成本骤降至 `58.8`。

此外，MySQL 8.0+ 补齐了三项可替代复杂多层子查询的现代语法特性：

| 现代 SQL 特性 | 引入版本 | 优化器处理机制与最佳工程场景 |
| --- | --- | --- |
| **公用表表达式** `WITH [RECURSIVE]` | `8.0.1` | 单次引用的非递归 CTE 自动走 `derived_merge` 或条件下推；多次引用仅物化 1 次供多处复用；`RECURSIVE` 原生遍历树形层级 |
| **横向派生表** `LATERAL` | `8.0.14` | 允许 `FROM` 右侧派生表引用左侧同级表列，每取 1 行左表记录即用索引 + `LIMIT K` 局部查出每组 Top-K，免于全表排序 |
| **窗口函数** `OVER (...)` | `8.0.2` | 单趟分组排序完成 `ROW_NUMBER()`、`RANK()`、滑动汇总等分析计算，消除昂贵的自连接计数子查询 |

例如查询前 3 个分组各自 `c` 最大的 2 条记录，利用 `LATERAL` 可精准驱动内层索引下潜 `3` 次而非全表窗口排序：

```sql
SELECT t1.id, top2.id AS t2_id, top2.c
FROM t1 JOIN LATERAL (
    SELECT id, c FROM t2 WHERE t2.a = t1.a ORDER BY c DESC LIMIT 2
) AS top2 WHERE t1.id <= 3;
```

### 6.3.2 半连接（Semi-join）五大策略、反连接与 NOT IN 空值陷阱 {#ch6-3-2}

初学者常把 `WHERE t1.a IN (SELECT t2.a FROM t2 ...)` 理解成“先执行子查询，再逐行过滤”。若按字面执行，相关子查询需随外层每行反复重跑，不相关子查询也难以利用外层与内层双向索引。优化器的破局之道是引入关系代数中的**半连接**（Semi-join）：对于外层表 `t1` 而言，它并不关心 `t2` 里匹配了几行，只关心 **`t2` 中是否存在至少 1 行与之匹配**；只要将 `IN` / `EXISTS` 子查询提升为半连接，就能纳入多表连接优化框架统一挑选驱动顺序，同时必须保证**绝不因 `t2` 有多条重复匹配而把 `t1` 的记录重复输出**。

只要 `IN` 或 `EXISTS` 位于顶层 `WHERE` / `ON` 的 `AND` 分支，且无 `OR` 缠绕或 `GROUP BY` 配 `LIMIT` 等阻碍，开启 `semijoin=on` 后优化器便会按成本在以下**五大物理半连接去重策略**中择优执行：

| 半连接策略 | 核心去重与执行机制 | 适用前提或优势场景 | `EXPLAIN` 识别特征 |
| --- | --- | --- | --- |
| **Table pullout**（表上拉） | 直接将子查询表上拉为与外层表的普通内连接 | 子查询连接键是**主键或唯一二级索引**，天然最多匹配 1 行，零去重开销 | 无特殊 `Extra`；`SHOW WARNINGS` 可见已改写为普通 `join` |
| **DuplicateWeedout**（临时表去重） | 正常执行连接，每产出一行就把外层表主键值插入临时表，插入成功才输出 | 通用兜底策略，不苛求连接列有序或唯一 | `Extra` 成对出现 `Start temporary` 与 `End temporary` |
| **LooseScan**（松散索引扫描） | 由子查询表做驱动表，扫描其连接列二级索引时**相同键值只取第一条记录**去关联外层表 | 子查询连接列具备二级索引，且重复值较多 | 子查询表 `Extra` 出现 `LooseScan` |
| **Materialization**（半连接物化） | 先将不相关子查询结果集去重写入带自动唯一索引的内存/磁盘物化表 `<subqueryN>`，再与外层表内连接 | 不相关子查询，且去重后基数较小，支持双向选驱动表 | `table` 列出现 `<subqueryN>`，并新增 `select_type = MATERIALIZED` 行 |
| **FirstMatch**（首次匹配短路） | 外层表驱动子查询表，在内层索引中匹配到**第 1 条**合规记录后立即短路停止，跳向下一条外层记录 | 外层扇出小、内层连接列有索引 | 子查询表 `Extra` 出现 `FirstMatch(outer_tbl)` |

补充说明：在 MySQL 8.0.18+ 无索引场景下，半连接还可直接交由哈希连接引擎执行 **`Hash semijoin`**，在探测或构建阶段顺带完成哈希去重。在 MySQL 8.4.13 中使用 `SEMIJOIN` 优化器提示可实测对比各半连接策略在 `EXPLAIN` 中的精确标识：

```sql
-- 1. Table pullout：子查询关联 uk_key2 唯一索引，直接上拉为两表内连接
EXPLAIN SELECT * FROM t1 WHERE t1.id IN (SELECT key2 FROM single_table WHERE key2 < 500);
-- table: single_table (range) -> t1 (eq_ref PRIMARY) | SHOW WARNINGS 可见已改写为普通 join

-- 2. Materialization（默认）：物化去重生成 <subquery2> 临时表并建立 <auto_distinct_key>
EXPLAIN SELECT * FROM t1 WHERE t1.a IN (SELECT t2.a FROM t2 WHERE t2.id < 500);
-- id=1: t1 (ALL) -> <subquery2> (eq_ref <auto_distinct_key>) | id=2: select_type=MATERIALIZED, table=t2

-- 3. DuplicateWeedout / LooseScan / FirstMatch 标识对比：
-- /*+ SEMIJOIN(@s DUPSWEEDOUT) */ -> t2 Extra: Using where; Using index; Start temporary; End temporary
-- /*+ SEMIJOIN(@s LOOSESCAN)   */ -> t2 Extra: Using where; Using index; LooseScan (t2 做驱动表)
-- /*+ SEMIJOIN(@s FIRSTMATCH)  */ -> t2 Extra: Using where; Using index; FirstMatch(t1)
```

与半连接相对，求“不存在匹配项”的逻辑自 **MySQL 8.0.17** 起正式支持重写为**反连接**（Anti-join），其树形执行计划显示为 `Nested loop antijoin` 或 `Hash antijoin`，覆盖 `NOT EXISTS (...)`、外连接配 `WHERE inner_pk IS NULL` 反筛选，以及**两侧表达式均声明为 `NOT NULL` 的 `NOT IN (...)`**。

> [!WARNING]
> **生产铁律：严禁在可空列上使用 `NOT IN` 子查询，一律改用 `NOT EXISTS`！** 这背后潜藏着“结果全空”与“执行计划降级”双重灾难。

通过 MySQL 8.4.13 实测可直观复现 `NOT IN` 的空值陷阱。设 `users_demo` 含 `(1, 10), (2, 20), (3, 30)`，黑名单表 `blacklist_demo(id PK, code INT NULL)` 含 `(1, 10)` 与 **`(2, NULL)`**：

```sql
-- 灾难写法：blacklist_demo 混入 1 行 NULL 后，结果集直接变成 0 行（Empty set）！
SELECT * FROM users_demo WHERE code NOT IN (SELECT code FROM blacklist_demo);
-- Empty set (0.00 sec)

-- 正确写法：使用 NOT EXISTS，准确返回 (2, 20) 与 (3, 30)，且底层自动走高效 Hash antijoin！
SELECT * FROM users_demo u WHERE NOT EXISTS (SELECT 1 FROM blacklist_demo b WHERE b.code = u.code);
-- 返回 2 行：(2, 20), (3, 30)
-- EXPLAIN FORMAT=TREE: -> Hash antijoin (b.`code` = u.`code`)
```

根因来自 SQL 三值逻辑——即 `TRUE`、`FALSE` 与 `UNKNOWN`：

1. **语义全空灾难**：`code NOT IN (10, NULL)` 等价展开为 `code <> 10 AND code <> NULL`。代入 `code = 20` 时，`20 <> 10` 为 `TRUE`，但任何值与 `NULL` 比较（`20 <> NULL`）结果恒为 `UNKNOWN`；在逻辑与运算中 `TRUE AND UNKNOWN` 仍得 **`UNKNOWN`**！而 `WHERE` 子句只放行求值为 `TRUE` 的行，导致**只要子查询结果里混入哪怕一行 `NULL`，外层所有记录全军覆没，返回 0 行**。而 `EXISTS` 子查询返回的是布尔存在性判断，匹配不到任何 `TRUE` 行即判为不存在，天然免疫 `NULL` 干扰。
2. **优化器降级灾难**：MySQL 8.4 实测表明，哪怕 `blacklist_demo` 当前没有任何 `NULL` 数据——甚至你在子查询内手动加了 `WHERE code IS NOT NULL`——只要 `code` 列的表结构元数据允许为 `NULL`，优化器为了维护 `NOT IN` 严格的三值语义，**依然拒绝将其重写为 `antijoin`**，被迫退化为挂载 `<is_not_null_test>` 探针的 `dependent` 相关子查询逐行探测；唯有字段本身声明为 `NOT NULL` 或改写为 `NOT EXISTS`，才能无条件解锁 `Hash antijoin` 与 `Nested loop antijoin`。

## 练习 {#ch6-exercises}

以下 2 道练习分别检验运用列直方图纠正无索引倾斜列导致的连接顺序反转，以及综合判读派生表条件下推边界与半连接物理策略。建议先独立分析，再展开核对参考答案。

### 练习 1：利用列直方图修复无索引倾斜列的连接驱动顺序

现有订单表 `p_orders(id PK, user_id INT, flag TINYINT NOT NULL, payload CHAR(100))` 共 `2000` 行，无二级索引，其中 `flag = 9` 的异常订单仅 **`5` 行**（占 `0.25%`），其余 `1995` 行均为 `flag = 1`；另有订单日志表 `p_logs(id PK, order_id INT NOT NULL, msg VARCHAR(50), INDEX idx_oid(order_id))` 共 `600` 行，每个 `order_id` 平均对应 `3` 条日志。执行如下连接查询：

```sql
SELECT * FROM p_orders o JOIN p_logs l ON o.id = l.order_id WHERE o.flag = 9;
```

1. 未创建直方图前，优化器为何错误选择 `p_logs`（`600` 行）做驱动表去执行 `600` 次主键回表，而不选有效记录仅 `5` 行的 `p_orders` 做驱动表？
2. 若在不宜为低频后台查询新增索引的前提下修复该计划，请写出支持随 `ANALYZE TABLE` 自动维护的直方图创建语句，并说明创建后两表的驱动顺序、`filtered` 值与被驱动表访问方法如何变化。

<details>
<summary>查看参考答案</summary>

1. **未建直方图前的误判根因**：`o.flag` 列无索引且无直方图，优化器对等值条件 `o.flag = 9` 只能套用固定启发式选择率 **`filtered = 10.00%`**，将 `p_orders` 的扇出严重高估为 `2000 × 10% = 200` 行；按该估算若由 `o` 驱动 `l`，除全表扫 `2000` 行外还需对 `l.idx_oid` 发起 `200` 次 `ref` 查找（约 `600` 行回表），总成本高于由 `l` 全表扫 `600` 行并对 `o.PRIMARY` 发起 `600` 次 `eq_ref` 查找，故误选 `l` 为驱动表。
2. **构建自动更新直方图及计划翻转结果**：

   ```sql
   ANALYZE TABLE p_orders UPDATE HISTOGRAM ON flag WITH 16 BUCKETS AUTO UPDATE;
   ```

   因 `flag` 仅含 `2` 个离散值（`≤ 16`），MySQL 自动生成 **`singleton`** 单值直方图，并在 **MySQL 8.4.0+** 下标记 `"auto-update": true`（本例表仅 `2000` 行，全量采样 `"sampling-rate": 1.0`）。此后再次执行 `EXPLAIN`，`o` 表的 `filtered` 修正为 **`0.25`**，对应扇出 `2000 × 0.25% = 5` 行，优化器立即将驱动顺序翻转为 **`o` 驱动 `l`**：全扫内存中的 `o` 表筛出 `5` 行后，仅对 `l.idx_oid` 执行 **`5` 次 `ref` 查找**即可收尾。

</details>

### 练习 2：判读聚合派生表条件下推边界与半连接执行策略

基于 `t1(id PK, a, b, INDEX idx_a(a))`（`200` 行）与 `t2(id PK, a, c, b, INDEX idx_a(a))`（`5000` 行），回答以下两个执行计划问题：

1. 对比下列 SQL A 与 SQL B 在 MySQL 8.4 默认配置下的执行过程：哪些外层条件能下推至派生表内部的什么位置？哪条 SQL 无法触发条件下推，为什么？

```sql
-- SQL A
SELECT * FROM (SELECT a, SUM(c) AS total_c FROM t2 GROUP BY a) AS dt
WHERE dt.a > 490 AND dt.total_c > 1000;

-- SQL B
SELECT * FROM (SELECT a, SUM(c) AS total_c FROM t2 GROUP BY a ORDER BY a LIMIT 495) AS dt
WHERE dt.a > 490;
```

2. 对子查询 `SELECT * FROM t1 WHERE t1.a IN (SELECT t2.a FROM t2)`，若某次 `EXPLAIN` 显示 `t2` 为驱动表且其 `Extra` 含 `Using index; LooseScan`，请简述执行器是如何保证 `t1` 结果不重复的。

<details>
<summary>查看参考答案</summary>

1. **SQL A 与 SQL B 的派生表条件下推对比**：
   - **SQL A 两个条件均成功下推，但落点不同**：`dt.a > 490` 仅依赖分组列 `a`，直接穿透至聚合前的内层 **`WHERE` 层**，转化为对 `t2.idx_a` 的紧凑索引范围扫描 `(490 < a)`；`dt.total_c > 1000` 依赖聚合函数 `SUM(c)`，下推至分组聚合之后、临时表物化之前的内层 **`HAVING` 层**，大幅缩减物化写入行数。
   - **SQL B 完全无法下推**：派生表内含有 **`LIMIT 495`**。若先把 `a > 490` 下推到 `LIMIT` 之前执行，就会改变原派生表“先按全表前 495 个分组截断，再从中筛选 `a > 490`”的结果集语义，故优化器自动拦截下推，必须在物化完 `495` 行后再于外层执行 `Filter: (dt.a > 490)`。
2. **`LooseScan` 松散索引扫描的去重机制**：子查询表 `t2` 在连接列上拥有二级索引 `idx_a(a)`，相同 `a` 值在索引叶子节点上紧密相邻。执行器以 `t2` 为驱动表顺序扫描 `idx_a`，**每遇到一个新的 `a` 值，只取该组的第一条索引记录去关联 `t1.idx_a`（`ref` 访问），随后直接跳过 `t2.idx_a` 中其余相同的 `a` 值**。因为驱动端传给 `t1` 的每个连接键 `a` 本身已经无重复，自然不会令 `t1` 的同一条记录被重复匹配输出。

</details>

## 面试题 {#ch6-interview}

以下 3 道面试题考查线上高频出现的 `IN` 大列表索引失效、可空列 `NOT IN` 规范禁令以及 MySQL 8.0+ CBO 成本模型升级。建议先独立作答，再展开核对参考答案。

### 面试题 1：IN 参数列表满 200 个引发索引突变为全表扫描的根因

线上某接口执行 `SELECT * FROM orders WHERE status IN (?, ?, ...)`，`status` 上建有普通二级索引。传入 199 个冷门状态码时耗时仅 2 ms（走 `range` 索引），多传 1 个变成 200 个状态码后耗时骤增至数百毫秒并退化为全表扫描 `ALL`。请解释底层触发阈值及治理手段。

<details>
<summary>查看参考答案</summary>

**根因触碰了系统变量 `eq_range_index_dive_limit` 的默认阈值 `200`：**

1. **机制分界**：`eq_range_index_dive_limit` 针对非唯一索引上的等值范围比较（如 `IN (...)` 或多个等值 `OR` 条件）。当等值范围个数 **`< 200`**（如 199 个）时，优化器执行 **Index Dive**（索引下潜），沿 `idx_status` B+ 树定位每个等值区间的左右边界并估算行数——虽非逐行精确计数，但能较准确反映这 199 个冷门状态码总命中极少，从而选择 `range` 索引。当等值范围个数 **`≥ 200`** 时，优化器为控制编译期下潜开销跳过 Index Dive，改用 `innodb_index_stats` 中的索引统计信息（平均单值行数 × 200）近似估算。最终是否走全表扫描仍由成本模型比较决定（并非跨越 200 就必然走 `ALL`）；但本例中状态列枚举少且热值严重倾斜，统计均值远高于冷门状态真实行数，导致估算的回表成本大幅超过全表扫描，从而触发计划退化为 `ALL`。
2. **治理手段**：① 业务层拆分 `IN` 参数量（例如每批控制在阈值以下，如 `100` 个）；② 确需大列表准确估算时，在会话或实例级适度调大 `eq_range_index_dive_limit`（设为 `0` 表示始终下潜，但需权衡编译期耗时）；③ 及时执行 `ANALYZE TABLE` 保持索引统计新鲜，必要时通过 `FORCE INDEX(idx_status)` 提示锁定索引——注：在 MySQL 8.4 中，满足单表等条件且带单索引 `FORCE INDEX` 时还会自动跳过冗余的 Index Dive。

</details>

### 面试题 2：生产研发规范禁用可空列 NOT IN 而强制改用 NOT EXISTS 的原因

为什么主流数据库研发规范都严禁对可为 `NULL` 的列编写 `WHERE col NOT IN (SELECT ...)`，而要求统一改写为 `NOT EXISTS`？除了正确性隐患外，在 MySQL 8.0+ 执行计划层面还有什么差距？

<details>
<summary>查看参考答案</summary>

同时存在**正确性归零隐患**与**反连接优化失效**两重原因：

1. **三值逻辑导致结果集瞬间归零**：`x NOT IN (a, b, NULL)` 等价于 `x <> a AND x <> b AND x <> NULL`。根据 SQL 三值逻辑，`x <> NULL` 永远求值为 `UNKNOWN`，而 `TRUE AND UNKNOWN` 仍为 `UNKNOWN`，无法通过只认 `TRUE` 的 `WHERE` 过滤。因此子查询表一旦写入哪怕 1 条 `NULL` 脏数据，整条查询会静默返回 **`0` 行空集**，造成严重业务事故；而 `NOT EXISTS` 只判断子查询是否返回行，天然忽略 `NULL` 记录。
2. **阻塞 MySQL 8.0.17+ 的 Anti-join 重写**：当字段定义为可空（`NULL`）时，即便当前表中无 `NULL` 值甚至子查询里写了 `IS NOT NULL`，优化器为保证三值语义仍无法把 `NOT IN` 转为反连接，只能退化为逐行执行的相关子查询；而 `NOT EXISTS` 可无条件被优化器重写为高效的 **`Hash antijoin`** 或 **`Nested loop antijoin`**。

</details>

### 面试题 3：MySQL 8.0 / 8.4 页面读取成本计算相比 5.7 的本质进步

原书基于 MySQL 5.7 计算 I/O 成本时将读取每个页面的成本固定设为 `1.0`。升级到 MySQL 8.0 / 8.4 后，优化器计算页面读取成本的模型有何核心改进？这对索引选型有什么实际影响？

<details>
<summary>查看参考答案</summary>

**核心改进是引入了区分“内存缓冲页”与“磁盘物理页”的动态命中率加权模型，并同步调低了 CPU 评估常数：**

1. **Buffer Pool 驻留率动态加权**：`mysql.engine_cost` 将页读取拆分为 `io_block_read_cost = 1.0`（磁盘读）与 **`memory_block_read_cost = 0.25`**（内存读，5.7 中均为 `1.0`）。存储引擎实时向优化器汇报目标表或索引在 Buffer Pool 中的缓存比例 `in_memory`，按 `` `in_memory × 0.25 + (1 - in_memory) × 1.0` `` 计算单页真实开销；同时 `mysql.server_cost` 将 `row_evaluate_cost` 等常数减半（`0.2 → 0.1`）。
2. **对索引选型的实际影响**：在 5.7 中，优化器常因高估全内存热表回表页的“磁盘 I/O 代价”而放弃原本很快的二级索引，或无法区分冷表与热表；在 8.0 / 8.4 中，若二级索引与热表数据已常驻 Buffer Pool，回表读页成本仅按 `0.25` 计费，而未缓存的冷大表全表扫描仍按接近 `1.0` 计费，使优化器在冷热混合负载下的索引与连接选型显著贴近真实硬件延迟。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: Configuring Persistent Optimizer Statistics Parameters](https://dev.mysql.com/doc/refman/8.4/en/innodb-persistent-stats.html)
- [MySQL 8.4 Reference Manual: Optimizer Statistics & Column Histograms](https://dev.mysql.com/doc/refman/8.4/en/optimizer-statistics.html)
- [MySQL 8.4 Reference Manual: The Optimizer Cost Model (`server_cost` & `engine_cost`)](https://dev.mysql.com/doc/refman/8.4/en/cost-model.html)
- [MySQL 8.4 Reference Manual: Range Optimization & Equality Range Dive Limit](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html#equality-range-optimization)
- [MySQL 8.4 Reference Manual: Derived Condition Pushdown Optimization](https://dev.mysql.com/doc/refman/8.4/en/derived-condition-pushdown-optimization.html)
- [MySQL 8.4 Reference Manual: Optimizing IN and EXISTS Subquery Predicates with Semijoin and Antijoin Transformations](https://dev.mysql.com/doc/refman/8.4/en/semijoins.html)
