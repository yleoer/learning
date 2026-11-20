---
title: 第 1 章 并发概述
description: 从 Amdahl 定律、数据竞争、原子性与活性故障出发，建立分析并发程序正确性的基本框架。
---

# 第 1 章 并发概述

## 本章要点

编写并发程序的难点不在于“如何启动多个同时执行的函数”，而在于多个执行流如何安全地共享状态、以确定的因果顺序观察彼此的结果，并在资源受限或请求取消时持续向前推进。本章沿着原书的问题脉络，从多核与水平扩展的物理边界切入，依次剖析竞态条件与数据竞争、原子性的观察范围、内存访问同步的局限，以及死锁、活锁和饥饿三类活性故障，最后给出评估组件并发安全性的契约清单。

读完本章后，应能清晰区分“没有数据竞争”与“没有竞态条件”，解释为什么在代码中插入 `time.Sleep` 或单纯给每个字段加锁都不能保证业务正确性，并能对照 Coffman 条件与临界区粒度排查并发代码中的死锁与饥饿隐患。

> 核对日期：2026 年 11 月 10 日；核对环境为 Go 1.27.3、Windows/AMD64。

## 1.1 摩尔定律、Web Scale 与并发的边界 {#ch1-1}

并发（Concurrency）是组织多个逻辑上独立、执行时间相互重叠的任务的方式：Web 服务器同时处理成百上千个客户端连接，下载器在等待网络响应的间隙继续解析已到达的数据，桌面界面在后台计算时依然流畅响应点击。代码结构是否采用并发组织，与任务在运行时是否真正由多个 CPU 核心在同一物理时刻执行，属于两个层面的问题（详见[并发与并行的区别](./chapter-02#ch2-1)）。

原书从摩尔定律（Moore's Law）增速放缓讲起：当单核时钟频率的提升逼近功耗与散热墙，硬件演进转向多核处理器，软件架构则转向借助云计算实现水平扩展（Horizontal Scaling，即常说的 Web Scale）。如果一个问题可以拆分为几乎互不依赖的子任务——例如原书提到的用 Spigot 算法分段计算圆周率 $\pi$——这类问题在计算机科学中称为**易并行问题（Embarrassingly Parallel Problem）**，往往能通过增加 CPU 核心或机器实例获得接近线性的吞吐提升。

然而，绝大多数真实业务并非纯粹的易并行问题。计算机架构师 Gene Amdahl 提出的 **Amdahl 定律（Amdahl's Law）** 刻画了固定规模任务在并行化时的理论加速上限。设任务中必须串行执行的比例为 $s$（$0 \le s \le 1$），其余 $1 - s$ 的部分可以理想地均分给 $p$ 个处理单元并行执行，则整体加速比为：

```text
加速比 = 1 / (s + (1 - s) / p)
```

这个公式揭示了两条关键工程边界：

1. **串行部分决定了加速比的绝对天花板**：例如一个任务有 20% 的步骤必须串行完成（$s = 0.2$），即便将处理单元 $p$ 增加到无穷大，理论加速比也永远不可能超过 $1 / 0.2 = 5$ 倍。原书以图形界面（GUI）程序为例：无论给机器配备多少个 CPU 核心，整个流程的速度依然受制于“等待人类点击按钮”这一串行环节。
2. **盲目增加并发度可能适得其反**：Amdahl 定律给出的是忽略协调开销的理想上限。实际运行中，跨 goroutine 同步、锁争用、CPU 缓存行失效、结果汇总以及共享数据库的单点热点都会额外增加串行与通信成本。能够水平增加无状态服务实例，也不等于下游存储自动具备同等的扩展能力。

## 1.2 竞态条件与数据竞争 {#ch1-2}

初学者踏入并发编程时，最常踩中的坑是假设并发代码会按照源码书写的先后顺序执行。在讨论具体代码之前，需要先厘清原书常一并提及、但在 Go 内存模型中必须严格区分的两个概念：

- **竞态条件（Race Condition）**：当两个或多个操作必须按特定顺序执行才能保证业务结果正确，但程序并未通过同步机制保证这一顺序时，就会发生竞态条件。
- **数据竞争（Data Race）**：两个或多个 goroutine 在没有任何同步约束的情况下并发访问同一内存位置，且其中至少有一次访问是写入。

来看原书第 1 章最核心的入门示例（完整可运行程序，导入标准库 `"fmt"`）：

```go
package main

import "fmt"

func main() {
	var data int
	go func() {
		data++
	}()
	if data == 0 {
		fmt.Printf("the value is %v.\n", data)
	}
}
```

关键字 `go` 启动了一个新的 goroutine 并发执行 `data++`，同时主 goroutine 继续向下执行 `if data == 0` 判断。因为两段逻辑之间没有任何同步，对变量 `data` 的写操作（`data++`）与读操作（`data == 0` 及 `fmt.Printf` 中的读取）构成了典型的**数据竞争**。仅这短短几行代码，在运行时就存在**三种**可能的结果：

1. **什么也不打印**：子 goroutine 的 `data++` 在主 goroutine 执行 `if data == 0` 之前完成，`data` 变为 `1`，条件为假。
2. **打印 `the value is 0.`**：主 goroutine 的 `if data == 0` 和 `fmt.Printf` 都在子 goroutine 执行 `data++` 之前运行完毕。
3. **打印 `the value is 1.`**：主 goroutine 执行 `if data == 0` 时 `data` 确实还是 `0`，因此进入 `if` 分支；但在 `fmt.Printf` 真正读取 `data` 参数之前，子 goroutine 完成了 `data++`，导致进入“`data == 0`”分支后反而打印出了 `1`！

不少开发者在遇到这类不确定行为时，会下意识地在 `go func()` 后面塞一行休眠语句，试图“等子协程跑完”：

```go
var data int
go func() { data++ }()
time.Sleep(time.Second) // 错误做法：只改变时机概率，并未消除数据竞争
if data == 0 {
	fmt.Printf("the value is %v.\n", data)
}
```

原书对此给出了非常精辟的提醒：**`time.Sleep` 绝不是解决并发问题的方案**。休眠 1 秒只是降低了后两种结果出现的概率，在操作系统负载飙升、容器 CPU 被限流或极端调度延迟下，上面三种结果依然可能发生——它永远不会让程序在逻辑上变正确，反而白白拖慢了正常执行的速度（原本只需几微秒的同步变成了硬等 1 秒）。思考并发交错时，不妨像原书建议的那样：想象任意两条语句之间都可能相隔 1 纳秒，也可能相隔 1 小时。

此外，在 Go 中绝不能抱有“发生数据竞争大不了只是读到旧值或新值”的侥幸心理。根据 [Go 内存模型](https://go.dev/ref/mem)，对于切片（包含指针、长度、容量三个机器字）、字符串（指针与长度）和接口值（类型指针与数据指针）等多机器字结构，未同步的并发读写可能读到“半新半旧”的撕裂表示，直接引发越界访问或内存损坏；对内置 `map` 的并发读写更会被运行时直接拦截并触发不可恢复的 `fatal error`。检测执行路径上数据竞争的方法详见[附录 A 的竞态检测器](./appendix-a#cha-2)。

## 1.3 原子性、临界区与内存访问同步 {#ch1-3}

### 1.3.1 原子性取决于观察上下文 {#ch1-3-1}

当某个操作被称为具有**原子性（Atomicity）**时，意味着在它所处的**上下文（Context，即观察范围）**中，它是不可分割（Indivisible）且不可中断（Uninterruptible）的：要么完整执行完毕，要么尚未发生，外界绝不会观察到它执行到一半的中间状态。

定义原子性时，第一件事就是明确观察范围：

- 在单线程顺序程序的上下文中，`i++` 不会与任何并发流交错，可以视为原子的；
- 但在多个 goroutine 共享变量 `i` 的上下文中，一行 `i++` 实际上包含三个独立步骤：**读取 `i` 的当前值 → 将值加 1 → 将结果写回 `i`**。两个 goroutine 并发执行 `i++` 时，完全可能同时读到 `0`、各自算出 `1` 并写回，导致递增两次后结果仍是 `1`。

这揭示了并发设计的一条核心铁律：**将多个单独原子的操作组合在一起，并不会自动构成一个更大的原子操作**。即便把计数变量换成 `sync/atomic` 的原子整数，单次 `Add` 是原子的，但“先检查库存大于 0、再扣减库存”横跨两次操作，若没有覆盖整个“检查并修改（Check-Then-Act）”过程的同步协议，两个并发请求依然会同时通过检查并导致超卖。

### 1.3.2 临界区与互斥锁为何不能消除所有竞态 {#ch1-3-2}

程序中需要独占访问共享资源的代码段称为**临界区（Critical Section）**。在 [1.2 节](#ch1-2)的示例中，共有三处访问共享变量：子 goroutine 递增变量、`if` 语句读取变量判断、以及 `fmt.Printf` 读取变量打印。

原书展示了如何用标准库 `"sync"` 的互斥锁 `sync.Mutex`（完整规则见[第 3 章](./chapter-03#ch3-3)）保护这些临界区：

```go
package main

import (
	"fmt"
	"sync"
)

func main() {
	var memoryAccess sync.Mutex
	var value int
	go func() {
		memoryAccess.Lock()
		value++
		memoryAccess.Unlock()
	}()

	memoryAccess.Lock()
	if value == 0 {
		fmt.Printf("the value is %v.\n", value)
	} else {
		fmt.Printf("the value is %v.\n", value)
	}
	memoryAccess.Unlock()
}
```

通过约定“凡是读写 `value` 都必须先调用 `memoryAccess.Lock()`，用完再调用 `Unlock()`”，我们把主 goroutine 中的判断与打印合并进了同一个受保护的临界区。现在，**数据竞争被消除了**——`if value == 0` 分支内绝不可能再诡异地打印出 `1`。

但请仔细思考原书紧接着提出的问题：**这段代码的竞态条件（Race Condition）消失了吗？**

**并没有！** 互斥锁只保证了两个临界区不会同时重叠执行，却**没有规定哪个临界区先拿到锁**。这次运行可能是子 goroutine 先抢到锁把 `value` 改成 `1`，主 goroutine 随后打印 `the value is 1.`；下次运行也可能是主 goroutine 先抢到锁看到 `0`，打印 `the value is 0.`。如果你的业务逻辑要求“必须等子任务算出结果后再读取”，光靠给读写两边各自套一把互斥锁，根本无法建立确定的先后顺序。

不仅如此，直接靠人工约定维护共享内存锁还会带来两重负担：

1. **契约脆弱性**：只要团队里有任何一个人在未来的修改中漏写了 `Lock()` 直接裸读 `value`，独占假设就会瞬间崩塌；
2. **粒度权衡困难**：临界区进出过于频繁会增加同步开销，而把临界区划得太大又会拖慢并发吞吐甚至引发后文将讨论的饥饿问题。

### 1.3.3 用 happens-before 建立确定的同步顺序 {#ch1-3-3}

要同时消除数据竞争与执行顺序的不确定性，需要依赖 [Go 内存模型](https://go.dev/ref/mem)定义的 **happens-before（先行发生）** 偏序关系。在同一 goroutine 内部，语句按程序顺序构成 happens-before；跨 goroutine 之间，则必须通过通道通信、`sync.Mutex`、`sync.WaitGroup` 或 `sync/atomic` 等同步事件建立 happens-before 边。只有当写入事件 $W$ happens-before 读取事件 $R$，且中间没有其他竞争写入时，$R$ 才被保证观察到 $W$ 写入的值。

例如，将前面的示例改为通过关闭通道显式发布计算结果：

```go
package main

import "fmt"

func main() {
	var value int
	done := make(chan struct{})
	go func() {
		value = 42
		close(done)
	}()
	<-done
	fmt.Println(value)
}
```

这段程序之所以保证一定打印 `42`，是由一条完整的 happens-before 链支撑的：

1. 在子 goroutine 内，`value = 42` 先于 `close(done)` 执行；
2. 根据 Go 内存模型，**关闭通道 happens-before 从该通道接收到因关闭而返回的零值**（即 `close(done)` 先于 `<-done` 返回）；
3. 在主 goroutine 内，`<-done` 返回先于 `fmt.Println(value)`。

根据偏序关系的传递性，`value = 42` 严格 happens-before `fmt.Println(value)`。同时要注意两条边界：第一，发布完成后子 goroutine 不能在 `close(done)` 之后继续偷偷修改 `value`，否则后续写入与主 goroutine 的读取将不再受该同步边保护；第二，`go` 语句本身只保证“启动语句先于新 goroutine 开始执行”，**goroutine 的退出不会自动产生任何通知调用方的同步事件**，必须借助通道或 `WaitGroup` 显式等待（即汇合）。

## 1.4 死锁、活锁与饥饿 {#ch1-4}

前面的数据竞争、原子性与同步解决的是**安全性（Safety，即“程序绝不会算出错误或损坏的状态”）**；哪怕安全性完全达标，并发程序还必须跨越另一道难关——**活性（Liveness，即“程序始终能够继续向前推进，最终完成有效工作”）**。死锁、活锁与饥饿是三类最典型的活性故障：

| 活性故障 | 核心特征 | 监控表象 | 根治方向 |
| --- | --- | --- | --- |
| **死锁（Deadlock）** | 多个并发单元互相等待对方释放资源或发送信号，无外力干预永不恢复 | 相关任务彻底卡死，CPU 占用跌至 0 | 消除循环等待（如统一加锁顺序）、明确通道收发与关闭配对 |
| **活锁（Livelock）** | 并发单元持续主动改变状态试图避让冲突，却因步调同步而无法前进 | CPU 占用居高不下，但有效业务吞吐为 0 | 引入随机退避（Jitter）、不对称角色或统一协调者 |
| **饥饿（Starvation）** | 个别贪婪任务长期霸占共享资源，导致其他任务迟迟拿不到执行所需的资源 | 整体有吞吐，但部分任务尾延迟极高或长期停滞 | 缩小临界区、避免持锁做慢操作、引入公平队列与并发配额 |

### 1.4.1 死锁与 Coffman 条件 {#ch1-4-1}

死锁是指并发进程彼此等待对方先迈出下一步，导致所有相关执行流永久停滞的状态。原书给出了一个经典的交叉加锁死锁示例：

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type value struct {
	mu    sync.Mutex
	value int
}

func main() {
	var wg sync.WaitGroup
	printSum := func(v1, v2 *value) {
		defer wg.Done()
		v1.mu.Lock()
		defer v1.mu.Unlock()

		time.Sleep(2 * time.Second) // 模拟持锁期间的耗时操作，放大交错窗口
		v2.mu.Lock()
		defer v2.mu.Unlock()

		fmt.Printf("sum=%v\n", v1.value+v2.value)
	}

	var a, b value
	wg.Add(2)
	go printSum(&a, &b)
	go printSum(&b, &a)
	wg.Wait()
}
```

运行这段代码，2 秒后程序会直接崩溃退出：

```text
fatal error: all goroutines are asleep - deadlock!
```

原因一目了然：第一个 `printSum(&a, &b)` 锁住了 `a`，休眠后试图去锁 `b`；与此同时，第二个 `printSum(&b, &a)` 已经锁住了 `b`，正试图去锁 `a`。顺带留意原书埋下的一个幽默细节：为了让示例简短，代码用 `time.Sleep(2 * time.Second)` 提高死锁复现率，但这本身其实是个竞态条件——如果第一个 goroutine 在第二个 goroutine 启动前就已经跑完并释放了 `a` 和 `b`，死锁甚至可能偶然不触发！

1971 年 Edgar Coffman 总结了资源死锁发生的四个必要条件（**Coffman 条件**）：

1. **互斥（Mutual Exclusion）**：并发任务在任意时刻对所请求资源拥有排他独占权（`a.mu` 和 `b.mu` 同一时刻只能被一个 goroutine 持有）。
2. **占有并等待（Hold and Wait）**：并发任务在已经持有一个资源的同时，等待获取额外的资源（持有 `a.mu` 的同时阻塞等待 `b.mu`）。
3. **不可抢占（No Preemption）**：已被占有的资源只能由持有它的任务主动释放，外界无法强行剥夺。
4. **循环等待（Circular Wait）**：存在一组并发任务 $P_1, P_2, \dots, P_n$，使得 $P_1$ 等待 $P_2$ 持有的资源，而 $P_2$ 又反过来等待 $P_1$ 持有的资源。

只要**破坏这四个条件中的任意一个**，就能在根源上防止死锁。工程中最常用的手段是破坏第 4 条“循环等待”：当需要同时获取多把锁时，规定所有代码路径都按固定的全局顺序加锁（例如始终先锁 ID 较小或地址较小的对象，使两边都先锁 `a` 再锁 `b`）。此外，尽量不要在持有互斥锁的临界区内调用外部未知回调函数、收发阻塞通道或发起网络 I/O，以免把隐蔽的外部等待关系带进锁依赖图中。

还要特别警惕：**Go 运行时的死锁检测器只能发现“整个进程中所有 goroutine 全部陷入休眠”的全局死锁**。在线上服务端程序里，只要还有一个后台心跳协程、HTTP 监听协程或定时器在正常运转，哪怕有几百个业务请求 goroutine 已经因为交叉锁或通道无人接收而永久卡死，运行时也**不会**报出 `deadlock!`，而是表现为悄无声息的 [goroutine 泄漏](./chapter-04#ch4-3)。

### 1.4.2 活锁：持续礼让却毫无进展 {#ch1-4-2}

原书用一个生动的日常场景解释**活锁（Livelock）**：你和迎面走来的人在狭窄的走廊里相遇，对方往左让一步想给你让路，你也恰巧同时往同一侧迈了一步；接着你们又同时往另一侧迈步——两个人都在不停地移动（消耗精力），却谁也走不过去。

原书编写了 `Alice` 和 `Barbara` 在走廊避让的代码：两人以完全相同的节拍（由 `sync.Cond` 每毫秒广播一次驱动）尝试调用 `tryLeft`；一旦借助原子计数 `atomic.AddInt32` 发现同一方向上有两个人，双方就同时退回（计数减 1），接着又在下一拍同时尝试 `tryRight`，如此周而复始，直到耗尽重试上限无奈放弃：

```text
Alice is trying to scoot: left right left right left right left right left right
Alice tosses her hands up in exasperation!
Barbara is trying to scoot: left right left right left right left right left right
Barbara tosses her hands up in exasperation!
```

活锁最常出现在“两个或多个并发任务试图在缺乏协调的情况下主动回退以避免死锁或冲突”的场景（例如无退避的乐观锁 CAS 自旋、两端同时检测到信道冲突后按固定间隔重发）。在生产环境中，活锁往往比死锁更具欺骗性：查看监控面板时，进程没有挂起，CPU 使用率甚至高达 100%，日志或指标还在不断跳动，容易让人误以为系统正在全速处理业务，实际上却在原地空转。打破对称性是消除活锁的关键：例如在冲突重试时引入**带随机抖动的指数退避（Exponential Backoff with Jitter）**，或者赋予各方不同的优先级（约定一方原地等待、另一方绕行）。

### 1.4.3 饥饿与锁粒度权衡 {#ch1-4-3}

**饥饿（Starvation）**是指一个或多个并发进程长期无法获得完成工作所需的资源。原书通过对比一个“贪婪工作者（`greedyWorker`）”和一个“平和工作者（`politeWorker`）”展示了不当的临界区粒度如何引发饥饿：

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

func main() {
	var wg sync.WaitGroup
	var sharedLock sync.Mutex
	const runtime = 1 * time.Second

	greedyWorker := func() {
		defer wg.Done()
		var count int
		for begin := time.Now(); time.Since(begin) <= runtime; {
			sharedLock.Lock()
			time.Sleep(3 * time.Nanosecond)
			sharedLock.Unlock()
			count++
		}
		fmt.Printf("Greedy worker was able to execute %v work loops\n", count)
	}

	politeWorker := func() {
		defer wg.Done()
		var count int
		for begin := time.Now(); time.Since(begin) <= runtime; {
			sharedLock.Lock()
			time.Sleep(1 * time.Nanosecond)
			sharedLock.Unlock()

			sharedLock.Lock()
			time.Sleep(1 * time.Nanosecond)
			sharedLock.Unlock()

			sharedLock.Lock()
			time.Sleep(1 * time.Nanosecond)
			sharedLock.Unlock()

			count++
		}
		fmt.Printf("Polite worker was able to execute %v work loops.\n", count)
	}

	wg.Add(2)
	go greedyWorker()
	go politeWorker()
	wg.Wait()
}
```

每轮循环中，两个工作者模拟的有效工作量都是 `3ns`，区别仅在于：`greedyWorker` 在整轮循环期间一口气独占持有 `sharedLock`，而 `politeWorker` 只在真正需要的三个 `1ns` 片段分别加锁并及时释放。在原书运行结果中，同样 1 秒内 `greedyWorker` 完成了 47 万余次循环，几乎是 `politeWorker`（28 万余次）的两倍！

这个对比揭示了内存访问同步中的经典权衡：

- **粗粒度同步**减少了反复加锁解锁的次数，但如果某个协程不必要地把非共享工作（如拼装参数、日志格式化、甚至网络 I/O）也包进锁内，就会长期霸占临界区，把只做短小访问的协程饿死；
- **细粒度同步**把锁严格限制在必须保护共享状态的最小语句块内，对其他并发协作者更友好，但过密的加锁解锁本身也会带来同步开销。

原书给出的调优原则非常实用：**编码时默认先将内存访问同步限制在最小的关键临界区内；只有当性能剖析（Profiling）证明频繁加解锁本身成了瓶颈时，才考虑调整锁范围或重构并发模型**。同时别忘了，饥饿不仅发生在互斥锁上，CPU、内存、文件句柄、数据库连接池乃至网络带宽等任何共享资源，都可能因为缺乏配额与公平调度而导致饥饿；而发现饥饿最直接的手段，就是像上例统计 `count` 那样，为各工作流记录完成速率与尾延迟指标。

## 1.5 确定并发安全与面对复杂性的简单性 {#ch1-5}

### 1.5.1 并发安全契约的四个问题 {#ch1-5-1}

原书指出，并发编程中最困难的部分归根结底在于“人”——当你在调用别人的函数或编写供团队复用的组件时，单看函数签名往往难以判断它的并发边界。例如原书给出的圆周率计算函数签名：

```go
// CalculatePi 计算 begin 到 end 之间的圆周率数字
func CalculatePi(begin, end int64, pi *Pi)
```

面对这个签名，调用者立刻会陷入一连串疑问：我是直接调一次就行，还是需要自己起多个 goroutine 分段调用它？传入的 `*Pi` 内部自己加了锁，还是需要我在外部用 `Mutex` 保护？

原书强调，设计或注释任何一个并发相关的函数、方法与类型时，都应当明确回答前三个核心问题，结合现代工程实践我们还应补上第四个关于生命周期的问题：

1. **谁负责并发？** 是由函数内部自己启动并管理 goroutine，还是它只是一个纯粹的同步函数、由调用方决定是否并发调用？
2. **问题空间如何映射到并发原语？** 如果改成 `func CalculatePi(begin, end int64) <-chan uint`，只读通道返回值就能在类型层面清晰传达“函数内部至少启动了一个生产 goroutine，调用方只需从通道消费结果”。
3. **谁负责同步？** 状态由谁拥有？哪些方法允许并发调用？返回的切片、映射或指针是否仍与组件内部共享底层存储？
4. **生命周期与资源边界如何收尾？** 每个阻塞点由什么事件唤醒？请求失败、超时取消或调用方提前退出时，后台 goroutine 如何确保退出？在途任务数与排队内存是否有上限？

### 1.5.2 Go 运行时分担了什么，留下了什么 {#ch1-5-2}

既然并发潜藏着如此多陷阱，为什么 Go 依然极力提倡用并发直接映射问题域？原书在章末总结了 Go 为开发者卸下的三座大山：

- **低延迟并发垃圾回收器（GC）**：自 Go 1.8 起，GC 停顿时间（STW）通常已降至百微秒乃至亚毫秒级。开发者无需在跨协程传递数据生命期时手动计算何时 `free` 内存，规避了并发环境下最容易出错的悬垂指针与双重释放问题。
- **自动管理 goroutine 到 OS 线程的复用**：传统语言中编写高并发网络服务，往往要先建固定线程池，再把成千上万个连接状态机手动切碎映射到线程上；而在 Go 中，直接为每个连接启动一个 `go handleConn(conn)` 即可，运行时调度器会自动在阻塞时挂起 goroutine 并将操作系统线程转交给其他就绪任务。
- **天然可组合的通道与 `select`**：让独立执行流之间的通信与同步可以像搭积木一样拼装。

但请始终保持清醒：**Go 的垃圾回收器不会自动回收一个永久阻塞在通道或锁上的 goroutine，调度器也不会替业务代码自动定义事务边界、取消协议或下游并发上限**。理解了第 1 章的正确性与活性基础后，[第 2 章](./chapter-02)将探讨如何运用 CSP 思想对并发代码建模。

## 练习 {#ch1-exercises}

以下三道练习分别检验“检查并修改”复合操作的原子性、基于 happens-before 的结果发布边界，以及死锁、活锁与饥饿的辨析与修复。建议先独立写出推理过程与修改方案，再展开参考答案核对；无需实际运行程序。

### 练习 1：给每个方法单独加锁能否防止库存超卖

某商品库存初始值为 `1`。类型 `Inventory` 内部持有一把 `sync.Mutex`，其 `Stock() int` 方法在加锁保护下返回当前库存，`Decrease()` 方法在加锁保护下将库存减 `1`。两个 goroutine 并发执行以下逻辑：

```go
if inv.Stock() > 0 {
	inv.Decrease()
}
```

请问：这段代码是否存在数据竞争？是否一定不会把库存扣成负数？请给出一种具体的交错执行顺序，并说明如何修改 `Inventory` 的接口设计以保证“库存非负”这一业务不变量。

<details>
<summary>查看参考答案</summary>

1. **没有数据竞争，但存在业务竞态条件（会超卖）**。因为每次读写内部字段都持有了同一把互斥锁，内存访问本身是同步的；但“检查库存大于 0”与“扣减库存”被拆成了两次独立的加锁调用，整个业务决策在并发上下文中不具备原子性。
2. **超卖交错顺序**：
   - Goroutine A 调用 `inv.Stock()`，加锁读到 `1` 后解锁；
   - Goroutine B 调用 `inv.Stock()`，加锁读到 `1` 后解锁；
   - Goroutine A 进入 `if` 分支调用 `inv.Decrease()`，将库存从 `1` 减为 `0`；
   - Goroutine B 随后也进入 `if` 分支调用 `inv.Decrease()`，将库存从 `0` 减为 `-1`，破坏了库存非负的不变量。
3. **修复方案**：将“检查”与“修改”收敛到同一个受同一把锁保护的临界区内，对外提供原子的复合方法：
   ```go
   func (inv *Inventory) TryDecrease() bool {
   	inv.mu.Lock()
   	defer inv.mu.Unlock()
   	if inv.stock <= 0 {
   		return false
   	}
   	inv.stock--
   	return true
   }
   ```
   判断并发组件是否安全的标准，是所有并发交错下业务不变量始终成立，而不是每个单独的 getter/setter 是否加了锁。

</details>

### 练习 2：发布信号之后继续修改共享变量

在 [1.3.3 节](#ch1-3-3)通过 `close(done)` 发布 `value` 的示例中，如果将子 goroutine 改为下面这样：

```go
go func() {
	value = 42
	close(done)
	value = 43
}()
<-done
fmt.Println(value)
```

请问：这段程序是否仍然无数据竞争？主 goroutine 打印的结果是否确定？如果想向主 goroutine 传递最终结果（或持续传递多次更新），应如何设计同步协议？

<details>
<summary>查看参考答案</summary>

1. **存在数据竞争，输出不再确定**。`close(done)` 只为它**之前**的 `value = 42` 建立了先于 `<-done` 的 happens-before 关系；`close(done)` **之后**的 `value = 43` 与主 goroutine 在 `<-done` 之后的 `fmt.Println(value)` 之间没有任何同步顺序约束，构成并发读写冲突。
2. **修复思路**：
   - 若只需发布一次最终值，应保证所有修改都在 `close(done)` 之前完成，且发布后不再触碰该共享变量；更地道的做法是直接定义值通道 `ch := make(chan int, 1)`，通过 `ch <- 43` 直接把值发给接收方。
   - 若业务需要持续发布多次状态更新，则不能复用一次性的 `close(done)` 充当后续写入的同步边，而应将每次更新作为消息依次发往 `chan int`，或用 `sync.Mutex` 保护所有读写访问。

</details>

### 练习 3：诊断并消除交叉加锁与饥饿隐患

阅读以下三个并发场景，分别判断它们属于**死锁**、**活锁**还是**饥饿**，并针对每个场景给出具体的代码或协议修复手段：

1. 转账函数 `Transfer(from, to *Account, amount int)` 先调用 `from.mu.Lock()`，再调用 `to.mu.Lock()`；线上偶发两个用户互相给对方转账时请求永久挂起，但服务进程并未崩溃报错。
2. 两个工作协程争抢两个硬件槽位：先用 `TryLock` 抢槽位 1，抢到后再用 `TryLock` 抢槽位 2；若槽位 2 被占用，则立即释放槽位 1 并马上重新发起下一轮争抢。压测时 CPU 飙到 100%，有效完成数却骤降为 0。
3. 后台报表协程每隔几秒锁住全局缓存表，在锁内逐条序列化上万条记录并写入磁盘文件；与此同时，前端查询协程读取同一缓存表的 P99 延迟从 0.1ms 恶化到数百毫秒。

<details>
<summary>查看参考答案</summary>

1. **场景 1 属于局部死锁（Deadlock）**。
   - **原因**：`Transfer(A, B)` 持有 `A.mu` 等 `B.mu`，`Transfer(B, A)` 持有 `B.mu` 等 `A.mu`，满足 Coffman 四个条件形成循环等待；因为服务进程中还有其他活跃 goroutine，运行时不会触发全局 `all goroutines are asleep - deadlock!` 崩溃。
   - **修复**：按账户唯一 `ID` 排序固定加锁顺序（如始终先锁 `ID` 较小的一方，再锁 `ID` 较大的一方；若 `from.ID == to.ID` 则直接返回），彻底破坏循环等待条件。
2. **场景 2 属于活锁（Livelock）**。
   - **原因**：两个协程分别抢占一个槽位后发现另一个槽位被占，同时释放并立即同步重试，陷入对称的“抢占—回退—再抢占”死循环。
   - **修复**：去掉自旋式的 `TryLock` 回退协议，直接按固定顺序（始终先锁槽位 1、再锁槽位 2）阻塞加锁；若业务确实需要非阻塞冲突重试，必须在回退后加入**随机抖动退避（Random Jitter Backoff）**以打破步调同步。
3. **场景 3 属于饥饿（Starvation）**。
   - **原因**：报表协程将耗时的序列化与磁盘文件 I/O 塞进了全局互斥锁的临界区，贪婪地长时间霸占锁，饿死了只需极短时间读取缓存的前端协程。
   - **修复**：缩小临界区粒度——报表协程在锁内仅快速拷贝所需数据的快照（或结合写时复制/分片锁），立即解锁后再在锁外慢慢执行序列化与磁盘写入。

</details>

## 面试题 {#ch1-interview}

以下三题聚焦并发基础概念与工具边界。作答时请先给出明确结论，再简述底层规则依据。

### 面试题 1：将 `GOMAXPROCS` 设为 1 能否省掉互斥锁或通道同步？

如果一个 Go 程序在启动时固定执行 `runtime.GOMAXPROCS(1)`（或者部署在单核机器上），多个 goroutine 并发读写同一个普通变量时，还会发生数据竞争吗？能否因此省掉互斥锁？

<details>
<summary>查看参考答案</summary>

**仍然会发生数据竞争，绝不能省掉同步措施。**

`GOMAXPROCS(1)` 只限制同一物理时刻最多有 1 个操作系统线程执行用户态 Go 代码（即限制并行度为 1），并不会改变程序的并发结构，也不建立任何 Go 内存模型认可的 happens-before 关系。首先，单条高级语言语句（如 `n++`、结构体赋值、映射写入）编译后可能对应多条机器指令，且自 Go 1.14 起运行时支持基于信号的异步抢占，goroutine 可以在非预期的指令边界被挂起切换；其次，编译器与 CPU 的指令重排及寄存器缓存优化只受同步原语约束，未同步的访问即使在单核上也可能破坏业务不变量。

</details>

### 面试题 2：“没有数据竞争”是否等价于“没有竞态条件”？

某段并发代码通过了严格的审查，确认对共享变量的每一次读写都加了同一把 `sync.Mutex`，且 `go test -race` 测试完全通过。能否据此断言这段代码不存在竞态条件（Race Condition）？

<details>
<summary>查看参考答案</summary>

**不能。消除数据竞争只是并发正确的必要条件，不是充分条件。**

数据竞争（Data Race）关注的是底层的单个内存位置是否存在未同步的并发冲突访问；而竞态条件（Race Condition）关注的是高层的业务结果是否依赖不受控的事件先后顺序。即使每次单独的内存读写都加了锁（如练习 1 中分别加锁的 `Stock()` 和 `Decrease()`，或 [1.3.2 节](#ch1-3-2)中各自加锁的 `value++` 与 `if value == 0`），只要一个完整的业务不变量被拆散在多个临界区之间，或者多个 goroutine 获得锁的先后顺序未经协调，程序依然会出现竞态条件。

</details>

### 面试题 3：`go test -race` 测试全绿能证明什么、不能证明什么？

在 CI 中开启 `go test -race ./...` 全部通过后，能否证明代码在生产环境中不会出现数据竞争或死锁？

<details>
<summary>查看参考答案</summary>

**不能。**

1. **受限于动态执行路径覆盖**：竞态检测器（Race Detector）是基于运行时插桩与 happens-before 追踪的动态分析工具，只能抓到**本次测试实际执行到的代码路径与实际触发的交错**中的数据竞争。测试未覆盖的分支（如罕见的超时、错误回滚路径）仍可能潜藏数据竞争。
2. **不负责业务竞态与活性问题**：对于每步都加了锁但临界区拆分错误的业务竞态条件（如 Check-Then-Act 超卖），`-race` 不会报错；对于死锁、活锁、饥饿以及永久阻塞导致的 goroutine 泄漏，`-race` 同样不负责检测，需要配合 `pprof`、`goroutineleak`、执行跟踪（`trace`）与协议审查共同保障。

</details>

## 参考资料

- [Go 内存模型（The Go Memory Model）](https://go.dev/ref/mem)
- [Go 数据竞争检测器（Data Race Detector）](https://go.dev/doc/articles/race_detector)
- [标准库 `sync` 包文档](https://pkg.go.dev/sync)
- [标准库 `runtime.GOMAXPROCS` 文档](https://pkg.go.dev/runtime#GOMAXPROCS)
- [Gene M. Amdahl：Validity of the Single Processor Approach to Achieving Large Scale Computing Capabilities（1967）](https://doi.org/10.1145/1465482.1465560)
- [E. G. Coffman 等：System Deadlocks（1971）](https://doi.org/10.1145/356586.356588)
