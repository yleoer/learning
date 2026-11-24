---
title: 第 5 章 进程间通信与并发同步
description: 系统梳理进程间通信（IPC）机制与现代事件原语，深入互斥锁（futex）、自旋锁、读写锁、条件变量、RCU、乐观锁与 ABA、信号量同步模型及死锁治理。
---

# 第 5 章 进程间通信与并发同步

## 本章要点

独立进程的虚拟地址空间彼此隔离，需要借助操作系统内核才能安全交换数据；而同一进程内的多线程直接共享堆与全局变量，通信几乎零成本，挑战反而转为如何避免并发读写冲突与死锁。本章整合原书《图解系统》第 4.2–4.5 节，彻底消除原书在信号量、互斥/自旋锁及读写锁上的多处重复，剥离生活段子，并补齐现代系统工程必备的底层机制：Linux 互斥锁的 **`futex` 用户态快速路径**、**条件变量与虚假唤醒**、**RCU**、CAS 乐观锁的 **ABA 与节点安全回收问题**，以及 `eventfd` / `signalfd` / Unix 域套接字传递文件描述符等现代 IPC 实践。

读完本章后，应能依据吞吐、延迟与隔离需求选型合适的 IPC 机制，严格区分数据竞争与竞态条件、互斥与同步，说明 `futex` 如何在无竞争时避免内核切换及高争用退化边界，掌握无锁 ABA 防护与死锁破环准则。

> 核对日期：2026 年 11 月 23 日；核对环境为 Linux 6.12 LTS 内核文档、POSIX Threads（NPTL）及 Go 1.27.4 运行时源码。

## 5.1 进程间通信（IPC）：经典机制与现代原语 {#ch5-1}

每个进程拥有独立的用户虚拟地址空间，无法直接读写另一进程的用户内存；而所有进程映射同一份内核空间（见[第 3 章虚拟地址布局](./chapter-03#ch3-3-1)），因此**进程间通信（Inter-Process Communication, IPC）本质上都需要内核参与建立通道或映射共享物理页**。

### 5.1.1 主流 IPC 机制全景对比 {#ch5-1-1}

| IPC 机制 | 通信范围 | 传输形态与拷贝次数 | 典型特点与适用场景 |
| --- | --- | --- | --- |
| **匿名管道（`pipe`）** | 亲缘进程（`fork` 继承 fd） | 无格式字节流、单向半双工；2 次拷贝（用户→内核→用户） | 生命周期随进程；Shell 管道 `cmd1 \| cmd2`（创建兄弟子进程） |
| **命名管道（FIFO，`mkfifo`）** | 本机任意进程 | 同匿名管道，通过文件系统路径名寻址 | 适合简单单向流式传递，不支持随机 `lseek` |
| **消息队列（SysV / POSIX）** | 本机任意进程 | 结构化消息块（保留边界）；2 次拷贝 | 生命周期随内核；POSIX `mq_open` 支持 fd 与多路复用，但单消息与队列总长受限 |
| **共享内存（`shm_open`+`mmap` / `memfd_create`）** | 本机任意进程 | 直接读写同一物理页框；**0 次内核拷贝（最快）** | 适合高频大数据量交换；**无内置同步**，须配合信号量/互斥锁/原子操作 |
| **信号（Signal）** | 本机进程 / 内核→进程 | 仅传递信号编号（唯一**异步打断**机制） | 异常与控制事件通知（如 `SIGINT`、`SIGTERM`、`SIGCHLD`） |
| **Unix 域套接字（`AF_UNIX`）** | 本机任意进程 | 支持字节流（`SOCK_STREAM`）与数据报（`SOCK_DGRAM`），绕过 TCP/IP 协议栈 | **现代本机服务通信主力**（Docker、containerd、MySQL、systemd）；支持全双工、`SO_PEERCRED` 身份鉴权及通过辅助数据 **`SCM_RIGHTS` 跨进程传递打开的文件描述符** |
| **网络套接字（`AF_INET`/`AF_INET6`）** | 跨主机 / 本机 | 完整 TCP/UDP 协议栈 | 分布式网络通信（详见[第 7 章网络协议栈](./chapter-07#ch7-1)） |

### 5.1.2 关键细节与易错点校准 {#ch5-1-2}

1. **匿名管道的写端/读端关闭规则**：`pipe(int fd[2])` 返回读端 `fd[0]` 与写端 `fd[1]`。`fork()` 后父子进程必须各自关闭不用的那一端，否则若写端未全部关闭，读端永远读不到 EOF 而永久阻塞；若所有读端均已关闭而继续写入，内核会向写进程发送 **`SIGPIPE`**（默认终止进程，网络服务常需忽略该信号以改为处理 `EPIPE` 错误码）。
2. **信号处理的两个硬边界**：**`SIGKILL`（9）与 `SIGSTOP`（19）绝对无法被捕捉、阻塞或忽略**（修正原书 `SEGSTOP` 笔误）。此外，信号处理函数可能随时异步打断线程正在执行的任意代码（例如刚拿到 `malloc` 堆锁或日志锁时被打断），因此函数体内**只能调用异步信号安全（Async-Signal-Safe）系统调用**（如 `write()`、`_exit()`，严禁调用 `printf()`、`malloc()` 或获取普通互斥锁，否则极易自死锁！）。
3. **UDP Socket 绑定纠偏**：原书 4.2 节称“每一个 UDP 的 socket 都需要 `bind`”，实际仅**接收端**（服务端）需要显式 `bind()` 固定端口，UDP 发送端可直接调用 `sendto()`，由内核自动分配临时端口。
4. **现代 Linux 事件文件化原语**：为规避异步信号的并发陷阱，现代 Linux 提供了将事件转化为**文件描述符**的三件套——**`eventfd`**（轻量 64 位计数唤醒）、**`signalfd`**（全进程线程先屏蔽目标信号后，在事件循环中同步安全读取）和 **`timerfd`**（高精度定时），均可统一纳入 `epoll` 或 `io_uring` 监听。

## 5.2 并发竞争与现代同步原语 {#ch5-2}

### 5.2.1 竞态条件、数据竞争与临界区 {#ch5-2-1}

多线程共享同一地址空间，一行 `i++` 在汇编层拆为 `load → add → store` 三步，并发交错执行便会丢失更新。工程上必须严格区分两组概念（语言级建模详见[《Go 语言并发之道》第 1 章竞争条件与数据竞争](../go-concurrency/chapter-01#ch1-1-2)）：

- **数据竞争（Data Race）vs 竞态条件（Race Condition）**：**数据竞争**指多线程未加同步地并发访问同一内存地址且至少含一次写（在 C/C++ 中直接构成未定义行为）；**竞态条件**指业务正确性依赖外部事件的非确定性时序——即使每次读写都单独加了锁（无数据竞争），若“先查询余额、再扣减余额（Check-Then-Act）”未置于同一原子临界区内，照样发生超卖竞态。
- **互斥（Mutual Exclusion）vs 同步（Synchronization）**：**互斥**保证同一时刻至多一个执行流进入临界区；**同步**协调多个执行流的确定先后顺序（如生产者就绪后唤醒消费者）。

### 5.2.2 互斥锁（`futex`）与自旋锁 {#ch5-2-2}

互斥锁和自旋锁的核心差异在于**加锁失败时的等待策略**：

- **自旋锁（Spinlock）**：基于硬件原子指令在循环中忙等重试，**不让出 CPU、无线程上下文切换**。循环体内须插入退让指令（x86-64 `PAUSE`、ARM64 `YIELD`）以降低功耗并避免退出自旋时的流水线内存序冲刷。仅适用于**多核环境且临界区极短**（几十纳秒级）或严禁睡眠的内核中断上下文；在非抢占单核上自旋会直接死锁。
- **互斥锁（Mutex）与 Linux `futex` 底层（核心校准）**：原书 4.5 节易让人误以为“每次互斥锁加解锁都要陷入内核”。实际上，现代 Linux 1:1 线程互斥锁（如 glibc `pthread_mutex_t`、Rust `std::sync::Mutex` / `parking_lot`）底层均构建在 **`futex`（Fast Userspace Mutex）** 之上：

```text
无竞争快速路径（纯用户态，零系统调用）：
  线程调用 lock() ──> 原子 CAS(state: 0 -> 1) 成功 ──> 直接进入临界区！
  线程调用 unlock() ──> 原子置 state = 0（发现无等待者）──> 直接返回！

OS 线程竞争慢速路径（以 pthread_mutex_t 为例，陷入内核睡眠）：
  线程调用 lock() ──> CAS 失败 ──>（可选自适应短暂自旋数十次）
                  ──> 仍失败，调用 futex(FUTEX_WAIT) 陷入内核挂起当前 OS 线程
  持锁者 unlock() ──> 置 state = 0，发现有等待者 ──> 调用 futex(FUTEX_WAKE) 唤醒等待线程
```

由此可见，**现代互斥锁在无竞争时与自旋锁同样是纯用户态纳秒级原子操作**；仅在真实争用且短暂自旋未果时，才付出上下文切换代价休眠（注：在 Go 等 M:N 协程运行时中，`sync.Mutex` 竞争慢路径则是通过运行时信号量 `runtime_SemacquireMutex` **先在用户态挂起当前 Goroutine `G` 并复用内核线程 `M` 执行其他就绪协程**，只有当整个 `M` 无协程可跑需要停放 `notesleep` 时才在底层调用 `futex`）。

### 5.2.3 读写锁、条件变量与 RCU {#ch5-2-3}

1. **读写锁（RWLock）**：共享读、独占写，按唤醒策略分读优先（易致写者饥饿）、写优先（阻断后续新读者）与公平 FIFO 队列。
   - **生产拐点警示（区分真共享与伪共享）**：每次加/解读锁都必须对**同一个**读者计数器做原子加减（`LOCK XADD`）。多核高频并发读时，几十个核心激烈争抢该计数器所在缓存行的独占写权，属于**真共享（True Sharing）**引发的 MESI 缓存行颠簸（加 Padding 无效，唯有分片为每核独立计数器 `per-CPU` 或改用 RCU 才能消除；伪共享对比见[第 1 章 1.4.3 节](./chapter-01#ch1-4-3)，Go 实测拐点见[《Go 语言并发之道》第 2 章 RWMutex 与 sync.Cond](../go-concurrency/chapter-02#ch2-2)）。读临界区极短时，读写锁往往反慢于普通互斥锁。
2. **RCU（Read-Copy-Update）**：Linux 内核在极度读多写少场景（路由表、`dentry` 缓存、BPF Map 部分场景）的首选。**读者完全无锁、不写任何共享计数**，开销接近普通指针读取；写者先拷贝副本完成修改，再原子替换根指针，并等待一个**宽限期（Grace Period，即所有已进入旧读临界区的读者全部退出）**后安全回收旧版本内存。
3. **条件变量（Condition Variable）与虚假唤醒**：`pthread_cond_wait(&cv, &mtx)` 会**原子释放互斥锁并休眠**，被唤醒返回前重新拿回锁。工程铁律：**必须用 `while (!cond)` 而非 `if (!cond)` 包裹 `wait()`**，以防御操作系统允许的**虚假唤醒（Spurious Wakeup）**及多消费者下的唤醒抢先（Stolen Wakeup）。

### 5.2.4 悲观锁 vs 乐观锁、CAS 与 ABA 问题 {#ch5-2-4}

悲观锁访问前先独占加锁；**乐观锁**假定冲突稀少，无锁读取计算后靠硬件 **CAS（`Compare-And-Swap`）** 或版本号校验原子提交，低争用下吞吐极高，但高冲突下大量失败自旋会烧满 CPU。

底层 CAS 无锁数据结构必须同时应对两个问题：**ABA 误判问题**（指针经历 `A → B → A` 后单靠地址比较误以为未曾变动，通过绑定单调递增**版本号 Tagged Pointer / 双宽 `CMPXCHG16B`** 识别）与**并发读期间的节点安全内存回收**（无 GC 语言中防止读线程解引用 `A->next` 前节点内存已被其他线程 `free`，需配合 Hazard Pointer 或 Epoch-based Reclamation 保护生命周期）。

## 5.3 信号量与经典同步不变量 {#ch5-3}

**信号量（Semaphore）**维护内核/共享整型计数 `sem`，仅支持原子 `P(sem)`（`sem--`，若 `< 0` 阻塞）与 `V(sem)`（`sem++`，若 `<= 0` 唤醒一个等待者）。初值 `1` 用于互斥，初值 `0` 用于跨线程先后同步，初值 `N` 用于有界并发限流。经典同步模型可归纳为三条工程不变量：

### 5.3.1 生产者-消费者（先申请资源信号量，后加互斥锁） {#ch5-3-1}

容量为 N 的有界队列设 `mutex = 1`、`empty = N`、`full = 0`：生产者必须严格按 **`P(empty) → P(mutex) → 写入 → V(mutex) → V(full)`** 执行（消费者对称 `P(full) → P(mutex)`）。若颠倒为先拿 `mutex` 再等 `empty`，队列满时生产者持锁睡眠，消费者无法拿 `mutex` 消费腾空槽，必然死锁。

### 5.3.2 哲学家就餐（破坏对称环路） {#ch5-3-2}

多执行流需同时获取多把相邻资源锁时，若统一按相对位置（如“先左叉后右叉”）加锁，并发争抢必形成闭环死锁。工程通用解法是赋予所有锁全局唯一编号并**强制按编号升序获取**（打破对称），无需引入串行化全局大锁即可从根源消除环路。

### 5.3.3 读者-写者（排队闸门防写者饥饿） {#ch5-3-3}

朴素读者优先实现中，只要活跃读者不断档，后续读者可持续插队饿死写者。引入一把公平闸门信号量 `turnstile = 1`（写者持闸门等待在途读者退场，新读者被挡在闸门外），即可将读写转换为按到达顺序推进的公平语义。

## 5.4 死锁成因、预防与治理 {#ch5-4}

死锁必须**同时满足四个必要条件（Coffman 条件，与活锁/饥饿的对照诊断详见[《Go 语言并发之道》第 1 章](../go-concurrency/chapter-01#ch1-2-1)）**：**互斥**、**持有并等待**、**不可剥夺**、**环路等待**。

工程上防死锁的核心手段：
- **全局锁顺序（Lock Ordering，破除环路等待，首选）**：嵌套加多把锁时统一按固定层级或对象唯一 ID/内存地址升序加锁，缩小锁粒度、严禁持锁发起慢速网络 RPC。
- **超时与非阻塞尝试（破除持有并等待）**：使用 `trylock` 或带超时的锁，拿不到第二把锁时主动回退释放已持有的锁并带随机退避（Jitter）重试以防活锁。
- **静态/动态锁序检测**：研发期开启 **ThreadSanitizer（TSan）** 或内核 **`lockdep`** 在尚未发生真实死锁时即捕获首次逆序加锁告警；线上定位方法详见[第 8 章死锁排查实战](./chapter-08#ch8-2-2)。

## 练习 {#ch5-exercises}

本节包含 4 道练习，覆盖本机高性能 IPC 选型、条件变量虚假唤醒修复、多账户并发转账防死锁重构以及无锁栈 ABA 与节点回收机制辨析。请先独立作答，再展开答案核对。

### 练习 1：同机进程间通信的架构选型

现有三个本机多进程协作需求（均运行在同一台 Linux 服务器上），请为每个场景选择最合适的 IPC 方式并说明理由：

1. 视频解码进程每秒产生 60 帧 4K 未压缩图像（约 1.5 GB/s），需要交给渲染进程实时读取；
2. 宿主机上的 CLI 客户端需要与本地容器运行时守护进程进行双向控制通信、校验调用方 UID，并把容器标准输出伪终端 fd 传给客户端；
3. 主进程仅需在共享内存环形队列写入新任务后，极轻量地唤醒正阻塞在 `epoll_wait()` 上的工作进程。

<details>
<summary>查看参考答案</summary>

1. **共享内存（`shm_open`/`memfd_create` + `mmap`）+ 原子环形索引**：1.5 GB/s 吞吐下，管道或普通 Socket 的两次用户↔内核拷贝会消耗巨量内存带宽与 CPU；共享内存直接读写同一物理页框零拷贝，配合原子读写游标同步帧就绪是最优解。
2. **Unix 域套接字（`AF_UNIX`）**：全双工且免经 TCP/IP 协议栈，支持通过 `SO_PEERCRED` 获取对端内核态验证的 PID/UID/GID 防伪造鉴权，并支持经 `sendmsg` + `SCM_RIGHTS` 直接跨进程传递打开的伪终端文件描述符（`containerd`/`runc` 标准做法）。
3. **`eventfd`**：内核仅维护一个 8 字节无符号计数器，本身即是可被 `epoll`/`io_uring` 监听的文件描述符，内存与唤醒开销远小于管道或套接字。

</details>

### 练习 2：找出条件变量等待代码中的并发 Bug

以下代码试图实现一个多线程共享任务队列的消费函数（假设队列 `q` 已正确初始化）：

```c
pthread_mutex_lock(&mtx);
if (queue_empty(q)) {
    pthread_cond_wait(&cv, &mtx);
}
task_t task = queue_pop(q);
pthread_mutex_unlock(&mtx);
```

当有多个消费者线程并发运行、生产者每次放入 1 个任务后调用 `pthread_cond_broadcast(&cv)` 时，这段代码存在什么严重缺陷？应如何修改？

<details>
<summary>查看参考答案</summary>

**缺陷分析**：使用 `if (queue_empty(q))` 而非 `while (queue_empty(q))` 会导致对空队列非法执行 `queue_pop`：
1. **多消费者抢先消费（Stolen Wakeup）**：生产者放入 1 个任务并广播唤醒多个消费者；消费者 1 先抢到 `mtx` 取走唯一任务并解锁后，消费者 2 随后拿到 `mtx` 从 `wait` 返回，因使用 `if` 不再复查，直接对空队列出队崩溃！
2. **虚假唤醒（Spurious Wakeup）**：POSIX 与 Linux `futex` 均允许条件变量在无信号通知（如被信号中断恢复）时提前返回。

**修复方法**：一律改为 `while` 循环重检条件谓词：

```c
pthread_mutex_lock(&mtx);
while (queue_empty(q)) {
    pthread_cond_wait(&cv, &mtx);
}
task_t task = queue_pop(q);
pthread_mutex_unlock(&mtx);
```

</details>

### 练习 3：修改转账函数彻底消除潜在死锁

某多账户并发转账函数简化如下，每个账户自带一把非重入互斥锁 `acc->lock` 和唯一编号 `acc->id`：

```c
void transfer(account_t *from, account_t *to, int amount) {
    pthread_mutex_lock(&from->lock);
    pthread_mutex_lock(&to->lock);
    from->balance -= amount;
    to->balance += amount;
    pthread_mutex_unlock(&to->lock);
    pthread_mutex_unlock(&from->lock);
}
```

1. 指出该函数在哪两类调用场景下会发生死锁；
2. 用**资源有序分配法**重写该函数。

<details>
<summary>查看参考答案</summary>

1. **两类死锁场景**：
   - **双向互转环路死锁**：线程 1 调 `transfer(A, B, 100)` 持 A 等 B，线程 2 同时调 `transfer(B, A, 50)` 持 B 等 A。
   - **同账户自转自死锁（易漏边界）**：调用 `transfer(A, A, 100)` 时 `from == to`，非重入互斥锁在同一线程内二次加锁立即卡死。
2. **修复实现**：先拦截同账户自转，再严格按账户唯一 `id` 升序加锁：

```c
void transfer(account_t *from, account_t *to, int amount) {
    if (from == to) return;

    account_t *first = (from->id < to->id) ? from : to;
    account_t *second = (from->id < to->id) ? to : from;

    pthread_mutex_lock(&first->lock);
    pthread_mutex_lock(&second->lock);
    from->balance -= amount;
    to->balance += amount;
    pthread_mutex_unlock(&second->lock);
    pthread_mutex_unlock(&first->lock);
}
```

</details>

### 练习 4：剖析 C/C++ 无锁栈中的 ABA 误判与节点回收风险

某 C/C++ 无锁单向链表栈当前结构为 `Top -> A -> B -> C`。线程 1 执行 `pop()`：先读取 `old_top = Top`（得到 `A`），再解引用读取 `next = old_top->next`（得到 `B`），随后在即将执行 `CAS(&Top, A, B)` 前被抢占挂起。

1. 构造一个操作序列，说明在节点内存池复用的情况下，线程 1 恢复执行时为何 `CAS` 会误判成功并破坏栈结构（ABA 问题）；
2. 分别说明 **Tagged Pointer（带版本号指针）** 与 **Hazard Pointer / Epoch 延迟内存回收** 各自解决什么问题——在 C/C++ 中只加版本号能否保证绝对安全？

<details>
<summary>查看参考答案</summary>

1. **ABA 故障序列**：线程 1 挂起期间，线程 2 连续执行 `pop()` 弹出 `A`、再 `pop()` 弹出 `B`（栈剩 `Top -> C`），接着从对象池复用同一个节点 `A`（其 `next` 已变为 `C`）执行 `push(A)`（此时栈为 `Top -> A -> C`）。线程 1 恢复执行 `CAS(&Top, A, B)`，因只比对指针地址仍等于 `A`，**CAS 错误成功**，把 `Top` 强行改指向早已出栈的旧节点 `B`，导致节点 `C` 丢失且链表结构损坏。
2. **两类机制的职责边界（C/C++ 中缺一不可或由安全回收统合）**：
   - **Tagged Pointer（双宽 CAS 绑定单调版本号）**：专门解决**指针被复用后 `CAS` 无法察觉历史变更（ABA）**的问题——每次修改递增版本号 `(A, 1) → (C, 2) → (A, 3)`，使线程 1 的 `CAS` 因版本不匹配安全失败重试；主要适用于节点取自固定对象池、永不 `munmap`/`free` 归还操作系统的场景。
   - **Hazard Pointer / Epoch-based Reclamation（延迟安全回收）**：专门解决**线程 1 在执行 `old_top->next` 解引用读取节点内存期间，线程 2 直接 `free(A)` 归还操作系统触发 Use-After-Free 段错误**的内存生命周期问题（单靠 Tagged Pointer 对 CAS 之前的解引用崩溃无能为力！）。同时，只要 Hazard Pointer / Epoch 机制保证了在线程 1 持有引用期间节点 `A` 绝不会被提前释放或重用，也就从源头一并阻止了地址级 ABA 的发生。

</details>

## 面试题 {#ch5-interview}

本节精选 4 道高并发同步与 IPC 深水区面试题，结合多核退化与内核实现追问检验实战功底。

### 面试题 1：为什么现代 Linux 的互斥锁（`pthread_mutex_t`）在无竞争时开销极低？追问：在 64 核高争用场景下，大量线程竞争同一把互斥锁会引发什么退化现象？为什么自适应锁不能无限制自旋？

<details>
<summary>查看参考答案</summary>

**结论**：现代互斥锁底层基于 **`futex`**，无竞争时通过纯用户态原子 CAS 完成加解锁，零系统调用陷入；但在多核高争用下会出现**缓存行乒乓与锁护航（Lock Convoying）尾延迟恶化**，而无限制自旋会在持锁线程被调度器抢占时白白烧干全部 CPU。

**关键依据**：
- **`futex` 快慢分离**：锁状态字位于用户内存，无争用时十余纳秒即过；争用失败才调 `futex(FUTEX_WAIT)` 入核休眠。
- **高争用退化（锁护航）**：若采用严格排队的公平锁，一旦刚被 `FUTEX_WAKE` 唤醒的接班线程尚未被 CPU 调度上核，其他已经在核上活跃运行的线程即便到了锁门口也必须排队干等，引发级联上下文切换风暴；非公平锁虽允许活跃线程插队提升吞吐，但又可能造成等待线程长尾饥饿。
- **自旋上限边界**：自适应互斥锁仅在多核且确认持锁线程仍在其他核运行时自旋极短次数（如几十到百余次 `PAUSE`）；一旦持锁线程自身因缺页或时间片耗尽被切走，继续自旋纯属空耗算力甚至阻塞持锁线程重新上核，必须及时挂起让出 CPU。

</details>

### 面试题 2：在读多写少场景下，把互斥锁换成读写锁（RWLock）性能一定会更好吗？追问：Linux 内核为什么在路由表、目录项缓存中大量用 RCU 取代读写锁？RCU 有什么代价？

<details>
<summary>查看参考答案</summary>

**结论**：**不一定**，多核短临界区高频读下读写锁因争抢共享读者计数器反而可能慢于互斥锁；Linux 内核改用 **RCU** 是为了实现**读者彻底零原子写、零锁开销**，其代价是**写者拷贝开销较高且在高负载下若宽限期拉长会导致待回收内存积压**。

**关键依据**：
- **读写锁瓶颈**：每次加解读锁都要原子修改同一读者计数变量，核数越多，MESI 缓存行跨核失效越惨烈，除非读临界区耗时显著大于缓存一致性延迟，否则得不偿失。
- **RCU 的取舍**：RCU 让读者不改任何全局计数，直接无锁顺着指针读；写者分配新结构修改后用原子发布替换指针，将同步成本全部转移给低频写者与后台宽限期回收（`RCU` 软中断 / `rcu_gp` 线程）。但若写操作其实很频繁，或某读者违规长耗时占用读临界区拖慢宽限期结束，未释放的旧版本对象就会迅速撑大内存。

</details>

### 面试题 3：为什么在 Linux 信号处理函数里调用 `printf()`、`malloc()` 或获取业务互斥锁会导致偶发死锁？多线程服务收到 `SIGTERM` 执行优雅停机（Graceful Shutdown）的正确做法是什么？

<details>
<summary>查看参考答案</summary>

**结论**：因为信号会**在同一线程上异步打断任意正在执行的函数**，若该线程正持有 `malloc` 内部锁或业务非重入锁时被信号打断，信号处理函数再次请求同一把锁就会发生**单线程自死锁**；多线程优雅停机应**先在创建子线程前屏蔽目标信号**，再通过 **`signalfd`、`sigwait()` 专职线程或异步信号安全的原子唤醒**把信号转为同步事件消费。

**关键依据**：
- `printf` 内部会获取 `stdout` 文件流锁并可能调用 `malloc`，均属于**非异步信号安全函数**；线上平时测试不死锁，只在信号恰好落入那几微秒持锁窗口时突然卡死。
- **多线程生产标准范式**：
  1. **关键前提（掩码继承）**：进程级信号（如外部发来的 `SIGTERM`）会被内核投递给进程内**任意一个未屏蔽该信号的线程**！因此必须在 `main()` 启动早期、**调用 `pthread_create` 派生任何工作线程之前**先用 `pthread_sigmask(SIG_BLOCK, ...)` 屏蔽 `SIGTERM`/`SIGINT`，使所有子线程自动继承该屏蔽掩码；
  2. **同步安全消费**：随后创建 **`signalfd`** 注册进主 `epoll` 循环读取，或由单个专职线程调用 `sigwait()` 阻塞等待（在 Go 1.27+ 的 Linux 运行时中，信号处理器则通过无锁原子位图 `sigsend` 记录信号，再经基于 `futex` 的 `sigNoteWakeup` 安全唤醒后台 `signal.NotifyContext` 协程）。

</details>

### 面试题 4：Nginx 热升级或容器运行时常用 Unix 域套接字（`AF_UNIX`）配合 `SCM_RIGHTS`“传递文件描述符”。既然文件描述符只是一个整数（比如 `fd = 5`），为什么不能直接发个整数 `"5"` 给另一个进程用？内核底层到底传了什么？

<details>
<summary>查看参考答案</summary>

**结论**：文件描述符编号仅是**当前进程私有 `files_struct` 数组的局部下标**，发整数 `"5"` 给另一进程毫无意义（在对方进程里 `5` 可能是完全无关的文件或未打开）；`SCM_RIGHTS` 在内核底层实际是**在接收进程的 FD 表中分配一个新空闲槽位（如 `fd = 8`），将其指向发送进程 `fd = 5` 所对应的同一个内核级 `struct file` 对象并递增引用计数**。

**关键依据**：
- 回顾三层文件表（`进程 FD 表 → 内核 struct file → inode/socket`），跨进程共享已打开连接或监听端口的唯一途径是让两个进程的 FD 表项指向内核态同一个 `struct file`。
- 借助 `AF_UNIX` 的 `sendmsg`/`recvmsg` 控制消息 `SCM_RIGHTS`，即使两个进程**毫无父子 `fork` 亲缘关系**，老进程也能把正在监听的端口 Socket 或客户端连接无缝移交给新启动的进程接管，从而实现零断连热升级（Envoy / Nginx / HAProxy 无损重载的核心基石）。

</details>

## 参考资料

- [Linux Programmer's Manual: `futex(2)` 与 `futex(7)`](https://man7.org/linux/man-pages/man2/futex.2.html)
- [Linux Programmer's Manual: `unix(7)`（`SCM_RIGHTS` / `SO_PEERCRED`）与 `signal-safety(7)`](https://man7.org/linux/man-pages/man7/unix.7.html)
- [Linux Programmer's Manual: `eventfd(2)` 与 `signalfd(2)`](https://man7.org/linux/man-pages/man2/signalfd.2.html)
- [Linux Kernel Documentation: What is RCU?](https://docs.kernel.org/RCU/whatisRCU.html)
- [The Open Group Base Specifications: `pthread_cond_wait`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/pthread_cond_wait.html)
