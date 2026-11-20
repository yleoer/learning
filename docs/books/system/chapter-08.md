---
title: 第 8 章 Linux 系统观测、性能排查与实战命令
description: 整合全书系统排障实战，建立基于 USE 方法的现代 Linux 观测工具图谱，详解软中断飙高、多线程死锁、TCP 全连接队列溢出排查以及大日志安全分析管道。
---

# 第 8 章 Linux 系统观测、性能排查与实战命令

## 本章要点

理解硬件缓存、内存页表、调度器、锁、块存储与网络协议栈的最终价值，在于面对线上延迟毛刺、吞吐骤降或进程卡死时，能迅速顺着底层机制定位根因，而不是盲目猜测重启。本章整合原书《图解系统》第 9 章（网络指标与日志分析）、第 1.6 节（软中断排查）、第 4.4 节（死锁排查）以及第 10 章开头的 **TCP 全连接队列溢出排障案例**，淘汰 `ifconfig`/`netstat` 等旧工具为主的写法，建立以 `ip`、`ss`、`nstat`、`vmstat`、`iostat`、`sar`、`perf` 与 `bpftrace` 为核心的现代 Linux 观测与实战排障手册。

读完本章后，应能依据 USE 方法快速定位系统资源瓶颈，独立走通软中断飙高、多线程死锁和 TCP 全连接队列溢出三条高频线上排障闭环，准确解读 `ss` 中 `Recv-Q`/`Send-Q` 在不同状态下的语义，并写出不压垮线上机器的高效大日志分析管道。

> 核对日期：2026 年 11 月 20 日；核对环境为 Linux 6.12 LTS（`iproute2`、`sysstat`、`procps-ng`、`perf` 与 `bpftrace` 工具链）。

## 8.1 系统性能排查方法论与现代工具图谱 {#ch8-1}

### 8.1.1 USE 方法与排查顺序 {#ch8-1-1}

面对“系统变慢”的模糊告警，先用 Brendan Gregg 提出的 **USE 方法**对四大物理资源（CPU、内存、存储 I/O、网络）做 60 秒快速体检，检查每项资源的三个维度：

- **Utilization（使用率）**：资源处于忙碌状态的时间或容量占比（如 CPU `us`/`sy`/`si`、内存已用比例、网卡带宽占比）；
- **Saturation（饱和度）**：资源无法立刻服务而**排队积压**的程度（如 CPU 运行队列长度、内存 Swap/Direct Reclaim、磁盘请求队列深度、TCP 全连接队列积压）；
- **Errors（错误数）**：硬件或协议层报错（如网卡 `dropped`/`overruns`、TCP 重传与丢包、磁盘硬件错、OOM 日志）。

### 8.1.2 经典旧工具与现代推荐工具对照 {#ch8-1-2}

原书部分章节仍同时展示已停止维护的 `net-tools`（`ifconfig`、`netstat`），在现代 Linux 生产环境应优先使用基于 Netlink 与内核统计的高性能工具：

| 观测维度 | 已过时旧工具 | 现代推荐工具 | 核心用途 |
| --- | --- | --- | --- |
| **网卡配置与错包** | `ifconfig` | **`ip -s link` / `ip addr`** | 查看物理连通、MTU、收发错包与丢包统计 |
| **Socket 与队列** | `netstat` | **`ss` / `nstat`** | 基于 Netlink `tcp_diag` 高速查看连接、全连接队列与协议栈计数（高并发下远快于解析 `/proc/net/tcp` 的 `netstat`） |
| **CPU 与进程调度** | — | **`top` / `pidstat` / `vmstat`** | 观测运行队列、上下文切换、`us`/`sy`/`si`/`wa` 及单进程线程开销 |
| **磁盘与存储 I/O** | — | **`iostat -xz` / `iotop`** | 查看 IOPS、吞吐、读写平均延迟（`await`）与队列深度 |
| **网络吞吐与 PPS** | — | **`sar -n DEV,TCP` / `ethtool` / `tcpdump`** | 查看每秒包速率（PPS）、吞吐率、网卡协商速率与抓包分析 |
| **函数级与内核剖析** | — | **`perf` / `bpftrace`（eBPF）** | CPU 火焰图定位热点函数、无侵入动态追踪内核丢包/锁争用/I/O 延迟直方图 |

## 8.2 CPU、软中断与多线程死锁排查实战 {#ch8-2}

### 8.2.1 实战一：软中断 CPU 使用率（`si`）飙高排查 {#ch8-2-1}

当 `top`（按 `1` 展开各核）显示某些核心 `si`（软中断占比）异常偏高，甚至 `[ksoftirqd/N]` 冲上进程榜前列时，按以下四步闭环定位：

```bash
# 1. 动态观察 10 类软中断的变化速率（/proc/softirqs 是开机累计值，必须看差值！）
watch -d -n 1 cat /proc/softirqs

# 2. 若确认 NET_RX 飙升，查看各网卡实时 PPS（包/秒）与吞吐率（KB/秒）
sar -n DEV 1 5

# 3. 检查是否单核倾斜（硬中断集中绑定在少数核）
cat /proc/interrupts | grep -E "CPU0|eth0|ens"

# 4. 抓包分析流量特征（限制抓包数量，-nn 禁用 DNS/端口反查减轻线上开销）
tcpdump -i eth0 -nn -c 200
```

**根因分流判断**：
- 若 `sar -n DEV` 显示 **PPS 极高但吞吐带宽很小**（大量 64 字节小包），且 `tcpdump` 看到来自异常源 IP 的海量 `SYN` 或 UDP 报文 → 极可能是 **SYN Flood / 小包 DDoS 攻击**，应通过防火墙/XDP 限流封禁；
- 若为正常业务流量且仅个别 CPU 核 `NET_RX` 爆满 → 检查并开启网卡多队列 **RSS** 与 IRQ 多核绑核（见[第 7 章收包加速](./chapter-07#ch7-1-2)）；
- 若是业务代码用户态（`us`）或内核态（`sy`）飙高，可直接用 `perf top -g` 或采集 30 秒样本生成火焰图锁定具体热点函数。

### 8.2.2 实战二：C/C++ 多线程死锁定位 {#ch8-2-2}

对于线上僵死不响应、CPU 占用接近 0% 的多线程服务，先区分语言运行时工具（Java 用 `jstack`，Go 用 `pprof` 的 `goroutine`/`mutex` profile）；对于 C/C++ 原生进程，可用 `pstack`（或 `eu-stack`）配合 `gdb` 实锤死锁环路：

```bash
# 1. 间隔几秒连续执行两次 pstack，观察哪些线程一直卡在 __lll_lock_wait / pthread_mutex_lock
pstack <pid>
sleep 3
pstack <pid>

# 2. 确认可疑线程后，使用 gdb 挂载核实各自等待与持有的锁归属（生产高危提示见下文）
gdb -p <pid>
```

在 `gdb` 交互命令行中按如下步骤交叉印证：

```text
(gdb) info threads        # 列出所有线程及其 LWP（轻量级进程号）
(gdb) thread 2            # 切换到阻塞在锁上的线程 2（假设其 LWP 为 87748）
(gdb) bt                  # 查看调用栈，定位到调用 pthread_mutex_lock 的业务栈帧
(gdb) frame 3             # 切入该栈帧，查看正在等待哪把锁（如 mutex_A）
(gdb) p mutex_A           # 查看 __data.__owner 字段 → 若为 87747，说明被线程 3 持有
(gdb) p mutex_B           # 查看 __data.__owner 字段 → 若为 87748，说明被线程 2 持有
```

当“线程 2（87748）持有 `mutex_B` 等待 `mutex_A`”且“线程 3（87747）持有 `mutex_A` 等待 `mutex_B`”闭环成立时，即可确凿定性为死锁，按[第 5 章资源有序分配法](./chapter-05#ch5-4)调整加锁顺序根治。

> **生产安全警示（区分只读观测与 STW 内存转储）**：
> - **需安排暂停窗口的高危取证（`gdb -p` / `gcore`）**：`gdb -p` 挂载后会暂停目标进程全部线程（Stop-The-World），若服务尚有正常请求在跑会立刻引发超时雪崩。GNU `gcore` 也**并非无暂停的非侵入手段**——它底层同样通过 GDB 执行 `attach → dump core → detach`，attach 与转储期间默认暂停目标进程全部线程，且进程内存越大、暂停时间越长、占用的磁盘空间越高。`gcore` 的价值仅在于“导出核心转储后尽快 detach，再在离线环境慢速分析以缩短手工交互停顿”，因此同样必须**先摘除线上流量并预留足够磁盘空间**。
> - **低影响只读观测**：在未摘流的线上节点做初步排查时，应优先使用不暂停进程的只读观测手段——如 `perf` 采样、`bpftrace` 动态追踪锁等待与调用栈，或直接读取 `/proc/<pid>/task/*/stack` 观察阻塞内核栈；确需用户态完整内存现场时，再摘流执行 `gcore` 或 `gdb`。

## 8.3 网络指标观测与 TCP 全连接队列溢出排障 {#ch8-3}

### 8.3.1 核心网络指标与 `ip` / `ss` / `sar` 解读 {#ch8-3-1}

衡量 Linux 网络性能的四个基础指标为：**带宽**（链路最大传输速率，单位 `b/s`；用 `ethtool eth0 | grep Speed` 查看，注意小写 `b` 为 bit）、**延时**（往返 RTT，用 `ping` / `mtr` 观测，注意防火墙禁 ICMP 时 `ping` 不通不代表 TCP/HTTP 不通）、**吞吐率**（实际有效传输速率）与 **PPS（每秒包数）**。

日常观测网口与套接字的三条核心命令：

```bash
# 1. 查看网卡状态、MTU 与收发错包/丢包统计（替代 ifconfig）
ip -s link show eth0
# 关注点：LOWER_UP 表示物理链路连通；RX/TX 的 errors、dropped（内存/协议栈丢弃）、overruns（Ring Buffer 来不及处理溢出）均应为 0

# 2. 分别查看监听队列与已建立 TCP 连接（替代 netstat；注意 -l 仅列 LISTEN 态，看不到已建立连接）
ss -lnt                        # 查看监听端口及其全连接队列 Recv-Q / Send-Q（需进程信息时加 -p）
ss -tin state established      # 查看已建立 TCP 连接及内部状态（含 rtt、cwnd、notsent、retrans 等）
ss -s                          # 查看各类 Socket 汇总统计

# 3. 查看协议栈详细计数变化（替代 netstat -s，-z 显示零值，-a 输出绝对值）
nstat -az | grep -E "TcpExtListen|TcpRetransSegs|TcpExtTCPSynRetrans"
```

**高频必考：`ss` 输出中 `Recv-Q` 与 `Send-Q` 的双重含义**：

| Socket 状态 | `Recv-Q` 含义 | `Send-Q` 含义 |
| --- | --- | --- |
| **`LISTEN`** | **当前全连接队列（Accept Queue）中等待 `accept()` 取走的连接数** | **全连接队列最大容量上限**，等于 `min(net.core.somaxconn, listen 的 backlog)` |
| **`ESTABLISHED`** | Socket 接收缓冲区中**尚未被应用程序 `read()` 读走的字节数** | 内核 `write_seq - snd_una`：**既包含已发出但尚未收到对端 ACK 确认的字节（in-flight），也包含已排入发送队列但尚未发出的字节（`notsent`）** |

> **排障口径校准（Linux 6.12 `net/ipv4/tcp_diag.c`）**：已连接 TCP 套接字的 `Send-Q` 统计的是 `write_seq - snd_una`，涵盖了全部已排入发送队列但尚未确认的字节，并非仅仅“已发未确认”字节。因此**不能单凭 `Send-Q` 偏大就直接断定发生了网络丢包**——对端接收窗口（`rwnd`）缩小或归零、拥塞窗口（`cwnd`）受限，或应用层突发写入过快，都会推高 `notsent` 使 `Send-Q` 增大；排查时必须结合 `ss -tin state established` 输出的 `notsent`、重传计数（`retrans`）与对端接收窗口（`rwnd`）综合判断。

### 8.3.2 实战三：TCP 全连接队列溢出排障闭环 {#ch8-3-2}

本节聚焦线上现场的排查命令与处置闭环；关于半连接队列（Linux 4.4+ 全局 `ehash` 演进）、全连接队列内核机制与 SYN Flood 防御细节，可对照阅读[《图解网络》第 3 章半/全连接队列与 SYN Flood 防御](../network/chapter-03#ch3-3)。

**故障现象**（提炼自原书第 10 章真实案例）：Web 服务运行一段时间后新客户端无法建连，偶发建连超时或连接被重置；在服务端用 `tcpdump` 抓包发现，客户端正常发来了三次握手的最后一个 `ACK`，服务端却毫无响应（或直接回了 `RST`）。

**四步定位与修复**：

1. **查协议栈溢出计数**：执行 `nstat -az TcpExtListenOverflows TcpExtListenDrops`，发现两个计数持续攀升（`ListenOverflows` 直接标明全连接队列溢出）。
2. **核对监听队列饱和度**：执行 `ss -lnt`，看到对应监听端口的 `Recv-Q` 已达到甚至超过 `Send-Q`（例如 `Send-Q` 仅为 `128`，而 `Recv-Q` 为 `129`）。
3. **解释抓包现象**：溢出后的行为由内核参数 `net.ipv4.tcp_abort_on_overflow` 决定：
   - 默认 **`0`**：内核静默**丢弃**客户端第三次握手的 `ACK`（并定时重发 `SYN+ACK` 期待客户端重试时队列已腾空），表现为客户端卡顿超时；
   - 设为 **`1`**：内核立刻回复 **`RST`** 终止连接，便于客户端快速失败重连其他健康节点。
4. **根治调优**：
   - 治本：排查应用程序为何 `accept()` 消费太慢（例如主循环阻塞在慢同步 I/O、GC 停顿或锁争用）；
   - 治标扩容：同时调大内核参数 `net.core.somaxconn` 与应用层 `listen(fd, backlog)` 参数（二者取较小值生效），并视情况核对半连接队列上限 `net.ipv4.tcp_max_syn_backlog`。

## 8.4 内存/磁盘观测、eBPF 工具与大日志分析 {#ch8-4}

### 8.4.1 内存、磁盘快速体检与 `bpftrace` {#ch8-4-1}

```bash
# 1. 每秒输出综合系统概览（r: 可运行任务数；si/so: Swap 换入换出；cs: 上下文切换；wa: iowait）
vmstat 1

# 2. 磁盘详细 I/O 指标（-x 扩展指标 -z 跳过无活动设备）
iostat -xz 1
# 关注点：r_await / w_await（平均读写毫秒延迟）、aqu-sz（平均请求队列长度）。
# 注意：在多队列 NVMe SSD 上，%util 接近 100% 仅表示设备始终有在途请求，并不代表带宽或 IOPS 已饱和，应结合 await 与队列深度综合判断！

# 3. 现代 eBPF 动态追踪示例（bpftrace）：统计各进程发起系统调用次数，零代码侵入
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# 4. 容器 cgroup v2 内存限额与 PSI 压力观测（Linux 4.20+ 内置 PSI，核对用量/OOM 计数/回收停顿）
# cat /sys/fs/cgroup/<cgroup_path>/memory.current /sys/fs/cgroup/<cgroup_path>/memory.max
# cat /sys/fs/cgroup/<cgroup_path>/memory.events /sys/fs/cgroup/<cgroup_path>/memory.pressure
```

### 8.4.2 实战四：Nginx 大日志安全分析与高效管道 {#ch8-4-2}

线上排查接口流量、PV（Page View，总请求次数）、UV（Unique Visitor，按独立 IP 近似去重人数）与异常爬虫时，切记两条安全红线：

1. **先用 `ls -lh access.log` 看文件体积**：GB 级大日志严禁直接在线上执行 `cat` 或海量全量 `sort`（既刷爆终端又吃光磁盘 I/O 与内存）；需要深度离线统计时应 `scp`/`rsync` 到闲置分析机处理。
2. **交互浏览用 `less` 和 `tail`**：`less` 按需分页加载不吃全文件内存；看最新日志用 `tail -n 200` 或实时追踪 `tail -f`。

以标准 Nginx `access.log`（第 1 列为客户端 IP、第 4 列为 `[10/Nov/2026:12:00:01` 时间、第 7 列为请求路径、第 12 列起为 User-Agent）为例，对比传统管道写法与更高效的纯 `awk` 单趟聚合写法（修正原书 9.2 节多处将 `awk` 误写为 `ack` 的笔误）：

```bash
# 1. 统计总 PV（总行数）
wc -l access.log

# 2. 按天统计 PV（传统方式需全量 sort 再 uniq -c；改用单趟 awk 关联数组更快且不占排序临时空间）
awk '{day = substr($4, 2, 11); pv[day]++} END {for (d in pv) print d, pv[d]}' access.log | sort

# 3. 统计总 UV（独立 IP 数）
awk '{seen[$1] = 1} END {print length(seen)}' access.log

# 4. 按天分组统计 UV（原书需两次 awk + sort + uniq；单趟 awk 用组合键去重一步到位）
awk '{day = substr($4, 2, 11); if (!seen[day, $1]++) uv[day]++} END {for (d in uv) print d, uv[d]}' access.log | sort

# 5. 统计访问量 Top 3 请求路径
awk '{cnt[$7]++} END {for (p in cnt) print cnt[p], p}' access.log | sort -rn | head -n 3
```

> **性能差异说明**：`uniq -c` 仅对**相邻重复行**去重，因此传统 `awk | sort | uniq -c` 必须先对数千万行日志做全量外部排序（`O(N log N)`，大量临时磁盘写）；利用 `awk` 关联数组（哈希表）直接按 key 聚合，只需顺序扫描一遍（`O(N)`）且内存中只保存唯一键的数量，最后仅对聚合后的少量结果 `sort -rn`，速度和资源消耗往往领先一个数量级。

## 练习 {#ch8-exercises}

本节包含 5 道实战排障练习，覆盖 `ss` 队列解读、软中断与网卡丢包定位、宿主机磁盘与内存综合诊断、宿主机与容器 cgroup v2 内存限额/PSI 联合诊断以及高效日志统计管道编写。请先独立推演，再展开答案核对。

### 练习 1：根据 `ss` 与 `nstat` 输出诊断建连故障

某线上 API 网关监听 8080 端口，客户端频繁报 `connect timeout`。你在服务端采集到以下片段：

```text
$ ss -lnt sport = :8080
State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port
LISTEN  129     128     0.0.0.0:8080         0.0.0.0:*

$ nstat -az TcpExtListenOverflows TcpExtListenDrops
TcpExtListenOverflows           48210
TcpExtListenDrops               48210
```

1. `Recv-Q = 129` 和 `Send-Q = 128` 分别代表什么？为什么 `Recv-Q` 会比 `Send-Q` 还大 1？
2. 给出短期应急扩容参数与长期应用层排查方向。

<details>
<summary>查看参考答案</summary>

1. **含义**：在 `LISTEN` 状态下，`Send-Q = 128` 是该端口 **TCP 全连接队列（Accept Queue）的最大容量**，`Recv-Q = 129` 是当前积压在队列中等待应用 `accept()` 的连接数（Linux 内核全连接队列判定溢出条件为 `sk_ack_backlog > sk_max_ack_backlog`，因此实际最多可暂存 `Send-Q + 1` 个连接）。结合 `TcpExtListenOverflows` 激增，确认发生了严重的**全连接队列溢出**。
2. **处置方向**：
   - **短期扩容**：同时检查并调大内核 `net.core.somaxconn`（如调至 `4096`）以及网关代码/配置中 `listen()` 的 `backlog` 参数（二者取最小值生效）；
   - **长期治本**：排查网关进程为何来不及调用 `accept()`（如单线程事件循环中混入了同步阻塞操作、线程池耗尽、严重 GC 停顿或 CPU 被 cgroups 限流）。

</details>

### 练习 2：区分 `ip -s link` 中 `overruns` 增长与 `ESTAB` 下 `Recv-Q` 积压

两台业务服务器均出现接口延迟升高，分别观察到不同指标异常：
- **主机 A**：`ip -s link` 显示 RX 方向 `overruns` 持续增长，同时 CPU `si` 飙高；
- **主机 B**：`ip -s link` 各项错包均为 0，但 `ss -nt` 显示大量 `ESTAB` 连接的 `Recv-Q` 长期积压几十 KB 到数 MB。

请判断两台主机的瓶颈分别位于网络收包链路的哪一层，并给出对应的调优方向。

<details>
<summary>查看参考答案</summary>

- **主机 A（底层网卡驱动 / Ring Buffer 瓶颈）**：RX `overruns` 增长意味着网卡硬件收包速率超过了内核 `NET_RX` 软中断从 **RX Ring Buffer** 摘取数据包的速度，导致环形缓冲区溢出直接丢包。应调大网卡 RX Ring Buffer 尺寸（`ethtool -G eth0 rx 4096`）、开启多队列 RSS 将中断打散到多核，或排查是否遭遇小包洪泛攻击。
- **主机 B（应用层消费速度瓶颈）**：底层驱动与协议栈健康无丢包，但 `ESTAB` 状态的 `Recv-Q` 持续堆积说明数据已经安稳抵达 **Socket 接收缓冲区**，而**用户态应用程序调用 `read()` 消费数据的速度远远跟不上对端发送速度**（随后会导致 TCP 接收窗口归零、触发流量控制反压发端）。应排查业务线程阻塞、下游慢查询或消费者并发不足。

</details>

### 练习 3：从 `vmstat` 与 `iostat` 联合输出定位系统卡顿根因

某数据库主机在夜间批处理期间响应骤降，执行 `vmstat 1` 看到 `si`/`so`（每秒 Swap 换入/换出 KB 数）持续在数万级别，`wa`（iowait）飙升至 45%，而 `us` 仅 10%；同时 `iostat -xz 1` 显示系统盘 `r_await` / `w_await` 高达 80 ms。请还原此时操作系统内部正在发生什么，并提出治理思路。

<details>
<summary>查看参考答案</summary>

- **根因还原**：系统发生了严重的**内存颠簸（Thrashing）**。批处理任务与数据库共同耗尽了物理内存，内核被迫频繁将匿名页换出到磁盘 Swap（`so` 飙升）又因数据库再次访问而立即触发主缺页从 Swap 换回（`si` 飙升）；大量随机 Swap I/O 打满磁盘队列，把磁盘 `await` 拖高至 80 ms，进而导致整个系统线程大量阻塞在 `iowait`（`wa = 45%`），CPU 反而大部分时间在空等磁盘。
- **治理思路**：
  1. 用 cgroups v2 隔离并限制批处理任务的内存上限（`memory.max`），防止挤占数据库工作集；
  2. 合理调低数据库内存池（如 InnoDB Buffer Pool）使常驻集留有安全余量，并视业务SLA 调低 `vm.swappiness`（如 `1`）减少不必要的匿名页换出，或将重型批处理迁至离线节点。

</details>

### 练习 4：宿主机 `available` 充裕但容器进程反复异常退出的联合诊断

一台 64 GiB 物理内存的 Linux 6.12 宿主机上运行着多个业务容器。晚高峰期间，运维在宿主机执行 `free -h` 看到 `available` 仍有 **20 GiB**、整机未发生 Swap 颠簸，但其中某个核心服务容器却每隔十几分钟便突然异常退出（退出码 **`137`**），且每次重启前的几分钟内业务 P99 延迟持续飙升。

1. 为什么宿主机 `free -h` 显示还有 20 GiB `available`，该容器进程仍可能因内存耗尽被内核终止？
2. 请写出在宿主机上进入该容器对应 **cgroup v2** 目录后应重点核查的四项接口文件（`memory.current`、`memory.max`、`memory.events` 以及 **`memory.pressure`（PSI）**），并说明它们各自用来印证什么结论。
3. 能否仅凭容器退出码 `137` 就直接定性为 OOM？应结合哪些证据完成闭环确认？

<details>
<summary>查看参考答案</summary>

1. **宿主机视图与容器限额视图分离**：容器与宿主机共享同一个 Linux 内核，宿主机 `free -h` 读取的是全局 `/proc/meminfo`，只反映整台物理机的剩余可回收内存；而每个容器受自身 **cgroup v2** 内存硬限（`memory.max`）严格隔离。只要该容器进程及其计入该 cgroup 的匿名页、页缓存（PageCache）与内核对象（Slab）总用量逼近并顶满 `memory.max`，且内核回收后仍无法满足新分配请求，就会在**该 cgroup 内部**触发 cgroup OOM Killer，与宿主机全局是否还有 20 GiB 可用内存无关。
2. **cgroup v2 与 PSI 联合核查清单**：
   - **`memory.current` vs `memory.max`（及软节流阈值 `memory.high`）**：比对容器当前内存使用量与硬限/软限配置，判断容器是否已长期紧贴限额运行；
   - **`memory.events`**：重点观察 **`oom`**（触及硬限并进入 OOM 路径的累计次数）和 **`oom_kill`**（实际由 cgroup OOM Killer 强杀进程的次数）是否在故障时段同步递增，同时结合 `high`、`max` 计数判断节流与触顶频率；
   - **`memory.pressure`（PSI，Pressure Stall Information）**：检查 `some`（至少有一个任务因等待内存回收而停顿的时间占比）与 `full`（容器内全部非空闲任务同时因内存回收停顿的时间占比）在 `avg10` / `avg60` / `avg300` 窗口的读数。若进程被杀前几分钟 `some`/`full` 持续攀升，即说明容器在真正 OOM 之前已陷入严重的**内存回收抖动（频繁触发 Direct Reclaim 阻塞工作线程）**，这正是重启前业务 P99 延迟飙升的直接原因。
3. **退出码 `137` 的严谨辨析**：**不能单凭退出码 `137` 断定 OOM。**退出码 `137`（`128 + 9`）仅说明进程收到了 `SIGKILL (9)`——除了 cgroup OOM Killer 强杀外，容器优雅停机超时（如 `SIGTERM` 后超出宽限期被运行时强杀）或外部运维手工 `kill -9` 同样会产生 `137`。必须交叉印证 cgroup v2 `memory.events` 中的 `oom_kill` 增量、宿主机内核日志（`dmesg -T` 中的 `Memory cgroup out of memory` 记录）或编排层终止原因（如 Kubernetes `State.Terminated.Reason == OOMKilled`），方可最终实锤（容器侧 QoS 与退出码 137 完整案例详见[《架构修炼指南》第 8 章练习 1](../architecture/chapter-08#ch8-exercises)）。

</details>

### 练习 5：优化一条慢速大日志统计命令

某同学需要从一份 10 GB 的 Nginx 访问日志中统计 **HTTP 状态码为 `500` 的请求里，访问次数最多的前 5 个 URL（第 7 列，状态码在第 9 列）**，写出了如下命令：

```bash
cat access.log | grep " 500 " | awk '{print $7}' | sort | uniq -c | sort -rn | head -n 5
```

请指出这条命令的三处性能或准确性问题，并用更安全、高效的写法改写。

<details>
<summary>查看参考答案</summary>

**三处问题**：
1. **准确性隐患**：`grep " 500 "` 是纯文本模糊匹配，如果响应字节数（第 10 列）或 User-Agent 中恰好出现 `" 500 "`，会被误判为 500 状态码；
2. **多余进程与管道拷贝**：无意义的 `cat | grep | awk` 开了 3 个进程与 2 条管道，反复拷贝 10 GB 数据；
3. **昂贵的全量排序**：`sort | uniq -c` 会对所有命中 500 的 URL 先做全量排序，若故障期间有数百万条 500 日志，会消耗大量内存与临时磁盘写。

**高效准确改写（单进程单趟 `awk` 精确匹配第 9 列并哈希聚合）**：

```bash
awk '$9 == 500 {cnt[$7]++} END {for (url in cnt) print cnt[url], url}' access.log | sort -rn | head -n 5
```

（仅扫描文件一遍、精确匹配字段 `$9 == 500`，内存中只保留去重后的不同 URL 计数，最后只对少量聚合结果排序。）

</details>

## 面试题 {#ch8-interview}

本节精选 4 道线上排障高频面试题，聚焦工具原理差异与生产误区。

### 面试题 1：为什么生产环境高并发服务器上强烈推荐用 `ss` 替代 `netstat`？

<details>
<summary>查看参考答案</summary>

**结论**：因为 `netstat` 需要遍历读取并解析 `/proc/net/tcp` 等文本伪文件，高并发下锁争用与耗时极大；而 **`ss` 通过 Netlink 接口（`tcp_diag` 内核模块）直接获取二进制套接字信息**，速度往往快数十倍。

**关键依据**：
- 当单机存在数万甚至数十万条 TCP 连接时，执行 `netstat` 会逐一遍历内核哈希表并格式化成庞大文本，不仅自身耗时长达数秒，还会长时间持有内核套接字表锁，可能加剧线上业务抖动；
- `ss` 属于持续维护的 `iproute2` 套件，支持内核态直接过滤条件并高效返回，对线上影响极小。

</details>

### 面试题 2：在 `iostat -xz` 输出中，NVMe SSD 的 `%util` 达到 100% 是否一定说明磁盘已经到达性能上限？

<details>
<summary>查看参考答案</summary>

**结论**：**不一定。** 这一经验只适用于单队列机械硬盘，在支持高并发多队列的 **NVMe SSD** 上极具误导性。

**关键依据**：
- `%util` 的定义是“采样周期内，设备**至少有 1 个在途 I/O 请求**的时间占比”。
- 机械硬盘一次只能服务 1 个请求，因此 `%util = 100%` 确实接近饱和；但 NVMe SSD 可并行处理数十上百个请求，即使每毫秒都刚好只有 1 个请求在途（远未触及 IOPS 与带宽上限），`%util` 也会显示 100%。
- 判断 NVMe 是否真正饱和，应重点观察 **`r_await`/`w_await`**（延迟是否非线性陡增）、**`aqu-sz`**（队列深度）以及实际吞吐/IOPS 是否逼近硬件规格上限。

</details>

### 面试题 3：线上怀疑有网络数据包在 Linux 内核协议栈里被静默丢弃，除了 `tcpdump` 和 `nstat`，现代 Linux 还有什么更精准的定位方式？

<details>
<summary>查看参考答案</summary>

**结论**：可结合 **`dropwatch`** 或基于 **eBPF（`bpftrace` / `pwru`）** 挂载内核丢包追踪点 **`tracepoint:skb:kfree_skb`**，直接打印每个被丢弃数据包的**精确内核丢包原因码与调用栈**。

**关键依据**：
- `tcpdump` 只能看到包进了网卡却没到应用，难以直接说出协议栈哪一行丢了包；
- 自 **Linux 5.17+ 起**，内核为 `kfree_skb_reason()` 全面引入了细粒度丢包原因枚举（`SKB_DROP_REASON_*`，如 `SOCKET_RCVBUFF`、`TCP_CSUM`、`IP_INNOROUTES` 等），用 `bpftrace` 订阅 `tracepoint:skb:kfree_skb` 即可低开销精准定位丢包根因。

</details>

### 面试题 4：`top` 显示某 8 核服务器平均负载（Load Average）为 20，但 CPU 总使用率只有 15%，最可能是什么原因？

<details>
<summary>查看参考答案</summary>

**结论**：Linux 的 Load Average 不仅统计正在运行和等待 CPU 的 **`R` 状态任务**，还统计处于**不可中断睡眠 `D` 状态**（通常为等待磁盘/NFS I/O）的任务数。

**关键依据**：
- CPU 使用率低但 Load 极高，是典型的 **I/O 瓶颈或存储故障特征**——大量线程卡在 `D` 状态等待慢速磁盘、Swap 颠簸或失联的 NFS 挂载。
- 可立刻结合 `vmstat 1`（看 `b` 不可中断阻塞列与 `wa`）、`iostat -xz 1` 及 `ps -eo stat,pid,comm | grep '^D'` 核实并定位阻塞源。

</details>

## 参考资料

- [Linux Programmer's Manual: `ss(8)`、`ip(8)`、`nstat(8)`、`perf(1)`](https://man7.org/linux/man-pages/man8/ss.8.html)
- [sysstat Documentation: `sar(1)` 与 `iostat(1)`](https://github.com/sysstat/sysstat)
- [Brendan Gregg: The USE Method & Linux Performance Tools](https://www.brendangregg.com/usemethod.html)
- [bpftrace Reference Guide](https://github.com/bpftrace/bpftrace/blob/master/docs/reference_guide.md)
- [Linux Kernel Documentation: `skb` Drop Reasons (`kfree_skb_reason`)](https://docs.kernel.org/networking/statistics.html)
- [Linux Kernel Documentation: Control Group v2 (`cgroup-v2`)](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [Linux Kernel Documentation: Pressure Stall Information (`PSI`)](https://docs.kernel.org/accounting/psi.html)
