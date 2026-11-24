---
title: 第 8 章 Linux 系统观测、性能排查与实战命令
description: 整合全书系统排障实战，建立基于 USE 方法的全栈观测工具图谱，详解软中断飙高、多线程死锁、TCP 全连接队列溢出、容器 PSI/OOM 及大日志高效分析闭环。
---

# 第 8 章 Linux 系统观测、性能排查与实战命令

## 本章要点

理解硬件缓存、内存页表、调度器、锁、块存储与网络协议栈的最终价值，在于面对线上延迟毛刺、吞吐骤降或进程假死时，能顺着内核指标迅速锁定根因，而不是盲目重启碰运气。本章整合原书《图解系统》第 9 章、1.6 节、4.4 节与第 10 章开头的实战案例，摒弃已停维的 `ifconfig`/`netstat` 等旧工具，建立以 `ip`、`ss`、`nstat`、`vmstat`、`iostat`、`perf`、**cgroups v2 PSI** 与 `bpftrace` 为核心的现代 Linux 系统级排障闭环。

读完本章后，应能运用 USE 方法完成 60 秒全栈物理体检，独立走通软中断飙高、多线程死锁（严守非侵入观测与 STW 转储红线）、TCP 全连接队列溢出、容器局部内存压力/OOM 四大实战链路，并在明确基数边界的前提下写出高效大日志分析管道。

> 核对日期：2026 年 11 月 23 日；核对环境为 Linux 6.12 LTS（`iproute2`、`sysstat`、`procps-ng`、`perf` 与 `bpftrace` 工具链）。

## 8.1 系统性能排查方法论与现代工具图谱 {#ch8-1}

### 8.1.1 USE 方法与 60 秒全栈体检 {#ch8-1-1}

面对“接口变慢”的笼统告警，先按 Brendan Gregg 的 **USE 方法**对四大物理子系统（CPU、内存、存储 I/O、网络）逐一核查三项核心信号：

- **Utilization（使用率）**：资源忙碌时间或容量占比（CPU `us`/`sy`/`si`、内存已用比、网卡带宽占比）；
- **Saturation（饱和度）**：来不及即时处理而产生的**排队与节流**（CPU 运行队列长度与 cgroup `nr_throttled`、内存回收/Swap/PSI 停顿、块设备队列深度 `aqu-sz`、TCP 全连接队列积压）；
- **Errors（错误数）**：硬件或内核拒绝计数（网卡 `overruns`/`dropped`、TCP `ListenOverflows`/重传、磁盘 I/O 错误、`dmesg` OOM 记录）。

### 8.1.2 全栈现代观测工具图谱 {#ch8-1-2}

生产环境统一采用基于 Netlink、性能计数器与 eBPF 的低开销现代工具（网络协议栈全链路 6 大丢包检查点与 `tcpdump`/`mtr` 路由判读详见[《图解网络》第 8 章](../network/chapter-08#ch8-3)）：

| 观测维度 | 淘汰旧工具 | 现代主力工具 | 核心排障用途 |
| --- | :---: | --- | --- |
| **CPU 与调度** | — | **`top` / `mpstat -P ALL` / `pidstat` / `vmstat`** | 查各核 `us`/`sy`/`si`/`wa` 倾斜、运行队列 `r`、不可中断阻塞 `b` 与上下文切换 `cs` |
| **内存与容器压力** | — | **`free -h` / `sar -B` / cgroup `memory.pressure`** | 查 `available`、主次缺页速率（`majflt/s`）、页面回收及容器 PSI 停顿时间占比 |
| **存储与块设备** | — | **`iostat -xz` / `iotop` / `lsof +L1`** | 查读写毫秒延迟（`r_await`/`w_await`）、平均队列深度（`aqu-sz`）与未释放删除句柄 |
| **网卡与套接字** | `ifconfig` / `netstat` | **`ip -s link` / `ss` / `nstat`** | 基于 Netlink `tcp_diag` 极速查全连接队列、TCP 内部窗口（`cwnd`/`snd_wnd`/`notsent`）与协议栈异常计数 |
| **内核与函数剖析** | — | **`perf` / `bpftrace`（eBPF）** | 低开销采集 On-CPU 火焰图、Off-CPU 阻塞栈、锁争用与内核 `kfree_skb` 丢包原因 |

## 8.2 CPU、软中断与多线程死锁排查实战 {#ch8-2}

### 8.2.1 实战一：软中断 CPU 使用率（`si`）飙高排查 {#ch8-2-1}

当 `top`（按 `1` 展开各核）显示部分核心 `si` 异常飙高甚至 `[ksoftirqd/N]` 登顶时，按四步闭环定因：

```bash
# 1. 动态观察 10 类软中断增量速率（/proc/softirqs 为开机累计值，必须对比差值！）
watch -d -n 1 cat /proc/softirqs

# 2. 若确认 NET_RX 激增，核查网卡实时 PPS（包/秒）与吞吐率（kB/s）
sar -n DEV 1 5

# 3. 检查网卡硬中断是否单核倾斜
grep -E "CPU0|eth|ens" /proc/interrupts

# 4. 限量抓包识别报文特征（-nn 禁反向解析防拖慢线上，-c 限制包数）
tcpdump -i eth0 -nn -c 200
```

- **高 PPS + 低带宽小包（海量异常 `SYN`/UDP）**：判定为小包 Flood 攻击，在网卡 XDP 或上游防火墙限流丢弃；
- **正常业务流量但单核 `NET_RX` 100%**：开启多队列 **RSS / RPS** 打散中断绑核（见[第 7 章练习 3](./chapter-07#ch7-exercises)）；
- **若高的是 `us`/`sy` 而非 `si`**：执行 `perf record -F 99 -p <pid> -g -- sleep 15` 生成火焰图直指热点函数。

### 8.2.2 实战二：多线程死锁闭环取证与线上非侵入红线 {#ch8-2-2}

面对僵死不响应且 CPU 跌至 0% 的多线程进程（Java 用 `jstack`，Go 用 `pprof` `goroutine`/`mutex`），C/C++ 原生服务在**已摘除流量**后可用 `pstack` 与 `gdb` 验证**完整等待闭环**（注意：必须双向核实对方也在等己方持有的锁，否则可能只是单向锁阻塞慢操作而非死锁！）：

```text
$ gdb -p <pid>
(gdb) info threads        # 列出全部线程 LWP（设线程 2 LWP=87748，线程 3 LWP=87747）
(gdb) thread 2            # 1. 切至卡在 __lll_lock_wait 的线程 2 (LWP 87748)
(gdb) bt                  #    定位调用 pthread_mutex_lock(&mutex_A) 的业务栈帧（如 frame 3）
(gdb) frame 3
(gdb) p mutex_A           #    查 __data.__owner = 87747 ──> 证明线程 2 正在等线程 3 持有的 mutex_A
(gdb) p mutex_B           #    查 __data.__owner = 87748 ──> 证明线程 2 当前持有 mutex_B
(gdb) thread 3            # 2. 【关键闭环步】切至线程 3 (LWP 87747) 查调用栈与等待目标
(gdb) bt                  #    确认线程 3 同样卡在 pthread_mutex_lock(&mutex_B) ──> 双向环路实锤！
```

> **生产高危红线（严禁在带流量的存活节点裸敲 `gdb` 或 `gcore`）**：
> - **`gdb -p` 与 `gcore` 均会触发全进程暂停（Stop-The-World）**：`gcore` 底层同样通过 `ptrace`/GDB 挂载冻结全部线程直至内存转储写盘完毕——一个 30 GB 内存的进程转储可能冻结数十秒并打满磁盘，导致上游雪崩！确需完整内存现场必须**先从负载均衡摘流并核实磁盘余量**。
> - **带流量的低侵入替代方案**：优先读取 `/proc/<pid>/task/*/stack` 看内核等待栈，或用 `perf` / `bpftrace` 追踪 `futex` 慢路径与 Off-CPU 睡眠栈。

## 8.3 网络队列观测与 TCP 全连接队列溢出排障 {#ch8-3}

### 8.3.1 `ss` 中 `Recv-Q` 与 `Send-Q` 的双重语义与真实字段 {#ch8-3-1}

```bash
ss -lnt                        # 仅查看 LISTEN 监听端口队列（注意 -l 看不到已建立连接）
ss -tin state established      # 查看已建立连接及内部状态（rtt、cwnd、snd_wnd、notsent、retrans、rwnd_limited 等；值为 0 的可选指标常被省略）
nstat -az | grep -E "TcpExtListen|TcpRetransSegs"
```

| Socket 状态 | `Recv-Q` 精确含义 | `Send-Q` 精确含义（Linux 6.12 `tcp_diag.c` 口径） |
| --- | --- | --- |
| **`LISTEN`** | **当前全连接队列（Accept Queue）等待 `accept()` 取走的连接数** | **全连接队列容量上限** `min(net.core.somaxconn, listen backlog)` |
| **`ESTABLISHED`** | Socket 接收缓冲区**尚未被应用 `read()` 读走的字节数** | `write_seq - snd_una`：**已发出未收 ACK 字节（in-flight） + 已入队尚未发出字节（`notsent`）之和** |

### 8.3.2 实战三：TCP 全连接队列溢出排障闭环 {#ch8-3-2}

（三次握手半/全连接队列协议细节互引[《图解网络》第 3 章](../network/chapter-03#ch3-3)。）

- **故障表征**：新客户端偶发建连超时或收到 `RST`；服务端抓包见客户端已发第三次握手 `ACK`，服务端却静默不理或回 `RST`。
- **四步闭环**：① 查 `nstat -az TcpExtListenOverflows TcpExtListenDrops` 确认溢出计数持续增长；② 查 `ss -lnt` 见 `Recv-Q > Send-Q`（如 `129 > 128`）；③ 核对 `net.ipv4.tcp_abort_on_overflow`（默认 `0` 静默丢弃 `ACK` 待重传，`1` 直接回 `RST` 快速失败）；④ **治标**同步调大 `net.core.somaxconn` 与应用 `listen(backlog)`，**治本**用火焰图/GC 日志/PSI 定位应用主循环为何来不及调 `accept()`。

## 8.4 磁盘/容器压力观测与大日志高效管道 {#ch8-4}

### 8.4.1 `vmstat`、`iostat` NVMe 判读与容器 PSI {#ch8-4-1}

```bash
vmstat 1          # 看 r(就绪队列)、b(D态阻塞)、si/so(Swap换入换出颠簸)、cs(上下文切换)、wa(iowait)
iostat -xz 1      # 看 r_await / w_await(读写毫秒延迟) 与 aqu-sz(平均请求队列深度)

# 容器 cgroup v2 限额、回收细分、OOM 事件与 PSI（Pressure Stall Information）停顿观测
cat /sys/fs/cgroup/<pod_path>/memory.{current,max,events,pressure,stat}
```

### 8.4.2 实战四：Nginx 大日志安全分析与单趟 `awk` 边界 {#ch8-4-2}

处理线上 GB 级日志严守两条铁律：**先 `ls -lh` 看大小（禁直接 `cat` 或全量外部 `sort` 打满临时磁盘），交互浏览用 `less` / `tail`**。在**默认 Combined 日志格式**（第 1 列为直连对端 IP，存在七层代理时须改取真实客户端列；第 4 列为 `[10/Nov/2026:...` 时间；第 7 列为请求 URI；第 9 列为状态码）且**去重后唯一键基数可控**（如几十万至百万级以内）的前提下，用 `awk` 关联数组单趟 `O(N)` 聚合可省去昂贵的 `sort | uniq -c` 外部排序：

```bash
# 1. 按天统计独立客户端 IP 数（粗略近似 UV；受共享 NAT 与代理影响不等于真实自然人数）
awk '{day = substr($4, 2, 11); if (!seen[day, $1]++) ips[day]++} END {for (d in ips) print d, ips[d]}' access.log | sort

# 2. 精确统计 HTTP 500 状态码（$9 == 500）下出现次数 Top 5 的请求路径（先用 split 剥离 ? 后高基数动态查询参数防撑爆内存！）
awk '$9 == 500 {split($7, u, "?"); cnt[u[1]]++} END {for (p in cnt) print cnt[p], p}' access.log | sort -rn | head -n 5
```

> **高基数内存边界提示**：`awk` 关联数组常驻内存，若不对包含随机 Token/时间戳的 `$7` 做路径归一化，或遭遇数千万随机伪造源 IP 攻击，哈希表本身仍可能耗尽数 GB 内存；超大规模/超高基数场景应离线导入列式分析库（ClickHouse）或采用流式 HyperLogLog / 分桶统计。

## 练习 {#ch8-exercises}

本节包含 5 道实战排障推演题，覆盖全连接队列溢出、收包分层积压定界、主机 Swap 颠簸、容器 cgroup v2/PSI OOM 证据闭环及大日志命令重构。请先独立推演，再展开答案核对。

### 练习 1：根据 `ss` 与 `nstat` 输出诊断建连故障

某线上 API 网关监听 8080 端口，客户端频繁报 `connect timeout`，服务端采样如下：

```text
$ ss -lnt sport = :8080
State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port
LISTEN  129     128     0.0.0.0:8080         0.0.0.0:*

$ nstat -az TcpExtListenOverflows TcpExtListenDrops
TcpExtListenOverflows           48210
TcpExtListenDrops               48210
```

1. 解释 `LISTEN` 态下 `Recv-Q = 129` 与 `Send-Q = 128` 的含义，以及为何 `Recv-Q` 能等于 `Send-Q + 1`；
2. 给出短期扩容参数与长期根因排查方向。

<details>
<summary>查看参考答案</summary>

1. **含义**：`Send-Q = 128` 为全连接队列上限，`Recv-Q = 129` 为当前积压未 `accept()` 的连接数（内核判定满的条件是 `sk_ack_backlog > sk_max_ack_backlog`，故允许存满至 `128 + 1 = 129` 后才拒绝第 130 个连接）。配合 `ListenOverflows` 攀升，确诊为**全连接队列溢出**。
2. **处置**：短期同时调大内核 `net.core.somaxconn`（如 `4096`）与应用层 `listen backlog`（取较小值生效，故只改内核参数而应用写死 128 依然无效！）；长期排查应用层为何消费新连接过慢（如线程阻塞、GC 停顿或容器 CPU Throttling）。

</details>

### 练习 2：区分网卡 `overruns` 增长与 `ESTAB` 态 `Recv-Q` 积压

两台延迟升高的主机分别呈现不同异常：
- **主机 A**：`ip -s link` 显示 RX `overruns` 持续增长，同时某核 `si` 跑满；
- **主机 B**：`ip -s link` 错包全为 0，但 `ss -nt` 显示大量 `ESTAB` 连接的 `Recv-Q` 长期堆积数 MB。

请定位各自瓶颈所在层级并给出修复手段。

<details>
<summary>查看参考答案</summary>

- **主机 A（驱动层 RX Ring Buffer 溢出）**：网卡 DMA 收包速率快于内核 `NET_RX` 软中断摘包速率。应通过 `ethtool -G eth0 rx 4096` 扩容环形缓冲，并开启多队列 RSS 将中断分流至多核。
- **主机 B（用户态应用消费慢于接收速率）**：报文已顺利穿过网卡与 TCP 协议栈进入 Socket 接收缓冲区，是**业务进程调用 `read()` 速度跟不上**导致积压（继而引发 TCP 接收窗口收缩反压对端）。应直接剖析应用进程阻塞栈、慢 SQL 或锁争用。

</details>

### 练习 3：从 `vmstat` 与 `iostat` 联合输出还原系统雪崩现场

某数据库主机夜间响应骤降：`vmstat 1` 看到 `si`/`so` 持续数万、`wa` 达 45%、`us` 仅 10%；`iostat -xz 1` 显示磁盘 `r_await`/`w_await` 飙至 80 ms。请还原内核故障链并给出治理方案。

<details>
<summary>查看参考答案</summary>

- **故障链还原**：典型**内存 Swap 颠簸（Thrashing）**。夜间任务与数据库撑爆物理内存，内核疯狂将热匿名页换出（`so` 飙升）又瞬间触发主缺页换入（`si` 飙升）；海量随机页交换打满存储队列使磁盘延迟飙至 80 ms，所有业务线程挂起在 `D` 状态等磁盘（`wa = 45%`），CPU 空闲干等。
- **治理方案**：用 cgroups v2 `memory.max` 限制批处理内存，为数据库预留安全余量，将数据库机器 `vm.swappiness` 调至 `1`（或禁用磁盘 Swap），并将重批处理迁离在线库节点。

</details>

### 练习 4：宿主机 `available` 充裕但容器反复退出（Exit 137）的证据闭环诊断

一台 64 GiB 物理内存的宿主机上 `free -h` 显示 `available` 仍有 **20 GiB**，但某核心业务容器每隔十几分钟便以退出码 **`137`** 重启，且重启前数分钟接口 P99 延迟剧烈抖动。

1. 解释为何宿主机仍有 20 GiB 可用内存，该容器依然可能因内存触顶被杀；
2. 写出宿主机核查该容器 **cgroup v2** 的核心文件（`memory.current`/`max`、`memory.events`、`memory.pressure` 及 `memory.stat`），并准确说明它们各自能证明到哪一步（注意区分内存压力来源与全局/局部 OOM 计数边界）；
3. 为什么不能单凭退出码 `137` 定性为容器 OOM？如何按时间窗口完成严谨闭环？

<details>
<summary>查看参考答案</summary>

1. **隔离边界**：`free -h` 只反映宿主机全局剩余可回收内存；容器受自身 cgroup v2 `memory.max` 硬限约束，只要计入该 cgroup 的匿名页、PageCache 与内核 Slab 总和顶满 `memory.max` 且组内回收无果，即在该 cgroup 作用域内触发 OOM Killer。
2. **cgroup v2 指标的精确证据强度**：
   - `memory.current` vs `memory.max`（及软限 `memory.high`）：确认容器内存是否紧贴限额运行；
   - `memory.pressure`（PSI）：若重启前 `some`/`full` 百分比持续飙升，证明任务因**内存压力**发生了实质性停顿（解释了重启前 P99 延迟毛刺；注：PSI 涵盖直接内存回收 Direct Reclaim、`memory.high` 节流、内存紧缩 Compaction 与 Swap 回读等所有内存停顿，若要进一步实锤是 Direct Reclaim，可对照同目录 `memory.stat` 中 `pgsteal_direct` / `pgscan_direct` 的增量）；
   - `memory.events`：核查故障时间窗口内 `max`、`oom` 与 `oom_kill` 增量（注：内核中整机全局 OOM 若恰好选中杀掉该 cgroup 内的进程，`oom_kill` 同样会加 1；但结合本例宿主机仍有 20 GiB `available` 且 `max`/`oom` 同步增长，指向局部 memcg 触限）。
3. **退出码 `137` 严谨闭环**：**单凭 `137` 绝不足以定性 OOM**——在 Unix/容器约定中 `137` 通常对应 `128 + SIGKILL(9)`（可能源于 OOM Killer、探针失败/优雅停机超时后被 kubelet 发 `SIGKILL` 强杀或外部人工 `kill -9`），甚至程序自身调用 `exit(137)` 也会返回该值。必须按**同一故障时间戳**交叉对齐三项证据：`memory.events` 中 `oom` + `oom_kill` 递增、宿主机 `dmesg -T` 出现指向该 cgroup 的 `Memory cgroup out of memory: Killed process ...` 记录，以及容器运行时记录的 `Reason: OOMKilled`（容器侧 QoS 详见[《凤凰架构》第 8 章练习 1](../architecture/chapter-08#ch8-exercises)）。

</details>

### 练习 5：重构高开销且易误判的大日志统计管道

某同学从 10 GB 标准 Nginx 访问日志中统计 **HTTP 状态码为 `500` 的请求里，访问次数最多的前 5 个接口路径（第 7 列为可能带 `?token=...` 参数的 URI，第 9 列为状态码）**，写下：

```bash
cat access.log | grep " 500 " | awk '{print $7}' | sort | uniq -c | sort -rn | head -n 5
```

指出该写法在**准确性、I/O 开销与高基数参数**上的问题，并给出更安全高效的改写方案。

<details>
<summary>查看参考答案</summary>

- **主要问题**：① `grep " 500 "` 全行文本模糊匹配，响应字节数（第 10 列）恰好为 `500` 时会被误计入；② `cat | grep | awk` 多进程管道冗余拷贝 10 GB 文本，且 `sort | uniq -c` 需对全部命中行做 `O(N log N)` 外部临时文件排序；③ 若 `$7` 带有高基数动态 Query 参数（如 `?req_id=xxx`），既会导致同一接口无法合并计数，改用哈希表时还会撑大内存。
- **高效准确改写（单进程精确匹配第 9 列，剥离动态参数降低基数后单趟聚合）**：

```bash
awk '$9 == 500 {split($7, u, "?"); cnt[u[1]]++} END {for (p in cnt) print cnt[p], p}' access.log | sort -rn | head -n 5
```

</details>

## 面试题 {#ch8-interview}

本节精选 4 道线上排障深水区面试题，采用“工具机制 + 多分支故障推演”考察真实生产诊断能力。

### 面试题 1：高并发服务器上为什么必须用 `ss` 替代 `netstat`？追问：用 `ss -nt` 发现某条 `ESTAB` 连接的 `Send-Q` 长期积压 2 MB，能直接断定是中间网络丢包吗？如何利用 `ss -tin` 的真实指标缩小排查范围？

<details>
<summary>查看参考答案</summary>

**结论**：`netstat` 逐行解析 `/proc/net/tcp` 伪文件，数十万连接下持锁耗时长达数秒；`ss` 经内核 **Netlink `tcp_diag`** 二进制接口直接过滤返回，快一个数量级。**`Send-Q` 积压绝不能直接断定是中间网络丢包**，应执行 **`ss -tin`** 结合内核真实输出字段分流定界。

**关键依据**：
- `ESTAB` 态下 `Send-Q = write_seq - snd_una`，同时包含了“已发出待确认（in-flight）”与“尚积压在本地未发出（`notsent`）”两部分字节。观察 `ss -tin`（注意：`iproute2` 中对端通告的发送窗口字段名为 **`snd_wnd`**，且值为 `0` 的可选字段在输出中会被省略）：
  1. **观测到重传退避**：若 `retrans`（在途/累计重传）持续攀升、`cwnd` 明显受压，说明发送端检测到了报文未获确认并触发重传（至于丢包发生在中间链路、对端网卡 Ring Buffer 还是防火墙，还需结合两端 `ip -s link`/`nstat`/`mtr` 进一步定界）；
  2. **对端接收窗口反压（流量控制受限）**：若无明显重传，但出现 `timer:(persist,...)` 零窗口探测定时器、`rwnd_limited`（受对端接收窗口限制的累计时长）持续增长，或 `snd_wnd` 极小乃至因归零被省略，同时本地 `notsent` 积压巨大——说明**对端内核 Socket 接收缓冲区已满**（对端应用读取慢于发送速率，需去对端查 `Recv-Q` 与进程状态）；
  3. **本地突发写入受限于带宽/Pacing**：窗口与重传均正常，仅 `notsent` 随业务突发大包写入短暂冲高。

</details>

### 面试题 2：`iostat -xz` 显示 NVMe SSD 的 `%util` 达到 100%，一定说明磁盘性能见顶了吗？追问：如果 `iostat` 里磁盘硬件读写延迟 `await` 只有 `0.2 ms` 非常健康，但应用调用 `write()` 却偶发 200 ms 卡顿，问题可能出在内核哪一层？

<details>
<summary>查看参考答案</summary>

**结论**：NVMe 上 `%util = 100%` **不代表饱和**（它只统计“至少有 1 个在途请求的时间占比”，多队列 NVMe 可并行处理上百个请求，应看 `r_await`/`w_await` 是否陡增及 `aqu-sz`/IOPS 是否触顶）；若底层硬件 `await` 极低但缓冲 `write()` 偶发百毫秒毛刺，瓶颈通常在**通用块层之上的 PageCache 脏页同步限流或文件系统锁**。

**关键依据**：
- **脏页触顶前台阻塞（Dirty Throttling）**：当突发写入使内存脏页越过 `vm.dirty_ratio`（或容器 cgroup 脏页阈值）时，内核不再允许 `write()` 写完内存立刻返回，而是强行把当前业务线程拉去同步等待脏页回写节流！
- **文件系统层串行锁**：Ext4 JBD2 日志事务切换等待或同一文件 `inode` 互斥写锁争用，同样发生在块设备层之上（因此块层的 `iostat await` 看起来依然很低）。可用 eBPF 工具 `ext4slower` / `xfsdist` 直接对比 VFS 层耗时与块层耗时实锤。

</details>

### 面试题 3：线上怀疑报文进了服务器却没到应用程序，如何精准查出丢在内核哪一行？追问：在服务端运行 `tcpdump -i eth0`，入站包被本机防火墙 `INPUT` 链丢弃能抓到吗？出站包被 `OUTPUT` 链丢弃能抓到吗？

<details>
<summary>查看参考答案</summary>

**结论**：定位内核协议栈静默丢包可直接用 `bpftrace` 订阅 **`tracepoint:skb:kfree_skb`**（Linux 5.17+ 原生携带细粒度 `SKB_DROP_REASON_*` 原因码与内核调用栈，或使用 `pwru` / `dropwatch`）；**入站被本机防火墙丢弃的包 `tcpdump` 抓得到，而出站被本机防火墙丢弃的包 `tcpdump` 抓不到**！

**关键依据**：
- `tcpdump` 基于 `AF_PACKET` 挂在接近网卡驱动的设备层（`dev_queue_xmit_nit` / `__netif_receive_skb_core`）：
  - **入站顺序**：`网卡驱动 → tcpdump 抓包点 → netfilter (PREROUTING / INPUT) → Socket`。因此 `tcpdump` 看到客户端发来了 `SYN` 却没看到本机回 `SYN+ACK`，首要排查本机 `nftables`/`iptables` 拦截、反向路径过滤 `rp_filter` 丢包或全连接队列静默溢出；
  - **出站顺序**：`Socket → netfilter (OUTPUT / POSTROUTING) → tcpdump 抓包点 → 网卡驱动`。若出站包在 `OUTPUT` 链被规则 `DROP`，根本走不到 `tcpdump` 挂载点。

</details>

### 面试题 4：线上某高负载服务出现偶发延迟尖刺或疑似局部锁卡顿，为什么不能直接在线上实例执行 `gdb -p` 或 `gcore`？在不暂停业务的前提下，如何分别定位“CPU 算力热点”与“线程睡眠/锁等待热点”？

<details>
<summary>查看参考答案</summary>

**结论**：`gdb -p` 和 `gcore` 均基于 `ptrace` 挂载，执行期间会**强制暂停目标进程全部线程（Stop-The-World）**，带流量操作会直接引爆上游超时重试雪崩；生产在线诊断应采用 **On-CPU 采样 + Off-CPU eBPF 追踪**双管齐下的非侵入方案。

**关键依据**：
- **查 On-CPU 算力热点（谁在烧 CPU）**：使用基于硬件 PMU 计数器的 `perf record -F 99 -p <pid> -g -- sleep 15` 生成 **On-CPU 火焰图**，开销通常低于 1%～2%。
- **查 Off-CPU 阻塞热点（为什么不干活卡住了）**：线程等锁、等磁盘、等下游网络时不占 CPU，On-CPU 火焰图完全看不见它！此时应使用基于 eBPF 挂载内核 `sched:sched_switch` 的 **`offcputime`（生成 Off-CPU 火焰图）** 或 **`klockstat` / `futex` 慢路径追踪**（Go/Java 亦可直接拉取内置低开销 `mutex`/`block` profile 与 FlightRecorder），零暂停锁定究竟卡在哪把锁或哪个系统调用上。

</details>

## 参考资料

- [Linux Programmer's Manual: `ss(8)`、`ip(8)`、`nstat(8)`、`perf(1)`](https://man7.org/linux/man-pages/man8/ss.8.html)
- [Brendan Gregg: The USE Method & Off-CPU Analysis](https://www.brendangregg.com/offcpuanalysis.html)
- [bpftrace Reference Guide](https://github.com/bpftrace/bpftrace/blob/master/docs/reference_guide.md)
- [Linux Kernel Documentation: `skb` Drop Reasons (`kfree_skb_reason`)](https://docs.kernel.org/networking/statistics.html)
- [Linux Kernel Documentation: Control Group v2 & Pressure Stall Information (`PSI`)](https://docs.kernel.org/accounting/psi.html)
