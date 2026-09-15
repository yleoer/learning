---
title: 第 3 章 复合类型
description: Go 的数组、切片、字符串、映射和结构体，以及它们的存储与比较规则。
---

# 第 3 章 复合类型

## 本章要点

本章沿用原书的顺序，依次学习数组、切片、字符串、映射和结构体。重点是区分值的复制与底层数据的共享，理解长度、容量、零值和可比较性如何影响实际操作。

> 核对日期：2026 年 9 月 15 日；核对环境为 Go 1.27.1、Windows/AMD64。
>
> `clear`、标准库 `slices` 和 `maps` 需要 Go 1.21 或更新版本；切片转数组值从 Go 1.20 起支持，转数组指针从 Go 1.17 起支持。

## 3.1 数组：长度属于类型 {#ch3-1}

数组是固定长度、元素类型相同的序列。数组长度是类型的一部分：`[3]int` 与 `[4]int` 是不同类型。

```go
var a [3]int
b := [3]int{10, 20, 30}
c := [...]int{10, 20, 30} // 推导为 [3]int
d := [12]int{1, 5: 4, 6, 10: 100, 15}
```

`d` 的值为 `[1 0 0 0 0 4 6 0 0 0 100 15]`。显式索引后的无索引元素从下一个位置继续，未指定的位置使用元素零值。数组长度必须是编译期可确定的非负整数常量，不能用运行时变量决定。

数组支持索引、`len`、`==` 和 `!=`。比较要求数组元素类型本身可比较，并且至少一个操作数可赋值给另一个操作数的类型；通常这意味着类型相同，但具名数组与底层类型相同的匿名数组也可以比较。例如 `[3]int` 可比较，`[3][]int` 不可比较。数组赋值和传参会复制全部元素，元素内部若含指针、切片或映射，复制的是这些字段的值，并不递归复制它们指向的数据。

数组适合长度由协议、算法或固定格式定义的场景，例如哈希摘要。长度不确定或需要通用 API 时，通常使用切片。

数组索引从 `0` 到 `len(a)-1`。常量索引越界会在编译时被发现，变量索引越界则在运行时触发 `panic`。`[2][3]int` 表示一个含两个元素的数组，每个元素又是 `[3]int`；多维数据由此组合而成。

## 3.2 切片：可变长度的视图 {#ch3-2}

切片是对底层数组一段连续区域的描述，包含指针、长度和容量三个信息。复制切片值只复制描述符，多个切片可能共享元素。

```go
var nilSlice []int
empty := []int{}
reserved := make([]int, 0, 5)
filled := make([]int, 5, 10)
```

| 表达式 | `len` | `cap` | `nil` | 适用含义 |
| --- | ---: | ---: | :---: | --- |
| `var s []int` | 0 | 0 | 是 | 零值切片，通常可直接 `append` |
| `[]int{}` | 0 | 0 | 否 | 非 `nil` 空切片，序列化时可能与 `nil` 有不同表现 |
| `make([]int, 0, 5)` | 0 | 5 | 否 | 预留容量，使用 `append` 填充 |
| `make([]int, 5, 10)` | 5 | 10 | 否 | 已有 5 个可索引的零值元素 |

这种差异会影响外部表示：`encoding/json` 将 nil 切片编码为 `null`，将非 nil 空切片编码为 `[]`。因此，API 是否区分“缺失”和“空集合”会影响切片的初始化方式。

切片字面量可以在创建时给出元素，也可以只指定部分索引；长度由最高索引决定：

```go
primes := []int{2, 3, 5, 7}
sparse := []int{1, 3: 10} // [1 0 0 10]
```

`len` 是当前可索引元素数，`cap` 是切片在不重新分配底层数组前允许扩展到的最大长度。二索引切片会继承来源切片从新起点开始的可用容量，三索引切片则可以主动限制它。容量内但长度外的位置不能直接索引：`make([]int, 0, 5)` 后访问 `s[0]` 仍会越界；应先 `append` 或重新切到合法长度。

### 3.2.1 `append`

```go
s = append(s, 10)
s = append(s, 5, 6, 7)
s = append(s, other...)
```

`append` 返回追加后的切片值，通常要把结果赋回变量；单独写 `append(s, 10)` 而不使用结果会编译失败。追加后的长度不超过容量时，会复用原底层数组；超过容量时，会分配新数组并复制原切片的元素。

追加 `n` 个元素后长度增加 `n`。`append(s)` 和追加空切片也是合法的，此时长度不变；因此“每次调用 `append` 都增加长度”并不准确。

这也解释了函数边界：函数收到的是切片描述符的副本。函数内修改已有元素可能影响调用方；函数内 `append` 后得到的新长度或新底层数组不会自动更新调用方变量，所以需要返回新切片，或让调用方负责 `append`。

### 3.2.2 `make` 的长度与容量

```go
buf := make([]byte, 1024)    // 1024 个可直接索引的零值字节
items := make([]int, 0, 100) // 长度为 0，容量明确为 100
```

逐项写入已知长度的数据时，设置非零长度并用索引；逐项生成、数量可能变化时，设置零长度和预估容量并用 `append`。不要把 `make([]int, 5)` 和 `append` 混用来填充前五个位置，否则追加值会出现在五个零值之后。

`make([]T, length, capacity)` 要求 `0 <= length <= capacity`；容量省略时等于长度。无效的常量参数会导致编译错误，运行时才确定的无效参数会触发 `panic`。选择初始容量应服务于已知需求，避免为了减少扩容而预留大量用不到的空间。

### 3.2.3 派生切片与共享存储

切片表达式左闭右开，不复制元素：

| 表达式 | 长度 | 容量 |
| --- | --- | --- |
| `x[low:high]` | `high-low` | `cap(x)-low` |
| `x[low:high:max]` | `high-low` | `max-low` |
| `x[:]` | `len(x)` | `cap(x)` |

对切片 `x`，二索引表达式要求 `0 <= low <= high <= cap(x)`；省略 `high` 时默认使用 `len(x)`。三索引表达式要求 `0 <= low <= high <= max <= cap(x)`，其中 `high` 和 `max` 不能省略。直接索引仍必须小于 `len(x)`。完整表达式可限制容量，防止子切片追加元素时覆盖父切片的尾部：

```go
x := []string{"a", "b", "c", "d"}
y := x[:2:2]
y = append(y, "z") // y 扩容，x 不会被写成 [a b z d]
```

这里将容量限制为长度，追加元素时才必须分配新数组；三索引表达式本身不会复制数据，已有元素仍与 `x` 共享。需要独立的元素存储时，可以先用 `make` 分配目标切片再用 `copy` 复制，也可以在 Go 1.21 及更新版本中使用 `clone := slices.Clone(x)`。两种方式都是浅复制：如果元素本身引用其他存储，内部数据仍可能共享。

### 3.2.4 `copy` 与 `clear`

`copy(dst, src)` 把元素复制到已存在的目标切片，返回复制数量 `min(len(dst), len(src))`，不会为目标自动扩容；源和目标允许重叠。

```go
dst := make([]int, len(src))
copy(dst, src)
```

这是浅复制：如果元素本身是切片、映射或指针，内部数据仍可能共享。复制数量不看容量，例如 `copy(make([]int, 0, 10), src)` 复制零个元素；重叠复制也有明确结果，例如当 `s := []int{1, 2, 3, 4}` 时，`copy(s[:3], s[1:])` 返回 `3`，并把 `s` 改为 `[2 3 4 4]`。

`clear(s)` 将当前长度内的元素设为零值，保持长度和容量不变，其他共享这些位置的切片也会看到变化；`s = s[:0]` 只把该切片的长度改为零，不会清除底层元素。`clear` 对 nil 切片是无操作；它清空映射时的行为见 [3.4 节](#ch3-4)。

### 3.2.5 切片比较

切片不能互相使用 `==` 或 `!=`，只能与 `nil` 比较。内容比较使用标准库 `slices` 包：

```go
var a []int
b := []int{}
fmt.Println(a == nil)          // true
fmt.Println(b == nil)          // false
fmt.Println(slices.Equal(a, b)) // true
```

`slices.Equal` 要求元素可比较；`slices.EqualFunc` 通过调用方提供的函数判断元素是否相等。两者比较元素内容，不判断底层数组是否相同。

### 3.2.6 数组与切片的转换

#### 数组派生切片

```go
a := [4]int{1, 2, 3, 4}
s := a[:] // 与 a 共享存储
s[0] = 10
```

数组必须可寻址，派生切片不会复制数据。

#### 切片转换为数组或数组指针

```go
s := []int{1, 2, 3, 4}
a := [2]int(s)   // 复制前两个元素
p := (*[4]int)(s) // 与 s 共享底层数组
```

数组长度 `N` 是编译期常量。转换为 `[N]T` 或 `*[N]T` 时，切片长度必须至少为 `N`；容量足够但长度不足仍会在运行时 `panic`。数组转换复制元素，数组指针转换共享存储。需要处理任意长度数据时，优先把函数参数设计为 `[]T`。

## 3.3 字符串、字节和 `rune` {#ch3-3}

字符串是不可变的字节序列，不是 `rune` 序列。Go 源代码使用 UTF-8；字符串值本身不强制必须是有效 UTF-8，但标准库的许多 API 和 `for range` 按 UTF-8 代码点处理。

```go
s := "Hi 🌍"
fmt.Println(len(s)) // 7：按字节计数
fmt.Println(s[3])   // 一个 byte，不是完整的“🌍”
```

字符串索引、切片和 `len` 都按字节位置工作，索引结果的类型是 `byte`。多字节 UTF-8 字符被切在中间时，可能得到无效字节序列；需要按 Unicode 代码点处理时，可转换为 `[]rune`，或用 `unicode/utf8` 解码和计数。查找、替换等文本操作可使用 `strings`，但需留意具体 API 的索引单位：

```go
rs := []rune(s)
fmt.Println(len(rs)) // 4：按代码点计数
```

代码点也不一定等同于用户看到的一个字符。例如，带组合附加符号的字母和部分 emoji 由多个代码点组成，`len([]rune(s))` 仍不能得到视觉字符数。需要按用户可见字符截断、计数或移动光标时，应使用支持 Unicode 字素簇分段的库，而不是仅按字节或 `rune` 处理。

`byte` 是 `uint8` 的别名，适合处理原始数据；`rune` 是 `int32` 的别名，通常用于表示 Unicode 代码点，但其类型本身不保证值合法。整数转字符串按代码点编码：`string('A')` 和 `string(65)` 都是 `"A"`，无效代码点转为替换字符 `U+FFFD`。数字转十进制文本应使用 `strconv.Itoa` 或 `fmt.Sprint`。

单个 `byte` 转字符串也按代码点解释，例如 `string(byte(0xff))` 得到 `"ÿ"`，其 UTF-8 编码有两个字节；保留原始单字节应写 `string([]byte{0xff})`。`go vet` 会提示部分可疑的整数转字符串操作，但这不表示语言禁止该转换。

常见转换：

```go
bs := []byte(s) // 原始字节；s 为有效 UTF-8 时，就是它的 UTF-8 编码
rs = []rune(s)  // 按 UTF-8 解码得到的代码点
s1 := string(bs)
s2 := string(rs)
```

`[]byte` 与字符串相互转换后，修改字节切片不会改变原字符串。`[]rune(s)` 遇到无效 UTF-8 时会使用替换字符；如果要原样保存任意字节，应使用字节转换，不能依赖 rune 转换往返还原。

## 3.4 映射（`map`） {#ch3-4}

映射表示键到值的关联，类型写作 `map[K]V`。键必须是可比较类型，因此不能使用切片、映射或函数作为键。

```go
var nilMap map[string]int
scores := map[string]int{}
ages := make(map[string]int, 100)
```

`nil` 映射的长度为 0，读取任意键都会返回值类型的零值，但写入会 `panic`；空字面量和 `make` 创建的映射可读可写。`make(map[string]int, 100)` 中的 `100` 是初始空间提示，不会创建 100 个条目，也不是容量上限；映射不支持 `cap`。映射的长度用 `len` 获取，本身只能与 `nil` 使用 `==`、`!=` 比较。

映射赋值和传参会复制映射值，仍引用同一份映射数据；通过副本增删条目会影响另一方。需要独立的键值容器时，Go 1.21 及更新版本可以使用 `clone := maps.Clone(scores)`，但键和值中引用的内部数据仍是浅复制。若键类型是接口，放入的动态值也必须可比较，例如把切片作为 `map[any]int` 的键仍会在运行时 `panic`。相关接口规则将在后续的接口章节展开。

已经知道初始键值时，可以使用非空映射字面量：

```go
scores := map[string]int{
	"go":   10,
	"rust": 8,
}
```

每个条目写作 `键: 值`。多行字面量的最后一个条目后也必须保留逗号。

### 3.4.1 读写、逗号 `ok` 与删除

```go
scores["go"] = 10
scores["go"]++

value, ok := scores["rust"]
if !ok {
	fmt.Println("key not found", value)
}

delete(scores, "go") // 键不存在或映射为 nil 时无操作
clear(scores)         // 清空键值对；原本非 nil 的映射仍可写
```

单值读取无法区分“键不存在”和“键存在但值恰好是零值”，需要区分时使用逗号 `ok` 模式。映射遍历顺序不受语言保证；需要稳定输出时先提取并排序键，现代写法见 [4.4.4 节](./chapter-04#ch4-4-4)。

`clear` 和 `delete` 对 nil 映射都是无操作，不会完成初始化；清空 nil 映射后写入仍会 `panic`。

### 3.4.2 映射模拟集合

Go 没有内置集合类型，可以用映射的键表示集合元素：

```go
set := map[string]struct{}{}
set["go"] = struct{}{}
if _, ok := set["go"]; ok {
	fmt.Println("present")
}
```

也可使用 `map[T]bool`，约定只存储 `true`、删除成员时使用 `delete`，这样 `set[value]` 就能直接判断成员身份。如果允许存储 `false`，才需要用逗号 `ok` 区分“键不存在”和“键存在但值为假”。`map[T]struct{}` 直接用键的存在性表达成员身份，空结构体的值大小为零，但映射本身仍有存储开销。

### 3.4.3 比较映射内容

标准库 `maps.Equal` 比较两个映射的键值内容，要求值类型可比较；`maps.EqualFunc` 接受自定义的值比较函数。两者不比较插入顺序，并将 nil 映射与非 nil 空映射视为内容相等：

```go
// 需要导入 "maps"
first := map[string]int{"go": 10, "rust": 8}
second := map[string]int{"rust": 8, "go": 10}
fmt.Println(maps.Equal(first, second)) // true
```

## 3.5 结构体（`struct`） {#ch3-5}

结构体由编译期确定的字段名和字段类型组成，可通过 `type` 声明命名。相比用 `map[string]any` 约定字段含义，结构体能在编译期检查字段访问和赋值，更适合稳定的数据模型；映射只统一约束键的类型，运行时可以动态增删具体键。

```go
type Person struct {
	Name string
	Age  int
	Pet  string
}

var zero Person
bob := Person{Name: "Bob", Age: 50}
bob.Pet = "dog"
```

结构体零值的每个字段都是各自类型的零值。字段使用点号访问。结构体赋值和传参会复制整个结构体值；这仍是浅复制，如果字段是切片、映射或指针，副本中的这些字段可能继续引用同一份数据。

推荐使用带字段名的字面量：字段可以按任意顺序出现，未写字段获得零值，结构体增加字段时也更容易维护。非空字面量若省略字段名，必须按声明顺序提供全部字段，且不能混用两种风格；空字面量 `Person{}` 则表示零值。不要依赖外部包结构体的字段顺序。

```go
type Point struct{ X, Y int }

p1 := Point{10, 20}
p2 := Point{Y: 20, X: 10}
```

### 3.5.1 匿名结构体

不命名的结构体类型适合一次性数据、JSON 编解码和表格驱动测试：

```go
payload := struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}{Name: "Ada", Age: 36}
```

反引号中的内容是结构体字段标签，是附加在字段上的元数据，本身不会改变字段行为。`encoding/json` 等包通过反射读取约定的标签；这里的 `json:"name"` 和 `json:"age"` 指定 JSON 字段名。`Name`、`Age` 首字母大写，因此可以被包外的 JSON 编码器访问。

### 3.5.2 比较与转换

结构体是否可比较取决于所有字段：只含可比较字段的结构体可以使用 `==` 和 `!=`；含切片、映射或函数字段的结构体不可比较。

通道和指针类型都可比较，含有这些字段不会单独导致结构体不可比较；比较检查的是通道或指针的身份，而非所引用对象的内容。接口字段另有动态值的限制，将在后续章节讨论。

两个不同的定义类型不能仅因字段相同就直接比较，需先转换到兼容类型。普通结构体之间若忽略标签后的底层类型相同，可以显式转换；字段的顺序、名称、类型及是否嵌入仍需一致。标签参与普通类型身份与赋值判断，却在这种显式转换中被忽略；不同包中的未导出字段也不会仅因拼写相同就被当成同一字段。

具名结构体与底层类型相同的匿名结构体之间可以直接赋值；字段全部可比较时，也可以直接比较。赋值只复制结构体值，不会递归复制切片、映射等字段所引用的数据。

## 练习 {#ch3-exercises}

五题分别检查数组、切片、字符串、映射和结构体的关键行为。先独立完成，再展开参考答案。除完整程序外，代码片段位于 `main` 函数内，`fmt` 对应标准库导入路径 `"fmt"`；其他包在首次使用处说明。

### 练习 1：数组的赋值、传参与长度

写出输出，说明数组赋值与传参分别复制了什么。若只把 `b := a` 改为 `b := [...]int{1, 2}`，`change(b)` 和 `a == b` 还能编译吗？

```go
package main

import "fmt"

func change(a [3]int) {
	a[0] = 9
}

func main() {
	a := [3]int{1, 2}
	b := a
	change(b)
	b[1] = 8
	fmt.Println(a, b, a == b)
}
```

<details>
<summary>查看参考答案</summary>

输出为 `[1 2 0] [1 8 0] false`。字面量中未指定的第三个元素取零值；`b := a` 复制三个整数，调用 `change(b)` 时又复制一次，所以函数内的修改不影响 `b`，对 `b[1]` 的修改也不影响 `a`。

改用 `[...]int{1, 2}` 后，`b` 的类型为 `[2]int`，与 `[3]int` 不同，调用和比较都无法编译。数组长度属于类型，元素相同或前缀相同不能消除这个区别。可回看[数组的类型与值语义](#ch3-1)。

</details>

### 练习 2：限制追加范围与复制已有元素

写出 `view` 在追加前的长度和容量，以及最后一行的输出。再只把 `clone` 的创建方式改为 `make([]int, 2)`，判断输出如何变化，解释哪些操作共享存储、哪些操作复制元素。

```go
src := []int{1, 2, 3, 4}
view := src[1:3:3]
clone := make([]int, 0, 2)
n := copy(clone, view)
view[0] = 9
view = append(view, 5)
view[0] = 8
fmt.Println(src, view, clone, n)
```

<details>
<summary>查看参考答案</summary>

追加前 `view` 的长度和容量均为 `2`。原程序输出：

```text
[1 9 3 4] [8 3 5] [] 0
```

三索引切片只限制容量，不复制元素，因此 `view[0] = 9` 会修改 `src[1]`。追加后长度将超过受限容量，必须分配新数组；随后的 `view[0] = 8` 才不再影响 `src`。不能据此推断新容量的具体数值。

`copy` 复制数量为两个切片长度的较小值，目标虽有容量 `2`，长度却为 `0`，所以第一次复制数量为 `0`。改成 `make([]int, 2)` 后，先复制出 `[2 3]`，输出变为：

```text
[1 9 3 4] [8 3 5] [2 3] 2
```

独立存储来自 `make`，`copy` 负责填充已有元素，不会自动扩展目标长度。可回看[三索引切片](#ch3-2)中的容量规则与 `copy` 的长度要求。

</details>

### 练习 3：按字节和代码点处理字符串

写出三行输出，分别说明计数与索引使用的单位，以及 `message[3]` 为什么不是完整字符。`utf8` 对应标准库导入路径 `"unicode/utf8"`。

```go
message := "Hi 🌞"
fmt.Println(len(message), utf8.RuneCountInString(message))
fmt.Println(string([]rune(message)[3]))
fmt.Println(message[3])
```

<details>
<summary>查看参考答案</summary>

需要导入 `fmt` 和 `unicode/utf8`。输出为：

```text
7 4
🌞
240
```

`len` 统计 UTF-8 字节数，太阳符号占 4 个字节；`utf8.RuneCountInString` 按 Unicode 代码点计数。字符串索引返回单个字节，`message[3]` 是太阳符号编码的首字节 `0xf0`，不能单独表示完整字符；用 `[]rune` 后按代码点索引才能得到 `🌞`。

</details>

### 练习 4：区分零值条目、缺失键与 nil 映射

写出输出，并解释两次读取的区别。另行将第一行改为 `var counts map[string]int`：读取是否安全，哪条语句失败，失败发生在哪个阶段？给出保留零值声明、在写入前完成初始化的修改。

```go
counts := map[string]int{"go": 0}
present, okPresent := counts["go"]
missing, okMissing := counts["rust"]
counts["go"]++
fmt.Println(present, okPresent, missing, okMissing, counts["go"])
```

<details>
<summary>查看参考答案</summary>

输出为：

```text
0 true 0 false 1
```

`"go"` 存在且值为零，`"rust"` 不存在，两次都读到 `0`，但 `ok` 不同。改成 nil 映射后，两次读取都安全，均返回 `0, false`；`counts["go"]++` 包含写入，执行到这里会发生运行时 `panic`，最后的打印不会执行。

保留零值声明时，在两次读取之后、写入之前增加 `counts = make(map[string]int)` 即可。此前读到的 `ok` 不会随映射初始化而改变，修改后输出为 `0 false 0 false 1`。注意已有 `counts` 时使用 `=`，不是再次 `:=`。

</details>

### 练习 5：区分结构体字段赋值与共享元素修改

写出两行输出，说明修改 `b.Name`、`b.Scores[0]` 和给 `b.Scores` 整体赋值各自影响哪些数据。再在 `b := a` 之后补一行，使对 `b` 的所有后续修改都不影响 `a`，并写出修改后的输出。

```go
type Profile struct {
	Name   string
	Scores []int
}
a := Profile{Name: "Ada", Scores: []int{1, 2}}
b := a
b.Name = "Lin"
b.Scores[0] = 9
fmt.Println(a.Name, a.Scores, b.Name, b.Scores)
b.Scores = []int{7, 8}
fmt.Println(a.Scores, b.Scores)
```

<details>
<summary>查看参考答案</summary>

原代码输出：

```text
Ada [9 2] Lin [9 2]
[9 2] [7 8]
```

`b := a` 复制了所有字段值。给 `b.Name` 赋新值只改变 `b` 的字段；但 `Scores` 字段复制的是切片描述符，两个结构体仍共享底层数组，所以 `b.Scores[0] = 9` 会影响 `a.Scores`。随后给 `b.Scores` 整体赋值只替换 `b` 中的切片值，既不替换 `a.Scores`，也不撤销此前的元素修改。

在 `b := a` 后、任何元素修改之前补上以下一行；`slices` 对应标准库导入路径 `"slices"`：

```go
b.Scores = slices.Clone(a.Scores)
```

修改后输出：

```text
Ada [1 2] Lin [9 2]
[1 2] [7 8]
```

复制出的 `[]int` 有独立元素存储，整数元素也不引用其他数据，因而足以满足本题的隔离要求。若元素本身又是切片、映射或指针，还需根据需要复制其引用的数据；不能把这一修复推广为任意结构体的深复制。可回看[结构体的值复制](#ch3-5)。

</details>

## 面试题 {#ch3-interview}

四题检查容器清空、内容比较、映射副本和结构体类型规则。先独立回答，再展开参考答案；代码上下文与 `fmt` 导入沿用[练习部分](#ch3-exercises)，`slices` 和 `maps` 分别对应标准库导入路径 `"slices"` 和 `"maps"`。

### 面试题 1：`clear(s)` 与 `s = s[:0]` 等价吗？

下面代码输出什么？最后一次 `clear` 能否清除 `alias` 中剩余的元素？

```go
s := []int{1, 2, 3}
alias := s
clear(s[:2])
s = s[:0]
clear(s)
fmt.Println(alias, len(s), cap(s))
```

<details>
<summary>查看参考答案</summary>

不等价，输出为 `[0 0 3] 0 3`。`clear` 只清零当前长度内的元素，不改变长度和容量；缩短 `s` 只改变其切片值，`alias` 的长度仍为 `3`。最后 `len(s) == 0`，因此 `clear(s)` 不会清除任何元素。

</details>

### 面试题 2：内容相等能代替 nil 判断吗？

下面代码输出什么？`slices.Equal` 和 `maps.Equal` 分别比较什么？

```go
var s []int
var m map[string]int
fmt.Println(slices.Equal(s, []int{}), maps.Equal(m, map[string]int{}))
fmt.Println(s == nil, m == nil)
```

<details>
<summary>查看参考答案</summary>

两行均输出 `true true`。`slices.Equal` 比较长度与各位置的元素；`maps.Equal` 比较键集合与各键对应的值，不比较插入顺序。它们都把 nil 与已初始化的空容器视为内容相等；空字面量本身却不为 nil，因此内容相等不能代替 nil 判断。

</details>

### 面试题 3：映射赋值与 `maps.Clone` 的清空范围相同吗？

下面代码输出什么？`clear(alias)` 会影响哪几个映射变量看到的条目，为什么？

```go
source := map[string]int{"go": 1}
alias := source
cloned := maps.Clone(source)
clear(alias)
cloned["go"]++
fmt.Println(len(source), len(alias), cloned["go"])
```

<details>
<summary>查看参考答案</summary>

不同，输出为 `0 0 2`。直接赋值得到的 `alias` 与 `source` 引用同一份映射数据，清空任一方都会影响另一方。`maps.Clone` 创建独立的键值容器，保留复制时的 `"go": 1`，加一后为 `2`。本题的值是整数，容器独立性与引用数据的浅复制边界应分开判断。

</details>

### 面试题 4：结构体能直接赋值就能用 `==` 比较吗？

分别判断 A、B 是否合法。若将所有 `Values []int` 改为 `Values [1]int`，并把字面量 `[]int{1}` 改为 `[1]int{1}`，比较是否成立？

```go
type Record struct{ Values []int }
a := Record{Values: []int{1}}
var b struct{ Values []int } = a // A
fmt.Println(a == b)              // B
```

<details>
<summary>查看参考答案</summary>

A 合法，B 不合法。`Record` 与匿名结构体具有相同的底层类型，且至少一方不是具名类型，满足赋值规则；但切片字段不可比较，因此不能对两个结构体使用 `==`。改成 `[1]int` 字段后，赋值仍合法，字段也可比较，程序输出 `true`。类型兼容与字段可比较性是两项独立条件。

</details>

## 参考资料

- [Go 语言规范：类型身份与赋值](https://go.dev/ref/spec#Type_identity)
- [Go 语言规范：比较运算](https://go.dev/ref/spec#Comparison_operators)
- [Go 语言规范：切片到数组的转换](https://go.dev/ref/spec#Conversions_from_slice_to_array_or_array_pointer)
- [Go 语言规范：数组、切片、映射与结构体](https://go.dev/ref/spec#Array_types)
- [Go 语言规范：切片表达式](https://go.dev/ref/spec#Slice_expressions)
- [Go 预声明函数：`append` 与 `copy`](https://go.dev/ref/spec#Appending_and_copying_slices)
- [Go 预声明函数：`make`](https://go.dev/ref/spec#Making_slices_maps_and_channels)
- [Go 预声明函数：`clear`](https://go.dev/ref/spec#Clear)
- [Go 标准库 `encoding/json`：切片的 JSON 编码](https://pkg.go.dev/encoding/json#Marshal)
- [Go 标准库 `slices` 包：`Clone` 与内容比较](https://pkg.go.dev/slices)
- [Go 标准库 `maps` 包：`Clone` 与内容比较](https://pkg.go.dev/maps)
- [Go Blog：Strings, bytes, runes and characters in Go](https://go.dev/blog/strings)
