---
title: 第 4 章 代码块、变量隐藏和控制结构
description: 理解 Go 的词法作用域与变量隐藏，并正确选择 if、for、switch、标签和 goto。
---

# 第 4 章 代码块、变量隐藏和控制结构

## 本章要点

本章围绕标识符的词法作用域解析与控制流转移规则展开，系统阐述代码块层级、变量隐藏（Variable Shadowing）机制，以及 `if`、`for`、`switch`、标签和 `goto` 的执行语义。核心目标是准确追踪嵌套作用域内的标识符绑定，识别并规避意外隐藏，依据数据特征与退出条件选择循环及分支形式，并掌握 Go 1.22+ 整数 `range`、逐次迭代变量语义与 Go 1.23+ 迭代器函数的核心规则。

> 核对日期：2026 年 10 月 20 日；核对环境为 Go 1.27.2、Windows/AMD64。

## 4.1 代码块与作用域 {#ch4-1}

代码块（Block）是由声明和语句构成的词法区域，作用域（Scope）则是已声明标识符在源码中可被合法引用的编译期范围。内层代码块可访问外层代码块中处于作用域内的标识符；若内层重新声明同名标识符，名字解析将优先绑定至最内层声明。

除另有说明外，正文代码片段均位于 `main` 函数内，省略 `package main` 和导入声明；`fmt` 对应标准库导入路径 `"fmt"`，其余标准库包在首次出现处说明。

Go 包含由花括号显式界定的代码块与由语法规则隐式构成的块：

| 代码块 | 包含的典型标识符或语句 |
| --- | --- |
| 宇宙块（universe block） | `int`、`true`、`nil`、`len` 等全部预声明标识符 |
| 包块（package block） | 包级变量、常量、类型和函数；同包内所有源文件共享 |
| 文件块（file block） | 当前源文件通过 `import` 导入的包名 |
| 函数体块 | 函数形参、具名返回值参数及函数体内的局部声明 |
| `if`、`for`、`switch` 隐式块 | 控制结构初始化语句声明的标识符及该控制结构自身 |
| `switch`、类型 `switch`、`select` 子句块 | 每个 `case` 或 `default` 分支内的局部声明 |
| 任意 `{ ... }` 显式块 | 花括号内部的局部声明 |

包级标识符的作用域覆盖整个包的所有源文件，而导入的包名仅在包含对应 `import` 声明的源文件块内可见。函数形参与具名返回值的作用域覆盖整个函数体。函数内部声明的局部变量，其作用域自该声明语句结束处起始，至包含它的最内层块结束处终止；因此，局部变量自身的初始化表达式无法引用尚未进入作用域的新变量。

```go
x := 10
{
	// 右侧 x 解析为外层变量；新变量 x 的作用域自本条声明结束后起始
	x := x + 1
	fmt.Println(x) // 11
}
fmt.Println(x) // 10
```

作用域属于编译期词法规则，不等同于变量在运行时的内存生命周期。判定标识符绑定对象时，应自当前最内层代码块起沿词法嵌套向外逐层查找，而非依据声明在源码中的行距判断。

## 4.2 变量隐藏 {#ch4-2}

当内层代码块声明的标识符与外层已声明标识符同名时，即发生变量隐藏（Variable Shadowing，又称变量遮蔽）：内层标识符在其作用域内遮蔽外层同名标识符。外层变量本身未被销毁或修改，仅在内层声明的作用域内无法直接通过该名称访问。

```go
x := 10
if x > 5 {
	fmt.Println(x) // 外层 x：10
	x := 5
	fmt.Println(x) // 内层 x：5
}
fmt.Println(x) // 外层 x：10
```

短变量声明 `:=` 仅在当前词法块内查找可复用的同名变量（当处于函数体最外层时，包含函数形参与具名返回值），不会跨越块边界复用外层变量。在同一词法块内，`:=` 可对已声明变量执行重声明（实为赋值），但要求左侧至少包含一个新的非空白变量，且被重声明变量的类型必须保持一致：

```go
x := 10
x, y := 20, 30 // 与上一行同属一个块：更新 x 的值，并声明新变量 y
fmt.Println(x, y) // 20 30

if x > 0 {
	x, z := 40, 50 // 位于 if 分支显式块内：x 与 z 均为新声明的局部变量
	fmt.Println(x, z) // 40 50
}
fmt.Println(x) // 20
```

在嵌套块中接收多返回值时极易引发意外隐藏。例如外层（或具名返回值）已声明 `err`，内层块执行 `value, err := read()` 会声明全新的局部 `err`，导致外层 `err` 未被更新（若外层为具名返回值，在内层执行无参数 `return` 还会触发编译错误）。若需更新外层变量，应预先声明新变量并改用普通赋值语句 `=`：

```go
var value string
value, err = read()
```

由于导入包名与宇宙块中的预声明标识符并非语言关键字，它们同样会被内层同名声明隐藏：

```go
fmt := "output"
fmt.Println("hello") // 编译失败：fmt 已被隐藏为 string 变量，不再表示包名
```

同理，将局部变量命名为 `len`、`true` 或 `error` 虽符合语法，但会导致对应预声明标识符在当前作用域内失效。工程上应避免覆盖预声明标识符与包名，仅在确需隔离局部状态时使用同名变量。Go 编译器与 `go vet` 默认内置分析器均不将合法的变量隐藏报错；若需开展专项静态检查，可独立安装 `golang.org/x/tools/go/analysis/passes/shadow` 工具并通过 `go vet -vettool` 调用。

## 4.3 `if` 语句 {#ch4-3}

`if` 语句的条件表达式求值结果必须为 `bool` 类型；条件外围无需添加圆括号，但分支执行体必须使用花括号包裹。多分支结构按源码顺序依次求值，仅执行首个条件为 `true` 的分支：

```go
if n == 0 {
	fmt.Println("too low")
} else if n > 5 {
	fmt.Println("too high")
} else {
	fmt.Println("accepted")
}
```

条件表达式前可前置一条简单语句（以分号分隔）。该初始化语句声明的变量处于整个 `if` 结构的隐式块内，在条件表达式、`if` 主体及后续所有 `else if`、`else` 分支中均可访问，脱离整条 `if` 语句后即超出作用域。

以下示例调用 Go 1.22 引入的标准库 `"math/rand/v2"` 中的 `rand.IntN`（旧版 `"math/rand"` 对应函数名为 `rand.Intn`）：

```go
if n := rand.IntN(10); n == 0 {
	fmt.Println("too low")
} else if n > 5 {
	fmt.Println("too high:", n)
} else {
	fmt.Println("accepted:", n)
}
// fmt.Println(n) // 编译失败：n 已超出 if 隐式块作用域
```

前置初始化语句适用于收敛仅服务于当前条件判定的临时变量（如执行函数调用并立即校验返回的 `err`）。虽然初始化语句亦可对外层变量赋值，但应避免在条件头部夹带改变外层状态的副作用；若变量在 `if` 语句结束后仍需使用，应在外部显式声明并赋值。此外，当 `if` 分支以 `return`、`break`、`continue` 或 `panic` 终止控制流时，工程惯例省略后续 `else` 块，保持主干逻辑左对齐。

当多个分支条件存在交集时，必须按条件严苛程度或业务优先级从高到低排列。例如判定整除关系时，“同时被 2 和 3 整除”必须置于“被 2 整除”或“被 3 整除”之前，否则宽泛条件将先行命中并短路后续细分分支。

## 4.4 `for` 语句 {#ch4-4}

`for` 是 Go 唯一的循环控制关键字，包含经典三段式子句、单条件子句、无限循环以及 `range` 遍历子句四种语法形态。

### 4.4.1 三种基本写法 {#ch4-4-1}

完整的三段式 `for` 子句由初始化语句、条件表达式和后置语句构成。初始化语句仅在循环开始前执行一次；每次迭代前求值条件表达式；循环体正常执行完毕后执行后置语句，再进入下一轮条件判定：

```go
for i := 0; i < 10; i++ {
	fmt.Println(i)
}
```

省略初始化与后置语句、仅保留条件表达式时，等价于其他语言中的 `while` 循环：

```go
i := 1
for i < 100 {
	fmt.Println(i)
	i *= 2
}
```

同时省略三部分即构成无限循环，需依赖循环体内的 `break`、`return` 等语句显式终止：

```go
for {
	value := next()
	if value == stopValue {
		break
	}
	process(value)
}
```

Go 未提供 `do/while` 语法。若需保证循环体至少执行一次，可使用无限循环并在末尾判定退出条件：

```go
for {
	doWork()
	if !condition() {
		break
	}
}
```

### 4.4.2 `break` 与 `continue` {#ch4-4-2}

无标签的 `break` 立即终止最内层的 `for`、`switch` 或 `select` 语句。无标签的 `continue` 跳过最内层 `for` 循环体的剩余语句；在三段式 `for` 循环中，`continue` 会先触发后置语句执行，随后进行下一轮条件判定。

工程上常利用 `continue` 提前过滤无效元素，以减少循环体内的条件嵌套层级：

```go
for _, value := range values {
	if value < 0 {
		continue
	}
	process(value)
}
```

循环退出条件应清晰明确。涉及外部 I/O 或状态轮询的无限循环，应结合超时控制、上下文取消或最大重试次数限制，防范因外部故障导致的死循环。

### 4.4.3 `range` 可以遍历什么 {#ch4-4-3}

`range` 子句根据数据源类型产出零个、一个或两个迭代值。当前 Go 支持的数据源及规则如下；整数数据源从 Go 1.22 起支持，迭代器函数数据源从 Go 1.23 起支持：

| 数据源 | 第一个值 | 第二个值 | 核心规则 |
| --- | --- | --- | --- |
| 数组、数组指针、切片 | 索引 `int` | 元素值的副本 | `nil` 切片迭代 0 次 |
| 字符串 | UTF-8 字节起始偏移量 `int` | 解码后的 `rune` | 非法 UTF-8 字节产出 `U+FFFD` 并前进 1 字节 |
| 映射 | 键 | 值的副本 | 遍历顺序未指定；`nil` 映射迭代 0 次 |
| 通道 | 接收到的元素 | 无 | 持续接收直至通道关闭；`nil` 通道永久阻塞 |
| 整数 | 从 `0` 递增的整数 | 无 | Go 1.22+ 支持；非正数（`<= 0`）迭代 0 次 |
| 特定签名的迭代器函数 | 传给 `yield` 的首个值 | 传给 `yield` 的第二值 | Go 1.23+ 支持 |

`range` 右侧表达式默认在循环开始前仅求值一次。唯一的规范例外是：当 `range` 左侧至多接收一个迭代变量，且右侧为数组或数组指针、其长度 `len` 在编译期即为常量（且不含函数调用等非常量表达式）时，右侧表达式本身不会被求值（例如对值为 `nil` 的数组指针 `var p *[3]int` 执行 `for i := range p` 可正常迭代 3 次，而 `for i, v := range p` 会解引用并触发运行时 `panic`）。对切片执行 `range` 时，循环次数由循环起始时求值得到的切片长度决定；迭代期间对原切片变量重新赋值或追加元素，均不会改变本轮循环的迭代次数，但通过底层数组修改尚未遍历到的元素仍可被后续迭代观察到。

遍历数组、切片和映射时，若无需首个返回值可用空白标识符 `_` 忽略，无需第二个返回值则直接省略：

```go
for index, value := range values {
	fmt.Println(index, value)
}

for _, value := range values {
	fmt.Println(value)
}

for key := range counts {
	fmt.Println(key)
}
```

整数 `range`（Go 1.22+）支持直接表达固定次数的迭代：

```go
for i := range 5 {
	fmt.Println(i) // 依次输出 0、1、2、3、4
}
```

通过 `:=` 声明整数 `range` 的迭代变量时，变量类型与右侧表达式一致：若 `n` 为 `int8`，则 `for i := range n` 中 `i` 的类型亦为 `int8`；若右侧为无类型整数常量（如 `5`），则推导为默认类型 `int`。

迭代器函数（Go 1.23+）签名须符合 `func(yield func() bool)`、`func(yield func(V) bool)` 或 `func(yield func(K, V) bool)`。`range` 语句将编译器合成的 `yield` 回调传入迭代器，迭代器每次调用 `yield` 即向循环体产出一组值；当循环体通过 `break` 或 `return` 提前终止时，`yield` 返回 `false`，此时迭代器必须立即停止产出并返回（若持有底层资源应配合 `defer` 释放），继续调用 `yield` 将触发运行时 `panic`。标准库 `iter` 包（导入路径 `"iter"`）定义了通用的 `Seq` 与 `Seq2` 泛型类型，后续将在函数与泛型章节深入展开。

调用方直接使用 `range` 即可消费迭代器函数产出的序列。展开下方示例可查看完整实现与提前终止行为：

<details>
<summary>查看迭代器示例</summary>

`countUpTo` 返回符合 `func(yield func(int) bool)` 签名的迭代器函数。下面是可直接运行的完整示例（需要导入标准库 `"fmt"`）。每次调用 `yield(i)` 将当前值传递给循环体；当循环体在 `value == 3` 处执行 `break` 时，`yield` 返回 `false`，迭代器立即退出：

```go
package main

import "fmt"

func countUpTo(limit int) func(func(int) bool) {
	return func(yield func(int) bool) {
		for i := 1; i <= limit; i++ {
			if !yield(i) {
				return
			}
		}
	}
}


func main() {
	for value := range countUpTo(5) {
		fmt.Println(value)
		if value == 3 {
			break
		}
	}
}
```

输出结果：

```text
1
2
3
```

因循环在 `3` 处执行 `break`，后续的 `4` 和 `5` 不再生成。若需产出键值对，可将内部签名改为 `func(yield func(K, V) bool)` 并在调用 `yield` 时传入两个参数。

</details>

### 4.4.4 索引、值副本与遍历中的修改 {#ch4-4-4}

对字符串执行 `range` 时，首个返回值为当前字符的 UTF-8 起始字节偏移量，第二个返回值为解码后的 `rune` 代码点，索引值并非连续递增的字符序号：

```go
for i, r := range "Aπ!" {
	fmt.Println(i, r, string(r))
}
```

由于 `"π"` 的 UTF-8 编码占 2 个字节，上述输出的字节索引依次为 `0`、`1`、`3`。

对数组、切片或映射执行 `range` 时，第二个迭代变量接收的是当前元素的**值副本**。直接修改该迭代变量不会写回原容器：

```go
numbers := []int{2, 4, 6}
for _, value := range numbers {
	value *= 2
}
fmt.Println(numbers) // [2 4 6]
```

需注意区分“数据源求值副本”与“迭代元素副本”两层机制：当 `range` 直接遍历数组并接收元素值时，循环开始前会复制整个数组，迭代期间修改原数组不会影响后续产出的迭代值；而遍历数组指针或切片时，求值复制的仅是指针或切片描述符，底层数组仍共享，因此迭代期间修改尚未遍历到的底层元素会被后续迭代读取到。无论数据源是否共享底层存储，赋给第二个迭代变量的元素始终是独立副本（若切片元素为大结构体，仅使用单变量索引遍历 `for i := range s` 可避免每次迭代的元素值拷贝开销）。

若容器元素本身为指针，迭代变量复制的是指针地址，仍指向同一目标对象。修改指针所指对象的字段会反映至原容器，但将迭代变量自身置为 `nil` 或指向其他地址，不会改变原容器内存储的指针：

```go
type Item struct {
	Name string
}

items := []*Item{{Name: "old"}}
for _, item := range items {
	item.Name = "new" // 解引用修改目标对象字段，修改生效
	item = nil        // 仅修改迭代变量持有的指针副本
}
fmt.Println(items[0].Name, items[0] == nil) // new false
```

若需原地修改切片或数组元素，应通过索引下标直接写入：

```go
for i := range numbers {
	numbers[i] *= 2
}
```

映射的 `range` 遍历顺序未由语言规范指定，业务逻辑不能依赖某个观察到的顺序。遍历期间若删除尚未访问到的键，该键在后续迭代中不再产出；若插入新键，则该键在本次遍历中可能产出也可能被跳过。若需按确定性顺序遍历映射，Go 1.23+ 可组合标准库 `"maps"` 与 `"slices"` 的 `maps.Keys` 和 `slices.Sorted`：

```go
for _, key := range slices.Sorted(maps.Keys(counts)) {
	fmt.Println(key, counts[key])
}
```

`slices.Sorted` 适用于整数、浮点数与字符串等满足有序约束的键类型；自定义排序规则可使用 `slices.SortedFunc`。

### 4.4.5 每次迭代的变量 {#ch4-4-5}

自 Go 1.22 语言版本起，当 `for` 或 `range` 循环头部使用 `:=` 声明迭代变量时，每次迭代均会创建独立的变量实例。这一语义消除了闭包捕获或取地址跨迭代保存时意外共享同一循环变量的经典缺陷：

```go
words := []string{"one", "two", "three"}
var pointers []*string
for _, word := range words {
	pointers = append(pointers, &word)
}

for _, pointer := range pointers {
	fmt.Println(*pointer) // 依次输出 one、two、three
}
```

通过调整模块 `go.mod` 中的 `go` 语言版本指令（如分别设为 `1.21` 与 `1.22`），可在同一工具链下验证闭包捕获循环变量的语义差异。下面是需要导入标准库 `"fmt"` 的完整程序片段：

<details>
<summary>查看 Go 1.22 前后的闭包示例</summary>

```go
package main

import "fmt"

func makeReaders(words []string) []func() string {
	var readers []func() string
	for _, word := range words {
		readers = append(readers, func() string { return word })
	}
	return readers
}

func main() {
	for _, read := range makeReaders([]string{"one", "two", "three"}) {
		fmt.Println(read())
	}
}
```

当模块语言版本为 Go 1.21 或更早时，整个循环复用单一变量实例，三个闭包最终均读取末次迭代写入的值：

```text
three
three
three
```

当模块语言版本为 Go 1.22 或更新时，`:=` 声明的循环变量按次迭代隔离，各闭包分别绑定当次迭代的变量实例：

```text
one
two
three
```

</details>

该语义由包所属模块 `go.mod` 中的 `go` 版本指令控制，而非仅取决于本地安装的编译器版本。声明为 `go 1.21` 及以下版本的模块仍保持单变量复用语义。

注意：若循环变量在循环外部预先声明，而在循环头部使用 `=` 赋值，则所有迭代依然读写同一个外部变量：

```go
var word string
for _, word = range words {
	fmt.Println(word)
}
```

此外，逐次迭代创建新变量并不改变 [4.4.4 节](#ch4-4-4)的元素值复制规则：每次迭代的新变量持有的仍是容器元素的副本，直接对其赋值不会修改原容器。

### 4.4.6 标签控制外层循环 {#ch4-4-6}

无标签的 `break` 与 `continue` 仅作用于最内层控制结构。在多层嵌套循环中，若需从内层直接跳出或继续外层循环，可为外层 `for` 语句声明标签（Label）：

```go
outer:
for _, row := range rows {
	for _, value := range row {
		if value < 0 {
			continue outer
		}
		fmt.Println(value)
	}
}
```

`continue label` 的目标标签必须绑定在包裹当前语句的某层 `for` 循环上；`break label` 的目标标签则可绑定在包裹当前语句的 `for`、`switch` 或 `select` 结构上。标签拥有独立的命名空间，仅在简化多层控制流的效果明显优于抽取辅助函数时使用，且命名应准确表意。

### 4.4.7 选择循环形式 {#ch4-4-7}

- **全量遍历**：遍历数组、切片、字符串、映射、通道或迭代器时，优先采用 `range`。
- **精细步进控制**：需自定义起始索引、边界条件、步长或逆序遍历时，采用三段式 `for` 子句。
- **单条件驱动**：仅依赖动态布尔条件决定是否继续执行时，采用单条件 `for`。
- **先执行后判定**：需至少执行一次循环体再检查退出条件时，采用含显式 `break` 的无限 `for`。
- **字符串遍历区分**：按 Unicode 代码点处理字符串必须使用 `for range`；三段式 `for i := 0; i < len(s); i++` 仅适用于明确的按字节遍历场景。

## 4.5 `switch` 语句 {#ch4-5}

表达式 `switch` 依次执行可选的初始化语句、求值 `switch` 表达式，并按源码自上而下的顺序比对各 `case` 分支，仅执行首个匹配的分支。省略 `switch` 表达式时默认等价于求值布尔常量 `true`（即无表达式 `switch`）。每个 `switch` 至多包含一个 `default` 分支，无论其书写位置如何，仅在所有 `case` 均未命中时执行。

```go
switch size := len(word); size { // size 为字符串的字节长度
case 1, 2, 3, 4:
	fmt.Println("short")
case 5:
	fmt.Println("right")
default:
	fmt.Println("long")
}
```

单个 `case` 可使用逗号罗列多个候选表达式（逻辑或关系）。`switch` 表达式与各 `case` 表达式必须支持相等比较（`==`），因此切片、映射和函数不可直接作为比较目标；当多个 `case` 出现重复的常量值时，编译器将直接报错。初始化语句声明的变量在整个 `switch` 隐式块内可见，而每个 `case` 与 `default` 子句各自构成独立的隐式子块，不同分支内可声明同名局部变量。

Go 的 `switch` 分支默认在执行完毕后自动退出，无需显式书写 `break`；空 `case` 分支合法且构成独立的空操作，不会向下一分支贯穿。若确需无条件贯穿至紧邻的下一分支，须在当前分支末尾显式添加 `fallthrough` 语句：`fallthrough` 会跳过下一分支的条件判定直接执行其语句块，且不可用于最后一个分支或类型 `switch` 中。工程实践中通常优先合并 `case` 列表或提取公共函数，避免依赖 `fallthrough`。

当 `switch` 嵌套于循环内部时，`case` 分支内的无标签 `break` 仅终止当前 `switch` 语句，外层循环将继续执行。若需从 `case` 内部直接终止外层循环，必须为外层循环添加标签并调用 `break label`：

```go
loop:
for i := 0; i < 10; i++ {
	switch i {
	case 7:
		break loop
	}
}
```

### 4.5.1 无表达式 `switch` {#ch4-5-1}

无表达式 `switch` 等价于 `switch true`，各 `case` 分支可书写任意返回 `bool` 的独立条件表达式：

```go
switch {
case n%6 == 0:
	fmt.Println("Six!")
case n%2 == 0:
	fmt.Println("Two!")
case n%3 == 0:
	fmt.Println("Three!")
default:
	fmt.Println("Never mind")
}
```

由于仅首个求值为 `true` 的分支会被执行，存在包含关系的条件（如 `n%6 == 0` 与 `n%2 == 0`）必须将更具体的条件置于上方。无表达式 `switch` 适用于组织一组逻辑相关且优先级明确的分类判定规则。

### 4.5.2 在 `if` 和 `switch` 之间选择 {#ch4-5-2}

当分支数量仅有一两个、使用卫语句提前返回，或后续条件依赖前置分支的计算结果时，`if` 语句更为直接。当针对同一变量枚举多个离散值，或围绕同一业务决策划分多组分类条件时，使用 `switch` 结构更清晰。切勿为压缩代码行数而将正交、无关的判定条件强行聚合至同一无表达式 `switch` 中。用于判定接口动态类型的类型 `switch`（Type Switch）将在接口章节详述。

## 4.6 `goto` 语句 {#ch4-6}

`goto label` 将执行流无条件转移至当前函数体内的同名标签处。标签的作用域覆盖整个函数体（且声明后必须被引用，否则编译报错），但语言规范严格禁止使用 `goto` 从外部跳入其他代码块内部，亦禁止向前跳过后续会进入作用域的变量声明语句：

```go
goto done
value := 10 // 编译失败：goto 跳过了变量 value 的声明
done:
fmt.Println(value)
```

上述编译期限制防止了目标位置访问未初始化变量或破坏词法块边界，但合法的 `goto` 仍可能降低控制流的可读性。绝大多数场景应优先通过提前 `return`、带标签的 `break`/`continue`、`defer` 或拆分独立函数实现；仅在极少数深层嵌套需统一汇聚至末尾清理逻辑且其他方式会导致严重代码重复时，才审慎使用短距离的向后 `goto`。

## 练习 {#ch4-exercises}

以下四题分别检验词法作用域与变量隐藏、分支优先级、迭代变量生命周期及 `range` 数据源复制规则。建议先独立作答，再展开参考答案核对。

### 练习 1：追踪作用域与变量隐藏

不运行程序，写出三次打印输出，并说明 `if` 初始化语句右侧的 `x`、条件与分支体内的 `x`，以及 `if` 语句结束后的 `x` 分别绑定至哪个声明。

```go
x := 10
if x, y := x+1, 20; x < y {
	fmt.Println(x, y)
	x := 30
	fmt.Println(x, y)
}
fmt.Println(x)
```

<details>
<summary>查看参考答案</summary>

输出为：

```text
11 20
30 20
10
```

`if` 初始化语句右侧的 `x+1` 在新变量进入作用域前求值，读取外层 `x`（值为 `10`）；声明完成后，`if` 隐式块内的 `x`（值为 `11`）和 `y`（值为 `20`）生效，供条件表达式 `x < y` 及分支体首个打印语句使用。分支体内的 `x := 30` 在显式块中声明了第三层同名变量，仅在该花括号块内隐藏隐式块的 `x`。脱离整条 `if` 语句后，内层变量均超出作用域，末行打印的是未被修改的最外层 `x`（值为 `10`）。

</details>

### 练习 2：找出分类分支的顺序错误

已知成绩为 `[0, 100]` 区间内的整数，要求 `90` 分及以上输出 `优秀`、`60`～`89` 分输出 `通过`、其余输出 `未通过`。写出下列代码的实际输出，指出不合要求的输入区间；仅通过调整 `case` 分支顺序修复缺陷，并结合 `59`、`60`、`89`、`90` 四个边界值说明修复原理。

```go
scores := []int{59, 60, 89, 90}
for _, score := range scores {
	switch {
	case score >= 60:
		fmt.Println("通过")
	case score >= 90:
		fmt.Println("优秀")
	default:
		fmt.Println("未通过")
	}
}
```

<details>
<summary>查看参考答案</summary>

原程序输出：

```text
未通过
通过
通过
通过
```

处于 `[90, 100]` 区间的输入均满足首个条件 `score >= 60` 并先行命中，导致其后的 `case score >= 90` 成为永远无法到达的死分支。将两个 `case` 分支互换位置即可修复：

```go
switch {
case score >= 90:
	fmt.Println("优秀")
case score >= 60:
	fmt.Println("通过")
default:
	fmt.Println("未通过")
}
```

修复后输出：

```text
未通过
通过
通过
优秀
```

`59` 均不满足前两个分支，落入 `default`；`60` 与 `89` 不满足首个分支 `>= 90`，向下匹配 `>= 60`；`90` 优先命中首个分支 `>= 90`。因 `switch` 仅执行首个匹配分支，排在后方的条件隐含了“前置条件均不成立”的前提。详见 [4.5.1 节](#ch4-5-1)。

</details>

### 练习 3：避免依赖版本的迭代变量地址

分别在模块语言版本设为 Go 1.21 与 Go 1.22 时，判断循环结束后 `pointers` 中的三个指针是否指向同一变量、解引用各自读取到什么值；再改写循环体，使两种语言版本下三个指针均分别读取到 `1`、`2`、`3`。

```go
values := []int{1, 2, 3}
var pointers []*int
for _, value := range values {
	pointers = append(pointers, &value)
}
```

<details>
<summary>查看参考答案</summary>

在 Go 1.21 语言版本下，整个循环复用同一个 `value` 变量，三个指针指向同一内存地址，解引用均读取到末次迭代值 `3`。在 Go 1.22 及以上语言版本下，循环头 `:=` 声明的变量每次迭代独立创建，三个指针指向不同变量，分别读取到 `1`、`2`、`3`。

通过在循环体内部显式声明局部副本（或直接取切片元素地址 `&values[i]`），可跨语言版本保证每次迭代变量独立：

```go
for i := range values {
	value := values[i]
	pointers = append(pointers, &value)
}
```

循环体块内的 `value` 在每次迭代执行时重新声明，三个指针绑定至不同的局部变量实例，行为不依赖模块语言版本。

</details>

### 练习 4：区分数据源副本与元素副本

下列代码分别将 `range` 表达式设为 `a`、`a[:]`、`&a`（其余语句不变，且每次均从初始数组 `[3]int{1, 2, 3}` 开始执行）。写出三种情形下循环内外的输出，解释修改 `a[1] = 9` 为何会或不会影响后续迭代值，并说明 `value *= 10` 是否会修改原数组。

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

以数组 `a` 作为 `range` 数据源时输出：

```text
0 10
1 20
2 30
[1 9 3]
```

以切片 `a[:]` 或数组指针 `&a` 作为 `range` 数据源时，两者输出均为：

```text
0 10
1 90
2 30
[1 9 3]
```

本例中 `range` 需要产出第二个元素值变量：当数据源为数组 `a` 时，循环开始前对 `a` 求值会复制整个数组，后续迭代从该数组副本中取值，因此首轮迭代中执行的 `a[1] = 9` 仅修改原数组，不影响副本中的第二个元素（仍为 `2`）。当数据源为切片 `a[:]` 或数组指针 `&a` 时，求值仅复制切片描述符或数组指针，底层存储仍指向原数组 `a`，故第二轮迭代读取到修改后的 `9`。

在全部三种情形下，迭代变量 `value` 接收的始终是当前元素的值副本，对其执行 `value *= 10` 仅修改局部副本，绝不会写回原数组。详见 [4.4.4 节](#ch4-4-4)。

</details>

## 面试题 {#ch4-interview}

以下四题检验嵌套控制流跳转目标、`fallthrough` 约束、`goto` 作用域限制及整数 `range` 的版本控制机制。

### 面试题 1：循环里的 `switch` 如何选择跳转目标？

当 `for` 循环内嵌 `switch` 时，`case` 分支中的无标签 `break` 与 `continue` 分别作用于哪个结构？在多层循环中若需直接终止或继续指定的外层循环，应如何编写？

<details>
<summary>查看参考答案</summary>

`case` 分支中的无标签 `break` 仅终止当前最内层的 `switch` 语句；无标签 `continue` 则直接作用于包裹该 `switch` 的最内层 `for` 循环，触发其进入下一轮迭代。若需在 `switch` 或多层嵌套循环中直接控制指定的外层循环，须为目标外层 `for` 声明标签，并显式调用 `break label` 或 `continue label`。

</details>

### 面试题 2：`fallthrough` 会检查下一分支的条件吗？

写出下列代码的输出。若在 `fallthrough` 之后、下一条 `case` 之前插入 `fmt.Println("after")`，能否通过编译？

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

依次输出 `A`、`B`。`fallthrough` 会无条件将控制流转移至紧邻的下一分支执行体，跳过对 `n > 10` 的求值；由于第二个分支末尾未包含 `fallthrough`，执行完 `"B"` 后即正常退出 `switch`，不会继续执行 `default` 分支。

在 `fallthrough` 后追加打印语句会导致编译失败（报错 `fallthrough statement out of place`）。根据 [Go 语言规范](https://go.dev/ref/spec#Fallthrough_statements)，`fallthrough` 必须是当前分支中的最后一条非空语句。

</details>

### 面试题 3：`goto` 可以跳入 `if` 块或跳过变量声明吗？

<details>
<summary>查看参考答案</summary>

不可以。Go 语言规范严格禁止使用 `goto` 从外层跳入任何内层代码块（如 `if`、`for`、`switch` 分支块或显式花括号块），同时禁止向前跳过当前代码块内后续会进入作用域的变量声明语句，以在编译期杜绝访问未初始化变量或破坏词法块边界的控制流。

</details>

### 面试题 4：`for range 100` 从哪个版本开始可用？

<details>
<summary>查看参考答案</summary>

整数 `range` 语法自 Go 1.22 语言版本起支持。该特性是否启用取决于当前包所属模块在 `go.mod` 中声明的 `go` 语言版本指令：若本地安装了 Go 1.22+ 工具链，但 `go.mod` 中声明的版本低于 `1.22`，编译器仍会拒绝该语法；需先升级 `go.mod` 中的语言版本指令或维持传统三段式 `for` 循环写法。

</details>

## 参考资料

- [Go 语言规范：代码块](https://go.dev/ref/spec#Blocks)
- [Go 语言规范：声明与作用域](https://go.dev/ref/spec#Declarations_and_scope)
- [Go 语言规范：短变量声明](https://go.dev/ref/spec#Short_variable_declarations)
- [Go 语言规范：`if` 语句](https://go.dev/ref/spec#If_statements)
- [Go 语言规范：`for` 语句与 `range`](https://go.dev/ref/spec#For_statements)
- [Go 语言规范：表达式 `switch`](https://go.dev/ref/spec#Expression_switches)
- [Go 语言规范：`fallthrough` 的位置与控制转移](https://go.dev/ref/spec#Fallthrough_statements)
- [Go 语言规范：`break` 语句](https://go.dev/ref/spec#Break_statements)
- [Go 语言规范：`continue` 语句](https://go.dev/ref/spec#Continue_statements)
- [Go 语言规范：`goto` 语句](https://go.dev/ref/spec#Goto_statements)
- [Go 1.22 发布说明：循环变量与整数 `range`](https://go.dev/doc/go1.22#language)
- [Go 1.23 发布说明：迭代器函数 `range`](https://go.dev/doc/go1.23#language)
- [Go 模块参考：`go` 指令与语言版本](https://go.dev/doc/modules/gomod-ref#go)
- [Go `vet` 命令：内置分析器](https://pkg.go.dev/cmd/vet)
- [Go `shadow` 分析器：检查可能的变量隐藏](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/shadow)
- [Go 标准库 `iter` 包：迭代器类型与约定](https://pkg.go.dev/iter)
- [Go 标准库 `maps.Keys`：以迭代器返回映射键](https://pkg.go.dev/maps#Keys)
- [Go 标准库 `slices.Sorted`：收集并排序迭代器值](https://pkg.go.dev/slices#Sorted)
- [Go 标准库 `math/rand/v2` 包：`IntN`](https://pkg.go.dev/math/rand/v2#IntN)
