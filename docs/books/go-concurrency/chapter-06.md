---
title: 第 6 章 goroutine 和 Go 语言运行时
description: 理解 G、M、P、工作窃取、抢占与阻塞，使用现代调度指标解释并发程序的性能边界。
---

# 第 6 章 goroutine 和 Go 语言运行时

## 本章要点

goroutine 把任务表达与操作系统线程管理分开，运行时负责调度、栈和阻塞唤醒。本章以原书的工作窃取为起点，建立 G、M、P 的基本模型，更新异步抢占和容器感知并行度的旧结论，并说明哪些调度细节不能写成程序的正确性前提。

读完后，应能解释“很多 goroutine 却没跑满 CPU”“线程数超过 GOMAXPROCS”和“取消不能终止计算”等现象，并根据运行指标、profile 与 trace 选择下一步调查方向。

> 核对日期：2026 年 11 月 10 日；核对环境为 Go 1.27.3、Windows/AMD64；运行时细节对照该版本源码。Linux cgroup 行为依据官方文档，未在本机实测。

## 6.1 G、M、P 分别代表什么 {#ch6-1}

以下是理解当前实现的模型，不是 Go 语言规范要求其他实现必须采用的架构：

| 对象 | 主要职责 | 不应混同为 |
| --- | --- | --- |
| G | goroutine 的执行状态、栈及调度信息 | 一个固定绑定的操作系统线程 |
| M | 执行 Go 或运行时工作的操作系统线程 | 一个 CPU 核心 |
| P | 执行普通 Go 代码所需的调度与分配资源 | 一条业务任务或一个硬件核心 |

通常一个 M 要持有一个 P 才能执行普通 Go 代码。P 的数量对应 `GOMAXPROCS`；M 的数量可以更多，因为线程可能阻塞在系统调用、cgo 或执行其他运行时工作。一个 G 也可以在不同 M 上恢复，因此不能默认依赖线程局部状态。

```text
可运行的 G → 被调度 → 持有 P 的 M 执行 Go 代码
      ↑                     ↓
被事件唤醒 ← 等待中的 G ← channel、锁或 I/O 等待
```

`runtime.LockOSThread`（导入路径 `"runtime"`）用于确有线程亲和要求的接口，例如某些 GUI 或本地库调用；它不提供多个 goroutine 访问共享数据的互斥保证，也不是常规性能优化手段。

goroutine 栈可按需增长。运行时会随栈移动处理相应引用，但这不意味着栈上的所有对象都便宜：大对象、逃逸到堆、长期阻塞时保留的引用和递归深度仍会影响内存。

## 6.2 工作窃取与调度顺序 {#ch6-2}

### 6.2.1 从局部队列到负载均衡

如果把任务永久平均分到各处理器，一个长任务可能使某个执行端繁忙、其他执行端已经空闲。工作窃取允许空闲执行端从其他执行端取走可运行工作，使负载分配可以随着实际执行时间调整。

在 Go 1.27.3 的运行时中，P 有本地运行队列，调度器还处理全局可运行队列、优先运行槽位、网络就绪与定时事件。找不到工作时，可以尝试从其他 P 获取可运行 goroutine。具体检查顺序、批量迁移数量和公平性启发式属于实现细节。

不能据此推断“新建 goroutine 必定最先执行”“先入队必定先完成”或“均匀窃取保证每个任务在固定时限内运行”。channel 的语义与内存模型才是编写同步协议的依据，调度队列不是 API。

### 6.2.2 窃取任务与窃取续体

原书用递归 Fibonacci 展示 fork-join，并比较新任务与续体的排队方式：续体指分叉点之后，调用者还要继续执行的那部分工作。这是理解调度策略的概念模型。

Go 的 `go f()` 创建一个可调度的 goroutine，并不把调用者后续代码公开成可供程序操纵的“续体任务”。原书把某种队列端点顺序和任务窃取策略直接对应到 Go 的解释，应限制为历史上的实现分析；当前运行时还有 `runnext`、全局队列与抢占等机制，不能简化成一个始终遵循固定 LIFO/FIFO 规则的队列。

递归计算也不应该无条件在每个节点创建 goroutine。若任务拆分成本高于计算成本，树形扩张会造成调度、分配与同步开销。可以设置粒度阈值，在较大的独立分支并发，较小的分支顺序计算，并用同一负载下的基准比较。

## 6.3 阻塞、系统调用与异步抢占 {#ch6-3}

### 6.3.1 阻塞的不一定是线程

goroutine 在 channel 或锁上等待时，运行时通常可以挂起这个 G，让执行资源运行其他可运行 G。网络 I/O 在支持的平台和描述符类型上可以由网络轮询器等待就绪，而不是为每个连接永久占用一个线程。

系统调用、文件 I/O、cgo 和具体平台则可能采取不同路径。某个 M 阻塞时，运行时可以让 P 转交其他 M 继续执行 Go 代码，因此线程数可能上升。不能把所有 I/O 都概括成“不阻塞线程”，更不能认为运行时能自动取消任意系统调用。

### 6.3.2 更新原书的抢占结论

原书提到“不调用函数、不做 I/O 的 goroutine 无法被抢占”，描述的是旧运行时的限制。**Go 1.14 起引入 goroutine 异步抢占**，在支持的平台上缓解紧循环长期占用执行资源及延迟垃圾回收的问题。具体平台支持与安全点仍属于实现边界。

异步抢占改变的是调度机会，不是业务取消语义。下面函数即使可以被调度器暂停，也不会因为外部 `cancel()` 自动返回：

```go
func Spin() {
	for {
	}
}
```

若计算需要终止，应在合适的工作粒度检查 `ctx.Err()` 或 `ctx.Done()`，并维护可清理的状态。`runtime.Gosched` 只是让出执行机会，不建立共享内存同步关系，也不提供退出协议。

程序也不应承诺“调度器会在精确的十毫秒内抢占每个任务”。系统负载、平台、中断与运行时状态都可能影响实际调度延迟。

## 6.4 默认并行度与容器 {#ch6-4}

Go 1.5 起默认并行度不再固定为 1。原书据此用 `runtime.NumCPU()` 解释默认值，但现代部署还需要考虑进程实际可用的 CPU 和容器配额。

**Go 1.25 起**，运行时默认 `GOMAXPROCS` 会综合逻辑 CPU 数与亲和性，并在 Linux 上考虑 cgroup 的 CPU 带宽限制；还可周期性更新默认值。这是 CPU limit 一类吞吐量约束，不是 Kubernetes CPU request，也不是给程序分配一组独占物理核心。

当前文档还规定了配额取整与通常不低于 2 的实现边界，不能直接用“配额为 1.2 就严格只有 1.2 个 P”理解。依赖精确细节时应查 `runtime.GOMAXPROCS` 的对应版本文档。

设置 `GOMAXPROCS` 环境变量或调用 `runtime.GOMAXPROCS(n)` 会停止默认自动更新。Go 1.25 新增的 `runtime.SetDefaultGOMAXPROCS()` 可以恢复。对语言版本不高于 Go 1.24 的主模块，`containermaxprocs` 与 `updatemaxprocs` 的兼容默认值也会影响行为。

并行度过大可能导致容器 CPU 节流和尾延迟上升，但调小它也不会限制 HTTP 请求、数据库连接或等待中的 goroutine 数量。这些资源应由[并发预算](./chapter-05#ch5-5)独立控制。

## 6.5 用证据分析并发性能 {#ch6-5}

### 6.5.1 先区分计算、等待与积压

“goroutine 多”只是数量现象。要同时观察任务到达率、在途数、可运行任务、CPU 使用与等待位置：

| 观察 | 可能方向 | 继续取得的证据 |
| --- | --- | --- |
| CPU 高、计算栈集中 | 计算热点或空转 | CPU profile、基准 |
| CPU 低、goroutine 多数等 channel | 下游慢、协议阻塞或正常空闲 | goroutine 栈、队列指标、block profile |
| 大量任务等待锁 | 临界区过长或竞争模式不合适 | mutex profile，检查持锁 I/O |
| 可运行任务多、调度等待增加 | CPU 预算不足或过量派发 | 调度指标、trace、容器节流指标 |
| 请求结束后 goroutine 持续增长 | 生命周期遗漏或后台任务积压 | 多次快照、goroutineleak profile |

不要仅凭一张快照就把所有等待判定成死锁，也不要仅因 CPU 没跑满就增加 goroutine。

### 6.5.2 现代指标与跟踪能力

标准库 `runtime/metrics` 自 **Go 1.16** 提供运行指标，代码中常以 `metrics` 为包名。`/sched/goroutines:goroutines` 是 goroutine 总量指标，`/sched/latencies:seconds` 描述调度等待分布。**Go 1.26 起**又增加可运行、运行、等待等 goroutine 状态指标及线程、创建量等信息。状态计数是近似观察，不能要求它们在不同采样时刻严格相加等于总量。

应通过 `metrics.All()` 枚举当前工具链支持的名称与值类型，不把某个版本的指标清单直接硬编码成跨版本契约。例如本地 Go 1.27.3 使用 `/sched/goroutines/runnable:goroutines` 与 `/sched/threads/total:threads`。

`runtime/trace` 展示随时间发生的调度、阻塞、唤醒、系统调用和 GC 事件，比聚合 profile 更适合分析“这次请求为什么晚了”。**Go 1.25 起提供 `trace.FlightRecorder`**，可以保留近期 trace 窗口，在出现慢请求等事件时导出；它仍需要设置合适的数据与内存预算。

**Go 1.27 起正式提供 `goroutineleak` profile**，能报告基于可达性分析识别出的永久阻塞 goroutine；Go 1.26 中它还是实验功能。它有检测边界，不能证明“没有 profile 条目就没有泄漏”。具体采集命令、`-race` 与虚拟时间测试见[附录 A](./appendix-a#cha-3)。

## 练习 {#ch6-exercises}

下面通过现象分析检查运行时模型。先独立列出解释与下一步证据，再展开答案；不需要运行程序，也不要求记忆队列容量或抢占时间常数。

### 练习 1：为什么线程数能超过并行度

程序 `GOMAXPROCS` 为 4，启动 1000 个 goroutine，其中一些调用会阻塞在 cgo 或系统调用上。监控看到超过 4 个操作系统线程。是否说明 GOMAXPROCS 失效？

<details>
<summary>查看参考答案</summary>

不是。它限制执行 Go 代码所用的并行度，线程总量还包含阻塞在系统调用或 cgo 等位置的线程。P 可以转交其他 M，让可运行 G 继续执行。

应查看线程创建栈、cgo 使用和实际 Go 并行度，而不是把线程数与 P 数量相等当作正确性要求。它也不能代替外部调用的并发上限。

</details>

### 练习 2：有抢占为什么取消仍不生效

一个 CPU 密集函数执行很长的循环，不接受 `Context`。调用方等待超时后取消请求，监控却发现计算继续。请分别解释调度器和业务函数的责任。

<details>
<summary>查看参考答案</summary>

异步抢占让其他 goroutine 和运行时有机会执行，不会替业务函数返回。业务函数应接受上下文，按合理粒度检查取消并返回，调用方再等待其结束。

检查频率需在取消响应时间与计算开销之间权衡。把循环改成不断 `Gosched` 仍没有终止条件，也没有建立内存同步。

</details>

### 练习 3：容器扩大配额后为什么没有自动变化

一个采用 Go 1.27 语言版本的 Linux 服务启动时手动调用 `runtime.GOMAXPROCS(2)`。后来容器提高 CPU limit，运行时却没有按新配额自动调整。这个行为是否符合文档？应如何恢复默认更新？

<details>
<summary>查看参考答案</summary>

符合。手动设置会关闭自动更新。可以去掉不再需要的手动设置，或用 Go 1.25 起的 `runtime.SetDefaultGOMAXPROCS()` 恢复默认行为。

恢复默认不等于承诺精确匹配配额数值；仍受可用 CPU、取整和当前实现规则约束，实际影响应在 Linux 部署环境核验。

</details>

## 面试题 {#ch6-interview}

这里检查调度细节与性能结论的边界。先独立回答，再展开答案；涉及当前实现时以 Go 1.27.3 为上下文。

### 面试题 1：同一 goroutine 是否总在同一线程上执行

能否把操作系统线程局部状态直接当成某个 goroutine 的私有状态？

<details>
<summary>查看参考答案</summary>

不能。goroutine 可能在不同 M 上恢复。确有本地库线程亲和要求时需遵守 `runtime.LockOSThread` 的契约，但锁线程不提供共享内存互斥。

</details>

### 面试题 2：工作窃取是否保证完成顺序

既然调度器有本地队列和工作窃取，能否依赖先启动的任务先完成？

<details>
<summary>查看参考答案</summary>

不能。启动、获得运行机会和完成是不同事件，任务还会阻塞或迁移。需要顺序语义时应通过通信、同步或编号汇总明确表达。

</details>

## 参考资料

- [Go 1.27.3 runtime/proc.go：调度器、运行队列与工作窃取](https://cs.opensource.google/go/go/+/refs/tags/go1.27.3:src/runtime/proc.go)
- [Go 1.27.3 runtime/preempt.go：同步与异步抢占](https://cs.opensource.google/go/go/+/refs/tags/go1.27.3:src/runtime/preempt.go)
- [Go 1.14：运行时异步抢占](https://go.dev/doc/go1.14#runtime)
- [runtime.GOMAXPROCS：默认值、更新与实现边界](https://pkg.go.dev/runtime#GOMAXPROCS)
- [runtime.LockOSThread：线程亲和契约](https://pkg.go.dev/runtime#LockOSThread)
- [Go 1.25：容器感知并行度与 flight recorder](https://go.dev/doc/go1.25)
- [runtime/metrics：运行指标与 All](https://pkg.go.dev/runtime/metrics)
- [Go 1.26：调度状态指标](https://go.dev/doc/go1.26#runtimemetricspkgruntimemetrics)
- [runtime/trace：执行跟踪与 FlightRecorder](https://pkg.go.dev/runtime/trace)
- [Go 1.27：goroutine 泄漏 profile](https://go.dev/doc/go1.27#runtime)
