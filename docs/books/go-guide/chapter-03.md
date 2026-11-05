---
title: 第 3 章 复合类型
description: 厘清数组、切片、字符串、映射与结构体的值复制、底层共享、零值差异与可比较性规则。
---

# 第 3 章 复合类型

## 本章要点

学习 Go 复合类型，最核心的一条主线是分清“操作复制的是全部元素，还是仅复制指向底层存储的描述符”。数组与结构体按值整体浅复制，切片与映射则通过描述符共享底层数组或哈希表，字符串则在不可变字节序列之上区分字节索引与 Unicode 码点解码。把这五种类型的内存布局、`nil` 与空容器差异、扩容/清理边界以及可比较性规则串起来，才能准确预判一次修改会影响谁、何时需要显式克隆，以及如何避免底层大对象滞留内存。

> 核对日期：2026 年 10 月 15 日；核对环境为 Go 1.27.2、Windows/AMD64。

## 3.1 数组：长度属于类型 {#ch3-1}

除另有说明外，本章正文代码片段均位于 `main` 函数内，省略外层 `package main` 与 `import` 声明；涉及的标准库包在首次出现处注明导入路径。

数组是由固定长度、同类型元素组成的连续内存序列。在 Go 中，**长度是数组类型的一部分**，`[3]int` 与 `[4]int` 是完全不同的两种类型。

```go
var a [3]int
b := [3]int{10, 20, 30}
c := [...]int{10, 20, 30} // 编译器按初始元素个数推导为 [3]int
d := [12]int{1, 5: 4, 6, 10: 100, 15}
```

`d` 的结果为 `[1 0 0 0 0 4 6 0 0 0 100 15]`：字面量中显式写出索引后，紧随其后的无索引元素会顺着该位置递增填充，未提及的位置自动取元素零值。数组长度必须是编译期可确定的非负整数常量，不能用运行期变量指定。

数组支持下标访问、`len` 和 `cap`（后两者都返回数组长度）。当且仅当元素类型可比较时，数组才支持 `==` 与 `!=` 判等；比较两侧还须满足赋值兼容（类型相同，或其中一方为底层类型相同的未命名数组类型），因此 `[3]int` 可比较，而包含切片元素的 `[3][]int` 不可比较。

数组的赋值与函数传参都会对全部元素做一次**浅复制**：基本类型元素彼此彻底独立；但如果元素内部含有指针、切片或映射，复制的只是地址或描述符，副本仍与原数组共享那些字段指向的底层数据。日常代码中，数组主要用于长度由协议或算法严格固定的场景（如 `sha256` 的 `[32]byte` 摘要）；长度可变或需要通用函数签名时都应使用切片。

数组有效下标范围为 `0` 到 `len(a)-1`：常量下标越界在编译期直接报错，变量下标越界在运行期触发 `panic`。多维数组由一维数组嵌套构成，例如 `[2][3]int` 表示包含 2 个 `[3]int` 元素的数组。

## 3.2 切片：可变长度的视图 {#ch3-2}

切片（Slice）是对底层数组一段连续区间的动态视图。运行时的切片描述符（Slice Header）只包含三个字段：指向底层数组起始元素的指针、当前长度（`len`）和可用容量（`cap`）。给切片赋值或将其传入函数时，复制的只是这三个字段组成的描述符，多个切片可以同时指向同一块底层数组。

```go
var nilSlice []int
empty := []int{}
reserved := make([]int, 0, 5)
filled := make([]int, 5, 10)
```

| 表达式 | `len` | `cap` | 是否为 `nil` | 语义与常见用途 |
| --- | ---: | ---: | :---: | --- |
| `var s []int` | 0 | 0 | 是 | 零值切片，无需额外初始化即可直接 `append` |
| `[]int{}` | 0 | 0 | 否 | 非 `nil` 空切片，JSON 编码结果与 `nil` 切片不同 |
| `make([]int, 0, 5)` | 0 | 5 | 否 | 预留 5 个元素的底层容量，后续配合 `append` 填充 |
| `make([]int, 5, 10)` | 5 | 10 | 否 | 立即拥有 5 个可直接下标读写的零值元素，总容量 10 |

未知初始元素时，优先声明零值切片 `var s []int`；需要注意它与非 `nil` 空切片在序列化时的差别：标准库 `"encoding/json"` 默认把 `nil` 切片编码为 `null`，而把 `[]int{}` 编码为 `[]`。对外接口若严格区分“字段为空值”与“空数组”，初始化方式就不能混用。

切片字面量同样支持顺序填充与按索引稀疏填充，初始 `len` 和 `cap` 都等于最大索引加一：

```go
primes := []int{2, 3, 5, 7}
sparse := []int{1, 3: 10} // [1 0 0 10]，len 和 cap 均为 4
```

`len` 决定当前能合法下标访问的元素范围（`0` 到 `len(s)-1`）；`cap` 则代表从当前切片起始元素算起，在不重新分配底层数组的前提下最多可扩展到多少个元素。落在 `len` 之外、`cap` 之内的槽位不能直接用下标读写：对 `make([]int, 0, 5)` 访问 `s[0]` 会立即触发越界 `panic`，必须先通过 `append` 或重切片扩展长度。

### 3.2.1 `append` 与扩容机制 {#ch3-2-1}

```go
s = append(s, 10)
s = append(s, 5, 6, 7)
s = append(s, other...)
```

`append` 把新元素追加到切片尾部，并返回一个更新后的切片描述符。返回值通常赋回原变量（或作为函数结果返回）；直接丢弃 `append` 返回值无法通过编译，写成 `_ = append(s, 10)` 虽能过编译，但原变量 `s` 的长度不会更新。

底层存储是否分离，取决于追加后是否超出当前容量：

- **未超出 `cap`**：直接在原底层数组紧邻 `len(s)` 之后的位置写入新元素，返回的新切片仍共享同一底层数组——如果还有其他切片覆盖到这些槽位，它们看到的元素会被一并改写。
- **超出 `cap`**：运行时分配一块容量更大的新底层数组，把原切片元素拷过去后再写入新元素，返回的新切片从此指向新数组，与原底层数组脱钩。

追加 `n` 个元素后，返回切片的长度增加 `n`；不传待追加元素 `append(s)` 或展开空切片 `append(s, []int{}...)` 同样合法，长度保持不变。

这也解释了切片做函数参数时的典型现象：函数拿到的是切片描述符副本，通过下标改写现有元素 `s[i] = v` 会直接改动共享的底层数组，调用方可见；但在函数内做 `s = append(s, v)` 所产生的长度变化乃至扩容后的新数组指针，都只写在了形参副本上，调用方的切片描述符不会跟着变。需要让函数增删切片元素时，必须把新切片作为返回值传回。

### 3.2.2 `make` 的长度与容量 {#ch3-2-2}

```go
buf := make([]byte, 1024)    // 1024 个可直接按索引读写的零值字节
items := make([]int, 0, 100) // 长度为 0，预留 100 个元素的容量
```

选错初始长度是高频新手错误：如果已经知道确切元素个数、准备按下标 `s[i] = ...` 逐个填入，用 `make([]T, N)`；如果要靠循环过滤或动态 `append` 收集结果，则应写成 `make([]T, 0, cap)`。一旦对 `make([]int, 5)` 直接调用 `append`，新元素会排在 5 个零值后面，变成长度 6 的切片。

`make([]T, length, capacity)` 要求 `0 <= length <= capacity`（省略 `capacity` 时默认等于 `length`）。常量参数违反该条件会在编译期报错，运行期变量参数违反则触发 `panic`。预留容量应建立在已知或可合理估算的数据规模上，不必盲目预分配过大数组。

### 3.2.3 派生切片与共享存储 {#ch3-2-3}

对切片（或数组）做切片表达式遵循左闭右开区间规则，只生成新的切片描述符，**不会复制任何底层元素**：

| 表达式 | 长度 | 容量 | 索引边界约束 |
| --- | --- | --- | --- |
| `x[low:high]` | `high - low` | `cap(x) - low` | `0 <= low <= high <= cap(x)`（省略 `low` 取 `0`，省略 `high` 取 `len(x)`） |
| `x[low:high:max]` | `high - low` | `max - low` | `0 <= low <= high <= max <= cap(x)`（`high` 与 `max` 不可省略） |
| `x[:]` | `len(x)` | `cap(x)` | 等价于 `x[0:len(x)]` |

注意边界上限的差别：按下标取单个元素 `x[i]` 要求 `i < len(x)`，而切片表达式的右边界最高可以延伸到 `cap(x)`。

为了防止向子切片 `append` 时意外踩坏原切片后面的元素，可以使用三索引切片（Go 1.2+）通过 `max` 把派生切片的容量锁死到与长度相等：

```go
x := []string{"a", "b", "c", "d"}
y := x[:2:2]       // len=2, cap=2
y = append(y, "z") // 容量已满，强制分配新底层数组，x 仍保持 [a b c d]
```

不过三索引切片在扩容发生之前依然共享原数组——若在 `append` 前写 `y[0] = "k"`，`x[0]` 仍会跟着变。需要彻底拆开底层元素存储时，应调用 Go 1.21 引入的标准库 `slices.Clone(x)`（导入路径 `"slices"`），或使用 `make` 配合 `copy`。注意这两者都是**浅复制**：如果元素本身又是指针、切片或映射，更深层的数据依然共享。

#### 克隆的 `nil` 语义与大数组内存滞留

1. **保留 `nil` 状态**：对零值切片 `var src []int`，`slices.Clone(src)` 返回的仍是 `nil`（注意不能直接写无类型的 `slices.Clone(nil)`，会因无法推导类型参数而编译失败）；而未提前判空的 `make([]int, len(src))` 会造出一个非 `nil` 空切片，可能改变默认 JSON 序列化结果。
2. **避免大缓冲区滞留内存**：只要还有一个活跃切片指向底层数组的任意一小段，垃圾回收器（GC）就无法回收整块底层数组。比如从 10 MB 的读取缓冲区 `buf` 上切出 `buf[:64]` 长期保存，整块 10 MB 数组都会被连带留驻内存。遇到这种“大数组截小片段长期持有”的场景，应通过 `slices.Clone(buf[:64])` 把所需字节拷到独立小数组中，及时放开大缓冲区。

### 3.2.4 `copy` 与 `clear` {#ch3-2-4}

内置函数 `copy(dst, src)` 把源切片元素拷入目标切片，返回实际复制的元素个数 `min(len(dst), len(src))`。它只按 `dst` 当前的 **`len`** 写入，不会替 `dst` 扩容，但允许同一底层数组内的重叠区间安全拷贝：

```go
dst := make([]int, len(src))
copy(dst, src)
```

因此 `copy(make([]int, 0, 10), src)` 返回的是 `0`。重叠区间拷贝也很常见：若 `s := []int{1, 2, 3, 4}`，执行 `copy(s[:3], s[1:])` 会返回 `3`，并把 `s` 就地左移覆盖为 `[2 3 4 4]`。普通切片之间调用 `copy` 要求两侧元素类型严格一致；唯一特例是允许直接把 `string` 的字节拷进字节切片（如 `copy(dstBytes, "Go")`）。

内置函数 `clear(s)`（Go 1.21+）会把切片当前长度 `len(s)` 范围内的所有元素重置为元素类型的零值，切片自身的 `len` 与 `cap` 保持不变，其他共享这片底层槽位的切片也会看到元素归零；对 `nil` 切片调用 `clear` 是安全的无操作。相比之下，`s = s[:0]` 只把当前描述符的长度改成 `0`，底层数组里的旧值原封未动。

#### 缩短切片时的尾部引用清理

当切片元素是指针，或是含有指针、切片、映射的结构体时，单纯用 `s = s[:newLen]` 缩短长度并不会抹掉底层数组尾部的旧槽位。只要这块底层数组还被持有，落在 `newLen` 与旧长度之间的旧指针就依然算作可达引用，阻碍所指对象被 GC 回收。确认尾部元素已经废弃且没有其他活跃别名依赖它们后，应先执行 `clear(s[newLen:])` 把残留引用清零，再执行 `s = s[:newLen]`（须满足 `0 <= newLen <= len(s)`）。此外，缩短长度永远不会自动缩小底层数组的容量。

### 3.2.5 切片比较 {#ch3-2-5}

切片本身不可比较，不能写 `a == b` 或 `a != b`，唯一合法的直接判等是与 `nil` 比较。按元素内容比较可使用 Go 1.21 引入的 `slices.Equal`（以下示例同时导入 `"fmt"` 与 `"slices"`）：

```go
var a []int
b := []int{}
fmt.Println(a == nil)           // true
fmt.Println(b == nil)           // false
fmt.Println(slices.Equal(a, b)) // true
```

`slices.Equal` 要求元素类型本身可比较；元素不可比较或需要自定义判等规则时可改用 `slices.EqualFunc`。两者都先比长度、再按索引逐个比元素，不关心底层数组是不是同一块，并且把 `nil` 切片与非 `nil` 空切片视为内容相等。如果切片元素是接口类型，运行期仍须满足接口动态值可比较的约束。

### 3.2.6 数组与切片的转换 {#ch3-2-6}

#### 数组派生切片

对可寻址的数组做切片表达式，会得到一个直接共享该数组内存的切片：

```go
a := [4]int{1, 2, 3, 4}
s := a[:] // 与数组 a 共享底层存储
s[0] = 10 // a[0] 同步变为 10
```

#### 切片转换为数组或数组指针

```go
s := []int{1, 2, 3, 4}
a := [2]int(s)    // 复制前 2 个元素到新数组（Go 1.20+）
p := (*[4]int)(s) // 获取指向底层前 4 个元素的数组指针，共享存储（Go 1.17+）
```

目标数组长度 `N` 必须是编译期非负整数常量，且两种转换都在运行期严格检查 **`len(s) >= N`**——只要当前长度小于 `N`，哪怕 `cap(s) >= N`，也会立即触发 `panic`。转为数组值 `[N]T` 会复制前 `N` 个元素；转为数组指针 `*[N]T` 则直接指向原底层数组。零长边界下，`nil` 切片转 `[0]T` 得到空数组，转 `*[0]T` 得到 `nil` 指针；非 `nil` 空切片转 `*[0]T` 则得到非 `nil` 指针。

## 3.3 字符串、字节和 `rune` {#ch3-3}

Go 的 `string` 是**不可变的字节序列**，而不是字符数组或 `rune` 序列。Go 源码固定采用 UTF-8 编码，因此源码里的字符串字面量通常是合法 UTF-8 文本，但语言规范允许 `string` 存放任意原始字节。

```go
s := "Hi 🌍"
fmt.Println(len(s)) // 7：UTF-8 字节总长度（"Hi " 占 3 字节，"🌍" 占 4 字节）
fmt.Println(s[3])   // 240 (0xf0)：取到的是 "🌍" 的首字节，而非完整字符
```

字符串的 `len(s)`、下标访问 `s[i]` 与切片表达式 `s[low:high]` 全部以**字节**为单位：

- `s[i]` 返回 `byte`（即 `uint8`）。
- 字符串不支持 `cap`，也不支持三索引切片；子串边界须满足 `0 <= low <= high <= len(s)`。如果切片位置恰好劈开一个多字节 UTF-8 字符，运行期不会 `panic`，但切出来的子串会包含残缺的无效 UTF-8 字节。

需要按 Unicode 码点（Code Point）逐个处理文本时，可以使用 `for range` 循环、转换为 `[]rune`，或调用标准库 `"unicode/utf8"` 的解码与计数函数。继续沿用上面的 `s`：

```go
rs := []rune(s)
fmt.Println(len(rs)) // 4：按 Unicode 码点计数

for i, r := range s {
	fmt.Printf("%d:%c ", i, r) // 输出 0:H 1:i 2:  3:🌍
}
```

`for i, r := range s` 会按 UTF-8 规则自动解码每个码点：注意这里的 `i` 是当前码点起始处的**字节偏移量**，不是第几个字符的序号。上例中 `i` 依次为 `0`、`1`、`2`、`3`；由于 `🌍` 占 4 个字节，如果它后面还有字符，下一个 `i` 就会跳到 `7`。解码途中若遇到非法 UTF-8 字节，循环会产出一个替换码点 `U+FFFD`，并只把字节偏移量向后推进 `1`。

还要注意，“一个 `rune`”也不等于用户肉眼看到的“一个字符”：带组合重音符号的拉丁字母、肤色或家庭组合 Emoji 等，往往由多个码点拼成一个字素簇（Grapheme Cluster），`len([]rune(s))` 算出来的是码点数而非视觉字符数。需要按视觉字符安全截断或移动光标时，必须按 Unicode 字素簇规则分段，终端显示宽度还会受等宽字体实现影响。

字符串与切片、整数之间的转换细节经常出现在边界 Bug 中：

```go
bs := []byte(s)  // 完整复制原始字节序列
rs = []rune(s)   // 按 UTF-8 解码为码点切片；每个非法字节变成一个 U+FFFD
s1 := string(bs) // 原样保留全部字节
s2 := string(rs) // 将码点序列重新编码为 UTF-8 字符串
```

- **`string` 与 `[]byte` / `[]rune` 互转**：`string` 与 `[]byte` 互转无损保留每一个字节（包含非法 UTF-8 字节），且语言语义保证修改转换后的 `[]byte` 绝不会污染原字符串（底层是否真的分配堆内存由编译器逃逸分析决定）。而经由 `[]rune` 往返转换时，所有非法 UTF-8 字节都会被不可逆地替换成 `U+FFFD`（UTF-8 编码为 3 字节 `\xef\xbf\xbd`），因此不能拿 `[]rune` 承载任意二进制数据。
- **整数转 `string`**：`string('A')` 与 `string(65)` 都是把整数当作 Unicode 码点编码成 `"A"`，绝不会生成十进制文本 `"65"`。同理，`string(byte(0xff))` 会按码点 `U+00FF` 生成两字节 UTF-8 字符串 `"ÿ"`；若本意是构造含单字节 `0xff` 的字符串，必须写 `string([]byte{0xff})`。把整数格式化为十进制数字字符串，应使用标准库 `"strconv"` 的 `strconv.Itoa` 或 `fmt.Sprint`。

如 [2.4 节](./chapter-02#ch2-4)所述，虽然 `string(65)` 在语法上仍合法，但 `go vet` 的 `stringintconv` 检查会直接拦截非 `rune`/`byte` 类型的整数转 `string`；由于 `go test` 默认启用该检查，这类代码会直接导致测试无法通过编译。

## 3.4 映射（`map`） {#ch3-4}

映射是无序的键值对集合，记作 `map[K]V`。键类型 `K` 必须支持 `==` 与 `!=` 判等，因此切片、映射和函数都不能做键；接口类型虽能声明为键，但一旦存入、查找或删除的动态值本身不可比较，就会在运行期触发 `panic`。

自 Go 1.24 起，官方运行时将映射底层默认实现切换为基于 Swiss Table 的哈希表。由于内部结构会随版本持续演进，编写代码时只应依赖语言规范承诺的行为，不要假设旧版 `hmap` 桶布局或任何内部内存细节。

```go
var nilMap map[string]int
scores := map[string]int{}
ages := make(map[string]int, 100)
```

- **`nil` 映射**：零值映射的 `len` 为 `0`。用合法键读取 `nil` 映射安全无虞，始终返回值类型的零值；但**向 `nil` 映射写入任何键值都会当场触发运行期 `panic`**（若接口键的动态值不可比较，读取或 `delete` 同样会 `panic`）。
- **已初始化映射**：用空字面量 `map[K]V{}` 或 `make(map[K]V, hint)` 创建可读写映射。`make` 的第二个参数 `100` 只是初始容量提示（Hint），用来提前分配底层空间、减少插入过程中的渐进扩容次数——它既不会预先塞入条目，也不会限制映射后续继续增长。映射不支持 `cap` 函数。

已知初始键值时可直接用字面量构造（多行书写时，最后一行末尾也必须保留逗号）：

```go
scores := map[string]int{
	"go":   10,
	"rust": 8,
}
```

映射本身不能彼此做 `==` 或 `!=` 比较，只能与 `nil` 判等。映射赋值与函数传参同样只复制映射描述符（底层表指针），所有别名共享同一张哈希表，通过任意别名增删改键值都会立即对其他别名可见；但如果给某个变量重新赋一张新映射（如 `m = make(...)`），则只改变该变量自己的指向。

需要复制出一张互不干扰的新映射表时，可调用 Go 1.21 引入的标准库 `"maps"` 中的 `maps.Clone(m)`（传入具名类型的 `nil` 映射仍返回 `nil`）。它同样只对键和值做**浅复制**：如果值本身是切片、映射或指针，深层指向的数据依然共享。

### 3.4.1 读写、逗号 `ok` 与删除 {#ch3-4-1}

```go
scores["go"] = 10
scores["go"]++

value, ok := scores["rust"]
if !ok {
	fmt.Println("key not found", value)
}

delete(scores, "go") // 键不存在或映射为 nil 时均安全无操作
clear(scores)        // 清空全部键值对；非 nil 映射清空后仍可继续写入
```

单值读取 `v := m[k]` 在键缺失时也会静默返回值类型的零值，无法区分“键根本不在”与“键存在且值恰好是零值”；需要区分时必须用逗号 `ok` 写法 `v, ok := m[k]`。在键本身合法可比较的前提下，`delete` 面对缺失键或 `nil` 映射都只是无操作，`clear`（Go 1.21+）面对 `nil` 映射也是无操作——当然，这两者都不会把 `nil` 映射变成可写映射。

语言规范故意不固定映射的 `for range` 遍历顺序，运行时还会随机打乱遍历起点，因此同一份数据连跑两次的打印顺序都可能不同；需要稳定顺序时，必须先取出键切片显式排序后再读取（见 [4.4.4 节](./chapter-04#ch4-4-4)）。

#### 并发访问与底层表内存回收

1. **并发读写边界**：没有任何写入发生时，多个 Goroutine 并发只读同一映射是安全的；只要存在并发写或一写多读，就必须加同步保护。裸并发读写映射会直接触发运行时致命错误（如 `fatal error: concurrent map writes`），**无法通过 `recover` 捕获恢复**。常见做法是用标准库 `"sync"` 的 `sync.Mutex` / `sync.RWMutex` 保护普通 `map`，或在契合“键集合稳定、读远多于写”的特定场景下改用 `sync.Map`。
2. **底层表空间不会自动缩容**：在当前官方运行时（含 Go 1.27.2）中，`delete` 与 `clear` 会清掉键值条目，让原本被引用的外部对象失去可达性并得以被 GC 回收，但映射自身已分配的底层哈希表槽位会保留下来供后续写入复用，不会缩容归还。如果一张全局或长生命周期映射曾因流量尖峰膨胀到百万级条目、此后长期只剩极少数据，想要真正释放底层表内存，就必须新建一张小映射把有效条目迁过去，让旧映射整体被 GC 回收。

### 3.4.2 映射模拟集合 {#ch3-4-2}

Go 语言和标准库都没有专门内置 `Set` 类型，日常编码通常直接借用映射键的唯一性来表达集合：

```go
set := map[string]struct{}{}
set["go"] = struct{}{}
if _, ok := set["go"]; ok {
	fmt.Println("present")
}
```

- **`map[T]struct{}`**：空结构体 `struct{}` 自身占 `0` 字节，不为“值”额外消耗存储（当然键本身和哈希表元数据仍占内存），并且语义上清楚表明“只关心键存不存在”。
- **`map[T]bool`**：写起来更简短——只要严格遵守“加入集合只写 `true`、移出集合一律调 `delete`”，就能直接用 `if set[v]` 判断存在性；一旦混入 `set[v] = false`，就又得退回逗号 `ok` 写法才能区分键缺失与 `false`。

### 3.4.3 比较映射内容 {#ch3-4-3}

按内容判断两张映射是否包含完全相同的键值对，可使用标准库 `"maps"`（Go 1.21+）中的 `maps.Equal`（要求值类型可比较）或 `maps.EqualFunc`（自定义值比较逻辑）。两者都与遍历顺序无关，并且同样把 `nil` 映射与非 `nil` 空映射判为内容相等：

```go
first := map[string]int{"go": 10, "rust": 8}
second := map[string]int{"rust": 8, "go": 10}
fmt.Println(maps.Equal(first, second)) // true
```

## 3.5 结构体（`struct`） {#ch3-5}

结构体把一组编译期固定的具名字段聚合成复合值类型。相比随手拿 `map[string]any` 拼装松散键值，结构体拥有编译期字段与类型校验、无哈希查找开销以及紧凑连续的内存布局，是表达业务实体与配置的默认选择。

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

结构体的零值就是每个字段各自取零值。结构体赋值和传参都会按值拷贝全部字段（同样是浅复制）。构造结构体实例时，日常应坚持写**带字段名的字面量**（如 `Person{Name: "Bob", Age: 50}`）：字段顺序自由、未写出的字段自动取零值，日后给结构体增删或重排字段也不会把已有调用点震碎。不写字段名的位置字面量必须按声明顺序填满每一个字段，只适合 `image.Point{10, 20}` 这类字段极少且永不变更的小型类型。

#### 映射中的结构体值为何不能直接改字段

映射下标表达式 `m[k]` 返回的是临时值副本，不属于可寻址（Addressable）操作数，因此 `&m[k]` 无法通过编译。当映射的值类型是结构体（如 `m := map[string]Person{}`）时，直接写 `m["bob"].Age = 51` 会触发编译错误 `cannot assign to struct field m["bob"].Age in map`——因为哪怕允许改写那份临时副本的字段，改动也会立刻丢失，语言干脆在编译期直接禁止。常用改法有两种：

1. **读出、修改再整体写回**：`p := m["bob"]; p.Age = 51; m["bob"] = p`；
2. **改存结构体指针**：声明为 `map[string]*Person`，写入非 `nil` 指针后即可直接通过指针解引用修改 `m["bob"].Age = 51`。

### 3.5.1 匿名结构体 {#ch3-5-1}

不需要复用的临时聚合结构可以省略 `type` 声明，直接写成匿名结构体，常用于单次 JSON 编解码载荷、模板渲染数据以及表格驱动测试（Table-Driven Tests）的用例切片：

```go
payload := struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}{Name: "Ada", Age: 36}
```

字段类型后面的反引号字符串是**结构体标签**（Struct Tag）。标签本身不触发任何自动逻辑，只是编译期附着在字段上的纯文本元数据，供标准库 `"reflect"` 在运行期读取：例如 `"encoding/json"` 默认直接拿导出字段名做 JSON 键名，读到 `json:"name"` 标签时才改用 `"name"`；如果默认字段名本就符合预期，不必机械地给每个字段都贴上标签。

### 3.5.2 比较与转换 {#ch3-5-2}

- **可比较性**：当且仅当结构体的**所有字段类型都可比较**时，该结构体才支持 `==` 与 `!=`（比较时按字段声明顺序逐个比对非空白 `_` 字段，遇到第一个不等字段立即短路）。只要掺入一个切片、映射或函数字段，整个结构体就变成不可比较类型；指针与通道字段比的是引用地址或通道身份；接口字段虽允许编译期写 `==`，但若两侧接口恰好装着相同且不可比较的动态类型，运行期仍会触发 `panic`。
- **具名结构体之间的显式转换**：两个不同的具名结构体类型之间不能隐式赋值，也不能直接用 `==` 比较。若两者的字段名、声明顺序、字段类型、嵌入属性以及未导出字段所属包完全一致，可以用 `T(v)` 显式转换；自 Go 1.8 起，这种显式转换会自动忽略两侧结构体标签的差异。
- **与匿名结构体的隐式互通**：若具名结构体与某个匿名结构体的底层类型**完全相同**，两者之间无需强转即可直接相互赋值；字段全部可比较时还能直接用 `==` 判等。注意这里的“底层类型完全相同”**包含结构体标签一致**——只要标签差一个字符，隐式赋值就会编译失败。

## 练习 {#ch3-exercises}

以下五题分别检验数组值复制与类型长度、三索引切片与 `copy` 长度约束、字符串字节与码点转换、`nil` 映射读写边界，以及结构体浅复制隔离。除完整程序外，代码片段均位于 `main` 函数内；`fmt`、`utf8`、`slices` 分别对应标准库 `"fmt"`、`"unicode/utf8"`、`"slices"`。建议先独立推理作答，再展开核对参考答案。

### 练习 1：数组的赋值、传参与类型身份

写出以下程序的输出，并说明数组赋值与函数传参时的复制行为。若把 `b := a` 改为 `b := [...]int{1, 2}`，`change(b)` 和 `a == b` 能否通过编译？

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

输出为 `[1 2 0] [1 8 0] false`。`a` 未显式给出的第三个元素自动取零值 `0`；`b := a` 与 `change(b)` 都会把整块 `[3]int` 按值复制一份，因此 `change` 内修改形参副本不会影响 `b`，后续修改 `b[1]` 也不会影响 `a`。

改为 `b := [...]int{1, 2}` 后，`b` 的类型被推导为 `[2]int`。由于数组长度属于类型的一部分，`[2]int` 与 `[3]int` 是完全不同的类型，`change(b)` 和 `a == b` 都会在编译期直接报错。

</details>

### 练习 2：三索引切片容量限制与 `copy` 行为

写出 `view` 在执行 `append` 前的长度与容量，以及原程序的输出。若只把 `clone` 的初始化改为 `make([]int, 2)`，输出会变成什么？说明每一步哪些变量共享底层存储、哪些发生了元素复制。

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

`append` 之前，`view` 的长度与容量均为 `2`。原程序输出：

```text
[1 9 3 4] [8 3 5] [] 0
```

三索引切片 `src[1:3:3]` 只把容量上限锁为 `2`，并未复制元素，所以扩容前的 `view[0] = 9` 直接改写了共享底层数组中的 `src[1]`。紧接着 `append(view, 5)` 突破容量 `2`，触发分配新数组并拷走元素；此后的 `view[0] = 8` 只改在新数组上，`src` 不再受影响。

`copy` 拷贝的元素个数等于 `min(len(dst), len(src))`。原代码中 `len(clone)` 为 `0`，所以一个元素也没拷进去（`n == 0`）。将初始化改为 `make([]int, 2)` 后，`len(clone)` 为 `2`，赶在 `view[0]` 被改成 `9` 之前就把 `[2 3]` 拷到了独立数组中，输出变为：

```text
[1 9 3 4] [8 3 5] [2 3] 2
```

</details>

### 练习 3：字符串的字节索引与码点解码

写出以下三行代码的输出，说明两个计数值与两次索引各自的单位，并解释为何 `message[3]` 取不出完整字符。另外，若有 `raw := "A\xff中"`，分别判断 `raw == string([]byte(raw))` 与 `raw == string([]rune(raw))` 的结果。

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

`len(message)` 统计 UTF-8 字节总数（`"Hi "` 占 3 字节，`"🌞"` 占 4 字节，合计 7 字节）；`utf8.RuneCountInString` 按 Unicode 码点统计（共 4 个码点）。字符串下标 `message[3]` 按字节取值，拿到的是 `"🌞"` UTF-8 四字节序列的首字节 `0xf0`（十进制 `240`）；先转成 `[]rune` 再按下标 `3` 索引，才是按码点取出第 4 个字符 `🌞`。

附加比较的结果依次为 `true`、`false`。`[]byte` 往返转换原封不动保留包括 `0xff` 在内的 5 个字节；而转成 `[]rune` 时，非法 UTF-8 单字节 `0xff` 会被解码替换为 `U+FFFD`，再转回 `string` 后重编码为 `"A\xef\xbf\xbd中"`（共 7 字节），与原字符串 `"A\xff中"` 不再相等。

</details>

### 练习 4：区分零值条目、缺失键与 `nil` 映射

写出以下代码的输出并说明两次读取的区别。若将首行改为 `var counts map[string]int`，两次读取是否仍然安全？哪一行会失败，发生在编译期还是运行期？给出保留首行零值声明、但在写入前补齐初始化的改法。

```go
counts := map[string]int{"go": 0}
present, okPresent := counts["go"]
missing, okMissing := counts["rust"]
counts["go"]++
fmt.Println(present, okPresent, missing, okMissing, counts["go"])
```

<details>
<summary>查看参考答案</summary>

原代码输出：

```text
0 true 0 false 1
```

键 `"go"` 存在且对应值恰好是零值 `0`，键 `"rust"` 不存在；两次读取拿到的值都是 `0`，只能靠第二个布尔返回值 `ok` 区分键是否真实存在。

首行改为 `var counts map[string]int` 后，`counts` 是 `nil` 映射。前两行读取依然安全，均返回 `0, false`；但 `counts["go"]++` 等价于读取后再写回 `counts["go"] = counts["go"] + 1`，向 `nil` 映射写入会在**运行期**触发 `panic`，最后一行打印不会执行。

若保留首行的 `var` 零值声明，可在两次读取之后、`counts["go"]++` 之前补上一行 `counts = make(map[string]int)`（注意对已声明变量用 `=` 赋值，不要写成 `:=`），修改后输出 `0 false 0 false 1`。

</details>

### 练习 5：区分结构体字段赋值与共享元素修改

写出两行输出，说明修改 `b.Name`、修改 `b.Scores[0]` 与重赋 `b.Scores` 各自的影响范围。随后在 `b := a` 之后只补一行代码，使后续对 `b` 的任何修改都不再波及 `a`，并给出修改后的输出。

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

结构体赋值 `b := a` 执行按字段浅复制：`Name` 各自独立，而 `Scores` 只复制了切片描述符，`a.Scores` 与 `b.Scores` 仍指向同一底层数组，所以 `b.Scores[0] = 9` 会同步改掉 `a.Scores[0]`。后面的 `b.Scores = []int{7, 8}` 把 `b.Scores` 指向了新切片，不再影响 `a.Scores`，但此前写进旧底层数组的 `9` 已经留在 `a.Scores` 里了。

在 `b := a` 之后补上一行克隆底层切片即可隔离（需导入 `"slices"`）：

```go
b.Scores = slices.Clone(a.Scores)
```

修改后输出：

```text
Ada [1 2] Lin [9 2]
[1 2] [7 8]
```

这里因为 `Scores` 的元素类型是值类型 `int`，浅克隆一层切片就足以彻底隔离；如果字段是 `[][]int` 或含指针的结构体切片，`slices.Clone` 只克隆外层切片，内层引用仍需按需深拷贝。

</details>

## 面试题 {#ch3-interview}

以下六题围绕切片清理、容器判等与 `nil` 边界、映射浅克隆、可赋值性与可比较性分离、切片转数组长度检查以及映射元素不可寻址规则展开。代码上下文与导入约定沿用[练习部分](#ch3-exercises)，另以 `maps` 对应标准库 `"maps"`；标有 A、B 的语句需分别判断。

### 面试题 1：`clear(s)` 与 `s = s[:0]` 等价吗？

以下代码输出什么？最后一次 `clear(s)` 能否把 `alias` 里剩下的元素清零？复用包含引用的切片时两者应按什么顺序配合？

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

不等价，输出为 `[0 0 3] 0 3`。`clear` 会将传入切片**当前长度范围**内的底层元素置零，不改长度与容量；`s = s[:0]` 只把 `s` 自己的长度设为 `0`，不动底层数组，`alias` 的长度仍是 `3`。随后的 `clear(s)` 因 `len(s) == 0` 而作用区间为空，清不到 `alias[2]`。

复用存有指针或引用的切片缓冲区时，确认无其他活跃别名依赖旧元素后，必须**先 `clear(s)` 清空引用，再 `s = s[:0]` 重置长度**（若此前已缩短过长度，清理范围还应覆盖到曾写入过的容量区间，如 `clear(s[:cap(s)])`）。顺序一旦颠倒，`clear` 就形同虚设。

</details>

### 面试题 2：内容相等判定能代替 `nil` 判断吗？

以下代码两行分别输出什么？为什么 `slices.Equal` 和 `maps.Equal` 不能完全替代 `== nil`？

```go
var s []int
var m map[string]int
fmt.Println(slices.Equal(s, []int{}), maps.Equal(m, map[string]int{}))
fmt.Println(s == nil, m == nil)
```

<details>
<summary>查看参考答案</summary>

不能替代，两行都输出 `true true`。`slices.Equal` 只比对元素个数与各位置的值，`maps.Equal` 只比对键值集合，两者都把 `nil` 容器与非 `nil` 空容器视为内容相等。但 `nil` 与空容器仍有两处关键差异：一是 `"encoding/json"` 默认把 `nil` 切片/映射编码为 `null`，而把空切片/空映射编码为 `[]` 与 `{}`；二是向 `nil` 映射写入会直接触发运行期 `panic`，空映射则可正常写入。

</details>

### 面试题 3：`maps.Clone` 隔离了哪一层数据？

写出两行输出，并解释为什么改写 `cloned["go"][0]` 与执行 `clear(alias)` 的影响范围不同。

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

两行输出依次为 `[9] [9]` 和 `0 1 [9]`。`alias` 与 `source` 指向同一张底层映射表；`maps.Clone` 为 `cloned` 新建了独立的映射表，但对表中的值 `[]int` 只做了浅复制（复制切片描述符），因此 `cloned["go"]` 与 `source["go"]` 仍指向同一块底层数组，改写元素 `0` 两边都会变。而 `clear(alias)` 清空的是 `source` 与 `alias` 共用的那张映射表，影响不到 `cloned` 独立的表结构及其持有的切片。

</details>

### 面试题 4：结构体能直接赋值就能用 `==` 比较吗？

分别判断语句 A、B 能否通过编译。若把两处 `Values []int` 都改为 `Values [1]int`（字面量同步改为 `[1]int{1}`），结果又如何？

```go
type Record struct{ Values []int }
a := Record{Values: []int{1}}
var b struct{ Values []int } = a // A
fmt.Println(a == b)              // B
```

<details>
<summary>查看参考答案</summary>

语句 A 可以通过编译，语句 B 编译失败。具名结构体 `Record` 与右侧结构完全一致的匿名结构体拥有相同的底层类型，且其中一方是未命名类型，满足隐式赋值规则；但结构体里含有不可比较的切片字段 `[]int`，导致整个结构体不支持 `==` 运算。

把字段改成定长数组 `[1]int` 后，所有字段都可比较，A、B 均能通过编译并输出 `true`。记住结论：**“能否直接赋值”与“能否用 `==` 比较”在 Go 类型系统中是两条彼此独立的判定规则。**

</details>

### 面试题 5：切片转数组看长度还是容量？

写出 `fmt.Println` 的输出，并判断最后一行能否通过编译与正常执行。

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

`fmt.Println` 输出 `[1 2] 9`；最后一行能通过编译，但在运行期触发 `panic`。转为数组值 `[2]int(s)`（Go 1.20+）会复制前两个元素，所以 `value` 保持 `[1 2]`；转为数组指针 `(*[2]int)(s)`（Go 1.17+）直接指向原底层数组首部，因此 `s[0] = 9` 会反映在 `pointer[0]` 上。`short` 虽然容量 `cap(short)` 仍为 `3`，但当前长度 `len(short)` 只有 `1`；切片转数组或数组指针一律校验 **`len(s) >= N`**，容量够大也不能抵消长度不足。

</details>

### 面试题 6：映射中的结构体为何无法直接修改字段，却能修改其切片元素？

分别判断语句 A、B 能否通过编译。若合法，说明执行结果与背后的寻址差异。

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

语句 A 合法，语句 B 编译失败；去掉 B 后执行 A，`m["go"].Tags` 的内容变为 `["safe"]`。

原因是映射索引结果 `m["go"]` 返回的是不可寻址的结构体值副本：它的字段 `m["go"].Count` 同样不可寻址，既不能赋值也不能自增，所以 B 在编译期被拒绝。而**切片下标表达式本身始终是可寻址的**——语句 A 从那份临时结构体副本里读出 `Tags` 切片描述符后，顺着描述符里的指针直接改写了底层数组的第 0 个元素，并没有修改映射条目内存储的结构体字段本身。

</details>

## 参考资料

- [Go 语言规范：类型身份（Type identity）](https://go.dev/ref/spec#Type_identity)
- [Go 语言规范：可赋值性（Assignability）](https://go.dev/ref/spec#Assignability)
- [Go 语言规范：比较运算（Comparison operators）](https://go.dev/ref/spec#Comparison_operators)
- [Go 语言规范：数组类型（Array types）](https://go.dev/ref/spec#Array_types)
- [Go 语言规范：切片类型（Slice types）](https://go.dev/ref/spec#Slice_types)
- [Go 语言规范：切片表达式（Slice expressions）](https://go.dev/ref/spec#Slice_expressions)
- [Go 语言规范：切片到数组或数组指针的转换](https://go.dev/ref/spec#Conversions_from_slice_to_array_or_array_pointer)
- [Go 语言规范：字符串相关转换](https://go.dev/ref/spec#Conversions_to_and_from_a_string_type)
- [Go 语言规范：映射类型（Map types）](https://go.dev/ref/spec#Map_types)
- [Go 语言规范：结构体类型（Struct types）](https://go.dev/ref/spec#Struct_types)
- [Go 语言规范：可寻址操作数（Address operators）](https://go.dev/ref/spec#Address_operators)
- [Go 语言规范：内置函数 `append` 与 `copy`](https://go.dev/ref/spec#Appending_and_copying_slices)
- [Go 语言规范：内置函数 `make`](https://go.dev/ref/spec#Making_slices_maps_and_channels)
- [Go 语言规范：内置函数 `clear`](https://go.dev/ref/spec#Clear)
- [Go 标准库 `encoding/json`：`Marshal` 默认编码规则](https://pkg.go.dev/encoding/json#Marshal)
- [Go 标准库 `slices`：`Clone` 与内容比较](https://pkg.go.dev/slices)
- [Go 标准库 `maps`：`Clone` 与内容比较](https://pkg.go.dev/maps)
- [Go 标准库 `unicode/utf8`：`RuneCountInString`](https://pkg.go.dev/unicode/utf8#RuneCountInString)
- [Go 标准库 `sync.Map`：并发映射适用场景](https://pkg.go.dev/sync#Map)
- [`go vet` 分析器：`stringintconv`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/stringintconv)
- [Go Blog：Strings, bytes, runes and characters in Go](https://go.dev/blog/strings)
- [Go Blog：Generic Slice Functions（废弃切片元素的引用清理）](https://go.dev/blog/generic-slice-functions)
- [Unicode UAX #29：字素簇边界（Grapheme Cluster Boundaries）](https://www.unicode.org/reports/tr29/#Grapheme_Cluster_Boundaries)
- [Go 1.8 发布说明：显式结构体转换忽略标签](https://go.dev/doc/go1.8#language)
- [Go 1.24 发布说明：基于 Swiss Table 的运行时映射实现](https://go.dev/doc/go1.24#runtime)
- [Go 运行时源码：`internal/runtime/maps` 存储清理与复用](https://go.dev/src/internal/runtime/maps/map.go)
- [Go FAQ：为什么映射操作不定义为原子安全](https://go.dev/doc/faq#atomic_maps)
