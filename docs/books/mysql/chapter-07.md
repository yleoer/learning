---
title: 第 7 章 执行计划（EXPLAIN / ANALYZE）与优化追踪
description: 精通 EXPLAIN 十二列与 key_len 计算规则，运用 FORMAT=JSON/TREE、EXPLAIN ANALYZE 真实耗时采样及 optimizer_trace 定位慢查询根因。
---

# 第 7 章 执行计划（EXPLAIN / ANALYZE）与优化追踪

## 本章要点

索引规则与成本模型决定了查询优化器的内部推演逻辑，而线上慢查询治理要求工程师能够从执行计划反向还原优化器的真实决策链路。单靠传统表格态 `EXPLAIN` 只能看到优化器最终选定的访问方法与索引前缀，无法直接量化回表与求值成本，更无法暴露统计信息失真引发的预估基数偏差。本章构建从静态判读到动态采样的四级慢查询诊断闭环：先建立 `EXPLAIN` 十二列及 `Extra` 高频信号的精确判读体系与 `key_len` 字节拆解公式，再运用 `FORMAT=JSON`、`SHOW WARNINGS`、`FORMAT=TREE` 与 `EXPLAIN ANALYZE` 对照预估成本与火山算子真实耗时，最后通过会话级 `optimizer_trace` 追踪候选方案的成本淘汰全过程。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 7.1 EXPLAIN 十二列完整判读速查 {#ch7-1}

`EXPLAIN` 支持检视 `SELECT`、`DELETE`、`INSERT`、`REPLACE` 与 `UPDATE` 语句的执行计划。自 **MySQL 8.0** 起，历史遗留的 `EXPLAIN EXTENDED` 与 `EXPLAIN PARTITIONS` 语法已被正式移除；标准 `EXPLAIN` 默认直接输出包含 `partitions` 与 `filtered` 在内的全部 12 列，并在紧随其后执行 `SHOW WARNINGS` 时直接展示优化器重写后的查询文本。

### 7.1.1 核心列语义与 utf8mb4 下 key_len 精确公式 {#ch7-1-1}

传统表格格式下，每条输出行对应查询计划中的一次单表物理访问或临时表合并动作，12 列核心判读规则汇总如下：

| 列名 | 核心语义与执行顺序、调优判读准则 |
| --- | --- |
| `id` | 每个未被消除的 `SELECT` 分配独立编号。**相同 `id`** 按从上到下顺序依次为驱动表 → 被驱动表；子查询通常具有更大 `id`；`UNION` 去重合并行显示 `id = NULL`，而 `UNION ALL` 无此临时表行 |
| `select_type` | 查询块角色：`SIMPLE` 为无 `UNION` 及子查询的简单查询；`PRIMARY` 为最外层或首分支；`SUBQUERY` 为仅求值一次的不相关子查询；`DEPENDENT SUBQUERY` 会随外层扇出重复执行；`DERIVED` 为物化派生表；`MATERIALIZED` 为物化半连接或 `IN` 子查询表 |
| `table` | 访问的表名或别名；`<derivedN>` 指代 `id = N` 的物化派生表，`<subqueryN>` 指代 `id = N` 的物化子查询表，`<unionM,N>` 指代去重合并临时表 |
| `partitions` | 分区表命中的分区列表；未分区普通表恒显示 `NULL` |
| `type` | 单表访问方法，从最优到最差依次为 `system → const → eq_ref → ref → fulltext → ref_or_null → index_merge → unique_subquery → index_subquery → range → index → ALL`，详见[第 5 章 5.1 节](./chapter-05#ch5-1) |
| `possible_keys` | 优化器初筛可能用到的候选索引；候选过多会抬高范围分析耗时，全索引覆盖扫描时可能出现 `possible_keys = NULL` 而 `key` 非空 |
| `key` | 经成本对比后最终选定的索引名称；未走索引的全表扫描显示 `NULL` |
| `key_len` | 本次选中索引所用键前缀的最大字节数总和；在 `const` / `eq_ref` / `ref` / `range` 等查找场景中用于反推参与扫描区间边界的联合索引前几列；注意全索引扫描（`type = index`）时也会输出整条索引的完整 `key_len` |
| `ref` | 采用 `const`、`eq_ref`、`ref` 或 `ref_or_null` 等值匹配索引时，右值的来源类型：`const` 表示常量，`db.tbl.col` 表示前序驱动表列，`func` 表示比较值经过函数运算或隐式字符集、类型转换 |
| `rows` | 优化器预估需扫描的记录数；单表全表扫描取自表统计信息，索引扫描取自 `index dive` 或索引基数估算，详见[第 6 章 6.2.1 节](./chapter-06#ch6-2-1) |
| `filtered` | 经 `rows` 扫描后，预估剩余多少百分比记录能通过本表其余过滤条件，取值 `(0, 100.00]`；连接查询中驱动表**预估扇出**为 `rows × filtered ÷ 100`，直接决定被驱动表的循环访问次数 |
| `Extra` | 执行器附加动作与优化器策略信号，如覆盖索引、ICP 下推、外部排序、内部临时表与半连接去重，详见 [7.1.2 节](#ch7-1-2) |

解读 `key_len` 前，**务必先结合 `type`、查询谓词以及树形执行计划（`EXPLAIN FORMAT=TREE`）定位访问方式，切勿看到 `key_len` 有值就断定存在索引筛选区间**。例如无 `WHERE` 条件的全索引扫描（`type = index`，如对建有可空 `INT` 索引 `k_code` 的表执行 `SELECT code FROM aa FORCE INDEX(k_code) ORDER BY code`），引擎实质上遍历了整棵覆盖索引树、并未构造任何范围筛选边界，但 `EXPLAIN` 依然会输出整条索引的完整 `key_len`（本例为 `4 + 1 = 5`）。只有在 **`const`、`eq_ref`、`ref`、`range`** 等索引查找场景中，`key_len` 才适合用来反推联合索引中实际参与构建 B+ 树扫描区间边界的前几列。单列 `key_len` 遵循严格的上限字节累加公式：

```text
单列 key_len = 列最大数据字节数 + 可空标志字节 + 变长长度头字节
```

三项构成的取值规则如下：

1. **列最大数据字节数**：定长数值与时间类型取固定物理宽度，如 `TINYINT = 1`、`SMALLINT = 2`、`INT = 4`、`BIGINT = 8`、`DATE = 3`、`DATETIME(0) = 5`；字符串类型按 `声明字符数 × 字符集单字符最大字节数 Maxlen` 计算，其中 `latin1 = 1`、`gbk = 2`、`utf8mb3 = 3`、默认的 **`utf8mb4 = 4`**。
2. **可空标志字节**：列允许存储 `NULL` 时计 **`1`**，声明为 `NOT NULL` 时计 **`0`**。
3. **变长长度头字节**：`VARCHAR` 等变长类型在 `key_len` 统计中**固定计 `2` 字节**，`CHAR`、`INT` 等定长类型计 **`0`**。注意此处是优化器用于区分索引前缀的固定上限标记，不同于[第 2 章 2.1.1 节](./chapter-02#ch2-1-1)物理行格式按真实字节数动态占用 `1` 或 `2` 字节的规则。

在 `ref`、`range` 等索引查找场景下，**`key_len` 仅累加实际用于划定索引扫描区间边界的前缀列**——像仅用于 `ORDER BY` 排序或索引条件下推（ICP）过滤的后续索引列，不会把该查找计划的 `key_len` 撑大；但若访问类型已变为 `type = index` 的覆盖全索引扫描，则会直接显示整条索引的完整字节数。以下基于 MySQL 8.4.13 实测验证 `ref` / `range` 场景下的前缀拆解规律：

```sql
CREATE TABLE shop_exp (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  region VARCHAR(32) NOT NULL, shop_code VARCHAR(100) NOT NULL, KEY idx_region (region)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE orders_exp (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_code VARCHAR(100) DEFAULT NULL, -- 100 × 4 + 1(NULL) + 2(VARCHAR) = 403
  status INT NOT NULL,                 -- 4 + 0(NOT NULL) + 0 = 4
  amount BIGINT DEFAULT NULL,          -- 8 + 1(NULL) + 0 = 9
  memo VARCHAR(64) DEFAULT NULL, KEY idx_shop_status_amt (shop_code, status, amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

写入 4 家门店与 400 条订单并执行 `ANALYZE TABLE` 后，对比 4 条查询的 `EXPLAIN` 关键列结果：

```text
-- Q1: SELECT id FROM orders_exp WHERE shop_code = 'SH01'
type=ref   | key=idx_shop_status_amt | key_len=403 | ref=const       | Extra=Using index
-- Q2: SELECT id FROM orders_exp WHERE shop_code = 'SH01' AND status = 1
type=ref   | key=idx_shop_status_amt | key_len=407 | ref=const,const | Extra=Using index
-- Q3: SELECT id FROM orders_exp WHERE shop_code = 'SH01' AND status = 1 AND amount > 5000
type=range | key=idx_shop_status_amt | key_len=416 | ref=NULL        | Extra=Using where; Using index
-- Q4: SELECT memo FROM orders_exp WHERE shop_code = 'SH01' AND amount > 5000 ORDER BY status
type=ref   | key=idx_shop_status_amt | key_len=403 | ref=const       | Extra=Using index condition
```

从 `403 → 407 → 416` 的阶梯跳变可以清晰看到前 1、2、3 列依次纳入扫描边界。而在 Q4 中，由于跳过中间列 `status` 无法把 `amount > 5000` 拼入扫描边界，尽管 `status` 成功消除了 `ORDER BY` 的文件排序且 `amount > 5000` 触发了 ICP 下推，`key_len` 依然严格保持首列的 `403`。

### 7.1.2 Extra 列高频诊断信号对照表 {#ch7-1-2}

`Extra` 列浓缩了执行计划最关键的性能瓶颈与优化器特性命中状态，常见信号对照如下：

| `Extra` 输出信号 | 底层执行机制与版本演进、调优动作 |
| --- | --- |
| `Using index` | **覆盖索引**生效，查询所需全部列均可直接从二级索引树获取，彻底省去聚簇索引随机回表 |
| `Using index condition` | 触发**索引条件下推**（ICP，详见[第 4 章 4.2.2 节](./chapter-04#ch4-2-2)），在存储引擎层先利用二级索引列过滤不满足条件的记录，仅对通过记录执行回表 |
| `Using where` | 需在 Server 层或扫描后依据非索引边界条件过滤记录；若同时伴随 `type = ALL` 或庞大 `rows`，通常意味着缺少有效索引或索引因函数、隐式转换失效 |
| `Using filesort` | 无法利用索引天然有序性完成 `ORDER BY`，需将记录载入内存 `sort_buffer` 排序，数据量超限时溢写磁盘多路归并临时文件 |
| `Using temporary` | 创建内部临时表完成 `DISTINCT`、`GROUP BY` 或 `UNION` 去重。**MySQL 8.0+** 默认采用内存 `TempTable` 引擎，超 `temptable_max_ram`（默认 `1 GiB`）后直接溢写为 `InnoDB` 磁盘临时表；且 8.0 起 **`GROUP BY` 已取消隐式排序**，单纯分组不再捆绑出现 `Using filesort` |
| `Using intersect(...)` / `union(...)` / `sort_union(...)` | 触发索引合并，分别对多个二级索引扫描出的有序主键集合取交集、并集或先排序再取并集后回表，详见[第 5 章 5.2 节](./chapter-05#ch5-2) |
| `Using index for skip scan` | 触发 **MySQL 8.0.13+** 索引跳跃扫描，在前导列区分度极低且满足覆盖索引前提下，枚举前导列唯一值跳跃检索后续列，详见[第 4 章 4.3 节](./chapter-04#ch4-3) |
| `Using join buffer (hash join)` | 被驱动表缺少可用索引时启用 **MySQL 8.0.18+** Hash Join，全面取代已废弃的 `Block Nested Loop`，详见[第 5 章 5.4 节](./chapter-05#ch5-4) |
| `Start temporary` / `End temporary` | 半连接 `DuplicateWeedout` 策略生效，利用临时表消除多表关联产生的重复外层行，详见[第 6 章 6.3.2 节](./chapter-06#ch6-3-2) |
| `LooseScan` / `FirstMatch(tbl)` | 半连接的松散索引扫描策略或首次匹配即短路回退外层的策略，详见[第 6 章 6.3.2 节](./chapter-06#ch6-3-2) |
| `Impossible WHERE` / `No matching min/max row` | `WHERE` 条件恒为假直接返回空集，或 `MIN` / `MAX` 聚合函数在目标索引区间内不存在匹配记录，无需扫表即刻短路 |

## 7.2 JSON 成本拆解、FORMAT=TREE 与 EXPLAIN ANALYZE {#ch7-2}

传统表格 `EXPLAIN` 隐藏了定量成本与算子级耗时，现代 MySQL 提供了三种递进式增强视图：

| 诊断命令 | 最低版本 | 是否真实执行 SQL | 核心输出价值与适用场景 |
| --- | --- | --- | --- |
| `EXPLAIN FORMAT=JSON` | MySQL 5.6 | 否 | 精确输出总成本 `query_cost` 与逐表 `read_cost`、`eval_cost`、`prefix_cost` 量化明细 |
| `EXPLAIN FORMAT=TREE` | MySQL 8.0.16 | 否 | 按火山迭代器树形管道展示真实算子嵌套层级、过滤位置与单轮预估成本 |
| `EXPLAIN ANALYZE` | MySQL 8.0.18 | **是** | 真实运行查询并在每个迭代器节点并排打印**预估指标**与**真实毫秒耗时、行数、循环次数** |

对 [7.1.1 节](#ch7-1-1)的 `shop_exp` 与 `orders_exp` 执行两表连接 `EXPLAIN FORMAT=JSON`，并紧接着调用 `SHOW WARNINGS\G`：

```sql
EXPLAIN FORMAT=JSON
SELECT o.id, o.memo
FROM shop_exp s
JOIN orders_exp o ON s.shop_code = o.shop_code
WHERE s.region = 'east' AND o.status = 1;
SHOW WARNINGS\G
```

MySQL 8.4.13 返回的核心 JSON 成本节点与 `Code 1003` 重写结果如下：

```text
-- FORMAT=JSON 关键成本拆解摘要：
"query_cost": "9.20",
"nested_loop": [
  { "table": { "table_name": "s", "access_type": "ref", "key": "idx_region",
      "rows_examined_per_scan": 2, "rows_produced_per_join": 2,
      "cost_info": { "read_cost": "0.50", "eval_cost": "0.20", "prefix_cost": "0.70" } } },
  { "table": { "table_name": "o", "access_type": "ref", "key": "idx_shop_status_amt",
      "rows_examined_per_scan": 20, "rows_produced_per_join": 40,
      "cost_info": { "read_cost": "4.50", "eval_cost": "4.00", "prefix_cost": "9.20" } } }
]

-- SHOW WARNINGS 输出（Level: Note, Code: 1003）：
/* select#1 */ select `verify_ch07_08`.`o`.`id` AS `id`,`verify_ch07_08`.`o`.`memo` AS `memo`
from `verify_ch07_08`.`shop_exp` `s` join `verify_ch07_08`.`orders_exp` `o`
where ((`verify_ch07_08`.`o`.`shop_code` = `verify_ch07_08`.`s`.`shop_code`)
  and (`verify_ch07_08`.`o`.`status` = 1) and (`verify_ch07_08`.`s`.`region` = 'east'))
```

JSON 中的四项成本满足严格累加关系：`eval_cost = 累计扫描行数 × row_evaluate_cost(0.1)`，因此驱动表 `s` 的 `prefix_cost = 0.50 + 2 × 0.1 = 0.70`；驱动表产出扇出 `2` 行，使被驱动表 `o` 累计扫描 `2 × 20 = 40` 行，`o` 的 `eval_cost = 40 × 0.1 = 4.00`，叠加两次索引与回表读取成本 `4.50` 后，最终 `prefix_cost = 0.70 + 4.50 + 4.00 = 9.20`，恰好等于整条查询的 `query_cost`。紧随其后的 `Code 1003` 消息是排查隐式转换的利器——一旦连接列字符集不兼容或类型失配（详见[第 1 章 1.3.2 节](./chapter-01#ch1-3-2)），此处会直接暴露包裹在索引列外的 ` convert(...)` 或 `cast(...)` 伪代码；但需注意 `Code 1003` 属于优化器内部等价表示，未必总能直接作为合法 SQL 粘贴运行。

自 MySQL 8.0 重构为统一的**火山迭代器执行引擎**后，`EXPLAIN ANALYZE` 进一步打通了预估模型与运行期真实指标的鸿沟。对上述连接查询直接运行 `EXPLAIN ANALYZE`：

```text
-> Nested loop inner join  (cost=9.2 rows=40) (actual time=0.173..0.309 rows=40 loops=1)
    -> Index lookup on s using idx_region (region='east')  (cost=0.7 rows=2) (actual time=0.105..0.108 rows=2 loops=1)
    -> Index lookup on o using idx_shop_status_amt (shop_code=s.shop_code, status=1)  (cost=3.25 rows=20) (actual time=0.0513..0.0889 rows=20 loops=2)
```

阅读树形计划遵循**缩进越深越先作为子输入执行、同级节点从上到下依次驱动**的原则。每个算子右侧第 2 组括号内的 4 项实测指标含义如下：

- **`actual time = T_first..T_last`**：单轮调用返回**第 1 行**与**最后 1 行**的平均毫秒耗时；若 `loops > 1`，该节点消耗的**真实累计时间 = `T_last × loops`**，如上例被驱动表 `o` 总耗时约为 `0.0889 × 2 ≈ 0.178 ms`。
- **`rows`**：单轮调用实际产出的平均行数；将其与左侧括号的预估 `rows` 对照，若出现数量级偏差，即可断定统计信息过期、无索引倾斜列缺乏直方图（详见[第 6 章 6.1 节](./chapter-06#ch6-1)）或列上套了函数导致基数盲猜。
- **`loops`**：父算子调用该子算子的循环总次数；内层嵌套循环的 `loops` 恒等于驱动表实际输出的扇出行数。
- **`never executed`**：当驱动表过滤后实际返回 `0` 行或外层 `LIMIT` 提前满足短路时，未曾触发的子算子会直接标记为 `never executed`。

**生产执行安全边界与写语句误区澄清**：`EXPLAIN ANALYZE` 支持 `SELECT`、`TABLE`（MySQL 8.0.19+）以及多表 `UPDATE` / `DELETE` 语句，运行期间会真实驱动迭代器扫描与连接，仅抑制结果集向客户端发送。针对写语句需特别澄清一个高频误区：在 MySQL 8.4 实测与源码实现（`sql/sql_update.cc`、`sql/sql_delete.cc`）中，简单单表 `UPDATE` / `DELETE` 未接入迭代器执行器，执行 `EXPLAIN ANALYZE` 会直接输出 `<not executable by iterator executor>`；多表 `UPDATE ... JOIN` / `DELETE ... JOIN`（或改写为连接的含子查询写语句）虽会真实执行扫描与连接迭代器并输出实际行数与耗时，但在 `is_explain_analyze` 模式下会跳过实际的行修改与删除步骤，**不会真正修改目标行，也不会提交写入**。因此，① 它**不能**用于衡量实际行写入、维护二级索引、写 Undo/Redo 或事务提交刷盘的耗时；② 生产环境仍须慎用——因为底层扫描、连接与过滤会真实消耗 CPU、I/O 与内存，并可能产生锁竞争或触发含副作用的存储函数；线上排障优先将写条件改写为等价 `SELECT` 分析，或移至隔离测试环境验证，且耗时过长时可随时通过 `KILL QUERY` 中止。

## 7.3 使用 optimizer_trace 透视优化器选型根因 {#ch7-3}

当 `EXPLAIN` 显示优化器放弃了预期二级索引而退化为全表扫描或选中了次优索引时，`EXPLAIN` 只给出胜出结果，而系统变量 `optimizer_trace` 能把所有落选方案的成本测算与淘汰原因完整导出为 JSON。由于追踪会产生额外内存与 CPU 开销，生产上严禁开启全局追踪，标准四步会话级排障流程如下：

```sql
SET SESSION optimizer_trace = 'enabled=on,one_line=off';

-- 执行待排查 SQL（或 EXPLAIN SELECT ...）
SELECT id, memo FROM orders_exp WHERE shop_code = 'SH01' AND amount > 35000;

-- 读取追踪 JSON，同时检查是否因超出 optimizer_trace_max_mem_size(默认 1MB) 被截断
SELECT QUERY, MISSING_BYTES_BEYOND_MAX_MEM_SIZE, TRACE
FROM information_schema.OPTIMIZER_TRACE\G

SET SESSION optimizer_trace = 'enabled=off';
```

若 `MISSING_BYTES_BEYOND_MAX_MEM_SIZE > 0`，说明复杂 SQL 的追踪文本被尾部截断，需调大当前会话的 `SET SESSION optimizer_trace_max_mem_size = 8388608;` 后重采。`TRACE` JSON 顶层数组 `steps` 严格按优化与执行时序划分为三大阶段：

| 顶层阶段 | 核心子对象 | 排障重点关注信息 |
| --- | --- | --- |
| `join_preparation` | `expanded_query` | 补齐库表前缀、展开通配符及视图后的初始标准化 SQL |
| `join_optimization` | `condition_processing`、`rows_estimation`、`considered_execution_plans`、`refine_plan` | 等值传递与死条件消除；全表扫描 `table_scan` 与各索引 `range` 成本对比；多表连接顺序及 **`ref` 与 `range` 的最终胜负裁决**；ICP 下推条件挂载 |
| `join_execution` | `creating_tmp_table`、`filesort_summary` | 执行期创建的临时表引擎类型、排序模式 `sort_mode`——区分单路 `<fixed_sort_key, additional_fields>` 与双路 `<sort_key, rowid>`——及是否溢写磁盘归并文件 |

实测提取上例查询在 MySQL 8.4.13 中 `join_optimization` 阶段的核心裁剪片段：

```json
{
  "rows_estimation": [{
    "table": "`orders_exp`",
    "range_analysis": {
      "table_scan": { "rows": 400, "cost": 42.85 },
      "skip_scan_range": {
        "potential_skip_scan_indexes": [{
          "index": "idx_shop_status_amt", "usable": false,
          "cause": "query_references_nonkey_column"
        }]
      },
      "analyzing_range_alternatives": {
        "range_scan_alternatives": [{
          "index": "idx_shop_status_amt", "ranges": ["shop_code = 'SH01'"],
          "index_dives_for_eq_ranges": true, "index_only": false,
          "rows": 100, "cost": 35.26, "chosen": true
        }]
      }
    }
  }],
  "considered_execution_plans": [{
    "table": "`orders_exp`",
    "best_access_path": {
      "considered_access_paths": [
        { "access_type": "ref", "index": "idx_shop_status_amt", "rows": 100, "cost": 12.25, "chosen": true },
        { "access_type": "range", "chosen": false, "cause": "heuristic_index_cheaper" }
      ]
    }
  }],
  "refine_plan": [{
    "table": "`orders_exp`",
    "pushed_index_condition": "(`orders_exp`.`amount` > 35000)",
    "table_condition_attached": null
  }]
}
```

阅读 `join_optimization` 时必须区分两个极易混淆的决策点：

1. **`rows_estimation` 仅完成全表扫描与 `range` 范围扫描的初筛**：此处对比全表扫描成本 `42.85` 与 `range_scan_alternatives` 成本 `35.26`，同时在 `skip_scan_range` 中明确给出了未触发跳跃扫描的原因 `query_references_nonkey_column`——因为投影列 `memo` 不在二级索引中，违反了跳跃扫描必须覆盖索引的硬性前提。
2. **`considered_execution_plans` 才是等值 `ref`、`eq_ref` 与连接顺序的终审裁决场**：初学者常在 `rows_estimation` 中看到某索引 `range` 未被选中就误判索引失效，实际上等值匹配路径是在 `best_access_path` 中以 `access_type: "ref"` 参与竞选，并以更低的 `cost: 12.25` 击败 `range` 胜出，随后由 `refine_plan` 将剩余条件 `amount > 35000` 转化为 `pushed_index_condition` 下推至引擎层。

## 练习 {#ch7-exercises}

以下 2 道练习围绕联合索引 `EXPLAIN` 综合反推调优，以及基于 `sys.statement_analysis` 筛选头号待调优 SQL 并用 `EXPLAIN ANALYZE` 排查百倍行数偏差展开。测试库默认采用 `utf8mb4` 字符集与 `InnoDB` 引擎，建议先独立推演结论再展开核对。

### 练习 1：根据 `EXPLAIN` 输出矩阵反推联合索引生效列与回表、排序优化方案

给定工单日志表 `ticket_log` 及 3 条查询 Q1～Q3 在 MySQL 8.4.13 下的真实 `EXPLAIN` 结果：

```sql
CREATE TABLE ticket_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tenant_code VARCHAR(32) NOT NULL,
  level TINYINT DEFAULT NULL,
  created_ts INT NOT NULL,
  detail VARCHAR(128) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_tlc (tenant_code, level, created_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Q1: SELECT id, created_ts FROM ticket_log WHERE tenant_code = 'T01' AND level = 2;
--     type=ref   | key=idx_tlc | key_len=132 | rows=50  | Extra=Using index
-- Q2: SELECT id, detail FROM ticket_log WHERE tenant_code = 'T01' AND created_ts >= 1700011400 ORDER BY created_ts DESC;
--     type=ref   | key=idx_tlc | key_len=130 | rows=100 | Extra=Using index condition; Using filesort
-- Q3: SELECT id, detail FROM ticket_log WHERE tenant_code = 'T01' AND level = 2 AND created_ts >= 1700006000;
--     type=range | key=idx_tlc | key_len=136 | rows=25  | Extra=Using index condition
```

请完成以下分析：

1. 逐项列出 `idx_tlc` 三列的单列 `key_len` 构成，解释为何 Q1、Q2、Q3 的 `key_len` 分别为 `132`、`130`、`136`。
2. 说明为何 Q1 无回表也无排序，而 Q2 同时触发了 `Using index condition` 与 `Using filesort`。
3. 针对高频执行的 Q2，给出一条能够同时将扫描范围收敛至精确区间并彻底消除 `Using filesort` 的索引优化 DDL。

<details>
<summary>查看参考答案</summary>

1. **三列 `key_len` 拆解**：
   - `tenant_code VARCHAR(32) NOT NULL`：`32 × 4 + 0(NOT NULL) + 2(VARCHAR) = 130` 字节。
   - `level TINYINT DEFAULT NULL`：`1 + 1(NULL) + 0 = 2` 字节。
   - `created_ts INT NOT NULL`：`4 + 0(NOT NULL) + 0 = 4` 字节。
   - Q1 等值匹配前两列：`130 + 2 = 132`；Q2 缺失中间列 `level` 的条件，仅首列 `tenant_code` 构成扫描区间，故 `key_len = 130`；Q3 前两列等值加第 3 列范围匹配，三列全部纳入扫描区间边界，故 `130 + 2 + 4 = 136`。
2. **Q1 与 Q2 的 `Extra` 成因差异**：
   - Q1 查询列 `id` 与 `created_ts` 全部包含在 `idx_tlc` 叶子节点中，命中覆盖索引 `Using index`，无需回表。
   - Q2 需读取二级索引外的 `detail` 列而必须回表；由于跳过了第 2 列 `level`，在 `tenant_code = 'T01'` 分片内部记录先按 `level` 排序而非按 `created_ts` 全局有序，因此：① `created_ts >= 1700011400` 只能作为 ICP 条件在引擎层过滤，对应 `Using index condition`，无法缩窄索引扫描区间；② 回表取出的结果无法利用索引顺序满足 `ORDER BY created_ts DESC`，被迫执行 `Using filesort`。
3. **针对 Q2 的索引优化 DDL**：新建联合降序索引将等值列与时间范围排序列直接相邻排列，详见[第 4 章 4.3 节](./chapter-04#ch4-3)：

```sql
ALTER TABLE ticket_log ADD KEY idx_tc_desc (tenant_code, created_ts DESC);
```

在 MySQL 8.4.13 实测验证后，Q2 的执行计划更新为 `type = range`、`key = idx_tc_desc`、`key_len = 134`（`130 + 4`）、`rows = 6`、`Extra = Using index condition`，`Using filesort` 完全消除。

</details>

### 练习 2：从 `sys.statement_analysis` 筛选头号待调优 SQL，并用 `EXPLAIN ANALYZE` 定位偏差与修复

某业务库高峰期 CPU 使用率持续偏高，DBA 先从 `sys.statement_analysis`（Performance Schema 语句摘要视图）导出脱敏后的 Top SQL 统计片段如下：

| `query`（脱敏语句摘要） | `exec_count` | `total_latency` | `avg_latency` |
| --- | --- | --- | --- |
| ``SELECT `id` , `payload` FROM `event_log` WHERE DATE ( `event_time` ) = ?`` | `184200` | `1.42 m`（约 `85.2 s`） | `462.54 us` |
| ``SELECT `id` , `memo` FROM `audit_archive` WHERE `batch_no` = ? ORDER BY `id` DESC LIMIT ?`` | `6` | `14.80 s` | `2.47 s` |
| ``SELECT `status` FROM `shop_config` WHERE `shop_code` = ?`` | `950000` | `3.15 s` | `3.32 us` |

随后，工程师为优先治理目标准备了与线上结构一致的可控只读样例表 `event_log`（共 `1000` 行，其中仅 `10` 行发生在 `2026-11-17`），执行 `EXPLAIN ANALYZE` 采样得到如下实测输出：

```sql
CREATE TABLE event_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_time DATETIME NOT NULL,
  user_id BIGINT NOT NULL,
  payload VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_event_time (event_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

EXPLAIN ANALYZE
SELECT id, payload FROM event_log WHERE DATE(event_time) = '2026-11-17';
-- 实测输出：
-- -> Filter: (cast(event_log.event_time as date) = '2026-11-17')  (cost=101 rows=1000) (actual time=0.0552..0.45 rows=10 loops=1)
--     -> Table scan on event_log  (cost=101 rows=1000) (actual time=0.0409..0.318 rows=1000 loops=1)
```

请完成以下三步诊断与治理：

1. 面对上述 `sys.statement_analysis` 摘要，若目标是优先压降实例整体负载，应最先调优哪一条 SQL？说明为何不应优先选择单次最慢（`avg_latency = 2.47 s`）或调用次数最多（`exec_count = 950000`）的语句。
2. 结合可控只读样例的 `EXPLAIN ANALYZE` 估算与实测数据，指出 `Filter` 算子出现“预估 `rows=1000`、实际 `rows=10`”百倍偏差的根因，并说明该偏差在多表连接中会引发什么连锁危害。
3. 给出改写后的等价最优 SQL，并说明改写后的执行计划及估算/实测指标变化。

<details>
<summary>查看参考答案</summary>

1. **优先调优第 1 条 `event_log` 按日查询 SQL**：
   - **排序准绳是累计总耗时（`total_latency`）而非单次最慢**：优化实例整体 CPU 与并发吞吐时，应优先治理“执行次数 × 单次耗时”乘积最大的头号资源消耗源。第 1 条 SQL 虽单次仅 `462.54 us`，但高频执行 `184200` 次后累计消耗高达 **`1.42 m`（约 `85.2 s`）**，占三者总耗时的 `82%` 以上，收益最大。
   - **为何不先调第 2 条与第 3 条**：第 2 条虽然单次最慢（`avg_latency = 2.47 s`），但在统计窗口内仅触发 `6` 次，累计总耗时仅 `14.80 s`（若业务明确反馈该后台接口超时才需单独专项处理，而非降全局 CPU 的首选）；第 3 条虽然 `exec_count` 高达 `950000`，但单次仅 `3.32 us`、累计仅 `3.15 s`，已接近内存索引点查极限，继续调优的边际收益微乎其微。同时，选出目标 digest 后，应使用可控只读样例（或隔离从库/测试环境）跑 `EXPLAIN ANALYZE`，避免在主库高峰期放大额外扫描负载。
2. **百倍偏差根因与多表连接连锁危害**：
   - **偏差根因**：`WHERE DATE(event_time) = '2026-11-17'` 对索引列包裹了函数 `DATE(...)`，导致 B+ 树无法建立基于原始 `DATETIME` 值的有序扫描区间而退化为 `Table scan`（实测扫描整表 `1000` 行耗时 `0.318 ms`）；同时优化器无法对函数表达式使用索引统计信息或 `index dive` 估算选择率，只能保守假定 `filtered = 100%`，将整表 `1000` 行原样作为 `Filter` 预估输出行数，与真实匹配的 `10` 行产生 100 倍偏差。
   - **多表连接连锁危害**：若 `event_log` 参与多表连接，虚高 100 倍的预估扇出 `rows=1000` 会严重误导优化器的连接总成本公式，导致本应作为小结果集驱动表的 `event_log` 被错误排为被驱动表，甚至错误放弃嵌套循环索引查找而改走高开销的全表扫描。
3. **等价改写与实测验证**：保持比较符左侧为裸列，改写为左闭右开的连续时间范围查询；若业务无法改写 SQL，也可在 MySQL 8.0.13+ 创建函数索引 `KEY idx_ev_date ((CAST(event_time AS DATE)))`：

```sql
SELECT id, payload
FROM event_log
WHERE event_time >= '2026-11-17 00:00:00'
  AND event_time <  '2026-11-18 00:00:00';
```

MySQL 8.4.13 实测 `EXPLAIN ANALYZE` 输出如下，访问方式由 `Table scan` 升级为 `Index range scan`，预估 `rows=10` 与真实 `rows=10` 完全吻合，总成本从 `101` 骤降至 `4.76`，单次实测耗时从 `0.45 ms` 降至 `0.0524 ms`（降幅近 `90%`），映射至 `18.4` 万次调用可大幅释放整体 CPU 压力：

```text
-> Index range scan on event_log using idx_event_time over ('2026-11-17 00:00:00' <= event_time < '2026-11-18 00:00:00'), with index condition: ((event_log.event_time >= TIMESTAMP'2026-11-17 00:00:00') and (event_log.event_time < TIMESTAMP'2026-11-18 00:00:00'))  (cost=4.76 rows=10) (actual time=0.0493..0.0524 rows=10 loops=1)
```

</details>

## 面试题 {#ch7-interview}

以下 3 道面试题聚焦 `Extra` 三大高频过滤信号辨析、`key_len` 可空位精确心算以及 `EXPLAIN ANALYZE` 线上安全边界。环境约定同[练习部分](#ch7-exercises)，建议先独立作答再展开核对。

### 面试题 1：`EXPLAIN` 的 `Extra` 列中 `Using index`、`Using index condition` 与 `Using where` 有何本质区别？它们能否成对同时出现？

<details>
<summary>查看参考答案</summary>

1. **三者本质区别**：
   - **`Using index`**：表示**覆盖索引**，查询涉及的所有列均在当前二级索引树上，存储引擎直接返回索引记录而**无需回聚簇索引查整行**。
   - **`Using index condition`**：表示**索引条件下推**（ICP），查询**需要回表**，但部分无法构成扫描边界却仅涉及该二级索引列的过滤条件被下推给存储引擎先行判定，只有通过判定的记录才执行回表。
   - **`Using where`**：表示存储引擎返回记录后，还需在 **Server 层**（或扫描后）评估剩余过滤条件——常见于全表扫描过滤，或回表取出聚簇索引非索引列后再按条件过滤。
2. **能否同时出现**：
   - `Using index` 与 `Using where` **可以同时出现**，显示为 `Using where; Using index`：典型场景是二级索引覆盖了所有查询列无需回表，但 `WHERE` 带有跳过前导列的非边界索引过滤条件或范围边界重验条件，由 Server 层在覆盖索引记录上直接过滤。
   - `Using index condition` 与 `Using where` **可以同时出现**，显示为 `Using index condition; Using where`：当 SQL 既包含可下推至二级索引的 ICP 条件，又包含必须回表读取非索引列后才能在 Server 层判断的 `WHERE` 条件时同时触发。
   - `Using index` 与 `Using index condition` **互斥，不会在同一单表扫描中同时出现**：覆盖索引根本不需要回表，自然不存在“为了减少回表次数而先在引擎层下推过滤”的 ICP 动作。

</details>

### 面试题 2：在默认 `utf8mb4` 字符集下，表建有联合索引 `idx_abc (a, b, c)`，其中 `a VARCHAR(100) DEFAULT NULL`、`b INT DEFAULT NULL`、`c INT NOT NULL`。若 `EXPLAIN` 显示 `type = ref`、`key = idx_abc` 且 `key_len = 408`，说明哪几列构成了扫描区间？若改写为 `WHERE a = 'x' ORDER BY b`（仍为 `type = ref`），`key_len` 会变成多少？如果是无 `WHERE` 的全索引扫描（`type = index`），`key_len` 又会如何表现？

<details>
<summary>查看参考答案</summary>

1. **`type = ref` 且 `key_len = 408` 说明前两列 `(a, b)` 构成了扫描区间，第 3 列 `c` 未参与扫描边界**：
   - 列 `a`：`100 × 4(utf8mb4) + 1(可空) + 2(VARCHAR 变长头) = 403` 字节；
   - 列 `b`：`4(INT) + 1(可空) + 0(定长) = 5` 字节；
   - 列 `c`：`4(INT) + 0(NOT NULL) + 0 = 4` 字节。
   - 前两列之和 `403 + 5 = 408` 恰好吻合；若 `b` 为 `NOT NULL` 则前两列应为 `407`，若用满三列则应为 `412`。
2. **改写为 `WHERE a = 'x' ORDER BY b` 后，`key_len` 会变为 `403`**：在 `ref` / `range` 等索引查找场景中，尽管列 `b` 紧接在等值匹配的列 `a` 之后，能够利用索引天然有序性消除 `Using filesort`，但 `key_len` 仅累加用于限定扫描边界的前缀列 `a`，纯粹用于 `ORDER BY` 排序的列 `b` 不计入该次查找的 `key_len`。
3. **无 `WHERE` 的覆盖全索引扫描（`type = index`）仍会显示整条索引的完整 `key_len = 412`**：因此解读 `key_len` 必须先看 `type` 与查询谓词，`key_len` 有值并不等价于存在索引筛选区间。

</details>

### 面试题 3：`EXPLAIN` 与 `EXPLAIN ANALYZE` 各适用于什么场景？在 MySQL 8.4 中对 `UPDATE` 或 `DELETE` 语句执行 `EXPLAIN ANALYZE` 会真正修改数据吗？线上排障应注意什么？

<details>
<summary>查看参考答案</summary>

1. **适用场景分工**：
   - **`EXPLAIN`**——涵盖传统格式、`FORMAT=JSON` 与 `FORMAT=TREE`：仅运行到优化器生成执行计划即止，**不真正执行 SQL**，毫秒级返回且零数据副作用。适用于日常上线前 SQL 索引审查、超大慢查询初步静态诊断及生产高峰期安全检视。
   - **`EXPLAIN ANALYZE`**：在优化器生成计划后**真实驱动火山迭代器跑完扫描与连接管道**，适用于静态 `EXPLAIN` 看着走了索引但线上依然极慢、怀疑统计信息失真导致预估 `rows` 与真实行数背离、或需定位连接/排序/聚合多算子中究竟哪一步占用了核心耗时的深度剖析场景。
2. **对 `UPDATE` / `DELETE` 的真实行为与线上注意事项**：
   - **不会真正修改并提交目标行**：在 MySQL 8.4 中，简单单表 `UPDATE` / `DELETE` 执行 `EXPLAIN ANALYZE` 会直接返回 `<not executable by iterator executor>`，不执行查询也不改数据；多表 `UPDATE ... JOIN` / `DELETE ... JOIN`（及转为连接的含子查询写语句）虽会真实执行底层扫描与连接迭代器并输出实际行数和耗时，但源码（`sql/sql_update.cc`、`sql/sql_delete.cc`）在 `EXPLAIN ANALYZE` 模式下会跳过实际的行更新和删除动作，因此**不会真正改动表数据，也不会产生事务提交写入**。
   - **不能衡量写入与刷盘开销，但线上仍须慎用**：正因跳过了实际写入，`EXPLAIN ANALYZE` 无法反映维护索引、写 Undo/Redo 及事务提交刷盘的真实成本；同时，其扫描和连接阶段会真实消耗线上 CPU、I/O 与内存资源，仍可能带来锁开销或执行含副作用的存储函数。生产排障优先用普通 `EXPLAIN`（含 `FORMAT=JSON`）检查计划，或提取相同 `WHERE` / `JOIN` 条件改写为只读 `SELECT` 在低峰期或从库/测试库用 `EXPLAIN ANALYZE` 验证，必要时用 `KILL QUERY` 及时中止。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: 10.8.2 EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html)
- [MySQL 8.4 Reference Manual: 15.8.2 EXPLAIN Statement — FORMAT=JSON, TREE, and ANALYZE](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- [MySQL 8.4 Reference Manual: 10.8.5 Estimating Query Performance & Optimizer Trace](https://dev.mysql.com/doc/refman/8.4/en/estimating-performance.html)
- [MySQL 8.4 Reference Manual: 28.3.26 The INFORMATION_SCHEMA OPTIMIZER_TRACE Table](https://dev.mysql.com/doc/refman/8.4/en/information-schema-optimizer-trace-table.html)
- [MySQL 8.4 Reference Manual: 10.2.1.16 GROUP BY Optimization](https://dev.mysql.com/doc/refman/8.4/en/group-by-optimization.html)
- [MySQL 8.4 Reference Manual: 10.4.4 Internal Temporary Table Use in MySQL](https://dev.mysql.com/doc/refman/8.4/en/internal-temporary-tables.html)
- [MySQL 8.4 Reference Manual: 30.4.3.32 The sys.statement_analysis View](https://dev.mysql.com/doc/refman/8.4/en/sys-statement-analysis.html)
