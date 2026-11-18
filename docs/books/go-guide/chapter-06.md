---
title: 第 6 章 指针与值传递
description: 理解 Go 的指针寻址规则与全类型按值传递模型，掌握切片与映射共享边界及值语义、指针语义取舍。
---

# 第 6 章 指针与值传递

## 本章要点

Go 只有“按值传递”一种传参规则，但不同类型的值内部既可能是完整数据本身，也可能是内存地址或底层容器描述符。本章从取地址、解引用、`nil` 与 `new(expr)`（Go 1.26+）出发，建立全类型传参复制内容与可见性总表，厘清指针形参重赋值与切片剩余容量跨函数 `append` 的高频陷阱，最后给出值语义与指针语义的工程决策标准。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 6.1 指针基础、可寻址性与 new {#ch6-1}

### 6.1.1 取地址、解引用与 nil 指针 {#ch6-1-1}

指针用于保存另一个变量的内存首地址。指向类型 `T` 的指针类型写作 `*T`，其宽度仅取决于目标平台字长：32 位架构占 4 字节，64 位架构占 8 字节。为保证内存安全，Go 禁止对普通指针做加减偏移运算；底层字节级寻址须显式使用标准库 `"unsafe"`，详见 [19.2 节](./chapter-19#ch19-2)。

阅读代码时需先分清 `*` 与 `&` 在三个语法位置的含义：

- **类型位置 `*int`**：如 `var p *int`，表示指向 `int` 的指针类型；
- **取地址运算 `&x`**：获取可寻址操作数 `x` 的内存地址，结果类型为 `*int`；
- **解引用运算 `*p`**：读写指针 `p` 所指向的目标变量。

```go
x := 10
p := &x
*p = 20
fmt.Println(x, *p) // 20 20（标准库 "fmt"）
```

所有指针类型的零值均为 `nil`，直接解引用 `nil` 指针会立即触发运行期 `panic`。若将值为 `nil` 的具体类型指针赋给 `error` 等接口变量，会产生判空为 `false` 的[有类型 `nil`](./chapter-08#ch8-3-1)，无错返回时应直接写字面量 `return nil`。

操作数的可寻址性边界如下：

- **允许直接 `&` 取址**：变量、指针解引用 `*p`、可寻址结构体的字段、数组元素，以及**切片下标表达式 `s[i]`**。
- **禁止直接 `&` 取址**：`const` 常量、基本类型字面量（如 `10`、`"ok"`）、普通函数调用返回值 `f()`，以及**映射下标表达式 `m[k]`**——因哈希表扩容会搬迁底层桶内存，语言规范禁止对其取址，详见 [3.5.2 节](./chapter-03#ch3-5-2)。

### 6.1.2 字面量取址与 new(expr)（Go 1.26+） {#ch6-1-2}

构造结构体、数组、切片或映射指针时，可直接对复合字面量取址 `&T{...}`。内置函数 `new` 则提供统一分配入口：传入类型 `new(T)` 分配零值初始化的 `T` 并返回 `*T`；自 **Go 1.26** 起，`new` 支持直接传入表达式 `new(expr)`，分配与表达式同类型、并以该表达式结果初始化的变量后返回其指针：

```go
type Person struct {
	Name       string
	MiddleName *string
}

pZero, pVal, pI32 := new(int), new(20), new(int32(20)) // Go 1.26+；不可写 new(nil)
pat := &Person{Name: "Pat", MiddleName: new("Perry")}  // Go 1.26+：直接构造可选字符串指针
fmt.Println(*pZero, *pVal, *pI32, *pat.MiddleName)     // 0 20 20 Perry
```

无类型常量传入 `new(expr)` 时会先按[默认类型规则](./chapter-02#ch2-3-1)转为具体类型，例如 `new(20)` 返回 `*int`。若维护 Go 1.25 及更早语言版本的模块，可用一行泛型辅助函数 `func ptr[T any](v T) *T { return &v }` 获取副本地址。

## 6.2 按值传递：全类型传参行为总表 {#ch6-2}

Go 语言的函数传参与返回值只有一条铁律：**所有类型一律按值传递**（Pass by Value）。调用函数时，实参的值总是被浅复制一份赋给形参，**在函数内直接对形参变量本身重赋值（`param = ...`），永远不会改变调用方手里的变量**。调用方能否观察到函数内部的数据修改，完全取决于被复制的值里是否带有共享底层存储的指针：

| 类型类别 | 按值传参复制的内容 | 函数内原地修改内容，调用方是否可见 | 函数内对形参重赋值或扩容，调用方是否可见 |
| --- | --- | --- | --- |
| 基本类型（`int`、`bool` 等） | 标量数值本身 | 不适用（无内部成员） | 不可见 |
| 字符串 `string` | 不可变描述符（`ptr`、`len`） | 不可原地修改字节 | 不可见 |
| 数组 `[N]T` | 整块全部元素（浅复制） | 不可见（含指针元素时除外） | 长度固定，重赋整个数组不可见 |
| 结构体 `struct` | 全部顶层字段（浅复制） | 纯值字段不可见；内部切片/映射/指针字段的目标修改可见 | 不可见 |
| 指针 `*T` | 内存地址（4 或 8 字节） | **可见**：`*p = v` 解引用改写共享目标 | 不可见：`p = &other` 只改局部指针指向 |
| 切片 `[]T` | 切片描述符（`ptr`、`len`、`cap`） | **可见**：`s[i] = v` 改写共享底层数组 | 新 `len`/`ptr` 不可见；`cap > len` 时未扩容 `append` 会改写共享尾部槽位 |
| 映射 `map[K]V` | 运行时哈希表句柄 | **可见**：非 `nil` 时增删改键值共享哈希表 | `m = make(...)` 不可见；传入 `nil` 映射直接写入会 `panic` |
| 通道 `chan T` / 接口 / 函数 | 通道句柄 / `(动态类型, 动态值)` / 闭包指针 | 通道收发与关闭、接口调用指针方法对共享状态可见 | 对形参变量重赋值不可见 |

### 6.2.1 指针形参重赋值与解引用修改 {#ch6-2-1}

把指针传给函数时，调用方与被调函数各自持有独立的指针变量，但存着相同的目标地址。解引用 `*p = 20` 会改写共同指向的内存；给形参重赋新地址 `p = &v` 则仅改写了局部指针副本：

```go
func failedUpdate(p *int) {
	v := 20
	p = &v // 仅改局部形参指向，不影响调用方
}

func update(p *int) { *p = 20 } // 解引用改写共享目标内存

func create() *int {
	v := 20
	return &v
}

x := 10
failedUpdate(&x)
update(&x)
fmt.Println(x, *create()) // 20 20
```

若调用方传入 `nil` 指针，在函数内写 `p = &v` 后外部变量依然是 `nil`。需要构造新对象交给调用方时，地道做法是像 `create()` 一样直接通过返回值传出指针；编译器会通过[逃逸分析](./chapter-18#ch18-1)自动管理局部变量生命周期，绝不会产生悬垂指针。

### 6.2.2 切片与映射传参的共享与扩容边界 {#ch6-2-2}

非 `nil` 映射传参复制哈希表句柄，函数内增删改键值对对调用方立即可见，但向 `nil` 映射写入会触发 `panic`，详见 [3.4 节](./chapter-03#ch3-4)。

切片传参复制 `ptr`、`len`、`cap` 三字段描述符，最隐蔽的陷阱发生在**传入切片尚有剩余容量（`cap > len`）时跨函数调用 `append`**：

```go
func appendFour(s []int) { s = append(s, 4) }

nums := append(make([]int, 0, 4), 1, 2, 3) // len=3, cap=4
appendFour(nums)
fmt.Println(nums, len(nums)) // [1 2 3] 3：调用方 len 仍为 3
fmt.Println(nums[:4])        // [1 2 3 4]：共享底层数组的第 4 个槽位已被改写！
```

一旦调用方随后执行 `nums = append(nums, 5)`，又会把刚才写入同一槽位的 `4` 静默覆盖。消除容量耦合只需坚守两条规范：

1. **增删切片元素的函数一律返回新切片**：写为 `func appendFour(s []int) []int`，由调用方执行 `nums = appendFour(nums)` 接回新描述符。
2. **下发只读视图时截断剩余容量**：传参处调用标准库 `"slices"` 的 `slices.Clip(nums)`（Go 1.21+）或 `nums[:len(nums):len(nums)]`，将 `cap` 压至等于 `len`，迫使被调函数一旦 `append` 就独立分配新数组。`slices.Clip` 不隔离 `s[0] = 99` 原地修改；若需隔离顶层容器元素，应传入浅拷贝 `slices.Clone(nums)` 或 `"maps"` 的 `maps.Clone(m)`（Go 1.21+）。流式 I/O 中复用读取切片缓冲区的模式见 [15.1.1 节](./chapter-15#ch15-1-1)。

## 6.3 值语义与指针语义的设计取舍 {#ch6-3}

### 6.3.1 何时传值、何时传指针 {#ch6-3-1}

“指针只占 8 字节，所以传指针一定比传值快”是常见误区：值切片 `[]T` 内存连续排布，对 CPU 缓存预取友好；滥用指针不仅引入跨调用链的可变共享状态，还可能促使对象逃逸到堆上并加重垃圾回收扫描负担，详见 [18.1 节](./chapter-18#ch18-1)与 [18.3 节](./chapter-18#ch18-3)。签名设计按以下对照表决策：

| 决策维度 | 优先选值类型 `T` | 选择指针类型 `*T` |
| --- | --- | --- |
| 核心意图 | 纯计算转换、构造新结果、不可变值对象 | 原地更新实例状态、跨组件共享连接池或服务句柄 |
| 并发与可维护性 | 副本天然隔离顶层纯值字段，无隐式远端修改 | 多方持有同一地址，需明确修改契约或加锁保护 |
| 不可复制字段限制 | 字段全部可安全复制时适用 | **含有标准库 `"sync"` 的 `Mutex`、`RWMutex`、`WaitGroup`、`Once` 等原语时必须传指针**，详见 [13.4 节](./chapter-13#ch13-4) |
| 性能与反射边界 | 中小型结构体优先传值，栈与寄存器传递极快 | 经[基准测试](./chapter-17#ch17-4-2)证实大结构体拷贝为瓶颈，或标准库 `"encoding/json"` 的 `json.Unmarshal(data, &v)` 等需反射填充目标容器的 API |
| 标准库代表 | `time.Time`、`net/netip.Addr` | `*os.File`、`*bytes.Buffer`、`*http.Client` |

包含同步原语的结构体首次使用后一旦按值拷贝就会复制锁的内部状态字，导致互斥失效或死锁。运行 `go vet ./...` 默认会启用 `copylocks` 检查器静态拦截锁拷贝；切勿单独运行 `go vet -copylocks ./...`，否则会关闭其余全部默认检查项。

### 6.3.2 用指针表达“未设置”三态配置 {#ch6-3-2}

当需要区分“未设置”“显式设为零值”与“设为非零值”三种状态时，可将边界字段声明为指针：

```go
type PatchOptions struct {
	Retries *int `json:"retries,omitempty"`
}

unset := PatchOptions{}
zeroRetries := PatchOptions{Retries: new(0)} // Go 1.26+：显式设置为 0 次
fmt.Println(unset.Retries == nil, *zeroRetries.Retries == 0) // true true
```

指针三态字段宜严格限制在系统边界的数据传输对象（DTO）上，例如解析 HTTP `PATCH` 局部更新请求；数据库可空列也可使用标准库 `"database/sql"` 的泛型 `sql.Null[T]`（Go 1.22+）。进入内部领域逻辑后，应尽早补齐默认值并转换为全值字段结构体，或改用 `(Config, bool)` 返回值表达存在性。

## 练习 {#ch6-exercises}

以下 2 道练习检验 `nil` 指针形参重赋值修复与切片剩余容量下的跨函数可见性判定。代码片段位于 `package main`，`fmt` 对应标准库 `"fmt"`。建议先独立推演或编写，再展开核对参考答案。

### 练习 1：修复 `nil` 指针形参赋值失效

写出下面程序的输出，解释为什么 `initPort` 内的赋值对 `main` 无效、为什么不能直接改成 `*p = 8080`，并用符合 Go 惯例的方式重构代码使 `main` 拿到指向 `8080` 的指针。

```go
func initPort(p *int) {
	v := 8080
	p = &v
}

func main() {
	var port *int
	initPort(port)
	fmt.Println(port == nil, port)
}
```

<details>
<summary>查看参考答案</summary>

原程序输出 `true <nil>`。`port` 按值传参复制了值为 `nil` 的局部形参 `p`：`p = &v` 只改了局部副本，`main` 中的 `port` 仍为 `nil`；同时因 `p` 为 `nil`，直接写 `*p = 8080` 会在运行期触发空指针解引用 `panic`。

地道重构是直接将新指针作为返回值传出，在 Go 1.26+ 中函数体也可简写为 `return new(8080)`：

```go
func defaultPort() *int {
	v := 8080
	return &v
}

func main() {
	port := defaultPort()
	fmt.Println(port == nil, *port) // false 8080
}
```

</details>

### 练习 2：综合判定切片剩余容量与映射传参可见性

阅读下面的程序，写出三行 `fmt.Println` 的准确输出，说明原因，并修改函数签名让调用方正式接回追加后的切片。

```go
func mutate(s []int, m map[string]int) {
	s[0] = 90
	s = append(s, 30)
	m["ok"] = 1
	fmt.Println("inside:", s, m["ok"])
}

func main() {
	s := append(make([]int, 0, 4), 10, 20)
	m := map[string]int{"ok": 0}
	mutate(s, m)
	fmt.Println("caller s:", s)
	fmt.Println("caller s[:3]:", s[:3], "map:", m["ok"])
}
```

<details>
<summary>查看参考答案</summary>

三行输出依次为：

```text
inside: [90 20 30] 1
caller s: [90 20]
caller s[:3]: [90 20 30] map: 1
```

`s[0] = 90` 改写共享底层数组，外部可见；传入 `s` 满足 `len=2, cap=4`，`append(s, 30)` 未触发扩容，直接将 `30` 写入共享底层数组下标 `2` 槽位，但新 `len=3` 只留在局部形参中，因此 `s` 打印 `[90 20]` 而 `s[:3]` 能看到 `30`；非 `nil` 映射共享哈希表句柄，`m["ok"] = 1` 外部可见。

正式接回新长度应返回新切片：`func mutateSlice(s []int) []int { s[0] = 90; return append(s, 30) }`，并在调用处写 `s = mutateSlice(s)`。

</details>

## 面试题 {#ch6-interview}

以下 3 道面试题检查取地址合法性、`slices.Clip` 的隔离范围及锁拷贝禁令，代码约定同[练习部分](#ch6-exercises)，另使用标准库 `"slices"` 与 `"sync"`。建议先独立作答，再展开核对参考答案。

### 面试题 1：哪些表达式不可直接用 `&` 取址，如何获取其副本指针？

判断下面 `p1`～`p5` 哪些能通过编译、哪些报错，并说明在 Go 1.26+ 中如何简洁获取报错项的值副本指针。

```go
x := 42
const limit = 42
s := []int{10}
m := map[string]int{"k": 10}

p1, p2, p3, p4, p5 := &x, &limit, &42, &s[0], &m["k"]
```

<details>
<summary>查看参考答案</summary>

**`p1`（`&x`）和 `p4`（`&s[0]`）编译通过；`p2`、`p3`、`p5` 编译失败。**

局部变量 `x` 与切片元素 `s[0]` 具备稳定的可寻址槽位；常量 `limit` 与字面量 `42` 无运行期存储位置，映射下标表达式 `m["k"]` 因扩容可能搬迁桶内存而禁止取址。通用写法是先赋给局部变量 `v` 再取 `&v`；在 **Go 1.26+** 模块中可直接写 `new(limit)`、`new(42)` 和 `new(m["k"])`。

</details>

### 面试题 2：传参时调用 `slices.Clip(s)` 隔离了什么，没隔离什么？

写出下面代码的输出结果并说明原因。

```go
func worker(s []int) {
	s[0] = 77
	s = append(s, 99)
}

buf := append(make([]int, 0, 4), 1, 2)
worker(slices.Clip(buf))
fmt.Println(buf, buf[:4])
```

<details>
<summary>查看参考答案</summary>

输出 `[77 2] [77 2 0 0]`。

`slices.Clip(buf)` 等价于 `buf[:len(buf):len(buf)]`，仅把传入描述符的 `cap` 压至 `2`，**并未复制底层数组**。因此 `s[0] = 77` 仍改在共享底层数组上；而 `append(s, 99)` 因传入 `len == cap == 2` 容量已满，被迫另开新数组，从而保护了原数组下标 `2`、`3` 的尾部槽位保持 `0`。若连已有元素也不允许修改，应传 `slices.Clone(buf)`。

</details>

### 面试题 3：包含 `sync.Mutex` 的结构体为何严禁按值传参？如何提前发现？

```go
type SafeCounter struct {
	mu sync.Mutex
	n  int
}

func snapshot(c SafeCounter) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}
```

<details>
<summary>查看参考答案</summary>

按值传参 `c SafeCounter` 会浅复制互斥锁当时的内部状态字与等待队列信息：一方面 `snapshot` 锁住的是局部副本锁，无法与外部并发写操作互斥，引发数据竞态；另一方面若拷贝瞬间原锁处于已锁定状态，副本锁一进来就是锁定态，调 `c.mu.Lock()` 会当场永久死锁。

修复方法是将参数与方法接收者统一改为 `*SafeCounter`。执行 `go vet ./...` 可通过默认启用的 `copylocks` 分析器静态拦截此类错误。

</details>

## 参考资料

- [Go 语言规范：指针类型与取地址运算符](https://go.dev/ref/spec#Address_operators)
- [Go 语言规范：内置分配函数 `new`](https://go.dev/ref/spec#Allocation)
- [Go 语言规范：完整切片表达式](https://go.dev/ref/spec#Slice_expressions)
- [Go 标准库 `slices.Clip` 与 `slices.Clone`](https://pkg.go.dev/slices#Clip)
- [Go 标准库 `sync.Mutex` 不可复制约定](https://pkg.go.dev/sync#Mutex)
- [`go vet` 分析器：`copylocks`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/copylocks)
- [Go 标准库 `database/sql`：`Null[T]`](https://pkg.go.dev/database/sql#Null)
