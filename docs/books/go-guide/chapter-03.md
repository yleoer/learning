---
title: 第 3 章 数组、切片、映射与结构体
description: 掌握数组、切片、字符串、映射与结构体的内存语义、共享扩容边界、不可寻址规则与可比较性。
---

# 第 3 章 数组、切片、映射与结构体

## 本章要点

理解 Go 复合类型的关键主线是分清**操作复制的是全部元素，还是仅复制指向底层存储的描述符**。数组与结构体按值整体浅复制；切片与映射通过描述符共享底层数组或哈希表；字符串在不可变字节序列之上区分字节索引与 Unicode 码点解码。厘清这五类结构的零值边界、扩容分离时机、不可寻址规则与可比较性，才能准确预判修改可见性并避免底层内存滞留。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 3.1 数组：长度属于类型 {#ch3-1}

数组是由固定长度、同类型元素组成的连续内存块。在 Go 中，**长度是数组类型的一部分**，`[3]int` 与 `[4]int` 是完全不同的类型，且数组长度必须是编译期非负整数常量：

```go
var a [3]int
b := [...]int{10, 20, 30} // 按元素个数推导为 [3]int
d := [6]int{1, 3: 4, 5}   // 稀疏索引初始化：[1 0 0 4 5 0]
```

数组支持下标读写、`len` 与 `cap`，后两者均返回数组长度。常量下标越界在编译期直接报错，变量下标越界在运行期触发 `panic`；多维数组如 `[2][3]int` 由一维数组嵌套构成。当且仅当元素类型本身可比较时，同类型数组才支持 `==` 与 `!=` 逐元素判等；例如 `[3]int` 可比较，而含切片元素的 `[3][]int` 不可比较。

数组的赋值与函数传参都会对全部元素做**浅复制**：值类型元素彼此彻底独立，但若元素内部含有指针、切片或映射，副本仍共享深层引用。日常工程仅在协议或算法固定字节长度（如 `[32]byte` 摘要）时使用数组，通用集合一律优先选用切片。

## 3.2 切片：共享底层数组的动态视图 {#ch3-2}

### 3.2.1 声明方式、长度与容量 {#ch3-2-1}

切片（Slice）是对底层数组连续区间的动态视图，其运行时描述符仅含三个字长：底层数组起始指针、当前长度 `len` 和可用容量 `cap`。给切片赋值或跨函数传参时只复制该描述符，跨函数传参细节详见 [6.2 节](./chapter-06#ch6-2)。四种常见声明方式对比如下：

| 声明写法 | `len` | `cap` | `== nil` | 语义与典型用途 |
| --- | ---: | ---: | :---: | --- |
| `var s []int` | 0 | 0 | `true` | 零值切片，未知初始元素时的首选，可直接 `append` |
| `[]int{}` | 0 | 0 | `false` | 非 `nil` 空切片，`"encoding/json"` 编码为 `[]` 而非 `null` |
| `make([]int, 0, 5)` | 0 | 5 | `false` | 预分配 5 个元素容量，配合循环 `append` 避免中途频繁扩容 |
| `make([]int, 5, 10)` | 5 | 10 | `false` | 立即拥有 5 个可直接下标读写的零值元素，总容量为 10 |

区分 `len` 与 `cap` 的边界是避坑重点：

- **下标访问只认 `len`**：合法下标区间为 `0 <= i < len(s)`；对 `make([]int, 0, 5)` 访问 `s[0]` 会立即触发越界 `panic`。
- **预分配勿选错 `len`**：已知元素总数且按下标 `s[i] = v` 填充时用 `make([]T, N)`；靠 `append` 收集结果时必须写 `make([]T, 0, cap)`，否则新元素会排在 `N` 个前导零值之后。`make` 要求 `0 <= len <= cap`，违反时常量参数编译报错、变量参数运行期 `panic`。

### 3.2.2 append 扩容与三索引切片 {#ch3-2-2}

内置函数 `append` 向切片尾部追加元素并返回更新后的切片描述符，返回值必须赋回变量接收：

```go
s = append(s, 10)
s = append(s, other...)
```

底层存储是否分离取决于追加后是否突破当前容量：

- **追加后未超出 `cap`**：直接在原底层数组紧随 `len(s)` 的槽位覆写新值，返回切片仍共享原数组，覆盖该区间的其他派生切片会被连带改写。
- **追加后超出 `cap`**：运行时分配容量更大的新底层数组、拷入旧元素再写入新值，返回切片从此指向新数组，与原底层数组脱钩。

这也决定了函数内对切片形参调用 `append` 时，长度更新与扩容后的新指针只改动局部形参描述符，若不通过返回值传回则调用方不可见，详见 [6.2.2 节](./chapter-06#ch6-2-2)。

对切片或可寻址数组做左闭右开切片操作只生成新描述符，**不复制任何底层元素**：

| 切片表达式 | 结果长度 | 结果容量 | 合法边界约束 |
| --- | --- | --- | --- |
| `x[low:high]` | `high - low` | `cap(x) - low` | `0 <= low <= high <= cap(x)`；省略 `low` 取 `0`，省略 `high` 取 `len(x)` |
| `x[low:high:max]` | `high - low` | `max - low` | `0 <= low <= high <= max <= cap(x)`（Go 1.2+）；后两项不可省 |
| `x[:]` | `len(x)` | `cap(x)` | 等价于 `x[0:len(x)]` |

若希望防止子切片后续 `append` 踩坏母切片后方元素，可使用**三索引切片**把容量锁死到当前长度：

```go
x := []string{"a", "b", "c", "d"}
y := x[:2:2]       // len=2, cap=2
y = append(y, "z") // 容量已满，强制分配新数组，x 仍保持 [a b c d]
```

注意扩容前 `y` 与 `x` 依旧共享前两个元素：若在 `append` 之前执行 `y[0] = "k"`，`x[0]` 仍会同步变为 `"k"`。

### 3.2.3 克隆、copy、clear 与尾部引用清理 {#ch3-2-3}

需要隔离底层数组、搬移数据或释放引用时，应精准区分以下三组操作：

- **`slices.Clone`（Go 1.21+）与防大数组滞留**：该函数位于标准库 `"slices"`，对元素做一层浅拷贝并返回独立底层数组，且保留 `nil` 语义——传入零值切片仍返回 `nil`，而 `make([]T, len(src))` 会生成非 `nil` 空切片。只要存在任一活跃小切片指向大缓冲区，垃圾回收器（GC）就无法回收整块底层数组；例如从 10 MB 缓冲区 `buf` 切出 64 字节长期保存时，必须调用 `slices.Clone(buf[:64])` 拷出独立小切片。
- **`copy(dst, src)`**：按目标切片当前长度拷贝 `min(len(dst), len(src))` 个元素，绝不自动扩容 `dst`；支持同一底层数组重叠区间安全就地移动，且特例支持将 `string` 字节直接拷入 `[]byte`：

```go
s := []int{1, 2, 3, 4}
n := copy(s[:3], s[1:]) // 重叠区间左移：n=3，s 变为 [2 3 4 4]
```

- **`clear(s)`（Go 1.21+）与尾部引用清理**：将 `s[:len(s)]` 范围内的底层元素全部置为元素类型零值，`len` 与 `cap` 保持不变，对 `nil` 切片则为安全空操作；相比之下，`s = s[:0]` 仅改写描述符长度，底层旧值仍在。当元素为指针或含引用的结构体时，直接用 `s = s[:newLen]` 缩短切片会导致尾部旧指针持续阻止目标对象被 GC 回收；确认无其他别名依赖后，应**先清零尾部引用再缩短长度**：

```go
clear(s[newLen:]) // 先抹除废弃槽位中的指针引用
s = s[:newLen]    // 再缩短可见长度
```

### 3.2.4 切片比较与转数组 {#ch3-2-4}

切片自身不支持 `==` 互比，仅允许 `s == nil` 检查。按元素内容判等应调用 `"slices"` 包的 `slices.Equal` 或 `slices.EqualFunc`（Go 1.21+），两者均将 `nil` 切片与非 `nil` 空切片判为内容相等：

```go
var a []int
b := []int{}
fmt.Println(a == nil, b == nil, slices.Equal(a, b)) // true false true
```

切片转定长数组值或数组指针在运行期严格校验 **`len(s) >= N`**，`N` 须为编译期非负常量；即便 `cap(s) >= N`，只要 `len(s) < N` 就会触发 `panic`：

```go
s := []int{1, 2, 3, 4}
arr := [2]int(s)    // 复制前 2 个元素到独立新数组（Go 1.20+）
ptr := (*[4]int)(s) // 返回指向底层前 4 个元素的数组指针，共享存储（Go 1.17+）
```

零长转换边界下，`(*[0]int)(nilSlice)` 得到 `nil` 指针，而 `(*[0]int)([]int{})` 得到非 `nil` 指针。

## 3.3 字符串、字节与 rune {#ch3-3}

Go 的 `string` 是**不可变的任意字节序列**，源码字面量采用 UTF-8 编码。字符串的 `len(s)`、下标 `s[i]`（返回 `byte`）与子串切片 `s[low:high]` 全部以**字节**为单位，不支持 `cap` 与三索引切片：

```go
s := "Hi 🌍"
fmt.Println(len(s), s[3]) // 7 240："Hi " 占 3 字节，"🌍" 占 4 字节，s[3] 仅为首字节 0xf0
```

若子串边界劈开多字节 UTF-8 字符，运行期不会 `panic`，但会产生残缺的无效 UTF-8 字节。按 Unicode 码点处理文本时，可用 `for range`、`[]rune` 转换或标准库 `"unicode/utf8"` 的 `utf8.RuneCountInString`：

```go
for i, r := range s {
	fmt.Printf("%d:%c ", i, r) // 0:H 1:i 2:  3:🌍；i 是起始字节偏移，非字符序号
}
```

解码遇到非法 UTF-8 字节时，`for range` 会产出替换码点 `U+FFFD` 并将字节偏移推进 `1`。注意单个视觉字符（字素簇）如组合 Emoji 可能由多个 `rune` 拼成，`len([]rune(s))` 统计的是码点数而非终端视觉列宽。

字符串类型转换须谨防两类失真：

- **`[]byte` 无损 vs `[]rune` 有损**：`string` 与 `[]byte` 互转完整保留任意原始字节，且修改 `[]byte` 不会污染原字符串；而经 `[]rune` 往返转换会将所有非法 UTF-8 字节不可逆地替换为 3 字节的 `U+FFFD`（`\xef\xbf\xbd`），二进制数据切勿转 `[]rune`。
- **整数转字符串陷阱**：`string(65)` 生成 `"A"`，`string(byte(0xff))` 按码点 `U+00FF` 生成双字节 `"ÿ"`，构造单字节原始串必须写 `string([]byte{0xff})`；十进制格式化详见 [2.2 节](./chapter-02#ch2-2)。

## 3.4 映射（map） {#ch3-4}

### 3.4.1 初始化、逗号 ok、删除与清空 {#ch3-4-1}

映射 `map[K]V` 是无序键值对哈希表。自 Go 1.24 起官方运行时默认采用 Swiss Table 实现，业务代码只应依赖语言规范契约而不假设内部桶布局。键类型 `K` 必须可比较，切片、映射、函数不可作键；接口作键时若存入不可比较动态值会触发运行期 `panic`，详见 [8.3.2 节](./chapter-08#ch8-3-2)。

```go
var nilMap map[string]int          // nil 映射：可读可删，写入即 panic
scores := map[string]int{"go": 10} // 字面量初始化
ages := make(map[string]int, 100)  // 100 为初始容量提示，映射不支持 cap()
```

- **读写与逗号 `ok`**：读取缺失键或读取 `nil` 映射均安全返回值类型的零值；**向 `nil` 映射写入必触发运行期 `panic`**。区分“键不存在”与“值恰为零值”必须用 `v, ok := m[k]`：

```go
val, ok := scores["rust"] // val=0, ok=false
delete(scores, "go")      // 缺失键或 nil 映射均安全无操作
clear(scores)             // Go 1.21+：清空全部条目，非 nil 映射仍可继续写入
```

- **共享描述符与浅克隆**：映射赋值与传参只复制底层表描述符，详见 [6.2.2 节](./chapter-06#ch6-2-2)；独立克隆表结构可调用标准库 `"maps"` 的 `maps.Clone(m)`（Go 1.21+），但若值为切片或指针，深层数据依旧共享。
- **无序遍历**：`for range` 每次随机打乱遍历起点，有序遍历写法见 [4.3.2 节](./chapter-04#ch4-3-2)。

### 3.4.2 集合模拟、内容比较与并发/内存边界 {#ch3-4-2}

Go 无内置 `Set`，常以 `map[T]struct{}` 模拟集合，空结构体 `struct{}` 占 `0` 字节且语义最清晰；若改用 `map[T]bool`，只有在严格只写 `true`、移出一律调 `delete` 的前提下才能直接写 `if set[v]`。

```go
visited := map[string]struct{}{"main": {}}
if _, ok := visited["main"]; ok {
	fmt.Println("seen")
}
```

映射自身仅允许 `m == nil` 判等，按内容比较键值集合可使用 `"maps"` 包的 `maps.Equal` 或 `maps.EqualFunc`（Go 1.21+）。生产环境使用映射须严守两条运行时红线：

- **并发读写直接崩溃**：无写入时并发只读安全；一旦存在并发写或一写多读而未加 `sync.Mutex` 等同步保护，运行时会直接抛出 `fatal error: concurrent map writes` 终止进程，**`recover` 无法捕获恢复**，同步选型详见 [13.4 节](./chapter-13#ch13-4)。
- **底层表槽位不自动缩容**：`delete` 与 `clear` 会断开外部键值对象引用使其可被 GC 回收，但哈希表已分配的底层桶空间会保留复用而不归还内存。长生命周期映射若经历百万级峰值后长期只剩少量条目，应新建小映射迁入有效数据并丢弃旧映射。

## 3.5 结构体与复合类型速查 {#ch3-5}

### 3.5.1 具名结构体、匿名结构体与标签 {#ch3-5-1}

结构体（Struct）将固定具名字段聚合成值类型，零值为各字段取零值，赋值与传参均按字段执行浅复制。初始化应坚持使用**带字段名的字面量**，避免增删或重排字段时破坏既有调用方；仅单次使用的临时载荷可声明为匿名结构体并附带反引号结构体标签（Struct Tag）：

```go
type Person struct {
	Name string
	Age  int
}

bob := Person{Name: "Bob", Age: 50}
payload := struct {
	Name string `json:"name"`
}{Name: bob.Name}
```

结构体标签是编译期附着在字段上的纯文本元数据，由 `"reflect"` 等包在运行期按需解析，JSON 标签规则详见 [16.1.1 节](./chapter-16#ch16-1-1)。两个具名结构体若字段名、顺序、类型、内嵌属性及未导出字段所属包完全一致，可通过 `T(v)` 显式转换并自动忽略标签差异（Go 1.8+）；而具名结构体与匿名结构体隐式互赋则要求底层类型**连同标签一字不差**：

```go
type Staff struct {
	Name string `json:"staff_name"`
	Age  int
}
s := Staff(bob)                        // 显式转换：自动忽略标签差异
var anon struct{ Name string; Age int } = bob // 隐式赋值：底层类型含标签完全一致
```

### 3.5.2 映射中结构体不可寻址与可比较性总表 {#ch3-5-2}

映射下标表达式 `m[k]` 返回的是不可寻址的临时值副本，`&m[k]` 无法通过编译。因此对 `m := map[string]Person{}` 直接写 `m["bob"].Age = 51` 会编译报错，必须改用“读出副本、修改后整体写回”或改存指针 `map[string]*Person`：

```go
p := m["bob"]
p.Age = 51
m["bob"] = p
```

但若结构体内部含有切片字段，写 `m["bob"].Tags[0] = "go"` 却完全合法——因为**切片下标表达式本身始终可寻址**，该操作顺着副本中的切片指针直接修改了底层数组，并未改动映射条目自身存储的结构体字节。

结构体当且仅当**全部非 `_` 字段都可比较**时才支持 `==` 与 `!=`；一旦掺入切片、映射或函数字段，整个结构体即不可比较。注意“可隐式赋值”与“可 `==` 比较”彼此独立。五种复合类型核心性质汇总如下：

| 类型 | 零值 | 赋值/传参复制内容 | 是否支持 `==` / `!=` | 核心可变与共享边界 |
| --- | --- | --- | --- | --- |
| 数组 `[N]T` | 各元素为零值 | 全部 `N` 个元素（浅复制） | 仅当元素 `T` 可比较时支持 | 长度属类型；副本修改值元素互不影响 |
| 切片 `[]T` | `nil` | 3 字长描述符（指针/`len`/`cap`） | 仅支持与 `nil` 比较 | 共享底层数组；超出 `cap` 扩容后脱钩 |
| 字符串 `string` | `""` | 2 字长描述符（指针/字节长度） | 支持，且支持 `<` `>` 字典序 | 底层字节不可变；下标与 `len` 按字节计 |
| 映射 `map[K]V` | `nil` | 底层哈希表指针描述符 | 仅支持与 `nil` 比较 | `nil` 写入 `panic`；共享同表，并发写致命崩溃 |
| 结构体 `struct` | 各字段为零值 | 全部字段值（浅复制） | 仅当所有字段均可比较时支持 | 映射元素 `m[k]` 不可寻址，不可直接改字段 |

## 练习 {#ch3-exercises}

以下 3 道练习检验三索引切片与 `copy` 长度约束、字符串字节与 `rune` 转换，以及 `nil` 映射读写边界。代码片段位于 `main` 函数内，`fmt`、`utf8` 分别对应标准库 `"fmt"`、`"unicode/utf8"`。建议先独立作答，再展开核对参考答案。

### 练习 1：三索引切片、append 扩容与 copy 长度约束

写出以下代码的输出。若仅将 `clone` 初始化改为 `make([]int, 2)`，输出又是什么？说明哪一步发生了底层数组分离。

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

原代码输出 `[1 9 3 4] [8 3 5] [] 0`；改为 `make([]int, 2)` 后输出 `[1 9 3 4] [8 3 5] [2 3] 2`。

- `src[1:3:3]` 令 `view` 的 `len=2, cap=2`，扩容前仍与 `src` 共享底层存储，故 `view[0] = 9` 同步改写了 `src[1]`；随后的 `append(view, 5)` 突破容量 `2`，分配新底层数组并分离，此后 `view[0] = 8` 不再影响 `src`。
- `copy` 仅复制 `min(len(dst), len(src))` 个元素：原 `clone` 的 `len` 为 `0` 故拷贝 `0` 个；改为 `make([]int, 2)` 后在 `view[0]` 被修改前拷出了 `[2 3]`。

</details>

### 练习 2：字符串的字节索引与 rune 解码

写出前三行打印结果；再针对 `raw := "A\xff中"`，判断 `raw == string([]byte(raw))` 与 `raw == string([]rune(raw))` 的布尔值并说明原因。

```go
message := "Hi 🌞"
fmt.Println(len(message), utf8.RuneCountInString(message))
fmt.Println(string([]rune(message)[3]), message[3])
```

<details>
<summary>查看参考答案</summary>

打印输出为：

```text
7 4
🌞 240
```

`"Hi "` 占 3 字节、`"🌞"` 占 4 字节，故 `len(message)` 返回字节总数 `7`，`utf8.RuneCountInString` 返回码点数 `4`；`message[3]` 取到 `"🌞"` 的首字节 `0xf0`（`240`），转 `[]rune` 后下标 `3` 才取到第 4 个码点。附加判断依次为 `true`、`false`：`[]byte` 往返无损保留非法字节 `0xff`，而转 `[]rune` 会将其替换为 `U+FFFD`（重编码后占 3 字节），破坏原始二进制内容。

</details>

### 练习 3：nil 映射读写与逗号 ok 判存

写出以下代码的输出。若将首行改为 `var counts map[string]int`，哪一行会在何时报错？如何在保留首行 `var` 声明的前提下修复？

```go
counts := map[string]int{"go": 0}
present, okPresent := counts["go"]
missing, okMissing := counts["rust"]
counts["go"]++
fmt.Println(present, okPresent, missing, okMissing, counts["go"])
```

<details>
<summary>查看参考答案</summary>

原代码输出 `0 true 0 false 1`：键 `"go"` 值为零值而 `"rust"` 缺失，单靠返回值 `0` 无法区分，须凭 `ok` 布尔值判断。

首行改为 `var counts map[string]int` 后，两次读取对 `nil` 映射依然安全，均返回 `0, false`；但 `counts["go"]++` 包含写入操作，会在**运行期**触发 `panic`。在 `counts["go"]++` 之前补一行 `counts = make(map[string]int)` 即可修复。

</details>

## 面试题 {#ch3-interview}

以下 3 道面试题聚焦切片引用泄漏、映射元素寻址规则与切片转数组边界。代码上下文同[练习部分](#ch3-exercises)。建议先独立作答，再展开核对参考答案。

### 面试题 1：`clear(s)` 与 `s = s[:0]` 有何本质区别？复用含指针的切片缓冲区要注意什么？

<details>
<summary>查看参考答案</summary>

`clear(s)` 将 `s[:len(s)]` 范围内的底层元素置零，不改变 `len` 和 `cap`；`s = s[:0]` 只把切片描述符长度改为 `0`，底层数组里的旧值原封未动。若切片元素含指针或引用，必须**先执行 `clear(s)` 抹除引用，再执行 `s = s[:0]` 重置长度**；若顺序颠倒，`clear` 因 `len == 0` 变成空操作，残留指针会阻碍旧对象被 GC 回收。

</details>

### 面试题 2：为什么 `map[string]Meta` 不能直接写 `m["go"].Count++`，却能写 `m["go"].Tags[0] = "safe"`？

```go
type Meta struct {
	Count int
	Tags  []string
}
```

<details>
<summary>查看参考答案</summary>

映射索引 `m["go"]` 返回的是不可寻址的结构体值副本，其字段 `m["go"].Count` 同样不可寻址，编译器直接禁止修改临时副本字段。而**切片下标表达式始终可寻址**：`m["go"].Tags[0] = "safe"` 从临时副本取出 `Tags` 切片描述符后，顺着指针直接改写了共享底层数组的第 `0` 号元素，并未改动映射桶内存储的结构体自身。

</details>

### 面试题 3：切片转数组 `[N]T(s)` 和 `(*[N]T)(s)` 在运行期检查 `len(s)` 还是 `cap(s)`？

<details>
<summary>查看参考答案</summary>

一律严格检查 **`len(s) >= N`**。只要当前切片长度小于 `N`，哪怕底层容量 `cap(s) >= N`，运行期也会立即触发 `panic`。区别在于 `[N]T(s)`（Go 1.20+）会复制前 `N` 个元素生成独立新数组，而 `(*[N]T)(s)`（Go 1.17+）返回直接指向原底层数组首部的数组指针，修改互相同步。

</details>

## 参考资料

- [Go 语言规范：数组、切片、映射与结构体类型](https://go.dev/ref/spec#Array_types)
- [Go 语言规范：切片表达式与三索引切片](https://go.dev/ref/spec#Slice_expressions)
- [Go 语言规范：切片到数组或数组指针的转换](https://go.dev/ref/spec#Conversions_from_slice_to_array_or_array_pointer)
- [Go 语言规范：内置函数 `append`、`copy` 与 `clear`](https://go.dev/ref/spec#Appending_and_copying_slices)
- [Go 语言规范：比较运算与可寻址操作数](https://go.dev/ref/spec#Comparison_operators)
- [Go 标准库 `slices` 与 `maps`](https://pkg.go.dev/slices)
- [Go Blog：Strings, bytes, runes and characters in Go](https://go.dev/blog/strings)
- [Go 1.24 发布说明：基于 Swiss Table 的映射实现](https://go.dev/doc/go1.24#runtime)
