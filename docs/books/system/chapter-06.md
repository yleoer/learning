---
title: 第 6 章 文件系统与存储 I/O
description: 整合虚拟文件系统、Ext4/XFS/OverlayFS、设备驱动与 DMA、NVMe blk-mq 多队列块层，以及页缓存落盘语义与 Linux io_uring 真异步 I/O。
---

# 第 6 章 文件系统与存储 I/O

## 本章要点

内存断电即失，持久化数据必须落盘到非易失存储设备；但物理介质只认块地址，各厂商外设控制器的寄存器协议也千差万别。操作系统借助**虚拟文件系统（VFS）**、**页缓存（PageCache）**、**通用块层**与**设备驱动**搭起分层抽象，把异构硬件统一封装为文件与目录。本章整合原书《图解系统》第 6 章、第 7 章与第 5 章磁盘调度内容，补齐原书略过的 **Ext4 区段树（Extent Tree）与日志机制**、容器镜像层底座 **OverlayFS**、Linux **三层打开文件结构**，并将已淘汰的单队列磁盘调度（CFQ）与旧伪异步 I/O 全面升级为现代 **NVMe + `blk-mq` 多队列块层**与 **Linux `io_uring`**。

读完本章后，应能厘清 `inode`、`dentry`、`struct file` 与 `fd` 的映射关系，掌握 Ext4/XFS 与容器 OverlayFS 的存储特性与性能边界，说明一次 `write() + fdatasync()` 经 `blk-mq` 与 DMA 落盘的完整链路，并准确运用 `O_DIRECT`、原子文件替换与 `io_uring`。

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

> **线上高频故障**：`rm` 删除几十 GB 的活跃日志文件后，若服务进程未关闭对应 `fd`（`i_count > 0`），磁盘块绝不会释放（表现为 `df -h` 100% 满而 `du` 查不到大文件），须用 `lsof +L1` 定位进程重开日志或清空句柄。

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
   - **`copy_up` 写放大陷阱**：当容器内首次打开并修改某个位于只读 `lowerdir` 的文件时（哪怕只改 1 字节），内核必须先把**整份文件**同步复制到 `upperdir`！若基础镜像内含数百 MB 文件并在运行时修改，会造成剧烈 I/O 卡顿且修改后 `inode` 号发生改变。因此，MySQL/Redis 等有状态存储目录必须通过绑定挂载或 K8s Volume（CSI）直接落到宿主机 Ext4/XFS 上，严禁写在容器 OverlayFS 根分区内。

## 6.3 设备管理、DMA 与现代块存储层（`blk-mq`） {#ch6-3}

### 6.3.1 设备控制器、MMIO 与 DMA {#ch6-3-1}

CPU 通过**内存映射 I/O（MMIO）**读写设备控制器的命令/状态寄存器。为将 CPU 从慢速数据搬运中彻底解放，现代网卡与磁盘均内置 **DMA（Direct Memory Access）控制器**：CPU 仅向驱动下发一次源/目的物理地址与长度描述符便切走执行其他业务；DMA 引擎自行通过 PCIe 总线完成整块内存与设备间的数据传输，仅在全部完成时触发**一次硬中断**通知内核收尾。

### 6.3.2 块层演进：淘汰单队列电梯，全面迈入 NVMe `blk-mq` {#ch6-3-2}

早期机械硬盘（HDD）受制于 5–10 ms 的磁头寻道延迟，Linux 2.6–4.x 单队列块层围绕电梯合并排序设计了 SSTF/SCAN（电梯）/LOOK 等算法与 `cfq` 调度器。然而在现代 **NVMe SSD**（无机械寻道、随机延迟仅 10–70 µs、PCIe 原生提供数万硬件并行队列）面前，多核争抢单队列全局自旋锁反而成了致命的 CPU 瓶颈！

因此，**Linux 5.0 起已彻底删除传统单队列块层与 CFQ 等旧调度器**，全面采用**多队列块层 `blk-mq`（Multi-Queue Block Layer）**：为每个 CPU 核心配置无锁的**软件提交队列**，直通映射至 NVMe 的多条**硬件派遣队列**。现代 `/sys/block/<dev>/queue/scheduler` 可选策略中，NVMe 与高性能云盘默认使用 **`none`**（近乎零调度锁开销直达硬件），SATA/SAS 盘常用防饥饿的 **`mq-deadline`**，桌面或精细限流场景可选 `bfq` 或 `kyber`。

### 6.3.3 端到端链路串联：一次 `write() + fdatasync()` 落盘全过程 {#ch6-3-3}

把存储栈各层连成一条完整生产时序：

```text
用户进程 write(fd, buf, 4096)
  └──> 1. VFS 经 fd 查 struct file，进入 Ext4 拷贝数据至内存 PageCache 并标为脏页（write 立即返回！）
用户进程 fdatasync(fd)
  └──> 2. Ext4 按 data=ordered 将脏数据页（及必要 JBD2 日志）封装为块层请求 struct bio
         └──> 3. 通用块层 blk-mq 放入当前 CPU 核软件队列，合并后派发至 NVMe 硬件提交队列 (SQ)
                └──> 4. NVMe 控制器经 PCIe DMA 读取物理内存页写入 NAND 闪存，写硬件完成队列 (CQ)
                       └──> 5. 触发 MSI-X 硬中断 + BLOCK 软中断完成 bio，唤醒阻塞在 fdatasync 的线程返回
```

## 6.4 文件 I/O 分类、PageCache 持久化与 `io_uring` {#ch6-4}

### 6.4.1 缓冲 I/O vs 非缓冲 I/O（用户态维度） {#ch6-4-1}

指是否经过标准库用户态缓冲区（如 C `fwrite` vs 系统调用 `write`）。用户态缓冲聚合零碎小写入以削减 `syscall` 次数；若进程崩溃（如 `kill -9`），尚未 `fflush()` 进入内核的缓冲数据会丢失（而宿主机不掉电时，已 `write()` 进内核 PageCache 的数据不会因进程自身崩溃丢失）。

### 6.4.2 直接 I/O vs 非直接 I/O 与安全落盘契约 {#ch6-4-2}

- **非直接 I/O（Buffered / PageCache I/O，默认）**：`write()` 仅写内存脏页即返，由内核后台按脏页阈值（`vm.dirty_background_ratio` / `vm.dirty_ratio`）或周期异步回写。
  - **WAL 刷盘铁律**：宿主机断电会丢失未落盘脏页，数据库写事务日志必须调用 `fsync()` 或更轻量的 **`fdatasync()`**（文件大小不变时跳过非必要 `inode` 时间戳磁盘写，详见[《MySQL 是怎样运行的》第 8 章 Redo 刷盘策略](../mysql/chapter-08#ch8-2-2)）。
  - **配置文件/快照原子替换三步法**：严禁直接覆写原文件（断电易留半截坏文件），须在**同目录**依次执行：① 写临时文件并 **`fsync(tmp_fd)`**（确保新数据先落盘）；② **`rename(tmp, target)`** 原子切换目录项；③ **`fsync(parent_dir_fd)`** 确保父目录中的新目录项映射也已持久化到磁盘（见[第 7 章大文件传输衔接](./chapter-07#ch7-2-3)）。
- **直接 I/O（`O_DIRECT`）**：绕过 PageCache，要求内存地址、偏移与大小按扇区/页对齐，经 DMA 直连用户态缓冲与磁盘。专用于**自管缓冲池的数据库**（如 MySQL InnoDB Buffer Pool，消除双份缓存与多余拷贝）以及**超大冷文件读写**（防挤爆热点 PageCache）。

### 6.4.3 同步 vs 异步 I/O 与现代 `io_uring` {#ch6-4-3}

读 I/O 分**阶段 1（设备→内核准备数据）**与**阶段 2（内核→用户态拷贝数据）**。阻塞 I/O、非阻塞轮询与 `select`/`poll`/`epoll` 在阶段 2 仍须应用主动调用 `read()` 同步等待拷贝完成，故均属**同步 I/O**（见[第 7 章 I/O 多路复用](./chapter-07#ch7-3)）；唯有内核包办两阶段并在数据就位后通知应用的才是**异步 I/O**。

早期 Linux POSIX `aio` 靠用户态线程模拟、`libaio` 仅支持 `O_DIRECT` 块文件且不支持 Socket。**Linux 5.1+ 引入、6.x 全面成熟的 `io_uring`** 通过 `mmap` 在用户态与内核态共享无锁 **提交队列（SQ）** 与 **完成队列（CQ）** 彻底统一了异步存储与网络：

```text
用户态批量填请求 (SQE) ──> [ 共享环形队列 SQ ] ──> 内核异步完成文件(缓冲/直接)或 Socket I/O + 拷入用户缓冲
用户态无锁收割结果     <── [ 共享环形队列 CQ ] <── 内核写入完成事件 (CQE)
```

单次 `io_uring_enter()` 可批量提交上百个异构系统调用；启用 **`IORING_SETUP_SQPOLL`** 后由内核轮询线程自动拉取 SQ，在重载存储引擎中可实现**零系统调用**提交。

## 练习 {#ch6-exercises}

本节包含 4 道练习，覆盖三层打开文件表行为、已删文件占满磁盘排障、数据库 WAL `fdatasync`/`O_DIRECT` 选型及 NVMe `blk-mq` 原理。请先独立作答，再展开核对。

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

某线上业务服务器磁盘报警写满（`df -h` 显示 100%），运维删掉了一个 50 GB 的过期日志后再次查看，`df -h` 依然是 100%，但用 `du -sh /*` 统计所有目录总和远小于磁盘总容量。请解释底层原因并给出定位与无损释放方法。

<details>
<summary>查看参考答案</summary>

- **根因**：`rm` 只删了目录项并令 `inode` 硬链接数 `i_nlink` 归零；但业务进程仍打开着该文件的 `fd`（内存引用计数 `i_count > 0`），文件系统不能释放其数据块。`du` 遍历可见目录树故统计不到，而 `df` 读超级块已用块计数仍为 100%。
- **定位与解决**：执行 `lsof +L1` 定位持有 `(deleted)` 大文件的进程 PID 与 FD。支持信号重开日志的服务发信号切换（如 `nginx -s reopen`）；不便重启的服务可直接执行 `truncate -s 0 /proc/<pid>/fd/<fd>` 在线原地截断归还磁盘块。

</details>

### 练习 3：数据库写 WAL 为什么必须调用 `fdatasync()`，且数据文件常开启 `O_DIRECT`？

某自研存储引擎采用“先写 WAL 日志，再更新内存索引”，却在压测拔电测试中丢失了最后几百条已返回客户端成功的记录，检查发现写 WAL 只用了 `fwrite()` + `fflush()`。请分析：

1. 为什么调用了 `fflush()` 依然会在宿主机掉电后丢数据？若只是存储引擎进程自己 `SIGSEGV` 崩溃（宿主机未掉电），这批数据会丢吗？
2. 预分配固定大小的 WAL 文件为何优先用 `fdatasync()` 而非 `fsync()`？
3. 为什么 MySQL InnoDB 数据文件常配置 `O_DIRECT`？

<details>
<summary>查看参考答案</summary>

1. **`fflush()` 边界辨析**：`fflush()` 把标准库用户态缓冲经 `write()` 刷入了内核 **PageCache（DRAM）**。因此若只是**进程自身崩溃**而内核健在，后台回写线程仍会把 PageCache 脏页落盘，**不会丢数据**；但若**宿主机掉电或 Kernel Panic**，停留在 DRAM 中的脏页瞬间蒸发！必须调 `fdatasync()` 落入非易失闪存。
2. **`fdatasync()` 优势**：`fsync()` 每次都强制同步文件数据与全部 `inode` 元数据（含 `mtime` 修改时间，导致额外的 `inode` 表磁盘写）；WAL 预先通过 `fallocate` 分配好固定大小后，写入不改变文件长度与块映射，`fdatasync()` 只需刷数据页即可省掉一次元数据 I/O。
3. **`O_DIRECT` 原因**：InnoDB 自带 16 KB 页管理的 Buffer Pool，绕开内核 PageCache 可彻底消除双重缓存内存浪费、CPU 二次拷贝以及内核脏页集中刷盘带来的不可控 I/O 抖动。

</details>

### 练习 4：为什么 NVMe SSD 上将 I/O 调度器设为 `none` 往往比开启复杂排序调度器更快？

对比机械硬盘（HDD）与 NVMe SSD 的硬件架构，解释为什么 Linux 5.0 移除单队列块层并引入 `blk-mq` 后，NVMe 默认调度器为 `none`。

<details>
<summary>查看参考答案</summary>

1. **硬件瓶颈转移**：HDD 受制于毫秒级机械磁头寻道，花几十微秒做电梯排序合并稳赚；NVMe SSD 无机械寻道（几十微秒级随机访问）且内部多闪存通道高度并行，软件层复杂排序毫无收益，反而因软件队列锁与计算增加 CPU 开销与尾延迟。
2. **多队列无锁直通**：NVMe 通过 PCIe 暴露与 CPU 核心数对等的硬件提交/完成队列对，配合 `blk-mq` + `none`，每核 I/O 请求在本核无锁直达对应硬件队列，释放百万级 IOPS 潜能。

</details>

## 面试题 {#ch6-interview}

本节包含 5 道深度文件系统与存储 I/O 面试题，结合云原生 OverlayFS、`io_uring` 安全边界与隐蔽配额排障连环追问。

### 面试题 1：在 Linux 中，文件名保存在 `inode` 里吗？追问：在 Docker/K8s 容器的 OverlayFS 根文件系统中，为什么首次修改基础镜像里的大文件会特别卡顿，且修改前后的文件 `inode` 号会发生变化？

<details>
<summary>查看参考答案</summary>

**结论**：文件名**不存在** `inode` 中，而是保存在**父目录文件的数据块**里（内存缓存在 `dentry`）；OverlayFS 首次修改底层只读镜像文件会触发整文件同步 **`copy_up`（向上拷贝）** 并在上层文件系统新建独立 `inode`。

**关键依据**：
- `inode` 只存元数据与块指针，这也是不同目录多个名字可硬链接到同一 `inode` 的根基。
- OverlayFS 中基础镜像位于只读 `lowerdir`。当进程以写模式 `open()` 一个位于 `lowerdir` 的 500 MB 文件时，VFS/OverlayFS 在 `open` 返回前必须先把这 **500 MB 完整拷贝**到可写 `upperdir` 的新文件中（产生严重的阻塞延迟与双倍磁盘占用），随后操作转向上层新文件，因此 `stat` 看到的 `inode` 号也会突变（还会令依赖 `inode` 追踪日志的采集器或文件锁出现预期外行为）。

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

### 面试题 5：Linux 服务器上 `df -h` 显示磁盘还有 50% 空余，但程序创建文件或启动监听时却报错 `No space left on device`（`ENOSPC`），有哪些常见与隐蔽根因？

<details>
<summary>查看参考答案</summary>

**结论**：除最经典的 **`inode` 耗尽**外，若检查 `df -i` 发现 `inode` 也充裕，线上最隐蔽的高频根因是 **`inotify` 文件监控配额耗尽**（在 Kubernetes 节点上尤为高发）。

**关键依据**：
1. **`inode` 位图耗尽（查 `df -i`）**：Ext4 格式化时固定了 `inode` 总数，数百万个字节级小文件会把 `IUse%` 占到 100%，导致无法新建任何文件或目录。
2. **`inotify` Watch 上限耗尽（`df -h` 与 `df -i` 均正常！）**：Linux 内核在 `inotify_add_watch()` 超过 `/proc/sys/fs/inotify/max_user_watches` 或 `max_user_instances` 时，返回的错误码同样是 **`ENOSPC`（被 libc 格式化为 `No space left on device`）**！K8s 节点上同时运行 `kubelet`、日志采集 Agent（FluentBit/Vector）与热重载工具时极易踩中，调大对应 `sysctl` 即可恢复。
3. **非特权用户触碰 Ext4 5% 保留块**：Ext4 默认为 `root` 预留 5% 空间（`tune2fs -m`），当普通用户写到 95% 时即报 `ENOSPC`。

</details>

## 参考资料

- [Linux Kernel Documentation: Overview of the Linux Virtual File System](https://docs.kernel.org/filesystems/vfs.html)
- [Linux Kernel Documentation: ext4 Data Structures and Algorithms](https://docs.kernel.org/filesystems/ext4/index.html)
- [Linux Kernel Documentation: Overlay Filesystem (`overlayfs`)](https://docs.kernel.org/filesystems/overlayfs.html)
- [Linux Kernel Documentation: Multi-Queue Block IO Queueing Mechanism (`blk-mq`)](https://docs.kernel.org/block/blk-mq.html)
- [Linux Programmer's Manual: `fsync(2)` 与 `io_uring(7)`](https://man7.org/linux/man-pages/man7/io_uring.7.html)
