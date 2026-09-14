---
title: 第 2 章 基础类型和变量声明
description: Go 的预声明类型、零值、字面量、变量声明、常量与命名惯例。
---

# 第 2 章 基础类型和变量声明

## 本章要点

本章围绕变量的零值、类型边界和声明方式展开：先确定变量未初始化时的行为，再区分字面量、无类型常量和有类型值，最后选择能表达意图的声明形式。完成本章后，你应能判断赋值或运算是否需要显式转换，解释常量为何在编译期失败，并在 `var`、`:=` 和 `const` 之间做出清晰选择。

Go 的类型系统强调“明确表达意图”：没有隐式数值提升，也不会把任意数字或字符串当作布尔值。掌握零值、显式转换和常量的可表示性，比记住所有声明形式更重要。

> 核对日期：2026 年 9 月 14 日；实验环境为 Go 1.27.1、Windows/AMD64。
>
> `strings.CutPrefix` 需要 Go 1.20 或更新版本。

## 2.1 零值：未初始化也有确定的值 {#ch2-1}

变量声明后如果没有显式初始值，会得到该类型的零值：

| 类型 | 零值 |
| --- | --- |
| `bool` | `false` |
| 整数、浮点数 | `0` |
| 复数 | `0 + 0i` |
| `string` | `""` |
| 指针、切片、映射、函数、通道、接口 | `nil` |
| 数组、结构体 | 每个元素或字段各自的零值 |

零值是语言保证，不是“内存恰好被清零”的偶然现象。应优先设计成零值有意义的类型，这样调用方可以直接声明并使用变量，而不必先调用额外的构造函数。

```go
var count int
var ready bool
var name string
var tags []string

fmt.Println(count, ready, name == "", tags == nil)
// 0 false true true
```

`nil` 不是所有类型都能使用的通用值。例如，整数和结构体没有 `nil` 零值；[切片](./chapter-03#ch3-2)、[映射](./chapter-03#ch3-4)等虽然都可以为 `nil`，但它们对读写的行为并不相同。

## 2.2 字面量 {#ch2-2}

字面量是直接写在源代码中的值。本节的整数、浮点数、虚数、字符和字符串字面量都是无类型常量，在需要时才确定具体类型；[第 3 章的数组、切片等复合字面量](./chapter-03#ch3-1)则有明确类型。

### 2.2.1 整数

```go
42          // 十进制
0b101010    // 二进制
0o755       // 八进制
0x2a        // 十六进制
1_000_000   // 下划线只改善可读性
```

旧式的 `010` 也表示八进制，但容易被误读；新代码优先使用意图更清晰的 `0o10`。下划线只能紧跟在进制前缀后，或出现在两个连续数字之间；因此不能位于数字开头或结尾，也不能连续出现，`1_.0`、`1._0` 和 `1e_3` 都不合法。

### 2.2.2 浮点数和复数

```go
3.14
6.03e23
0x1.2p5       // 十六进制浮点字面量
1.5i           // 虚数字面量
```

`0x1.2p5` 表示十六进制的 `1.2` 乘以 `2⁵`，即十进制的 `36`；这里的 `p` 指定二进制指数。字面量作为常量时不立即受 `float64` 精度限制，赋给具体浮点类型后才按其精度舍入。虚数字面量可组成复数表达式，例如 `2 + 1.5i`。

### 2.2.3 字符与字符串

字符（rune）字面量使用单引号，表示一个 Unicode 代码点，默认类型为 `rune`：

```go
'A'
'中'
'\n'
'\u4E2D'
```

解释型字符串使用双引号，会处理转义；原始字符串使用反引号，不处理转义并可跨行，但不能包含反引号，源码中的回车符 `\r` 会被移除：

```go
interpreted := "line1\nline2"
raw := `line1
line2`
```

`string` 的零值是 `""`。字符串可以用 `==`、`!=` 比较是否相等，用 `<`、`<=`、`>`、`>=` 按字节的字典序比较，也可以用 `+` 拼接。字符串的内容不可修改：可以给字符串变量重新赋值，但不能给 `s[i]` 赋值。

字符串的底层是不可变字节序列；字符串与 UTF-8、`byte`、`rune` 的关系在 [3.3 节](./chapter-03#ch3-3)展开。

## 2.3 布尔与数值类型 {#ch2-3}

### 2.3.1 布尔值

`bool` 只有 `true` 和 `false` 两个值，零值是 `false`。Go 不会把数字、字符串、指针或集合隐式当作布尔值；条件必须产生 `bool`。

```go
ready := true
hasItems := count > 0
canStart := ready && hasItems
shouldWait := !ready || !hasItems
```

`!` 表示逻辑非，`&&` 表示逻辑与，`||` 表示逻辑或。`&&` 和 `||` 会短路求值：结果由左侧决定时，右侧表达式不会执行。可以利用这个规则先检查边界，再访问数据，例如 `i >= 0 && i < len(items) && items[i] != ""`。这里的条件判断会在 [4.3 节](./chapter-04#ch4-3)展开。

### 2.3.2 整数

Go 提供有符号和无符号整数：

| 类型 | 位宽 | 取值范围 |
| --- | ---: | --- |
| `int8` | 8 | -2⁷～2⁷-1 |
| `int16` | 16 | -2¹⁵～2¹⁵-1 |
| `int32` | 32 | -2³¹～2³¹-1 |
| `int64` | 64 | -2⁶³～2⁶³-1 |
| `uint8` | 8 | 0～2⁸-1 |
| `uint16` | 16 | 0～2¹⁶-1 |
| `uint32` | 32 | 0～2³²-1 |
| `uint64` | 64 | 0～2⁶⁴-1 |

另外还有：

- `byte` 是 `uint8` 的别名，适合表示原始字节。
- `rune` 是 `int32` 的别名，适合表示 Unicode 代码点。
- `int` 和 `uint` 的宽度相同，为 32 位或 64 位，取决于实现；普通索引、计数和长度通常使用 `int`。
- `uintptr` 用于保存指针的整数表示，属于底层互操作场景，不应作为普通整数使用。

协议、文件格式或二进制布局明确要求位宽时，使用 `int32`、`uint64` 等固定宽度类型；普通业务逻辑优先使用 `int`。即使位宽相同，`int`、`int32` 和 `int64` 仍是不同的 Go 类型。

整数支持 `+`、`-`、`*`、`/`、`%`，比较运算，以及 `&`、`|`、`^`、`&^`、`<<`、`>>` 等位运算。`&^` 表示按位清除右操作数中为 1 的位；这些二元算术和位运算也有 `+=`、`&^=` 等复合赋值形式。`++`、`--` 是语句，不能写成 `y := x++`。

整数除法向零截断，例如 `-7 / 3 == -2`，取余满足 `-7 % 3 == -1`。整数除法的除数若是零常量，编译时就会报错；若执行时变量的值为零，则触发 `panic`。整数变量运算可以溢出且不会因此自动 `panic`：无符号整数按模 `2ⁿ` 运算，有符号加减乘等运算按对应位宽的补码规则产生结果。业务上不允许溢出时，需要自行检查范围。

### 2.3.3 浮点数

`float32` 和 `float64` 分别采用 IEEE 754 的 32 位和 64 位二进制浮点表示，约有 6～7 位和 15～16 位十进制有效数字，并非固定数量的小数位。除非需要兼容外部格式或已测量确认内存占用是问题，否则优先使用 `float64`。

浮点数能精确表示部分十进制数（如 `0.5`），但不能精确表示 `0.1` 这样的值。`==` 比较的是实际保存的值，不是“足够接近”；近似计算应根据问题选择绝对误差、相对误差或二者结合。金额等要求精确十进制语义的场景，通常使用以最小单位计数的整数或专用十进制库。

在本章使用的官方 Go 工具链上，有限非零浮点变量除以零得到正负无穷，零除以零得到 `NaN`；可用 `math.IsNaN`、`math.IsInf` 判断。语言规范把浮点除零是否触发运行时 `panic` 留给实现，因此不要把本机现象泛化到所有实现。整个除法表达式若是常量表达式（如 `1.0 / 0.0`），会在编译期报错；但 `x := 1.0` 后的 `x / 0.0` 是变量运算，不会仅因除数是零常量而被拒绝。

### 2.3.4 复数

```go
z := complex(2.5, 3.1) // 默认 complex128
fmt.Println(real(z), imag(z))
```

`complex64` 的实部、虚部是 `float32`；`complex128` 的实部、虚部是 `float64`。复数运算同样继承浮点数的近似特性，需要更复杂的函数时使用 `math/cmplx`。

`complex` 的两个有类型参数必须具有相同的浮点类型；一个是无类型常量时，须能转换为另一个参数的类型。两个参数都是合适的无类型常量时，结果也是无类型复数常量。`float32` 和 `float64` 变量混用不会自动提升。复数支持四则运算及 `==`、`!=`，不支持大小比较或 `%`。

## 2.4 显式类型转换 {#ch2-4}

Go 不允许变量之间自动类型提升。不同的数值类型进行赋值或运算时，必须显式转换：

```go
var x int = 10
var y float64 = 30.2

sum := float64(x) + y
whole := x + int(y) // 小数部分被截去
fmt.Println(sum, whole) // 40.2 40
```

转换可能丢失信息：整数变量转为较窄整数时会截去高位，浮点变量转为整数时会向零截去小数部分；浮点值超出目标整数范围时，结果依赖实现。无类型常量则在编译期检查目标类型能否表示该值：

```go
var a byte = 255  // 合法
// var b byte = 256 // 编译错误：常量溢出 byte
var c int = 20.0  // 合法：该无类型常量的值是整数 20
// var d int = 20.5 // 编译错误：常量有小数部分
```

原文“浮点字面量不能赋给整型变量”的说法过于绝对。能否赋值取决于常量值是否可表示，而非字面量是否带小数点；已经有 `float64` 类型的变量则仍需显式转换。

Go 不支持把数字、字符串或指针直接转换为 `bool`。应使用明确的比较，例如 `x != 0` 或 `s != ""`。

## 2.5 无类型常量与默认类型 {#ch2-5}

无类型常量没有固定的机器类型，因此在可表示的前提下可以赋给不同类型：

```go
const value = 10
var i int = value
var f float64 = value
var b byte = value
```

无类型不等于没有约束：常量仍有布尔、整数、浮点等种类。需要默认类型时，规则是布尔值为 `bool`，整数为 `int`，浮点数为 `float64`，字符为 `rune`，字符串为 `string`，复数为 `complex128`。例如 `x := 20.0` 推导为 `float64`，而 `var x int = 20.0` 使用显式指定的 `int`。

数值常量在编译期计算，精度不按普通运行时变量处理；实现仍可限制支持的常量精度。无类型整数常量可以大于任何整数类型的最大值，但一旦放进变量，就必须满足目标类型的范围。

有类型常量则遵守普通类型检查：

```go
const typedValue int = 10
// var f float64 = typedValue // 编译错误
```

数学常量通常保持无类型以获得更大灵活性；需要通过 API 强制类型边界时，再声明为有类型常量。

## 2.6 `var`、`:=` 与 `const` {#ch2-6}

### 2.6.1 `var` 变量声明 {#ch2-6-var}

`var` 可以出现在包级或函数内部，可以显式指定类型、依赖零值，也可以声明多个变量：

```go
var count int
var limit = 10
var x, y int = 1, 2

var (
	name    = "Go"
	version int = 1
)
```

### 2.6.2 `:=` 短变量声明 {#ch2-6-short-variable-declaration}

短变量声明只能在函数内部使用，左侧至少要有一个新的非空白变量。已经在同一代码块中声明、或已经出现在当前函数参数列表中的变量，可以在类型相同的前提下通过包含新变量的短声明重新赋值：

```go
x := 10
x, y := 20, "hello" // x 重新赋值，y 是新变量
```

在函数体中，短声明也可以给参数重新赋值，只要同时引入至少一个新变量。下面的示例需要导入标准库 `strings`：

```go
func normalize(input string) (string, bool) {
	input, changed := strings.CutPrefix(input, "-") // input 是参数，changed 是新变量
	return input, changed
}
```

如果 `x` 只在外层代码块声明，内层的 `x := ...` 会创建新变量，隐藏外层 `x`；详见 [4.2 节](./chapter-04#ch4-2)。单独写 `_` 不算新变量，只给已有变量赋新值时应使用 `=`。

最常见的函数内声明方式是 `:=`。以下情况使用 `var` 更能表达意图：

- 明确表示“从零值开始”：`var count int`。
- 需要指定与字面量默认类型不同的类型：`var id int32 = 20`。
- 担心短声明在内层作用域意外隐藏外层变量时，先显式声明，再使用 `=`。

### 2.6.3 `const` 常量声明 {#ch2-6-const}

`const` 可用于包级或函数内部，只能保存编译期可确定的布尔、数值或字符串值，以及符合常量规则的表达式。下面的 `time.Second` 需要导入标准库 `time`：

```go
const (
	readTimeout = 5 * time.Second
	serviceName = "billing"
)
```

常量可以由表达式计算得到，不限于字面量；但普通函数调用的结果和依赖变量的表达式通常不是常量。`len`、`cap`、`complex` 等内置函数也只有满足规范条件时才能出现在常量表达式中，例如 `len("Go")` 是常量，切片变量的长度不是常量。Go 没有把任意变量声明为只读的通用语法，也不能用 `const` 保存数组、切片、映射或结构体。

## 2.7 变量的使用与命名 {#ch2-7}

函数内声明的局部变量必须至少被读取一次，否则编译失败；包级变量允许未使用，但可变的包级状态会增加数据流分析和并发维护的难度，应谨慎使用。未使用的常量不会报错，因为它们没有运行时副作用。

这项检查不保证每次赋值都被使用。例如 `x := 10; x = 20; fmt.Println(x); x = 30` 可以编译，虽然初始的 `10` 和最后的 `30` 都没有被读取。

另一个独立规则是：导入的包必须在该文件中使用，除非明确采用空白导入。

命名规则允许 Unicode 标识符，但清晰和可输入比“能编译”更重要：

- 多词标识符使用驼峰式，如 `requestCount`，不使用蛇形命名。
- 小作用域使用短名（如循环索引 `i`、键值 `k`/`v`）；包级名称应更具描述性。
- 不用全大写下划线表示常量；首字母大小写还承担包外可见性的含义。
- 避免相似 Unicode 码点、无意义下划线和把类型名重复塞进变量名。

## 2.8 练习 {#ch2-exercises}

三题对应原书第 2 章练习。每题单独建立程序，先运行自己的实现，再展开参考答案。

### 练习 1：整数转浮点数

声明一个值为 `20` 的 `int` 变量，将它转换为 `float64` 后打印两个变量。

<details>
<summary>查看参考答案</summary>

```go
package main

import "fmt"

func main() {
	var i int = 20
	var f float64 = float64(i)

	fmt.Printf("i = %v (%T), f = %v (%T)\n", i, i, f, f)
}
```

输出：

```text
i = 20 (int), f = 20 (float64)
```

Go 不会自动把 `int` 提升为 `float64`，因此必须显式写出 `float64(i)`。

</details>

### 练习 2：无类型常量

声明一个无类型常量，使它既能赋给整数变量，也能赋给浮点变量，并打印两个结果。

<details>
<summary>查看参考答案</summary>

```go
package main

import "fmt"

func main() {
	const value = 20

	var i int = value
	var f float64 = value

	fmt.Printf("i = %v (%T), f = %v (%T)\n", i, i, f, f)
}
```

输出：

```text
i = 20 (int), f = 20 (float64)
```

`value` 没有显式类型，只要值能由目标类型表示，就可以直接赋值。

</details>

### 练习 3：整数溢出

声明 `byte`、`int32` 和 `uint64` 变量，分别初始化为各自类型的最大值，再加 `1`，观察运行时结果。思考：如果把这些值写成常量并在编译期加 `1`，结果有什么不同？

<details>
<summary>查看参考答案</summary>

```go
package main

import (
	"fmt"
	"math"
)

func main() {
	var b byte = math.MaxUint8
	var smallI int32 = math.MaxInt32
	var bigI uint64 = math.MaxUint64

	b++
	smallI++
	bigI++

	fmt.Println(b)
	fmt.Println(smallI)
	fmt.Println(bigI)
}
```

输出：

```text
0
-2147483648
0
```

`math.MaxUint8`、`math.MaxInt32` 和 `math.MaxUint64` 是带语义的无类型整数常量；赋值时分别落到 `byte`、`int32` 和 `uint64`。

运行时整数运算可以溢出，结果仍按目标整数类型表示，不会自动 `panic`。无类型常量本身可以保存更大的精确整数，但把超出范围的常量赋给 `byte`、`int32` 或 `uint64` 时，编译器会报告溢出。例如 `var b byte = math.MaxUint8 + 1` 无法通过编译。

</details>

## 实验 {#ch2-experiments}

### 实验 1：常量类型与可表示性

验证目标：区分无类型常量与有类型常量的赋值规则，并确认不可表示的常量会在编译期被拒绝。

保留下面三个常量，每次只选 A～H 中的一条声明放入 `main`，并用 `fmt.Printf("%T %v\n", 变量, 变量)` 打印结果。

```go
const flexible = 255
const fixed uint16 = 255
const tooLarge = 256

var a uint8 = flexible  // A
var b uint16 = flexible // B
var c uint8 = fixed     // C
var d = uint8(fixed)    // D
var e uint8 = tooLarge  // E
var f = uint8(tooLarge) // F
var g int = 20.0        // G
var h int = 20.5        // H
```

先预测并运行验证，再回答：

1. 逐条预测 A～H 能否通过编译；失败项写明触发的是“常量可表示性”还是“有类型值的赋值兼容性”。
2. 对能编译的语句，预测变量的静态类型和值。
3. 解释 C 与 D 唯一改变的条件为什么可能改变编译结果。

<details>
<summary>查看参考答案与解释</summary>

| 语句 | 结果 | 静态类型和值 / 失败原因 |
| --- | --- | --- |
| A | 通过 | `a` 是 `uint8`，值为 `255` |
| B | 通过 | `b` 是 `uint16`，值为 `255` |
| C | 失败 | `fixed` 已是 `uint16`，不能直接赋给 `uint8`；这是有类型值的赋值兼容性问题 |
| D | 通过 | `d` 是 `uint8`，值为 `255` |
| E | 失败 | 无类型常量 `256` 不能由 `uint8` 表示 |
| F | 失败 | 常量转换仍检查可表示性，`256` 会溢出 `uint8` |
| G | 通过 | `g` 是 `int`，值为 `20`；常量没有小数部分 |
| H | 失败 | `20.5` 无法由整数表示 |

`flexible` 是无类型常量。把它赋给具体类型时，只要值能由目标类型表示即可，所以 A、B 都成立。`fixed` 已经具有 `uint16` 类型；虽然它的值 `255` 能放进 `uint8`，C 也不会发生隐式数值转换。

D 明确写出了 `uint8(fixed)`。对常量进行这种显式转换时，编译器检查常量值是否可由目标类型表示；`255` 满足条件，所以转换成功。显式转换只解决了 C 的类型不兼容问题，不会绕过可表示性检查，这正是 F 仍然失败的原因。

</details>

### 实验 2：整数转换与运行时边界

验证目标：观察运行时整数转换如何截断高位并按目标类型重新解释结果，确认转换本身不会因信息丢失而 `panic`。

```go
package main

import "fmt"

func main() {
	inRange := 255
	tooWide := 260
	negative := -1
	fmt.Printf("A %T %d\n", uint8(inRange), uint8(inRange))
	fmt.Printf("B %T %d\n", uint8(tooWide), uint8(tooWide))
	fmt.Printf("C %T %d\n", uint8(negative), uint8(negative))
}
```

先预测并运行验证，再回答：

1. 预测程序能否编译、是否会 `panic`，并逐行写出 A、B、C 的类型和值。
2. 说明 `255 -> uint8`、`260 -> uint8`、`-1 -> uint8` 各自保留或丢弃了哪些整数表示信息。

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A uint8 255
B uint8 4
C uint8 255
```

三个源操作数都是 `int` 变量，因此这里发生的是运行时整数值转换，而不是常量转换：

- `255` 的二进制值能由 8 位无符号整数完整表示，信息没有丢失。
- `260` 对 `2^8` 取模后为 `4`，高于最低 8 位的信息被丢弃。
- `-1` 转为 8 位无符号整数后得到与它模 `2^8` 同余的 `255`；目标类型不再保留“负数”这一符号解释。

转换为宽度为 `n` 的整数类型时，结果保留足以形成目标位宽的低位，再按目标类型的有符号或无符号规则解释。整数转换本身不会因为截断或符号改变而 `panic`。

</details>

### 实验 3：整数除零的错误阶段

验证目标：对比常量除零与变量除零，确认错误分别发生在编译期和运行期。

以下三个场景视为三个互不影响的独立程序：

```go
// nonzero.go 的 main
divisor := 3
fmt.Println(12 / divisor)

// const_zero.go 的 main
const divisor = 0
fmt.Println(12 / divisor)

// runtime_zero.go 的 main
divisor := 3
fmt.Println(12 / divisor)
divisor = 0
fmt.Println(12 / divisor)
```

先预测并运行验证，再回答：

1. 分别预测三个场景能否编译、能执行到哪一行，以及失败发生在编译期还是运行期。
2. 对 `nonzero.go` 和 `runtime_zero.go`，逐行预测实际打印值或失败位置。
3. 对两个零除数场景，明确预测证据来自编译器诊断还是运行时 `panic`，并解释判断依据。

<details>
<summary>查看参考答案与解释</summary>

| 场景 | 编译 | 执行结果 | 失败阶段 |
| --- | --- | --- | --- |
| `nonzero.go` | 通过 | 打印 `4` | 不失败 |
| `const_zero.go` | 失败 | 不会开始执行 | 编译期 |
| `runtime_zero.go` | 通过 | 先打印 `4`，随后在第二个 `Println` 的除法求值处 `panic` | 运行期 |

`const_zero.go` 中的除数是值为零的常量，表达式 `12 / divisor` 是非法常量运算，编译器会直接报告除零错误。

`runtime_zero.go` 中的 `divisor` 是变量。编译器允许除法表达式，执行时才读取它的当前值。第一次读取到 `3`，所以打印 `4`；赋值为 `0` 后，第二次整数除法触发 `panic: runtime error: integer divide by zero`。参数必须先求值，因而第二个 `fmt.Println` 本身没有机会打印结果。

</details>

### 实验 4：定宽整数运算溢出

验证目标：观察有符号和无符号定宽整数越过边界后的结果，并与编译期常量溢出区分开。

```go
package main

import "fmt"

func main() {
	normalSigned := int8(126)
	normalSigned++
	fmt.Printf("A %T %d\n", normalSigned, normalSigned)

	maxSigned := int8(127)
	maxSigned++
	fmt.Printf("B %T %d\n", maxSigned, maxSigned)

	normalUnsigned := uint8(1)
	normalUnsigned--
	fmt.Printf("C %T %d\n", normalUnsigned, normalUnsigned)

	minUnsigned := uint8(0)
	minUnsigned--
	fmt.Printf("D %T %d\n", minUnsigned, minUnsigned)
}
```

先预测并运行验证，再回答：

1. 预测程序能否编译、是否会 `panic`，并逐行写出 A～D 的类型和值。
2. 对比 A/B，只解释初值从 `126` 变为 `127` 后的差异；对比 C/D，只解释初值从 `1` 变为 `0` 后的差异。
3. 说明这些变量运算与“常量表达式直接写出越界结果”为什么不能共用同一份证据。

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A int8 127
B int8 -128
C uint8 0
D uint8 255
```

A 的加法结果仍在 `int8` 范围内。B 从 `int8` 最大值继续加一，按 8 位整数表示回绕为 `-128`。C 的减法结果仍在 `uint8` 范围内；D 从无符号最小值减一，按模 `2^8` 运算得到 `255`。

这里的 `++`、`--` 操作数都是变量，属于运行时整数运算。Go 允许整数变量运算溢出，并按该整数类型产生确定的表示结果，不会自动 `panic`。常量表达式在编译期保持精确值；若最终值不能由所需类型表示，例如 `var x int8 = 127 + 1`，编译器会拒绝程序。因此两类代码验证的是不同阶段的规则。

</details>

### 实验 5：短变量声明与作用域

验证目标：对比同一代码块中的重新赋值与内层代码块中的变量隐藏，并确认 `:=` 必须引入新变量。

```go
package main

import "fmt"

func main() {
	x := 10
	x, y := 20, "go"
	fmt.Println("A", x, y)
	{
		x := 30
		fmt.Println("B", x)
	}
	fmt.Println("C", x)
}
```

先预测并运行验证，再回答：

1. 原程序能否编译？A、B、C 分别输出什么？
2. 单独把内层的 `x := 30` 改为 `x = 30`，哪些输出变化？
3. 恢复原程序，再单独把 `x, y := 20, "go"` 改为 `x := 20`，同时把 A 行改为只打印 `x`。编译器会如何处理第二次声明？

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A 20 go
B 30
C 20
```

`x, y := ...` 中的 `y` 是同一代码块内的新变量，`x` 被重新赋值。内层 `x := 30` 创建另一个变量，因此不会改变外层 `x`；把它改为 `x = 30` 后，修改的是外层变量，C 变为 `C 30`。

第三种改动在同一代码块内重复写 `x := 20`，左侧没有新变量，编译失败并报告 `no new variables on left side of :=`。该语句应改为 `x = 20`。

</details>

### 实验 6：浮点常量与运行时计算

验证目标：检查相同十进制表达式在常量和变量运算中的结果，观察浮点除零行为，并练习如何按允许的误差判断两个浮点数是否近似相等。

```go
package main

import (
	"fmt"
	"math"
)

func main() {
	const constantSum = 0.1 + 0.2
	x, y := 0.1, 0.2
	runtimeSum := x + y
	fmt.Printf("A %.17g %t\n", constantSum, constantSum == 0.3)
	fmt.Printf("B %.17g %t\n", runtimeSum, runtimeSum == 0.3)
	zero := 0.0
	fmt.Println("C", math.IsInf(1.0/zero, 1), math.IsNaN(zero/zero))
}
```

先预测并运行验证，再回答：

1. A、B 的相等性比较是否一致？数值以 17 位有效数字输出后有什么差异？
2. C 中两次浮点除法的结果分别属于哪一类特殊值？
3. 另建一个程序，将 `zero := 0.0` 改为 `const zero = 0.0`。这时失败发生在哪个阶段？

<details>
<summary>查看参考答案与解释</summary>

本章验证环境的输出为：

```text
A 0.29999999999999999 true
B 0.30000000000000004 false
C true true
```

A 的比较在常量语义下进行，`0.1 + 0.2` 与 `0.3` 相等；传给 `Printf` 时，常量才转换为默认的 `float64`，显示出二进制浮点近似。B 的两个变量已经分别舍入为 `float64`，相加后与转换为 `float64` 的 `0.3` 不相等。

C 在本机官方工具链上得到正无穷和 `NaN`，并由 `math` 函数识别。这是已验证环境的结果，浮点除零的实现边界见 [2.3 节](#ch2-3)。把零改成常量后，两处除法都在编译期被拒绝，不会开始运行。

**先区分精确相等与近似相等。** Go 的 `==` 比较两个浮点值是否精确相等，适用于确实需要精确比较的场景；它不会自动容忍舍入误差。要判断计算结果是否足够接近，需要根据业务要求设定误差范围。

在原程序的 `main` 中追加以下语句，可以先尝试绝对误差判断：

```go
diff := math.Abs(runtimeSum - 0.3)
fmt.Printf("diff = %.17g\n", diff)
fmt.Println(diff <= 1e-12, diff <= 1e-18)
```

输出为：

```text
diff = 5.5511151231257827e-17
true false
```

绝对误差使用与原数值相同的单位，适合接近零的值；相对误差则将差值除以两个数中较大的绝对值，适合比较不同数量级的值。本例采用“满足任一误差条件即可”的规则：

```text
|a - b| <= absTol
或
|a - b| / max(|a|, |b|) <= relTol
```

下面是一份可独立运行的实现。辅助函数和条件判断会在后续章节展开，这里先关注检查顺序与返回条件：

```go
package main

import (
	"fmt"
	"math"
)

// 调用方应保证阈值有限，absTol >= 0，且 0 <= relTol < 1。
func nearlyEqual(a, b, absTol, relTol float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return false
	}
	if a == b {
		return true
	}
	if math.IsInf(a, 0) || math.IsInf(b, 0) {
		return false
	}

	diff := math.Abs(a - b)
	scale := math.Max(math.Abs(a), math.Abs(b))
	return diff <= absTol || diff/scale <= relTol
}

func main() {
	const absTol = 1e-12
	const relTol = 1e-9
	x, y := 0.1, 0.2

	fmt.Println("sum", nearlyEqual(x+y, 0.3, absTol, relTol))
	fmt.Println("near zero", nearlyEqual(0, 1e-13, absTol, relTol))
	fmt.Println("large", nearlyEqual(1e12, 1e12+0.5, absTol, relTol))
	fmt.Println("different", nearlyEqual(1, 1.01, absTol, relTol))
	fmt.Println("NaN", nearlyEqual(math.NaN(), math.NaN(), absTol, relTol))
	fmt.Println("same infinity", nearlyEqual(math.Inf(1), math.Inf(1), absTol, relTol))
	fmt.Println("opposite infinities", nearlyEqual(math.Inf(1), math.Inf(-1), absTol, relTol))
	fmt.Println("finite vs infinity", nearlyEqual(1, math.Inf(1), absTol, relTol))
}
```

输出为：

```text
sum true
near zero true
large true
different false
NaN false
same infinity true
opposite infinities false
finite vs infinity false
```

`0` 与 `1e-13` 的相对误差是 `1`，但绝对误差足够小；`1e12` 与 `1e12 + 0.5` 的绝对误差是 `0.5`，但相对误差约为 `5e-13`。前者需要绝对误差条件，后者需要相对误差条件。`1` 与 `1.01` 则不满足本例的任一阈值。

先判断 `NaN`，再用 `a == b` 处理完全相等的有限值、正负零和同号无穷；之后排除其余无穷情况，避免直接计算无穷之间的差。到达误差计算时，两个值有限且不相等，`scale` 必定大于零。如果相反符号的极大有限值相减溢出为无穷，两项误差检查也都会返回 `false`，符合本例阈值约束。

`nearlyEqual` 是本例自定义函数。`1e-12` 和 `1e-9` 只是演示参数，应按数据单位、数量级和可接受的误差选择；阈值越大，越容易把不同的结果判为接近。近似相等不会消除数值误差，也不能替代金额计算所需的精确十进制表示。

</details>

## 参考资料

- [Go 语言规范：基本类型、常量与变量](https://go.dev/ref/spec)
- [Go 语言规范：常量](https://go.dev/ref/spec#Constants)
- [Go 语言规范：变量声明](https://go.dev/ref/spec#Variable_declarations)
- [Go 语言规范：转换](https://go.dev/ref/spec#Conversions)
- [Go 标准库 `strings.CutPrefix`：移除字符串前缀并报告是否匹配](https://pkg.go.dev/strings#CutPrefix)
- [Effective Go：命名](https://go.dev/doc/effective_go#names)
