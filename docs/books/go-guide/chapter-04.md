---
title: 第 4 章 代码块、变量隐藏和控制结构
description: 理解 Go 的词法作用域与变量隐藏，并正确选择 if、for、switch、标签和 goto。
---

# 第 4 章 代码块、变量隐藏和控制结构

## 本章要点

本章围绕“一个名字在何处表示哪个对象”与“程序下一步执行哪段代码”展开。前半部分从代码块和作用域解释变量隐藏，说明短变量声明为什么既方便又容易隐藏外层变量；后半部分梳理 `if`、`for`、`switch`、标签和 `goto` 的控制规则。

读完后，应能沿着词法嵌套判断标识符的含义，识别意外隐藏，按数据和退出条件选择循环形式，并准确分析 `break`、`continue` 和分支匹配的目标。文中还补充了当前 Go 对整数 `range`、迭代器函数及逐次迭代变量的规则。

> 核对日期：2026 年 9 月 15 日；核对环境为 Go 1.27.1、Windows/AMD64。
>
> - 整数 `range` 和逐次迭代变量语义需要 Go 1.22 或更新的语言版本。
> - 标准库 `math/rand/v2` 需要 Go 1.22 或更新的工具链。
> - 对迭代器函数使用 `range` 需要 Go 1.23 或更新的语言版本。
> - 标准库 `maps.Keys` 和 `slices.Sorted` 需要 Go 1.23 或更新的工具链。

## 4.1 代码块与作用域 {#ch4-1}

代码块是声明和语句的词法范围，作用域则说明一个已声明标识符可以在哪里使用。内层块可以读取外层块中仍处于作用域内的名字；如果内层重新声明同名标识符，名字查找会选择最内层的声明。

Go 既有由花括号显式写出的块，也有语法隐含的块：

| 代码块 | 其中的典型名字或语句 |
| --- | --- |
| 宇宙块（universe block） | `int`、`true`、`nil`、`len` 等预声明标识符 |
| 包块（package block） | 包级变量、常量、类型和函数；同一个包的多个文件共享 |
| 文件块（file block） | 当前源文件导入的包名 |
| 函数体块 | 参数、结果参数和局部声明 |
| `if`、`for`、`switch` 的隐式块 | 初始化语句声明的名字及控制结构本身 |
| `switch`、类型 `switch`、`select` 的子句块 | 每个 `case` 或 `default` 中的声明 |
| 任意 `{ ... }` 显式块 | 块内的局部声明 |

包级标识符的作用域覆盖该包的所有文件，但导入的包名只属于写出 `import` 的那个文件。函数参数和结果参数的作用域是整个函数体。函数内部声明的局部变量，其作用域从声明结束处开始，到包含它的最内层块结束为止；因此声明自己的初始化表达式不能引用尚未进入作用域的新变量。

```go
x := 10
{
	// 右侧的 x 来自外层；新 x 的作用域从这条声明结束后开始。
	x := x + 1
	fmt.Println(x) // 11
}
fmt.Println(x) // 10
```

作用域是编译期规则，不等同于值在运行时占用内存的时间。判断一段代码里的名字时，应先找当前最内层块，再逐层向外查找，而不是只看两个声明在文件中的距离。

## 4.2 变量隐藏 {#ch4-2}

内层声明与外层声明同名时，就会发生变量隐藏（variable shadowing，也常译为“变量遮蔽”，原书称“影子变量”）：内层标识符会暂时隐藏外层标识符。外层变量没有被删除或修改，只是在内层声明的作用域中无法通过这个名字访问。

```go
x := 10
if x > 5 {
	fmt.Println(x) // 外层 x：10
	x := 5
	fmt.Println(x) // 内层 x：5
}
fmt.Println(x) // 外层 x：10
```

短变量声明 `:=` 是否复用变量，只看当前块，而不是所有外层块；当前块是函数体时，函数参数也可以被复用。当前块中可以重新声明已有变量，但左侧必须至少有一个新的非空白变量，而且被重新声明的变量类型不能改变：

```go
x := 10
x, y := 20, 30 // x 与前一行在同一块：给 x 赋值，并声明 y
fmt.Println(x, y) // 20 30

if x > 0 {
	x, z := 40, 50 // 在 if 分支的显式块中，x 和 z 都是新变量
	fmt.Println(x, z) // 40 50
}
fmt.Println(x) // 20
```

混合处理返回值时尤其容易意外隐藏。例如，外层已有 `err`，但内层块中的 `value, err := read()` 会声明一个新的 `err`。如果原意是更新外层变量，可以先声明真正的新变量，再使用普通赋值：

```go
var value string
value, err = read()
```

导入名和预声明标识符也能被隐藏，因为它们不是关键字：

```go
fmt := "output"
fmt.Println("hello") // 编译失败：fmt 此时是 string，不是导入的包
```

类似地，把局部变量命名为 `len`、`true` 或 `error` 可能合法，却会使相应的预声明标识符暂时不可用或改变表达式含义。应优先选择表达业务含义的名字；只有确实想让内层状态独立时，才有意隐藏外层名字。编译器会报告类型错误和未使用变量，但不会把每一次合法隐藏都视为错误，`go vet` 的内置分析器也不提供通用的变量隐藏检查。需要专项检查时，可以另外安装 `golang.org/x/tools` 提供的 `shadow` 分析器，再通过 `go vet -vettool` 指定其可执行文件；该分析器可能报告需要人工判断的结果，并不适合作为编译规则理解。

## 4.3 `if` 语句 {#ch4-3}

Go 的 `if` 条件必须产生 `bool`，语法不要求、惯例也不添加包住整个条件的多余括号，执行体必须使用花括号。分支按顺序判断，只执行第一个条件为真的分支：

```go
if n == 0 {
	fmt.Println("too low")
} else if n > 5 {
	fmt.Println("too high")
} else {
	fmt.Println("accepted")
}
```

条件前可以放一条简单语句，用分号与条件分开。这里声明的变量属于整个 `if` 的隐式块：条件、`if` 分支以及所有 `else if`、`else` 分支都能访问它，离开整条语句后则不能访问。

以下示例的 `rand.IntN` 来自标准库 `math/rand/v2`，需要导入 `"math/rand/v2"`；旧的 `math/rand` 包提供的是名称不同的 `rand.Intn`。

```go
if n := rand.IntN(10); n == 0 {
	fmt.Println("too low")
} else if n > 5 {
	fmt.Println("too high:", n)
} else {
	fmt.Println("accepted:", n)
}
// fmt.Println(n) // 编译失败：n 已超出作用域
```

初始化语句适合保存只为本次判断服务的结果，例如读取值并同时检查错误。它也能给外层变量赋值，但把状态变化藏在条件头部通常更难读；如果该值在 `if` 之后仍有意义，应在外部声明并把赋值过程写清楚。

条件存在重叠时，应按照业务优先级排列。以整除判断为例，如果要单独处理“同时被 2 和 3 整除”，就必须把它放在两个单独条件之前，否则前面的宽泛条件会先匹配，后面的分支永远没有机会执行。

## 4.4 `for` 语句 {#ch4-4}

`for` 是 Go 唯一的循环关键字。语法上可以分为条件循环、带初始化和后置语句的 `for` 子句，以及 `range` 子句；省略条件后就是无限循环。

### 4.4.1 三种基本写法

完整的 `for` 子句由初始化、条件和后置语句组成。初始化只执行一次；每次迭代前检查条件；循环体正常结束后执行后置语句，再次检查条件。

```go
for i := 0; i < 10; i++ {
	fmt.Println(i)
}
```

初始化和后置语句都可以省略。只保留条件时相当于其他语言的 `while`：

```go
i := 1
for i < 100 {
	fmt.Println(i)
	i *= 2
}
```

条件也省略时得到无限循环，通常要通过 `break`、`return` 或其他明确的终止机制离开：

```go
for {
	value := next()
	if value == stopValue {
		break
	}
	process(value)
}
```

Go 没有 `do/while`。需要至少执行一次时，可以先进入无限循环，在循环末尾检查是否继续：

```go
for {
	doWork()
	if !condition() {
		break
	}
}
```

### 4.4.2 `break` 与 `continue`

无标签的 `break` 结束最内层的 `for`、`switch` 或 `select`。无标签的 `continue` 跳过最内层 `for` 循环体的剩余部分；在完整 `for` 子句中，它会先执行后置语句，再开始下一次条件判断。

`continue` 常用来提前排除当前元素，减少嵌套：

```go
for _, value := range values {
	if value < 0 {
		continue
	}
	process(value)
}
```

循环终止条件应当能从代码中看清。依赖外部状态的无限循环还应考虑超时、取消或最大尝试次数，以免暂时故障变成无法退出的程序。

### 4.4.3 `range` 可以遍历什么

`range` 按数据源产生零个、一个或两个迭代值。Go 1.23 及更新版本支持以下数据源：

| 数据源 | 第一个值 | 第二个值 | 关键规则 |
| --- | --- | --- | --- |
| 数组、数组指针、切片 | 索引 `int` | 元素的副本 | nil 切片迭代 0 次 |
| 字符串 | UTF-8 字节起始索引 `int` | 解码后的 `rune` | 无效编码产生 `U+FFFD`，前进 1 字节 |
| 映射 | 键 | 值的副本 | 顺序不保证；nil 映射迭代 0 次 |
| 通道 | 接收到的元素 | 无 | 持续到通道关闭；nil 通道会永久阻塞 |
| 整数 | 从 0 递增的值 | 无 | Go 1.22 起支持，负数或 0 迭代 0 次 |
| 特定签名的迭代器函数 | 迭代器传给 `yield` 的值 | 可选的第二个值 | Go 1.23 起支持 |

`range` 表达式通常在循环开始前求值一次，而不是在每次迭代前重新求值。唯一的例外是：最多只有一个迭代变量，并且表达式本身或其 `len` 结果是常量时，`range` 表达式不会被求值。对于切片，循环开始前求值得到的是当时的切片值，因此迭代次数由当时的长度决定；在循环中重新给原切片变量赋值或向它追加元素，不会延长本轮迭代。不过，迭代仍可能观察到对共享底层数组中已有元素的修改。

数组、切片和映射通常同时接收位置与值；不需要第一个值时用空白标识符 `_`，不需要第二个值时直接省略：

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

整数 `range` 让“执行 n 次”可以直接写成：

```go
for i := range 5 {
	fmt.Println(i) // 依次为 0、1、2、3、4
}
```

使用 `:=` 声明整数 `range` 的迭代变量时，其类型跟随 `range` 表达式：若 `n` 的类型是 `int8`，`for i := range n` 中的 `i` 也是 `int8`；若表达式是 `5` 这样的无类型整数常量，迭代变量使用默认类型 `int`。

迭代器函数的签名必须是 `func(yield func() bool)`、`func(yield func(V) bool)` 或 `func(yield func(K, V) bool)`。`range` 会把合成的 `yield` 函数传给迭代器，迭代器每调用一次 `yield` 就向循环产生一组值；循环提前结束后，`yield` 返回 `false`，迭代器必须停止，继续调用会触发运行时 `panic`。标准库 `iter` 包定义了常用的 `Seq` 和 `Seq2` 类型，本指南会在介绍函数和泛型之后再展开迭代器的组合方式。

对于这种函数，调用方只需使用 `range` 即可消费它产生的值。展开下面的示例，可以看到函数签名、提前停止的处理方式和预期输出。

<details>
<summary>查看迭代器示例</summary>

例如，`countUpTo` 返回一个符合 `func(yield func(int) bool)` 签名的迭代器。`range` 会传入 `yield`；每次调用 `yield(i)` 都把 `i` 交给循环体。循环体执行 `break` 后，`yield` 返回 `false`，迭代器随即返回：

```go
func countUpTo(limit int) func(func(int) bool) {
	return func(yield func(int) bool) {
		for i := 1; i <= limit; i++ {
			if !yield(i) {
				return
			}
		}
	}
}

for value := range countUpTo(5) {
	fmt.Println(value)
	if value == 3 {
		break
	}
}
```

预期输出为：

```text
1
2
3
```

循环在 `3` 处执行 `break`，所以不会产生 `4` 和 `5`；去掉 `break` 就会产生完整的 `1` 到 `5`。需要产生两个值时，将签名改为 `func(yield func(K, V) bool)`，并在每次调用 `yield` 时传入两个值即可。

</details>

### 4.4.4 索引、值副本与遍历中的修改 {#ch4-4-4}

遍历字符串时，第一个值是字节索引，第二个值是解码后的 Unicode 码点，不是字节位置连续的“字符编号”：

```go
for i, r := range "Aπ!" {
	fmt.Println(i, r, string(r))
}
```

输出中的索引依次是 `0`、`1`、`3`，因为 `π` 的 UTF-8 编码占两个字节。

对数组、切片或映射进行 `range` 时，值变量接收元素值的副本。给这个变量重新赋值，不会写回数据源：

```go
numbers := []int{2, 4, 6}
for _, value := range numbers {
	value *= 2
}
fmt.Println(numbers) // [2 4 6]
```

数据源本身是否共享存储则要分开判断。当 `range` 产生数组的元素值时，循环开始前求值得到的是数组副本，之后修改原数组不会改变尚未产生的迭代值；数组指针和切片的值仍指向原有存储，因而可能观察到循环期间对尚未到达元素的修改。这个区别描述的是 `range` 数据源，而不是迭代变量；无论数据源是否共享存储，赋给迭代变量的元素值都是副本。

如果元素本身是指针，复制的是指针值，副本仍指向同一个对象。给迭代变量重新赋值不会替换容器中的指针，但通过指针修改对象会被其他别名观察到：

```go
type Item struct {
	Name string
}

items := []*Item{{Name: "old"}}
for _, item := range items {
	item.Name = "new" // 修改指针指向的对象
	item = nil        // 只修改迭代变量中的指针副本
}
fmt.Println(items[0].Name, items[0] == nil) // new false
```

要修改切片元素，应通过索引写入：

```go
for i := range numbers {
	numbers[i] *= 2
}
```

映射的迭代顺序未指定，同一个程序的不同轮遍历也可能不同，业务逻辑不能依赖观察到的顺序。遍历期间删除尚未到达的键，该键不会再产生；新加入的键可能产生，也可能被跳过。如果需要按有序键稳定遍历，Go 1.23 及更新版本可以组合 `maps.Keys` 和 `slices.Sorted`。以下代码需要导入标准库 `maps` 和 `slices`：

```go
for _, key := range slices.Sorted(maps.Keys(counts)) {
	fmt.Println(key, counts[key])
}
```

`slices.Sorted` 适用于整数、浮点数和字符串等有序键；需要自定义顺序时，可以改用 `slices.SortedFunc` 并提供比较函数。若遍历期间的修改会影响控制逻辑，应先得到排好序的键切片，再逐个处理。

### 4.4.5 每次迭代的变量

当 `for` 或 `range` 使用 `:=` 声明循环变量时，从 Go 1.22 语言版本开始，每次迭代都有各自的新变量。这使闭包或地址在跨迭代保存时不再意外共享同一个循环变量：

```go
words := []string{"one", "two", "three"}
var pointers []*string
for _, word := range words {
	pointers = append(pointers, &word)
}

for _, pointer := range pointers {
	fmt.Println(*pointer) // one、two、three
}
```

闭包捕获循环变量时，语言版本差异会直接体现在输出上。将模块 `go.mod` 中的 `go` 指令分别设为 `1.21` 和 `1.22`（或更高），再用同一工具链运行下面的代码，可以对照旧语义与新语义：

<details>
<summary>查看 Go 1.22 前后的闭包示例</summary>

```go
func makeReaders(words []string) []func() string {
	var readers []func() string
	for _, word := range words {
		readers = append(readers, func() string { return word })
	}
	return readers
}

for _, read := range makeReaders([]string{"one", "two", "three"}) {
	fmt.Println(read())
}
```

当语言版本为 Go 1.21 或更早时，循环变量在迭代之间复用，三个闭包都读取最后一次迭代的值：

```text
three
three
three
```

当语言版本为 Go 1.22 或更高时，使用 `:=` 声明的循环变量每次迭代各自独立，闭包分别读取当次迭代的值：

```text
one
two
three
```

</details>

这项规则由包含该包的模块在 `go.mod` 中声明的 Go 语言版本控制，不只是由当前安装的工具链版本决定。声明 Go 1.21 或更早语言版本的包仍使用旧的复用语义；迁移时应先升级 `go` 指令并运行测试。

如果循环变量预先声明，再在循环头中使用 `=` 赋值，所有迭代仍会更新同一个变量：

```go
var word string
for _, word = range words {
	fmt.Println(word)
}
```

“每次迭代有新变量”也不改变 [4.4.4 节](#ch4-4-4)的复制规则。新的 `word` 仍是当前元素的副本，修改它不会修改切片元素。

### 4.4.6 标签控制外层循环

`break` 和 `continue` 默认只作用于最内层控制结构。嵌套循环需要直接控制外层循环时，可以给外层 `for` 添加标签：

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

`continue label` 的标签必须指向包含这条语句的某个 `for`。`break label` 可以指向包含它的 `for`、`switch` 或 `select`。标签应只在它比拆分函数或调整条件更清楚时使用，并取能说明目标含义的名字。

### 4.4.7 选择循环形式

- 遍历整个数组、切片、字符串、映射、通道或迭代器时，优先使用 `range`。
- 需要明确的起点、终点、步长或反向遍历时，使用完整 `for` 子句。
- 只由一个动态条件决定是否继续时，使用条件 `for`。
- 需要先执行再判断时，使用带明确退出条件的无限 `for`。
- 处理字符串时，不要用 `for i := 0; i < len(s); i++` 冒充 Unicode 字符遍历；这种写法得到的是字节。需要按码点处理时使用 `range`，需要按字节处理时则应明确说明。

## 4.5 `switch` 语句 {#ch4-5}

表达式 `switch` 先计算可选的初始化语句，再计算 `switch` 表达式，然后按源码顺序寻找第一个匹配的 `case`。省略表达式时等价于使用 `true`，形成无表达式 `switch`。`default` 最多出现一次，可以放在任意位置，但只有没有其他分支匹配时才执行。

```go
switch size := len(word); size { // size 是字符串的字节数
case 1, 2, 3, 4:
	fmt.Println("short")
case 5:
	fmt.Println("right")
default:
	fmt.Println("long")
}
```

同一个 `case` 可以用逗号列出多个匹配表达式。`switch` 表达式与各 `case` 表达式必须能够进行相等比较；切片、映射和函数不能直接用作普通 `switch` 的比较值。常量 `case` 的值不能重复，否则编译失败。初始化语句声明的名字在所有分支中可见，而每个 `case` 和 `default` 又各自形成隐式块，因此不同分支可以声明同名的局部变量。

Go 默认只执行匹配分支，不需要在每个分支末尾写 `break`。空 `case` 什么也不做，也不会自动执行下一个分支。确实需要无条件进入下一分支时，应把 `fallthrough` 放在当前分支末尾；它不检查下一分支的条件，不能出现在最后一个分支中，也不能用于类型 `switch`。通常重组共同逻辑会更清楚。

当 `switch` 位于循环内时，`case` 中的无标签 `break` 只结束当前 `switch`，循环会继续。若要从 `case` 直接结束外层循环，需要给循环加标签，并使用 `break label`：

```go
loop:
for i := 0; i < 10; i++ {
	switch i {
	case 7:
		break loop
	}
}
```

### 4.5.1 无表达式 `switch`

无表达式 `switch` 等价于以 `true` 作为 `switch` 表达式，每个 `case` 可以写独立的布尔表达式：

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

分支仍然只执行第一个匹配项，所以这里必须把能被 6 整除的情况放在能被 2 或 3 整除之前。无表达式 `switch` 适合表达一组互相关联、可能重叠但优先级明确的条件。

### 4.5.2 在 `if` 和 `switch` 之间选择

只有一两个判断、各分支处理流程差异很大，或后续判断依赖前一分支的计算时，`if` 往往更直接。同一个值存在多个离散情况，或多个相关条件构成一组分类规则时，`switch` 通常更清楚。

不要为了减少行数把无关条件塞进同一个无表达式 `switch`。选择标准不是语法是否可行，而是读者能否把这些分支理解成同一个决策。类型 `switch` 用于判断接口值的动态类型，将在接口章节讨论。

## 4.6 `goto` 语句 {#ch4-6}

`goto label` 会跳到当前函数体内同名标签处。标签的作用域覆盖所在函数体，但 `goto` 不能跳入另一个块，也不能向前跳过随后会进入作用域的变量声明：

```go
goto done
value := 10 // 编译失败：goto 跳过了 value 的声明
done:
fmt.Println(value)
```

同样，从 `if` 外部跳到其内部标签也不合法。限制能阻止一部分难以分析的控制流，却不表示合法的 `goto` 就自然易读。

大多数情况可以用提前 `return`、`break`、`continue`、标签或拆分辅助函数表达。极少数需要从深层流程汇合到同一段收尾逻辑、且其他写法会重复复杂代码时，局部、短距离的 `goto` 可能合理；使用前应确认跳转目标和收尾路径一眼可见。

## 练习 {#ch4-exercises}

四题分别检查作用域隐藏、分支优先级、迭代变量的身份和 `range` 数据源的复制规则。先独立完成，再展开参考答案。代码片段位于 `main` 函数内，`fmt` 对应标准库导入路径 `"fmt"`；涉及旧语言版本的场景单独说明。

### 练习 1：追踪作用域与变量隐藏

不运行程序，写出三次输出，并说明初始化语句右侧的 `x`、条件和主体中的 `x`、以及 `if` 结束后的 `x` 分别来自哪个声明。

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

短变量声明右侧的 `x+1` 先读取外层 `x == 10`；声明完成后，`if` 的条件和主体使用新的 `x == 11`、`y == 20`。主体中的 `x := 30` 又创建更内层变量，只在该块中隐藏外层 `x`。离开 `if` 后，外层 `x` 仍为 10。

</details>

### 练习 2：找出分类分支的顺序错误

已知成绩是 `[0, 100]` 内的整数，要求 `90` 分及以上输出 `优秀`、`60`～`89` 分输出 `通过`、其余输出 `未通过`。写出下列代码的实际输出，指出与要求不符的输入范围。只调整分支顺序修复（每个条件连同其输出一起移动），并用 `59`、`60`、`89`、`90` 四个边界值解释修复为何成立。

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

所有 `90`～`100` 分都会先匹配 `score >= 60`，因此 `优秀` 分支永远不会被选中。交换两个 `case` 及其输出，保留其他代码，即可修复：

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

`59` 不满足两个条件；`60` 和 `89` 不满足第一个条件，但满足第二个；`90` 首先匹配第一个条件。`switch` 只执行第一个匹配分支，因此后一个分支的实际范围还受前面条件排除的影响。可回看[无表达式 `switch`](#ch4-5)。

</details>

### 练习 3：避免依赖版本的迭代变量地址

分别在模块语言版本为 Go 1.21 和 Go 1.22 时，判断循环结束后三个指针是否指向同一变量、各自读到什么值。再改写循环，使两种版本下三个指针都分别读到 `1`、`2`、`3`。

```go
values := []int{1, 2, 3}
var pointers []*int
for _, value := range values {
	pointers = append(pointers, &value)
}
```

<details>
<summary>查看参考答案</summary>

Go 1.21 语言版本复用同一个循环变量，三个指针指向同一变量，最终都读到 `3`。Go 1.22 起，由循环头的 `:=` 声明的变量每次迭代各自独立，三个指针分别读到 `1`、`2`、`3`。

可以在循环体内显式创建每次执行都独立的变量：

```go
for i := range values {
	value := values[i]
	pointers = append(pointers, &value)
}
```

循环体中的 `value` 每次执行时重新声明，三个指针指向不同变量；只要指针仍可访问，变量就保持有效。这个结论不依赖具体的内存分配位置。

</details>

### 练习 4：区分数据源副本与元素副本

下面代码分别以 `a`、`a[:]`、`&a` 作为 `range` 表达式，其他语句保持不变；每种情况都从原始数组重新开始。写出三种情况下循环内和循环后的输出，说明修改原数组为什么会或不会影响后续迭代值，以及 `value *= 10` 是否写回数组。

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

以数组 `a` 为数据源时输出：

```text
0 10
1 20
2 30
[1 9 3]
```

以切片 `a[:]` 或数组指针 `&a` 为数据源时，两者都输出：

```text
0 10
1 90
2 30
[1 9 3]
```

这里的 `range` 需要产生元素值。数组表达式在循环开始前求值得到数组副本，之后的 `a[1] = 9` 不改变副本；切片和数组指针的副本仍指向原数组，所以后续迭代能读到 `9`。

三种情况下，迭代变量 `value` 接收的都是当前元素值的副本，因此 `value *= 10` 都不会写回数组。这与每次迭代是否创建新变量是两条独立规则，详见[索引、值副本与遍历中的修改](#ch4-4-4)。

</details>

## 面试题 {#ch4-interview}

四题检查跳转目标、分支贯穿、`goto` 限制和整数 `range` 的版本要求。先独立回答，再展开参考答案；代码上下文与导入约定沿用[练习部分](#ch4-exercises)。

### 面试题 1：循环里的 `switch` 如何选择跳转目标？

`for` 内嵌 `switch` 时，`case` 中的无标签 `break`、`continue` 分别作用于哪里？多层循环中要控制指定的外层循环，应怎样写？

<details>
<summary>查看参考答案</summary>

`break` 结束这个 `switch`；`continue` 开始最近一层 `for` 的下一次迭代。控制指定的外层循环时，为该循环添加标签，分别使用 `break label` 或 `continue label`；标签必须指向包含当前语句的目标循环。

</details>

### 面试题 2：`fallthrough` 会检查下一分支的条件吗？

下面代码输出什么？若在 `fallthrough` 之后、下一条 `case` 之前再加一条 `fmt.Println("after")`，能否编译？

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

依次输出 `A`、`B`。`fallthrough` 无条件进入下一分支，不求值 `n > 10`；第二个分支没有 `fallthrough`，因此不会继续打印 `C`。

追加打印语句后编译失败，报 `fallthrough statement out of place`。[规范的准确限定](https://go.dev/ref/spec#Fallthrough_statements)是“最后一条非空语句”：后面可以只有空语句（如单独的 `;`），但不能再有打印、赋值或代码块。

</details>

### 面试题 3：`goto` 可以跳入 `if` 块或跳过变量声明吗？

<details>
<summary>查看参考答案</summary>

不可以。Go 禁止从块外跳入块内，也禁止向前跳过会使局部变量进入作用域的声明，以避免目标位置出现未按正常路径初始化的状态。

</details>

### 面试题 4：`for range 100` 从哪个版本开始可用？

<details>
<summary>查看参考答案</summary>

整数 `range` 从 Go 1.22 的语言版本开始支持。是否启用该语义由模块的 `go` 指令决定，因此工具链版本足够新但模块语言版本较低时，仍应使用传统的三段式 `for`，或先升级模块语言版本并检查兼容性。

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
