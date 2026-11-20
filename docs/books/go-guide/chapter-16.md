---
title: 第 16 章 JSON、HTTP 与日志
description: 掌握 encoding/json 标签与流式编解码、net/http 生产级客户端与 Go 1.22+ 路由中间件，以及 log/slog 结构化日志实践。
---

# 第 16 章 JSON、HTTP 与日志

## 本章要点

无需引入厚重的第三方框架，仅凭 Go 标准库即可构建生产就绪的 Web 服务与数据接口：`"encoding/json"` 通过结构体标签与流式编解码打通外部协议边界，`"net/http"` 提供连接池客户端、增强型路由与可组合中间件模型，`"log/slog"` 则统一了高性能结构化日志输出。本章重点梳理结构体标签、自定义 JSON 序列化、HTTP 客户端与服务端的零超时陷阱及响应头写入顺序，最后总结结构化日志在业务层与底层库中的职责边界。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 16.1 encoding/json 序列化与流式编解码 {#ch16-1}

### 16.1.1 结构体标签速查（含 omitzero） {#ch16-1-1}

标准库 `"encoding/json"` 基于运行期反射工作，详见[第 19 章](./chapter-19#ch19-1)，**只能读写首字母大写的导出字段**；小写未导出字段无论是否标注 `json` 标签都会被静默忽略，标签语法拼写错误则可由 `go vet` 的 `structtag` 检查器静态拦截。

结构体 `json` 标签各选项的行为差异汇总如下：

| 标签写法 | 序列化（Marshal）与反序列化（Unmarshal）行为 |
| --- | --- |
| 不写标签 | `Marshal` 输出大写 Go 字段原名；`Unmarshal` 先精确匹配，未命中再做忽略大小写兜底匹配 |
| `json:"order_id"` | 将字段精确映射为 JSON 键 `"order_id"`，对外协议结构体应显式声明全部键名 |
| `json:"-"` | 编解码均彻底忽略该字段；若 JSON 键名本身恰好是 `"-"`，须写作 `json:"-,"` |
| `json:"tag,omitempty"` | 省略 `0`、`false`、`""`、`nil` 指针及长度为 `0` 的切片与映射，但**不省略零值结构体** |
| `json:"at,omitzero"` | 按类型零值或 `IsZero() bool` 方法省略（Go 1.24+），零值结构体与 `time.Time{}` 均正确省略 |
| `json:"id,string"` | 对布尔、整数、浮点或字符串外包双引号转为 JSON 字符串，常用于防前端 64 位整数精度丢失 |

对比 `omitempty` 与 `omitzero` 时注意两处高频边界：一是零值 `time.Time{}` 在 `omitempty` 下不会被省略，而是输出 `"0001-01-01T00:00:00Z"`，改用 `omitzero` 即可干净省去；二是对非 `nil` 空切片 `[]string{}`，`omitempty` 因长度为 `0` 会将其省略，而 `omitzero` 因切片本身不等于零值 `nil` 会保留输出 `[]`；下例导入 `"time"`：

```go
type Order struct {
	ID          int64     `json:"id,string"`
	CustomerID  string    `json:"customer_id,omitempty"`
	DateOrdered time.Time `json:"date_ordered,omitzero"`
	InternalTag string    `json:"-"`
	Items       []string  `json:"items"`
}
```

### 16.1.2 内存编解码、流式 Decoder 与自定义编解码接口 {#ch16-1-2}

当 JSON 报文已在内存 `[]byte` 中时，使用 `json.Marshal(v)` 与 `json.Unmarshal(data, &v)`，其中 `Unmarshal` 的第二个参数必须传入非 `nil` 指针，见[值语义与指针语义](./chapter-06#ch6-3)。当数据源或目标本身是 `io.Reader` 或 `io.Writer` 时，应直接使用 `json.NewDecoder(r).Decode(&v)` 与 `json.NewEncoder(w).Encode(v)` 流式处理，省去整块 `io.ReadAll` 的内存分配；注意 `Encode` 输出末尾会自动追加换行符 `\n`。

面对日志采集中每行一个独立 JSON 对象的 NDJSON 连续流，可通过同一个 `json.Decoder` 循环调用 `Decode` 直至 `io.EOF`；下例导入 `"encoding/json"`、`"errors"` 与 `"io"`：

```go
func consumeNDJSON(r io.Reader) error {
	dec := json.NewDecoder(r)
	for {
		var event struct {
			Type string `json:"type"`
			Code int    `json:"code"`
		}
		if err := dec.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}
```

此外，Go 1.27 标准库已合入新一代 `"encoding/json/v2"` 及底层词法包 `"encoding/json/jsontext"`，大幅提升了编解码吞吐并修正了默认区分大小写、默认将 `nil` 切片编码为 `[]` 等语义；存量 v1 `"encoding/json"` 仍长期保持兼容。

当对接外部系统需要定制字段格式时，可定义包装类型分别实现 `json.Marshaler`（值接收者）和 `json.Unmarshaler`（指针接收者）：

```go
type RFC822ZTime struct{ time.Time }

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

`UnmarshalJSON` 接收的是含外层双引号与潜在 `\uXXXX` 转义的原始 JSON 词法字节，先用 `json.Unmarshal(b, &raw)` 还原出真实字符串再调用 `time.Parse` 最稳妥。若协议形态与内部模型差异较大，优先拆分为独立的传输 DTO 结构体与领域结构体做显式转换；同时切记用 `map[string]any` 探查未知报文时，JSON 数字会一律解码为 `float64`。

## 16.2 net/http 客户端与服务端实践 {#ch16-2}

### 16.2.1 生产级 HTTP 客户端三要素 {#ch16-2-1}

编写生产级出站调用的首要禁令是：**绝不直接调用包级 `http.Get`、`http.Post` 或裸用 `http.DefaultClient`**。因为默认客户端的 `Timeout` 为 `0`（永不超时），下游一旦挂死不回包，就会将本服务的协程与套接字耗尽。正确做法是在组件初始化时构造显式设好 `Timeout` 的 `*http.Client` 并并发复用；切勿每次发请求都新建 `&http.Transport{}`，否则会破坏底层连接池复用并泄漏空闲连接协程。下例导入 `"context"`、`"fmt"`、`"io"`、`"net/http"` 与 `"time"`：

```go
var apiClient = &http.Client{Timeout: 10 * time.Second}

func fetchTodo(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")

	res, err := apiClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096)) // 有限排空错误体，利于复用连接
		return fmt.Errorf("unexpected status: %s", res.Status)
	}
	_, err = io.Copy(io.Discard, res.Body) // 实际业务中此处解码或读尽响应体至 EOF
	return err
}
```

每次发起请求必须落实三要素：

1. **绑定调用链上下文**：用 `http.NewRequestWithContext(ctx, ...)` 创建请求，使上游超时或取消能立即中断底层套接字等待，见[Context 传参规范](./chapter-14#ch14-1)。
2. **读尽并无条件关闭响应体**：只要 `Do` 返回 `err == nil`，下一行必须立即写 `defer res.Body.Close()`。需特别注意，在 HTTP/1.x 下若希望将底层 Keep-Alive 长连接归还连接池复用，通常不仅要调用 `Close()`，还需将 `res.Body` **读尽至 `io.EOF`**——不消费响应体内容时（例如仅检查状态码或非 200 错误分支），可在关闭前执行 `io.Copy(io.Discard, res.Body)`（面对可能超大的响应体应配合 `io.LimitReader` 限制排空字节数，超限时直接关闭并重建连接更划算）；虽然标准库 `http.Transport` 关闭时也会在保守上限内异步尝试排空，但响应体未读尽且超出该上限时，底层连接仍会被直接关闭而无法复用。
3. **显式校验 HTTP 状态码**：只要收到合法的 HTTP 响应报文，即便对方返回 `404` 或 `500`，`apiClient.Do` 返回的 `err` 依然是 `nil`。

### 16.2.2 ServeMux 增强路由（Go 1.22+）、超时配置与中间件 {#ch16-2-2}

服务端同样**严禁在生产代码中直接使用全局 `http.HandleFunc` 和零超时的 `http.ListenAndServe`**：前者挂载于包级共享的 `http.DefaultServeMux`，任何第三方依赖都可在 `init` 中偷挂路由；后者未设任何连接超时。生产环境应独立实例化 `http.NewServeMux()` 与配齐超时的 `&http.Server{}`。

自 Go 1.22 起，标准库 `ServeMux` 原生支持**“HTTP 方法 + `{param}` 路径通配符”**，同时提供匹配剩余路径段的 `{path...}` 与精确匹配根路径的 `{$}`，搭配 `r.PathValue` 即可满足常规 REST 路由需求：

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
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

输出 JSON 响应时必须使用 `"encoding/json"` 的 `Encode` 或 `Marshal`，**严禁用 `fmt.Fprintf(w, "{\"id\":%q}", id)` 手动拼接**。`%q` 输出的是 Go 字符串字面量转义而非 JSON 规范转义——例如含控制字符 `U+0007`（`\x07`）的字符串会被编成 Go 专有的 `\a`（合法 JSON 须写作 `\u0007`），生成的文本不是合法 JSON（`json.Valid` 返回 `false`），会直接破坏下游解析。

`http.Server` 四项核心超时字段防护职责对照如下：

| 字段名 | 计时覆盖范围与防护目标 |
| --- | --- |
| `ReadHeaderTimeout` | 建立连接后读完请求头的最长时间，防御慢速头部攻击（Slowloris）的第一道防线 |
| `ReadTimeout` | 从连接被接受到读完完整请求头与请求体的总时间上限 |
| `WriteTimeout` | 从读完请求头到写完响应体的总时间上限；流式长响应可按请求单独放宽 |
| `IdleTimeout` | Keep-Alive 长连接在两笔请求之间空闲等待的最大保持时长 |

除四项超时外，生产服务端通常还需补齐两道防护边界：一是读取请求体前用 `http.MaxBytesReader(w, r.Body, limit)` 限制单次负载大小，解码超限时通过 `*http.MaxBytesError`（Go 1.19+）返回 `413 Request Entity Too Large`；二是在进程准备下线时，用带独立超时的上下文调用 `srv.Shutdown(shutdownCtx)` 停止接收新连接并等待在途请求完成，同时在 `ListenAndServe` 返回时识别并忽略正常的 `http.ErrServerClosed`。

编写处理函数时必须遵守 **`http.ResponseWriter` 的写入顺序铁律**：所有 `w.Header().Set(...)` 操作必须在调用 `w.WriteHeader(code)` 或首次调用 `w.Write(...)` **之前**完成。若此前未调 `WriteHeader`，首次调用 `Write` 会自动先发出 `200 OK` 与当前头部，此后修改 `Header()` 或补调 `WriteHeader` 均不生效。

鉴权、耗时统计、防 CSRF 跨域保护——Go 1.25+ 内置 `http.NewCrossOriginProtection`——及异常恢复等横切逻辑，统一编写为 `func(http.Handler) http.Handler` 中间件套合。若外层中间件包装了 `ResponseWriter`，内层需刷流或设单请求写截止时间时，应使用 **`rc := http.NewResponseController(w)`**（Go 1.20+）调用 `rc.Flush()` 或 `rc.SetWriteDeadline(...)`，穿透实现了 `Unwrap() http.ResponseWriter` 的中间件层。

## 16.3 log/slog 结构化日志 {#ch16-3}

自 Go 1.21 起，标准库 `"log/slog"` 提供了带级别、键值对的结构化日志体系；下例导入 `"log/slog"` 与 `"os"`：

```go
logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
	Level: slog.LevelInfo,
}))
slog.SetDefault(logger)

slog.InfoContext(ctx, "order created", "order_id", orderID, "items", count)
```

开发调试时可将 `slog.NewJSONHandler` 换为 `slog.NewTextHandler`；单元测试静默输出可直接传 `slog.DiscardHandler`（Go 1.24+）；一条日志同时分发多个后端可使用 `slog.NewMultiHandler`（Go 1.26+）。日常使用 `slog` 应遵循三条准则：

1. **善用静态检查防错位**：交替书写 `"key", val` 变长参数时，`go vet` 内置的 `slog` 检查器会自动拦截键值奇偶错位或非字符串键名。
2. **热点路径采用强类型 `LogAttrs`**：高频性能敏感路径改调 `logger.LogAttrs(ctx, slog.LevelInfo, "order created", slog.String("order_id", orderID), slog.Int("items", count))` 可消除 `any` 接口装箱，将堆分配降至最低。
3. **底层通用库不擅自打全局日志**：可复用库遇到异常应包装为 `error` 返回给调用方，或通过构造函数接收调用方注入的日志接口，详见[依赖注入](./chapter-08#ch8-5)。

## 练习 {#ch16-exercises}

以下 2 道练习分别覆盖带超时保护、请求体上限与优雅停机的 HTTP 服务构建，以及自定义日期格式的 JSON 编解码实现。代码片段默认位于 `package main`，按需导入 `"context"`、`"encoding/json"`、`"errors"`、`"fmt"`、`"log/slog"`、`"net/http"` 与 `"time"`。建议先独立编写，再展开核对参考答案。

### 练习 1：搭建带超时、请求体上限与优雅停机的 HTTP 服务

实现一个可安全下线的最小 HTTP 服务：

1. 实现中间件 `RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler`，记录每个请求的 HTTP 方法、路径与耗时；
2. 使用 `http.NewServeMux` 注册两条路由：
   - `GET /users/{id}`：返回 JSON `{"user_id": "..."}`；
   - `POST /users`：用 `http.MaxBytesReader` 将请求体上限限制为 `1 << 20`（1 MiB），通过 `json.NewDecoder` 解析 `{"name": "..."}`；若超限则识别 `*http.MaxBytesError` 并返回 `413 Request Entity Too Large`，其他解码失败返回 `400 Bad Request`，合法请求原样编码 JSON 返回 `201 Created`；
3. 组装配齐四项超时字段的 `*http.Server`，并编写 `runServer(ctx context.Context, srv *http.Server, shutdownTimeout time.Duration) error`：后台调用 `srv.ListenAndServe()` 并忽略正常的 `http.ErrServerClosed`；当 `ctx` 取消时，以独立的 `shutdownTimeout` 期限调用 `srv.Shutdown(shutdownCtx)` 停止接收新连接并等待在途请求完成；
4. 说明如何验证大请求体拦截、在途请求优雅排空，以及含控制字符（如 `"\x07"`）的合法 JSON 往返编解码。

<details>
<summary>查看参考答案</summary>

```go
type createUserReq struct {
	Name string `json:"name"`
}

func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			next.ServeHTTP(w, r)
			logger.InfoContext(r.Context(), "http_request",
				"method", r.Method,
				"path", r.URL.Path,
				"duration", time.Since(start).String(),
			)
		})
	}
}

func newServer(addr string, logger *slog.Logger) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		resp := map[string]string{"user_id": r.PathValue("id")}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			logger.ErrorContext(r.Context(), "encode failed", "err", err)
		}
	})
	mux.HandleFunc("POST /users", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 限制请求体最大 1 MiB
		var req createUserReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusCreated)
		if err := json.NewEncoder(w).Encode(req); err != nil {
			logger.ErrorContext(r.Context(), "encode failed", "err", err)
		}
	})

	return &http.Server{
		Addr:              addr,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		Handler:           RequestLogger(logger)(mux),
	}
}

func runServer(ctx context.Context, srv *http.Server, shutdownTimeout time.Duration) error {
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return <-errCh
}
```

关键要点与验证提示：

1. **请求体上限与状态码**：`http.MaxBytesReader` 包装 `r.Body` 后，一旦 `json.NewDecoder` 读取超过 1 MiB 会立刻中止并返回 `*http.MaxBytesError`（Go 1.19+），通过 `errors.As` 精确区分超限（`413 Request Entity Too Large`）与语法错误（`400 Bad Request`）；响应头 `w.Header().Set` 仍须严格置于 `WriteHeader` 与 `Encode` 之前。
2. **优雅停机与独立期限**：触发停机时父级 `ctx`（例如 `signal.NotifyContext` 返回的信号上下文）已被取消，因此须基于 `context.WithoutCancel(ctx)`（Go 1.21+）或 `context.Background()` 派生带独立 `shutdownTimeout` 的 `shutdownCtx` 传给 `srv.Shutdown`。`Shutdown` 会立即关闭监听停止接收新连接并等待在途请求完成；此时 `ListenAndServe` 返回 `http.ErrServerClosed` 属正常关闭，须用 `errors.Is` 识别忽略，其他监听错误（如端口占用）则经缓冲通道 `errCh` 原样返回。
3. **测试与控制字符 JSON 往返验证**：测试中将 `*slog.Logger` 替换为 `slog.DiscardHandler`（Go 1.24+）或内存缓冲区即可断言。除校验超过 1 MiB 请求返回 `413`、取消 `ctx` 后 `runServer` 返回 `nil` 外，建议专门向 `POST /users` 发送含控制字符 `"\x07"` 的报文（先用 `json.Marshal(createUserReq{Name: "alice\x07"})` 生成含 `\u0007` 转义的合法负载），断言响应满足 `json.Valid(body) == true` 且反序列化后的 `Name` 与 `"alice\x07"` 完全一致——这能直接拦截误用 `fmt.Fprintf(..., %q)` 产出非法 `\a` 转义的回归缺陷。

</details>

### 练习 2：实现按 YYYY-MM-DD 格式编解码的自定义 JSON 日期类型

定义内嵌 `time.Time` 的类型 `DateOnly`，为其实现 `json.Marshaler` 与 `json.Unmarshaler` 接口，使其按 `time.DateOnly`（`"2006-01-02"`）格式序列化与反序列化，正确兼容 JSON `null` 与字符串转义，并可在外层结构体字段上配合 `omitzero` 省略零值日期。

<details>
<summary>查看参考答案</summary>

```go
type DateOnly struct{ time.Time }

func (d DateOnly) MarshalJSON() ([]byte, error) {
	if d.IsZero() {
		return []byte("null"), nil
	}
	return []byte(`"` + d.Format(time.DateOnly) + `"`), nil
}

func (d *DateOnly) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	var raw string
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	t, err := time.Parse(time.DateOnly, raw)
	if err != nil {
		return err
	}
	*d = DateOnly{Time: t}
	return nil
}

type Profile struct {
	Name     string   `json:"name"`
	Birthday DateOnly `json:"birthday,omitzero"`
}
```

`MarshalJSON` 采用值接收者，无论序列化 `Profile` 值还是 `*Profile` 指针都能生效；由于 `DateOnly` 内嵌了 `time.Time`，自动提升了 `IsZero() bool` 方法，标注 `omitzero`（Go 1.24+）时零值 `DateOnly{}` 会被直接省略。

</details>

## 面试题 {#ch16-interview}

以下 3 道面试题分别考察 JSON 切片与零值标签差异、`net/http` 默认全局函数风险以及 `ResponseWriter` 写入顺序约束。代码约定同[练习部分](#ch16-exercises)，建议先独立作答再展开核对。

### 面试题 1：对下面结构体执行 `json.Marshal` 会输出什么？`omitempty` 与 `omitzero` 有何区别？

```go
type Event struct {
	NilTags   []string  `json:"nil_tags"`
	EmptyTags []string  `json:"empty_tags"`
	At        time.Time `json:"at,omitempty"`
	When      time.Time `json:"when,omitzero"`
}

data, _ := json.Marshal(Event{EmptyTags: []string{}})
fmt.Println(string(data))
```

<details>
<summary>查看参考答案</summary>

输出 `{"nil_tags":null,"empty_tags":[],"at":"0001-01-01T00:00:00Z"}`。

1. 无省略标签时，`"encoding/json"` 将零值 `nil` 切片编码为 `null`，将长度为 `0` 的非 `nil` 空切片 `[]string{}` 编码为 `[]`。
2. `omitempty` 不会将结构体零值视为空值，因此零值 `time.Time{}` 仍输出 `"0001-01-01T00:00:00Z"`。
3. `omitzero`（Go 1.24+）按类型零值及 `IsZero() bool` 方法判断，`time.Time{}.IsZero()` 为 `true`，故 `"when"` 字段被省略。反之若给 `EmptyTags` 贴标签，`omitempty` 会省略 `[]string{}`，而 `omitzero` 因切片非 `nil` 会保留输出 `[]`。

</details>

### 面试题 2：生产环境中直接调用 `http.Get` 和 `http.ListenAndServe` 分别有哪些隐患？

<details>
<summary>查看参考答案</summary>

1. **`http.Get` 的隐患**：底层使用 `Timeout: 0` 的 `http.DefaultClient`，既无超时兜底也无法传入 `context.Context` 联动取消，下游挂死会耗尽本服务协程与连接资源。生产中应复用显式配置 `Timeout` 的 `*http.Client` 并搭配 `http.NewRequestWithContext`。
2. **`http.ListenAndServe` 与 `http.HandleFunc` 的隐患**：一方面内部创建的 `http.Server` 读写与空闲超时全为 `0`，易被慢速连接耗尽文件描述符；另一方面 `http.DefaultServeMux` 是包级全局变量，第三方依赖若在 `init` 中注册调试路由会直接暴露在公网端口上。生产中应独立创建 `http.NewServeMux()` 与配齐四项超时的 `&http.Server{}`。

</details>

### 面试题 3：`http.ResponseWriter` 设置响应头、状态码与写正文有什么顺序要求？中间件包装后内层如何安全刷流？

<details>
<summary>查看参考答案</summary>

所有 `w.Header().Set(...)` 调用必须在 `w.WriteHeader(statusCode)` 或第一次 `w.Write(body)` **之前**完成。一旦调用 `WriteHeader` 或首次调用 `Write`——未调过 `WriteHeader` 时会自动先发出 `200 OK` 及当时的响应头——HTTP 头部就已经写入底层连接，此后修改 `Header()` 或再次调用 `WriteHeader` 均无效。

当外层中间件用自定义结构体包装了 `ResponseWriter` 时，直接类型断言 `w.(http.Flusher)` 会失败；应让中间件包装器实现 `Unwrap() http.ResponseWriter`，并在内层通过 `http.NewResponseController(w).Flush()`（Go 1.20+）穿透调用。

</details>

## 参考资料

- [Go 标准库 `encoding/json`：结构体标签（含 `omitzero`）与流式编解码](https://pkg.go.dev/encoding/json)
- [Go 标准库 `encoding/json/v2`：新一代 JSON 语义处理（Go 1.27+）](https://pkg.go.dev/encoding/json/v2)
- [Go 标准库 `net/http`：客户端、`ServeMux` 路由与 `ResponseController`](https://pkg.go.dev/net/http)
- [Go 1.22 发布说明：`net/http.ServeMux` 增强路由模式](https://go.dev/doc/go1.22#enhanced_routing_patterns)
- [Go 官方博客：Structured Logging with `slog`](https://go.dev/blog/slog)
- [Go 标准库 `log/slog`：`JSONHandler`、`DiscardHandler` 与 `MultiHandler`](https://pkg.go.dev/log/slog)
