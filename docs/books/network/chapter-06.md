---
title: 第 6 章 HTTP 语义、缓存机制与 HTTP/1.1 到 HTTP/3 协议演进
description: 对齐 RFC 9110–9114、RFC 9000–9002 与 RFC 9204，系统梳理 HTTP 语义与缓存机制、HTTP/1.1 到 HTTP/2 的二进制分帧与 HPACK 优化，以及基于 QUIC 的 HTTP/3 现代可靠传输。
---

# 第 6 章 HTTP 语义、缓存机制与 HTTP/1.1 到 HTTP/3 协议演进

## 本章要点

HTTP 是当今互联网最核心的应用层协议。原书《图解网络》HTTP 篇（3.1、3.2、3.6、3.7 节）与 TCP 篇（4.17、4.18 节）在 HTTP/1.1 瓶颈、缓存、HTTP/2 特性和 QUIC/HTTP/3 上存在高达三重的内容与配图重复，且成书于 HTTP/3 草案阶段（2022 年 5 月），保留了诸多如今已过时或有误的表述。本章彻底去重重组，全面对齐 **2022–2026 年定稿的 IETF 规范家族（RFC 9110–9114、RFC 9204、RFC 9218、RFC 9000–9002）**：纠正 `ETag` 与 `Last-Modified` 优先级规则、3.2 节误写 `ETag` 请求头、误解 `Accept` `q` 权重、`HTTP/2` Server Push 已被主流浏览器与 Nginx 移除、`QPACK` 静态表条目数（99 项而非 91 项）以及原书 4.18 节错误的 QUIC 连接级流控公式，并补齐 `103 Early Hints`、`zstd`/AVIF/AV1 与 DNS `HTTPS/SVCB` 发现机制。

读完本章后，应能准确把握 HTTP 方法语义、状态码与报文边界规则，完整推演强缓存与协商缓存的判定优先级，剖析 HTTP/2 二进制帧与 HPACK 的得失，并深入阐释 QUIC 与 HTTP/3 如何从传输层根除跨流队头阻塞并实现连接迁移。

> 核对日期：2026 年 11 月 20 日；核对环境为 RFC 9110–9114（HTTP 规范族）、RFC 9000–9002（QUIC）、RFC 9204（QPACK）、RFC 9218（优先级）与现代浏览器/Nginx 1.26+ 实现。

## 6.1 HTTP 核心语义、状态码与报文边界 {#ch6-1}

### 6.1.1 语义与传输解耦及常见状态码 {#ch6-1-1}

2022 年发布的新一代 HTTP 核心标准 **RFC 9110** 将“HTTP 语义（方法、状态码、头字段、内容协商）”与底层传输语法（RFC 9112 HTTP/1.1、RFC 9113 HTTP/2、RFC 9114 HTTP/3）彻底解耦——无论底层跑在文本流、二进制帧还是 UDP/QUIC 上，应用层语义完全统一。

| 类别 | 高频状态码 | 工程要点与现代补齐 |
| --- | --- | --- |
| **`1xx` 信息响应** | `101 Switching Protocols`<br>**`103 Early Hints`（RFC 8297）** | 纠正原书“1xx 很少用”：`101` 用于 HTTP/1.1 升级 WebSocket；**`103 Early Hints`** 允许服务端在主 HTML 尚未生成完前提前发预加载头，现已正式取代被废弃的 HTTP/2 Server Push |
| **`2xx` 成功** | `200 OK`、`204 No Content`、`206 Partial Content` | `206` 配合 `Range` / `Content-Range` 实现断点续传与视频分片拖放 |
| **`3xx` 重定向** | `301`、`302`、`304`、**`307`**、**`308`** | `301`（永久）/ `302`（临时）在历史浏览器实现中常将 `POST` 改为 `GET`；**`307`（临时）与 `308`（永久）**严格规定**禁止改变原请求方法与请求体**；`304 Not Modified` 为协商缓存命中 |
| **`4xx` 客户端错误** | `400`、`401`、`403`、`404`、`405`、`425`、`429` | 区分 `401 Unauthorized`（缺少有效身份凭证，响应应带 `WWW-Authenticate`）与 `403 Forbidden`（服务端拒绝执行请求，既可能因权限不足，也可能与身份无关如 IP 封禁，不能据此断定已登录）；`425 Too Early` 用于拒绝有重放风险的 TLS 1.3 0-RTT 请求；`429 Too Many Requests` 用于限流 |
| **`5xx` 服务端错误** | `500`、`502 Bad Gateway`、`503 Service Unavailable`、`504 Gateway Timeout` | `502` 指网关从上游收到无效响应；`504` 指网关等待上游响应超时 |

### 6.1.2 `GET` vs `POST`：安全、幂等与常见误区 {#ch6-1-2}

按 **RFC 9110 §9.2** 语义定义：
- **安全（Safe）**：请求方法为只读，不会修改服务器上的资源状态；
- **幂等（Idempotent）**：执行一次与连续执行多次对服务器资源产生的**副作用相同**（注意幂等看的是服务端状态结果，而非每次响应体是否一字不差）。

| 方法 | 语义定位 | 安全 | 幂等 | 可缓存 | 工程纠偏说明 |
| --- | --- | --- | --- | --- | --- |
| **`GET`** | 获取指定资源 | 是 | 是 | 是 | ① URL 经 UTF-8 百分号编码可传非 ASCII 字符；② **RFC 9110 §9.3.1** 规定 `GET` 请求体无定义语义，客户端 **SHOULD NOT** 发送 Body（主流浏览器 `fetch` 直接抛错、CDN/代理常丢弃）；③ 切勿用 `GET` 执行删除/修改操作，以免被搜索引擎爬虫或浏览器预取误触发 |
| **`POST`** | 提交数据由目标资源处理（如创建、提交表单） | 否 | 否 | 默认否 | 明文 HTTP 下 `POST` 把数据放 Body **并不比 `GET` 放 URL 更安全**，抓包同样一目了然，防窃听必须靠 HTTPS |
| **`PUT` / `DELETE`** | 全量替换 / 删除资源 | 否 | **是** | 否 | RESTful API 中常借 `PUT`/`DELETE` 表达天然幂等操作 |

### 6.1.3 HTTP/1.1 报文边界、内容协商与现代压缩 {#ch6-1-3}

1. **报文边界判定（防 HTTP 请求走私）**：HTTP/1.1 头部行间以 `\r\n` 分隔，头部与消息体以空行 `\r\n\r\n` 分隔；而**消息体的结束边界**主要有两种机制：
   - 已知长度的静态或固定响应使用 **`Content-Length`**；
   - 流式动态生成响应使用 **`Transfer-Encoding: chunked`**（按“十六进制块大小 `\r\n` 块内容 `\r\n`”分段，以 `0\r\n\r\n` 结束）。
   - **安全红线（RFC 9112 §6.3）**：严禁在同一报文中同时发送 `Content-Length` 与 `Transfer-Encoding`，若前端代理与后端服务器解析优先级不一致，极易触发 **HTTP Request Smuggling（请求走私）**漏洞。
2. **内容协商与现代压缩升级**：
   - **纠正原书 3.2 节对 `q` 的误解**：请求头 `Accept: image/avif, image/webp, image/*;q=0.8` 中的 `q`（Quality Value，0.000–1.000）表示客户端对不同 MIME 格式的**偏好权重**，用于内容协商排序，与有损压缩的画质等级无关。
   - **2026 主流压缩与媒体格式**：文本无损压缩除 `gzip` 与 **Brotli（`br`）**外，现代浏览器（Chrome 123+、Firefox 126+）与 CDN 已原生支持压缩速度更快、压缩率更优的 **`zstd`（RFC 8878）**（`Accept-Encoding: gzip, deflate, br, zstd`）；图片格式由 PNG/JPEG → WebP 进一步演进至 **AVIF**；音视频推荐 **AV1** 与 **Opus**。

## 6.2 HTTP 缓存体系与性能演进取舍 {#ch6-2}

减少延迟最彻底的优化是**根本不发请求**（强缓存）或**只验指纹不传载荷**（协商缓存）。遵循 **RFC 9111**，浏览器本地缓存分为两级：

```text
发起 HTTP 请求
   │
   ├─> 1. 强缓存命中？(检查 Cache-Control / Expires，且未设 no-cache)
   │        ├─ 是 ──> 直接读本地磁盘/内存缓存 (200 from cache)，零网络往返
   │        └─ 否 ──> 2. 发起协商缓存请求 (带上 If-None-Match / If-Modified-Since)
   │                     ├─ 服务端比对未变更 ──> 返回 304 Not Modified (仅响应头，省载荷)
   │                     └─ 服务端比对已变更 ──> 返回 200 OK + 最新资源与新缓存头
```

### 6.2.1 强制缓存核心指令 {#ch6-2-1}

- **`Cache-Control`**（HTTP/1.1+，优先级高于基于绝对时间的旧头 `Expires`，不受客户端时钟偏移影响）常用指令：
  - `max-age=<秒>`：资源有效相对时长；
  - `no-cache`：**不是禁止缓存**，而是允许本地缓存但**每次使用前必须向源站做协商验证**；
  - `no-store`：**彻底禁止**任何客户端与中间代理落盘或内存缓存（用于敏感金融/隐私数据）；
  - `public` / `private`：分别允许 CDN 等共享代理缓存或仅限终端浏览器私有缓存；
  - **`immutable`**（RFC 8246）：声明带内容哈希指纹的静态资源（如 `app.a1b2c3.js`）在 `max-age` 内永不改变，用户点击刷新也不会触发多余的 304 协商；
  - **`stale-while-revalidate=<秒>`**（RFC 5861）：允许在过期后的宽限期内先立即返回旧缓存保证零延迟，同时后台异步回源刷新缓存。
- **`Vary`（内容协商缓存键，RFC 9110 §12.5.5 / RFC 9111 §4.1）**：当同一 URL 依据客户端请求头（如 `Accept-Encoding: br, gzip, zstd`）返回不同的压缩或编码表示时，服务端**必须返回 `Vary: Accept-Encoding`**，指示浏览器与 CDN 将对应请求头纳入缓存键，避免把 `br`/`zstd` 压缩响应错误分发给仅支持 `gzip` 的客户端。需要注意，`Vary` 仅用于区分同一资源的不同缓存表示，**不承担权限控制职责**，含敏感信息的私有响应仍须配合 `Cache-Control: private` 或 `no-store`。

### 6.2.2 协商缓存与优先级纠偏 {#ch6-2-2}

协商缓存有两组配对字段（注意区分**响应头**与**条件请求头**，纠正原书 3.2 节误将请求头写作 `ETag` 的严重笔误）：
1. **时间戳验证**：响应头 `Last-Modified` ↔ 下次请求头 **`If-Modified-Since`**（仅精确到秒，且无法区分“文件重新保存但内容未变”）；
2. **指纹验证**：响应头 `ETag` ↔ 下次请求头 **`If-None-Match`**（基于内容哈希或 inode+mtime+size 生成，精确识别内容变更，支持弱验证 `W/"..."`）。

> **关键规范纠偏**：原书 3.1 节称“如果 `ETag` 没变化，然后再看 `Last-Modified`”，**这违背了 RFC 9110 §13.1.3**。标准明确规定：当客户端同时携带 `If-None-Match` 与 `If-Modified-Since` 时，**服务端必须以 `If-None-Match` 为准并忽略 `If-Modified-Since`**，只要 `ETag` 匹配即可直接返回 `304`，不会再去校验修改时间。

### 6.2.3 从 HTTP/1.1 外部优化到 HTTP/2+ 的反模式转变 {#ch6-2-3}

HTTP/1.1 默认开启持久连接（Keep-Alive），但同一连接上响应必须严格按请求顺序返回（即使开启了早已在主流浏览器中被禁用的 Pipeline 管道化，**响应队头阻塞**依然存在），且浏览器限制单域名最多 **6 条并发 TCP 连接**。因此 HTTP/1.1 时代催生了大量变通技巧：**CSS 雪碧图（Sprites）、图片 Base64 内嵌、打包所有 JS/CSS 成单一大包、域名分片（Domain Sharding）**。

**时代边界提醒**：在 **HTTP/2 与 HTTP/3 多路复用**普及的今天，上述 HTTP/1.1 变通技巧大多变成了**反模式**——域名分片会破坏单连接多路复用与 HPACK/QPACK 字典共享并增加额外 TCP/TLS 握手；把所有资源打成单一巨包或 Base64 内嵌会破坏精细缓存粒度（改一行代码导致整个大包缓存失效）。现代前端应改用按路由/模块细粒度拆分 + 内容哈希 + `Cache-Control: max-age=31536000, immutable`。

## 6.3 HTTP/2 二进制分帧、HPACK 与多路复用 {#ch6-3}

**HTTP/2（RFC 9113，2022 年取代 RFC 7540）** 完全保留 HTTP 语义与 `https://` URI（规范允许明文 `h2c` 常用于内网 gRPC，公网浏览器仅支持基于 TLS + ALPN 协商的 `h2`），但在传输语法层做了脱胎换骨的重构：

### 6.3.1 二进制帧与多路复用 {#ch6-3-1}

HTTP/2 将明文报文拆解为固定 **9 字节帧头** + 载荷的**二进制帧（Frame）**（字段依次为 24 bit `Length`、8 bit `Type`、8 bit `Flags`、1 bit 保留位 `R`、**31 bit `Stream ID`**，最大值为 **2<sup>31</sup> - 1**，纠正原书写作 2<sup>31</sup>）：

- **四层层次模型**：一条 TCP **Connection** 上可并发承载多条双向独立的 **Stream**；每个 **Message**（一次完整请求或响应）由多个 **Frame**（如 `HEADERS` 帧、`DATA` 帧）组成。
- **并发乱序与有序重组**：属于不同 Stream 的帧可以在同一条 TCP 连接上**交错发送**（例如大文件流 1 与小接口流 3 交替穿插，彻底消除 HTTP/1.1 应用层队头阻塞），接收端按帧头中的 `Stream ID` 重组，同一 Stream 内的帧保持严格有序。客户端发起的 Stream ID 为**奇数**，服务端为**偶数**；ID 耗尽时发送 `GOAWAY` 帧优雅切新连接。
- **流优先级规范更新**：原书 3.6 节介绍的 RFC 7540 复杂优先级依赖树与 `PRIORITY` 帧在实际部署中收效甚微且实现混乱，已被 **RFC 9113 正式废弃**，现由 **RFC 9218（可扩展优先级方案）**通过简洁的 `Priority` 头部与 `PRIORITY_UPDATE` 帧统一负责 HTTP/2 与 HTTP/3 的调度。

### 6.3.2 HPACK 头部压缩（RFC 7541） {#ch6-3-2}

HTTP/1.1 每次请求都重复明文发送动辄数百至上千字节的 `User-Agent`、`Cookie` 等头部。HTTP/2 引入专用压缩算法 **HPACK**（注意：**HPACK 只压缩 HTTP 头部，`DATA` 帧载荷仍由 `Content-Encoding` 压缩**，纠正原书 3.6 节称“帧数据存放 HPACK 压缩过的头部和包体”）：
1. **静态表（Static Table）**：预置 61 个最高频头部键值对（索引 1–61）。例如 `:status: 200`（纠正原书误写 `:status: 200 ok`，HTTP/2 已取消原因短语）对应索引 `8`，编码后仅占 **1 字节**（`0x88`）；
2. **动态表（Dynamic Table）**：索引从 62 起，同一连接内首次出现的自定义头部（如 `authorization`、`cookie`）存入双端同步维护的动态表，后续请求仅发索引号。动态表内存由协议流控参数 **`SETTINGS_HEADER_TABLE_SIZE`**（默认 4096 字节）通过 FIFO 自动淘汰约束，绝不会无限增长（纠正原书 3.6 节误称靠已移除的 Nginx `http2_max_requests` 防止无限增大）；
3. **静态霍夫曼编码**：对未命中表的字符串按静态高频码表编码，避开动态字典（如 DEFLATE）在加密流中引发的 CRIME/BREACH 侧信道攻击。

### 6.3.3 HTTP/2 Server Push 的退场与残留痛点 {#ch6-3-3}

- **历史特性退场（重大更新）**：原书 3.1/3.6 节将 **Server Push（服务端主动推送）** 吹捧为 HTTP/2 核心优势并展示 Nginx `http2_push` 配置。实际运营多年后发现，服务端极难准确知道客户端本地缓存是否已有该资源，盲目推送反而浪费带宽、抢占关键资源优先级且缓存管理复杂。**Chrome 106（2022）已彻底移除 HTTP/2 Server Push 支持，Nginx 1.25.1 也已移除 `http2_push` 指令**；现代标准替代方案是 **`103 Early Hints`（RFC 8297）** 配合 `<link rel="preload">`——服务端只发“提示头”，由浏览器结合本地缓存自主决定是否提前拉取。（另注：Server Push 本是资源预推送，从未用于向 JS 推送实时业务通知，业务推送应选[第 8 章 SSE/WebSocket](./chapter-08#ch8-2)。）
- **无法绕开的底层硬伤——TCP 队头阻塞**：HTTP/2 把所有 Stream 都塞进**同一条 TCP 字节流**。一旦底层 TCP 丢失哪怕 1 个数据包，内核协议栈为了保证字节流严格有序，会把后续所有已经抵达的其他 Stream 数据全部扣在乱序队列里等待重传，导致整个连接的全部并发请求集体卡顿！在丢包率超过 2% 的移动弱网下，HTTP/2 的性能甚至可能反不如 6 条并发连接的 HTTP/1.1。

## 6.4 QUIC 与 HTTP/3：基于 UDP 的现代可靠传输 {#ch6-4}

要根除 TCP 的四大固有缺陷——**内核态升级困难与中间盒僵化、TCP+TLS 串行握手高延迟、全连接级队头阻塞、四元组绑定导致网络切换断连**——绕开内核 TCP、在用户态基于 UDP 重塑传输层成为必然选择。**QUIC（RFC 9000–9002，2021 年发布）**与构建其上的 **HTTP/3（RFC 9114，2022 年发布）**已全面落地（全球约三分之一网站及全主流浏览器/CDN 均已生产支持）。

### 6.4.1 QUIC 传输层核心机制（纠偏原书 4.18 节） {#ch6-4-1}

```text
传统栈: HTTP/2 ──> TLS 1.3 (Record层) ──> TCP (单字节流，跨流队头阻塞) ──> IP
现代栈: HTTP/3 ──> QUIC (内置 TLS 1.3 握手消息 + 多独立 Stream + 加密头) ──> UDP ──> IP
```

1. **包编号（Packet Number）与流偏移（Stream Offset）彻底解耦**：
   - 每个 QUIC 包携带**严格单调递增的 Packet Number**（按 Initial、Handshake、Application Data 划分 **3 个独立编号空间**）——即便重传同一份应用数据，也会分配一个全新的、更大的 Packet Number，彻底消除 TCP 重传 RTT 采样歧义，使丢包与 RTT 计算精确无比。
   - 包内承载多个 **Frame**（如 `STREAM` 帧携带 `Stream ID`、`Offset`、`Length`）。**重传包与原始包靠 `Stream ID + Offset` 识别同一份数据**。每个 Stream 拥有独立的有序重组空间，Stream 1 丢包绝不阻塞 Stream 2 的即时交付，彻底消灭**跨流队头阻塞**（注意：单个 Stream 内部仍保持有序，且同一连接内的各条 Stream 仍共享连接级拥塞控制，丢包触发的降速依然会影响其他流吞吐）。
2. **两级流量控制（重点勘误原书 4.18 节）**：
   - QUIC 在 RFC 9000 中使用标准帧 **`MAX_STREAM_DATA`**（单流流控）与 **`MAX_DATA`**（整条连接总流控），受阻时分别发 `STREAM_DATA_BLOCKED` / `DATA_BLOCKED`（原书 4.18 节混用了早期 Google gQUIC 的旧术语 `window_update`/`BlockFrame`）。
   - **纠正原书公式错误**：原书 4.18 节称“Connection 级接收窗口就是各个 Stream 接收窗口大小之和”，**这是错误的**！RFC 9000 §4.1 明确规定连接级上限（`MAX_DATA`）与流级上限（`MAX_STREAM_DATA`）是**两套独立配额**——各 Stream 上限之和通常会**大于**连接总上限（允许单条活跃流突发吃满额度，同时由连接总上限守住整体内存防线），连接可用额度 = `Connection_MAX_DATA - Σ(所有 Stream 已收到的最大偏移)`。
   - **为何传递“绝对最大偏移上限”而非“相对增量”？**（补齐原书 4.18 节作者未解的疑问）：UDP 报文可能乱序到达或重传。如果窗口更新传相对增量（`+100`），乱序或重传会导致窗口重复累加或算错；而传递单调递增的绝对上限值（如 `MAX_STREAM_DATA = 10240`）天然**幂等**，接收方只需简单取 `max(当前值, 收到值)` 即可，乱序与重复完全安全！
3. **内置 TLS 1.3 深度融合（1-RTT / 0-RTT）**：
   - 纠正原书 3.7 节“QUIC 携带 TLS 记录”与 4.18 节“QUIC 需要三次握手”：根据 **RFC 9001**，QUIC **舍弃了 TLS 记录层**，直接将 TLS 1.3 握手消息封装在 QUIC 的 **`CRYPTO` 帧**中，与传输参数（含 Connection ID）合并在 **1 RTT** 内同步完成建连与加密密钥协商（会话恢复支持 **0-RTT**），并且加密了绝大部分传输层头部（含 Packet Number 与 ACK 帧），彻底杜绝中间盒篡改与伪造 RST 攻击。
4. **连接迁移（Connection Migration，RFC 9000 §§7.2、9.5、17.2）**：
   - QUIC 放弃四元组标识连接，改用与网络地址解耦的 **Connection ID（CID）**。按 **RFC 9000 §§7.2、17.2**，QUIC v1 长包头中的 CID 长度允许 **0–20 字节**（仅在首次联系服务器时，客户端选择的 Initial Destination CID 要求至少 **8 字节**）。
   - 当客户端从 Wi-Fi **主动迁移**到 5G 等新本地地址时，依据 **RFC 9000 §9.5**，客户端**不得在多个本地地址复用同一 CID**（防止中间观察者跨网络关联追踪），而应切换使用服务端预先通过 `NEW_CONNECTION_ID` 下发的可用新 CID，并完成 **`PATH_CHALLENGE` / `PATH_RESPONSE` 路径验证**；与之相对，NAT 映射表老化引发的静默重绑定（NAT Rebinding）属于被动地址变化，客户端发包时可能先沿用原 CID 直至服务端察觉并触发路径验证。连接迁移免去了重新 TCP + TLS 握手，显著减少切网断连，但在弱网切换、丢包或新路径尚未完成验证与拥塞窗口重置期间，也不保证应用层绝对零停顿。
5. **可插拔用户态拥塞控制**：随应用程序发布即可升级拥塞控制算法（如 CUBIC、BBRv3），不再受制于操作系统内核更新周期。

### 6.4.2 HTTP/3 帧简化、QPACK 与生产发现机制 {#ch6-4-2}

- **极简帧结构**：由于流复用、流控与安全都已下沉到 QUIC 层，HTTP/3 帧头仅剩 **`Type` 与 `Length`** 两个变长整数，极大降低了协议复杂度。
- **QPACK 头部压缩（RFC 9204）**：HPACK 在 HTTP/2 中要求各流头部严格按序解压缩以同步动态表，若直接搬到乱序到达的 HTTP/3 上会重新引入动态表队头阻塞。**QPACK** 将静态表扩充至 **99 项**（索引 `0–98`，纠正原书 3.7 节基于旧草案写的 91 项），并开辟两条独立的 QUIC 单向控制流（`QPACK Encoder Stream` 与 `QPACK Decoder Stream`）异步同步动态表更新；既支持“等确认再引用”的零阻塞模式，也支持受 `SETTINGS_QPACK_BLOCKED_STREAMS` 约束的投机性引用（仅阻塞引用了未到达字典项的特定流）。
- **平滑发现与回退**：浏览器首次访问时可通过 **DNS `HTTPS/SVCB` 记录（RFC 9460）**直接得知站点支持 `h3`（或通过历史响应头 `Alt-Svc: h3=":443"` 获悉），并采用 Happy Eyeballs 并发尝试 QUIC（UDP 443）与 TCP+TLS，一旦遇到企业防火墙封禁 UDP 443 则毫秒级无感回退 HTTP/2。

## 练习 {#ch6-exercises}

本节包含 4 道递进练习，依次覆盖 HTTP 缓存判定与响应头排错、HTTP/1.1 到 HTTP/3 协议演进对比、QUIC 两级流控与绝对偏移推演及 HTTP 请求走私边界。请先独立推演，再展开参考答案核对。

### 练习 1：判读浏览器在以下三个缓存场景中的真实网络行为

某静态接口的响应头如下（设当前时间为 `T = 0`）：

- **场景 A**：`Cache-Control: max-age=60, no-cache`、`ETag: "v1"`、`Last-Modified: Mon, 01 Jan 2026 00:00:00 GMT`
- **场景 B**：`Cache-Control: max-age=3600, immutable`、`ETag: "v2"`
- **场景 C**：客户端发起了条件请求，同时携带 `If-None-Match: "v3"` 和 `If-Modified-Since: Mon, 01 Jan 2026 00:00:00 GMT`。服务端检查发现资源当前 `ETag` 仍为 `"v3"`，但文件 `mtime` 因重新部署变成了 `Tue, 02 Jan 2026 00:00:00 GMT`。

请分别回答：
1. 场景 A 在 `T = 10 s` 时再次访问，浏览器会直接命中本地强缓存还是发起网络请求？
2. 场景 B 在 `T = 100 s` 时用户按 F5 普通刷新页面，支持 `immutable` 的浏览器行为是什么？
3. 场景 C 服务端按照 RFC 9110 规范应当返回 `304` 还是 `200`？为什么？

<details>
<summary>查看参考答案</summary>

1. **场景 A 发起协商网络请求**：`no-cache` 的语义是“允许本地存缓存，但**每次复用前必须向源站重新验证**”，因此即使在 `max-age=60` 内，浏览器仍会带上 `If-None-Match: "v1"` 和 `If-Modified-Since` 发起协商验证（命中返回 `304`）。
2. **场景 B 不发网络请求，直接使用本地缓存**：`immutable` 告知浏览器该 URL 对应的资源在有效期内永不变更，普通刷新时跳过条件验证，直接返回本地 `200 (from cache)`。
3. **场景 C 返回 `304 Not Modified`**：依据 **RFC 9110 §13.1.3**，只要请求携带了 `If-None-Match`，服务端**必须忽略 `If-Modified-Since`**。由于 `ETag` `"v3"` 匹配，直接判定资源未变并返回 `304`（这也是 `ETag` 解决“重新部署导致 `mtime` 变了但内容没变”痛点的核心意义）。

</details>

### 练习 2：为什么把雪碧图与域名分片照搬到 HTTP/2 / HTTP/3 反而可能变慢？

某前端团队将站点从 HTTP/1.1 全面升级至 HTTP/2 + HTTP/3 后，依然保留了历史上的两项配置：① 把静态资源分散到 `static1`–`static4` 四个子域名；② 将 30 个页面图标拼成一张 500 KB 的大雪碧图。请从底层协议机制分析这两项遗留做法在新协议下的负面影响。

<details>
<summary>查看参考答案</summary>

1. **域名分片（4 个子域名）的负面影响**：
   - HTTP/2 与 HTTP/3 单条连接即可并发上百条 Stream，不再受 HTTP/1.1 单域名 6 连接上限约束；
   - 强行拆分 4 个子域名（除非证书与 IP 完全一致触发连接合并 Coalescing）会导致多余的 DNS 查询、额外的 TCP+TLS/QUIC 握手与独立的慢启动过程，同时割裂了 **HPACK/QPACK 动态头部字典**的共享与统一的流优先级调度。
2. **大雪碧图的负面影响**：
   - 多路复用下请求多个独立小图标几乎没有额外连接与头部开销；
   - 拼成 500 KB 单一大图后，任意 1 个图标微调都会导致整张 500 KB 雪碧图缓存全部失效，且首屏可能被迫下载大量当前页面根本用不到的冗余图标。

</details>

### 练习 3：计算 QUIC 两级流量控制下的实际可发送额度

一条 QUIC 连接当前协商的连接级上限 `MAX_DATA = 1000` 字节，其上并发了 Stream 0 与 Stream 4 两条流，各自的流级上限均为 `MAX_STREAM_DATA = 800` 字节：
- 当前 Stream 0 已累计发送 500 字节；
- 当前 Stream 4 已累计发送 400 字节。

1. 此时发送端还能向 Stream 0 最多再发送多少字节？能否发送 300 字节？
2. 若接收端随后发出的两条更新帧 `MAX_STREAM_DATA(Stream 0, 1200)` 和 `MAX_STREAM_DATA(Stream 0, 1600)` 在 UDP 链路中发生乱序（`1600` 先到、`1200` 后到），发送端应如何处理后到的 `1200`？

<details>
<summary>查看参考答案</summary>

1. **最多只能再发 100 字节，不能发 300 字节**：
   - **单流额度（Stream 0）**：`800 - 500 = 300` 字节；
   - **连接总额度**：`1000 - (500 + 400) = 100` 字节；
   - 发送端必须同时满足两级上限，取较小值 `min(300, 100) = 100` 字节。（这也直观揭示了为何两级上限是独立配额、且单流之和 `800 + 800 = 1600 > 1000` 可超售，原书 4.18 节“连接窗口 = 各流窗口之和”的公式是错误的。）
2. **直接忽略后到的 `1200`（取最大值）**：QUIC 流控帧携带的是单调递增的**绝对最大偏移量**，天然幂等。发送端收到 `1600` 时已将上限更新为 `1600`，后到达的 `1200 < 1600` 直接丢弃即可，不会因 UDP 乱序或重传造成窗口回缩或重复累加。

</details>

### 练习 4：识别并阻断一起 HTTP 请求走私（Request Smuggling）隐患

某 HTTP/1.1 客户端向反向代理发送了如下畸形报文：

```http
POST / HTTP/1.1
Host: example.com
Content-Length: 44
Transfer-Encoding: chunked

0

GET /admin HTTP/1.1
Host: example.com
```

假设前端代理只看 `Content-Length`，而后端源站只看 `Transfer-Encoding`。请推演后端源站解析出几条请求，并说明按 RFC 9112 应如何防御。

<details>
<summary>查看参考答案</summary>

- **攻击推演（CL.TE 走私）**：
  1. 前端代理依据 `Content-Length: 44` 将整段数据作为**1 个 POST 请求**通过与后端复用的长连接转发给源站；
  2. 后端源站依据 `Transfer-Encoding: chunked` 读到 `0\r\n\r\n` 即认为第 1 个 POST 请求已经结束，把紧跟在后面的 `GET /admin HTTP/1.1...` 留在了长连接缓冲区中，将其当成**第 2 个独立请求**（甚至拼到下一个正常用户的请求前缀上），绕过了前端代理对 `/admin` 的访问控制！
- **防御措施**：
  1. 严格遵循 **RFC 9112 §6.3**：代理或服务器收到同时包含 `Content-Length` 与 `Transfer-Encoding` 的请求时，**直接拒绝返回 `400 Bad Request` 并关闭连接**；
  2. 代理与后端上游之间升级使用 **HTTP/2**（明确二进制帧长度，彻底消除文本长度歧义）。

</details>

## 面试题 {#ch6-interview}

本节精选 5 道高频 HTTP 与 QUIC 面试题，聚焦协议演进逻辑与 2026 标准边界；请先独立作答，再展开核对。

### 面试题 1：HTTP/1.1、HTTP/2、HTTP/3 分别解决了什么核心性能瓶颈？为什么说 HTTP/2 依然存在队头阻塞？

<details>
<summary>查看参考答案</summary>

**结论**：HTTP/1.1 引入长连接解决频繁建连；HTTP/2 通过**二进制帧 + 多路复用 + HPACK** 消除了应用层队头阻塞与头部冗余；HTTP/3 基于 **QUIC（UDP）** 彻底根除了 TCP 传输层队头阻塞并实现 1-RTT 建连与连接迁移。

**关键依据（HTTP/2 队头阻塞根源）**：
- HTTP/2 将同一域名下的所有并发 Stream 复用在**同一条 TCP 连接**上；
- TCP 是严格有序的字节流协议，只要底层丢失 1 个数据包，内核协议栈必须把后续已到达的其他 Stream 数据全部扣留在乱序队列中等待重传，导致整个连接的全部并发流同时卡住；
- HTTP/3 改用基于 UDP 的 QUIC，为每条 Stream 维护独立的偏移与重组空间，单流丢包只影响该流自身。

</details>

### 面试题 2：HTTP/2 Server Push 曾经被视为重要特性，为什么如今主流浏览器都把它移除了？现在用什么替代？

<details>
<summary>查看参考答案</summary>

**结论**：因为服务端无法准确感知客户端本地缓存状态，盲目推送经常浪费带宽、挤占关键路径资源且跨代理/缓存语义复杂，**Chrome 106 及 Nginx 1.25.1 已彻底移除**；现代标准替代方案是 **`103 Early Hints`（RFC 8297）**。

**关键依据**：
- 服务端在后端渲染主 HTML 期间，可先发一个极轻量的 `103 Early Hints` 响应（携带 `Link: </app.css>; rel=preload; as=style`）；
- 浏览器收到提示后先检查本地缓存，仅对确实缺失的资源立刻发起并发预加载，既利用了服务端思考时间，又避免了重复推送。

</details>

### 面试题 3：QUIC 基于不可靠的 UDP，它是如何实现可靠传输且消除 TCP 重传 RTT 歧义的？

<details>
<summary>查看参考答案</summary>

**结论**：QUIC 在用户态实现了独立的确认重传、滑动窗口流控与可插拔拥塞控制，并通过**严格单调递增的 Packet Number** 与 **`Stream ID + Offset` 解耦**根除了重传 RTT 歧义。

**关键依据**：
- TCP 重传时沿用相同的 `seq`，发送方收到 ACK 无法区分是对原始包还是重传包的确认；
- QUIC 每次发送（含重传）都分配**全新的、严格递增的 Packet Number**，ACK 明确确认具体 Packet Number，因此 RTT 采样永远精确无歧义；而应用数据的顺序与去重则完全由载荷 `STREAM` 帧里的 `Stream ID` 和 `Offset` 承担。

</details>

### 面试题 4：在移动网络从 Wi-Fi 切换到 5G 时，为什么基于 TCP 的连接会断掉，而 HTTP/3（QUIC）如何实现连接迁移而无需重建连接？

<details>
<summary>查看参考答案</summary>

**结论**：TCP 用**四元组 `{源 IP, 源端口, 目的 IP, 目的端口}`** 标识连接，切网导致客户端 IP 变化即彻底失效；QUIC 改用与网络地址解耦的 **Connection ID（CID）** 标识连接（QUIC v1 长头 CID 允许 **0–20 字节**，仅首次建连客户端所选 Initial DCID 要求至少 **8 字节**），从而支持**连接迁移**。

**关键依据（RFC 9000 §§7.2、9.5、17.2）**：
- **主动迁移与 CID 轮换**：客户端主动切换到新的本地 IP/端口时，**不得在多个本地地址复用同一 CID**（防跨网络跟踪），而应切换使用服务端预先通过 `NEW_CONNECTION_ID` 下发的可用新 CID 发包，并由对端通过 **`PATH_CHALLENGE` / `PATH_RESPONSE`** 完成新路径可达性验证；
- **区分 NAT 静默重绑定与性能边界**：若只是中间 NAT 映射超时引发的被动地址变化（NAT Rebinding），客户端发包时才会暂时沿用原 CID 并触发服务端路径验证；连接迁移省去了重新握手，但在弱网切换、丢包或新路径重置拥塞状态期间，不保证应用层绝对零停顿。

</details>

### 面试题 5：HTTP 响应同时设置了 `ETag` 和 `Last-Modified`，为什么推荐以 `ETag` 为准？两者同时传给服务端时服务端怎么判？

<details>
<summary>查看参考答案</summary>

**结论**：`ETag` 克服了 `Last-Modified` 的秒级精度与时间伪变更局限；按 **RFC 9110 §13.1.3**，请求同时携带 `If-None-Match` 与 `If-Modified-Since` 时，**服务端必须仅依据 `If-None-Match` 判定并忽略 `If-Modified-Since`**。

**关键依据**：
- `Last-Modified` 存在三大缺陷：① 最小粒度仅 1 秒，1 秒内多次修改无法察觉；② 文件重新生成或覆盖但内容未变，`mtime` 变化导致缓存白白失效；③ 分布式多机部署若时间或文件 `mtime` 不一致会导致命中率抖动（需注意多机 `ETag` 也应基于纯文件内容哈希而非本机 inode 生成）。

</details>

## 参考资料

- [RFC 9110: HTTP Semantics](https://datatracker.ietf.org/doc/html/rfc9110)
- [RFC 9111: HTTP Caching](https://datatracker.ietf.org/doc/html/rfc9111)
- [RFC 9112 (HTTP/1.1) / RFC 9113 (HTTP/2) / RFC 9114 (HTTP/3)](https://datatracker.ietf.org/doc/html/rfc9114)
- [RFC 9000 (QUIC Transport) & RFC 9001 (Using TLS to Secure QUIC) & RFC 9002 (Loss Detection)](https://datatracker.ietf.org/doc/html/rfc9000)
- [RFC 9204 (QPACK) & RFC 9218 (Extensible Prioritization Scheme for HTTP)](https://datatracker.ietf.org/doc/html/rfc9204)
- [RFC 8297: An HTTP Status Code for Indicating Hints (`103 Early Hints`)](https://datatracker.ietf.org/doc/html/rfc8297)
- [Chrome Developers: Removing HTTP/2 Server Push from Chrome](https://developer.chrome.com/blog/removing-push/)
