---
title: 第 3 章 复合类型
description: Go 的数组、切片、字符串、映射和结构体，以及它们的存储与比较规则。
---

# 第 3 章 复合类型

## 本章要点

本章沿用原书的顺序，依次学习数组、切片、字符串、映射和结构体。重点是区分值的复制与底层数据的共享，理解长度、容量、零值和可比较性如何影响实际操作。

> 核对日期：2026 年 9 月 11 日；实验环境为 Go 1.27.1、Windows/AMD64。
>
> `clear`、标准库 `slices` 和 `maps` 需要 Go 1.21 或更新版本；切片转数组值从 Go 1.20 起支持，转数组指针从 Go 1.17 起支持。

<a id="ch3-1"></a>
## 3.1 数组：长度属于类型

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

<a id="ch3-2"></a>
## 3.2 切片：可变长度的视图

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

切片字面量可以在创建时给出元素，也可以只指定部分索引；长度由最高索引决定：

```go
primes := []int{2, 3, 5, 7}
sparse := []int{1, 3: 10} // [1 0 0 10]
```

`len` 是当前可索引元素数，`cap` 是切片在不重新分配底层数组前允许扩展到的最大长度。二索引切片会继承来源切片从新起点开始的可用容量，三索引切片则可以主动限制它。容量内但长度外的位置不能直接索引：`make([]int, 0, 5)` 后访问 `s[0]` 仍会越界；应先 `append` 或重新切到合法长度。

### `append`

```go
s = append(s, 10)
s = append(s, 5, 6, 7)
s = append(s, other...)
```

`append` 返回追加后的切片值，通常要把结果赋回变量；单独写 `append(s, 10)` 而不使用结果会编译失败。追加后的长度不超过容量时，会复用原底层数组；超过容量时，会分配新数组并复制原切片的元素。

追加 `n` 个元素后长度增加 `n`。`append(s)` 和追加空切片也是合法的，此时长度不变；因此“每次调用 `append` 都增加长度”并不准确。

这也解释了函数边界：函数收到的是切片描述符的副本。函数内修改已有元素可能影响调用方；函数内 `append` 后得到的新长度或新底层数组不会自动更新调用方变量，所以需要返回新切片，或让调用方负责 `append`。

### `make` 的长度与容量

```go
buf := make([]byte, 1024)    // 1024 个可直接索引的零值字节
items := make([]int, 0, 100) // 长度为 0，容量明确为 100
```

逐项写入已知长度的数据时，设置非零长度并用索引；逐项生成、数量可能变化时，设置零长度和预估容量并用 `append`。不要把 `make([]int, 5)` 和 `append` 混用来填充前五个位置，否则追加值会出现在五个零值之后。

`make([]T, length, capacity)` 要求 `0 <= length <= capacity`；容量省略时等于长度。无效的常量参数会导致编译错误，运行时才确定的无效参数会触发 `panic`。选择初始容量应服务于已知需求，避免为了减少扩容而预留大量用不到的空间。

### 派生切片与共享存储

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

这里将容量限制为长度，追加元素时才必须分配新数组；三索引表达式本身不会复制数据，已有元素仍与 `x` 共享。需要独立的元素存储时，先用 `make` 分配目标切片，再用 `copy` 复制。

### `copy` 与 `clear`

`copy(dst, src)` 把元素复制到已存在的目标切片，返回复制数量 `min(len(dst), len(src))`，不会为目标自动扩容；源和目标允许重叠。

```go
dst := make([]int, len(src))
copy(dst, src)
```

这是浅复制：如果元素本身是切片、映射或指针，内部数据仍可能共享。复制数量不看容量，例如 `copy(make([]int, 0, 10), src)` 复制零个元素；重叠复制也有明确结果，例如当 `s := []int{1, 2, 3, 4}` 时，`copy(s[:3], s[1:])` 返回 `3`，并把 `s` 改为 `[2 3 4 4]`。

`clear(s)` 将当前长度内的元素设为零值，保持长度和容量不变，其他共享这些位置的切片也会看到变化；`s = s[:0]` 只把该切片的长度改为零，不会清除底层元素。`clear` 对 nil 切片是无操作；它清空映射时的行为见 3.4 节。

### 切片比较

切片不能互相使用 `==` 或 `!=`，只能与 `nil` 比较。内容比较使用标准库 `slices` 包：

```go
var a []int
b := []int{}
fmt.Println(a == nil)          // true
fmt.Println(b == nil)          // false
fmt.Println(slices.Equal(a, b)) // true
```

`slices.Equal` 要求元素可比较；`slices.EqualFunc` 通过调用方提供的函数判断元素是否相等。两者比较元素内容，不判断底层数组是否相同。

### 数组与切片的转换

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

<a id="ch3-3"></a>
## 3.3 字符串、字节和 `rune`

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

<a id="ch3-4"></a>
## 3.4 映射（`map`）

映射表示键到值的关联，类型写作 `map[K]V`。键必须是可比较类型，因此不能使用切片、映射或函数作为键。

```go
var nilMap map[string]int
scores := map[string]int{}
ages := make(map[string]int, 100)
```

`nil` 映射的长度为 0，读取普通有效键会返回值类型的零值，但写入会 `panic`；空字面量和 `make` 创建的映射可读可写。`make(map[string]int, 100)` 中的 `100` 是初始空间提示，不会创建 100 个条目，也不是容量上限；映射不支持 `cap`。映射的长度用 `len` 获取，本身只能与 `nil` 使用 `==`、`!=` 比较。

映射赋值和传参会复制映射值，仍引用同一份映射数据；通过副本增删条目会影响另一方。若键类型是接口，放入的动态值也必须可比较，例如把切片作为 `map[any]int` 的键仍会在运行时 `panic`。接口规则在第 7 章展开。

已经知道初始键值时，可以使用非空映射字面量：

```go
scores := map[string]int{
	"go":   10,
	"rust": 8,
}
```

每个条目写作 `键: 值`。多行字面量的最后一个条目后也必须保留逗号。

### 读写、逗号 `ok` 与删除

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

单值读取无法区分“键不存在”和“键存在但值恰好是零值”，需要区分时使用逗号 `ok` 模式。映射遍历顺序不受语言保证；需要稳定输出时先提取并排序键。

`clear` 和 `delete` 对 nil 映射都是无操作，不会完成初始化；清空 nil 映射后写入仍会 `panic`。

### 映射模拟集合

Go 没有内置集合类型，可以用映射的键表示集合元素：

```go
set := map[string]struct{}{}
set["go"] = struct{}{}
if _, ok := set["go"]; ok {
	fmt.Println("present")
}
```

也可使用 `map[T]bool`，约定只存储 `true`、删除成员时使用 `delete`，这样 `set[value]` 就能直接判断成员身份。如果允许存储 `false`，才需要用逗号 `ok` 区分“键不存在”和“键存在但值为假”。`map[T]struct{}` 直接用键的存在性表达成员身份，空结构体的值大小为零，但映射本身仍有存储开销。

### 比较映射内容

标准库 `maps.Equal` 比较两个映射的键值内容，要求值类型可比较；`maps.EqualFunc` 接受自定义的值比较函数。两者不比较插入顺序，并将 nil 映射与非 nil 空映射视为内容相等：

```go
// 需要导入 "maps"
first := map[string]int{"go": 10, "rust": 8}
second := map[string]int{"rust": 8, "go": 10}
fmt.Println(maps.Equal(first, second)) // true
```

<a id="ch3-5"></a>
## 3.5 结构体（`struct`）

结构体由固定的字段名和字段类型组成，可通过 `type` 声明命名。相比用 `map[string]any` 约定字段含义，结构体能在编译期检查字段访问和赋值，更适合稳定的数据模型。映射也有键类型约束，只是通常不限制可以出现哪些键名。

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

### 匿名结构体

不命名的结构体类型适合一次性数据、JSON 编解码和表格驱动测试：

```go
payload := struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}{Name: "Ada", Age: 36}
```

反引号中的内容是结构体字段标签，是附加在字段上的元数据，本身不会改变字段行为。`encoding/json` 等包通过反射读取约定的标签；这里的 `json:"name"` 和 `json:"age"` 指定 JSON 字段名。`Name`、`Age` 首字母大写，因此可以被包外的 JSON 编码器访问。

### 比较与转换

结构体是否可比较取决于所有字段：只含可比较字段的结构体可以使用 `==` 和 `!=`；含切片、映射或函数字段的结构体不可比较。

原文把通道字段也列为不可比较，这是不准确的：通道类型可比较，含通道字段不会单独导致结构体不可比较。指针字段也可比较；这些比较检查的是引用身份，而非引用对象的内容。接口字段另有动态值的限制，将在后续章节讨论。

两个不同的定义类型不能仅因字段相同就直接比较，需先转换到兼容类型。普通结构体之间若忽略标签后的底层类型相同，可以显式转换；字段的顺序、名称、类型及是否嵌入仍需一致。标签参与普通类型身份与赋值判断，却在这种显式转换中被忽略；不同包中的未导出字段也不会仅因拼写相同就被当成同一字段。

具名结构体与底层类型相同的匿名结构体之间可以直接赋值；字段全部可比较时，也可以直接比较。赋值只复制结构体值，不会递归复制切片、映射等字段所引用的数据。

<a id="ch3-exercises"></a>
## 3.6 练习

三题对应原书第 3 章练习。

### 练习 1：派生切片

创建字符串切片 `greetings`，包含 `"Hello"`、`"Hola"`、`"नमस्कार"`、`"こんにちは"` 和 `"Привіт"`。分别派生包含前两个值、第 2～4 个值、第 4～5 个值的三个子切片，打印全部四个切片及各自长度。再修改第二个子切片的首元素，观察共享关系。

<details>
<summary>查看参考答案</summary>

```go
package main

import "fmt"

func main() {
	greetings := []string{
		"Hello",
		"Hola",
		"नमस्कार",
		"こんにちは",
		"Привіт",
	}

	first := greetings[:2]
	middle := greetings[1:4]
	last := greetings[3:]

	fmt.Println(greetings, len(greetings))
	fmt.Println(first, len(first))
	fmt.Println(middle, len(middle))
	fmt.Println(last, len(last))

	middle[0] = "¡Hola!"
	fmt.Println(greetings[1]) // ¡Hola!
}
```

四个切片的长度依次为 `5`、`2`、`3`、`2`，最后一行输出 `¡Hola!`。派生操作没有复制元素，`middle[0]` 与 `greetings[1]` 对应同一个底层数组位置，因此修改也能从 `first[1]` 观察到。

</details>

### 练习 2：字节与代码点

声明 `message := "Hi 🌞 and 🌍"`，按 Unicode 代码点计数，将第 4 个代码点作为字符打印出来。再用字符串索引、`[]byte` 和 `[]rune` 比较该位置的表示，解释字节位置与代码点位置的区别。

<details>
<summary>查看参考答案</summary>

```go
package main

import "fmt"

func main() {
	message := "Hi 🌞 and 🌍"
	bytes := []byte(message)
	runes := []rune(message)

	fmt.Println(len(message))
	fmt.Println(len(runes))
	fmt.Println(message[3])
	fmt.Printf("% x\n", bytes[3:7])
	fmt.Printf("%c\n", runes[3])
}
```

输出：

```text
16
10
240
f0 9f 8c 9e
🌞
```

`len(message)` 和 `message[i]` 都按字节工作。`🌞` 的 UTF-8 编码占 4 字节，而 `[]rune` 按 Unicode 代码点拆分字符串，因此 `runes[3]` 才是完整字符。

</details>

### 练习 3：初始化结构体

定义 `Employee` 结构体（`firstName`、`lastName`、`id`），分别用无字段名字面量、有字段名字面量和 `var` 创建三个实例，再用点号为第三个实例赋值并打印。

<details>
<summary>查看参考答案</summary>

```go
package main

import "fmt"

type Employee struct {
	firstName string
	lastName  string
	id        int
}

func main() {
	first := Employee{"Ada", "Lovelace", 1}
	second := Employee{
		firstName: "Grace",
		lastName:  "Hopper",
		id:        2,
	}

	var third Employee
	third.firstName = "Alan"
	third.lastName = "Turing"
	third.id = 3

	fmt.Printf("%+v\n", first)
	fmt.Printf("%+v\n", second)
	fmt.Printf("%+v\n", third)
}
```

输出：

```text
{firstName:Ada lastName:Lovelace id:1}
{firstName:Grace lastName:Hopper id:2}
{firstName:Alan lastName:Turing id:3}
```

无字段名写法依赖字段的声明顺序，并且必须提供所有字段；带字段名的写法更清晰，也更容易维护。

</details>

<a id="ch3-experiments"></a>
## 实验

### 实验 1：数组赋值与传参

```go
package main

import "fmt"

func change(v [3]int) {
	v[0] = 9
	fmt.Println("C", v)
}

func main() {
	a := [3]int{1, 2, 3}
	b := a
	b[0] = 7
	fmt.Println("A", a)
	fmt.Println("B", b)
	change(a)
	fmt.Println("D", a)
}
```

先预测并运行验证，再回答：

1. 预测程序能否编译、是否会 `panic`。
2. 按执行顺序写出 A、B、C、D 四行的完整数组值。
3. 分别指出执行 `b := a` 后被 `b[0] = 7` 修改的是哪个变量，调用 `change(a)` 后被 `v[0] = 9` 修改的是哪个变量。
4. 根据 A～D，分别说明赋值和传参后修改是否传播回原数组 `a`。

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A [1 2 3]
B [7 2 3]
C [9 2 3]
D [1 2 3]
```

`b := a` 会复制完整数组。`b[0] = 7` 只修改副本 `b`，所以 A 中的 `a` 保持不变，B 才显示修改后的值。

函数参数 `v [3]int` 同样按值接收数组。`change(a)` 创建参数副本，`v[0] = 9` 修改的是 `v`，所以 C 能在函数内看到 `[9 2 3]`，返回后 D 中的 `a` 仍是 `[1 2 3]`。因此，无论赋值还是按值传参，对数组副本的元素修改都不会传播回这个原数组。

</details>

### 实验 2：数组长度与类型身份

```go
// same_length.go
package main

import "fmt"

const size = 1 + 2

func take3(v [3]int) { fmt.Println(v) }

func main() {
	a := [3]int{1, 2, 3}
	var b [size]int = a
	take3(b)
}
```

```go
// different_length.go
package main

import "fmt"

func main() {
	a := [3]int{1, 2, 3}
	b := [4]int{1, 2, 3, 4}
	a = b
	fmt.Println(a)
}
```

先预测并运行验证，再回答：

1. 预测 `same_length.go` 中 `[size]int = [3]int` 的赋值和 `take3(b)` 调用能否编译，并写出运行输出。
2. 预测 `different_length.go` 能否编译、错误落在哪条语句，以及 `Println` 能否执行。
3. 解释数组类型身份判断使用常量表达式文本 `1 + 2`，还是其常量值；再说明长度从 3 变为 4 时唯一改变了什么。

<details>
<summary>查看参考答案与解释</summary>

`same_length.go` 能够编译，赋值和函数调用都成立，输出为：

```text
[1 2 3]
```

数组长度使用常量表达式求值后的常量值，而不是表达式的文本。`size` 的值是 `3`，所以 `[size]int` 与 `[3]int` 是同一个数组类型。

`different_length.go` 不能编译，错误落在 `a = b`：`[4]int` 不能赋给 `[3]int`。编译失败意味着程序不会启动，`fmt.Println(a)` 也不会执行。两个数组的元素类型仍然都是 `int`，唯一变化是长度从 3 变为 4；而长度属于数组类型，所以这一变化已经足以产生不同类型。

</details>

### 实验 3：切片容量与追加共享

以下两个场景视为互不影响的独立程序，每个场景都从新的 `src := []int{1, 2, 3, 4}` 开始：

```go
// 场景 A
src := []int{1, 2, 3, 4}
sub := src[:2]
out := append(sub, 9)
fmt.Println(src, sub, out, len(sub), cap(sub), &src[0] == &out[0])

// 场景 B
src := []int{1, 2, 3, 4}
sub := src[:2:2]
out := append(sub, 9)
fmt.Println(src, sub, out, len(sub), cap(sub), &src[0] == &out[0])
```

先预测并运行验证，再回答：

1. 预测两个场景能否编译、是否会 `panic`。
2. 分别写出场景 A、B 的 `src`、`sub`、`out`、`len(sub)`、`cap(sub)` 和地址比较结果。
3. 两个场景唯一改变的是派生切片的容量上界；说明该变化如何影响 `append` 返回切片是否仍与 `src` 共享底层数组。

<details>
<summary>查看参考答案与解释</summary>

两个场景都能编译，运行时都不会 `panic`。输出为：

```text
// 场景 A
[1 2 9 4] [1 2] [1 2 9] 2 4 true

// 场景 B
[1 2 3 4] [1 2] [1 2 9] 2 2 false
```

场景 A 中，`sub := src[:2]` 的长度为 2，容量为 4。它尚有足够容量，`append` 会把 `9` 写入原底层数组的索引 2，所以 `src[2]` 变为 `9`，`out` 与 `src` 的首元素地址相同。`sub` 的长度仍是 2，因此打印 `sub` 时看不到索引 2，但底层存储已经改变。

场景 B 的完整切片表达式把 `sub` 的容量限制为 2。追加一个元素时容量不足，`append` 必须为返回切片准备新的底层数组，所以 `src` 不变，两个首元素地址也不同。

</details>

### 实验 4：`copy` 的复制数量与存储独立性

以下两个场景视为互不影响的独立程序，每个场景都从新的 `src := []int{1, 2, 3, 4}` 开始；唯一改变的是 `dst` 的来源。

```go
// 场景 A：dst 独立分配
src := []int{1, 2, 3, 4}
dst := make([]int, 2)
n := copy(dst, src)
fmt.Println("A1", n, src, dst)
src[0] = 9
fmt.Println("A2", src, dst)
dst[1] = 8
fmt.Println("A3", src, dst)
```

```go
// 场景 B：dst 是 src 的派生切片
src := []int{1, 2, 3, 4}
dst := src[:2]
n := copy(dst, src)
fmt.Println("B1", n, src, dst)
src[0] = 9
fmt.Println("B2", src, dst)
dst[1] = 8
fmt.Println("B3", src, dst)
```

先预测并运行验证，再回答：

1. 预测两个场景能否编译、是否会 `panic`。
2. 按执行顺序写出 A1～A3、B1～B3 的完整输出。
3. 解释两个场景中 `n` 与 `len(src)`、`len(dst)` 的关系。
4. 说明 `copy` 是否负责创建独立存储，以及为什么 A2/A3 与 B2/B3 的修改传播不同。

<details>
<summary>查看参考答案与解释</summary>

两个场景都能编译，运行时都不会 `panic`。输出为：

```text
A1 2 [1 2 3 4] [1 2]
A2 [9 2 3 4] [1 2]
A3 [9 2 3 4] [1 8]

B1 2 [1 2 3 4] [1 2]
B2 [9 2 3 4] [9 2]
B3 [9 8 3 4] [9 8]
```

`copy` 返回实际复制的元素数量，即 `min(len(dst), len(src))`。两个场景里 `len(dst) == 2`、`len(src) == 4`，所以 `n` 都是 `2`。

`copy` 只把元素复制到调用方提供的目标切片，不负责为目标创建独立存储。场景 A 的独立性来自此前的 `make([]int, 2)`，所以之后修改任一方都不会影响另一方。场景 B 的 `dst` 是 `src` 的派生切片，二者一直共享底层数组；初始 `copy` 恰好把前两个元素复制到原位置，没有改变值，后续通过任一切片写入都会被另一方观察到。

</details>

### 实验 5：切片与数组转换边界

以下正常路径和失败路径分别运行；失败路径特意设置容量大于长度，以检查转换究竟使用哪一个边界：

```go
// convert_ok.go 的 main
s := []int{10, 20, 30}
value := [2]int(s)
pointer := (*[2]int)(s)
value[0] = 11
fmt.Println("A", s, value, *pointer)
pointer[1] = 22
fmt.Println("B", s, value, *pointer)

// convert_too_long.go 的 main
s := make([]int, 3, 5)
copy(s, []int{10, 20, 30})
value := [4]int(s)
fmt.Println(value)
```

先预测并运行验证，再回答：

1. 预测正常路径能否编译、是否会 `panic`，并写出 A、B 中 `s`、`value`、`*pointer` 的完整值。
2. 分别解释修改数组值和通过数组指针修改时，哪一个对象的元素发生变化。
3. 预测失败路径能否编译、是否会 `panic`、能否运行到 `Println`，并说明失败阶段和原因。

<details>
<summary>查看参考答案与解释</summary>

正常路径能够编译，运行时不会 `panic`，输出为：

```text
A [10 20 30] [11 20] [10 20]
B [10 22 30] [11 20] [10 22]
```

`[2]int(s)` 复制 `s` 的前两个元素，得到独立数组 `value`，所以 `value[0] = 11` 不会改变 `s`。`(*[2]int)(s)` 得到指向切片前两个元素的数组指针，没有复制元素；`pointer[1] = 22` 因而修改 `s[1]`。独立的 `value` 仍保持 `[11 20]`。

失败路径也能通过编译，因为切片长度是运行时属性。执行 `[4]int(s)` 时，切片容量虽为 `5`，长度 `3` 仍小于目标数组长度 `4`，程序在转换处 `panic`，不会运行到 `fmt.Println(value)`。判断条件是 `len(s) >= 4`，即使底层数组容量更大但切片长度不足也不能完成转换。

</details>

### 实验 6：清零切片与清空映射

```go
package main

import "fmt"

func main() {
	s := []int{1, 2, 3}
	alias := s[:]
	clear(s[:2])
	fmt.Println("A", s, alias, len(s), cap(s))
	s = s[:0]
	fmt.Println("B", len(s), cap(s), alias)
	clear(s)
	fmt.Println("C", alias)

	m := map[string]int{"x": 1}
	other := m
	clear(m)
	fmt.Println("D", len(m), len(other), m == nil)
	other["y"] = 2
	fmt.Println("E", m["y"])
	var missing map[string]int
	clear(missing)
	fmt.Println("F", len(missing), missing == nil)
}
```

先预测并运行验证，再回答：

1. A～C 中哪些元素会变为零？`s = s[:0]` 是否会改变 `alias` 的长度？
2. D～F 中清空操作是否影响共享的映射？nil 映射是否被初始化？
3. 另建程序，保留 `var missing map[string]int` 和 `clear(missing)` 后，执行 `missing["x"] = 1`，记录失败阶段。

<details>
<summary>查看参考答案与解释</summary>

```text
A [0 0 3] [0 0 3] 3 3
B 0 3 [0 0 3]
C [0 0 3]
D 0 0 false
E 2
F 0 true
```

`clear(s[:2])` 只清零前两个共享元素。随后把 `s` 的长度改为零，不会修改 `alias` 的长度或元素；再调用 `clear(s)` 时已没有长度范围内的元素，所以 C 中的 `3` 保留。

`m` 与 `other` 引用同一个映射，清空后两者长度都为零，仍可写入。`clear(missing)` 则是无操作，`missing` 仍为 nil；对它写入会在运行时触发 `panic: assignment to entry in nil map`。

</details>

### 实验 7：字符串字节与 UTF-8 边界

```go
package main

import (
	"fmt"
	"unicode/utf8"
)

func main() {
	s := "Hi 🌞"
	part := s[3:4]
	fmt.Println("A", len(s), utf8.RuneCountInString(s), utf8.ValidString(s))
	fmt.Printf("B % x\n", []byte(s))
	fmt.Printf("C %d % x\n", s[3], []byte(part))
	fmt.Printf("D %q %t\n", part, utf8.ValidString(part))
}
```

先预测并运行验证，再回答：

1. 预测程序能否编译、是否会 `panic`。
2. 写出 A 的三个值，并分别说明 `len` 和 `RuneCountInString` 的计数单位。
3. 写出 B 的完整十六进制字节序列，以及 C 中 `s[3]` 的十进制值和 `part` 的十六进制字节。
4. 预测 D 的 `%q` 显示和 UTF-8 有效性；解释为什么必须同时保存原始字节与有效性，不能只看终端显示。

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A 7 4 true
B 48 69 20 f0 9f 8c 9e
C 240 f0
D "\xf0" false
```

`len(s)` 统计 UTF-8 编码后的字节数：ASCII 的 `H`、`i` 和空格各占 1 字节，`🌞` 占 4 字节，共 7 字节。`utf8.RuneCountInString` 按解码得到的 Unicode 代码点计数，因此结果为 4。

索引字符串得到单个字节，`s[3]` 是太阳符号编码的首字节 `0xf0`，十进制为 `240`。切片 `s[3:4]` 也只包含这个字节，它不构成完整的 UTF-8 编码，所以 `utf8.ValidString(part)` 为 `false`，`%q` 将原始无效字节转义为 `"\xf0"`。

终端可能替换、隐藏或以不同方式渲染无效 UTF-8。十六进制字节记录实际数据，`ValidString` 记录编码是否合法；两者结合才能避免把显示效果误当成原始内容。

</details>

### 实验 8：nil 映射的读写边界

以下读取和写入场景视为两个互不影响的独立程序：

```go
// read.go 的 main
var nilMap map[string]int
withZero := map[string]int{"zero": 0}
a, okA := nilMap["missing"]
b, okB := withZero["missing"]
c, okC := withZero["zero"]
fmt.Println("A", a, okA)
fmt.Println("B", b, okB)
fmt.Println("C", c, okC)

// write.go 的 main
var nilMap map[string]int
fmt.Println("before")
nilMap["x"] = 1
fmt.Println("after")
```

先预测并运行验证，再回答：

1. 预测两个场景能否编译。
2. 逐行写出读取场景的 A、B、C，并说明为什么 B/C 都读取到 `0`，却必须用 `ok` 区分。
3. 预测写入场景会打印哪些行、是否 `panic`、失败发生在哪个阶段。
4. 分别用一句话概括 nil 映射的读取规则和写入规则。

<details>
<summary>查看参考答案与解释</summary>

两个场景都能编译。读取场景不会 `panic`，输出为：

```text
A 0 false
B 0 false
C 0 true
```

从 nil 映射读取与从非 nil 映射读取缺失键一样，都会得到元素类型的零值和 `false`。键 `"zero"` 确实存在，只是保存的值恰好也是 `0`，因此 C 的第二个结果是 `true`。只看单值结果无法区分 B 与 C，必须检查 `ok`。

写入场景先打印：

```text
before
```

随后执行 `nilMap["x"] = 1` 时发生运行时 `panic: assignment to entry in nil map`，所以不会打印 `after`。概括来说：读取 nil 映射是安全的，会像读取缺失键一样返回零值；写入 nil 映射会在运行时 `panic`，必须先用字面量或 `make` 初始化。

</details>

### 实验 9：映射内容比较与 nil 状态

```go
package main

import (
	"fmt"
	"maps"
)

func main() {
	var nilMap map[string]int
	emptyMap := map[string]int{}
	first := map[string]int{"a": 1, "b": 2}
	second := make(map[string]int)
	second["b"] = 2
	second["a"] = 1

	fmt.Println("A", maps.Equal(nilMap, emptyMap))
	fmt.Println("B", nilMap == nil, emptyMap == nil)
	fmt.Println("C", maps.Equal(first, second))
}
```

先预测并运行验证，再回答：

1. 预测程序能否编译、是否会 `panic`。
2. 逐行写出 A、B、C 的完整输出。
3. 说明 A 与 B 分别回答“内容是否相等”还是“映射值是否为 nil”，为什么一个结论不能替代另一个。
4. 说明 C 中不同的插入顺序是否会影响 `maps.Equal`，以及该函数实际比较什么。

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A true
B true false
C true
```

`maps.Equal` 比较长度以及每个键对应的值。nil 映射和已初始化的空映射长度都为 0、都没有条目，所以 A 的内容比较结果为 `true`。B 使用 `== nil` 检查映射值是否为 nil：`nilMap` 是 nil，`emptyMap` 不是；也可以用 `!= nil` 检查相反条件。内容相同不代表初始化状态相同，因此 A 不能替代 B。

映射没有受保证的条目顺序，`maps.Equal` 也不比较插入顺序。C 中两个映射包含相同的键 `a`、`b`，对应值分别都是 `1`、`2`，所以结果为 `true`。

</details>

### 实验 10：结构体的浅复制

```go
package main

import "fmt"

type Person struct {
	Name string
	Tags []string
}

func main() {
	a := Person{Name: "Ada", Tags: []string{"go", "db"}}
	b := a
	b.Name = "Grace"
	fmt.Println("A", a.Name, b.Name, a.Tags, b.Tags)
	b.Tags[0] = "rust"
	fmt.Println("B", a.Name, b.Name, a.Tags, b.Tags)
}
```

先预测并运行验证，再回答：

1. 预测程序能否编译、是否会 `panic`。
2. 写出 A、B 两行的完整输出。
3. 对比修改 `b.Name` 与修改 `b.Tags[0]`，分别说明为什么前者不影响 `a.Name`，后者却影响 `a.Tags[0]`。
4. 明确回答 `a.Tags` 和 `b.Tags` 是“同一个切片变量”还是“两个切片值共享同一个底层数组”。
5. 解释为什么观察 `a.Name != b.Name` 不能证明结构体中的所有字段都已深复制。

<details>
<summary>查看参考答案与解释</summary>

程序能够编译，运行时不会 `panic`，输出为：

```text
A Ada Grace [go db] [go db]
B Ada Grace [rust db] [rust db]
```

`b := a` 复制整个结构体值。字符串字段 `Name` 的值被复制，给 `b.Name` 重新赋值只替换 `b` 的字段，不会修改 `a.Name`。

切片字段被复制的则是切片描述符，而不是其全部元素。`a.Tags` 与 `b.Tags` 是两个切片值，但它们的描述符指向同一个底层数组；通过 `b.Tags[0]` 修改共享数组后，两个切片都能看到 `"rust"`。`Name` 字段互不影响只证明这个字段的赋值行为，不能证明引用了其他存储的字段也完成了递归复制。

</details>

### 实验 11：结构体可比较性

```go
// comparable.go
package main

import "fmt"

type Key struct {
	Name  string
	Codes [2]int
}

func main() {
	a := Key{Name: "go", Codes: [2]int{1, 2}}
	b := Key{Name: "go", Codes: [2]int{1, 2}}
	c := Key{Name: "go", Codes: [2]int{1, 3}}
	fmt.Println(a == b, a == c)
}
```

```go
// not_comparable.go
package main

import "fmt"

type Key struct {
	Name  string
	Codes []int
}

func main() {
	a := Key{Name: "go", Codes: []int{1, 2}}
	b := Key{Name: "go", Codes: []int{1, 2}}
	fmt.Println(a == b)
}
```

先预测并运行验证，再回答：

1. 预测 `comparable.go` 能否编译，并写出两个比较表达式的布尔值。
2. 预测 `not_comparable.go` 能否编译、错误落在哪个表达式；不要用 `reflect.DeepEqual` 或逐字段比较绕开 `==`。
3. 两个类型唯一改变的是 `Codes` 从 `[2]int` 变为 `[]int`；解释结构体可比较性如何由这一字段决定。

<details>
<summary>查看参考答案与解释</summary>

`comparable.go` 能够编译，运行输出为：

```text
true false
```

数组 `[2]int` 可比较，字符串也可比较，因此 `Key` 的所有字段都可比较。`a == b` 的每个字段都相等；`a == c` 的 `Codes[1]` 不同。

`not_comparable.go` 不能编译，错误落在 `a == b`。切片除与 `nil` 比较外不能使用 `==`，只要结构体含有一个不可比较字段，整个结构体就不可比较。这里唯一改变的 `Codes []int` 足以使 `Key` 失去可比较性，两个切片当前包含相同元素也不会改变这条类型规则。

</details>

### 实验 12：具名与匿名结构体类型身份

```go
// same_fields.go
package main

import "fmt"

type Person struct {
	Name string
	Age  int
}

func main() {
	p := Person{Name: "Ada", Age: 36}
	var anonymous struct {
		Name string
		Age  int
	} = p
	back := Person(anonymous)
	fmt.Println(anonymous, back, p == anonymous)
}
```

```go
// reordered_fields.go
package main

import "fmt"

type Person struct {
	Name string
	Age  int
}

func main() {
	p := Person{Name: "Ada", Age: 36}
	var reordered struct {
		Age  int
		Name string
	} = p
	fmt.Println(reordered)
}
```

先预测并运行验证，再回答：

1. 预测 `same_fields.go` 中的直接赋值、显式转换和比较能否编译，并写出完整输出。将 `back := Person(anonymous)` 改为 `var back Person = anonymous` 后是否仍成立？
2. 预测 `reordered_fields.go` 能否编译以及错误落在哪条赋值。赋值双方的字段名和类型相同，只改变字段顺序会有什么影响？
3. 解释为什么字段集合相同、但顺序不同，仍不足以完成直接赋值。保持字段顺序不变、只添加字段标签时，直接赋值与显式转换的规则又有何区别？

<details>
<summary>查看参考答案与解释</summary>

`same_fields.go` 能够编译。具名的 `Person` 与匿名结构体具有相同的底层类型，并且至少一方不是具名类型，所以可以直接赋值；显式转换回 `Person` 和直接赋值回 `Person` 都成立；字段均可比较，因此 `p == anonymous` 也合法且为 `true`。输出为：

```text
{Ada 36} {Ada 36} true
```

`reordered_fields.go` 不能编译，错误落在把 `p` 赋给 `reordered` 的声明上，`fmt.Println` 不会执行。结构体的类型身份由字段序列决定，其中包括字段的顺序、名称、类型、是否嵌入以及标签等信息，而不是把字段看成无序集合。因此，即使两个结构体都有 `Name string` 和 `Age int`，顺序不同也会得到不同的底层结构体类型，不能完成这里的直接赋值。只改变字段标签也会改变底层类型，从而阻止这里的直接赋值；普通结构体的显式转换忽略标签，因此仅标签不同仍可转换。

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
- [Go 标准库 `slices` 包](https://pkg.go.dev/slices)
- [Go 标准库 `maps` 包](https://pkg.go.dev/maps)
- [Go Blog：Strings, bytes, runes and characters in Go](https://go.dev/blog/strings)
