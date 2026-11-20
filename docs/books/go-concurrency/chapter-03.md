---
title: 第 3 章 Go 语言并发组件
description: 深入掌握 goroutine、sync 包原语、channel、select 与 GOMAXPROCS 的同步契约及 Go 1.27 现代特性。
---

# 第 3 章 Go 语言并发组件

## 本章要点

理解了 CSP 建模思想之后，需要落脚到 Go 语言提供的具体并发原语上：每个组件究竟承诺了什么同步关系？在什么状态下会阻塞或触发 `panic`？本章按原书顺序系统梳理 `goroutine`、`sync` 包（`WaitGroup`、`Mutex`、`RWMutex`、`Cond`、`Once`、`Pool`）、`channel`、`select` 以及 `runtime.GOMAXPROCS`，并融入 Go 1.19 类型化原子操作、Go 1.21 `OnceValue`/`OnceValues`、Go 1.22 循环变量按次创建以及 Go 1.25 `WaitGroup.Go` 与容器感知并行度等重要更新。

读完本章后，应能准确写出 fork-join 汇合点，避开闭包变量捕获、递归读锁、通道重复关闭与误把 `sync.Pool` 当连接池等高频陷阱，并能根据通道所有权原则设计权责清晰的并发接口。

> 核对日期：2026 年 11 月 10 日；核对环境为 Go 1.27.3、Windows/AMD64。

## 3.1 goroutine：fork-join 模型与闭包捕获 {#ch3-1}

### 3.1.1 什么是 goroutine 与 fork-join 模型 {#ch3-1-1}

每一个 Go 程序启动时都至少包含一个主协程——**`main` goroutine**。在任意普通函数、匿名函数或函数变量调用前加上 `go` 关键字，就会启动一个新的 goroutine 并发执行它：

```go
go sayHello()

go func() {
	fmt.Println("hello")
}()
```

原书对 goroutine 的定位给出了清晰的界定：它既不是由操作系统内核直接调度的重型 OS 线程，也不是需要程序员手动编写 `yield` 让出执行权的传统协程（Coroutine），而是**与 Go 运行时深度集成、由 M:N 调度器自动托管的特殊协程**。当 goroutine 在通道收发、锁等待或网络 I/O 上阻塞时，运行时会自动将其挂起，并把底层的操作系统线程转交给其他就绪的 goroutine 继续运行（调度内部机制详见[第 6 章](./chapter-06#ch6-1)）。

Go 的并发执行遵循 **fork-join（分叉-汇合）模型**：

```text
main goroutine ─────── fork (go sayHello) ───────► join (wg.Wait / <-done) ───► 继续执行
                         │                                  ▲
                         └───────► 子 goroutine 执行 ───────┘
```

- **Fork（分叉）**：执行 `go` 语句的瞬间，被调函数值与实参在父 goroutine 中完成求值，随后子分支与父分支并发推进；
- **Join（汇合）**：在未来的某个同步点，父分支等待子分支执行完毕并汇合结果。

如果在 `main` 函数中只写了 `go sayHello()` 而不建立汇合点，`main` 极可能在子 goroutine 还没来得及被调度器执行时就已经返回，整个进程随之立即终止，屏幕上什么也不会打印。建立汇合点必须使用 `sync.WaitGroup` 或通道同步，绝不能靠 `time.Sleep` 碰运气。

### 3.1.2 共享地址空间与循环变量捕获（Go 1.22 分水岭） {#ch3-1-2}

如果在 goroutine 中运行一个闭包，它捕获的外层变量究竟是独立副本还是原始引用？原书用下面这段代码给出了直观验证（完整程序需导入 `"fmt"` 与 `"sync"`）：

```go
var wg sync.WaitGroup
salutation := "hello"
wg.Add(1)
go func() {
	defer wg.Done()
	salutation = "welcome"
}()
wg.Wait()
fmt.Println(salutation) // 输出：welcome
```

输出是 `welcome`！这证明 **goroutine 在创建它的同一地址空间内运行，闭包直接捕获外层变量本身而非值副本**。即使外层函数已经返回、原本的栈帧已经销毁，Go 编译器的**逃逸分析（Escape Analysis）**也会自动将该变量分配到堆上，确保子 goroutine 不会访问悬垂内存。

紧接着，原书展示了并发面试中最高频的一段循环捕获代码：

```go
var wg sync.WaitGroup
for _, salutation := range []string{"hello", "greetings", "good day"} {
	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println(salutation)
	}()
}
wg.Wait()
```

阅读这段代码时，**必须特别注意 Go 1.22 带来的语言语义分水岭**：

1. **原书时代（模块语言版本为 Go 1.21 及更早）**：`for` 循环头声明的 `salutation` 在整个循环期间**只创建一个变量实例**，每轮迭代只是覆盖它的值。由于循环跑完往往比新 goroutine 启动快得多，当三个子协程开始执行 `fmt.Println(salutation)` 时，它们读到的往往都是最后一轮留下的 `"good day"`（且循环写入与闭包读取构成数据竞争）。在旧版本中，必须显式传参 `go func(s string) { ... }(salutation)` 才能固定每轮的字符串副本。
2. **现代 Go 语义（Go 1.22 起，且所属模块的 `go.mod` 声明为 `go 1.22` 或更高）**：`for` 循环头用 `:=` 声明的迭代变量改为**按每次迭代创建独立变量**！因此在 Go 1.27 的模块中直接运行上面这段代码，三个 goroutine 各自捕获独立的 `salutation` 实例，会正常打印出 `"hello"`、`"greetings"` 和 `"good day"`（打印先后顺序不固定，但不再重复打印三次 `"good day"`）。

不过，**切勿以为“升到 Go 1.27 编译器就再也不会有闭包捕获问题”**！以下三种情形仍然会共享同一个变量并产生数据竞争：

- 模块的 `go.mod` 仍停留在 `go 1.21` 或更低版本（语言语义由模块的 `go` 指令决定，而非单纯看本地安装的编译器版本）；
- 循环未使用 `:=`，而是用 `=` 复用循环外部声明的变量：
  ```go
  var salutation string
  for _, salutation = range []string{"hello", "greetings", "good day"} {
  	go func() { fmt.Println(salutation) }() // 依然共享同一个外部变量，存在数据竞争！
  }
  ```
- 闭包捕获的是普通作用域中随后还会被继续修改的变量。遇到这类情形，通过函数参数显式传入当前值（如 `go process(salutation)`）依然是最稳妥的写法。

### 3.1.3 轻量级栈与用户态上下文切换 {#ch3-1-3}

为什么 Go 鼓励用成千上万个 goroutine 直接映射业务并发？原书从**内存占用**和**上下文切换耗时**两个维度做了量化实验：

1. **极小的初始栈内存**：原书故意启动一万个永久阻塞在空通道 `<-c` 上的 goroutine，通过对比前后的 `runtime.ReadMemStats` 测得单个空闲 goroutine 仅占用约 2.8 KB 内存（在 Go 1.27.3 中，运行时指标 `/gc/stack/starting-size:bytes` 对应的初始栈大小为 **2 KiB**，即 2048 字节，并随函数调用深度按需动态扩缩容）。同时，原书借此强调了一条生死攸关的规则：**垃圾回收器（GC）绝不会自动回收一个被遗忘且永久阻塞的 goroutine**——只要它还卡在阻塞操作上，它自身以及它栈上引用的对象就会一直驻留到进程结束。
2. **廉价的用户态上下文切换**：操作系统内核切换线程时，必须陷入内核态、保存与恢复全部通用寄存器、浮点/向量寄存器及页表状态並刷新缓存；而在用户态调度器下切换 goroutine 只需保存程序计数器（PC）、栈指针（SP）等极少数寄存器。原书对比了 Linux 单核线程管道通信（`taskset -c 0 perf bench sched pipe -T`，单次切换约 `1.467 µs`）与 Go 单核无缓冲通道收发基准测试（`BenchmarkContextSwitch`，单次切换约 `225 ns`），相差近一个数量级。

阅读原书的 `BenchmarkContextSwitch` 代码时，有一处基准测试细节值得留意：原书在创建完两个 goroutine 后调用了 `b.StartTimer()`，但此前并未调用 `b.StopTimer()`，因此计时尚未清零。在现代 Go 中编写此类需要先做前置准备的基准测试时，应在 `close(begin)` 紧前面调用 **`b.ResetTimer()`**，以确保 goroutine 的创建开销不混入切换耗时统计。

## 3.2 WaitGroup：等待并发任务汇合 {#ch3-2}

当你只需要等待一组并发操作全部完成，而不依赖它们通过同一个通道逐条回传信号时，标准库 `"sync"` 的 `sync.WaitGroup` 是构建汇合点最直接的工具。它本质上是一个并发安全的任务计数器。

### 3.2.1 传统 `Add` / `Done` / `Wait` 契约 {#ch3-2-1}

在 Go 1.24 及更早的传统写法中，使用 `WaitGroup` 分为三步：在启动子 goroutine **之前**调用 `Add` 增加计数，在子 goroutine 内部用 `defer wg.Done()` 确保退出时将计数减 1，最后在父 goroutine 调用 `wg.Wait()` 阻塞等待计数器归零：

```go
var wg sync.WaitGroup
wg.Add(1)
go func() {
	defer wg.Done()
	// 执行并发任务
}()
wg.Wait()
```

使用传统 API 时必须严守三条铁律：

1. **`wg.Add` 必须在监控的 goroutine 外部（即 `Wait` 可能执行之前）调用**：如果把 `wg.Add(1)` 写进 `go func()` 内部，主 goroutine 完全可能在子 goroutine 还没被调度执行 `Add(1)` 前就先跑到了 `wg.Wait()`，此时看到计数器为 `0` 便会立刻提前返回！
2. **计数器绝不能变为负数**：`Done()` 调用次数多于 `Add` 的累计数会当场触发运行期 `panic: sync: negative WaitGroup counter`。
3. **禁止按值复制或跨轮次抢跑复用**：`WaitGroup` 第一次使用后严禁按值拷贝（传参必须传指针 `*sync.WaitGroup`）；若要复用同一个 `WaitGroup` 等待下一批新任务，必须等上一轮所有的 `Wait()` 调用全部返回之后，才能开始新一轮的 `Add`。

### 3.2.2 Go 1.25+ 的 `WaitGroup.Go` 方法 {#ch3-2-2}

为了彻底消除“手滑把 `Add(1)` 写进子协程”或“漏写 `defer wg.Done()`”的人为失误，**Go 1.25 起为 `sync.WaitGroup` 新增了 `Go(f func())` 方法**，将计数加一、启动新 goroutine 与函数返回时自动减一封装为一步操作：

```go
var wg sync.WaitGroup
wg.Go(func() {
	// 执行并发任务；无需调用 Add 或 Done
})
wg.Wait()
```

对照 Go 1.27.3 标准库文档，使用 `wg.Go` 时需掌握以下契约边界：

- **切勿画蛇添足**：不要写成 `go wg.Go(fn)`（否则又退回“在异步协程里调 `Add`”的竞态），也不要在传入的函数内部再调 `wg.Done()`（会导致重复减计数触发负数 `panic`）。
- **异常边界**：传给 `wg.Go` 的函数 `f` 不应让未恢复的 `panic` 逃逸。
- **动态派生规则**：当 `WaitGroup` 计数为 0 时，`wg.Go` 必须在 `wg.Wait` 之前调用；而当 `WaitGroup` 非空（即已有任务在运行）时，由 `wg.Go` 启动的子任务内部还可以继续安全地调用 `wg.Go` 动态追加子任务。
- **内存模型同步保证**：传入函数 `f` 的返回 **synchronizes-before（同步先于）** 被该次完成解除阻塞的 `wg.Wait()` 返回。因此，各子任务若分别写入各自独立的槽位（如 `results[i] = val`），主协程在 `wg.Wait()` 返回后可以直接安全读取整个 `results` 切片而无需额外加锁。但 `WaitGroup` **不会**让子任务之间并发修改同一个共享变量变安全，也不负责错误收集与取消传播（带错误与取消联动的任务组见[第 4 章 `errgroup`](./chapter-04#ch4-9)）。

## 3.3 Mutex、RWMutex 与原子操作 {#ch3-3}

### 3.3.1 `Mutex`：互斥保护临界区 {#ch3-3-1}

`sync.Mutex`（导入 `"sync"`）表示互斥锁，用于守卫临界区。原书展示了多个递增与递减协程通过同一把锁安全修改共享变量 `count` 的标准模式：

```go
var lock sync.Mutex
var count int

increment := func() {
	lock.Lock()
	defer lock.Unlock()
	count++
}
```

这里有四条核心工程准则：

1. **紧跟 `defer Unlock()`**：在 `Lock()` 下一行立即写 `defer lock.Unlock()` 是强烈推荐的惯用法，确保即使临界区内发生分支提前返回或 `panic`，锁也一定会被释放，避免把其他等待者永久锁死。
2. **零值可用且不可复制**：`sync.Mutex` 的零值就是一把处于未锁定状态的可用锁，无需额外初始化；但首次使用后绝对禁止按值复制（结构体方法必须使用指针接收者）。
3. **不可重入（Non-reentrant）**：Go 的 `Mutex` 不记录“当前哪个 goroutine 持有锁”。如果同一个 goroutine 在未解锁前再次对同一把 `Mutex` 调用 `Lock()`，它会把自己永久阻塞。
4. **正确理解 `TryLock`（Go 1.18+）**：`TryLock()` 尝试非阻塞获取锁并返回布尔值。根据 Go 内存模型，**返回 `false` 的失败 `TryLock` 调用不建立任何 happens-before 同步关系**——绝不能在 `TryLock()` 失败后去偷读受保护的变量，常规业务代码应优先使用阻塞式 `Lock()`。

### 3.3.2 `RWMutex`：读写锁的适用边界与防饥饿死锁 {#ch3-3-2}

当多个并发任务访问同一份数据，但大部分任务只是读取、只有极少数任务需要写入时，可以使用读写互斥锁 `sync.RWMutex`：

- 写操作调用 `Lock()` / `Unlock()`，要求排他独占；
- 读操作调用 `RLock()` / `RUnlock()`（或通过 `m.RLocker()` 获取满足 `sync.Locker` 接口的读锁视图），只要当前没有写锁持有或排队，任意数量的读者可以同时进入临界区。

原书通过改变读者数量从 $2^0$ 到 $2^{19}$ 的对比实验说明了减小读临界区争用的效果，但也给出了一句过于宽泛的结论：“通常建议使用 `RWMutex` 而不是 `Mutex`”。结合现代 Go 运行时实现，这里必须做两点重要校准：

1. **`RWMutex` 并不总是比 `Mutex` 快**：`RWMutex` 在每次 `RLock()` 和 `RUnlock()` 时，内部仍需对活跃读者计数器执行原子增减操作（`atomic.AddInt32`）。如果临界区极其短小（例如只是读一个结构体字段或一次简单的 `map` 查找），多核并发调用 `RLock()` 在同一个缓存行上争用原子计数器的开销，可能比普通 `Mutex` 还要高。只有当**读多写少且单次读操作本身有一定耗时**时，`RWMutex` 才能发挥并发读的优势；拿不准时应以基准测试为准。
2. **严禁递归获取读锁（防写饥饿机制导致的死锁）**：为了防止源源不断的读者把等待中的写者饿死，`sync.RWMutex` 规定：**一旦有写者调用了 `Lock()` 正在排队等待，所有后续新到达的 `RLock()` 调用都会被阻塞**，直到该写者完成写操作并释放锁。这就引出了一个极易踩中的死锁陷阱：
   ```text
   Goroutine A 持有第一次 RLock()
         │
         ├──► 此时 Goroutine B 调用 Lock() 排队等写锁（同时封锁后续新的 RLock）
         ▼
   Goroutine A 在未释放原读锁前，调用某辅助函数再次执行 RLock()
         └──► 第二次 RLock() 被排队中的 B 阻塞，而 B 又在等 A 释放第一次 RLock() ──► 永久死锁！
   ```
   因此，持有 `RLock` 的代码路径绝不能直接或间接再次对同一把 `RWMutex` 调用 `RLock`，更不能在持有读锁时直接调用 `Lock()` 尝试升级为写锁。

### 3.3.3 类型化原子操作与 `sync.Map` {#ch3-3-3}

对于单个独立整数或布尔状态位的高频并发读写，标准库 `"sync/atomic"` 提供了硬件指令级的原子操作。**自 Go 1.19 起**，标准库提供了强类型的 `atomic.Int64`、`atomic.Uint64`、`atomic.Bool` 和泛型指针 `atomic.Pointer[T]`，比早期的 `atomic.AddInt64(&n, 1)` 更安全（编译器能直接阻止你不小心用普通赋值 `n = 1` 绕过原子操作，且在 32 位架构上自动保证 64 位对齐）：

```go
var completed atomic.Int64
completed.Add(1)
current := completed.Load()
_ = current
```

在 Go 内存模型中，`sync/atomic` 的所有原子操作都具备顺序一致性（Sequentially Consistent）语义。但正如 [1.3.1 节](./chapter-01#ch1-3-1)所强调的，`if used.Load() < limit { used.Add(1) }` 依然是两次独立的原子操作，中间完全可能被其他 goroutine 插队；需要原子地完成“条件判断并更新”时，必须使用 `CompareAndSwap`（CAS）循环或退回 `sync.Mutex`。

此外，标准库自 Go 1.9 起提供了并发映射 `sync.Map`（Go 1.24 已将其底层重构为并发哈希前缀树 HashTrieMap，进一步改善了并发修改性能）。即便如此，官方文档依然明确建议：**绝大多数业务场景应优先使用普通的泛型 `map[K]V` 配合 `sync.Mutex` 或 `sync.RWMutex`**——不仅保留完整的编译期类型检查，还能把多个键或关联合计值的不变量包在同一个临界区里。`sync.Map` 仅专门针对两类场景优化：一是某个键只写入一次但会被大量协程高频读取，二是多个协程各自并发读写完全不相交的键集合。

## 3.4 Cond、Once 与 Pool {#ch3-4}

### 3.4.1 `Cond`：等待与广播条件事件 {#ch3-4-1}

`sync.Cond` 是供多个 goroutine 等待或宣布某个状态条件成立的集合点。如果不使用 `Cond`，想要等待某个受锁保护的条件 `conditionTrue()` 变为真，往往只能写空耗 CPU 的死循环 `for !conditionTrue() {}`，或者带人为延迟的轮询 `time.Sleep`。`sync.Cond` 则让 goroutine 能够在条件未满足时高效挂起，并在收到通知时唤醒重检：

```go
c := sync.NewCond(&sync.Mutex{})

// 等待方（消费者）
c.L.Lock()
for !conditionTrue() {
	c.Wait()
}
// 此时条件已满足，且仍持有 c.L 锁，可安全消费受保护的状态
c.L.Unlock()
```

阅读这段模板时，最关键的是理解 **`c.Wait()` 在底层自动完成的三步原子交接**，以及**为什么条件检查必须用 `for` 循环而不能用 `if`**：

1. **`c.Wait()` 的隐藏动作**：调用 `c.Wait()` 前**必须已经持有 `c.L` 锁**。进入 `Wait()` 后，运行时会先把当前 goroutine 加入等待队列并**自动调用 `c.L.Unlock()` 释放锁**，随后挂起当前 goroutine；当它被唤醒后，`Wait()` 会在返回前**自动重新调用 `c.L.Lock()` 拿回锁**！因此，虽然表面代码看起来从头到尾锁着 `c.L`，实际上在 `Wait()` 阻塞期间锁是释放给修改方去改变状态的。
2. **为什么必须用 `for !conditionTrue()` 循环检查**：当修改方改变状态并调用 `Signal()` 或 `Broadcast()` 唤醒等待者后，被唤醒的 goroutine 需要重新排队争抢 `c.L.Lock()`。在它真正拿到锁返回之前，完全可能有另一个协程抢先拿走锁并把队列里的唯一元素消费光了！因此，`Wait()` 返回只代表“曾经发生过一次通知”，必须在 `for` 循环中重新验证条件是否依然成立。

`sync.Cond` 提供了两种通知方法：

- **`Signal()`**：从内部 FIFO 等待队列中找出等待时间最长的**一个** goroutine 并唤醒它（原书用它实现了固定容量为 2、总计推入 10 个元素的有界队列协调）；
- **`Broadcast()`**：同时唤醒当前所有正在 `Wait()` 的 goroutine。原书用 GUI 按钮 `Button{Clicked: sync.NewCond(&sync.Mutex{})}` 展示了它的独特价值：如果只是做一次性停止广播，关闭通道 `close(done)` 更简单且对晚到的接收者也持续有效；但**通道一旦关闭就不能再次关闭，而 `Cond.Broadcast()` 可以随按钮被用户反复点击而无限次重复广播**。不过要注意，`Cond` 的通知没有记忆缓冲——如果调用 `Signal()` 或 `Broadcast()` 时没有任何 goroutine 正处在 `Wait()` 中，这次通知会直接消散。

### 3.4.2 `Once` 与 Go 1.21+ 函数式单次初始化 {#ch3-4-2}

`sync.Once` 保证在并发环境下某段初始化逻辑严格只执行一次。原书通过三个递进的小例子揭示了它的精确契约：

1. **高并发单次保证**：100 个 goroutine 并发调用 `once.Do(increment)`，最终 `count` 严格为 `1`，其余未抢到执行权的并发调用会阻塞等待那唯一一次 `increment` 执行完毕后才返回（建立 happens-before 同步关系）。
2. **`Once` 绑定的是实例本身，而非传入的函数身份**：观察原书的第二个例子：
   ```go
   var count int
   increment := func() { count++ }
   decrement := func() { count-- }

   var once sync.Once
   once.Do(increment)
   once.Do(decrement)
   fmt.Printf("Count: %d\n", count) // 输出：Count: 1（decrement 根本不会执行！）
   ```
   `sync.Once` 统计的是**该 `Once` 实例上 `Do` 被调用的次数**，而不是不同函数被调用的次数。
3. **循环依赖会导致死锁**：如果在 `onceA.Do(initA)` 调用的 `initA` 内部，又直接或间接调用了同一个 `onceA.Do(...)`，外层 `Do` 等待内层返回，内层 `Do` 又等待外层完成初始化，会当场死锁。

为了避免手动配对包级 `sync.Once` 变量与结果变量、也防止不小心往同一个 `Once` 实例传入不同函数，**Go 1.21 起在 `"sync"` 包中新增了三个高阶包装函数：`sync.OnceFunc`、`sync.OnceValue[T]` 和 `sync.OnceValues[T1, T2]`**：

```go
// 假设 readConfig 签名为 func() (Config, error)
var loadConfig = sync.OnceValues(readConfig)

func GetConfig() (Config, error) {
	return loadConfig()
}
```

首次调用 `loadConfig()` 时会执行 `readConfig`，后续所有并发调用直接返回缓存的 `(Config, error)` 结果。还要注意一处面试常考的边界差异：如果初始化函数发生 `panic`，原始 `once.Do(f)` 会将初始化视为已完成，后续再调 `once.Do(f)` 直接静默返回；而 **`OnceFunc` / `OnceValue` / `OnceValues` 则会捕获该 `panic` 值，并在后续每一次调用时重新抛出相同的 `panic`**，防止调用方误用未初始化成功的零值状态。

### 3.4.3 `Pool`：临时对象复用池与原书误区校准 {#ch3-4-3}

`sync.Pool` 是并发安全的临时对象池。调用 `Get()` 时，它会先检查池中是否有空闲实例可用，若有则直接返回，若无则调用 `New` 字段指向的函数创建新实例；使用完毕后调用 `Put(x)` 将实例归还池中供后续复用。

原书展示了用 `calcPool` 复用 `1024` 字节切片以减轻百万次并发工作内存分配压力的例子（注意为了避免将切片值赋给 `interface{}` / `any` 时触发额外的堆分配，池中通常存放切片指针 `*[]byte` 或 `*bytes.Buffer`）：

```go
var calcPool = &sync.Pool{
	New: func() any {
		buf := make([]byte, 1024)
		return &buf
	},
}

func useBuffer() {
	bufPtr := calcPool.Get().(*[]byte)
	buf := (*bufPtr)[:0] // 取出后必须重置状态，不得假设其中的旧内容已清零
	defer calcPool.Put(bufPtr)
	_ = buf
}
```

阅读原书这一节时，有**两处重要问题必须修正**：

1. **原书 `calcPool.New` 中的数据竞争**：原书在 `New` 函数内直接写了非同步的 `numCalcsCreated += 1` 来统计创建次数。实际上，当多个 goroutine 同时调用 `Get()` 且池中恰好为空时，**`New` 函数会被多个 goroutine 并发调用**！若要在 `New` 中做计数统计，必须使用 `atomic.Int64`。
2. **`sync.Pool` 绝不是固定容量的数据库连接池**：原书在介绍 `Pool` 时写道“它通常用于约束创建昂贵的场景（如数据库连接），以便只创建固定数量的实例”，并用预热 10 个对象模拟网络服务连接缓存。**这一类比在 Go 中具有误导性**：
   - `sync.Pool` 里的任何空闲对象**随时可能在垃圾回收（GC）期间被运行时悄无声息地清理释放**，且不会触发任何析构回调；
   - `sync.Pool` 没有最大容量上限，也不提供“遍历池中所有连接并逐一调用 `Close()`”的能力。
   因此，**绝对不要用 `sync.Pool` 管理数据库连接、TCP 套接字或文件句柄等需要显式关闭和严格并发上限的有状态资源**（这类场景应使用 `database/sql` 内置连接池、带缓冲通道实现的资源池或信号量）。`sync.Pool` 的真正定位是复用短暂存活的无状态内存块（如 `bytes.Buffer`、编码器状态机），帮高频分配路径分担 GC 压力。

## 3.5 channel：通信、状态表与所有权契约 {#ch3-5}

### 3.5.1 方向约束、无缓冲与有缓冲通道 {#ch3-5-1}

`channel` 是引用类型，零值为 `nil`，必须通过内置 `make` 函数初始化。在函数签名中，建议将双向通道 `chan T` 约束为单向通道（双向通道可隐式转换为单向通道，反之则会编译报错）：

- **`chan<- T`（只写/只发送通道）**：只允许发送数据 `ch <- v` 和关闭通道 `close(ch)`，尝试接收 `<-ch` 会触发编译错误；
- **`<-chan T`（只读/只接收通道）**：只允许接收数据 `<-ch`，尝试发送或调用 `close(ch)` 会触发编译错误。

创建通道时是否传入容量参数决定了它的同步形态：

```go
unbuffered := make(chan int)    // 等价于 make(chan int, 0)：无缓冲通道
buffered := make(chan rune, 4)  // 容量为 4 的带缓冲通道
```

- **无缓冲通道（容量为 0）**：每次通信都是一次严格的**同步会合（Rendezvous）**。发送方执行 `unbuffered <- v` 时会阻塞，直到另一个 goroutine 在同一通道上执行 `<-unbuffered`，反之亦然。
- **有缓冲通道（容量 $C > 0$）**：内部维护一个容量为 $C$ 的环形 FIFO 队列。当缓冲区未满时，发送操作将数据拷入槽位后立即返回而不阻塞；当缓冲区写满 $C$ 个元素且无人读取时，第 $C+1$ 次发送就会阻塞，直到有消费者取走队首元素腾出空位（此外，若缓冲通道当前为空且恰好已有接收者在阻塞等待，运行时会直接把值从发送方栈拷给接收方，省去入队出队开销）。

### 3.5.2 关闭广播、遍历与状态速查表 {#ch3-5-2}

当上游不再有新数据写入时，可以通过 `close(ch)` 关闭通道，向所有下游消费者发出“没有更多数据”的信号。从已关闭的通道读取**永远不会阻塞**：如果缓冲区里还有未读完的残留数据，会先按 FIFO 顺序依次读出（此时 `v, ok := <-ch` 的 `ok` 为 `true`）；一旦缓冲区排空，后续任意次读取都会**立即返回元素类型的零值，且 `ok` 为 `false`**。

利用“已关闭通道可被无限次立即读取”这一性质，**`close(ch)` 是在同一瞬间唤醒任意多个等待 goroutine 最优雅、开销最低的广播机制**。原书用 `close(begin)` 同时放行 5 个就绪协程展示了这一经典技巧：

```go
begin := make(chan struct{})
var wg sync.WaitGroup
for i := range 5 {
	wg.Go(func() {
		<-begin // 全部阻塞在此处等待发令枪
		fmt.Printf("%d has begun\n", i)
	})
}
fmt.Println("Unblocking goroutines...")
close(begin) // 一声令下，所有等待 <-begin 的协程同时解除阻塞！
wg.Wait()
```

将通道的接收、发送与 `close` 在不同状态下的行为汇总如下（对应原书表 3-2）：

| 操作 | `nil` 通道（零值） | 已打开且非空 / 未满 | 已打开但为空 | 已打开但已满 | 已关闭的通道 |
| --- | --- | --- | --- | --- | --- |
| **接收 `<-ch`** | **永久阻塞** | 读出值，`ok == true` | **阻塞等待发送者** | 读出队首值，`ok == true` | 先排空残留缓冲；排空后**立即返回零值且 `ok == false`** |
| **发送 `ch <- v`** | **永久阻塞** | 写入值（无缓冲需配对） | 无缓冲等接收者；有缓冲直接写入 | **阻塞等待空位** | **`panic: send on closed channel`** |
| **关闭 `close(ch)`** | **`panic: close of nil channel`** | 正常关闭 | 正常关闭 | 正常关闭 | **`panic: close of closed channel`** |

观察这张表就会发现：通道共有**三处阻塞点**和**三处 `panic` 雷区**（关闭 `nil` 通道、向已关闭通道发送、重复关闭已关闭通道）。如何从代码结构上彻底拆掉这三颗雷？答案就是原书提出的**通道所有权原则**。

### 3.5.3 通道所有权原则（`chanOwner` 模式）与内存模型保证 {#ch3-5-3}

原书将**通道所有权（Channel Ownership）**定义为“负责实例化、写入并关闭该通道的那个 goroutine”，并给出了职责分明的 `chanOwner` 范式（完整程序需导入 `"fmt"`）：

```go
package main

import "fmt"

func main() {
	chanOwner := func() <-chan int {
		resultStream := make(chan int, 5) // 1. 实例化通道（已知发 6 个值，缓冲 5 可减少阻塞）
		go func() {
			defer close(resultStream) // 3. 写完退出前确保关闭通道
			for i := 0; i <= 5; i++ {
				resultStream <- i // 2. 执行写操作
			}
		}()
		return resultStream // 4. 隐式收窄为只读通道 <-chan int 暴露给外部
	}

	resultStream := chanOwner()
	for result := range resultStream { // 消费者只需关心读取阻塞与通道何时关闭
		fmt.Printf("Received: %d\n", result)
	}
	fmt.Println("Done receiving!")
}
```

把 `resultStream` 的可写句柄严格约束在 `chanOwner` 词法作用域内后：

- **所有者（`chanOwner`）**独自掌控初始化、发送与 `defer close`，天然消除了向 `nil` 通道写、关 `nil` 通道、写已关闭通道和重复关闭通道的全部 `panic` 风险；
- **消费者（`main`）**拿到的只是只读类型 `<-chan int`，编译期就被禁止误调 `close` 或反向发送，只需专注处理读取阻塞与结束信号。

最后，牢记 [Go 内存模型](https://go.dev/ref/mem#chan)对通道规定的四条同步因果边：

1. 向通道的**第 $k$ 次发送** synchronizes-before 从该通道完成的**第 $k$ 次接收**；
2. 对于**无缓冲通道**，从通道的接收 synchronizes-before 对应的发送完成；
3. 对于**容量为 $C$ 的带缓冲通道**，第 $k$ 次接收 synchronizes-before 第 $k+C$ 次发送完成（这也解释了为什么容量为 $C$ 的缓冲通道可以用来实现最大并发数为 $C$ 的计数信号量）；
4. 关闭通道 `close(ch)` synchronizes-before 因通道已关闭而返回零值的接收操作。

## 3.6 select 语句：多路复用与求值规则 {#ch3-6}

如果说通道是粘合 goroutine 的胶水，那么 `select` 语句就是粘合多个通道的胶水。它允许一个 goroutine 同时等待多路通道的读取或写入事件：

```go
select {
case v := <-c1:
	// c1 可读时执行
case c2 <- x:
	// c2 可写时执行
case <-ctx.Done():
	// 取消或超时分支
}
```

要精准掌控 `select`，必须吃透原书强调的四个核心问题及其规范细节：

1. **多个分支同时就绪时如何选择？——均匀伪随机公平选择**：与从上往下顺序匹配的 `switch` 不同，当多个 `case` 同时可通信时，Go 运行时会在就绪分支中执行**均匀伪随机选择**。原书将两个已关闭的通道 `c1`、`c2` 放进循环跑 1000 次 `select`，实测 `c1Count` 为 505、`c2Count` 为 496，几乎各占一半。这意味着**把 `case <-ctx.Done():` 写在第一行并不会给它赋予更高的优先级**——如果取消信号与数据通道同时就绪，运行时依然有 50% 的概率抽中数据分支。若业务要求“一旦取消绝不再处理新数据”，必须在进入发送/处理分支前额外做一次非阻塞检查：`if ctx.Err() != nil { return }`。
2. **没有任何分支就绪时怎么办？——阻塞等待、超时或 `default`**：
   - 若无 `default` 分支，`select` 会挂起当前 goroutine，直到至少有一个 `case` 就绪；
   - 可加入 `case <-ctx.Done():` 或定时器分支限制最长等待时间；
   - 若包含 `default:` 分支，当所有通道均未就绪时会**立即执行 `default` 而不阻塞**。注意切勿在没有休眠或阻塞工作的 `for { select { ... default: } }` 循环中随手留一个空 `default`，否则无数据时循环会以每秒数千万次的速度空转跑满单核 CPU。
3. **特殊的 `select {}` 与 `nil` 通道分支**：不含任何分支的空 `select {}` 会永远挂起当前 goroutine；而在普通 `select` 中，若某个 `case` 操作的通道变量为 `nil`，该分支会被永久忽略（不会就绪也不会报错），非常适合在多路合流时动态屏蔽已经关闭的输入通道。
4. **进入 `select` 时的表达式求值顺序**：进入 `select` 语句时，所有 `case` 中的**通道表达式**和**发送箭头右侧的待发送表达式**都会按源码从上到下的顺序**先求值一次**！例如：
   ```go
   select {
   case out <- expensiveCompute():
   default:
   }
   ```
   即便此时 `out` 根本没人接收（甚至 `out` 为 `nil`）、最终走了 `default` 分支，**`expensiveCompute()` 也一定会在进入 `select` 时被无条件调用一次**！如果右侧表达式本身还是一个阻塞接收（如原书第 4 章曾写过的 `case out <- <-in:`），它甚至会在进入 `select` 分支选择之前就直接把当前协程卡死在 `<-in` 上。

## 3.7 GOMAXPROCS 控制与容器感知调度 {#ch3-7}

`runtime.GOMAXPROCS(n)`（导入 `"runtime"`）控制的是**同一时刻最多允许多少个操作系统线程同时执行用户态 Go 代码**（即调度模型中逻辑处理器 `P` 的数量，详见[第 6 章](./chapter-06#ch6-1)），而不是进程可创建的 goroutine 上限或 OS 线程总数上限（传入 $n < 1$ 时不修改当前设置，仅查询并返回当前值）。

从原书时代到 Go 1.27，这一参数的默认策略经历了两次重大演进：

- **Go 1.5—1.24**：默认在进程启动时读取宿主机逻辑 CPU 核数 `runtime.NumCPU()`。但在 Kubernetes / Docker 容器环境中，宿主机往往有 64 核或 128 核，而容器自身的 Linux cgroup CPU 限额（CPU Limit）可能只分到了 2 核——若按宿主机核数创建 64 个 `P`，会导致过多线程争抢微薄的容器配额，引发严重的内核 CFS 节流（CPU Throttling）与上下文切换抖动。
- **Go 1.25 起（容器感知与动态更新）**：运行时的默认 `GOMAXPROCS` 会综合计算**机器逻辑 CPU 数、进程 CPU 亲和性掩码（Affinity Mask）以及 Linux 上的 cgroup CPU 带宽限额（CPU quota / period，对应容器的 CPU Limit 而非 CPU Request）**，取三者的最小值并向上取整（除非物理/亲和核数不足 2，否则默认下限不低于 2）。不仅如此，运行时还会以最高每秒一次的频率动态感知 CPU 配额变化并自动更新默认值！

掌握现代 `GOMAXPROCS` 还需注意两条操作规则：

1. **手动设置会关闭自动更新**：一旦通过环境变量 `GOMAXPROCS` 或在代码中显式调用 `runtime.GOMAXPROCS(n)` 指定了数值，运行时的周期性自动更新就会停用；如需恢复默认自动感知行为，可调用 **Go 1.25 新增的 `runtime.SetDefaultGOMAXPROCS()`**。
2. **测试排错技巧**：正如原书作者分享的实战经验，当某些并发单测在 4 核开发机上偶发失败、疑似存在未暴露的竞态时，可以在测试时临时调高并行度（如 `go test -cpu=1,4,16 ./...`），拉大调度交错概率，配合 `-race` 更快揪出隐患。

## 练习 {#ch3-exercises}

以下五道练习覆盖 `WaitGroup` 启动竞态、`Cond` 唤醒重检、`RWMutex` 递归读锁死锁、`select` 发送求值顺序以及多生产者通道关闭责任。代码片段默认位于函数体内，假定已按需导入 `"sync"`、`"sync/atomic"` 与 `"fmt"`。请先独立分析作答，再展开核对。

### 练习 1：为什么 `wg.Wait()` 会偶发漏等子任务？

阅读下面这段代码（其中 `work` 为已声明的 `func()` 且不会触发 `panic`），指出其中的并发缺陷，并分别给出传统写法（Go 1.24 及以前）与 Go 1.25+ 现代写法的修正代码：

```go
var wg sync.WaitGroup
go func() {
	wg.Add(1)
	defer wg.Done()
	work()
}()
wg.Wait()
```

<details>
<summary>查看参考答案</summary>

1. **缺陷原因**：`wg.Add(1)` 被写在了新启动的子 goroutine 内部。由于 `go` 语句只负责将子 goroutine 放入就绪队列，主 goroutine 完全可能在新 goroutine 还没执行到 `wg.Add(1)` 之前就先执行了 `wg.Wait()`，此时计数器仍为 `0`，`wg.Wait()` 会立即返回，导致漏等 `work()`。
2. **传统修正写法（在 `go` 之前执行 `Add`）**：
   ```go
   var wg sync.WaitGroup
   wg.Add(1)
   go func() {
   	defer wg.Done()
   	work()
   }()
   wg.Wait()
   ```
3. **Go 1.25+ 现代修正写法（使用 `wg.Go`）**：
   ```go
   var wg sync.WaitGroup
   wg.Go(work)
   wg.Wait()
   ```

</details>

### 练习 2：`Cond.Wait()` 用 `if` 代替 `for` 为什么会触发越界崩溃？

某内存队列使用 `c := sync.NewCond(&sync.Mutex{})` 协调生产与消费。消费者代码如下：

```go
c.L.Lock()
if len(queue) == 0 {
	c.Wait()
}
item := queue[0]
queue = queue[1:]
c.L.Unlock()
```

假设当前有两个消费者协程 C1、C2 都阻塞在 `c.Wait()` 上；此时生产者向空队列放入了 **1 个**元素并调用了 `c.Broadcast()`（或者在 C1 被 `c.Signal()` 唤醒但尚未抢到 `c.L` 锁之前，另一个新调用消费方法的协程 C3 抢先拿到了 `c.L` 锁）。请问接下来会发生什么？如何修正？

<details>
<summary>查看参考答案</summary>

1. **故障过程**：当队列中只有 1 个元素时，第一个拿到 `c.L` 锁的消费者（如 C1 或抢先闯入的 C3）会取走这唯一的元素并将 `queue` 变回空切片 `len(queue) == 0`，随后释放锁。接着另一个从 `c.Wait()` 唤醒并重新拿到 `c.L` 锁的消费者（如 C2）从 `c.Wait()` 返回，因为外层写的是 `if` 而不是 `for`，它不会重新检查 `len(queue) == 0`，直接向下执行 `item := queue[0]`，当场触发 `panic: runtime error: index out of range [0] with length 0`！
2. **修正方案**：将 `if len(queue) == 0` 改为 **`for len(queue) == 0`**，确保每次从 `c.Wait()` 重新拿到锁返回时，都再次验证队列确实非空后才取元素。

</details>

### 练习 3：同一 goroutine 内嵌套获取 `RLock` 为何会死锁？

某配置中心结构体 `ConfigStore` 持有一把 `mu sync.RWMutex`。其公开方法 `GetSummary()` 先调用 `s.mu.RLock()`，再在锁内调用辅助方法 `s.getRegion()`；而 `s.getRegion()` 内部开头也写了一句 `s.mu.RLock()`（配对 `defer s.mu.RUnlock()`）。平时压测全是读请求时一切正常，但一旦后台定时刷新协程调用 `s.mu.Lock()` 更新配置，服务就会偶发彻底卡死。请解释原因并给出修改方案。

<details>
<summary>查看参考答案</summary>

1. **死锁原因**：`sync.RWMutex` 为防止写者饥饿规定：当后台刷新协程调用 `s.mu.Lock()` 开始排队等待写锁时，后续所有新发起的 `RLock()` 都会被阻塞。如果某个读协程已经拿到了 `GetSummary()` 的第一层 `RLock()`，此时写协程介入调用 `Lock()`，接着读协程进入 `getRegion()` 请求第二层 `RLock()`——第二层 `RLock()` 会等待写协程的 `Lock()`，而写协程的 `Lock()` 又在等待读协程释放第一层 `RLock()`，形成双向循环等待死锁！
2. **修改方案**：严禁在已持有 `RLock` 的调用链上再次获取同一把锁。常见的重构方式是将内部不加锁的逻辑拆成私有方法 `getRegionLocked()`（由调用方保证已持锁），公开的 `GetRegion()` 与 `GetSummary()` 各自在顶层加一次 `RLock()` 后调用 `getRegionLocked()`。

</details>

### 练习 4：被屏蔽的 `nil` 通道分支为什么还会产生副作用？

阅读下面这段代码，判断最终走哪个分支、变量 `calls` 的最终值是多少，并解释原因：

```go
var out chan int // 零值 nil 通道
calls := 0
next := func() int {
	calls++
	return 42
}

select {
case out <- next():
default:
}
fmt.Println(calls)
```

<details>
<summary>查看参考答案</summary>

**最终执行 `default` 分支，但打印出的 `calls` 值为 `1`（而不是 `0`）！**

根据 Go 语言规范对 `select` 语句求值顺序的规定：在进入 `select` 判断哪些分支可通信之前，所有 `case` 的通道表达式以及**发送语句右侧的表达式都会按源码顺序先求值一次**。尽管 `out` 是 `nil` 通道、导致 `case out <- ...` 分支永远不可能被选中，但右侧的 `next()` 依然在进入 `select` 时被实实在在地调用了一次，使 `calls` 变成了 `1`。因此，切勿把有副作用或高开销的函数直接写在 `select` 发送分支的箭头右侧。

</details>

### 练习 5：用原子变量做“先查后加”能否守住配额上限？

某限流器试图用 `atomic.Int64` 限制最大并发数为 `limit`（`limit > 0`），每个请求到来时执行：

```go
if used.Load() < limit {
	used.Add(1)
	defer used.Add(-1)
	handleRequest()
}
```

请问：高并发下正在执行 `handleRequest()` 的协程数能否严格不超过 `limit`？如果不能，请分别给出基于 `atomic` CAS 循环和基于通道信号量的正确写法。

<details>
<summary>查看参考答案</summary>

1. **不能保证 `used <= limit`**：`used.Load()` 与 `used.Add(1)` 是两次独立的原子操作。当 `used` 为 `limit - 1` 时，10 个 goroutine 可能同时执行 `used.Load()` 全部读到 `limit - 1` 并通过 `if` 检查，随后各自执行 `used.Add(1)`，使实际并发数冲到 `limit + 9`。
2. **写法一（使用 `CompareAndSwap` 循环原子提交）**：
   ```go
   for {
   	cur := used.Load()
   	if cur >= limit {
   		return // 超出配额，拒绝执行
   	}
   	if used.CompareAndSwap(cur, cur+1) {
   		defer used.Add(-1)
   		handleRequest()
   		break
   	}
   }
   ```
3. **写法二（使用带缓冲通道作为计数信号量，更地道）**：
   初始化 `sem := make(chan struct{}, limit)`，非阻塞抢占槽位：
   ```go
   select {
   case sem <- struct{}{}:
   	defer func() { <-sem }()
   	handleRequest()
   default:
   	// 槽位已满，拒绝执行（或改为阻塞等待 / 监听 <-ctx.Done()）
   }
   ```

</details>

## 面试题 {#ch3-interview}

以下四题聚焦日常开发与面试中最易混淆的组件边界。请先独立给出结论，再展开核对。

### 面试题 1：`sync.Once.Do` 初始化时如果发生 `panic`，后续再调还会重试吗？`OnceValues` 呢？

假设传给 `once.Do(initFn)` 的函数在首次执行时触发了 `panic`，被外层 `recover()` 捕获后，另一个协程再次调用同一个实例的 `once.Do(initFn)`，请问 `initFn` 会重新执行吗？如果改用 Go 1.21+ 的 `sync.OnceValues(initFn)`，行为有何不同？

<details>
<summary>查看参考答案</summary>

1. **都不会重试，但后续调用的表现不同**：
   - **`sync.Once.Do`**：一旦 `initFn` 执行过（哪怕中途 `panic` 退出），`Once` 内部都会将其标记为“已完成”。后续再调用 `once.Do` 会**直接静默返回**，不会重新执行 `initFn`，也不会再次 `panic`（这容易让后续调用方误以为资源已经初始化成功）。
   - **`sync.OnceFunc` / `OnceValue` / `OnceValues`（Go 1.21+）**：同样不会重新执行 `initFn`，但它们会记录首次发生的 `panic` 值，并在**后续每一次调用包装函数时都重新抛出相同的 `panic`**。
2. 如果初始化失败返回的是普通 `error`，`OnceValues` 也会永久缓存那次 `(zero, err)` 结果；若业务需要“失败后下次调用允许重试”，不能直接使用 `sync.Once`，而应使用 `sync.Mutex` 配合布尔成功标志（或 `golang.org/x/sync/singleflight`）自行控制。

</details>

### 面试题 2：在 `select` 中把 `case <-ctx.Done():` 写在第一行，能保证取消优先吗？

阅读以下代码（假设进入 `select` 的瞬间，`ctx` 已经取消，同时带缓冲通道 `out` 也有空位可写）：

```go
select {
case <-ctx.Done():
	return ctx.Err()
case out <- v:
	return nil
}
```

请问这段代码能保证一定返回 `ctx.Err()` 吗？如果业务要求“只要进入时 `ctx` 已取消就绝不发送 `v`”，应该怎么写？

<details>
<summary>查看参考答案</summary>

1. **不能保证**：Go 语言规范规定，当 `select` 的多个 `case` 同时就绪时，运行时按**均匀伪随机分布**从中任选一个执行，与 `case` 在源码中的上下书写顺序完全无关。因此此时有约 50% 的概率会走 `case out <- v` 分支。
2. **实现取消优先的标准两步写法**：先在真正阻塞的 `select` 之前做一次非阻塞检查（或在前置 `select` 中配 `default`）：
   ```go
   if err := ctx.Err(); err != nil {
   	return err
   }
   select {
   case <-ctx.Done():
   	return ctx.Err()
   case out <- v:
   	return nil
   }
   ```
   （注意：即使前置检查通过，在阻塞等待期间若 `ctx.Done()` 与 `out <- v` 在同一微秒同时就绪，仍属于并发竞态边界，协作式取消本身不承诺跨通道的硬件事务隔离。）

</details>

### 面试题 3：既然 `sync.Pool` 并发安全，为什么不能用它做数据库连接池？

如果把 10 个已经建好的 TCP 或数据库连接 `Put` 进 `sync.Pool`，能否把它当作容量为 10 的连接池使用，并在进程退出时从池中把这 10 个连接全部取出来关闭？

<details>
<summary>查看参考答案</summary>

**绝对不能。**

1. **对象随时可能被 GC 静默清除**：`sync.Pool` 的设计目标是缓存可随时丢弃的临时内存对象（如 `bytes.Buffer`）。每逢垃圾回收（GC）周期，运行时都有权在不发出任何通知、不调用任何关闭方法的情况下清空池中缓存的对象，导致底层套接字或数据库连接泄漏。
2. **无容量上限且无法枚举清理**：当并发请求超过 10 个时，`Get()` 会不断调用 `New` 创建新连接，无法起到限制下游最大连接数的作用；进程退出时也没有 API 能够遍历并关闭池中剩余的连接。管理长连接应使用 `database/sql` 连接池或基于带缓冲通道/互斥锁专门构建的有界资源池。

</details>

### 面试题 4：使用完的 `channel` 如果不调用 `close`，会导致内存泄漏吗？

有人认为：“只要 `make(chan int)` 创建了通道，用完就必须像关文件一样调用 `close(ch)`，否则垃圾回收器无法回收这个通道。”这个说法对吗？

<details>
<summary>查看参考答案</summary>

**不对。**

在 Go 中，通道只是一个普通的堆内存数据结构，并不绑定操作系统内核句柄。**一个通道只要不再被任何活跃的 goroutine 引用，无论它是否调用过 `close`，垃圾回收器（GC）都会正常回收它**。调用 `close(ch)` 的唯一目的是向接收方发送“后续不会再有新数据写入”的控制信号（例如结束下游的 `for range ch` 或广播 `<-done`）。但反过来一定要记住：**GC 不会回收阻塞在通道上的 goroutine**——如果有协程还死等在 `<-ch` 或 `ch <- v` 上，不仅该协程本身会泄漏，被它栈帧引用的通道 `ch` 也永远不会被回收！

</details>

## 参考资料

- [Go 语言规范：`go` 语句](https://go.dev/ref/spec#Go_statements)
- [Go 语言规范：`for` 语句与 Go 1.22 循环变量语义](https://go.dev/ref/spec#For_statements)
- [Go 语言规范：通道类型与 `close`](https://go.dev/ref/spec#Channel_types)
- [Go 语言规范：`select` 语句与求值顺序](https://go.dev/ref/spec#Select_statements)
- [Go 内存模型：通道、锁与 `Once` 的同步保证](https://go.dev/ref/mem)
- [标准库 `sync` 包文档（`WaitGroup.Go`、`Mutex`、`RWMutex`、`Cond`、`OnceValues`、`Pool`、`Map`）](https://pkg.go.dev/sync)
- [标准库 `sync/atomic` 包文档](https://pkg.go.dev/sync/atomic)
- [标准库 `runtime.GOMAXPROCS` 与 `SetDefaultGOMAXPROCS` 文档](https://pkg.go.dev/runtime#GOMAXPROCS)
- [Go 1.24 发布说明：`sync.Map` 实现重构](https://go.dev/doc/go1.24#syncpkgsync)
- [Go 1.25 发布说明：`WaitGroup.Go` 与容器感知 `GOMAXPROCS`](https://go.dev/doc/go1.25)
