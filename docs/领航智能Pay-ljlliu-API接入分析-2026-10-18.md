# 领航智能Pay（ljlliu.cn）API 接入分析

> 调研日期：2026-10-18
> 背景：Papilot 在线支付（`server/lib/pay.js`，V1 易支付 MD5 协议）拟接入该聚合支付平台。
> 秘钥来源：商户后台「API 接入」页导出的 Base64 串，解码后为 `{"site":"https://www.ljlliu.cn","pid":3,"key":"uJV3***（密钥已脱敏，见 server/data/pay.json）"}`。

## 0. 方法论与可信度说明

官方文档地址 `https://www.ljlliu.cn/user#/api-access/docs` 位于**用户中心 SPA 内，登录后才可见**（未登录访问被路由守卫重定向到登录页，含滑块验证码）。本文档**无法直接读取官方文档原文**，改用三条腿走路：

1. **生产 API 黑盒实测**（2026-10-18 全部亲测，原始响应见附录）：逐参数测绘 `/mapi.php`、`/submit.php`、`/Api/checkOrder` 的校验链与错误信息；
2. **易支付（Epay）V1 协议家族比对**：该平台的端点布局（submit.php / mapi.php）、参数命名（pid / out_trade_no / notify_url…）、错误文案风格均为标准易支付家族特征，Papilot 现有 V1 网关实现（`server/lib/pay.js`）可直接对照；
3. **域名授权后全链路实测**（同日 15:00，商户后台已授权 `pp.xinglintools.top`）：用正确 MD5 签名**真实创建 0.01/10.00 元测试单**（未支付）、`/Api/checkOrder` 查单——签名构造、下单响应、查单响应、鉴权行为全部拿到一手数据。

**标注约定**：标注 `[实测]` 的内容为直接探测验证；标注 `[惯例]` 的内容为易支付家族通行约定、在本平台尚待真实支付确认；标注 `[待确认]` 的为已知缺口。

## 1. 平台识别与 API 基础地址

| 项 | 值 |
|---|---|
| 平台名称 | 领航智能Pay（站点 `<title>` 与 `Api/getSoftwareConfig` 返回一致） |
| 技术栈 | Go 后端（未知路由返回 Go 默认 `404 page not found`）+ nginx 反代 + vue-next-admin v2.0.8 用户中心 |
| **API 基础地址** | `https://www.ljlliu.cn` |

**端点清单** `[实测]`：

| 端点 | 方法 | 用途 | 状态 |
|---|---|---|---|
| `/submit.php` | GET / 表单 POST | 跳转模式下单（浏览器直接跳收银台） | 存在，校验链与 mapi.php 一致，错误以 HTML 状态页呈现（`__STATUS_CFG__` 注入 SPA） |
| `/mapi.php` | GET / POST | API 模式下单（服务端调用，返回 JSON） | 存在，`{"code":201,"data":null,"msg":"..."}` 风格 |
| `/Api/checkOrder` | **仅 GET** | 订单查询（**非经典 `api.php` 路径！**） | 存在，查不到订单时返回 `{"code":201,"data":null,"msg":"订单不存在"}` |
| `/qrcode.php` | GET | 二维码生成服务（`?text=` 缺参时报 `missing text`） | 存在，收银台辅助设施 |
| `/pay/` | — | 收银台路由（无有效订单参数时返回 404 空页） | 存在 |

**响应统一格式** `[实测·已修正]`：公开 API（getSoftwareConfig 等）走 `{"code":200|201}` 体系；**但商户兼容端点各有体系**——`/mapi.php` 下单成功是经典 V1 的 `code=1`，`/Api/checkOrder` 查单成功是 `code=0`（业务错 201「订单不存在」/ 鉴权失败 401）。**不要假设全站统一成功码**，各端点见 §5。

**其它实测特征**：

- CORS 未开放（OPTIONS 预检 204 且不带 `Access-Control-Allow-Origin`）→ **mapi.php 只能服务端调用**，浏览器端 AJAX 会跨域失败。这是正确的设计，密钥本就不该下发浏览器。
- 每次请求种 `ls_cid` Cookie（HttpOnly / Secure / SameSite=Lax），用于会话关联。
- 安全响应头齐全：HSTS、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`。

## 2. 鉴权方式（如何使用那串秘钥）

秘钥本体是 Base64 包装的 JSON：`{"site":"https://www.ljlliu.cn","pid":3,"key":"…"}`。三个字段用途 `[实测+惯例]`：

| 字段 | 用途 |
|---|---|
| `site` | 网关地址（Papilot 网关配置的 `gateway` 字段，末尾不带 `/`） |
| `pid` | 商户 ID（3）——所有下单 / 查单请求的必填参数 |
| `key` | 商户密钥（16 位）——**只用于签名计算，不作为参数明文传输**（V1 家族惯例；`/Api/checkOrder` 实测传不传 `key` 参数响应一致） |

身份验证的载体是 **MD5 参数签名**：请求方用 key 计算 `sign` 随请求携带，平台用同一 key 复算比对 `[惯例]`。此外该平台叠加了一层**按商户的发起域名白名单**（见 §7.1），这层在签名校验之前。

## 3. 必填请求参数（实测校验链）

`/mapi.php` 与 `/submit.php` 共用同一套校验 `[实测]`，缺参报错顺序如下（每条都是原始错误文案）：

| 顺序 | 参数 | 缺省报错 | 说明 |
|---|---|---|---|
| 1 | `pid` | `PID不可为空!` | 商户号 |
| 2 | `out_trade_no` | `订单号不可为空!` | 商户订单号；家族惯例为**纯字母数字**（Papilot 内部 `o-xxx` 带连字符号会被拒，`newTradeNo()` 已处理） |
| 3 | `type` | `支付类型不可为空!` | 支付通道；家族通行值 `alipay` / `wxpay`（`qqpay`/`bank` 等 `[待确认]`） |
| 4 | `money` | `金额不可为空!` | 金额，两位小数字符串 |
| 5 | `name` | `商品名称不可为空!` | 商品名 |
| 6 | `notify_url` | `异步通知不可为空!` | **必须含协议头**：传 `example.com/n`（无 `http(s)://`）报 `异步通知地址域名无效`；其域名即域名白名单判定对象 |
| 7 | — | `该域名不可发起支付，原因：域名没过白，请前往平台授权域名` | 域名白名单总闸门（§7.1） |
| 8 | （`sign`） | 签名校验 `[待确认]`（被域名闸门挡住无法实测） | — |

**`return_url`（同步跳转地址）为可选** `[实测]`：缺省时校验直接跳过它走到域名检查，无任何报错。这与部分易支付实现强制要求 return_url 不同。

`sign` / `sign_type` 两个参数随请求携带（见下节）。

## 4. 签名与验签规则 `[实测·全链路验证]`

易支付 V1 家族标准 MD5 签名（与 Papilot `server/lib/pay.js` 的 `buildSign()` 完全一致）：

```
待签名串 = 所有非空参数（剔除 sign、sign_type 本身）
           按键名 ASCII 升序排列
           以 k=v 形式用 & 连接
sign     = md5(待签名串 + 商户密钥)        // 密钥直接拼接，无分隔符
sign_type = "MD5"
```

以本次凭证为例（key 以 `KEY` 代指）：

```
参数: money=10.00, name=Papilot会员, notify_url=https://pp.xinglintools.top/api/pay/notify,
      out_trade_no=PPKY2M1A3B7F1C9, pid=3, return_url=https://pp.xinglintools.top/api/pay/return, type=alipay

待签名串 = "money=10.00&name=Papilot会员&notify_url=https://pp.xinglintools.top/api/pay/notify&out_trade_no=PPKY2M1A3B7F1C9&pid=3&return_url=https://pp.xinglintools.top/api/pay/return&type=alipay"
sign     = md5(待签名串 + KEY)
```

> ✅ **2026-10-18 15:00 已实测关闭本项**：用上述构造（密钥直接拼接、剔除 sign/sign_type 与空值、ASCII 升序）对 `/mapi.php` 下单——订单创建成功并返回收银台 URL；同一签名方式对 `/Api/checkOrder` 查单亦通过（401 对照组验证了签名确被校验）。**Papilot `buildSign()` 无需任何修改。**
> 无签名下单的报错原文：`{"code":201,"msg":"验签失败,请检查PID或Key是否正确!"}`。

验签（回调侧）规则同构：取出回传参数中的 `sign`，用剩余非空参数复算 MD5 比对（大小写不敏感）。**注意陷阱**：`notify_url` 参与签名时必须与下单时完全一致（含协议、路径大小写），回调验签时若漏掉任何非空参数（如 `trade_no`）会验签失败——验签应基于回调实际收到的参数集复算，而不是下单时的参数集。

## 5. 接口调用示例

### 5.1 下单 —— 跳转模式（`/submit.php`，浏览器场景）

拼好带签名的 URL 后让浏览器直接跳转（Papilot `createPayUrl()` 现行做法）：

```
https://www.ljlliu.cn/submit.php?pid=3&type=alipay&out_trade_no=PPKY2M1A3B7F1C9&notify_url=<URL编码后>&return_url=<URL编码后>&name=Papilot会员&money=10.00&sign=<md5>&sign_type=MD5
```

Node.js 生成示例（与 `server/lib/pay.js` 同构）：

```js
const crypto = require('crypto');

function buildSignStr(params) {           // 非空参数、剔除 sign/sign_type、ASCII 升序、k=v 以 & 连接
  return Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined)
    .sort()
    .map(k => k + '=' + params[k])
    .join('&');
}
function buildSign(params, key) {
  return crypto.createHash('md5').update(buildSignStr(params) + String(key), 'utf8').digest('hex');
}

const params = {
  pid: '3',
  type: 'alipay',                                   // 或 'wxpay'
  out_trade_no: 'PPKY2M1A3B7F1C9',                  // 纯字母数字，商户侧唯一
  notify_url: 'https://pp.xinglintools.top/api/pay/notify',   // 域名须已在平台过白
  return_url: 'https://pp.xinglintools.top/api/pay/return',
  name: 'Papilot会员',
  money: '10.00',
};
const sign = buildSign(params, CFG_KEY);
const url = 'https://www.ljlliu.cn/submit.php?'
  + Object.entries({ ...params, sign, sign_type: 'MD5' })
      .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
```

### 5.2 下单 —— API 模式（`/mapi.php`，服务端场景）`[实测·成功响应已拿到]`

参数校验与 submit.php 完全一致；**成功响应为经典易支付 V1 平铺结构（无 data 包裹），`code=1` 成功**（2026-10-18 真实下单实测）：

```json
{
  "code": 1,
  "msg": "获取成功!",
  "trade_no": "LH2026101814571576946",
  "out_trade_no": "PPDOC1792306634548",
  "type": "alipay",
  "money": "0.01",
  "payurl": "https://www.ljlliu.cn/Pay/console?trade_no=LH2026101814571576946",
  "qrcode": "https://qr.alipay.com/tsx10688aiofc5nwctmhi34"
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `code` | **1 = 成功**（经典 V1 风格，非本站公开 API 的 200 体系） |
| `trade_no` | 平台订单号（LH 前缀 + 时间戳），查单与对账用 |
| `payurl` | 收银台地址（`/Pay/console?trade_no=…`），给浏览器跳转 |
| `qrcode` | **收款二维码直链**——实测所有订单返回**同一个**支付宝链接（固定个人收款码，见 §7.1 免签加价机制） |
| `money` | **加价后的实际支付金额**（字符串，两位小数；注意与请求金额可能差 1–N 分，见 §7.1） |

服务端拿到 `payurl` 后自行决定跳转或展示二维码。Papilot 用 submit.php 跳转模式则无需解析本响应。

### 5.3 查单 —— `/Api/checkOrder` `[实测·成功响应已拿到]`

**这是本平台与经典易支付最大的差异点：经典 `api.php?act=order` 路径在本平台是 404**（实测），查单走 `/Api/checkOrder`，且**只支持 GET**（POST 实测 404）：

```
GET https://www.ljlliu.cn/Api/checkOrder?pid=3&out_trade_no=PPKY2M1A3B7F1C9&sign=<md5(pid+out_trade_no 待签名串)>
```

三种实测响应（鉴权顺序：**先查单后鉴权**）：

```json
// ① 成功（订单存在 + 签名正确）——code=0，data 包裹，money 为数字（整元无小数位）
{"code":0,"data":{"end_time":null,"money":10.01,"out_trade_no":"PPT68519","status":0,"trade_no":"LH2026101815005136405","type":"alipay"},"msg":"ok"}

// ② 订单不存在——code=201，此分支不验签（先查单后鉴权）
{"code":201,"data":null,"msg":"订单不存在"}

// ③ 订单存在但签名坏/缺失——code=401
{"code":401,"data":null,"msg":"商户身份校验失败"}
```

- `data.status`：**0 = 未支付**（实测）；1 = 已支付 `[惯例·待真实支付确认]`；
- `data.money`：**数字类型**（`10.01`、整元时 `10` 无小数位）——解析时勿按字符串处理；为**加价后金额**（见 §7.1）；
- `data.end_time`：订单过期时间（未过期时 null）；
- 查询不存在订单**不验签**（201）——存在「订单号探测」面（知道 pid 可探测订单号是否存在），敏感度低但知悉即可；
- 该端点**不需要域名过白**（不受 §7 域名闸门约束），可直接服务端调用。

### 5.4 查单失败的排障路径

`订单号不可为空` → 检查参数名拼写；`订单不存在`（201）→ pid/out_trade_no 不匹配或订单未创建成功；`商户身份校验失败`（401）→ 签名错（密钥错 / 待签名串构造错，注意 sign 覆盖 pid+out_trade_no 两个参数）；连不上 → 检查是否误用 POST 或误拼路径（`api.php` 是 404）。

### 5.5 下单参数的深入校验层 `[实测·域名过白+正确签名后首次可见]`

域名授权 + 正确签名后，更深的校验层才暴露（此前全部被域名闸门掩盖）：

| 场景 | 响应 | 说明 |
|---|---|---|
| `type=wxpay` | `{"code":201,"msg":"暂无收款账号在线!"}` | **当前商户无微信收款账号在线**——接入初期只有支付宝可用 |
| `type=foo`（不存在的值） | `{"code":201,"msg":"暂无收款账号在线!"}` | **type 不是白名单校验**，而是路由到收款账号——拼错 type 的报错与通道离线完全同文案，排障易误导 |
| `money=0` / `money=abc` | `{"code":201,"msg":"金额错误!"}` | 金额必须为正数 |
| `money=100000` | `{"code":201,"msg":"订单金额高于最高发起金额"}` | 存在单笔上限（商户配置），具体阈值见商户后台 |
| 附带 `param` 字段 | 正常下单成功 | 业务自定义字段可用（参与签名） |
| 附带 `device` 字段 | 正常下单成功 | 被接受（家族惯例 pc/-mobile） |
| 缺 `return_url` | 正常下单成功 | 确认可选 |

## 6. 回调通知处理 `[惯例]`

**异步通知（notify）**：用户付款成功后，平台向 `notify_url` 发起 GET 请求，携带下单参数 + 订单结果参数 + 签名：

```
pid=3&name=Papilot会员&money=10.00&out_trade_no=PPKY2M1A3B7F1C9&trade_no=<平台订单号>&type=alipay&status=1&param=&sign=<md5>&sign_type=MD5
```

处理要点（Papilot `/api/pay/notify` 现行实现已覆盖）：

1. **验签**：剔除 `sign`/`sign_type` 与空值后按 ASCII 升序复算 MD5 比对；
2. **幂等**：同一订单可能收到多次通知（平台补发），入账逻辑必须幂等（Papilot 已用 `paidAt` / 状态机保证）；
3. **金额与订单号核对**：`out_trade_no` 必须是本地未完结订单；`money` 与本地订单金额比对（Papilot 1.8.3 起在**多付侧**留 ¥1 尾差窗口以兼容免签加价，**少付仍一律拒绝**——防的是篡改金额少付，不是多付）；
4. **应答**：处理成功后响应纯文本 `success`（各家要求 `success`/`ok` 略有差异 `[待确认]`）；未应答或应答非成功串时平台会按退避策略重发；
5. **不要信任同步跳转**：`return_url` 只是用户浏览器回跳（可能被关闭 / 断网），订单状态更新必须以 notify + 主动查单为准。

**同步回跳（return）**：GET 携带与 notify 相同的参数集，用于前端落地页展示；同样带 sign，可以复用验签逻辑，但**不得**作为入账依据。

**丢包兜底**：notify 收不到时用 `/Api/checkOrder` 主动查单（Papilot「刷新订单状态」按钮已内建此逻辑）。

## 7. 注意事项与常见错误（重点）

按踩坑概率排序，1–7 为实测亲证：

1. **★ 免签加价机制（个人收款码 + 唯一金额匹配）——影响回调金额核对，接入前必读**。实测铁证：所有订单的 `qrcode` 是**同一个支付宝链接**（固定个人收款码）；同金额的第 1 笔订单不加价（¥10.00→10.00），**第 2、3…笔并发未完结订单依次 +1 分**（10.00→10.01→10.02）；`mapi.php` 响应的 `money` 与 `checkOrder` 的 `data.money` 均为**加价后金额**。notify 的 `money` 极可能也带加价值（订单记录即存加价值）`[待真实支付确认]`。
   **Papilot 已适配（服务端 1.8.3）**：回调金额校验在多付侧开尾差窗口（`PP_PAY_OVERPAY_CENTS`，默认 ¥1，`pp.env` 可调，0=恢复精确比对）；少付仍一律拒绝；到账额度仍按本地订单金额。同价套餐并发是常态场景，**没有这个窗口每笔并发单都会被当「金额不符」拒掉**。
2. **域名白名单是总闸门，且按商户配置**。未过白的一切下单请求（含 `notify_url` 指向平台自身域名、`127.0.0.1`、任意 IP 直连）一律报：
   `该域名不可发起支付，原因：域名没过白，请前往平台授权域名`
   授权入口在用户中心（`pp.xinglintools.top` 已于 2026-10-18 授权并验证通过）。白名单判定对象是 `notify_url` 的域名（实测无协议的 URL 报「异步通知地址域名无效」，过了 URL 解析才进白名单比对）。
3. **域名检查先于签名校验**（实测：全参数 + 无 sign 时报的是域名错误而非签名错误）。排障时签名错误会被域名错误掩盖——先把域名过白，才能暴露签名层的问题（域名过白后无签名的报错是 `验签失败,请检查PID或Key是否正确!`）。
4. **经典查单路径 `api.php?act=order` 在本平台不存在（404）**；查单必须用 `GET /Api/checkOrder`。从其它易支付网关移植代码时这是第一个要改的地方。
5. **`mapi.php` 完全忽略 `act` 参数**（实测 `act=order`/`act=refund`/`act=close` 全部走下单校验链）。想用经典「同端点 act 分流」的代码在本平台无效。
6. **`/Api/checkOrder` 只接受 GET**（POST 404），且**先查单后鉴权**：查无订单回 201（不验签），订单存在才验签（坏签名回 401）。
7. **错误码体系按端点各自为政**：`mapi.php` 下单成功 `code=1`（经典 V1）；`/Api/checkOrder` 成功 `code=0` / 业务错 201 / 鉴权失败 401；公开 API `200/201`。**不要假设全站统一**。Papilot `queryOrder()` 的 checkOrder 变体判定已兼容 `code===0 || code===200`。
8. **通道可用性**：实测 `wxpay` 报 `暂无收款账号在线!`（当前商户仅有支付宝收款账号在线）；**拼错 type 的报错与通道离线同文案**——遇到它先确认 type 拼写，再确认通道状态。
9. **CORS 关闭**：任何浏览器端 AJAX 直调 `mapi.php` 都会失败，下单必须由服务端发起（或跳转 submit.php）。
10. **订单号格式**：家族惯例纯字母数字 `[惯例]`。Papilot 的 `newTradeNo()`（`PP+36进制时间戳+随机hex`）符合要求，勿传内部 `o-xxx` 号。
11. **`return_url` 可选但强烈建议传**：不传用户付完款无处可跳，滞留在平台收银台（实测不传可正常下单）。
12. **key 只进签名不进参数**：V1 家族惯例密钥绝不 URL 传输（本平台 checkOrder 实测传 key 无效果，侧面印证）。key 保管遵循项目密钥纪律（AES 加密于 `server/data/pay.json`，不进 git）。
13. **单笔金额上限**：`money=100000` 报 `订单金额高于最高发起金额`（阈值在商户配置，后台可见）。
14. **文档与后台都在登录墙后**：`user#/api-access/docs` 需登录；登录带滑块验证码 + 图形验证码（`captcha_type=1`）。
15. **平台合规红线**（`getSoftwareConfig` 公开返回的注册弹窗原文）：禁止赌博/刷单/色情/诈骗类交易，禁止伪造订单、拦截回调，禁止批量注册小号。违规清退。收款业务场景需与之匹配。
16. **免签模式的固有风险须知**：个人收款码 + 金额匹配意味着——匹配依赖支付宝/微信的入账通知（延迟、掉单概率高于商业通道）；平台侧无即时退款能力；收款账号离线则对应通道整体不可用（见 8）。建议保留收款码+人工核销作为回落（Papilot 默认设计即如此）。

## 8. 与 Papilot 现有网关代码的适配结论

Papilot `server/lib/pay.js` 的 **`provider: 'epay'`（V1 MD5）通道可直接复用**：

| 配置项 | 值 |
|---|---|
| `gateway` | `https://www.ljlliu.cn` |
| `pid` | `3` |
| `key` | 商户密钥（存 `server/data/pay.json`，AES 加密） |
| `queryMode` | `checkOrder`（现有变体分支） |

**服务端适配完成状态**（1.8.2 批次 + 1.8.3 批次，`pay.test.js` 119 断言全绿、接线扫描 0 问题）：

1.8.2 批次（已随 0.48.0 发版）：

1. ✅ `queryOrder()` checkOrder 变体成功码兼容：`code===0 || code===200`（实测该平台走 0，200 为同构站防御性容错；201「订单不存在」自然落 `ok=false`）；
2. ✅ `testConnection()` 深度自检：`base` 参数用真实回调域名（原写死 example.com 对域名白名单网关必然失败）；域名白名单拒绝如实报错（原会把失败误报成「全链路通过」）；标准查单 404 提示改选 checkOrder 变体；
3. ✅ 管理页「查询接口变体」选项文案标注。

1.8.3 批次（2026-10-18 全链路实测后新增）：

4. ✅ **免签加价兼容**：回调金额校验在多付侧开尾差窗口 `PAY_OVERPAY_TOLERANCE_CENTS`（默认 ¥1，`pp.env` 可调 `PP_PAY_OVERPAY_CENTS`，0=恢复精确比对）——少付仍一律拒绝、到账额度仍按本地订单金额（多付不多记）；测试 C39a-d 覆盖加价单入账/超容差拒绝；
5. ✅ 假网关仿真升级为真实实测行为（checkOrder 先查单后鉴权 201/401、Go 纯文本 404）。

**接入操作顺序**：

1. ~~平台用户中心：授权域名 `pp.xinglintools.top`~~ ✅ 2026-10-18 已授权并全链路验证；
2. 网页管理页「在线支付网关」：填协议 V1 MD5、网关地址、pid=3、密钥、查询接口变体选 **GET /Api/checkOrder** → 连接测试（深度测试应报「全链路通过」）；
3. 真实支付一笔小额订单（扫码付 0.0x 元）观察 notify 实际参数集与应答串——关闭 §9 剩余项；
4. 启用 `enabled`，客户端「刷新订单状态」按钮走 checkOrder 主动查单兜底。

## 9. 待确认清单（真实支付一笔即可全部关闭）

- [x] ~~签名串构造（密钥直接拼接）~~ ✅ 2026-10-18 实测关闭（真实下单+查单均通过）
- [x] ~~`/mapi.php` 成功响应字段（code=1 + payurl/qrcode/trade_no 平铺）~~ ✅ 实测关闭
- [x] ~~`/Api/checkOrder` 成功响应（code=0 + data 包裹 + status/money/trade_no/end_time）~~ ✅ 实测关闭
- [x] ~~域名白名单授权~~ ✅ 已授权并验证
- [ ] notify 回调参数全集与应答串（`success` vs `ok`）——**须真实支付一笔**
- [ ] notify `money` 是否确为加价后金额（订单记录存加价值，推断为是）——**须真实支付一笔**
- [ ] `data.status=1` 的已支付语义（家族惯例）
- [ ] wxpay 通道何时有收款账号在线（平台侧配置）
- [ ] 单笔金额上限的具体阈值（商户后台可见）
- [ ] 是否存在退款接口
- [ ] 域名白名单是否同时约束 `return_url` / 发起方 Referer（实测仅能确证 notify_url 域名受检）

## 附录：实测原始记录（2026-10-18）

| 请求 | 响应 |
|---|---|
| `GET /mapi.php` | `{"code":201,"data":null,"msg":"PID不可为空!"}` |
| `GET /mapi.php?pid=3` | `{"code":201,"data":null,"msg":"订单号不可为空!"}` |
| `GET /mapi.php?pid=3&out_trade_no=T` | `{"code":201,"data":null,"msg":"支付类型不可为空!"}` |
| `GET /mapi.php?pid=3&type=alipay&out_trade_no=T` | `{"code":201,"data":null,"msg":"金额不可为空!"}` |
| `…&money=0.01`（缺 name） | `{"code":201,"data":null,"msg":"商品名称不可为空!"}` |
| `…&name=TEST`（缺 notify_url） | `{"code":201,"data":null,"msg":"异步通知不可为空!"}` |
| `…&notify_url=https://example.com/n`（缺 return_url） | `{"code":201,"data":null,"msg":"该域名不可发起支付，原因：域名没过白，请前往平台授权域名"}` |
| `notify_url=example.com/n`（无协议） | `{"code":201,"data":null,"msg":"异步通知地址域名无效"}` |
| `notify_url=https://www.ljlliu.cn/n` | 域名没过白（平台自身域名同样拒绝） |
| `notify_url=http://127.0.0.1:8000/n` | 域名没过白（IP 直连同受白名单约束） |
| `pid=99999` + 全参数 | 域名没过白（先域名后商户校验） |
| `type=foo` / `money=0` / `money=-1` / `money=abc` / `money=100000` | 一律域名没过白（这些校验在白名单之后） |
| `GET /mapi.php?act=order&pid=3&key=…&out_trade_no=X` | `支付类型不可为空!`（act 被忽略） |
| `GET /submit.php`（缺 notify） | HTML 状态页：`异步通知不可为空` |
| `GET /submit.php?pid=3&type=alipay&out_trade_no=S2&notify_url=…&name=T&money=0.01` | HTML 状态页：域名没过白 |
| `GET /Api/checkOrder?pid=3&out_trade_no=PING0000000000` | `{"code":201,"data":null,"msg":"订单不存在"}` |
| `GET /Api/checkOrder?out_trade_no=X`（缺 pid） | `{"code":201,"data":null,"msg":"订单不存在"}` |
| `GET /Api/checkOrder?pid=3`（缺订单号） | `{"code":201,"data":null,"msg":"订单号不可为空"}` |
| `POST /Api/checkOrder` | `404 page not found` |
| `GET /api.php` / `/Api.php` / `/query.php` 等 | `404 page not found` |
| `OPTIONS /mapi.php`（Origin: pp.xinglintools.top） | `204 No Content`，无 CORS 头 |
| `GET /Api/getSoftwareConfig` | `{"code":200,"data":{"name":"领航智能Pay","is_reg":1,…},"msg":"获取成功"}` |

### 第二轮：域名授权后全链路实测（同日 15:00，均带正确 MD5 签名）

| 请求 | 响应 |
|---|---|
| `GET /mapi.php`（全参数无 sign，域名已过白） | `{"code":201,"msg":"验签失败,请检查PID或Key是否正确!"}`（签名校验层首次可见） |
| `GET /mapi.php`（全参数+正确 sign，0.01 元） | `{"code":1,"msg":"获取成功!","trade_no":"LH2026101814571576946","out_trade_no":"PPDOC…","type":"alipay","money":"0.01","payurl":"https://www.ljlliu.cn/Pay/console?trade_no=…","qrcode":"https://qr.alipay.com/tsx10688aiofc5nwctmhi34"}` **（订单创建成功）** |
| `GET /submit.php`（同参数） | HTTP 200 直出收银台 HTML（无 302） |
| `GET /Api/checkOrder?pid=3&out_trade_no=PPDOC…&sign=…` | `{"code":0,"data":{"end_time":null,"money":0.01,"out_trade_no":"PPDOC…","status":0,"trade_no":"LH…","type":"alipay"},"msg":"ok"}` |
| 同上（无 sign / 伪 sign，订单存在） | `{"code":401,"data":null,"msg":"商户身份校验失败"}`（成功路径确实验签） |
| `GET /mapi.php`（type=wxpay） | `{"code":201,"msg":"暂无收款账号在线!"}` |
| `GET /mapi.php`（type=foo） | `{"code":201,"msg":"暂无收款账号在线!"}`（拼错 type 与通道离线同文案） |
| `GET /mapi.php`（money=0 / abc） | `{"code":201,"msg":"金额错误!"}` |
| `GET /mapi.php`（money=100000） | `{"code":201,"msg":"订单金额高于最高发起金额"}` |
| `GET /mapi.php`（带 param / device 字段） | 正常下单成功 |
| **免签加价序列**（连续同额 0.01 元下单） | 响应 money 依次 `0.01 → 0.02 → 0.03 → 0.04`；¥10.00 三连单 `10.00 → 10.01 → 10.02`；qrcode 全程同一链接 |
| 查加价单 `PPP6769`（请求 0.01/实际 0.02） | `checkOrder.data.money = 0.02`（**订单记录存加价后金额**） |

> 第一轮探测未产生订单（域名未过白）；第二轮真实创建了 8 笔测试单（0.01–0.04 元五笔 + 10.00–10.02 元三笔），**全部未支付**，会在平台商户后台留未支付记录、超时自动关闭，无任何资金变动。订单号前缀 PPDOC/PPW/PPF/PPM/PPN/PPB/PPP/PPD/PPR/PPT 便于辨认清理。
