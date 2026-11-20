---
title: 第 3 章 分布式事务（2PC / TCC / SAGA）与共识算法（Paxos / Raft）
description: 贯通跨异构服务的刚性与柔性分布式事务（2PC、Outbox、TCC、SAGA、AT），深入剖析复制状态机、Paxos 与 Raft 共识机制。
---

# 第 3 章 分布式事务（2PC / TCC / SAGA）与共识算法（Paxos / Raft）

## 本章要点

分布式系统中最易混淆却又最核心的两大基石是**分布式事务**与**分布式共识**：前者解决“一次业务操作横跨订单、库存、账户等多个**异构服务/数据源**时，如何保证全成或全退的原子性”；后者解决“**同一份数据在多台机器保存同构副本**时，如何在节点宕机与网络乱序下就操作日志顺序达成一致”。本章整合原书第 3 章与第 6 章，剥离与 [MySQL 专题](../mysql/chapter-08) 重复的单机引擎细节，依次拆解 WAL 四象限与 2PC/3PC 刚性瓶颈、四大柔性事务（Outbox、TCC、SAGA、AT）的异常边界，以及 Basic Paxos、Multi-Paxos / Raft 与 Gossip 的底层协议机制。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Docker 29.10、Linux/AMD64。

## 3.1 崩溃恢复矩阵、全局事务（2PC / 3PC）与 CAP 权衡 {#ch3-1}

### 3.1.1 STEAL / NO-FORCE 四象限与 ARIES 恢复准则 {#ch3-1-1}

单数据源本地事务（详见 [MySQL 第 8～10 章](../mysql/chapter-08)）的原子性（A）与持久性（D）取决于缓冲池脏页落盘策略的设计。按“是否允许未提交事务脏页提前刷盘（`STEAL`）”与“提交时是否强制把全部脏页同步刷盘（`FORCE`）”构成经典四象限：

| 提交刷盘策略 \ 提前写盘策略 | `NO-STEAL`（未提交禁刷脏页） | `STEAL`（允许未提交提前刷脏页） |
| --- | --- | --- |
| **`NO-FORCE`**（提交免刷数据页） | 仅需 **Redo Log**，无需 Undo Log（即提交日志 Commit Logging，长事务易撑满内存） | **吞吐最高（主流数据库标准选择）**：必须同时维护 **Redo Log + Undo Log**（即 **WAL**） |
| **`FORCE`**（提交强刷所有数据页） | 无需 Redo / Undo 日志，但每次提交随机磁盘 I/O 极慢 | 仅需 **Undo Log**，无需 Redo Log |

> [!NOTE]
> **订正原书 ARIES 恢复 Redo 阶段误述**：原书称 ARIES 崩溃恢复在 Redo 阶段“只找出包含 Commit Record 的日志重做”。事实上，标准 ARIES 的精髓是 **Repeating History（重演全部历史）**：Analysis 定位起点后，**Redo 阶段会无差别重放所有已落盘日志（无论该事务最终是否提交）**，将缓冲池精确还原至崩溃瞬间的状态；随后再由 **Undo 阶段**逆序扫描回滚所有未提交的失败事务（Loser）。

### 3.1.2 2PC / 3PC 刚性全局事务瓶颈与 CAP / BASE 定律 {#ch3-1-2}

当单个服务或跨服务需要同时修改多个独立数据源时，基于 X/Open XA 规范的 **两阶段提交**（2PC）引入事务协调者（TM）分“投票准备（Prepare，各库写日志并持续锁住行资源）→ 全局提交/回滚（Commit/Abort）”两步同步驱动，存在三大工程硬伤：

1. **协调者单点永久阻塞**：参与者一旦返回 `Prepared` 就必须死锁资源等待协调者指令；若此时协调者宕机，所有参与者的数据库连接与行锁被无限期挂起。
2. **木桶效应拖垮高并发吞吐**：至少 2 轮跨网 RPC 加多次磁盘同步刷盘，锁持有时长放大数十倍。
3. **极端分区导致数据分裂**：协调者发出半数 `Commit` 后网络中断，收到者提交、未收到者无法推进，数据陷入不一致。而教科书式的 **3PC**（拆分为 `CanCommit -> PreCommit -> DoCommit` 并引入参与者超时自动提交）不仅正常路径更慢，且一旦协调者下发 `Abort` 因网络分区未送达，超时节点自动提交反而会**直接制造确定性的数据不一致**，因此工业界几乎无人采用 3PC。

从系统可用性公式 `A = MTBF / (MTBF + MTTR)`（如五个 9 即 `99.999%` 要求全年不可用时长不超过 `5.26 分钟`）与 **CAP 定理**来看：跨网络节点通信必定面临网络分区（`P` 必选）；刚性 XA 选择 `CP` 牺牲可用性，而高并发互联网微服务普遍选择 **`AP` + BASE 理论**（基本可用 Basically Available、允许中间软状态 Soft State、追求最终一致性 Eventual Consistency）。

## 3.2 柔性分布式事务实战：Outbox、TCC、SAGA 与 AT {#ch3-2}

### 3.2.1 四种主流柔性事务方案对比矩阵 {#ch3-2-1}

| 对比维度 | 本地消息表 / Outbox + CDC | TCC（Try-Confirm-Cancel） | SAGA 长事务模式 | Seata AT 模式 |
| --- | --- | --- | --- | --- |
| **核心流转机制** | 业务写库与写 `outbox` 消息表放进**同一本地事务**，再由 Debezium CDC 捕获 Binlog 投递 MQ 驱动下游 | 业务层显式实现三接口：`Try` 检查并**冻结预留资源** -> `Confirm` 真正核销 -> `Cancel` 释放冻结 | 拆为串行本地子事务 `T1..Tn`；若 `Tk` 失败则逆序调用补偿接口 `Ck-1..C1` 冲正（或正向重试） | 代理数据源自动解析 SQL 保存前后镜像入 `undo_log` 表，一阶段直接提交释放本地锁，二阶段失败自动生成逆向 SQL 补偿 |
| **写隔离性与超卖防护** | 无全局隔离（需首步先扣高风险资源） | **最强**（应用层字段级预留冻结，零数据库长锁） | **无隔离**（一阶段已真实落库，中间态对外可见） | 依赖协调端**全局锁**拦截并发修改防脏写；默认读未提交 |
| **代码侵入与适用场景** | 低侵入，仅支持异步单向最终一致（如支付成功发券/加积分） | **侵入最高**（每个参与方写 3 套接口），适合金融核心/秒杀扣减（无法改造的第三方银行接口不可用） | 中等侵入，适合跨多机构/长耗时履约编排（现代常借助 **Temporal** 工作流引擎托管） | **极低侵入**，适合内部完全可控的中低并发关系库微服务改造 |

### 3.2.2 生产必考红线：TCC / SAGA 的幂等、空回滚与防悬挂 {#ch3-2-2}

任何落地 TCC 或 SAGA 的生产系统，在网络丢包、超时重传与乱序到达下，若不处理以下**三大异常边界**必定引发资损：

```text
1. 幂等性（Idempotency）：Confirm / Cancel 可能因网络超时被协调器重复调用多次 ──► 必须建分支事务状态表，已 CONFIRMED/CANCELLED 直接返回成功！
2. 空回滚（Empty Rollback）：Try 请求因网络丢包根本未到达参与者，协调器超时触发 Cancel ──► Cancel 查无 Try 记录时，必须插入一条 CANCELLED 占位记录并正常返回 OK（不做反向加钱！）
3. 防悬挂（Anti-Hanging）：Try 包在网络中严重延迟，协调器已先执行完上述“空回滚”，随后迟到的 Try 包才抵达 ──► Try 执行前必须先查状态表，发现已存在 CANCELLED 记录必须立即拒绝执行！否则将产生永远无人清理的幽灵冻结资产！
```

同理，在 SAGA 模式中，逆向补偿操作 `Ci` 与正向操作 `Ti` 还必须满足**可交换律（Commutative）**——即便取消指令先于延迟的正向指令到达，最终账本状态也必须收敛一致。

## 3.3 复制状态机（SMR）、Paxos、Raft 与 Gossip 共识 {#ch3-3}

### 3.3.1 状态机复制与 Basic Paxos 两阶段抢占承诺 {#ch3-3-1}

需严格区分两个术语：**一致性**（Consistency）描述外部客户端观测多副本数据的结果特征（如线性一致性 vs 最终一致性）；**共识**（Consensus）则是多个节点在容忍非拜占庭故障（宕机、丢包、乱序，但不篡改伪造）下，围绕**复制状态机**（SMR）的输入操作日志序列达成唯一决议的算法过程——只要各节点初始状态相同且按完全相同的顺序执行确定性指令，最终状态必然一致，且基于**多数派**（Quorum，`≥ ⌊N/2⌋ + 1`）交集原理，总共 `N` 个节点可容忍最多 `⌊(N - 1) / 2⌋` 个节点故障。

Leslie Lamport 提出的 **Basic Paxos** 用于对**单个值**达成共识，包含 `Proposer`（提议者）、`Acceptor`（决策者）与 `Learner`（学习者）三类角色，核心是**两阶段可抢占逻辑锁**：

1. **阶段一（`Prepare(n)` -> `Promise`）**：Proposer 生成全局唯一递增提案号 `n` 广播给 Acceptor。若 `n` 大于 Acceptor 见过的最大编号，Acceptor 持久化更新最大编号并返回 `Promise`，做出**两项铁律承诺**：① 不再响应编号 `<= n` 的任何请求；② **将自己此前已经批准（Accepted）过的最大编号提案 `(max_acc_n, max_acc_val)` 如实汇报给 Proposer**（未批准过则返回空）。
2. **阶段二（`Accept(n, v)` -> `Accepted`）**：Proposer 收集到多数派 `Promise` 后，**如果收到的汇报中含有非空历史值，则必须无条件把自己的提议值替换为汇报中 `max_acc_n` 最大的那个 `max_acc_val`**（只有全为空时才能提议自己的新值 `v`），随后广播 `Accept(n, v)`；Acceptor 校验期间未向更大编号做过承诺则落盘批准；一旦多数派 `Accepted`，决议永久锁定！

Basic Paxos 之所以难直接用于生产日志流，一是因为每定一个值都要走 **2 轮 RTT**，二是两个 Proposer 交替用更大编号在阶段一抢占对方会导致谁也走不完阶段二的**活锁（Dueling Proposers）**。

### 3.3.2 Multi-Paxos 与 Raft 的关键差异及线性一致读（ReadIndex） {#ch3-3-2}

为消除活锁并将稳定期写入开销从 2 RTT 压缩至 **1 RTT**，工程界引入**选主机制（Leader Election）**：选定唯一主节点在任期内跳过阶段一直接广播日志复制。

> [!WARNING]
> **订正原书 6.2 节将 Multi-Paxos 与 Raft 混为一谈及“绝无双主”的表述偏差**：
> 1. **Multi-Paxos vs Raft 的核心差异**：**Multi-Paxos 允许日志槽位乱序并发批准（存在日志空洞）**，任意节点均可当选新主并在阶段一补齐空洞（代表系统：Google Spanner、OceanBase）；而云原生统治级协议 **Raft**（代表系统：Kubernetes **etcd**、TiKV **Multi-Raft**、Consul，以及在 Kafka 4.0 彻底取代 ZooKeeper 的 **KRaft**）强制要求**日志严格连续无空洞**——候选人（`Candidate`）竞选时其本地日志必须至少与多数派一样新，且 **Leader 只能通过统计多数派副本数来提交“当前任期（Current Term）”的日志**！
> 2. **任期安全与防脑裂脏读（`ReadIndex` / `LeaseRead`）**：Raft 的 Election Safety 仅保证“**同一个任期内最多选出 1 个 Leader**”；但在网络分区瞬间，少数派分区里的旧任期 Leader 尚未感知更高任期新主诞生前，物理时间上仍会短暂自认是主节点！若客户端直接读旧主内存就会读到陈旧脏数据。因此生产实现**线性一致读**必须走 **`ReadIndex`**——其关键前提是**新当选的 Leader 必须先提交一条当前任期的日志（通常是当选后立即追加的空操作 no-op 日志），以确认 `commitIndex` 已追上当前任期**；随后在收到读请求时记录 `commitIndex` 为 `ReadIndex`，向多数派发送一轮轻量心跳确认自己仍握有领导权，并等待本地状态机 `apply` 到该 `ReadIndex` 后才返回结果——或采用在相同前提下受严格时钟误差界定的 **`LeaseRead`**。

与强共识算法相对，**Gossip（流言协议）**去中心化随机抽取邻居周期扩散增量（传谣 Rumor-Mongering）或全量对账（反熵 Anti-Entropy），经 `O(log N)` 轮收敛至**最终一致**——适用于节点成员存活探测（如 SWIM）与大规模分片路由扩散（如 [Redis Cluster 总线](../redis/chapter-06#ch6-2-1)），但本身不能替代共识算法做强一致状态机定序。现代分布式 NewSQL 数据库普遍采用 **“分片内用 Multi-Paxos / Multi-Raft 保多副本高可用强一致 + 跨分片用优化版 2PC 保全局原子事务”** 的双层黄金架构。

## 练习 {#ch3-exercises}

以下 2 道练习分别检验跨服务订单扣减 TCC 异常时序防御，以及 Basic Paxos 并发提案决议推演。建议先独立作答，再展开核对参考答案。

### 练习 1：推演 TCC 分布式事务在极端网络乱序下的空回滚与悬挂故障

某跨境电商下单由协调器驱动“账户服务扣款”与“库存服务锁库存”执行 TCC。在某笔事务 `tx_9001` 中，协调器发出 `Try(tx_9001, lock=100元)` 请求时遭遇跨机房路由拥塞，报文在网络中滞留了 `15 秒`；协调器在 `3 秒` 超时后判定失败，立即向账户服务发送了 `Cancel(tx_9001)`，并于第 `4 秒` 收到返回；第 `15 秒` 那条迟到的 `Try(tx_9001)` 请求终于抵达账户服务。请回答：若账户服务只写了朴素的“Try 冻结余额、Cancel 解冻加回余额”逻辑，第 `4 秒` 和第 `15 秒` 会分别酿成什么资损事故？应如何设计分支事务控制表根治这两个问题？

<details>
<summary>查看参考答案</summary>

1. **两起连环资损事故**：
   - **第 `4 秒`（未防空回滚 -> 凭空给用户多加 100 元！）**：此时 `Try` 根本没到过账户库，用户余额一分未扣；朴素 `Cancel` 直接执行 `available = available + 100, frozen = frozen - 100`，导致用户账户凭空多出 100 元（或冻结金额变负数报错卡死）。
   - **第 `15 秒`（未防资源悬挂 -> 永久锁死用户 100 元！）**：即便第 4 秒发现无记录跳过了加钱，但未留痕；第 15 秒迟到的 `Try` 顺利把用户 100 元转入 `frozen` 冻结态——而此时全局事务 `tx_9001` 早已在 11 秒前终结回滚，永远不会再发第二次 `Cancel`，这 100 元将永久冻结无法解封（悬挂）！
2. **分支事务状态表根治方案**：
   - 在账户库同库建立 `tcc_branch_log(tx_id PRIMARY KEY, status INT)`（`1=TRIED`, `2=CONFIRMED`, `3=CANCELLED`），与余额修改置于**同一个本地 ACID 事务**内：
     - **`Cancel` 逻辑**：先 `SELECT ... FOR UPDATE` 查 `tx_id`；若已为 `CANCELLED` 直接幂等返回成功；**若记录不存在（触发空回滚），则直接 `INSERT (tx_9001, CANCELLED)` 落库且绝不修改用户余额**，返回成功！
     - **`Try` 逻辑**：先直接尝试 `INSERT (tx_9001, TRIED)`；若捕获**主键唯一冲突**，查出当前状态——若为 `TRIED` 则幂等返回成功；**若发现状态已为 `CANCELLED`（识别出延迟悬挂包！），立即回滚本地事务并拒绝冻结余额**！

</details>

### 练习 2：推演 5 节点 Basic Paxos 集群并发提案的最终决议值

现有 5 个 Acceptor 节点 `{S1, S2, S3, S4, S5}`（多数派为 `3` 个节点）。按时间先后发生以下事件：
1. `t1`：提议者 P1 发起 `Prepare(3.1)`，收到 `{S1, S2, S3}` 三个节点的空值 `Promise`；
2. `t2`：P1 发出 `Accept(3.1, "Value_A")`，但由于网络延迟，该消息**仅成功送达并被 `S3` 一个节点落盘批准**（发往 `S1`、`S2` 的包仍在路上，此时 `"Value_A"` 尚未达到多数派）；
3. `t3`：提议者 P2 发起更高编号的 `Prepare(4.2)`，成功送达 `{S3, S4, S5}` 三个节点。

请回答：`t3` 时刻 `{S3, S4, S5}` 分别向 P2 回复什么？P2 在阶段二会广播批准 `"Value_A"` 还是自己的 `"Value_B"`？随后 P1 在路上迟到的 `Accept(3.1, "Value_A")` 抵达 `S1` 和 `S3` 时各自会被接受还是拒绝？

<details>
<summary>查看参考答案</summary>

1. **`t3` 时刻 `{S3, S4, S5}` 的 Promise 回复**：
   - `4.2` 大于三者见过的最大编号，全部回复 `Promise`；其中 `S4`、`S5` 未批准过任何提案，汇报 `null`；**交集节点 `S3` 汇报自己已批准过的 `(3.1, "Value_A")`**。
2. **P2 阶段二的强制采纳行为**：
   - 尽管 P2 本想提议 `"Value_B"`，且 `"Value_A"` 在 `t2` 只写入了 1 个节点（未达多数派），但根据 Paxos 铁律——**只要收到的多数派 Promise 中存在任何非空已批准值，Proposer 必须采纳编号最大的那个值**！因此 P2 被迫放弃 `"Value_B"`，向 `{S3, S4, S5}` 广播 **`Accept(4.2, "Value_A")`** 并达成多数派决议 `"Value_A"`。
3. **迟到消息 `Accept(3.1, "Value_A")` 的命运**：
   - 抵达 **`S1`**：`S1` 此前只承诺到 `3.1`（未见过 `4.2`），不违背承诺，**予以接受**；
   - 抵达 **`S3`**：`S3` 已在 `t3` 向 `4.2` 做出“不再接受 `< 4.2` 提案”的承诺，因 `3.1 < 4.2` **直接拒绝**。最终全集群安全收敛于唯一值 `"Value_A"`。

</details>

## 面试题 {#ch3-interview}

以下 3 道面试题聚焦分布式事务选型、Raft 与 Paxos 差异及强一致读实现。建议先独立作答，再展开核对参考答案。

### 面试题 1：为什么高并发微服务中几乎不用 XA 两阶段提交（2PC），而在“本地消息表+CDC”“TCC”“SAGA”之间该如何选型？

<details>
<summary>查看参考答案</summary>

1. **弃用 XA 2PC 的原因**：2PC 在准备阶段就要锁定各参与库的行级资源并一直持有到第二阶段全部网络交互结束，吞吐量随参与节点数断崖式暴跌，且协调者单点故障会导致全局数据库连接挂死。
2. **三种柔性方案选型口诀**：
   - **单向异步通知、无需回滚上游**（如支付成功后通知发货、发优惠券）：首选 **Transactional Outbox（本地消息表 + CDC 日志捕获投递 MQ）**，零锁等待且代码侵入最低；
   - **短链路高并发核心资产扣减、严禁超卖**（如红包扣款、秒杀锁库存）：选 **TCC**，通过业务字段冻结实现细粒度强隔离；
   - **跨多个外部系统的长流程履约编排**（如机票+酒店+租车联订，部分外部接口无法改出 Try 冻结接口）：选 **SAGA 模式**（配合工作流引擎管理正向重试与逆向冲正补偿）。

</details>

### 面试题 2：Raft 相比 Basic Paxos / Multi-Paxos 做了哪些关键简化约束使它成为云原生事实标准？

<details>
<summary>查看参考答案</summary>

Raft 将共识清晰解耦为“Leader 选举、日志复制、安全性”三个子模块，并通过**两项核心强约束**大幅降低了工程实现与验证难度：

1. **日志严格连续无空洞，数据单向从 Leader 流向 Follower**：不同于 Multi-Paxos 允许并发乱序填槽产生空洞并在切主后重做补齐，Raft 要求所有日志按索引严格顺序追加，Follower 只做覆盖对齐绝不反向改写 Leader。
2. **选主完备性前置校验（无需选主后再靠恢复阶段捞旧数据）**：Candidate 发 `RequestVote` 时携带自身最后一条日志的 `(lastLogTerm, lastLogIndex)`，只有日志**至少和多数派一样新**的节点才能拿到选票当选 Leader——从而保证新 Leader 本地天然已包含所有历史已提交日志！

</details>

### 面试题 3：在 Raft 集群（如 etcd）中，客户端只向 Leader 节点发起读请求，就一定能读到最新数据（线性一致读）吗？

<details>
<summary>查看参考答案</summary>

**不一定！直接裸读 Leader 本地内存可能发生脑裂脏读。**

假设 5 节点集群发生网络分区：旧主 `S1` 与 `S2` 被隔离在少数派孤岛，而多数派 `{S3, S4, S5}` 已选出更高任期的新主 `S3` 并成功写入了新值 `V2`。此时旧主 `S1` 在选举超时内尚未感知自己已被废黜，若客户端连上 `S1` 直接读其内存，就会读到过期的旧值 `V1`！

实现严格线性一致读的两种标准工业做法是：
1. **`ReadIndex`（推荐，etcd 默认）**：首先满足关键前提——**新当选的 Leader 必须先在当前任期提交至少一条日志（通常是上任后立即追加的空操作 no-op 日志）**，因为 Raft 只能通过提交当前任期日志来间接确认旧任期日志的提交边界、让 `commitIndex` 追上当前任期；满足该前提后，Leader 收到读请求时记下当前 `commitIndex` 作为 `ReadIndex`，向所有 Follower 发一轮不带日志数据的轻量心跳，收到多数派响应确认自己此刻仍是合法主节点后，等待本地状态机 `apply` 到该 `ReadIndex` 即安全返回线性一致读结果。
2. **`LeaseRead`（租约读）**：同样要求新 Leader 先提交当前任期日志；随后利用有界物理时钟假设，在心跳确认后的短暂租约窗口内免去网络通信直接读本地内存，性能最高但若宿主机发生严重时钟漂移（Clock Skew）仍有极小破坏线性一致的理论风险。

</details>

## 参考资料

- [C. Mohan et al.：ARIES — A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using WAL](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- [Leslie Lamport：Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf)
- [Diego Ongaro & John Ousterhout：In Search of an Understandable Consensus Algorithm（Raft Extended Version）](https://raft.github.io/raft.pdf)
- [Microservices.io Pattern：Transactional Outbox & Saga Pattern](https://microservices.io/patterns/data/saga.html)
