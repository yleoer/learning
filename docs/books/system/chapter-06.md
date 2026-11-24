---
title: 第 6 章 文件系统与存储 I/O
description: 整合虚拟文件系统、Ext4/XFS/OverlayFS、设备驱动与 DMA、NVMe blk-mq 多队列块层，以及页缓存落盘语义与 Linux io_uring 真异步 I/O。
---

# 第 6 章 文件系统与存储 I/O

## 本章要点

内存断电即失，持久化数据必须落盘到非易失存储设备；但物理介质只认块地址，各厂商外设控制器的寄存器协议也千差万别。操作系统借助**虚拟文件系统（VFS）**、**页缓存（PageCache）**、**通用块层**与**设备驱动**搭起分层抽象，把异构硬件统一封装为文件与目录。本章整合原书《图解系统》第 6 章、第 7 章与第 5 章磁盘调度内容，补齐原书略过的 **Ext4 区段树（Extent Tree）与日志机制**、容器镜像层底座 **OverlayFS**、Linux **三层打开文件结构**，并将已淘汰的单队列磁盘调度（CFQ）与旧异步 I/O 全面对齐现代 **NVMe + `blk-mq` 多队列块层**与 **Linux `io_uring`**。

读完本章后，应能厘清 `inode`、`dentry`、`struct file` 与 `fd` 的映射关系，掌握 Ext4/XFS 与容器 OverlayFS 的存储特性与性能边界，说明一次 `write() + fdatasync()` 经 `blk-mq`、DMA 与设备 Flush 持久化的完整链路，并准确运用 `O_DIRECT`、原子文件替换与 `io_uring`。

> 核对日期：2026 年 11 月 23 日；核对环境为 Linux 6.12 LTS VFS、Ext4、OverlayFS、Block Layer（`blk-mq`）与 `io_uring` 内核文档。

## 6.1 虚拟文件系统（VFS）与文件核心抽象 {#ch6-1}

### 6.1.1 VFS 与“一切皆文件” {#ch6-1-1}

Linux 同时支持本地磁盘文件系统（Ext4、XFS、Btrfs）、伪文件系统（`/proc`、`/sys`、`tmpfs`）、联合文件系统（OverlayFS）与网络文件系统（NFS）。**虚拟文件系统（VFS）**向上提供统一的 `open`/`read`/`write`/`fsync` 接口，内部围绕四个核心对象运作：

- **超级块（`super_block`）**：整个文件系统的全局元信息（块大小、`inode` 总数与空闲统计），**挂载（mount）时**加载入内存。
- **索引节点（`inode`）**：文件的**唯一持久化身份标识**，记录文件大小、权限、属主、时间戳、硬链接计数（`i_nlink`）及数据块位置（**不含文件名**）。
- **目录项（`dentry`）**：**仅驻留内核内存的路径哈希缓存**，记录“文件名 → `inode` 指针”及父子目录关系以加速路径查找（而磁盘上的“目录”本质是特殊文件，其数据块保存子文件名与 `inode` 号映射表）。
- **打开文件对象（`struct file`）**：每次 `open()` 创建的内核会话对象，维护当前读写偏移 `f_pos`、打开标志（如 `O_APPEND`、`O_DIRECT`）与引用计数。

### 6.1.2 Linux 三层打开文件结构（纠偏混淆） {#ch6-1-2}

用户态拿到的**文件描述符（fd）**只是进程私有表下标，内核通过**三层结构**关联到物理文件（原书 6.1 节混同了前两层，必须拆解）：

```text
进程 A (files_struct)            系统级打开文件表 (struct file)          全局 inode 表 (struct inode)
+-----+------+                   +----------------------------+          +------------------------+
| fd3 |  * --+------------------>| f_pos(偏移) | flags | ref=2 |--------->| inode #1024            |
+-----+------+                   +----------------------------+          | 权限 / 大小 / 数据块位置 |
                                               ^                         +------------------------+
进程 B (fork 继承)                             |                                      ^
+-----+------+                                 |                                      |
| fd3 |  * --+---------------------------------+                                      |
+-----+------+                                                                        |
                                 +----------------------------+                       |
进程 C (独立 open 同一文件) ---->| f_pos(独立) | flags | ref=1 |-----------------------+
                                 +----------------------------+
```

1. **`fork()` 继承（或 `dup2`/`SCM_RIGHTS` 传递）共享偏移**：指向**同一个 `struct file`**，一方 `read()` 推进 `f_pos` 会直接影响另一方。
2. **独立 `open()` 同一文件偏移隔离**：各自创建独立的 `struct file`（独立 `f_pos`），底层共享同一个 `struct inode`（多进程并发写日志须开启 `O_APPEND` 由内核原子定位文件尾）。

### 6.1.3 硬链接与软链接 {#ch6-1-3}

| 特性 | 硬链接（Hard Link，`ln src dst`） | 软链接 / 符号链接（Symbolic Link，`ln -s src dst`） |
| --- | --- | --- |
| **底层本质** | 多个目录项直接指向**同一个 `inode`**，`i_nlink + 1` | 新建独立文件并拥有**独立的 `inode`**，数据内容为目标路径字符串 |
| **跨文件系统 / 链目录** | **不支持**跨文件系统，且禁止普通用户硬链目录防成环 | **均支持** |
| **删除源文件后** | 只要 `i_nlink > 0` 数据完好；归零且无进程打开（`i_count == 0`）才释放磁盘块 | 变成指向不存在路径的**悬空链接（Dangling Link）** |

> **线上高频故障**：`rm` 删除几十 GB 的活跃日志文件后，若服务进程未关闭对应 `fd`（`i_count > 0`），磁盘块绝不会释放（表现为 `df -h` 100% 满而 `du` 查不到大文件），须用 `lsof +L1` 定位进程重开日志释放空间。

## 6.2 文件磁盘布局：Ext4、XFS 与容器 OverlayFS {#ch6-2}

### 6.2.1 逻辑块、位图与历史索引演进 {#ch6-2-1}

现代大容量磁盘与 SSD 普遍采用 **4Kn（4096 字节物理扇区）**，Linux 文件系统默认以 **4 KB 逻辑块**为最小分配单位，并通过划分**块组（Block Group）**配合**数据位图 / `inode` 位图**高效管理空闲空间。早期数据块组织从连续分配（易生外部碎片）、FAT 链表（大盘占内存）演进至 Ext2/Ext3 的**12 直接块 + 一/二/三级间接索引块**——虽兼顾小文件速度，但面对 GB 级大文件仍存在间接元数据庞大、随机寻址深与删除缓慢的瓶颈。

### 6.2.2 现代生产文件系统核心机制 {#ch6-2-2}

1. **Ext4 — 区段树（Extent Tree）与日志（Journaling）**：
   - **Extent 取代间接块指针**：用 12 字节结构体 `(起始逻辑块, 连续块数, 起始物理块)` 描述整段连续空间（单 Extent 即可映射 128 MB 连续文件），大碎片文件自动组织为浅层 Extent B+ 树，配合**延迟分配（Delayed Allocation）**大幅减少碎片并实现秒级大文件删除。
   - **日志（Journaling，JBD2）**：修改前先将变更写入日志区（默认 `data=ordered` 保证数据块先于元数据日志落盘），意外断电重启只需重放数秒日志即可恢复一致性，告别数小时的全盘 `fsck`；大目录查找则通过 **HTree** 哈希树维持近似 `O(1)` 性能。
2. **XFS 与 Btrfs/ZFS**：**XFS** 采用独立分配组（AG）并行锁与全 B+ 树索引，支持**动态分配 `inode`**（避免小文件耗尽固定 `inode` 池），擅长高并发大吞吐存储；**Btrfs/ZFS** 则基于写时复制（COW）原生提供秒级快照与端到端数据校验和。
3. **OverlayFS — 容器镜像与沙箱联合文件系统**：Docker、`containerd` 与轻量代码沙箱默认用 OverlayFS 将多层**只读镜像层（`lowerdir`）**与容器私有的**可写层（`upperdir`）**叠加呈现为统一挂载视图（`merged`）：
   - **读操作**穿透直读底层共享文件（多容器共享同一份镜像 PageCache）；**删除底层文件**则在 `upperdir` 创建特殊 Whiteout 遮蔽标记。
   - **`copy_up` 写放大边界**：在默认无克隆支持的底座（如常规 Ext4）上，当容器内对某个位于只读 `lowerdir` 的大文件发起**保留原内容的修改**（如局部改写或追加写；注：若指定 `O_TRUNC` 截断重写可跳过旧数据拷贝，若上下层同处于支持 `FICLONE` 的 XFS reflink / Btrfs 上则可走块克隆）时，内核必须先把**整份文件数据**同步复制到 `upperdir`！这不仅造成首次写延迟尖刺与双倍空间占用，在未开启 `xino` 统一编号或跨文件系统布局下还会使文件可见的 `st_ino` 改变。因此，MySQL/Redis 等数据库数据目录必须挂载独立 Volume（CSI）绕开 OverlayFS。

## 6.3 设备管理、DMA 与现代块存储层（`blk-mq`） {#ch6-3}

### 6.3.1 设备控制器、MMIO 与 DMA {#ch6-3-1}

CPU 通过**内存映射 I/O（MMIO）**读写设备控制器的命令/状态寄存器。为将 CPU 从慢速数据搬运中彻底解放，现代网卡与磁盘均内置 **DMA（Direct Memory Access）控制器**：CPU 仅向驱动下发一次源/目的物理地址与长度描述符便切走执行其他业务；DMA 引擎自行通过 PCIe 总线完成整块内存与设备间的数据传输，仅在全部完成时触发**一次硬中断**通知内核收尾。

### 6.3.2 块层演进：淘汰单队列电梯，统一至 NVMe `blk-mq` {#ch6-3-2}

早期机械硬盘（HDD）受制于 5–10 ms 的磁头寻道延迟，Linux 2.6–4.x 单队列块层围绕电梯合并排序设计了 SSTF/SCAN（电梯）/LOOK 等算法与 `cfq` 调度器。然而在现代 **NVMe SSD**（无机械寻道、随机延迟仅 10–70 µs、PCIe 原生提供数万硬件并行队列）面前，多核争抢单队列全局自旋锁反而成了致命的 CPU 瓶颈！

Linux **3.13 引入了多队列块层 `blk-mq`（Multi-Queue Block Layer）**，并在 **Linux 5.0 彻底移除了传统单队列块层与 CFQ 等旧调度器**，使 `blk-mq` 成为唯一块存储路径：为每个 CPU 核心配置无锁的**软件提交队列**，直通映射至 NVMe 的多条**硬件派遣队列**。现代 `/sys/block/<dev>/queue/scheduler` 可选策略中，NVMe 与高性能云盘默认使用 **`none`**（近乎零调度锁开销直达硬件），SATA/SAS 盘常用防饥饿的 **`mq-deadline`**，桌面或精细限流场景可选 `bfq` 或 `kyber`。

### 6.3.3 端到端链路串联：一次 `write() + fdatasync()` 断电持久化全过程 {#ch6-3-3}

区分“普通 DMA 写请求完成”与“真正落入非易失介质”，把存储栈各层连成一条完整生产时序：

```text
用户进程 write(fd, buf, 4096)
  └──> 1. VFS 经 fd 查 struct file，进入 Ext4 写入内存 PageCache 标脏
         （在未触及 vm.dirty_ratio 等脏页同步节流阈值时，write 立即返回！）
用户进程 fdatasync(fd)
  └──> 2. Ext4 提交脏数据页 bio（若涉及文件扩长或未初始化块首次覆写，同步提交 JBD2 日志事务）
         └──> 3. 通用块层 blk-mq 经本核软件队列派发至 NVMe 硬件队列，DMA 写入设备并经硬中断/BLOCK 软中断完成普通写
                └──> 4. 【持久化屏障】针对带易失性写缓存的存储设备，文件系统/块层下发 REQ_PREFLUSH / REQ_FUA（如 NVMe Flush）
                       └──> 5. 确认数据与必要日志真正刷入非易失 NAND 闪存后，唤醒 fdatasync 返回成功
```

## 6.4 文件 I/O 分类、PageCache 持久化与 `io_uring` {#ch6-4}

### 6.4.1 缓冲 I/O vs 非缓冲 I/O（用户态维度） {#ch6-4-1}

指是否经过标准库用户态缓冲区（如 C `fwrite` vs 系统调用 `write`）。用户态缓冲聚合零碎小写入以削减 `syscall` 次数；若进程崩溃（如 `kill -9`），尚未 `fflush()` 进入内核的缓冲数据会丢失（而宿主机不掉电时，已 `write()` 进内核 PageCache 的数据不会因进程自身崩溃丢失）。

### 6.4.2 直接 I/O vs 非直接 I/O 与安全落盘契约 {#ch6-4-2}

- **非直接 I/O（Buffered / PageCache I/O，默认）**：`write()` 通常仅写内存脏页即返，由内核后台按脏页阈值（`vm.dirty_background_ratio` / `vm.dirty_ratio`）或周期异步回写。
  - **WAL 刷盘铁律**：宿主机断电会丢失未落盘脏页与盘内易失写缓存，数据库写事务日志必须调用 `fsync()` 或更轻量的 **`fdatasync()`**（当文件大小与已初始化块映射均未改变时跳过非必要 `inode` 时间戳写，详见[《MySQL 是怎样运行的》第 8 章 Redo 刷盘策略](../mysql/chapter-08#ch8-2-2)）。
  - **配置文件/快照原子替换三步法**：严禁直接覆写原文件（断电易留半截坏文件），须在**同目录**依次执行：① 写临时文件并 **`fsync(tmp_fd)`**（确保新数据先落盘）；② **`rename(tmp, target)`** 原子切换目录项；③ **`fsync(parent_dir_fd)`** 确保父目录中的新目录项映射也已持久化到磁盘（见[第 7 章大文件传输衔接](./chapter-07#ch7-2-3)）。
- **直接 I/O（`O_DIRECT`）**：绕过 PageCache，要求内存地址、偏移与大小按扇区/页对齐，经 DMA 直连用户态缓冲与磁盘（注：`O_DIRECT` 仅绕过内核 PageCache，若仍需防断电丢失设备内部易失写缓存，依然须配合 `fsync`/`fdatasync` 或 `O_DSYNC`）。专用于**自管缓冲池的数据库**（如 MySQL InnoDB Buffer Pool）与**超大冷文件传输**。

### 6.4.3 同步 vs 异步 I/O 与现代 `io_uring` {#ch6-4-3}

读 I/O 分**阶段 1（设备→内核准备数据）**与**阶段 2（内核→用户态拷贝数据）**。阻塞 I/O、非阻塞轮询与 `select`/`poll`/`epoll` 在阶段 2 仍须应用主动调用 `read()` 同步等待拷贝完成，故均属**同步 I/O**（见[第 7 章 I/O 多路复用](./chapter-07#ch7-3)）；唯有内核包办两阶段并在数据就位后通知应用的才是**异步 I/O**。

早期 POSIX `aio` 靠用户态线程池模拟；Linux 传统原生 AIO（`libaio` / `io_submit`）则**仅对 `O_DIRECT` 具备真正的异步非阻塞能力**——虽然在 API 上也能提交常规缓冲文件读取并拿到完成事件，但未命中缓存时会在 `io_submit()` 调用内直接退化为同步阻塞读取，且不支持网络 Socket。**Linux 5.1+ 引入、6.x 全面成熟的 `io_uring`** 通过 `mmap` 共享无锁 **提交队列（SQ）** 与 **完成队列（CQ）** 彻底统一了真异步存储与网络：

```text
用户态批量填请求 (SQE) ──> [ 共享环形队列 SQ ] ──> 内核异步完成文件(缓冲/直接)或 Socket I/O + 拷入用户缓冲
用户态无锁收割结果     <── [ 共享环形队列 CQ ] <── 内核写入完成事件 (CQE)
```

单次 `io_uring_enter()` 可批量提交上百个异构请求；启用 **`IORING_SETUP_SQPOLL`** 后由内核轮询线程自动拉取 SQ，在重载存储引擎中可实现**零系统调用**提交。

## 练习 {#ch6-exercises}

本节包含 4 道练习，覆盖三层打开文件表行为、已删日志占满磁盘的排障与截断陷阱、数据库 WAL `fdatasync`/`O_DIRECT` 边界及 NVMe `blk-mq` 原理。请先独立作答，再展开核对。

### 练习 1：预测两次打开文件与 `fork()` 后的读写偏移结果

假设文件 `data.txt` 内容为 `"ABCDEFGH"`，分析以下两段 C 伪码在 Linux 下的输出结果：

```c
// 场景 A：先 open，再 fork
int fd = open("data.txt", O_RDONLY);
char buf[3] = {0};
if (fork() == 0) {
    read(fd, buf, 2); // 子进程读 2 字节
    exit(0);
}
wait(NULL);
read(fd, buf, 2);     // 父进程再读 2 字节
printf("A: %s\n", buf);

// 场景 B：先 fork，父子各自 open
if (fork() == 0) {
    int fd1 = open("data.txt", O_RDONLY);
    read(fd1, buf, 2);
    exit(0);
}
wait(NULL);
int fd2 = open("data.txt", O_RDONLY);
read(fd2, buf, 2);
printf("B: %s\n", buf);
```

<details>
<summary>查看参考答案</summary>

- **场景 A 输出：`A: CD`**。`open()` 在 `fork()` 前执行，父子进程 FD 表指向内核中**同一个 `struct file`**，共享 `f_pos`。子进程读走 `"AB"` 将 `f_pos` 推至 `2`，父进程接着读到 `"CD"`。
- **场景 B 输出：`B: AB`**。父子各自调用 `open()`，创建了两个独立的 `struct file`（独立 `f_pos = 0`），仅共享底层 `struct inode`，故父进程仍从头读到 `"AB"`。

</details>

### 练习 2：为什么 `df -h` 显示磁盘使用率 100%，`du -sh /*` 统计总大小却只有 30%？

某线上业务服务器磁盘报警写满（`df -h` 显示 100%），运维直接 `rm` 删掉了一个 50 GB 的活跃日志后再次查看，`df -h` 依然是 100%，但用 `du -sh /*` 统计所有目录总和远小于磁盘总容量。请解释底层原因，并按“需保留日志数据”与“允许丢弃日志应急止血”给出正确处置方案与注意事项。

<details>
<summary>查看参考答案</summary>

- **根因**：`rm` 只删了目录项并令 `inode` 硬链接数 `i_nlink` 归零；但业务进程仍持有该文件的打开描述符（内存引用计数 `i_count > 0`），文件系统不会释放其数据块。`du` 遍历可见目录树统计不到已删项，而 `df` 读取超级块已分配块统计故仍显示 100%。
- **定位与分级处置**：
  1. 先执行 `lsof +L1` 定位仍打开着 `(deleted)` 大文件的进程 PID 与 FD 号；
  2. **需保留日志且稳妥释放（推荐首选）**：若还需抢救最后日志，先从 `/proc/<pid>/fd/<fd>` 拷贝提取所需片段到其他分区，随后向服务进程发送日志重开信号（如 `nginx -s reopen` / `kill -USR1`）或滚动重启进程，使旧 `fd` 正常关闭回收全部磁盘块；
  3. **允许丢弃历史日志且进程不可重启时的应急操作**：可执行 `truncate -s 0 /proc/<pid>/fd/<fd>` 立即清空文件内容归还物理块——但**必须注意两项副作用**：一是原有 50 GB 日志数据彻底丢失；二是 `truncate` **不会重置原打开句柄 `struct file` 中的写偏移 `f_pos`**！如果该进程当初未使用 `O_APPEND` 模式打开日志文件，下次 `write()` 仍会写在 50 GB 偏移处，瞬间形成逻辑大小 `50 GB+`、前端填充全 `\0` 的**稀疏空洞文件（Sparse File）**（虽暂不占 50 GB 物理块，但会导致 `ls -lh` 显示异常及顺序读日志工具读出海量零字节）。

</details>

### 练习 3：数据库写 WAL 为什么必须调用 `fdatasync()`，且数据文件常开启 `O_DIRECT`？

某自研存储引擎采用“先写 WAL 日志，再更新内存索引”，却在压测拔电测试中丢失了最后几百条已返回客户端成功的记录，检查发现写 WAL 只用了 `fwrite()` + `fflush()`。请分析：

1. 为什么调用了 `fflush()` 依然会在宿主机掉电后丢数据？若只是存储引擎进程自己 `SIGSEGV` 崩溃（宿主机未掉电），这批数据会丢吗？
2. 对预先分配好固定大小的循环 WAL 文件，为什么稳态运行时更偏爱 `fdatasync()` 而非 `fsync()`（注意首次覆写预分配块的边界）？
3. 为什么 MySQL InnoDB 数据文件常配置 `O_DIRECT`？

<details>
<summary>查看参考答案</summary>

1. **`fflush()` 边界辨析**：`fflush()` 把标准库用户态缓冲经 `write()` 刷入了内核 **PageCache（DRAM）**。因此若只是**进程自身崩溃**而宿主机内核正常运行，后台回写线程仍会将 PageCache 脏页落盘，**不会丢数据**；但若**宿主机断电或 Kernel Panic**，DRAM 脏页及盘内易失写缓存中的数据全部丢失！必须调 `fdatasync()` 触发落盘与设备 Flush。
2. **`fdatasync()` 收益与预分配边界**：`fsync()` 每次都强制同步文件数据与全部 `inode` 元数据（含 `mtime` 修改时间更新，多出额外的元数据写）；`fdatasync()` 仅在**读取该数据所必需的元数据发生变化**时才刷元数据。注意：若用 `fallocate()` 快速预分配 WAL，底层块初始标为**未写入区段（unwritten extent）**，**第一轮写入时仍须将区段状态转为已写入（written）并提交元数据日志**；但当循环 WAL 文件已被完整写满过一轮、进入后续稳态原地覆写已初始化块时，既不改文件大小也不改 Extent 映射，`fdatasync()` 即可稳定省去元数据落盘开销。
3. **`O_DIRECT` 原因**：InnoDB 自带 16 KB 页管理的 Buffer Pool，绕开内核 PageCache 可消除双重缓存内存浪费、CPU 二次拷贝以及内核脏页集中回写引发的 I/O 抖动。

</details>

### 练习 4：为什么 NVMe SSD 上将 I/O 调度器设为 `none` 往往比开启复杂排序调度器更快？

对比机械硬盘（HDD）与 NVMe SSD 的硬件架构，解释为什么 Linux 引入 `blk-mq`（并在 5.0 移除旧单队列层）后，NVMe 默认调度器为 `none`。

<details>
<summary>查看参考答案</summary>

1. **硬件瓶颈转移**：HDD 受制于毫秒级机械磁头寻道，花几十微秒做电梯排序合并稳赚；NVMe SSD 无机械寻道（几十微秒级随机访问）且内部多闪存通道高度并行，软件层复杂排序毫无收益，反而因软件队列锁与计算增加 CPU 开销与尾延迟。
2. **多队列无锁直通**：NVMe 通过 PCIe 暴露与 CPU 核心数对等的硬件提交/完成队列对，配合 `blk-mq` + `none`，每核 I/O 请求在本核无锁直达对应硬件队列，释放百万级 IOPS 潜能。

</details>

## 面试题 {#ch6-interview}

本节包含 5 道深度文件系统与存储 I/O 面试题，结合云原生 OverlayFS、`io_uring` 安全边界与隐蔽配额排障连环追问。

### 面试题 1：在 Linux 中，文件名保存在 `inode` 里吗？追问：在 Docker/K8s 容器的 OverlayFS 根文件系统中，什么条件下修改基础镜像里的大文件会引发严重卡顿乃至文件 `inode` 号改变？

<details>
<summary>查看参考答案</summary>

**结论**：文件名**不存在** `inode` 中，而是保存在**父目录文件的数据块**里（内存缓存在 `dentry`）；在标准 Ext4 底座的 OverlayFS 中，对底层只读镜像大文件执行**保留原内容的首次写入**会触发整文件同步 **`copy_up`（向上拷贝）**，并在未启用统一编号时改变可见 `st_ino`。

**关键依据**：
- `inode` 只存元数据与块指针，这也是不同目录多个名字可硬链接到同一 `inode` 的根基。
- **OverlayFS `copy_up` 精确触发边界**：基础镜像位于只读 `lowerdir`。若进程以 `O_TRUNC` 截断重写可跳过旧数据拷贝；若上下层同处支持 `FICLONE` 的 XFS（reflink）/ Btrfs 上可走轻量块克隆。但在最常见的默认 Ext4 容器节点上，一旦对 `lowerdir` 中 500 MiB 文件发起局部修改或 `O_APPEND` 追加，内核在写操作前必须先把这 **500 MiB 完整同步复制**到 `upperdir` 新文件中！同时，若上下层跨文件系统或未开启 `xino=on` 选项，`stat()` 看到的 `st_ino` 也会变为上层新文件的 `inode` 号，干扰按 `inode` 追踪偏移的日志组件。

</details>

### 面试题 2：Ext4 的默认日志模式（`data=ordered`）既然能保证文件系统掉电一致性，为什么应用程序直接打开关键配置文件原地覆写，断电重启后还是可能读到半截损坏或全零的文件？

<details>
<summary>查看参考答案</summary>

**结论**：因为文件系统 Journaling 承诺的是**文件系统自身内部元数据（位图、目录树、Extent 树）不自相矛盾损坏**，而**不是应用层多次写入的事务原子性**！

**关键依据**：
- 若应用执行 `open(O_TRUNC)` 先将原文件截断为 0 再调用 `write()` 写入新配置，且未调 `fsync()` 就遭遇断电：截断元数据日志可能已提交，而新数据尚在内存，重启后文件合法地变成了 **0 字节空文件**（或写到一半落盘的半截内容）。
- 要实现应用层断电原子更新（要么完整旧版，要么完整新版），必须遵守 **`write(同目录临时文件) → fsync(tmp_fd) → rename(tmp, target) → fsync(parent_dir_fd)`** 四步契约。

</details>

### 面试题 3：为什么说 `epoll` 属于同步 I/O，而 `io_uring` 才是真异步 I/O？追问：`io_uring` 开启 `SQPOLL` 零系统调用模式有什么生产代价？为什么早期云厂商容器默认 `seccomp` 策略曾禁用 `io_uring`？

<details>
<summary>查看参考答案</summary>

**结论**：`epoll` 仅通知“就绪”，数据从内核拷往用户态仍需应用同步调 `read()` 完成；`io_uring` 由内核异步完成设备读写及用户缓冲填充后经 CQ 通知完成。`SQPOLL` 的代价是**后台内核轮询线程持续消耗独立 CPU 核**，而早期容器默认拦截 `io_uring` 是为了**收敛高权限内核异步子系统的逃逸攻击面**。

**关键依据**：
- **`SQPOLL` 权衡**：开启 `IORING_SETUP_SQPOLL` 后，内核会派生专属 `iou-sqp` 内核线程忙轮询提交队列（空闲超过 `sq_thread_idle` 毫秒才休眠），仅适合极高 IOPS 存储/网关专机；低频负载下开启反而白烧 CPU。
- **容器安全演进**：`io_uring` 可在内核态异步串联执行复杂文件与网络操作，且不逐次经过传统的每次 `syscall` 入口 `seccomp` 审计点，早期内核版本曾曝出多起 `io_uring` 内存越界提权漏洞，因此 Docker / containerd / Google GKE 一度在默认 `seccomp` 配置或 `sysctl kernel.io_uring_disabled` 中将其屏蔽，仅在受信任的高性能服务 Pod 中按需显式放行。

</details>

### 面试题 4：为什么向 `epoll_ctl` 注册普通本地磁盘文件 fd 会直接报错 `EPERM`？像 Go、Node.js 这类单事件循环运行时在读写本地磁盘文件时，底层是怎么避免卡死整个网络事件循环的？

<details>
<summary>查看参考答案</summary>

**结论**：内核认为普通磁盘文件“随时可读可写”（不存在等待外部对端发包的未就绪态），故未实现 VFS `poll` 钩子、`epoll_ctl` 直接拒绝返回 `EPERM`；主流运行时在未切入 `io_uring` 前均依靠**底层阻塞系统调用线程交接或后台 I/O 线程池**避免阻塞网络轮询。

**关键依据**：
- 磁盘文件即便看似可读，一旦未命中 PageCache，调用 `read()` 就会在内核态同步休眠等待块设备 DMA。
- **运行时解法对比**：Node.js（`libuv`）将本地文件读写投递给后台固定大小的 C 线程池执行，完成后用 `eventfd` 唤醒主 `epoll` 循环；Go 运行时则在协程对普通文件发起阻塞 `read` 系统调用时，将当前内核线程 M 与逻辑处理器 P 剥离（Handoff），让其他 M 接管 P 继续调度成千上万个网络协程（现代框架亦正逐步接入 `io_uring` 原生异步文件 I/O）。

</details>

### 面试题 5：Linux 服务器上 `df -h` 显示磁盘还有 50% 空余，但程序新建文件或启动文件变更监控（如热重载工具、K8s 日志采集器）时却报错 `No space left on device`（`ENOSPC`），应如何分层定位？

<details>
<summary>查看参考答案</summary>

**结论**：先用 `strace` 或错误上下文区分是**创建文件失败**还是**注册文件监控失败**——前者最常见于 **`inode` 耗尽**或触碰 **Ext4 root 保留块**，后者则源于 **`inotify_add_watch()` 耗尽了用户监控配额 `max_user_watches`**！

**关键依据**：
1. **新建文件报 `ENOSPC`（查 `df -i` 与保留块）**：① Ext4 格式化时固定了 `inode` 总数，数百万个极小文件占满 `IUse% = 100%` 即无法创建任何文件；② Ext4 默认为 `root` 预留 5% 数据块（`tune2fs -m`），非特权业务用户在磁盘用到 95% 时即报 `ENOSPC`。
2. **文件监控服务报 `ENOSPC`（`df -h` 与 `df -i` 均充裕！）**：当日志 Agent、`tail -f` 或 `kubelet` 调用 **`inotify_add_watch()`** 超出 `/proc/sys/fs/inotify/max_user_watches` 上限时，内核返回的错误码正是 **`ENOSPC`（被标准库打印为 `No space left on device`）**！（注意区分：若是 `inotify_init1()` 超出 `max_user_instances` 实例上限，返回的则是 **`EMFILE` `Too many open files`**；普通文件读写或网络端口 `listen()` 不会消耗 `inotify` 配额。）

</details>

## 参考资料

- [Linux Kernel Documentation: Overview of the Linux Virtual File System](https://docs.kernel.org/filesystems/vfs.html)
- [Linux Kernel Documentation: ext4 Data Structures and Algorithms](https://docs.kernel.org/filesystems/ext4/index.html)
- [Linux Kernel Documentation: Overlay Filesystem (`overlayfs`)](https://docs.kernel.org/filesystems/overlayfs.html)
- [Linux Kernel Documentation: Writeback Cache Control (`REQ_PREFLUSH` / `REQ_FUA`)](https://docs.kernel.org/block/writeback_cache_control.html)
- [Linux Programmer's Manual: `fsync(2)`、`inotify_add_watch(2)` 与 `io_uring(7)`](https://man7.org/linux/man-pages/man7/io_uring.7.html)
