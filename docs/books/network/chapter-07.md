---
title: 第 7 章 HTTPS、PKI 信任体系与 TLS 1.3 现代安全演进
description: 对齐 RFC 8446（TLS 1.3）、RFC 10024（后量子混合密钥交换）与 2025–2026 PKI 生态变迁，系统梳理密码学基石、证书链验签、TLS 握手演进、0-RTT 安全边界及 OCSP 退场后的 HTTPS 优化。
---

# 第 7 章 HTTPS、PKI 信任体系与 TLS 1.3 现代安全演进

## 本章要点

明文 HTTP 暴露在公网上面临**窃听、篡改、冒充**三大致命威胁，而 HTTPS 通过在传输层（TCP 或 QUIC）与应用层之间引入 **TLS（Transport Layer Security）** 安全层，一次性解决了机密性、完整性与身份认证问题。原书《图解网络》将 HTTPS 拆散在 3.1、3.3、3.4、3.5 与 4.15 节中，不仅大段重复证书链与握手流程，且以早已废除的 **TLS 1.2 RSA 密钥交换**作为主线，还遗留了“私钥加密=数字签名”“客户端联网向 CA 请求中间证书”“TLS 记录层包含压缩与 MAC”“混淆 1-RTT/0-RTT 重放风险”以及推荐已 EOL 的 OpenSSL 1.1.1 和 **Let's Encrypt 2025 已永久关闭的 OCSP** 等多处过时或错误表述。本章全面重构，以 **TLS 1.3（RFC 8446）**、**后量子混合密钥交换 `X25519MLKEM768`（RFC 10024）**、**ECH** 与 **2025–2026 证书吊销新格局**为主线展开。

读完本章后，应能准确辨析对称 AEAD、密钥协商与数字签名的密码学分工，完整复盘 PKI 离线证书链验签与中间人攻防，清晰对比 TLS 1.2 RSA/ECDHE 与 TLS 1.3 1-RTT 握手，精准界定 `psk_dhe_ke` 与 0-RTT Early Data 的安全边界，并掌握 2026 年主流 HTTPS 性能优化方案。

> 核对日期：2026 年 11 月 20 日；核对环境为 RFC 8446（TLS 1.3）、RFC 8470（Early Data）、RFC 8996（弃用 TLS 1.0/1.1）、RFC 10024（X25519MLKEM768）、OpenSSL 3.5 LTS 与 Let's Encrypt 2025 公告。

## 7.1 HTTPS 密码学基石与 PKI 证书链 {#ch7-1}

### 7.1.1 三大威胁与三大现代密码学原语 {#ch7-1-1}

HTTPS 并非单一算法，而是三类密码学原语的精密组合：

| 安全目标 | 防御威胁 | 现代标准原语 | 关键机制与误区纠偏 |
| --- | --- | --- | --- |
| **机密性 + 完整性** | 窃听 + 篡改 | **AEAD 对称加密**（`AES-128/256-GCM`、`ChaCha20-Poly1305`） | 同步完成数据加密与完整性认证（如 GCM 内置 GMAC）；**纠偏原书 3.1 节**：TLS 1.3 已**彻底移除压缩层**（防 CRIME 攻击）与脆弱的 MAC-then-Encrypt CBC 模式（防 POODLE / Lucky 13） |
| **密钥协商** | 中间窃听推导会话密钥 | **临时密钥交换**（`ECDHE`、`X25519MLKEM768`） | 双方在公开信道交换临时公钥即可独立算出相同共享秘密，具备**前向保密（Forward Secrecy）**；DH/ECDHE 是密钥协商算法，不可直接用于加密数据 |
| **身份认证** | 冒充钓鱼服务器 | **数字签名 + PKI 证书链**（`ECDSA`、`Ed25519`、`RSA-PSS`） | **重要勘误（原书 3.1/3.3 节）**：严禁将数字签名笼统说成“私钥加密哈希值、公钥解密”。只有教科书裸 RSA 存在数学可逆表象，现代主流的 **ECDSA、Ed25519 根本不能用于加解密**，规范表述应始终为**“私钥签名（Sign）、公钥验签（Verify）”** |

### 7.1.2 CA 数字证书签发与离线信任链校验 {#ch7-1-2}

仅有公钥还不够——客户端如何确信收到的服务器公钥真的属于 `example.com` 而非中间人伪造？答案是引入权威第三方 **CA（Certificate Authority）** 与多级 **PKI 信任链**：

```text
[离线根 CA (Root CA)] ──签名签发──> [中间 CA (Intermediate CA)] ──签名签发──> [站点叶子证书 (example.com)]
  ▲ 预置在操作系统/浏览器                                                        ▲ 服务端握手时连同中间证书
    本地受信任根证书库                                                             一并下发给客户端
```

1. **签发流程**：站点生成密钥对，将公钥与域名信息（CSR）提交给 CA；CA 完成域名所有权验证（如 ACME HTTP-01/DNS-01 自动化挑战）后，对证书明文内容（域名、公钥、有效期、颁发者等）计算哈希摘要，用 **CA 私钥签名**生成数字证书。
2. **校验流程（纠偏原书 3.1/3.3 节错误）**：
   - 原书称“客户端验证证书链时向 CA 请求中间证书”或类比为“去警察局查真伪”，**这并不准确**。正确部署的服务器必须在 TLS `Certificate` 消息中**主动下发完整证书链（叶子证书 + 中间证书）**；客户端全程使用**操作系统/浏览器内置的本地根证书库离线逐级验签**（用根 CA 公钥验中间证书签名 → 用中间 CA 公钥验叶子证书签名），并核对域名（SAN 扩展）与有效期，**握手验签本身不需要联网访问 CA**（若服务器漏配中间证书，仅部分浏览器会按 AIA 扩展临时补拉，绝大多数 API 客户端和移动端 SDK 会直接校验证书失败）。
   - **三级证书链的意义**：将最高权威的根 CA 私钥彻底物理离线封存，日常签发由中间 CA 承担；即便某个中间 CA 失窃，只需吊销该中间 CA 即可，无需更换全球几十亿台终端里预置的根证书。

### 7.1.3 中间人攻击边界、抓包原理与 mTLS {#ch7-1-3}

“HTTPS 一定绝对安全吗？”——在协议本身无漏洞且配置合规的前提下，公网中间人无法伪造受信任的站点证书。然而现实中存在两种可截获明文的情形：
1. **用户主动忽略浏览器红屏告警**，或攻击者/企业管理员在终端设备中**预装了自签恶意/企业根证书**。这正是 **Fiddler、Charles、mitmproxy** 抓包 HTTPS 的原理：代理工具作为中间人，与目标服务器建立一段 TLS 连接，同时用用户手动信任的代理自签根证书为目标域名动态签发伪造证书，再与浏览器建立另一段 TLS 连接，从而在中间看到全部明文。
2. **防御手段**：普通用户绝不安装不明根证书、绝不忽略证书告警；高安全客户端（如银行 App、零信任微服务）可采用 **Certificate Pinning（证书/公钥固定，注意运维轮换风险）** 或 **mTLS（双向认证）**——不仅客户端验证服务端证书，服务端也强制校验客户端携带的合法数字证书，使未知代理无法冒充客户端接入。

## 7.2 TLS 握手演进：从 TLS 1.2 到 TLS 1.3 与后量子时代 {#ch7-2}

> **历史清理**：SSL 2.0/3.0 与 TLS 1.0/1.1 因存在大量协议漏洞已由 **RFC 8996（2021）** 正式弃用。当前互联网由 **TLS 1.3（RFC 8446）** 主导，少量存量系统兼容 TLS 1.2。

### 7.2.1 为何 TLS 1.2 RSA 密钥交换被淘汰、ECDHE 胜出 {#ch7-2-1}

| 维度 | TLS 1.2 RSA 密钥交换（已废弃） | TLS 1.2 ECDHE 密钥交换 | TLS 1.3（RFC 8446，现行标准） |
| --- | --- | --- | --- |
| **完整握手 RTT** | 2 RTT（4 次消息交互） | 2 RTT（开 False Start 可抢跑至 1 RTT） | **原生 1 RTT**（会话恢复支持 **0-RTT**） |
| **密钥交换机制** | 客户端生成 `pre-master`，用服务端**静态 RSA 公钥**加密发送 | 双方现场生成**临时椭圆曲线密钥对**（如 `x25519`），通过椭圆曲线点乘（d<sub>1</sub>Q<sub>2</sub> = d<sub>2</sub>Q<sub>1</sub>）算出共享秘密，服务端用证书私钥对临时参数签名防篡改 | 客户端在 `ClientHello` 中预测性携带 `key_share` 临时公钥，支持 ECDHE、FFDHE 及**后量子混合 `X25519MLKEM768`** |
| **前向保密（FS）** | **无**！服务端私钥一旦泄露，黑客过去截获的所有历史密文全部被瞬间解密 | **有**！每次握手生成独立临时私钥并立即销毁，长期证书私钥仅用于签名认证，即使日后泄露也无法解密历史流量 | **强制全部套件具备前向保密**（彻底废除静态 RSA 与静态 DH） |
| **密码套件结构** | 杂糅密钥交换、认证、加密、摘要（如 `TLS_RSA_WITH_AES_128_GCM_SHA256`） | 同左（注意：GCM 模式下末尾 `SHA256` 仅用于 PRF 密钥派生与握手摘要，认证由 GCM 内置 GMAC 完成，校准原书 3.3 节） | **极简解耦为 5 套**（如 `TLS_AES_128_GCM_SHA256`），**只指定 AEAD 算法 + HKDF 哈希**，与密钥交换和签名算法完全解耦 |

> **补齐原书 3.4 节悬疑（为何 TLS False Start 仅允许 ECDHE 而不允许 RSA？）**：TLS 1.2 的 False Start 允许客户端在收到服务端 `Finished` 确认前抢跑发送加密 HTTP 数据以省 1 RTT。依据 **RFC 7918**，若在未完成握手完整性校验前就抢跑，攻击者可能实施降级或弱密钥攻击窃取抢跑数据，因此 RFC 7918 强制要求必须配合具备前向安全的密钥交换（ECDHE/DHE）与强对称加密（AEAD）。而在原生 1-RTT 的 TLS 1.3 中，False Start 补丁已被彻底淘汰。

### 7.2.2 TLS 1.3 1-RTT 完整握手流程 {#ch7-2-2}

```text
客户端                                                              服务端
  │ ── 1. ClientHello (支持版本/套件 + supported_groups + key_share 预测公钥) ──> │
  │                                                                                │ 计算共享秘密，HKDF 派生握手密钥
  │ <── 2. ServerHello (选定套件 + 服务端 key_share)                                │
  │        + {EncryptedExtensions} + {Certificate} + {CertificateVerify}           │ ({...} 表示已用握手密钥加密!)
  │        + {Finished} [+ 0.5-RTT 服务端数据] ──────────────────────────────────── │
  │ 验签证书链 & 校验 Finished，派生应用流量密钥                                      │
  │ ── 3. {Finished} + [加密 HTTP 应用请求] ──────────────────────────────────────> │ (仅 1 RTT 即可发送业务数据!)
  │ <── 4. [加密 HTTP 应用响应] + {NewSessionTicket} ────────────────────────────── │
```

TLS 1.3 相比 TLS 1.2 的四大安全与速度飞跃：
1. **首包预测 `key_share` 砍半握手 RTT**：客户端不再傻等服务端选算法，而是直接在 `ClientHello` 里附上 1–2 个最常用密钥交换组的临时公钥（纠正原书 3.5 节误称“带上全部支持曲线的公钥”）；服务端 99% 概率直接命中并一步回复完整握手消息（极少数未命中时回复 `HelloRetryRequest` 退回 2 RTT）。
2. **证书与扩展全部加密**：从 `ServerHello` 之后的所有握手消息（包括服务器证书）均用握手流量密钥加密，有效防止明文暴露站点证书身份。
3. **强制 AEAD + 精简安全原语**：全面废除 RSA 密钥交换、CBC 模式、RC4、SHA-1、MD5、压缩层与不安全的重新协商，从协议根部掐断降级攻击面。
4. **密钥派生严谨分层**：无论 TLS 1.2 的 PRF 还是 TLS 1.3 的 **HKDF**，密钥交换算出的原始共享秘密（Pre-Master / ECDHE 共享点）**都不是直接用于加密数据的对称密钥**（纠正原书 3.3/3.5 节混用表述），必须结合握手上下文与随机数经过密码学密钥派生函数（KDF）才能分别产出客户端写密钥、服务端写密钥与 IV。

### 7.2.3 2025–2026 前沿安全演进：后量子密钥交换与 ECH {#ch7-2-3}

1. **后量子混合密钥交换（`X25519MLKEM768`，RFC 10024）**：面对未来量子计算机对经典椭圆曲线的“先截获、后解密（Harvest Now, Decrypt Later）”威胁，NIST 已于 2024 年正式发布后量子密钥封装标准 **ML-KEM（FIPS 203）**。自 2024 年底至 2026 年，Chrome（131+）、Firefox（132+）、OpenSSL 3.5 与 Cloudflare 等头部基础设施已将经典 `X25519` 与后量子 `ML-KEM-768` 结合的混合群组 **`X25519MLKEM768`** 设为 TLS 1.3 默认首选 `key_share`，只需多携带约 1.2 KB 公钥即可兼顾经典安全与抗量子安全。
2. **ECH（Encrypted Client Hello）**：传统 TLS 1.3 虽然加密了证书，但 `ClientHello` 中的 **SNI（Server Name Indication）** 字段依然明文暴露了用户正在访问的域名。**ECH** 通过预先从 DNS `HTTPS` 记录（见[第 2 章 DNS `HTTPS/SVCB`](./chapter-02#ch2-3-1)）获取服务端公钥，将真实 `ClientHello`（含真实 SNI）加密封入外层公开 `ClientHello` 之中，补齐了 HTTPS 隐私保护的最后一块明文拼图。

## 7.3 会话恢复、0-RTT 边界与现代 HTTPS 优化 {#ch7-3}

### 7.3.1 会话恢复演进与 0-RTT 重放风险（纠正原书 3.5 节混淆） {#ch7-3-1}

为避免每次重连都重复完整握手与证书验签，TLS 提供会话恢复机制：

| 机制 | 所属版本 | 握手 RTT | 前向保密 | 重放攻击风险 | 工程要点 |
| --- | --- | --- | --- | --- | --- |
| **Session ID** | TLS 1.2 | 1 RTT | 依赖票据轮换与主密钥周期 | 无 0-RTT 应用重放 | 状态存服务端内存，多机负载均衡需共享缓存（如 Redis），命中率低 |
| **Session Ticket** | TLS 1.2 | 1 RTT | 同上 | 无 0-RTT 应用重放 | 状态加密后交客户端保存，无服务端内存压力，集群须安全同步并**高频轮换** Ticket 加密密钥 |
| **TLS 1.3 PSK + ECDHE（`psk_dhe_ke`，默认）** | TLS 1.3 | **1 RTT** | **完全具备** | **无** | 结合预共享密钥（NewSessionTicket）与**全新的临时 ECDHE 交换**，既省去证书传输与验签，又保证完全前向安全 |
| **TLS 1.3 0-RTT Early Data** | TLS 1.3 | **0 RTT** | **首包数据无** | **存在重放攻击风险！** | 客户端在首个 `ClientHello` 中直接附带加密的 HTTP 请求数据 |

> **关键勘误**：原书 3.5 节将 Session ID、Session Ticket 与 TLS 1.3 PSK 一概打上“无前向安全、均存在重放攻击风险”的标签，并举例称攻击者可截获 Session ID/Ticket 重放 POST 请求。**这混淆了 1-RTT 恢复与 0-RTT Early Data**——TLS 1.2 的 1-RTT 恢复以及 TLS 1.3 默认的 `psk_dhe_ke` 1-RTT 恢复都需要交互新鲜随机数完成双向握手后才发送应用数据，应用层请求本身不可被简单重放；**真正存在重放风险与首包前向安全缺失的仅仅是 TLS 1.3 的 0-RTT Early Data**！
>
> **0-RTT 工程防护规范（RFC 8470）**：① 仅对严格**幂等且无副作用的只读请求（如 `GET`/`HEAD`）**开放 0-RTT，严禁用于支付、下单、修改密码等 `POST` 操作；② 反向代理将 0-RTT 请求转发给后端时必须注入 `Early-Data: 1` 头，若后端拒绝接受 0-RTT 可返回 **`425 Too Early`** 让客户端待握手完成后重试；③ 缩短 Ticket 有效期并部署服务端时间窗去重表。

### 7.3.2 证书吊销格局剧变：Let's Encrypt 停用 OCSP 与新体系 {#ch7-3-2}

证书在到期前若私钥泄露需要吊销，原书 3.5 节仍将 **OCSP + OCSP Stapling** 奉为标准最佳实践。然而在 2025–2026 年，Web PKI 吊销体系发生了历史性变革：
1. **在线 OCSP 的落幕**：客户端实时向 CA 发起 OCSP 查询不仅引入额外 DNS/TCP 延迟，更把用户的完整浏览历史实时暴露给了 CA（严重隐私泄露），且维持全球高并发 OCSP 基础设施成本极高。
2. **Let's Encrypt 2025 正式停用 OCSP**：作为全球签发量最大的 CA，Let's Encrypt 已于 **2025 年 5 月 7 日起停止在新证书中写入 OCSP URL，并于 2025 年 8 月 6 日永久关闭了全部 OCSP 服务器**！这意味着对海量使用 Let's Encrypt 证书的站点而言，OCSP Stapling 已不再适用。
3. **2026 现代吊销与信任体系**：行业正全面转向 **CRL（配合浏览器离线压缩推送：Chrome CRLSets / Firefox CRLite）** + **短期证书（Short-lived Certificates，如 6 天甚至 47 天有效期自动化 ACME 续签，大幅缩小泄露窗口）** + **CT（Certificate Transparency，RFC 9162 证书透明度公开审计日志）**。

### 7.3.3 2026 HTTPS 端到端优化清单 {#ch7-3-3}

1. **协议与连接层**：全面启用 **TLS 1.3** 与 **HTTP/3（QUIC）**，直接将传输+加密握手收敛至 1 RTT（取代公网僵化的 TFO + TLS 1.3 组合，见[第 3 章 TFO 现状](./chapter-03#ch3-4)）；优先配置 `X25519MLKEM768` / `x25519` 密钥交换。
2. **证书与算法**：使用体积更小、签名更快的 **ECDSA（P-256）** 证书替代传统 RSA 2048/4096 证书（或双证书部署）；对称加密在支持 **AES-NI** 硬件指令集的 x86/ARM 服务器上优先 `AES-128-GCM`，在无硬件加速的低功耗移动设备上自动协商 `ChaCha20-Poly1305`。
3. **软件栈与内核卸载**：全面升级至受支持的现代密码学库（**OpenSSL 3.x LTS**、BoringSSL 或内存安全的 **rustls**，淘汰已于 2023 年 9 月 EOL 的 OpenSSL 1.1.1）与 **Linux 6.x LTS**；对高吞吐静态文件/视频 HTTPS 分发场景启用 **kTLS（Kernel TLS）**，让加密流量重新享受 `sendfile()` 零拷贝红利（见[第 1 章零拷贝与 kTLS](./chapter-01#ch1-3-3)）。

## 练习 {#ch7-exercises}

本节包含 4 道递进练习，依次覆盖 PKI 证书链与中间人分析、TLS 1.2/1.3 握手差异与前向安全推导、0-RTT 安全边界设计及 2026 HTTPS 调优排查。请先独立推演，再展开参考答案核对。

### 练习 1：分析一次服务器证书链配置缺陷导致的跨端故障

某公司新上线一个 HTTPS API，运维只将 CA 签发的**站点叶子证书**配置到了 Nginx 的 `ssl_certificate` 中，漏拼了**中间 CA 证书**。上线后发现：产品经理用 Chrome 桌面浏览器打开接口能正常访问，但后端 Go/Java 微服务调用方与大量 Android 客户端全部报错 `x509: certificate signed by unknown authority`。

1. 解释为何桌面浏览器能访问，而后端服务与移动端 SDK 却全部验签失败？
2. 正确的服务端修复做法是什么？是否需要把根 CA 证书也拼入 `ssl_certificate`？

<details>
<summary>查看参考答案</summary>

1. **跨端表现差异根因**：
   - 客户端本地根证书库只预置了**根 CA**，没有预置成百上千的中间 CA。服务器漏发中间证书导致信任链断裂；
   - 部分桌面浏览器实现了 **AIA（Authority Information Access）补拉机制**，在证书链不全时会根据叶子证书中的 URL 额外联网下载缺失的中间证书（既拖慢首次握手，也不被所有环境支持）；而 Go/Java 标准库、curl 与多数移动 SDK 出于安全与性能考虑**不执行 AIA 联网补拉**，直接判定证书不可信。
2. **修复做法**：将**站点叶子证书 + 中间 CA 证书**按自底向上顺序拼接为一个完整的 `fullchain.pem` 配置给 `ssl_certificate`。**不需要也不应该拼接根 CA 证书**——根 CA 必须已内置在客户端本地信任库中，服务端下发根证书既不会被客户端信任，还白白增加握手报文体积。

</details>

### 练习 2：为什么 TLS 1.3 废除了 RSA 密钥交换，却依然允许使用 RSA 证书？

不少开发者看到“TLS 1.3 废除了 RSA”，便误以为自己的 RSA-2048 SSL 证书在 TLS 1.3 下无法使用。请准确区分 RSA 在 TLS 1.2 中承担的两种截然不同的角色，并解释为何其中一种必须废除、另一种仍可保留。

<details>
<summary>查看参考答案</summary>

- **两种截然不同的角色**：
  1. **RSA 密钥交换（已废除）**：客户端用证书里的静态 RSA 公钥加密 `pre-master` 发送。由于长期静态私钥直接参与保护会话密钥，一旦该私钥未来泄露，攻击者可以把多年前截获的全部密文一次性解密，**彻底丧失前向保密（Forward Secrecy）**，因此被 TLS 1.3 彻底禁止。
  2. **RSA 数字签名（仍保留，推荐使用 RSA-PSS）**：在 TLS 1.3 中，会话密钥改由每次握手临时生成的 **ECDHE / X25519MLKEM768** 协商产生；服务端证书里的 RSA 私钥**仅用于对本次握手摘要进行数字签名（`CertificateVerify`）**以证明服务器身份，绝不参与加密会话密钥。即使证书 RSA 私钥未来泄露，历史会话的临时私钥早已销毁，历史流量依然无法被解密。

</details>

### 练习 3：评估某电商网关开启 TLS 1.3 0-RTT 的安全风险与防护方案

某电商平台为了将移动端首屏延迟再压低 1 RTT，打算在接入层 Nginx 上全局开启 `ssl_early_data on;`（TLS 1.3 0-RTT），并直接放行全部 HTTP 请求到后端订单、支付与商品详情服务。

请指出该全局开启方案存在的致命安全漏洞，并给出符合 RFC 8470 的工程落地改造方案。

<details>
<summary>查看参考答案</summary>

- **致命漏洞（重放攻击）**：TLS 1.3 0-RTT Early Data 在客户端首个 `ClientHello` 中即附带加密业务请求，服务端无法在收到请求前混入新鲜随机数。攻击者截获该 UDP/TCP 首包后，可在 Ticket 有效期内反复向网关重发同一加密字节流——如果放行了非幂等的 `POST /api/order/create` 或 `POST /api/pay`，就会造成**重复下单或重复扣款**！
- **符合 RFC 8470 的改造方案**：
  1. **严格按方法与路由白名单放行**：网关层仅对严格只读幂等的 `GET`/`HEAD` 接口（如商品详情、静态资源）放行 0-RTT；
  2. **透传标记与 `425 Too Early` 兜底**：Nginx 转发给上游时添加 `proxy_set_header Early-Data $ssl_early_data;`；对任何携带 `Early-Data: 1` 且属于写操作或敏感路径的请求，网关或后端直接返回 **`425 Too Early`**，指示客户端等待 1-RTT 完整握手结束后安全重发；
  3. **缩短票据寿命与防重放窗**：缩短 `ssl_session_timeout` 并对 0-RTT 票据启用滑动时间窗去重。

</details>

### 练习 4：诊断 2026 年迁移至 Let's Encrypt 证书后的 Nginx 配置告警

某运维团队将站点的商业证书切换为自动化续签的 Let's Encrypt 免费证书后，发现 Nginx 启动时抛出警告：`nginx: [warn] "ssl_stapling" ignored, no OCSP responder URL in the certificate`，且业务排查指南中还要求把 OpenSSL 升级到 `1.1.1`。请结合 2025–2026 行业变迁给出准确的根因解释与配置升级清单。

<details>
<summary>查看参考答案</summary>

1. **告警根因**：Let's Encrypt 已于 **2025 年 5 月起停止在新签发证书中写入 OCSP URL，并于 2025 年 8 月永久关闭 OCSP 服务**，全面转向 CRL + 短期证书体系。因此对 Let's Encrypt 证书继续配置 `ssl_stapling on;` 必然触发无 OCSP URL 警告。
2. **2026 升级清单**：
   - 对使用 Let's Encrypt 证书的站点**移除 `ssl_stapling` 相关指令**，并确保自动化 ACME 续签正常（拥抱短期证书降低泄露风险）；
   - **不要升级到 OpenSSL 1.1.1**（已于 2023 年 9 月停止维护 EOL），应直接升级至受长期支持的 **OpenSSL 3.x LTS（如 3.5，支持 `X25519MLKEM768` 后量子混合密钥交换）** 或 BoringSSL/rustls；
   - 配置 `ssl_protocols TLSv1.3 TLSv1.2;`、优先采用 ECDSA 证书并开启 HTTP/3 与 kTLS（若为高吞吐静态分发场景）。

</details>

## 面试题 {#ch7-interview}

本节精选 5 道高频 HTTPS 与 TLS 1.3 面试题，聚焦密码学辨析、握手机制与最新安全边界；请先独立作答，再展开核对。

### 面试题 1：为什么 HTTPS 不全程使用非对称加密，而要采用“非对称协商/认证 + 对称加密数据”的混合架构？

<details>
<summary>查看参考答案</summary>

**结论**：核心原因是**计算性能相差上百至上千倍**，同时非对称加密通常无法直接高效加密任意长度的流式数据且缺乏前向保密优势。

**关键依据**：
- 对称加密（如配合 AES-NI 硬件指令集的 `AES-GCM`）吞吐可达数 GB/s，每字节开销极低，且原生提供 AEAD 完整性校验；
- 非对称运算（大整数模幂或椭圆曲线点乘）计算极其耗费 CPU，仅适合在握手阶段执行一次性的身份签名验签与临时密钥协商（ECDHE / ML-KEM），随后立刻切入高速对称加密传输海量应用数据。

</details>

### 面试题 2：在 TLS 1.3 完整握手中，客户端为什么能把握手延迟从 TLS 1.2 的 2 RTT 压缩到 1 RTT？

<details>
<summary>查看参考答案</summary>

**结论**：因为 TLS 1.3 让客户端在首包 **`ClientHello` 中直接通过 `key_share` 扩展预测性附带临时公钥**，省去了 TLS 1.2 中“先协商算法再交换公钥”的额外一轮往返。

**关键依据**：
- TLS 1.2 必须先 1 RTT 协商加密套件并拿服务端参数（`ServerKeyExchange`），再第 2 RTT 发 `ClientKeyExchange` 与 `Finished`；
- TLS 1.3 极度精简了密钥交换算法，客户端首包直接押注主流群组（如 `X25519MLKEM768` + `x25519`）并发出公钥；服务端命中后立刻算出共享秘密，在首轮回复中一次性加密发回证书、签名与 `Finished`，客户端验完即可紧跟着发出加密 HTTP 请求（1 RTT）。

</details>

### 面试题 3：“数字签名就是用私钥加密哈希值、用公钥解密哈希值”——这句话准确吗？

<details>
<summary>查看参考答案</summary>

**结论**：**不准确，是常见的概念误区。**规范表述应为**“私钥签名（Sign）、公钥验签（Verify）”**。

**关键依据**：
- 只有教科书版裸 RSA 存在数学公式对称的表象；但在真实工程中，RSA 签名（RSASSA-PSS）与 RSA 加密（RSA-OAEP）的填充规范与安全证明截然不同；
- 更重要的是，现代 TLS 与区块链广泛使用的 **ECDSA、Ed25519** 等主流签名算法**根本不具备加解密功能**，不存在“用私钥加密、用公钥解密”的操作。

</details>

### 面试题 4：Fiddler / Charles 等抓包工具是如何看到 HTTPS 明文的？客户端如何防范此类中间人抓包？

<details>
<summary>查看参考答案</summary>

**结论**：抓包工具通过充当**双段 TLS 中间人代理**并依赖**用户在设备中主动信任其自签根证书**来解密流量；防范核心是拒绝不可信根证书，并在高安全客户端启用 **Certificate Pinning 或 mTLS**。

**关键依据**：
- 抓包工具一方面作为客户端与真实服务器建连，另一方面用已植入系统的自签根证书现场伪造目标站点证书与浏览器建连，从而截取中间明文；
- 若客户端在代码中固定校验预期公钥哈希（Public Key Pinning），即使系统信任了代理根证书也会因公钥不匹配而拒绝连接；若服务端启用 **mTLS（双向认证）**，代理工具因没有客户端私钥同样无法冒充客户端连接真实服务器。

</details>

### 面试题 5：TLS 1.3 的会话恢复都会面临重放攻击和前向安全缺失吗？为什么？

<details>
<summary>查看参考答案</summary>

**结论**：**不是。**只有 **0-RTT Early Data** 存在重放攻击与首包前向安全缺失风险；TLS 1.3 默认的 **1-RTT 会话恢复（`psk_dhe_ke`）既抗重放又完全具备前向保密**。

**关键依据**：
- `psk_dhe_ke` 在使用预共享密钥（Ticket）免除证书验签的同时，仍会在 1 RTT 握手中执行一次**全新的临时 ECDHE 密钥交换**并混入双方新鲜随机数，因此具备完整前向保密且应用数据在握手完成后发送、不可重放；
- 0-RTT Early Data 直接拼在首包 `ClientHello` 中发出，服务端尚未参与随机数协商，故易遭重放，生产中必须限制仅用于幂等只读请求并配合 `Early-Data: 1` / `425 Too Early` 防护。

</details>

## 参考资料

- [RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3](https://datatracker.ietf.org/doc/html/rfc8446)
- [RFC 8470: Using Early Data in HTTP (`Early-Data` / `425 Too Early`)](https://datatracker.ietf.org/doc/html/rfc8470)
- [RFC 8996: Deprecating TLS 1.0 and TLS 1.1](https://datatracker.ietf.org/doc/html/rfc8996)
- [RFC 7918: Transport Layer Security (TLS) False Start](https://datatracker.ietf.org/doc/html/rfc7918)
- [RFC 10024: Hybrid Key Exchange in TLS 1.3 (`X25519MLKEM768`)](https://datatracker.ietf.org/doc/html/rfc10024)
- [Let's Encrypt Official Announcement: Ending OCSP Support in 2025](https://letsencrypt.org/2024/12/05/ending-ocsp/)
- [Cloudflare Blog: Encrypted Client Hello (ECH) & Post-Quantum Cryptography](https://blog.cloudflare.com/announcing-encrypted-client-hello/)
