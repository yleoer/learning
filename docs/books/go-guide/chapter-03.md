---
title: 第 3 章 复合类型
description: Go 的数组、切片、字符串、映射和结构体，以及它们的存储与比较规则。
---

# 第 3 章 复合类型

## 本章要点

本章围绕复合类型在赋值、传参与修改时的值独立性与底层存储共享机制展开，系统阐述数组、切片、字符串、映射和结构体的内存模型，以及长度、容量、零值和可比较性对操作的约束。核心目标是准确判定各类数据操作的影响边界，掌握容器的初始化、复制与清理策略，并厘清字节序列与 Unicode 代码点的处理差异。

> 核对日期：2026 年 10 月 15 日；核对环境：Go 1.27.2、Windows/AMD64。

## 3.1 数组：长度属于类型 {#ch3-1}

数组是由固定长度、同类型元素组成的连续序列。数组长度属于类型定义的组成部分，`[3]int` 与 `[4]int` 是完全不同的类型。

除另有说明外，正文代码片段均位于 `main` 函数内，省略 `package main` 及导入声明；涉及的标准库包在首次出现处注明导入路径。

```go
var a [3]int
b := [3]int{10, 20, 30}
c := [...]int{10, 20, 30} // 编译器推导为 [3]int
d := [12]int{1, 5: 4, 6, 10: 100, 15}
```

`d` 的值为 `[1 0 0 0 0 4 6 0 0 0 100 15]`。字面量显式指定索引后，后续未标明索引的元素沿该位置依次递增填充，未初始化的位置默认取元素类型的零值。数组长度必须为编译期可确定的非负整数常量，不可使用运行时变量。

数组支持下标索引、`len` 和 `cap`，后两者均返回数组长度。仅当元素类型可比较时，数组才支持 `==` 和 `!=` 运算；比较两个数组还要求至少一方可赋值给另一方的类型（即两者类型相同，或其中一方为底层类型相同的未命名数组类型）。例如 `[3]int` 可比较，而 `[3][]int` 不可比较。

数组赋值与函数传参均执行全量元素的浅复制：若元素内部包含指针、切片或映射，仅复制其地址或描述符，副本仍与原数组共享这些字段所引用的底层数据。数组适用于长度由协议或算法严格固定的场景（如密码学哈希摘要）；长度动态变化或需构建通用接口时，应使用切片。

数组有效索引范围为 `0` 至 `len(a)-1`。常量索引越界在编译期报错，变量索引越界则在运行时触发 `panic`。多维数组通过一维数组嵌套构成，例如 `[2][3]int` 表示由 2 个 `[3]int` 元素组成的数组。

## 3.2 切片：可变长度的视图 {#ch3-2}

切片（Slice）是对底层数组连续片段的动态视图，其运行时描述符（Slice Header）包含三个字段：指向底层数组起始元素的指针、切片长度（`len`）和切片容量（`cap`）。切片赋值或传参仅复制该描述符，多个切片可共享同一底层数组。

```go
var nilSlice []int
empty := []int{}
reserved := make([]int, 0, 5)
filled := make([]int, 5, 10)
```

| 表达式 | `len` | `cap` | 是否为 `nil` | 语义与适用场景 |
| --- | ---: | ---: | :---: | --- |
| `var s []int` | 0 | 0 | 是 | 零值切片，无需初始化即可直接调用 `append` |
| `[]int{}` | 0 | 0 | 否 | 非 `nil` 空切片，默认 JSON 编码结果异于 `nil` 切片 |
| `make([]int, 0, 5)` | 0 | 5 | 否 | 预分配容量为 5 的底层数组，配合 `append` 填充 |
| `make([]int, 5, 10)` | 5 | 10 | 否 | 初始化 5 个可直接索引的零值元素，总容量为 10 |

`nil` 切片与非 `nil` 空切片在序列化时存在差异：`encoding/json` 将 `nil` 切片编码为 `null`，而将 `[]int{}` 编码为 `[]`。若外部接口严格区分“字段缺失”与“空列表”，需据此选择初始化方式。

切片字面量支持顺序初始化或按索引稀疏初始化，其长度与容量均由最大索引位置加一决定：

```go
primes := []int{2, 3, 5, 7}
sparse := []int{1, 3: 10} // [1 0 0 10]，len 和 cap 均为 4
```

`len` 表示当前可安全索引的元素个数；`cap` 表示在不重新分配底层数组的前提下，切片从当前起始位置可延伸的最大元素个数。处于容量范围内但超出当前长度的位置不可直接索引：对 `make([]int, 0, 5)` 访问 `s[0]` 会触发运行时越界 `panic`，必须先通过 `append` 或切片表达式扩展长度。

### 3.2.1 `append` 与扩容机制 {#ch3-2-1}

```go
s = append(s, 10)
s = append(s, 5, 6, 7)
s = append(s, other...)
```

`append` 将元素追加至切片末尾并返回新切片描述符，返回值通常赋回原变量，也可赋给其他变量或直接作为函数返回值。丢弃 `append` 返回值会导致编译失败；写作 `_ = append(s, 10)` 虽可通过编译，但不会更新 `s` 的长度。

- **未超出容量**：直接在原切片末尾对应的底层数组位置写入新元素，返回的新切片与原切片共享底层存储，可能覆写共享该底层数组的其他切片元素。
- **超出容量**：运行时分配容量更大的新底层数组，将原切片元素复制至新数组后再追加新元素，返回的切片指向新数组。

追加 `n` 个元素后，切片长度增加 `n`。调用 `append(s)` 或追加空切片 `append(s, []int{}...)` 均合法，切片长度保持不变。

函数传参仅复制切片描述符。函数内部通过索引修改已有元素会反映至调用方；但函数内执行 `append` 引发的长度变更或底层数组扩容，不会更新调用方的切片描述符。若函数需修改切片长度，必须将新切片作为返回值传回。

### 3.2.2 `make` 的长度与容量 {#ch3-2-2}

```go
buf := make([]byte, 1024)    // 1024 个可直接索引的零值字节
items := make([]int, 0, 100) // 长度为 0，预留 100 个元素的容量
```

已知确切元素数量且按索引赋值时，应指定非零长度（如 `make([]T, N)`）；元素数量动态生成或需逐步过滤时，应指定零长度与预估容量（如 `make([]T, 0, cap)`）并配合 `append` 使用。切勿对 `make([]int, 5)` 直接调用 `append` 填充初始数据，否则新元素将追加在 5 个初始零值之后。

`make([]T, length, capacity)` 要求满足 `0 <= length <= capacity`（省略 `capacity` 时默认等于 `length`）。违反该约束的常量参数在编译期报错，运行时变量参数则触发 `panic`。容量预估应基于实际数据规模，避免盲目预分配过大内存。

### 3.2.3 派生切片与共享存储 {#ch3-2-3}

切片表达式遵循左闭右开原则，仅生成新的切片描述符，不复制底层元素：

| 表达式 | 长度 | 容量 | 索引边界约束 |
| --- | --- | --- | --- |
| `x[low:high]` | `high-low` | `cap(x)-low` | `0 <= low <= high <= cap(x)`（省略 `high` 默认取 `len(x)`） |
| `x[low:high:max]` | `high-low` | `max-low` | `0 <= low <= high <= max <= cap(x)`（`high` 与 `max` 不可省略） |
| `x[:]` | `len(x)` | `cap(x)` | 等价于 `x[0:len(x)]` |

直接索引 `x[i]` 要求 `0 <= i < len(x)`，而切片表达式的索引上限可延伸至 `cap(x)`。

三索引切片（Go 1.2 引入）通过 `max` 将派生切片的容量限制为 `max-low`。当容量限制为与长度相等时，首次追加元素即会触发底层数组扩容，从而防止覆写原切片的后续元素：

```go
x := []string{"a", "b", "c", "d"}
y := x[:2:2]       // len=2, cap=2
y = append(y, "z") // 触发扩容分配新数组，x 保持 [a b c d] 不变
```

三索引切片本身不复制数据；在触发扩容前修改 `y[0]`，仍会同步修改 `x[0]`。若需获取独立的底层元素存储，可调用 Go 1.21 引入的标准库函数 `slices.Clone(x)`（导入路径 `"slices"`），或通过 `make` 配合 `copy` 实现。两者均为浅复制：若元素内部包含指针、切片或映射，其引用的深层数据仍可能共享。

> 克隆的 `nil` 语义与 GC 内存滞留
>
> 1. **保留 `nil` 状态**：对零值切片 `var src []int`，`slices.Clone(src)` 返回 `nil`（直接调用无类型 `slices.Clone(nil)` 因无法推断类型而编译失败）。未加判空的 `make([]int, len(src))` 则返回非 `nil` 空切片，可能改变默认 JSON 序列化结果。
> 2. **防范底层大数组内存滞留**：只要存在任一活动切片引用底层数组，垃圾回收器（GC）即无法回收整个底层数组。例如从 10 MB 的读取缓冲区 `buf` 中直接切出 `buf[:64]` 并长期持有，会导致整个 10 MB 数组常驻内存。此类场景必须使用 `slices.Clone(buf[:64])` 将目标片段复制至独立小数组，以解除对大缓冲区的引用。

### 3.2.4 `copy` 与 `clear` {#ch3-2-4}

`copy(dst, src)` 将源切片元素复制到目标切片，实际复制元素个数为 `min(len(dst), len(src))`。`copy` 不会自动扩展 `dst` 的长度，且支持同一底层数组内的重叠区间复制：

```go
dst := make([]int, len(src))
copy(dst, src)
```

`copy(make([]int, 0, 10), src)` 的复制数量为 `0`。重叠区间复制示例：若 `s := []int{1, 2, 3, 4}`，执行 `copy(s[:3], s[1:])` 返回 `3`，`s` 变为 `[2 3 4 4]`。常规切片复制要求两侧元素类型严格一致；此外，`copy` 特例支持将字符串字节直接复制至字节切片（如 `copy(dstBytes, "Go")`）。

内置函数 `clear(s)`（Go 1.21 引入）将切片当前长度（`len(s)`）范围内的元素重置为零值，保持长度与容量不变；共享这些底层位置的其余切片也会观察到元素归零。`s = s[:0]` 仅将当前切片描述符的长度置零，不修改底层数组元素。对 `nil` 切片调用 `clear` 为无操作。

> 缩短切片时的引用清理
>
> 当切片元素为指针或包含引用类型时，仅缩短切片长度不会清除底层数组尾部的残留槽位。只要底层数组仍可达，超出新长度但位于容量内的旧指针会阻碍所指对象被 GC 回收，造成内存滞留。若尾部元素确已废弃，应先执行 `clear(s[newLen:])` 将残留引用置零，再执行 `s = s[:newLen]`（要求 `0 <= newLen <= len(s)`）。该操作会同步清空共享同一底层数组对应位置的别名数据，执行前需确认无其他活跃引用依赖这些元素。此外，缩短切片长度不会缩减底层数组容量。

### 3.2.5 切片比较 {#ch3-2-5}

切片之间不支持 `==` 或 `!=` 运算，仅允许与 `nil` 比较。按元素内容比较需使用 `slices.Equal`（以下示例同时导入标准库 `"fmt"`）：

```go
var a []int
b := []int{}
fmt.Println(a == nil)           // true
fmt.Println(b == nil)           // false
fmt.Println(slices.Equal(a, b)) // true
```

`slices.Equal` 要求元素类型可比较；`slices.EqualFunc` 支持传入自定义比较函数。两者均先比对切片长度，再按索引逐一比对元素，不检查底层数组地址，且将 `nil` 切片与非 `nil` 空切片判定为内容相等。若元素为接口类型，其动态值仍须遵循接口比较规则。

### 3.2.6 数组与切片的转换 {#ch3-2-6}

#### 数组派生切片

对可寻址的数组执行切片表达式，将生成共享该数组存储的切片：

```go
a := [4]int{1, 2, 3, 4}
s := a[:] // 与数组 a 共享底层存储
s[0] = 10 // a[0] 同步变为 10
```

#### 切片转换为数组或数组指针

```go
s := []int{1, 2, 3, 4}
a := [2]int(s)    // 复制前 2 个元素至新数组（Go 1.20+）
p := (*[4]int)(s) // 获取底层前 4 个元素的数组指针，共享存储（Go 1.17+）
```

目标数组长度 `N` 必须为编译期非负整数常量。上述两种转换均要求 `len(s) >= N`；若 `len(s) < N`（即使 `cap(s) >= N`），将在运行时触发 `panic`。转换为数组值 `[N]T` 会复制前 `N` 个元素，转换为数组指针 `*[N]T` 则与原切片共享底层元素。边界情形下，`nil` 切片转换为 `[0]T` 得到零值空数组，转换为 `*[0]T` 得到 `nil` 指针；非 `nil` 空切片转换为 `*[0]T` 则得到非 `nil` 指针。

## 3.3 字符串、字节和 `rune` {#ch3-3}

Go 字符串是不可变的字节序列，而非字符或 `rune` 序列。Go 源码文件固定采用 UTF-8 编码；字符串字面量通常为有效 UTF-8 序列，但语言规范允许字符串存储任意字节序列。

```go
s := "Hi 🌍"
fmt.Println(len(s)) // 7：返回 UTF-8 字节长度（"Hi " 占 3 字节，"🌍" 占 4 字节）
fmt.Println(s[3])   // 240 (0xf0)：返回 "🌍" 的首字节，而非完整字符
```

字符串的内置函数 `len`、下标索引 `s[i]` 和切片表达式 `s[low:high]` 均以**字节**为单位：

- 下标索引 `s[i]` 的返回类型为 `byte`（`uint8` 的类型别名）。
- 字符串不支持 `cap` 函数及三索引切片，切片边界须满足 `0 <= low <= high <= len(s)`。切片边界若截断多字节 UTF-8 字符，不会触发运行时 `panic`，但会生成无效的 UTF-8 字节序列。

按 Unicode 代码点（Code Point）处理文本时，可使用 `for range` 循环、转换为 `[]rune`（`rune` 为 `int32` 的类型别名），或调用标准库 `unicode/utf8`（导入路径 `"unicode/utf8"`）的解码与计数函数。沿用上例中的 `s`：

```go
rs := []rune(s)
fmt.Println(len(rs)) // 4：按 Unicode 代码点计数

for i, r := range s {
    fmt.Printf("%d:%c ", i, r) // 输出 0:H 1:i 2:  3:🌍
}
```

`for i, r := range s` 按 UTF-8 规则解码，迭代变量 `i` 为当前代码点起始位置的**字节偏移量**。上例中 `i` 依次取 `0`、`1`、`2`、`3`；因 `🌍` 占 4 个字节，后续若存在其他代码点，其起始偏移量将为 `7`。若遇到无效 UTF-8 字节，循环产出一个替换字符 `U+FFFD`（``），并将字节偏移量前进 `1`。

用户视觉感知的单个字符可能由多个 Unicode 代码点组合而成，称为字素簇（Grapheme Cluster，如带组合变音符号的字母或复合 Emoji），无法仅凭 `len([]rune(s))` 统计其数量。涉及按视觉字符截断文本或移动光标时，需进行字素簇分段；终端实际渲染宽度还受字体与环境影响。

字符串与切片、整数的常见类型转换规则如下：

```go
bs := []byte(s)  // 复制为原始字节序列
rs = []rune(s)   // 按 UTF-8 解码；每个无效字节转换为一个 U+FFFD
s1 := string(bs) // 原样保留全部字节
s2 := string(rs) // 将代码点序列编码为 UTF-8 字符串
```

- **字节转换与隔离性**：`string` 与 `[]byte` 互转完整保留全部字节（含无效 UTF-8）。语言语义保证修改转换后的字节切片不会改变原字符串；底层是否发生堆内存分配由编译器逃逸分析与优化决定。`[]rune` 转换则执行 UTF-8 解码并将非法字节替换为 `U+FFFD`，不可用于任意二进制数据的无损往返转换。
- **整数转字符串**：`string('A')` 与 `string(65)` 均将整数按 Unicode 代码点编码为 `"A"`，而非十进制文本 `"65"`。`string(byte(0xff))` 同样按代码点 `U+00FF` 生成双字节 UTF-8 字符串 `"ÿ"`；若需保留单字节 `0xff`，应写为 `string([]byte{0xff})`。超出合法范围的无效代码点统一转换为 `U+FFFD`。将整数格式化为十进制文本应使用 `strconv.Itoa`（导入 `"strconv"`）或 `fmt.Sprint`。

整数转字符串虽属合法语法，但受静态分析工具约束。在 Go 1.27.2 环境中，`go vet` 内置的 `stringintconv` 分析器会拦截 `string(65)` 或 `string(n)`（`n` 为 `int`）等非 `rune`/`byte` 类型的整数转换；由于 `go test` 默认执行该检查，此类代码会导致测试构建失败。

## 3.4 映射（`map`） {#ch3-4}

映射是无序的键值对集合，类型记作 `map[K]V`。键类型 `K` 必须支持 `==` 和 `!=` 比较运算，因此切片、映射和函数不可作为键类型。接口类型可作为键类型，但若写入、查找或删除的动态值不可比较，将在运行时触发 `panic`。

自 Go 1.24 起，官方工具链默认采用基于 Swiss Table 的运行时映射实现。由于底层结构随版本演进，工程代码应严格遵循语言规范，切勿依赖特定版本的内部结构（如旧版 `hmap`、桶内存布局或元素地址）。

```go
var nilMap map[string]int
scores := map[string]int{}
ages := make(map[string]int, 100)
```

- **`nil` 映射**：零值映射的 `len` 为 `0`。使用合法键读取时始终返回值类型的零值；向其写入键值对则触发运行时 `panic`（若接口键的动态值不可比较，读取或删除同样会触发 `panic`）。
- **已初始化映射**：通过空字面量 `map[K]V{}` 或 `make(map[K]V, hint)` 创建可读写映射。`make` 的第二参数 `100` 为容量提示（Hint），运行时据此预分配存储以减少扩容次数，但既不创建初始条目，也不限制最大容量。映射不支持 `cap` 函数。

已知初始条目时，可使用字面量初始化（多行书写时末尾条目必须保留逗号）：

```go
scores := map[string]int{
    "go":   10,
    "rust": 8,
}
```

映射仅支持与 `nil` 进行 `==` 或 `!=` 比较。映射赋值与传参仅复制映射描述符（底层表引用），多个别名共享同一映射存储，任一别名的增删改操作对其他别名均可见；对某变量重新赋以新映射则仅改变该变量自身的绑定。

标准库 `maps` 包（Go 1.21 引入，导入路径 `"maps"`）提供 `maps.Clone(m)`，用于创建独立的键值容器副本；传入具名类型的 `nil` 映射时返回 `nil`。该函数对键和值执行浅复制，若键或值内部包含指针、切片或映射，深层数据仍会共享。

### 3.4.1 读写、逗号 `ok` 与删除 {#ch3-4-1}

```go
scores["go"] = 10
scores["go"]++

value, ok := scores["rust"]
if !ok {
    fmt.Println("key not found", value)
}

delete(scores, "go") // 键不存在或映射为 nil 时均为无操作
clear(scores)        // 清空所有键值对；非 nil 映射清空后仍可直接写入
```

单值读取 `v := m[k]` 无法区分“键不存在”与“键存在且值为零值”，需通过“逗号 `ok`”模式（`v, ok := m[k]`）判定键是否存在。在键合法的前提下，`delete` 对不存在的键或 `nil` 映射均为无操作；`clear` 对 `nil` 映射亦为无操作。两者均不会将 `nil` 映射转换为可写映射。

语言规范未固定映射的 `for range` 遍历顺序；运行时会对遍历起点与顺序施加随机扰动，同一程序多次遍历同一映射可能得到不同顺序。若需确定性输出，应先提取键切片并显式排序（详见 [4.4.4 节](./chapter-04#ch4-4-4)）。

> 并发访问与内存回收边界
>
> 1. **并发访问**：无写入操作时，多个 Goroutine 可安全并发读取同一映射；一旦存在并发写或读写交叉，必须施加同步控制。未同步的并发读写会触发不可由 `recover` 捕获的运行时致命错误（如 `fatal error: concurrent map writes`），即便偶然未崩溃也存在数据损坏风险。工程中通常使用标准库 `"sync"` 的互斥锁（`sync.Mutex` / `sync.RWMutex`）保护映射，或在符合特定读多写少场景时选用 `sync.Map`。
> 2. **内存回收**：在 Go 1.27.2 运行时实现中，`clear` 仅清除键值条目而保留已分配的底层表空间供后续复用，`delete` 亦不会缩减底层表容量。需区分“条目所引用的对象”与“映射自身的表存储”：删除或清空条目可使被引用对象不可达并由 GC 回收，但映射底层表占用的内存不会归还。若映射经历流量峰值后需释放底层表空间，应创建新映射并迁移有效条目；待原映射无任何活跃引用后，其表存储方可被 GC 回收。

### 3.4.2 映射模拟集合 {#ch3-4-2}

Go 未内置集合（Set）类型，标准库亦未提供通用集合容器，工程中通常利用映射键的唯一性模拟集合：

```go
set := map[string]struct{}{}
set["go"] = struct{}{}
if _, ok := set["go"]; ok {
    fmt.Println("present")
}
```

- **`map[T]struct{}`**：空结构体 `struct{}` 大小为 0 字节，仅凭键的存在性表达成员身份，不额外消耗值存储空间（映射底层仍需为键及表元数据分配内存）。
- **`map[T]bool`**：若约定仅存入 `true` 且移除元素时统一调用 `delete`，可直接通过 `if set[v]` 判断成员资格；若允许存入 `false`，则仍须配合逗号 `ok` 区分键缺失与 `false` 值。

### 3.4.3 比较映射内容 {#ch3-4-3}

标准库 `maps.Equal` 用于按内容比较两个映射（要求值类型可比较），`maps.EqualFunc` 则支持传入自定义值比较函数。两者均忽略插入顺序，且将 `nil` 映射与非 `nil` 空映射视为内容相等：

```go
first := map[string]int{"go": 10, "rust": 8}
second := map[string]int{"rust": 8, "go": 10}
fmt.Println(maps.Equal(first, second)) // true
```

## 3.5 结构体（`struct`） {#ch3-5}

结构体是由编译期确定的具名字段聚合而成的复合值类型。相比使用 `map[string]any`（`any` 为 Go 1.18 引入的 `interface{}` 别名）动态拼装数据，结构体提供编译期类型检查与紧凑的连续内存布局，是构建领域模型的标准选择。

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

结构体的零值由其所有字段各自的零值构成。结构体赋值与传参均执行浅复制，按值拷贝全部字段。初始化结构体时，推荐始终采用**带字段名的字面量**（如 `Person{Name: "Bob", Age: 50}`）：字段顺序任意，未指定字段自动取零值，且后续扩充结构体字段不会破坏既有代码。省略字段名的位置字面量必须严格按声明顺序提供全部字段，仅适用于 `Point{10, 20}` 等结构高度稳定的小型内部类型。

> 映射中的结构体值不可寻址
>
> 映射索引表达式 `m[k]` 不属于可寻址操作数，Go 禁止对映射元素取地址（`&m[k]` 编译报错）。因此，当映射值类型为结构体（如 `m := map[string]Person{}`）时，**无法直接修改其字段**（执行 `m["bob"].Age = 51` 会触发编译错误 `cannot assign to struct field m["bob"].Age in map`）。标准工程解法有两种：
>
> 1. **读-改-写回**：`p := m["bob"]; p.Age = 51; m["bob"] = p`。
> 2. **存储结构体指针**：将映射声明为 `map[string]*Person`，直接解引用修改字段 `m["bob"].Age = 51`（须确保指针非 `nil`）。

### 3.5.1 匿名结构体 {#ch3-5-1}

无需 `type` 声明的匿名结构体适用于一次性数据组装、JSON 编解码载荷及表格驱动测试（Table-Driven Tests）：

```go
payload := struct {
    Name string `json:"name"`
    Age  int    `json:"age"`
}{Name: "Ada", Age: 36}
```

字段右侧的反引号字符串为**结构体标签**（Struct Tag），属于编译期附加的元数据，可由标准库 `reflect`（导入路径 `"reflect"`）在运行时读取。标签自身不执行编解码逻辑：例如 `encoding/json` 默认以导出字段名作为键，读取到 `json:"name"` 标签后才将该字段映射为 `"name"`，无特殊映射需求时无需为每个导出字段显式添加标签。

### 3.5.2 比较与转换 {#ch3-5-2}

- **可比较性**：当且仅当结构体的全部字段类型均可比较时，该结构体支持 `==` 和 `!=` 运算；比较时按声明顺序逐一比对非空白（`_`）字段，遇首个不等字段即短路返回。包含切片、映射或函数字段会使结构体不可比较；指针与通道字段比较的是引用身份（内存地址或通道描述符）。接口字段虽类型可比较，但若两侧接口持有相同且不可比较的动态类型，比较时将触发运行时 `panic`。
- **显式转换**：两个不同的具名结构体类型不可直接赋值或比较。自 Go 1.8 起，显式类型转换可忽略结构体标签差异，但要求两侧字段的名称、声明顺序、类型、嵌入属性以及未导出字段所属包完全一致（即忽略标签后的底层类型相同）。
- **匿名结构体赋值**：具名结构体类型与底层类型完全相同的匿名结构体之间可直接隐式赋值；若全部字段可比较，亦可直接使用 `==` 或 `!=` 比较。此处的底层类型一致性检查包含结构体标签，仅标签不同也会导致隐式赋值编译失败。

## 练习 {#ch3-exercises}

以下五题检验值复制、共享存储、字节与代码点转换及容器零值语义。建议先独立作答，再展开参考答案核对。除完整程序外，代码片段均假定位于 `main` 函数内；`fmt`、`utf8`、`slices` 分别对应标准库 `"fmt"`、`"unicode/utf8"`、`"slices"`。

### 练习 1：数组的赋值、传参与类型身份

写出程序输出，并说明数组赋值与传参的复制行为。若将 `b := a` 改为 `b := [...]int{1, 2}`，`change(b)` 和 `a == b` 能否通过编译？

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

输出为 `[1 2 0] [1 8 0] false`。`a` 未显式指定的第三个元素取零值 `0`；`b := a` 与 `change(b)` 均执行整数组的值复制，函数内修改形参副本不影响 `b`，修改 `b[1]` 亦不影响 `a`。

改为 `b := [...]int{1, 2}` 后，`b` 被推导为 `[2]int` 类型。因数组长度属于类型的一部分，`[2]int` 与 `[3]int` 类型不兼容，`change(b)` 与 `a == b` 均无法通过编译。

</details>

### 练习 2：三索引切片容量限制与 `copy` 行为

写出 `view` 在追加前的长度与容量，以及原程序的输出。若仅将 `clone` 的初始化改为 `make([]int, 2)`，输出有何变化？说明哪些操作共享存储、哪些操作复制元素。

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

追加前 `view` 的长度与容量均为 `2`。原程序输出：

```text
[1 9 3 4] [8 3 5] [] 0
```

三索引切片 `src[1:3:3]` 仅限制容量，不复制底层元素，因此在扩容前执行 `view[0] = 9` 会同步修改 `src[1]`。随后 `append(view, 5)` 超出容量上限 `2`，触发新底层数组分配与元素复制，此后的 `view[0] = 8` 仅作用于新数组，不再影响 `src`。

`copy` 的复制元素数取决于 `min(len(dst), len(src))`。原代码中 `len(clone)` 为 `0`，故实际复制数量 `n` 为 `0`。改为 `make([]int, 2)` 后，`len(clone)` 为 `2`，在 `view[0]` 被修改前已复制出独立副本 `[2 3]`，输出变为：

```text
[1 9 3 4] [8 3 5] [2 3] 2
```

</details>

### 练习 3：字符串的字节索引与代码点解码

写出三行输出，说明计数与索引各自的单位，并解释为何 `message[3]` 无法表示完整字符。此外，若有 `raw := "A\xff中"`，分别判断 `raw == string([]byte(raw))` 和 `raw == string([]rune(raw))` 的求值结果。

```go
message := "Hi 🌞"
fmt.Println(len(message), utf8.RuneCountInString(message))
fmt.Println(string([]rune(message)[3]))
fmt.Println(message[3])
```

<details>
<summary>查看参考答案</summary>

输出为：

```text
7 4
🌞
240
```

`len(message)` 统计 UTF-8 字节总数（`"Hi "` 占 3 字节，`"🌞"` 占 4 字节，共 7 字节）；`utf8.RuneCountInString` 按 Unicode 代码点计数（共 4 个代码点）。字符串下标 `message[3]` 按字节索引，返回 `"🌞"` UTF-8 编码的首字节 `0xf0`（十进制 `240`）；转换为 `[]rune` 后按代码点索引 `3`，方可获取完整字符 `🌞`。

附加比较的结果依次为 `true`、`false`。`[]byte` 往返转换无损保留包含 `0xff` 在内的全部字节；`[]rune` 转换在解码时将无效 UTF-8 字节 `0xff` 替换为 `U+FFFD`，重编码后变为 `"A中"`，与原字节序列不等。

</details>

### 练习 4：区分零值条目、缺失键与 `nil` 映射

写出输出并说明两次读取的差异。若将首行改为 `var counts map[string]int`，读取是否安全？哪条语句会失败，发生在编译期还是运行期？给出保留零值声明并在写入前完成初始化的修改方案。

```go
counts := map[string]int{"go": 0}
present, okPresent := counts["go"]
missing, okMissing := counts["rust"]
counts["go"]++
fmt.Println(present, okPresent, missing, okMissing, counts["go"])
```

<details>
<summary>查看参考答案</summary>

原程序输出：

```text
0 true 0 false 1
```

键 `"go"` 存在且值为 `0`，键 `"rust"` 不存在；两次读取均返回零值 `0`，通过布尔值 `ok` 区分键是否存在。

将首行改为 `var counts map[string]int` 后，`counts` 为 `nil` 映射。前两次读取均安全并返回 `0, false`；但 `counts["go"]++` 包含映射写入操作，将在**运行期**触发 `panic`，末尾打印语句不会执行。

若保留零值声明，可在两次读取之后、`counts["go"]++` 之前插入 `counts = make(map[string]int)`（对已声明变量须使用赋值符 `=` 而非短变量声明 `:=`），修改后输出为 `0 false 0 false 1`。

</details>

### 练习 5：区分结构体字段赋值与共享元素修改

写出两行输出，说明修改 `b.Name`、`b.Scores[0]` 与重新赋值 `b.Scores` 各自的影响范围。在 `b := a` 之后补充一行代码，使后续对 `b` 的任何修改均不影响 `a`，并给出修改后的输出。

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

结构体赋值 `b := a` 执行浅复制：`Name` 字段彼此独立，但 `Scores` 字段仅复制切片描述符，`a.Scores` 与 `b.Scores` 共享同一底层数组，故 `b.Scores[0] = 9` 会同步修改 `a.Scores[0]`。随后的 `b.Scores = []int{7, 8}` 将 `b.Scores` 指向新切片，不再影响 `a.Scores`，但此前对原底层数组的修改依然保留。

在 `b := a` 之后补充以下语句（需导入 `"slices"`）：

```go
b.Scores = slices.Clone(a.Scores)
```

修改后输出：

```text
Ada [1 2] Lin [9 2]
[1 2] [7 8]
```

本题中 `Scores` 类型为 `[]int`，克隆底层数组后，基本类型 `int` 不再持有外部可变引用，足以实现完全隔离。若字段类型为 `[][]int` 或包含指针的结构体切片，`slices.Clone` 仅浅复制最外层元素，仍需按需递归复制深层引用数据。

</details>

## 面试题 {#ch3-interview}

以下六题检验容器清理、内容比较、克隆边界、类型规则与寻址限制。代码上下文与导入约定沿用[练习部分](#ch3-exercises)，另以 `maps` 对应标准库 `"maps"`；标有 A、B 的语句需分别判定。

### 面试题 1：`clear(s)` 与 `s = s[:0]` 等价吗？

下面代码输出什么？最后一次 `clear(s)` 能否清除 `alias` 中剩余的元素？工程实践中两者应如何配合？

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

不等价，输出为 `[0 0 3] 0 3`。`clear` 将指定切片当前长度范围内的底层元素置零，不改变切片长度与容量；`s = s[:0]` 仅将 `s` 的长度重置为 `0`，不修改底层元素，且 `alias` 的长度仍为 `3`。随后因 `len(s) == 0`，`clear(s)` 作用范围为空，无法清除 `alias[2]`。

工程实践中，对于长期复用且元素包含指针或引用的切片，应在确认元素不再被任何别名使用时，先执行 `clear(s)` 解除底层引用，再执行 `s = s[:0]` 重置长度以复用容量。若此前已缩短切片长度，残留引用可能位于当前长度之外、容量之内，须将清理范围扩展至相应边界（如 `clear(s[:cap(s)])`）。

</details>

### 面试题 2：内容相等判定能代替 `nil` 判断吗？

下面代码输出什么？`slices.Equal` 和 `maps.Equal` 的判定逻辑是什么？

```go
var s []int
var m map[string]int
fmt.Println(slices.Equal(s, []int{}), maps.Equal(m, map[string]int{}))
fmt.Println(s == nil, m == nil)
```

<details>
<summary>查看参考答案</summary>

不能代替，两行均输出 `true true`。`slices.Equal` 比对长度与对应位置的元素，`maps.Equal` 比对键集合与对应值；两者均将 `nil` 容器与非 `nil` 空容器视为内容相等。然而在默认 JSON 序列化中，`nil` 切片与空切片分别编码为 `null` 和 `[]`，`nil` 映射与空映射分别编码为 `null` 和 `{}`；且 `nil` 映射不可直接写入。因此，内容相等判定不能替代 `== nil` 检查。

</details>

### 面试题 3：`maps.Clone` 隔离了哪一层数据？

写出两行输出。为何修改克隆映射中的切片元素与清空映射条目的影响范围不同？

```go
source := map[string][]int{"go": {1}}
alias := source
cloned := maps.Clone(source)
cloned["go"][0] = 9
fmt.Println(source["go"], cloned["go"])
clear(alias)
fmt.Println(len(source), len(cloned), cloned["go"])
```

<details>
<summary>查看参考答案</summary>

两行输出分别为 `[9] [9]` 和 `0 1 [9]`。`alias` 与 `source` 共享同一底层映射表；`maps.Clone` 为 `cloned` 分配了独立的映射表，但对值（`[]int`）仅执行浅复制，导致 `cloned["go"]` 与 `source["go"]` 共享同一底层数组。因此，修改切片元素会同步反映至两侧；而 `clear(alias)` 仅清空 `source` 与 `alias` 共享的映射表条目，不影响 `cloned` 的独立映射表。

</details>

### 面试题 4：结构体能直接赋值就能用 `==` 比较吗？

分别判断语句 A、B 是否合法。若将所有 `Values []int` 改为 `Values [1]int`（对应字面量改为 `[1]int{1}`），结果如何变化？

```go
type Record struct{ Values []int }
a := Record{Values: []int{1}}
var b struct{ Values []int } = a // A
fmt.Println(a == b)              // B
```

<details>
<summary>查看参考答案</summary>

语句 A 合法，语句 B 编译失败。具名结构体 `Record` 与匿名结构体具有相同的底层类型，且其中一方为未命名类型，满足隐式赋值条件；但因结构体包含不可比较的切片字段 `[]int`，不支持 `==` 运算。

将字段类型改为 `[1]int` 后，隐式赋值依然合法，且数组字段支持比较，程序正常编译并输出 `true`。类型间的可赋值性与类型的可比较性属于两项完全独立的判定规则。

</details>

### 面试题 5：切片转数组看长度还是容量？

写出 `fmt.Println` 的输出，并判断末行语句能否通过编译及正常执行。解释两种转换的复制语义，以及 `short` 的长度与容量对结果的影响。

```go
s := []int{1, 2, 3}
value := [2]int(s)
pointer := (*[2]int)(s)
s[0] = 9
fmt.Println(value, pointer[0])
short := s[:1]
_ = (*[2]int)(short)
```

<details>
<summary>查看参考答案</summary>

`fmt.Println` 输出为 `[1 2] 9`；末行语句可通过编译，但在运行期触发 `panic`。转换为数组值 `[2]int(s)`（Go 1.20+）会复制前两个元素，而转换为数组指针 `(*[2]int)(s)`（Go 1.17+）则直接指向原底层数组。`short` 的长度为 `1`、容量为 `3`；切片转数组或数组指针均严格校验切片当前长度 `len(short) >= 2`，容量充足无法替代长度要求。

</details>

### 面试题 6：映射中的结构体为何无法直接修改字段，却能修改其切片元素？

分别判断语句 A、B 能否通过编译。若某条语句合法，写出执行结果并解释底层的寻址规则差异。

```go
type Meta struct {
    Count int
    Tags  []string
}

m := map[string]Meta{
    "go": {Count: 1, Tags: []string{"fast"}},
}
m["go"].Tags[0] = "safe" // A
m["go"].Count++          // B
```

<details>
<summary>查看参考答案</summary>

语句 A 合法，语句 B 编译失败。移除 B 后，语句 A 将 `m["go"].Tags` 的底层元素修改为 `[]string{"safe"}`。

原因在于映射索引表达式 `m["go"]` 返回的是不可寻址的结构体值副本：虽然 `m["go"]` 整体可作为赋值左值，但其内部字段 `m["go"].Count` 不可寻址，无法作为自增或赋值目标（B 编译报错）。而切片索引表达式本身是可寻址的，语句 A 从结构体副本中取出 `Tags` 切片描述符后，通过下标寻址直接修改其指向的底层数组元素，并未修改映射内结构体字段本身。

</details>

## 参考资料

- [Go 语言规范：类型身份](https://go.dev/ref/spec#Type_identity)
- [Go 语言规范：可赋值性](https://go.dev/ref/spec#Assignability)
- [Go 语言规范：比较运算](https://go.dev/ref/spec#Comparison_operators)
- [Go 语言规范：切片到数组的转换](https://go.dev/ref/spec#Conversions_from_slice_to_array_or_array_pointer)
- [Go 语言规范：数组类型](https://go.dev/ref/spec#Array_types)
- [Go 语言规范：切片类型](https://go.dev/ref/spec#Slice_types)
- [Go 语言规范：映射类型](https://go.dev/ref/spec#Map_types)
- [Go 语言规范：结构体类型](https://go.dev/ref/spec#Struct_types)
- [Go 语言规范：切片表达式](https://go.dev/ref/spec#Slice_expressions)
- [Go 语言规范：字符串相关转换](https://go.dev/ref/spec#Conversions_to_and_from_a_string_type)
- [Go 语言规范：可寻址操作数](https://go.dev/ref/spec#Address_operators)
- [Go 预声明函数：`append` 与 `copy`](https://go.dev/ref/spec#Appending_and_copying_slices)
- [Go 预声明函数：`make`](https://go.dev/ref/spec#Making_slices_maps_and_channels)
- [Go 预声明函数：`clear`](https://go.dev/ref/spec#Clear)
- [Go 标准库 `encoding/json`：默认编码与字段省略规则](https://pkg.go.dev/encoding/json#Marshal)
- [Go 标准库 `slices` 包：`Clone` 与内容比较](https://pkg.go.dev/slices)
- [Go 标准库 `maps` 包：`Clone` 与内容比较](https://pkg.go.dev/maps)
- [Go Blog：Strings, bytes, runes and characters in Go](https://go.dev/blog/strings)
- [Go Blog：切片操作与废弃元素的引用清理](https://go.dev/blog/generic-slice-functions)
- [Unicode UAX #29：字素簇边界](https://www.unicode.org/reports/tr29/#Grapheme_Cluster_Boundaries)
- [Go 1.24 发布说明：运行时映射实现](https://go.dev/doc/go1.24#runtime)
- [Go 运行时源码：映射清理与存储复用](https://go.dev/src/internal/runtime/maps/map.go)
- [Go FAQ：映射的并发访问](https://go.dev/doc/faq#atomic_maps)
- [Go 标准库 `sync.Map`：适用场景](https://pkg.go.dev/sync#Map)
- [Go 标准库 `unicode/utf8`：`RuneCountInString`](https://pkg.go.dev/unicode/utf8#RuneCountInString)
- [Go 分析器 `stringintconv`：整数到字符串的转换检查](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/stringintconv)
- [Go 1.8 发布说明：结构体标签转换](https://go.dev/doc/go1.8#language)
