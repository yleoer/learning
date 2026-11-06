---
title: 第 13 章 标准库
description: 掌握 io、time、encoding/json、net/http 与 log/slog 五个核心标准库包的设计契约与工程惯用法。
---

# 第 13 章 标准库

## 本章要点

Go 标准库素有“自带电池”的口碑：不用引入一堆第三方框架，光靠标准库就能搭起健壮的后端服务。本章挑出日常出镜率最高、也最能代表 Go 接口与组合品味的五个核心包——`io` 用两个单方法接口串起全生态字节流，`time` 把时长、时区与防时钟回拨的单调时钟打包进不可变值，`encoding/json` 借助结构体标签与流式编解码打通外部数据边界，`net/http` 提供生产级客户端、Go 1.22 增强路由与中间件模型，`log/slog` 则统一了结构化日志输出——重点厘清每个包最容易踩坑的默认行为与资源清理边界。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 13.1 `io` 家族 {#ch13-1}

除另有说明外，本章正文中的类型与函数声明位于包级作用域，语句片段位于函数体内，省略外层 `package main` 与 `import` 声明；各小节涉及的标准库包在首次出现处注明导入路径。

### 13.1.1 `io.Reader` 与 `io.Writer` {#ch13-1-1}

整个 Go I/O 生态都立在标准库 `"io"` 的两个单方法接口之上（全语言使用频率仅次于 `error`）：

```go
type Reader interface {
	Read(p []byte) (n int, err error)
}

type Writer interface {
	Write(p []byte) (n int, err error)
}
```

初学者第一次见 `Read(p []byte)` 往往纳闷：“为什么不是 `Read() ([]byte, error)` 直接把读出来的字节返回给我？”答案在 [6.8 节](./chapter-06#ch6-8)已经埋过伏笔——如果每次 `Read` 都新建切片返回，高频读取循环每秒就会制造海量短命堆分配；反过来由调用方传一块切片缓冲区进去让 `Read` 填数据，分配权完全握在调用方手里，一块缓冲区就能从头复用到尾。

按 `io.Reader` 契约统计流中英文字母频次的标准写法如下：

```go
func countLetters(r io.Reader) (map[string]int, error) {
	buf := make([]byte, 2048)
	out := map[string]int{}
	for {
		n, err := r.Read(buf)
		for _, b := range buf[:n] {
			if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') {
				out[string(b)]++
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return nil, err
		}
	}
}
```

写 `Read` 循环务必盯紧三点：

1. **切片一定要按实际读出的字节数截成 `buf[:n]`**：当某次读不满 2048 字节时，`buf[n:]` 里留着的还是上一轮没覆盖掉的旧垃圾字节；
2. **先消费 `buf[:n]`，后检查 `err`**：这是全语言极少数打破“先判错再用值”惯例的地方——`io.Reader` 允许最后一次读取把剩余字节填进 `buf` 的同时顺手返回 `io.EOF`（`io` 契约要求实现方直接返回未包装的 `io.EOF` 哨兵值，因此写 `err == io.EOF` 或 `errors.Is(err, io.EOF)` 均可）；
3. **分清正常读完与半路截断**：正常读到流末尾返回 `io.EOF`；如果在按固定长度读报文头时流提前断了，`io.ReadFull` 等辅助函数则会返回代表异常截断的 `io.ErrUnexpectedEOF`。

### 13.1.2 装饰、组合与辅助函数 {#ch13-1-2}

正因为 `io.Reader` 只有一个方法，字符串（`"strings"` 的 `strings.NewReader`）、内存字节（`"bytes"` 的 `bytes.NewReader`）、磁盘文件（`*os.File`）、TCP/HTTP 响应体乃至压缩加密流全都能无缝套在一起。比如想让上面的 `countLetters` 直接统计 `.gz` 压缩文件，一行 `countLetters` 都不用改，只需在外头套一层 `"compress/gzip"` 的 `gzip.NewReader`（下例还用到 `"os"`）：

```go
func buildGZipReader(fileName string) (*gzip.Reader, func(), error) {
	r, err := os.Open(fileName)
	if err != nil {
		return nil, nil, err
	}
	gr, err := gzip.NewReader(r)
	if err != nil {
		_ = r.Close() // 注意：创建外层包装器失败时，必须先把已打开的底层文件关掉！
		return nil, nil, err
	}
	return gr, func() {
		_ = gr.Close()
		_ = r.Close()
	}, nil
}
```

留心上面注释标出的易漏细节：一旦 `os.Open` 成功拿到了文件句柄 `r`，后面构造 `gzip.NewReader(r)` 如果因为文件头损坏失败，返回前**必须手动把 `r.Close()` 调了**，否则就会泄漏一个无人关闭的文件描述符；成功返回后，调用方只需写一句 `defer closer()` 就能按从外到内的顺序把压缩流和底层文件一并关干净。

`"io"` 包里还有几个天天见面的搭积木小工具：

- **`io.Copy(dst, src)`**：在内部用 32 KiB 缓冲区（或走 `WriterTo`/`ReaderFrom` 零拷贝快路径）把 `src` 流式搬运到 `dst`，直到读完 `io.EOF`（注意 `io.Copy` 视 `io.EOF` 为正常结束，返回 `err == nil`）；
- **`io.LimitReader(r, maxBytes)`**：给不可信的外部输入流套一道字节上限闸门，防备超大请求把内存撑爆；
- **`io.MultiReader` / `io.MultiWriter`**：把几个输入流首尾拼成一条流，或者一次写入同时分发给多个输出流（比如一边写文件一边算 SHA-256 哈希）；
- **`io.ReadAll(r)`（Go 1.16+）**：一口气把整个流读进一块内存切片，只适合确定体积很小的响应或配置，大文件千万别图省事调它；
- **`io.NopCloser(r)`（Go 1.16+，早年在 `io/ioutil`）**：通过结构体内嵌给只有 `Read` 的对象补一个空操作的 `Close() error { return nil }`，凑足 `io.ReadCloser` 接口：

```go
type nopCloser struct {
	io.Reader
}

func (nopCloser) Close() error { return nil }
```

### 13.1.3 `os` 文件读写与 `bufio` 缓冲 {#ch13-1-3}

小配置文件一把读入或覆写，直接调 `"os"` 包的 `os.ReadFile` 和 `os.WriteFile`（Go 1.16+）最省事；大文件或需要按行解析文本时，则用 `os.Open` 拿到 `*os.File`，外头套一层标准库 `"bufio"` 的 `bufio.Scanner`（或带缓冲区的 `bufio.Reader` / `bufio.Writer`）：

```go
f, err := os.Open("access.log")
if err != nil {
	return err
}
defer f.Close()

scanner := bufio.NewScanner(f)
for scanner.Scan() {
	line := scanner.Text()
	_ = line
}
if err := scanner.Err(); err != nil {
	return err
}
```

用 `bufio.Scanner` 记住两个小细节：一是循环结束后**一定要检查 `scanner.Err()`**（它把正常 `io.EOF` 吞掉返回 `nil`，真遇到 I/O 错误或超长行截断全靠 `Err()` 报错）；二是它默认单行最大缓冲区只有 **64 KiB**（`bufio.MaxScanTokenSize`），扫超长 JSON 日志行前记得先调 `scanner.Buffer(buf, maxLen)` 扩容。另外自 Go 1.24 起，`"os"` 包新增了 `os.OpenRoot(dir)`，需要把用户传入的相对路径严格锁死在某个根目录下防目录穿越（`../`）时，优先用 `os.Root` 代替手写路径前缀拼接。

## 13.2 `time` 时间与定时 {#ch13-2}

### 13.2.1 时间段 `time.Duration` {#ch13-2-1}

标准库 `"time"` 用两个独立类型严格区分“一段时长”和“某个时刻”。时长类型 `time.Duration` 底层是**以纳秒为单位的 `int64`**（最大可表达约 290 年），写代码时直接拿预定义时间单位常量相乘相加：

```go
timeout := 2*time.Minute + 30*time.Second
```

注意函数参数收时长时直接收 `time.Duration`（调用方写 `5 * time.Second` 自带单位，绝不会闹出“这个 `int` 参数到底是秒还是毫秒”的乌龙）；配置文件里的 `"300ms"`、`"1h30m"` 字符串则可用 `time.ParseDuration` 解析（注意最大单位只支持到小时 `"h"`，因为夏令时切换下“一天”未必等于 24 小时）。

### 13.2.2 时刻 `time.Time` 与参考时间格式化 {#ch13-2-2}

`time.Time` 是带时区（`Location`）的值类型，所有计算方法（`Add`、`AddDate`、`UTC`、`In`、`Truncate`）都定义在值接收者上并返回新实例，不会原地改原变量。

比较两个 `time.Time` 时记住一条铁律：**永远用 `t1.Equal(t2)`、`t1.Before(t2)`、`t1.After(t2)`，不要直接写 `t1 == t2`**！因为 `==` 会连同结构体内部的时区指针和单调时钟字段逐一硬比——同一个绝对时刻，一个标着 `UTC`、一个标着 `+08:00`（或者一个来自 `time.Now()` 带单调时钟、一个刚从数据库反序列化出来不带单调时钟），用 `==` 比出来全是 `false`，而 `Equal` 会自动换算成同一瞬时再比较。

格式化与解析时间字符串时，Go 不用 `yyyy-MM-dd HH:mm:ss` 那套字母占位符，而是固定拿一个好记的参考时刻 **`Mon Jan 2 15:04:05 MST 2006`**（按美式习惯排列正好是 `01月 02日 03点 04分 05秒 06年 -07时区`，下午写作 `15`）当模板：

```go
t, err := time.Parse(time.RFC3339, "2026-03-13T08:30:00Z")
if err != nil {
	return err
}
fmt.Println(t.Format("2006-01-02 15:04:05"))
```

平时优先直接用标准库预定义好的布局常量：`time.RFC3339`、`time.RFC3339Nano`，以及 Go 1.20 补齐的 `time.DateTime`（`"2006-01-02 15:04:05"`）、`time.DateOnly`（`"2006-01-02"`）和 `time.TimeOnly`（`"15:04:05"`）。还要留心 `time.Parse` 在字符串不含时区偏移时默认按 **UTC** 解析；想按服务器本地时区或指定时区解析无偏移时间串，应改用 `time.ParseInLocation`。

### 13.2.3 单调时钟（Monotonic Clock） {#ch13-2-3}

操作系统里其实走着两块表：**墙上时钟（Wall Clock）**用来报现在是几点几分，但一旦遇到 NTP 网络校时或运维调表，可能突然往前跳或往回倒退几百毫秒；**单调时钟（Monotonic Clock）**只管从开机起稳步往前走了多久，绝不回拨。

在 Go 里完全不用你操心切哪块表：`time.Now()` 返回的 `time.Time` 内部已经悄悄捎上了当前单调时钟读数。只要起点 `start := time.Now()`，后面调 `time.Since(start)` 或 `end.Sub(start)` 算耗时，底层自动走单调时钟相减，哪怕中途系统时间被往回拨了一小时，算出来的接口耗时也绝不会变成负数（而经 `time.Parse` 或 JSON 反序列化出来的外部时间自然没有单调读数，只能按墙上时间相减）。

### 13.2.4 定时器与 `Ticker` {#ch13-2-4}

配合 `select` 做定时等待或周期轮询时，常用三个入口：

- **`time.After(d)`**：返回一个在 `d` 之后送出一次当前时刻的只读通道 `<-chan time.Time`；
- **`time.NewTicker(d)`**：返回周期性往 `ticker.C` 送时刻的 `*time.Ticker`，支持随时调用 `ticker.Stop()` 停止或 `ticker.Reset(d)` 改周期（`time.Tick(d)` 则是直接返回通道的简写包装）；
- **`time.AfterFunc(d, fn)`**：等够 `d` 之后单独起一个 Goroutine 跑一次 `fn`。

这里特别更新一条**跨版本重要变化**：在 Go 1.22 及更早版本中，老教程都会严厉警告“千万别在循环或长生命周期函数里用 `time.Tick` 或提前退出的 `time.After`，因为没调 `Stop()` 的底层定时器在触发前永远无法被 GC 回收”。**自 Go 1.23 起（模块语言版本 `>= 1.23`），运行时重写了定时器通道实现：只要没有任何代码再引用某个 `Timer` 或 `Ticker`（哪怕从未调过 `Stop`），垃圾回收器就能直接把它回收掉！**

即便如此，写 `for-select` 循环时依然要注意别把 `case <-time.After(5 * time.Second):` 错当成“总超时”或直接把 `case <-time.Tick(time.Second):` 塞进循环条件每次重新求值——每转一轮 `select` 都会新建一个全新的定时器从头倒数，既浪费分配又会让活跃通道重置计时；周期任务应先在循环外建好 `ticker := time.NewTicker(time.Second)`（顺手 `defer ticker.Stop()` 依然是兼容所有 Go 版本的好习惯），在循环内监听 `case <-ticker.C:`。

## 13.3 `encoding/json` 编解码 {#ch13-3}

### 13.3.1 结构体标签与 `omitzero` {#ch13-3-1}

标准库 `"encoding/json"` 通过结构体字段后面的标签控制字段名与空值省略。切记一个大前提：**`encoding/json` 基于反射工作，只能读写首字母大写的导出字段**——小写未导出字段不管贴没贴 `json` 标签都会被静默无视（标签拼写错漏可由 `go vet` 的 `structtag` 检查器抓出）：

```go
type Order struct {
	ID          string    `json:"id"`
	DateOrdered time.Time `json:"date_ordered,omitzero"`
	CustomerID  string    `json:"customer_id,omitempty"`
	InternalTag string    `json:"-"`
	Items       []Item    `json:"items"`
}
```

几条高频标签规则务必分清：

- **不写标签时**：`Marshal` 直接输出大写 Go 字段原名；`Unmarshal` 先找精确同名字段，找不到再做不区分大小写的兜底匹配。对外协议结构体应老老实实给每个导出字段写清 `json:"snake_case"`。
- **`json:"-"`**：编码和解码时彻底忽略该字段（极少数情况下如果真有个 JSON 键名叫 `"-"`，要写成 `json:"-,"`）。
- **`omitempty` 与 Go 1.24 新增的 `omitzero`**：老牌选项 `omitempty` 判断“空”的标准很怪——`0`、`false`、`""`、`nil` 指针以及长度为 `0` 的空切片/空映射算空，但**零值结构体（包括高频踩坑的零值 `time.Time{}`，会被打成 `"0001-01-01T00:00:00Z"`！）竟然不算空**。自 **Go 1.24** 起新增的 **`omitzero`** 彻底治好了这个痛点：严格按 Go 类型的零值（或类型自己实现的 `IsZero() bool` 方法，如 `time.Time.IsZero`）判定是否省略，新代码表达“零值不输出”优先用 `omitzero`（注意对非 `nil` 空切片 `[]int{}`，`omitempty` 会省略，而 `omitzero` 因切片本身非零值 `nil` 会保留输出 `[]`）。
- **`json:",string"`**：对布尔、整数、浮点或字符串字段，编码时外包一层双引号转成 JSON 字符串（对接 JavaScript 前端防 64 位大整数精度丢失时常用）。

### 13.3.2 内存切片编解码与流式 `Encoder`/`Decoder` {#ch13-3-2}

数据已经在内存 `[]byte` 里时，用 `json.Unmarshal(data, &v)` 和 `json.Marshal(v)`；数据源或目标本身就是 `io.Reader` / `io.Writer`（如 HTTP 请求响应体、磁盘文件）时，直接用 `json.NewDecoder(r).Decode(&v)` 和 `json.NewEncoder(w).Encode(v)` 流式处理，省掉先把整个请求体 `io.ReadAll` 拷进大字节切片的开销（注意 `Encode` 写完 JSON 后会自动在末尾补一个换行符 `\n`）：

```go
if err := json.NewEncoder(w).Encode(order); err != nil {
	return err
}
```

顺带提一句生态演进：Go 1.27 标准库已合入新一代 `"encoding/json/v2"`（及底层词法流 `"encoding/json/jsontext"`），大幅提升了吞吐性能，并修正了 v1 的一批历史默认行为（例如 v2 默认区分字段大小写、默认把 `nil` 切片编码为 `[]` 而非 `null`）；存量代码里的 `"encoding/json"` 依然长期受兼容性保护，新项目在明确需要 v2 语义或更高性能时可按需选用。

### 13.3.3 连续 JSON 流 {#ch13-3-3}

遇到日志采集或流式推送常见的 NDJSON（一行一个独立 JSON 对象，外层不包 `[...]` 数组）时，`json.Unmarshal` 没法直接解，用 `json.NewDecoder` 循环 `Decode` 直到 `io.EOF` 正好合适：

```go
dec := json.NewDecoder(r)
for {
	var item struct {
		Name string `json:"name"`
		Age  int    `json:"age"`
	}
	if err := dec.Decode(&item); err != nil {
		if errors.Is(err, io.EOF) {
			break
		}
		return err
	}
	// 处理单条 item
}
```

### 13.3.4 自定义编解码接口 {#ch13-3-4}

`time.Time` 默认按 RFC 3339 格式编解码 JSON。如果对接的老系统非要传 RFC 822 格式时间，只需包一层内嵌 `time.Time` 的定义类型，分别实现 `json.Marshaler`（值接收者，保证传值和传指针都能触发）和 `json.Unmarshaler`（指针接收者，负责写回结果）：

```go
type RFC822ZTime struct {
	time.Time
}

func (rt RFC822ZTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + rt.Format(time.RFC822Z) + `"`), nil
}

func (rt *RFC822ZTime) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	var raw string
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	t, err := time.Parse(time.RFC822Z, raw)
	if err != nil {
		return err
	}
	*rt = RFC822ZTime{Time: t}
	return nil
}
```

注意 `UnmarshalJSON` 收到的是原始 JSON 词法字节切片（含外层双引号及可能存在的 `\uXXXX` 等合法 JSON 字符串转义序列）：先用 `json.Unmarshal(b, &raw)` 解码还原出真实的 Go 字符串，再交给 `time.Parse` 解析，才能完整兼容标准 JSON 字符串转义。

如果一张业务表既有复杂的自定义 JSON 映射又有内部领域字段，与其在同一个结构体上硬搓容易无限递归的 `MarshalJSON`，不如干脆**把边界传输用的 DTO 结构体和内部领域结构体拆成两个类型**，解析完显式转换一次，代码干净得多。另外，`map[string]any` 只拿来临时探查未知格式的报文（注意 JSON 数字解进 `any` 会全部变成 **`float64`**！），一旦格式敲定就应立刻换成具体结构体。

## 13.4 `net/http` 客户端与服务端 {#ch13-4}

### 13.4.1 HTTP 客户端 {#ch13-4-1}

写生产级 HTTP 调用先记住头号禁令：**不要直接调包级的 `http.Get`、`http.Post` 或裸用 `http.DefaultClient`**——因为默认客户端的 `Timeout` 是 **`0`（永不超时）**！一旦下游挂死不回包，你的 Goroutine 和套接字就会一并死挂在上面直到把整个服务拖垮。

正确姿势是在组件初始化时建一个显式配好 `Timeout` 的 `*http.Client` 并并发复用它（注意底层的 TCP/TLS 连接池实际由客户端持有的 `Transport` 管理：未指定 `Transport` 的多个 `http.Client` 会共享全局 `http.DefaultTransport` 连接池；但如果每次请求都新建自定义的 `&http.Transport{...}`，就会彻底废掉连接复用并泄漏空闲连接协程，因此自定义 `Client` 与 `Transport` 都应按组件单例复用）：

```go
client := &http.Client{Timeout: 10 * time.Second}

req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://example.com/todos/1", nil)
if err != nil {
	return err
}
req.Header.Set("Accept", "application/json")

res, err := client.Do(req)
if err != nil {
	return err
}
defer res.Body.Close()

if res.StatusCode != http.StatusOK {
	return fmt.Errorf("unexpected status: %s", res.Status)
}
```

盯紧上面代码里的三个关键动作：

1. 用 `http.NewRequestWithContext(ctx, ...)` 把请求挂在调用链的 `context.Context` 上，上游一取消或超时立刻中断请求；
2. 只要 `err == nil` 拿到了 `res`，紧接着下一行**无条件 `defer res.Body.Close()`**（哪怕你不关心响应体内容也要关，否则底层 TCP 连接没法归还连接池复用甚至泄漏）；
3. **手动检查 `res.StatusCode`**：只要网络收发本身成功，对方回 `404` 或 `500` 时 `client.Do` 返回的 **`err` 依然是 `nil`**！不查状态码直接拿 `res.Body` 当成功 JSON 解码是新手常犯的错。

### 13.4.2 HTTP 服务器、路由与中间件 {#ch13-4-2}

服务端同样**不要在生产代码里直接调包级的 `http.HandleFunc` 和 `http.ListenAndServe`**——前者往全局共享的 `http.DefaultServeMux` 里塞路由（任何偷偷 `init` 的第三方包都能往上面挂暴露内部接口的路由），后者创建的是零超时的裸 `http.Server`，慢速连接攻击分分钟把文件描述符耗光。

标准做法是自己实例化 `http.NewServeMux()` 和配齐超时的 `http.Server`。自 **Go 1.22** 起，标准库 `ServeMux` 原生支持**“HTTP 方法 + `{参数}` 路径通配符”**（含匹配剩余路径段的 `{path...}` 与精确匹配根路径的 `{$}`），绝大多数中小型 REST 服务连第三方路由库都不用装了：

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /hello/{name}", func(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, "Hello, %s!\n", name)
})

srv := &http.Server{
	Addr:              ":8080",
	ReadHeaderTimeout: 5 * time.Second,
	ReadTimeout:       15 * time.Second,
	WriteTimeout:      30 * time.Second,
	IdleTimeout:       60 * time.Second,
	Handler:           mux,
}
```

写 `ServeHTTP` 处理函数时切记 **`http.ResponseWriter` 的调用顺序不可颠倒**：所有响应头 `w.Header().Set(...)` 必须在调 `w.WriteHeader(code)` 或第一次调 `w.Write(...)` **之前**设好——一旦调了 `Write`（若此前没调过 `WriteHeader` 会自动先发出 `200 OK` 和当前头部），响应头就已经刷上网络了，后面再改 `Header()` 或补 `WriteHeader` 都不会生效。

鉴权、请求耗时日志、跨域防护（Go 1.25 标准库还内置了防 CSRF 的 `http.NewCrossOriginProtection`）、`panic` 恢复这类横切逻辑，统一写成 **`func(http.Handler) http.Handler` 中间件**层层包裹即可：

```go
func RequestTimer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("http request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
	})
}
```

顺带留心一个中间件包装副作用：外层中间件如果把原始 `ResponseWriter` 包进了自己的结构体里，内层想调用流式刷新的 `http.Flusher` 或单独调整当前请求写超时的能力时，直接类型断言 `w.(http.Flusher)` 就会断掉。自 Go 1.20 起应统一改用 **`rc := http.NewResponseController(w)`**（调 `rc.Flush()`、`rc.SetWriteDeadline(...)`），它会自动穿透实现了 `Unwrap() http.ResponseWriter` 的中间件层找到底层连接控制器。

## 13.5 `log/slog` 结构化日志 {#ch13-5}

早期 `"log"` 包只能打一串纯文本，线上几百个实例汇总到日志检索系统后根本没法按字段过滤聚合。自 **Go 1.21** 起，标准库 `"log/slog"` 正式提供了带级别、带键值对的结构化日志体系：

```go
logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
	Level: slog.LevelInfo,
}))
slog.SetDefault(logger)

slog.Info("user login", "user_id", userID, "login_count", loginCount)
```

上面这行会向标准错误输出一条字段规整的 JSON（开发调试想看紧凑文本时把 `NewJSONHandler` 换成 `NewTextHandler` 即可；单测里想彻底静默日志，自 Go 1.24 起可直接传 `slog.DiscardHandler`；需要一条日志同时发往多个后端，Go 1.26 起内置了 `slog.NewMultiHandler`）。

日常用 `slog` 记住三点：

1. 变长参数写交替的 `"key", value` 最省事，而且 `go vet` 内置了 `slog` 检查器，漏写一个值导致奇偶错位或键不是字符串时静态检查就会直接报错；
2. 在每秒打上万条的极致热点路径上，改调 `logger.LogAttrs(ctx, slog.LevelInfo, "msg", slog.String("id", id), slog.Int("n", n))` 可以消除 `any` 装箱，把单条日志堆分配压到最低；
3. **写通用底层库时尽量别在库内部自作主张往全局打日志**——把情况包进 `error` 返回给调用方，或者按 [7.9 节](./chapter-07#ch7-9)接收调用方注入的日志接口，让应用顶层统一决定日志格式、采样和去向。

## 练习 {#ch13-exercises}

以下三题按步骤搭起一个小巧完整的 HTTP 时间服务：先建带超时的服务与路由，再套上 JSON 结构化访问日志中间件，最后按请求头 `Accept` 切换文本或 JSON 响应。建议先独立编写，再展开核对参考答案。

### 练习 1：搭建带超时的 RFC 3339 时间接口

使用 `http.NewServeMux` 与显式配置了读写空闲超时的 `http.Server`，暴露 `GET /time` 路由，返回当前时刻的 RFC 3339 格式文本。

<details>
<summary>查看参考答案</summary>

```go
package main

import (
	"fmt"
	"log"
	"net/http"
	"time"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /time", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, time.Now().Format(time.RFC3339))
	})

	srv := &http.Server{
		Addr:              ":8080",
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		Handler:           mux,
	}
	log.Fatal(srv.ListenAndServe())
}
```

路由模式 `"GET /time"`（Go 1.22+）会自动拒绝 `POST /time` 等其他方法（返回 `405 Method Not Allowed` 并自动补好 `Allow` 响应头），显式构造 `http.Server` 则补上了生产必需的连接超时保护。

</details>

### 练习 2：编写 `slog` JSON 请求日志中间件

实现中间件 `RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler`，为经过它的每个请求输出一条包含客户端地址（`RemoteAddr`）、HTTP 方法、请求路径和耗时字符串的 JSON 日志，并包裹练习 1 的 `mux`。

<details>
<summary>查看参考答案</summary>

需额外导入 `"log/slog"` 与 `"os"`：

```go
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			next.ServeHTTP(w, r)
			logger.InfoContext(r.Context(), "http_request",
				"remote_addr", r.RemoteAddr,
				"method", r.Method,
				"path", r.URL.Path,
				"duration", time.Since(start).String(),
			)
		})
	}
}

// main 中组装：
logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
srv.Handler = RequestLogger(logger)(mux)
```

把 `*slog.Logger` 作为参数显式注入中间件工厂，比硬编码调全局 `slog.Info` 更容易在单测里替换成内存缓冲区断言输出；调 `InfoContext(r.Context(), ...)` 还能让自定义 `slog.Handler` 自动从请求上下文提取追踪 ID。

</details>

### 练习 3：按 `Accept` 请求头协商输出 JSON 或纯文本

扩展 `GET /time`：当客户端请求头 `Accept` 包含 `application/json` 时，返回 `Content-Type: application/json` 及包含星期、日、月份英文名、年、时、分、秒字段的 JSON 对象；否则继续返回纯文本 RFC 3339 时间。

<details>
<summary>查看参考答案</summary>

需额外导入 `"encoding/json"` 与 `"strings"`：

```go
type timeResponse struct {
	DayOfWeek  string `json:"day_of_week"`
	DayOfMonth int    `json:"day_of_month"`
	Month      string `json:"month"`
	Year       int    `json:"year"`
	Hour       int    `json:"hour"`
	Minute     int    `json:"minute"`
	Second     int    `json:"second"`
}

mux.HandleFunc("GET /time", func(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		resp := timeResponse{
			DayOfWeek:  now.Weekday().String(),
			DayOfMonth: now.Day(),
			Month:      now.Month().String(),
			Year:       now.Year(),
			Hour:       now.Hour(),
			Minute:     now.Minute(),
			Second:     now.Second(),
		}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "encode time response failed", "err", err)
		}
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, now.Format(time.RFC3339))
})
```

注意两点细节：一是 `w.Header().Set("Content-Type", ...)` 必须在 `Encode` 首次调用 `w.Write` 之前设置；二是一旦 `Encode` 开始往 `w` 写字节，HTTP `200` 状态码就已经发出去了，此时若中途网络断开导致 `Encode` 返回错误，再调 `http.Error(w, ..., 500)` 已经改不了状态码，记入错误日志即可。

</details>

## 面试题 {#ch13-interview}

以下四题分别检验 `io.Reader.Read` 边界、`time.Time` 判等与单调时钟、`net/http` 默认陷阱以及结构体 JSON 标签的 `omitempty` 与 `omitzero` 差异。建议先独立作答，再展开核对参考答案。

### 面试题 1：调用 `n, err := r.Read(buf)` 时，如果 `err != nil`，能不能直接跳过数据处理就 `return`？

<details>
<summary>查看参考答案</summary>

**不能！** 按照 `io.Reader` 接口规范，一次 `Read` 调用完全可能先把最后一批有效字节填入 `buf[:n]`（`n > 0`），同时在同一次返回里带上 `err == io.EOF` 或读取错误。必须先处理完 `n > 0` 对应的 `buf[:n]` 数据，再去判断 `err != nil`。

</details>

### 面试题 2：为什么判断两个 `time.Time` 是否代表同一时刻不能用 `==`？算接口耗时为什么不怕 NTP 校时回拨？

<details>
<summary>查看参考答案</summary>

`time.Time` 内部除了墙上时间，还存有时区指针（`*time.Location`）和可选的单调时钟读数。直接写 `t1 == t2` 会把时区指针和单调时钟位一并纳入结构体字段比较，导致同一绝对时刻在不同时区表示（如 UTC 与东八区）或有无单调读数时被判为 `false`；正确做法是调用 `t1.Equal(t2)`。

`time.Now()` 生成的 `time.Time` 自带单调时钟读数，调用 `time.Since(start)` 或两者的 `Sub` 时会自动直接拿单调时钟求差，完全绕开可能跳变的系统墙上时间。

</details>

### 面试题 3：用 `http.Get(url)` 发线上请求有哪两个大坑？

<details>
<summary>查看参考答案</summary>

1. **零超时风险**：`http.Get` 底层用的是全局 `http.DefaultClient`，其默认 `Timeout` 为 `0`（永不超时），也没法传入请求级 `context.Context` 做取消联动；下游一旦僵死就会把本服务的 Goroutine 与连接耗光。生产代码应复用显式设好 `Timeout` 的 `*http.Client`，并用 `http.NewRequestWithContext` 发请求。
2. **返回 `err == nil` 后仍须关 `Body` 并查 `StatusCode`**：只要收到合法 HTTP 响应报文（哪怕状态码是 `500` 或 `404`），`err` 都是 `nil`；漏掉 `defer res.Body.Close()` 会导致连接无法复用并泄漏文件描述符，漏查 `res.StatusCode` 则会把错误页当正常数据解析。

</details>

### 面试题 4：在 JSON 编码中，未初始化的切片、`omitempty` 与 Go 1.24 的 `omitzero` 有什么区别？

```go
type Event struct {
	Tags []string  `json:"tags"`
	At   time.Time `json:"at,omitempty"`
	When time.Time `json:"when,omitzero"`
}
```

对零值 `Event{}` 执行 `json.Marshal` 会输出什么？

<details>
<summary>查看参考答案</summary>

输出 `{"tags":null,"at":"0001-01-01T00:00:00Z"}`。

1. `Tags` 没有省略标签：零值 `nil` 切片在 `"encoding/json"` v1 中默认编码为 `null`（而非 `nil` 空切片 `[]string{}` 才会编码为 `[]`）。
2. `At` 用的是旧的 `omitempty`：`omitempty` 不把结构体零值当成“空值”，所以零值 `time.Time{}` 不会被省略，而是打成 `"0001-01-01T00:00:00Z"`。
3. `When` 用的是 Go 1.24 新增的 `omitzero`：它会识别类型零值及 `IsZero() bool` 方法，`time.Time{}.IsZero()` 为 `true`，因此 `"when"` 字段被干净省略。

</details>

## 参考资料

- [Go 标准库 `io`：`Reader`、`Writer` 与流组合工具](https://pkg.go.dev/io)
- [Go 标准库 `os`：文件读写与 `os.Root`（Go 1.24+）](https://pkg.go.dev/os)
- [Go 标准库 `bufio`：`Scanner` 与缓冲流](https://pkg.go.dev/bufio)
- [Go 标准库 `time`：`Duration`、`Time`、单调时钟与 `Ticker`](https://pkg.go.dev/time)
- [Go 标准库 `encoding/json`：结构体标签（含 `omitzero`）与编解码器](https://pkg.go.dev/encoding/json)
- [Go 1.24 发布说明：`omitzero` 标签选项与 `os.Root`](https://go.dev/doc/go1.24)
- [Go 标准库 `net/http`：客户端、`ServeMux` 路由与 `ResponseController`](https://pkg.go.dev/net/http)
- [Go 1.22 发布说明：`net/http.ServeMux` 增强路由模式](https://go.dev/doc/go1.22#enhanced_routing_patterns)
- [Go 官方博客：Structured Logging with `slog`](https://go.dev/blog/slog)
- [Go 标准库 `log/slog`：结构化日志记录器](https://pkg.go.dev/log/slog)
