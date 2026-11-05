---
title: 第 4 章 代码块、变量隐藏和控制结构
description: 理解 Go 的词法块与变量隐藏机制，掌握 if、for、range、switch、标签和 goto 的求值与跳转规则。
---

# 第 4 章 代码块、变量隐藏和控制结构

## 本章要点

读懂一段函数控制流，核心要看清两件事：**当前位置的名字到底绑定到哪一层声明**，以及**循环或分支在何时求值、往哪里跳转**。Go 的词法块不仅来自花括号，也隐式存在于 `if`、`for`、`switch` 头部与分支中，配合 `:=` 很容易在嵌套块里静默制造变量隐藏。本章沿着词法作用域出发，依次梳理变量隐藏的成因与规避手法、`if` 与 `switch` 的分支收敛、`for` 与 `range` 的值复制和迭代变量规则（含 Go 1.22+ 逐次迭代变量与整数 `range`、Go 1.23+ 迭代器函数），以及标签与 `goto` 的使用边界。

> 核对日期：2026 年 10 月 20 日；核对环境为 Go 1.27.2、Windows/AMD64。

## 4.1 代码块与作用域 {#ch4-1}

除另有说明外，本章正文代码片段均位于 `main` 函数内，省略外层 `package main` 与 `import` 声明；`fmt` 对应标准库 `"fmt"`，其余标准库包在首次出现处注明导入路径。

代码块（Block）是由声明和语句组成的词法区域，作用域（Scope）则是某个已声明标识符在源码中可以被合法引用的编译期范围。内层块可以直接访问外层块处于作用域内的名字；一旦内层重新声明了同名标识符，名字解析就会优先绑定到最内层的声明。

Go 中既有花括号显式围出的块，也有由语法结构隐式形成的块：

| 代码块 | 包含的典型标识符或语句 |
| --- | --- |
| 宇宙块（Universe Block） | `int`、`true`、`nil`、`len` 等全部预声明标识符 |
| 包块（Package Block） | 包级变量、常量、类型和函数，同包所有源文件共享 |
| 文件块（File Block） | 当前源文件通过 `import` 引入的包名 |
| 函数体块 | 函数形参、具名返回值及函数体顶层的局部声明 |
| `if`、`for`、`switch` 隐式块 | 控制结构初始化子句声明的变量及整条控制语句 |
| `switch`、类型 `switch`、`select` 子句块 | 每个 `case` 或 `default` 分支内部的局部声明 |
| 任意 `{ ... }` 显式块 | 花括号内部的局部声明 |

包级标识符在整个包的所有文件里都可见（不需要声明顺序在前），而 `import` 导入的包名只在当前源文件块内可见。函数形参与具名返回值的作用域覆盖整个函数体；函数内部声明的局部变量，其作用域**从该条声明语句结束处才开始**，一直持续到包裹它的最内层块结束。正因为“先求值右侧、声明结束后新名字才生效”，局部变量的初始化表达式里如果写了同名标识符，读到的是外层旧变量：

```go
x := 10
{
	// 右侧 x 解析为外层变量（10）；新变量 x 的作用域在本条声明结束后才开始
	x := x + 1
	fmt.Println(x) // 11
}
fmt.Println(x) // 10
```

还要区分编译期作用域与运行期生命周期：作用域只决定源码里哪几行能写这个名字，而变量占用的内存何时回收由逃逸分析与垃圾回收器决定（被闭包捕获的局部变量即便走出词法块也依然存活）。查找名字绑定时，始终从当前最内层块出发，顺着词法嵌套一层层向外找。

## 4.2 变量隐藏 {#ch4-2}

只要内层块声明了一个与外层同名的新标识符，就会发生**变量隐藏**（Variable Shadowing，又称“变量遮蔽”）：在内层新声明的作用域里，外层同名变量被挡住而无法直接按原名访问；但外层变量本身既没有被销毁，也不会跟着内层的修改变化。

```go
x := 10
if x > 5 {
	fmt.Println(x) // 外层 x：10
	x := 5
	fmt.Println(x) // 内层新声明的 x：5
}
fmt.Println(x) // 外层 x 仍是 10
```

短变量声明 `:=` 只会在**当前这一层词法块**里寻找可复用的同名变量（处于函数体顶层块时，也包含函数形参与具名返回值），绝不会跨出当前花括号去复用外层块的变量。同一词法块内，只要 `:=` 左侧至少带有一个全新的非空白变量，且旧变量类型匹配，旧变量就会被就地重赋值；一旦跨进内层块，左侧所有变量都会变成全新的局部变量：

```go
x := 10
x, y := 20, 30    // 同一词法块：更新原有的 x，同时声明新变量 y
fmt.Println(x, y) // 20 30

if x > 0 {
	x, z := 40, 50    // 进入 if 分支块：x 与 z 全是新声明的局部变量
	fmt.Println(x, z) // 40 50
}
fmt.Println(x) // 外层 x 仍为 20
```

实际代码里最隐蔽的 Bug 往往出在嵌套块接收多返回值时。例如外层（或具名返回值）已经有了 `err`，在 `if` 或 `for` 块里顺手写下 `value, err := read()`，由于 `value` 是新名字，`:=` 会连带在内层新建一个局部 `err`，导致外层 `err` 根本没被更新（如果外层 `err` 是具名返回值，且在内层写了无参数的裸 `return`，编译器还会直接报错 `err is shadowed during return`）。想更新外层变量时，应先声明真正需要新增的变量，再改用 `=` 赋值：

```go
var value string
value, err = read()
```

因为导入的包名和宇宙块里的预声明标识符都不是语法关键字，它们同样会被内层同名声明隐藏：

```go
fmt := "output"
fmt.Println("hello") // 编译失败：fmt 已被隐藏为 string 变量，不再代表包名
```

同理，把变量起名为 `len`、`true`、`new` 或 `error` 在语法上完全合法，却会让对应的内置函数、常量或接口在当前作用域里失灵。日常编码应坚决避开包名与预声明标识符。注意 Go 编译器和默认的 `go vet` 都不会把合法的变量隐藏当成错误；需要做专项排查时，可以单独安装 `golang.org/x/tools/go/analysis/passes/shadow` 并通过 `go vet -vettool` 运行。

## 4.3 `if` 语句 {#ch4-3}

`if` 条件表达式的结果必须是 `bool` 类型；条件两侧不加圆括号，但分支体花括号不可省略。多分支自上而下依次求值，命中第一个为 `true` 的分支后即跳过其余分支：

```go
if n == 0 {
	fmt.Println("too low")
} else if n > 5 {
	fmt.Println("too high")
} else {
	fmt.Println("accepted")
}
```

条件前面可以带一条用分号隔开的初始化简单语句。这里声明的变量落在整条 `if` 语句的隐式块中，在条件本身、`if` 主体以及后续所有 `else if`、`else` 分支里都能读取，走出整条 `if` 语句后立即失效。

下面的例子使用 Go 1.22 引入的标准库 `"math/rand/v2"` 中的 `rand.IntN`（旧版 `"math/rand"` 中对应函数名为 `rand.Intn`）：

```go
if n := rand.IntN(10); n == 0 {
	fmt.Println("too low")
} else if n > 5 {
	fmt.Println("too high:", n)
} else {
	fmt.Println("accepted:", n)
}
// fmt.Println(n) // 编译失败：n 已离开 if 隐式块作用域
```

前置初始化子句非常适合把 `err` 或临时结果的作用域收紧在当前检查之内（如 `if err := save(); err != nil { ... }`）。如果某个结果在 `if` 结束后还要继续使用，就应该在 `if` 外面先声明；也不要为了省一行代码而在条件头部夹带难以察觉的外层状态修改。另外，当某个 `if` 分支已经通过 `return`、`break`、`continue` 或 `panic` 结束当前路径时，习惯上直接省略后面的 `else`，让主干逻辑保持左对齐（卫语句写法）。

当多个分支的条件范围存在重叠时，务必把**更具体、更严苛的条件写在前面**。例如判断整除关系时，“同时被 2 和 3 整除”必须排在“被 2 整除”和“被 3 整除”之前，否则宽泛分支会提前截胡，让后面的细分条件永远无法命中。

## 4.4 `for` 语句 {#ch4-4}

Go 没有 `while` 和 `do/while`，所有循环都统一由 `for` 表达，共四种常见形态：三段式 `for`、单条件 `for`、无限 `for` 以及 `for range`。

### 4.4.1 三种基本写法 {#ch4-4-1}

标准三段式 `for` 由初始化子句、条件表达式和后置语句组成：初始化只在进入循环前跑一次；每轮开始前先判条件；循环体执行完（或遇到 `continue`）后执行后置语句，再进入下一轮条件判断：

```go
for i := 0; i < 10; i++ {
	fmt.Println(i)
}
```

省掉初始化和后置语句、只保留条件表达式，就是其他语言里的 `while`：

```go
i := 1
for i < 100 {
	fmt.Println(i)
	i *= 2
}
```

三部分全部省掉就是无限循环，靠循环体内的 `break` 或 `return` 显式退出：

```go
for {
	value := next()
	if value == stopValue {
		break
	}
	process(value)
}
```

需要模拟“先至少执行一次、再判断要不要继续”的 `do/while` 逻辑时，同样用无限 `for` 把退出判断放在末尾：

```go
for {
	doWork()
	if !condition() {
		break
	}
}
```

### 4.4.2 `break` 与 `continue` {#ch4-4-2}

不带标签的 `break` 会立即跳出包裹它的最内层 `for`、`switch` 或 `select`；不带标签的 `continue` 则跳过最内层 `for` 本轮剩下的语句（在三段式 `for` 中仍会照常执行后置语句 `i++`，再去判断下一轮条件）。

遍历切片或序列时，常借助 `continue` 先筛掉不符合条件的元素，避免把正常处理逻辑一层层缩进到大段 `if` 里：

```go
for _, value := range values {
	if value < 0 {
		continue
	}
	process(value)
}
```

凡是涉及网络请求、消息消费或状态轮询的无限 `for` 循环，都应想好兜底退出路径（例如绑定 `context.Context` 取消、超时或最大重试次数），避免下游异常时卡死成真正的死循环。

### 4.4.3 `range` 可以遍历什么 {#ch4-4-3}

`for range` 会根据右侧数据源的类型每次产出零个、一个或两个值（其中整数遍历自 Go 1.22 起支持，迭代器函数自 Go 1.23 起支持）：

| 数据源 | 第一个值 | 第二个值 | 核心规则 |
| --- | --- | --- | --- |
| 数组、数组指针、切片 | 索引 `int` | 元素值的副本 | `nil` 切片正常遍历 0 次 |
| 字符串 | 当前码点起始字节偏移 `int` | 解码后的 `rune` | 非法 UTF-8 字节产出 `U+FFFD` 并前进 1 字节 |
| 映射 | 键 | 值的副本 | 遍历顺序随机未定；`nil` 映射正常遍历 0 次 |
| 通道 | 接收到的元素 | 无 | 一直读取直到通道关闭；**`nil` 通道会永久阻塞** |
| 整数 | 从 `0` 到 `n-1` 的整数 | 无 | Go 1.22+；非正数（`<= 0`）遍历 0 次 |
| 特定签名的迭代器函数 | 传给 `yield` 的第一个值 | 传给 `yield` 的第二个值 | Go 1.23+ |

`range` 右侧表达式默认在循环开始前**只求值一次**。语言规范只有一处特殊例外：当左侧至多接收一个迭代变量（只取索引或完全不接收变量），且右侧是数组或数组指针、同时表达式中不包含通道接收或非常量函数调用时，由于 `len` 在编译期已是常量，右侧表达式本身不会被求值——因此对 `var p *[3]int`（值为 `nil`）执行 `for i := range p` 能安全跑完 3 轮，而一旦写成 `for i, v := range p` 需要读取元素，就会在循环入口解引用 `nil` 触发 `panic`。遍历切片时，循环总轮数由入口处求值得到的切片长度固定下来：循环体内往同一个切片变量 `append` 不会拉长本轮遍历次数，但如果改写了共享底层数组里尚未走到位置的元素，后面的轮次仍会读到新值。

遍历数组、切片或映射时，不需要第一个值就用 `_` 忽略，不需要第二个值直接省略即可：

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

整数 `range`（Go 1.22+）让“重复执行 `N` 次”不必再手写三段式样板：

```go
for i := range 5 {
	fmt.Println(i) // 依次输出 0、1、2、3、4
}
```

用 `:=` 接收整数 `range` 变量时，`i` 的类型跟随右侧整数：若 `n` 是 `int8`，`for i := range n` 里的 `i` 也是 `int8`；右侧若是无类型整数常量（如 `5`），则按默认类型推导为 `int`。

迭代器函数（Go 1.23+）是形如 `func(yield func() bool)`、`func(yield func(V) bool)` 或 `func(yield func(K, V) bool)` 的高阶函数。`for range` 会把循环体包装成 `yield` 回调传给迭代器：迭代器每调一次 `yield(...)` 就向循环体推送一组值；一旦循环体内部执行了 `break` 或 `return` 提前退出，`yield` 就会返回 `false`——此时迭代器**必须立即停止并退出**（若持有文件或连接应配合 `defer` 清理），若无视 `false` 继续调用 `yield` 会直接触发运行期 `panic`。标准库 `"iter"` 包定义了通用的 `iter.Seq[V]` 与 `iter.Seq2[K, V]` 类型，后续结合泛型章节还会继续用到。

展开下方可查看完整可运行的迭代器与提前退出示例：

<details>
<summary>查看迭代器示例</summary>

`countUpTo` 返回满足 `func(yield func(int) bool)` 签名的迭代器函数（完整程序需导入 `"fmt"`）。每次调用 `yield(i)` 把当前数字交给循环体；当循环体在 `value == 3` 处 `break` 时，`yield` 返回 `false`，迭代器随即返回：

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

因为循环在 `3` 处执行了 `break`，后面的 `4` 和 `5` 根本不会生成。需要同时产出两个值时，把回调签名换成 `func(yield func(K, V) bool)` 即可。

</details>

### 4.4.4 索引、值副本与遍历中的修改 {#ch4-4-4}

对字符串做 `for range` 时，第一个值是当前字符在原字符串中的 **UTF-8 起始字节偏移**，第二个值才是解码出来的 `rune` 码点，因此索引值遇到多字节字符时会跳着增长：

```go
for i, r := range "Aπ!" {
	fmt.Println(i, r, string(r))
}
```

`"π"` 在 UTF-8 下占 2 个字节，所以上面三轮打印出的字节偏移依次是 `0`、`1`、`3`。

对数组、切片或映射做 `for range` 时，第二个变量拿到的是当前元素的**值副本**，直接改它是改不到原容器里的：

```go
numbers := []int{2, 4, 6}
for _, value := range numbers {
	value *= 2
}
fmt.Println(numbers) // 仍是 [2 4 6]
```

这里很容易把两层复制混在一起——**“入口处的数据源副本”**与**“每轮赋给迭代变量的元素副本”**：

- 如果 `range` 直接遍历**值数组** `a` 且要取第二个元素变量，循环开始前会先把整个数组 `a` 复制一份，后面每一轮都从这份快照里读元素，循环途中改原数组 `a[i]` 不会影响后续轮次读到的值；
- 如果遍历的是**切片 `a[:]` 或数组指针 `&a`**，入口处只复制了切片描述符或指针，底层数组仍是同一块，因此循环途中修改尚未遍历到的底层元素，会在后续轮次被读出来；
- 不管数据源怎么传，每轮赋给第二个迭代变量的**永远是元素副本**（如果切片元素是体积很大的结构体，只写 `for i := range s` 按下标访问 `s[i]` 可以省掉每轮拷贝整块结构体的开销）。

如果容器里存的本来就是指针（如 `[]*Item`），那么迭代变量拷贝的是指针地址，和原切片元素指向同一个堆对象：通过指针改对象字段 `item.Name = "new"` 会生效，但把迭代变量本身改成 `item = nil` 只改了局部指针副本，原切片里的指针纹丝不动：

```go
type Item struct {
	Name string
}

items := []*Item{{Name: "old"}}
for _, item := range items {
	item.Name = "new" // 顺着指针修改目标对象字段，生效
	item = nil        // 只清空了局部指针副本，不影响 items[0]
}
fmt.Println(items[0].Name, items[0] == nil) // new false
```

想原地修改切片或数组里的元素值，直接用下标写回即可：

```go
for i := range numbers {
	numbers[i] *= 2
}
```

遍历映射时顺序不确定：如果遍历途中 `delete` 掉还没走到的键，后面就不会再产出它；如果遍历途中新插入了键，这轮遍历可能见到它、也可能跳过它。需要按固定顺序遍历映射时，在 Go 1.23+ 中可以直接把标准库 `"maps"` 的 `maps.Keys`（返回键迭代器）传给 `"slices"` 的 `slices.Sorted`：

```go
for _, key := range slices.Sorted(maps.Keys(counts)) {
	fmt.Println(key, counts[key])
}
```

`slices.Sorted` 适用于整数、浮点数、`string` 等可比较大小的类型；需要自定义排序规则时改用 `slices.SortedFunc`。

### 4.4.5 每次迭代的变量 {#ch4-4-5}

从 Go 1.22 语言版本开始，只要 `for`（含三段式 `for` 与 `for range`）在循环头部用 `:=` 声明迭代变量，**每一轮迭代都会创建独立的变量实例**。这彻底修掉了早年 Go 里“在循环中对迭代变量取地址或用闭包捕获，结果全指到最后一轮同一个变量”的历史大坑：

```go
words := []string{"one", "two", "three"}
var pointers []*string
for _, word := range words {
	pointers = append(pointers, &word)
}

for _, pointer := range pointers {
	fmt.Println(*pointer) // Go 1.22+ 下依次输出 one、two、three
}
```

在同一套 Go 1.22+ 工具链下，只需把 `go.mod` 里的 `go` 指令分别改成 `1.21` 和 `1.22`，就能直观复现新旧语义的差别：

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

当模块声明为 `go 1.21` 或更早版本时，整轮循环共用同一个 `word` 变量，三个闭包最后读到的都是末轮写入的值：

```text
three
three
three
```

当模块声明为 `go 1.22` 或更新版本时，`:=` 声明的 `word` 按轮隔离，每个闭包各自绑定当轮实例：

```text
one
two
three
```

</details>

务必记住两点边界：

1. **看模块语言版本，不只看本地编译器版本**：即使本机装的是 Go 1.27，只要当前包所属 `go.mod` 写着 `go 1.21`，编译器为了向后兼容依然会按旧的单变量复用语义编译。
2. **只针对循环头 `:=` 声明的新变量**：如果变量提前在循环外面声明，循环头里用 `=` 赋值，那么不管什么 Go 版本，所有轮次读写的当然还是外头那同一个变量：

```go
var word string
for _, word = range words {
	fmt.Println(word)
}
```

另外，“每轮创建新变量”改变的只是迭代变量自身的实例归属，并不改变 [4.4.4 节](#ch4-4-4)讲的值复制规则——每轮新变量里装的依然是容器元素的副本，直接改它照样不会写回原切片。

### 4.4.6 标签控制外层循环 {#ch4-4-6}

无标签的 `break` 和 `continue` 只管最内层结构。在嵌套循环里如果想从内层一步跳出或跳到外层下一轮，可以给外层 `for` 贴上标签（Label）：

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

`continue label` 指向的标签必须贴在包裹当前语句的某层 `for` 上；`break label` 则可以贴在包裹当前语句的 `for`、`switch` 或 `select` 上。标签位于独立命名空间，不会与同名变量冲突；当抽一个小函数通过 `return` 返回比贴标签更好读时，优先抽函数，确实能让嵌套扫描更直观时再用具名清晰的标签。

### 4.4.7 选择循环形式 {#ch4-4-7}

- **顺序遍历集合或流**：遍历数组、切片、字符串、映射、通道或迭代器时，默认用 `for range`。
- **自定义起止位置或步长**：需要从非零下标起步、跳步前进或倒序扫描时，用三段式 `for`。
- **围绕单一动态条件循环**：退出时机不固定在步数上时，用单条件 `for cond`。
- **至少先跑一轮再判退出**：用无限 `for` 配合末尾 `if ... { break }`。
- **区分字符串的码点与字节**：按字符（码点）遍历必须用 `for range`；三段式 `for i := 0; i < len(s); i++` 走的是原始字节，只在明确按字节扫描 ASCII 或二进制协议时使用。

## 4.5 `switch` 语句 {#ch4-5}

表达式 `switch` 先执行可选的初始化语句、算出待匹配表达式的值，再按源码从上到下的顺序逐一比对各个 `case`，只运行第一个命中的分支；省略待匹配表达式时等价于 `switch true`（无表达式 `switch`）。`default` 最多只能写一个，不管摆在开头还是末尾，都只在所有 `case` 均未命中时兜底执行。

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

同一个 `case` 可以用逗号并列多个候选值（逻辑“或”）。待匹配值与 `case` 候选值之间必须能做 `==` 判等，因此切片、映射和函数不能直接拿来 `switch`；如果不同 `case` 里写了重复的常量值，编译器会直接报错。作用域上，初始化语句声明的变量（如 `size`）在整个 `switch` 隐式块内可见，而每个 `case` 和 `default` 自身又各是一个独立的隐式子块，互不干扰。

与 C、Java 不同，Go 的 `switch` **每个分支跑完后自动退出，默认不会往下贯穿**，也不用专门写 `break`；空分支（如 `case 0:` 下方不写语句）就表示“命中后什么也不做并直接结束”，不会滑进下一个 `case`。极少数真要无条件贯穿到紧邻下一个分支时，必须在分支最后一行显式写 `fallthrough`——注意它会**直接跳过下一个 `case` 的条件判断**强行执行其语句体，且不能写在最后一个分支或类型 `switch` 里。日常编码几乎总能用逗号合并 `case` 或提取辅助函数代替 `fallthrough`。

另一个常见易错点是**循环里套 `switch`**：在 `case` 里写不带标签的 `break`，跳出的只是这层 `switch`，外面的 `for` 循环还会接着跑下一轮！想在 `case` 里直接终结外层循环，必须给外层 `for` 打标签并写 `break loop`：

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

省略 `switch` 后面的表达式即等价于 `switch true`，每个 `case` 都可以写任意结果为 `bool` 的条件表达式，写起来比一长串 `if ... else if ...` 更整齐：

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

同样因为只执行第一个为 `true` 的分支，存在包含关系的条件（如 `n%6 == 0` 被包含在 `n%2 == 0` 内）必须把范围更窄的条件排在前面。

### 4.5.2 在 `if` 和 `switch` 之间选择 {#ch4-5-2}

只有一两个分支、用作卫语句提前返回（如 `if err != nil { return err }`），或者下一步判断依赖前一步刚算出的局部结果时，直接写 `if` 最自然。当围绕同一个值匹配多种离散状态，或针对同一决策按优先级划分三四个以上互斥区间时，`switch` 的视觉结构更清晰。不过不要为了少写几个 `if`，把完全风马牛不相及的几个布尔条件硬塞进同一个无表达式 `switch` 里。专门用于判断接口动态类型的类型 `switch`（`switch v := x.(type)`）详见[第 7 章的类型分支小节](./chapter-07#ch7-7-3)。

## 4.6 `goto` 语句 {#ch4-6}

`goto label` 会无条件跳转到当前函数体内的同名标签处。标签作用域覆盖整个函数体（且声明了却不用会编译报错），但语言规范设下了两条硬禁令：**不允许从外层跳进任何内层块**，也**不允许向前跳过当前块内后续会进入作用域的变量声明**：

```go
goto done
value := 10 // 编译失败：goto 跳过了变量 value 的声明
done:
fmt.Println(value)
```

这两条编译期规则堵死了“跳过初始化直接读脏变量”的漏洞，但随意跳转依然会让控制流难以追踪。绝大部分提前退出、跳出多层循环或资源收尾的需求，用卫语句 `return`、带标签的 `break`/`continue`、`defer` 或拆小函数都能写得更清楚；只有在极少数性能敏感或深层状态机代码里，用上述手段反而造成严重重复时，才考虑短距离向后跳转到函数末尾的统一收尾块。

## 练习 {#ch4-exercises}

以下四题分别检验嵌套块变量隐藏、分支优先级排错、循环变量跨版本行为以及 `range` 数据源快照与元素副本的差别。代码片段均位于 `main` 函数内，且已导入标准库 `"fmt"`。建议先独立推理作答，再展开核对参考答案。

### 练习 1：追踪作用域与变量隐藏

不运行程序，写出三次打印输出，并说明 `if` 初始化子句右侧的 `x`、条件与分支体内的 `x`，以及走出 `if` 后的 `x` 各自绑定到哪一处声明。

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

`if` 初始化子句右侧的 `x+1` 在新声明生效之前求值，因此读到的是外层 `x`（`10`）；该条短声明结束后，`if` 隐式块里的 `x`（`11`）和 `y`（`20`）进入作用域，供条件 `x < y` 和分支体内第一行打印使用。随后 `x := 30` 在花括号显式块内又新建了第三层同名变量 `x`，只在这对花括号内部隐藏了隐式块的 `x`。整条 `if` 结束后，内层两级变量全部离开作用域，最后一行打印的是从未被改过的最外层 `x`（`10`）。

</details>

### 练习 2：找出分类分支的顺序错误

已知成绩是 `[0, 100]` 范围内的整数，需求规定 `90` 分及以上输出 `优秀`、`60`～`89` 分输出 `通过`、其余输出 `未通过`。写出以下代码的实际输出，指出判错的分数段；只调整 `case` 顺序修复 Bug，并结合 `59`、`60`、`89`、`90` 四个边界值解释原因。

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

原代码实际输出：

```text
未通过
通过
通过
通过
```

所有落在 `[90, 100]` 的分数都会先满足第一个条件 `score >= 60` 并立即退出 `switch`，导致排在后面的 `case score >= 90` 变成永远走不到的死分支。把更具体的条件挪到前面即可修复：

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

`59` 两个 `case` 都不满足，落入 `default`；`60` 和 `89` 不满足首个 `>= 90`，往下命中 `>= 60`；`90` 直接命中首个 `>= 90`。因为 `switch` 只执行第一个匹配的分支，排在后面的 `score >= 60` 天然隐含了“`score < 90`”的前提（见 [4.5.1 节](#ch4-5-1)）。

</details>

### 练习 3：避免依赖版本的迭代变量地址

当模块的 `go.mod` 语言版本分别设为 `go 1.21` 与 `go 1.22` 时，循环结束后 `pointers` 里的三个指针是否指向同一地址、解引用分别读到什么值？再改写循环，使它在两种语言版本下都能稳定读出 `1`、`2`、`3`。

```go
values := []int{1, 2, 3}
var pointers []*int
for _, value := range values {
	pointers = append(pointers, &value)
}
```

<details>
<summary>查看参考答案</summary>

在 `go 1.21` 语言版本下，整轮循环共用同一个 `value` 变量，三个指针装的是同一个地址，解引用全都读到最后一轮覆盖进去的 `3`。在 `go 1.22` 及更新语言版本下，循环头 `:=` 声明的 `value` 每轮新建实例，三个指针指向不同变量，解引用依次读到 `1`、`2`、`3`。

在循环体花括号内显式声明局部副本（或者在不需要独立副本时直接按索引取原切片元素地址 `&values[i]`），即可不依赖模块语言版本保证每轮地址独立：

```go
for i := range values {
	value := values[i]
	pointers = append(pointers, &value)
}
```

循环体显式块里的 `value` 每执行一轮都会重新声明一个新变量，因此在任何 Go 版本下三个指针都互不干扰。

</details>

### 练习 4：区分数据源副本与元素副本

把下面代码中 `range` 右侧的数据源分别换成 `a`、`a[:]`、`&a`（其余语句不变，每次都从初始数组 `[3]int{1, 2, 3}` 开始跑）。写出三种写法在循环内外的全部输出，解释首轮执行的 `a[1] = 9` 为何会或不会改变第二轮读到的值，并说明 `value *= 10` 会不会改写原数组 `a`。

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

数据源写为值数组 `a` 时输出：

```text
0 10
1 20
2 30
[1 9 3]
```

数据源写为切片 `a[:]` 或数组指针 `&a` 时，输出同为：

```text
0 10
1 90
2 30
[1 9 3]
```

这里同时接收了 `i` 和 `value`：当数据源是值数组 `a` 时，进入循环前对 `a` 求值会把整块 `[3]int` 拷出一份快照，后续每轮从快照取值，所以第 0 轮改写原数组的 `a[1] = 9` 改不到快照里的第 1 号元素（仍读出 `2`）。而当数据源是切片 `a[:]` 或数组指针 `&a` 时，入口处只复制了切片描述符或指针，底层指的还是原数组 `a`，于是第 1 轮就读到了刚改过的 `9`。

三种写法下，赋给 `value` 的始终只是当前轮次元素的值副本，`value *= 10` 只改局部副本，绝不会写回原数组 `a`（因此最后 `a` 都是 `[1 9 3]`，见 [4.4.4 节](#ch4-4-4)）。

</details>

## 面试题 {#ch4-interview}

以下四题检验循环内嵌 `switch` 的跳转目标、`fallthrough` 规则、`goto` 编译期禁令以及整数 `range` 的版本控制边界。面试题 2 的代码上下文与导入约定同[练习部分](#ch4-exercises)。建议先独立作答，再展开核对参考答案。

### 面试题 1：循环里的 `switch` 如何选择跳转目标？

当 `for` 循环内部嵌套 `switch` 时，`case` 分支里的无标签 `break` 和无标签 `continue` 分别作用于哪一层结构？想从 `case` 里直接终止外层循环该怎么写？

<details>
<summary>查看参考答案</summary>

`case` 里的无标签 `break` **只跳出当前这层 `switch`**，外层 `for` 循环会继续跑下一轮；而由于 `continue` 只对循环有意义，无标签 `continue` 会直接作用于包裹该 `switch` 的最内层 `for` 循环，跳入下一轮迭代。想从 `switch`（或多层循环）内部直接终止指定的外层循环，需要给目标 `for` 语句加上标签并写 `break label`。

</details>

### 面试题 2：`fallthrough` 会检查下一分支的条件吗？

写出下面代码的输出。如果在 `fallthrough` 后面、下一个 `case` 之前再加一行 `fmt.Println("after")`，能否通过编译？

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

依次输出 `A`、`B`。`fallthrough` 会跳过紧邻下一个分支的条件判断（哪怕 `n > 10` 为 `false` 也不检查），直接进入其分支体执行；第二个分支末尾没有再写 `fallthrough`，打印完 `"B"` 就正常结束整个 `switch`，不会落进 `default`。

在 `fallthrough` 后面再加语句无法通过编译（报错 `fallthrough statement out of place`）：[语言规范](https://go.dev/ref/spec#Fallthrough_statements)规定 `fallthrough` 必须是当前分支里的最后一条非空语句。

</details>

### 面试题 3：`goto` 可以跳入 `if` 块或跳过变量声明吗？

<details>
<summary>查看参考答案</summary>

都不可以。语言规范在编译期同时禁止两件事：一是不能用 `goto` 从外层跳进任何内层块（如 `if`、`for`、`switch` 分支块或显式花括号块）；二是不能在同一块或外层块内向前跳过后续会进入作用域的变量声明语句，以此保证跳转落点处绝不会读到未初始化的变量。

</details>

### 面试题 4：`for range 100` 从哪个版本开始可用？

<details>
<summary>查看参考答案</summary>

整数 `range` 自 **Go 1.22** 语言版本起可用。它能否编译通过取决于当前包所属 `go.mod` 中 `go` 指令声明的语言版本，而不只看本机装了什么版本的编译器：如果本地工具链是 Go 1.22+，但 `go.mod` 里还写着 `go 1.21` 或更低版本，编译器仍会拒绝该语法，需先上调 `go.mod` 的 `go` 版本或改回传统三段式 `for`。

</details>

## 参考资料

- [Go 语言规范：代码块（Blocks）](https://go.dev/ref/spec#Blocks)
- [Go 语言规范：声明与作用域（Declarations and scope）](https://go.dev/ref/spec#Declarations_and_scope)
- [Go 语言规范：短变量声明（Short variable declarations）](https://go.dev/ref/spec#Short_variable_declarations)
- [Go 语言规范：`if` 语句](https://go.dev/ref/spec#If_statements)
- [Go 语言规范：`for` 语句与 `range` 子句](https://go.dev/ref/spec#For_statements)
- [Go 语言规范：长度与容量常量求值条件（`len` and `cap`）](https://go.dev/ref/spec#Length_and_capacity)
- [Go 语言规范：表达式 `switch`](https://go.dev/ref/spec#Expression_switches)
- [Go 语言规范：`fallthrough` 语句](https://go.dev/ref/spec#Fallthrough_statements)
- [Go 语言规范：`break` 语句](https://go.dev/ref/spec#Break_statements)
- [Go 语言规范：`continue` 语句](https://go.dev/ref/spec#Continue_statements)
- [Go 语言规范：`goto` 语句](https://go.dev/ref/spec#Goto_statements)
- [Go 语言规范：`return` 语句与具名返回值遮蔽限制](https://go.dev/ref/spec#Return_statements)
- [Go 1.22 发布说明：循环变量语义与整数 `range`](https://go.dev/doc/go1.22#language)
- [Go 1.23 发布说明：迭代器函数 `range`](https://go.dev/doc/go1.23#language)
- [Go 模块参考：`go` 指令与语言版本](https://go.dev/doc/modules/gomod-ref#go)
- [`go vet` 命令：内置分析器参考](https://pkg.go.dev/cmd/vet)
- [`shadow` 分析器：排查潜在的变量隐藏](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/shadow)
- [Go 标准库 `iter`：迭代器签名与约定](https://pkg.go.dev/iter)
- [Go 标准库 `maps.Keys`：返回映射键迭代器](https://pkg.go.dev/maps#Keys)
- [Go 标准库 `slices.Sorted`：收集迭代器元素并排序](https://pkg.go.dev/slices#Sorted)
- [Go 标准库 `math/rand/v2`：`IntN`](https://pkg.go.dev/math/rand/v2#IntN)
