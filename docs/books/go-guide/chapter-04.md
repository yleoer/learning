---
title: 第 4 章 作用域与控制结构
description: 掌握词法代码块与变量隐藏规避方法，厘清 for、range、Go 1.22+ 循环变量、迭代器与分支跳转规则。
---

# 第 4 章 作用域与控制结构

## 本章要点

准确掌控函数控制流，核心在于看清两件事：**当前标识符绑定到哪一层词法声明**，以及**循环与分支在何时求值、向何处跳转**。Go 的词法块既由花括号显式围成，也隐式存在于控制语句头部与分支内，误用 `:=` 极易静默制造变量隐藏。本章依次梳理词法作用域、变量隐藏规避、`for` 与 `range` 的副本规则、Go 1.22+ 按轮独立循环变量与 Go 1.23+ 迭代器函数，以及 `if`、`switch`、标签和 `goto` 的跳转边界。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 4.1 词法代码块与作用域 {#ch4-1}

代码块（Block）是由声明与语句构成的词法区域，作用域（Scope）则是已声明标识符在源码中可被合法引用的编译期范围。名称解析始终从当前最内层块出发，沿词法嵌套逐层向外查找：

| 词法块层级 | 包含的典型标识符与可见范围 |
| --- | --- |
| 宇宙块（Universe Block） | `int`、`true`、`nil`、`len`、`any`、`error` 等全部预声明标识符 |
| 包块（Package Block） | 包级常量、类型、变量与函数，同包所有源文件共享且与声明先后无关 |
| 文件块（File Block） | 当前源文件通过 `import` 引入的包限定名 |
| 函数体块 | 函数形参、具名返回值及函数体顶层局部变量 |
| `if` / `for` / `switch` 隐式块 | 控制语句初始化子句声明的变量，覆盖条件与全部分支 |
| `switch` / `select` 子句块 | 每个 `case` 或 `default` 分支内部的独立局部声明 |
| 显式 `{ ... }` 块 | 成对花括号内部声明的局部变量 |

函数内部声明的局部变量，其作用域**从该条声明语句结束处才开始**，直至包裹它的最内层块结束。因此短声明右侧若出现同名标识符，读取的是外层旧变量：

```go
x := 10
{
	x := x + 1     // 右侧 x 绑定外层变量（10），本句结束后内层新变量 x（11）生效
	fmt.Println(x) // 11
}
fmt.Println(x) // 10
```

注意区分编译期作用域与运行期生命周期：作用域只决定源码可见范围，变量内存何时回收由编译期逃逸分析与垃圾回收器决定，详见 [18.1 节](./chapter-18#ch18-1)。

## 4.2 变量隐藏与规避方法 {#ch4-2}

内层块声明与外层同名的标识符时即发生**变量隐藏**（Variable Shadowing），又称“变量遮蔽”：内层读写全部落在新局部变量上，外层原变量既未销毁也未更新。

短变量声明 `:=` 只会在**当前这一层词法块**内复用已有变量；一旦跨进 `if`、`for` 或 `{ ... }` 内层块，左侧所有标识符都会变成全新局部变量。最隐蔽的线上事故是在分支内用 `:=` 接收多返回值：

```go
var client *Client
var err error
if useTLS {
	// 陷阱：err 虽与外层同名，但跨入 if 块写 := 会新建内层局部 client 与 err！
	// 正确做法：外层已声明好变量时，分支内直接用普通赋值 =
	client, err = newTLSClient()
}
```

若外层仅声明了 `err` 而内层还需新增变量 `val`，应先写 `var val string`，再用 `val, err = read()` 赋值。此外，若具名返回值在内层块被同名变量隐藏，且在内层执行无参数的裸 `return`，编译器会直接报错拦截。

由于导入包名与 `fmt`、`len`、`true`、`new`、`error` 等预声明标识符位于文件块和宇宙块而非语法关键字，把局部变量命名为 `fmt` 或 `len` 同样合法并会遮蔽原功能，编码时应严格规避。编译器与默认 `go vet` 不报告普通变量隐藏，专项排查可运行 `golang.org/x/tools/go/analysis/passes/shadow` 分析器。

## 4.3 for 循环与 range 遍历 {#ch4-3}

### 4.3.1 四种循环写法与 break / continue {#ch4-3-1}

Go 没有 `while` 与 `do/while`，所有循环统一由 `for` 的四种形态表达：三段式 `for`、单条件 `for`、无限 `for` 以及下一小节的 `for range`：

```go
for i := 0; i < 10; i++ { /* 固定起止与步长 */ }

for count < limit { /* 单一动态条件，等价于 while */ }

for {
	doStep()
	if done() { // 末尾判退即可表达“至少执行一轮”的 do/while
		break
	}
}
```

不带标签的 `break` 立即跳出最内层 `for`、`switch` 或 `select`；不带标签的 `continue` 跳过最内层 `for` 本轮剩余语句，但在三段式 `for` 中仍会照常执行后置语句 `i++`。涉及网络或轮询的无限循环务必绑定超时或取消退出条件，详见 [14.2 节](./chapter-14#ch14-2)。

### 4.3.2 range 遍历速查与值副本边界 {#ch4-3-2}

`for range` 按右侧数据源类型每轮产出 0～2 个值；不需要首值时用 `_` 忽略，不需要次值时直接省略：

| 数据源 | 第一个值 | 第二个值 | 关键求值与边界规则 |
| --- | --- | --- | --- |
| 数组、数组指针、切片 | 索引 `int` | 元素值副本 | `nil` 切片安全遍历 0 次 |
| 字符串 | 码点起始字节偏移 `int` | 解码后的 `rune` | 非法 UTF-8 字节产出 `U+FFFD` 并前进 1 字节 |
| 映射 | 键 | 值副本 | 顺序随机；`nil` 映射安全遍历 0 次 |
| 通道 | 接收到的元素 | 无 | 直至通道关闭退出；**`nil` 通道会永久阻塞** |
| 整数 `n`（Go 1.22+） | `0` 到 `n-1`（类型随 `n`） | 无 | `n <= 0` 时安全遍历 0 次 |
| 迭代器函数（Go 1.23+） | 传给 `yield` 的首值 | 传给 `yield` 的次值 | 循环 `break`/`return` 时 `yield` 返回 `false` |

`range` 右侧表达式在进入循环前**只求值一次**，循环内对同一切片 `append` 不会改变本轮已固定的遍历次数。语言规范仅有一处求值例外：遍历数组或数组指针且左侧至多取一个索引变量、右侧不含通道接收或非常量调用时，因长度编译期已知而不求值数组本身；因此对空指针 `var p *[3]int` 执行 `for i := range p` 可安全跑完 3 轮，而写成 `for i, v := range p` 会解引用 `nil` 触发 `panic`。

务必分清**入口数据源副本**与**每轮元素值副本**两层拷贝：

- **数据源层**：直接 `for i, v := range a` 遍历值数组 `a` 时，入口处会拷贝整块数组快照，途中修改原 `a[k]` 不影响后续轮次；遍历切片 `a[:]` 或数组指针 `&a` 只拷贝描述符或地址，途中修改未走到的底层元素会被后续轮次读到。
- **元素层**：第二个迭代变量 `v` 永远是当前元素的**值副本**，`v *= 2` 改不到原容器；原地修改或避免每轮复制大结构体时，应写 `for i := range s { s[i] = ... }`。

需要按确定顺序遍历映射时，在 Go 1.23+ 中可组合标准库 `"maps"` 与 `"slices"`：

```go
for _, k := range slices.Sorted(maps.Keys(counts)) {
	fmt.Println(k, counts[k])
}
```

### 4.3.3 迭代变量按轮创建（Go 1.22+）与迭代器（Go 1.23+） {#ch4-3-3}

**Go 1.22+ 循环变量按轮独立创建**：自 Go 1.22 语言版本起，凡在三段式 `for` 或 `for range` 头部用 `:=` 声明的迭代变量，**每一轮迭代都会创建独立的新变量实例**，彻底消除了早年对循环变量取址、闭包捕获或启动子协程全部指到末轮旧值的历史隐患：

```go
words := []string{"one", "two", "three"}
var ptrs []*string
for _, w := range words {
	ptrs = append(ptrs, &w) // Go 1.22+ 下每轮 w 地址独立，依次指向 "one" "two" "three"
}
```

作为本指南全书该机制的基准规则，须牢记两条边界：

1. **受 `go.mod` 的 `go` 指令控制**：即便本地安装了 Go 1.27 工具链，若模块 `go.mod` 声明为 `go 1.21` 或更低版本，编译器仍按旧的单变量复用语义编译，详见 [11.2.1 节](./chapter-11#ch11-2-1)。
2. **仅限循环头 `:=` 声明**：若在循环外声明 `var w string` 并在循环头写 `for _, w = range words`（普通赋值 `=`），所有轮次读写的仍是外层同一个变量；且按轮新建的 `w` 装的仍是元素副本，直接改 `w` 依然不会写回原切片。

**Go 1.23+ 迭代器函数（标准库 `"iter"`）**：支持对满足 `iter.Seq[V]` 或 `iter.Seq2[K, V]` 签名的函数执行 `for range`，其中 `iter.Seq[V]` 定义为 `func(yield func(V) bool)`。循环体被包装为 `yield` 回调传入：一旦调用方通过 `break` 或 `return` 提前退出，`yield` 立即返回 `false`；此时**迭代器必须停止并退出**，若忽略 `false` 再次调用 `yield` 会直接触发运行期 `panic`：

```go
func countUpTo(limit int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for i := 1; i <= limit; i++ {
			if !yield(i) {
				return // 收到 false 必须立即停止生产
			}
		}
	}
}
```

## 4.4 if、switch、标签与 goto {#ch4-4}

### 4.4.1 if 初始化子句与卫语句 {#ch4-4-1}

`if` 条件表达式必须为 `bool` 类型，支持前置分号初始化简单语句，所声明变量的作用域限于整条 `if / else if / else` 隐式块。下例调用标准库 `"math/rand/v2"`（Go 1.22+）：

```go
if n := rand.IntN(10); n == 0 {
	return ErrZero // 卫语句提前返回，后续主干免去冗余 else 缩进
} else if n > 5 {
	fmt.Println("high:", n)
}
```

当前置分支已通过 `return`、`break`、`continue` 或 `panic` 终止路径时，应直接省略 `else` 保持主干左对齐（卫语句）；多分支条件存在包含关系时，必须将范围更窄的具体条件排在前面。

### 4.4.2 表达式 switch 与无表达式 switch {#ch4-4-2}

表达式 `switch` 自上而下比对各 `case`（支持逗号并列多值），只执行首个命中分支并**自动退出，默认不向下贯穿**；省略待匹配表达式即无表达式 `switch`（等价于 `switch true`），适合替代长串 `if-else`：

```go
switch {
case n%6 == 0:
	fmt.Println("six")
case n%2 == 0, n%3 == 0:
	fmt.Println("two or three")
default:
	fmt.Println("other")
}
```

极少数需向下贯穿的场景须在分支末行写 `fallthrough`：它会**无条件跳过紧邻下一分支的条件检查**直接执行其语句体，且禁止出现在最后一个分支或接口类型分支 `type switch` 中，后者详见 [8.4 节](./chapter-08#ch8-4)。

### 4.4.3 外层循环标签与 goto 限制 {#ch4-4-3}

在 `for` 内嵌套 `switch`（或 `select`）时，分支内的无标签 `break` **仅跳出内层 `switch`**，外层循环仍会继续！需一步终止或跳入外层循环下一轮时，应给外层 `for` 标注标签：

```go
scanLoop:
for _, row := range matrix {
	switch row[0] {
	case -1:
		break scanLoop // 直接跳出外层 for，而非仅跳出 switch
	}
}
```

其中 `continue label` 的目标必须是包裹当前位置的 `for`，`break label` 则可指向包裹当前位置的 `for`、`switch` 或 `select`。

`goto label` 仅限当前函数内跳转，且受两条编译期铁律约束：**严禁从外层跳入任何内层块**，且**严禁向前跳过后续仍处于作用域内的变量声明**，从根本上杜绝读取未初始化变量。日常控制流应优先采用卫语句 `return`、`defer` 或带标签的 `break` / `continue`。

## 练习 {#ch4-exercises}

以下 3 道练习检验嵌套块变量隐藏修复、`range` 双层副本边界以及 `iter.Seq` 迭代器实现。除完整函数外，代码片段位于 `main` 函数内，`fmt`、`strconv`、`iter` 分别对应标准库 `"fmt"`、`"strconv"`、`"iter"`。建议先独立作答，再展开核对参考答案。

### 练习 1：定位并修复嵌套块中的 := 变量隐藏

函数 `parsePort` 期望在 `raw` 非空时解析端口号覆盖默认值 `8080`，否则直接返回 `8080`。指出 `parsePort("9090")` 的实际返回值与缺陷根因，并在不改变函数行为契约的前提下修复。

```go
func parsePort(raw string) (int, error) {
	port := 8080
	if raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil {
			return 0, err
		}
		_ = port
	}
	return port, nil
}
```

<details>
<summary>查看参考答案</summary>

原函数调用 `parsePort("9090")` 实际返回 `8080, nil`；若删去 `_ = port`，还会触发内层 `port` 未使用的编译错误。原因是 `if` 块内的 `port, err := strconv.Atoi(raw)` 跨层使用了 `:=`，新建了内层局部 `port` 隐藏外层 `port`，外层值始终停留在 `8080`。

先在内层声明新变量 `err`，再用普通赋值 `=` 更新外层 `port` 即可修复：

```go
func parsePort(raw string) (int, error) {
	port := 8080
	if raw != "" {
		var err error
		port, err = strconv.Atoi(raw)
		if err != nil {
			return 0, err
		}
	}
	return port, nil
}
```

</details>

### 练习 2：区分数组值数据源快照与切片元素副本

每次从初始数组 `[3]int{1, 2, 3}` 出发，将下方 `range` 右侧的数据源依次换成 `a`、`a[:]`、`&a`，分别写出三种情况下的全部输出并说明原因。

```go
a := [3]int{1, 2, 3}
for i, value := range a {
	if i == 0 {
		a[1] = 9
	}
	value *= 10
	fmt.Println(i, value)
}
fmt.Println(a)
```

<details>
<summary>查看参考答案</summary>

- 遍历值数组 `a` 时，依次输出 `0 10`、`1 20`、`2 30`、`[1 9 3]`：循环入口处同时取 `i, value` 会拷出整块 `[3]int` 快照，首轮修改原数组 `a[1] = 9` 不影响快照第 `1` 项。
- 遍历切片 `a[:]` 或数组指针 `&a` 时，均依次输出 `0 10`、`1 90`、`2 30`、`[1 9 3]`：入口仅复制切片描述符或指针，仍指向原数组 `a`，故第 `1` 轮读到刚修改的 `9`。
- 三种写法下 `value` 均为元素值副本，`value *= 10` 绝不会写回 `a`。

</details>

### 练习 3：编写响应提前 break 的 iter.Seq 迭代器

使用 Go 1.23+ 标准库 `"iter"` 编写 `evenUpTo(limit int) iter.Seq[int]`，按升序产出 `[2, limit]` 内的所有偶数。要求调用方在循环中 `break` 时立即停止后续计算，并说明若无视 `yield` 返回值继续调用会发生什么。

<details>
<summary>查看参考答案</summary>

```go
func evenUpTo(limit int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for n := 2; n <= limit; n += 2 {
			if !yield(n) {
				return
			}
		}
	}
}
```

当消费端 `for v := range evenUpTo(10)` 执行 `break` 或 `return` 时，`yield(n)` 返回 `false`，函数立即 `return` 终止后续生成；若迭代器忽略 `false` 强行再次调用 `yield`，运行时会立即触发 `panic: runtime error: range function continued iterating after function for loop body returned false`。

</details>

## 面试题 {#ch4-interview}

以下 3 道面试题聚焦 `for-switch` 跳转层级、`fallthrough` 执行规则与 `goto` 编译期安全限制。代码上下文同[练习部分](#ch4-exercises)。建议先独立作答，再展开核对参考答案。

### 面试题 1：`for` 循环内嵌套 `switch` 时，无标签 `break` 与 `continue` 分别作用于哪一层？

<details>
<summary>查看参考答案</summary>

`case` 分支内的无标签 `break` **只跳出内层 `switch`**，外层 `for` 循环会继续执行下一轮；而 `continue` 仅作用于循环，因此无标签 `continue` 会直接跳过外层 `for` 本轮剩余部分进入下一轮。若要从 `switch` 内直接终止外层循环，必须给 `for` 加标签并写 `break label`。

</details>

### 面试题 2：`fallthrough` 会检查下一分支的条件吗？以下代码的输出是什么？

```go
switch n := 1; {
case n < 2:
	fmt.Println("A")
	fallthrough
case n > 10:
	fmt.Println("B")
default:
	fmt.Println("C")
}
```

<details>
<summary>查看参考答案</summary>

不会检查条件，依次输出 `A`、`B`。哪怕 `n > 10` 为 `false`，`fallthrough` 也会无条件跳过紧邻下一分支的条件表达式，直接进入其语句体；`case n > 10` 末尾无 `fallthrough`，执行完即退出整个 `switch`。注意 `fallthrough` 必须是所在分支的最后一条语句，且不可用于最后一个分支或 `type switch`。

</details>

### 面试题 3：为什么 Go 的 `goto` 禁止跳过变量声明或跳入内层代码块？

<details>
<summary>查看参考答案</summary>

这是为了在编译期彻底保证内存与初始化安全：若允许向前跳过目标标签处仍在作用域内的变量声明，或从外层直接跳进内层块，程序就会绕过变量的初始化语句直接访问未初始化状态。语言规范直接在编译阶段拦截这两类跳转。

</details>

## 参考资料

- [Go 语言规范：代码块与作用域](https://go.dev/ref/spec#Declarations_and_scope)
- [Go 语言规范：`for` 语句、`range` 子句与迭代器](https://go.dev/ref/spec#For_statements)
- [Go 语言规范：`switch` 与 `fallthrough` 语句](https://go.dev/ref/spec#Switch_statements)
- [Go 语言规范：`break`、`continue` 与 `goto` 语句](https://go.dev/ref/spec#Break_statements)
- [Go 1.22 发布说明：每轮独立循环变量与整数 `range`](https://go.dev/doc/go1.22#language)
- [Go 1.23 发布说明：迭代器函数 `range`](https://go.dev/doc/go1.23#language)
- [Go 标准库 `iter`：通用迭代器签名](https://pkg.go.dev/iter)
