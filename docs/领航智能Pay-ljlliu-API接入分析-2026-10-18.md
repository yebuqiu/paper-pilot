# 领航智能Pay（ljlliu.cn）API 接入分析

> 调研日期：2026-10-18
> 背景：PaperPilot 在线支付（`server/lib/pay.js`，V1 易支付 MD5 协议）拟接入该聚合支付平台。
> 秘钥来源：商户后台「API 接入」页导出的 Base64 串，解码后为 `{"site":"https://www.ljlliu.cn","pid":3,"key":"uJV3***（密钥已脱敏，见 server/data/pay.json）"}`。

## 0. 方法论与可信度说明

官方文档地址 `https://www.ljlliu.cn/user#/api-access/docs` 位于**用户中心 SPA 内，登录后才可见**（未登录访问被路由守卫重定向到登录页，含滑块验证码）。本文档**无法直接读取官方文档原文**，改用两条腿走路：

1. **生产 API 黑盒实测**（2026-10-18 全部亲测，原始响应见附录）：逐参数测绘 `/mapi.php`、`/submit.php`、`/Api/checkOrder` 的校验链与错误信息；
2. **易支付（Epay）V1 协议家族比对**：该平台的端点布局（submit.php / mapi.php）、参数命名（pid / out_trade_no / notify_url…）、错误文案风格均为标准易支付家族特征，PaperPilot 现有 V1 网关实现（`server/lib/pay.js`）可直接对照。

**标注约定**：标注 `[实测]` 的内容为本轮直接探测验证；标注 `[惯例]` 的内容为易支付家族通行约定、在本平台尚待登录文档页或真实下单确认；标注 `[待确认]` 的为已知缺口。

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

**响应统一格式** `[实测]`：`{"code":200|201,"data":…,"msg":"…"}` —— 200=成功、201=业务失败。**注意与经典易支付 V1「code=1 成功」不同，也与本项目现有 checkOrder 变体「code=0 成功」不同**（详见 §7.8）。

**其它实测特征**：

- CORS 未开放（OPTIONS 预检 204 且不带 `Access-Control-Allow-Origin`）→ **mapi.php 只能服务端调用**，浏览器端 AJAX 会跨域失败。这是正确的设计，密钥本就不该下发浏览器。
- 每次请求种 `ls_cid` Cookie（HttpOnly / Secure / SameSite=Lax），用于会话关联。
- 安全响应头齐全：HSTS、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`。

## 2. 鉴权方式（如何使用那串秘钥）

秘钥本体是 Base64 包装的 JSON：`{"site":"https://www.ljlliu.cn","pid":3,"key":"…"}`。三个字段用途 `[实测+惯例]`：

| 字段 | 用途 |
|---|---|
| `site` | 网关地址（PaperPilot 网关配置的 `gateway` 字段，末尾不带 `/`） |
| `pid` | 商户 ID（3）——所有下单 / 查单请求的必填参数 |
| `key` | 商户密钥（16 位）——**只用于签名计算，不作为参数明文传输**（V1 家族惯例；`/Api/checkOrder` 实测传不传 `key` 参数响应一致） |

身份验证的载体是 **MD5 参数签名**：请求方用 key 计算 `sign` 随请求携带，平台用同一 key 复算比对 `[惯例]`。此外该平台叠加了一层**按商户的发起域名白名单**（见 §7.1），这层在签名校验之前。

## 3. 必填请求参数（实测校验链）

`/mapi.php` 与 `/submit.php` 共用同一套校验 `[实测]`，缺参报错顺序如下（每条都是原始错误文案）：

| 顺序 | 参数 | 缺省报错 | 说明 |
|---|---|---|---|
| 1 | `pid` | `PID不可为空!` | 商户号 |
| 2 | `out_trade_no` | `订单号不可为空!` | 商户订单号；家族惯例为**纯字母数字**（PaperPilot 内部 `o-xxx` 带连字符号会被拒，`newTradeNo()` 已处理） |
| 3 | `type` | `支付类型不可为空!` | 支付通道；家族通行值 `alipay` / `wxpay`（`qqpay`/`bank` 等 `[待确认]`） |
| 4 | `money` | `金额不可为空!` | 金额，两位小数字符串 |
| 5 | `name` | `商品名称不可为空!` | 商品名 |
| 6 | `notify_url` | `异步通知不可为空!` | **必须含协议头**：传 `example.com/n`（无 `http(s)://`）报 `异步通知地址域名无效`；其域名即域名白名单判定对象 |
| 7 | — | `该域名不可发起支付，原因：域名没过白，请前往平台授权域名` | 域名白名单总闸门（§7.1） |
| 8 | （`sign`） | 签名校验 `[待确认]`（被域名闸门挡住无法实测） | — |

**`return_url`（同步跳转地址）为可选** `[实测]`：缺省时校验直接跳过它走到域名检查，无任何报错。这与部分易支付实现强制要求 return_url 不同。

`sign` / `sign_type` 两个参数随请求携带（见下节）。

## 4. 签名与验签规则 `[惯例]`

易支付 V1 家族标准 MD5 签名（与 PaperPilot `server/lib/pay.js` 的 `buildSign()` 完全一致）：

```
待签名串 = 所有非空参数（剔除 sign、sign_type 本身）
           按键名 ASCII 升序排列
           以 k=v 形式用 & 连接
sign     = md5(待签名串 + 商户密钥)        // 密钥直接拼接，无分隔符
sign_type = "MD5"
```

以本次凭证为例（key 以 `KEY` 代指）：

```
参数: money=10.00, name=PaperPilot会员, notify_url=https://pp.xinglintools.top/api/pay/notify,
      out_trade_no=PPKY2M1A3B7F1C9, pid=3, return_url=https://pp.xinglintools.top/api/pay/return, type=alipay

待签名串 = "money=10.00&name=PaperPilot会员&notify_url=https://pp.xinglintools.top/api/pay/notify&out_trade_no=PPKY2M1A3B7F1C9&pid=3&return_url=https://pp.xinglintools.top/api/pay/return&type=alipay"
sign     = md5(待签名串 + KEY)
```

验签（回调侧）规则同构：取出回传参数中的 `sign`，用剩余非空参数复算 MD5 比对（大小写不敏感）。**注意陷阱**：`notify_url` 参与签名时必须与下单时完全一致（含协议、路径大小写），回调验签时若漏掉任何非空参数（如 `trade_no`）会验签失败——验签应基于回调实际收到的参数集复算，而不是下单时的参数集。

> `[待确认]` 本平台签名串是否剔除 `sign_type`、密钥拼接方式（直接拼接 vs `&key=` 间隔）需登录文档页核对。绝大多数易支付 V1 兼容平台为「直接拼接」。

## 5. 接口调用示例

### 5.1 下单 —— 跳转模式（`/submit.php`，浏览器场景）

拼好带签名的 URL 后让浏览器直接跳转（PaperPilot `createPayUrl()` 现行做法）：

```
https://www.ljlliu.cn/submit.php?pid=3&type=alipay&out_trade_no=PPKY2M1A3B7F1C9&notify_url=<URL编码后>&return_url=<URL编码后>&name=PaperPilot会员&money=10.00&sign=<md5>&sign_type=MD5
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
  name: 'PaperPilot会员',
  money: '10.00',
};
const sign = buildSign(params, CFG_KEY);
const url = 'https://www.ljlliu.cn/submit.php?'
  + Object.entries({ ...params, sign, sign_type: 'MD5' })
      .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
```

### 5.2 下单 —— API 模式（`/mapi.php`，服务端场景）

`[实测]` 参数校验与 submit.php 完全一致；成功响应 `[待确认]`，按平台响应风格推断为：

```json
{"code":200,"data":{"payurl":"https://www.ljlliu.cn/pay/xxxx","qrcode":"...","trade_no":"..."},"msg":"成功"}
```

服务端拿到 `payurl` 后自行决定跳转或展示二维码（`qrcode.php` 可用于渲染二维码图）。**建议接入时先打印一次真实成功响应核对字段名**（payurl / urls / qrcode 各家实现有差异）。

### 5.3 查单 —— `/Api/checkOrder` `[实测]`

**这是本平台与经典易支付最大的差异点：经典 `api.php?act=order` 路径在本平台是 404**（实测），查单走 `/Api/checkOrder`，且**只支持 GET**（POST 实测 404）：

```
GET https://www.ljlliu.cn/Api/checkOrder?pid=3&out_trade_no=PPKY2M1A3B7F1C9&sign=<md5(pid+out_trade_no 待签名串)>
```

实测响应（订单不存在时）：

```json
{"code":201,"data":null,"msg":"订单不存在"}
```

- 查询不存在订单时**不校验签名也能得到「订单不存在」**（实测无 sign 与带伪 sign 响应一致）——不能据此判定该端点免鉴权，成功路径大概率验签 `[待确认]`；
- 成功响应 `[待确认]`：按平台风格推断 `{"code":200,"data":{"status":1,"trade_no":"...","money":"..."},"msg":"..."}`，`data.status==1` 为已支付；
- 实测该端点**不需要域名过白**（不受 §7.1 闸门约束），可直接服务端调用。

### 5.4 查单失败的排障路径

`订单号不可为空` → 检查参数名拼写；`订单不存在` → pid/out_trade_no 不匹配或订单未创建成功；连不上 → 检查是否误用 POST 或误拼路径（`api.php` 是 404）。

## 6. 回调通知处理 `[惯例]`

**异步通知（notify）**：用户付款成功后，平台向 `notify_url` 发起 GET 请求，携带下单参数 + 订单结果参数 + 签名：

```
pid=3&name=PaperPilot会员&money=10.00&out_trade_no=PPKY2M1A3B7F1C9&trade_no=<平台订单号>&type=alipay&status=1&param=&sign=<md5>&sign_type=MD5
```

处理要点（PaperPilot `/api/pay/notify` 现行实现已覆盖）：

1. **验签**：剔除 `sign`/`sign_type` 与空值后按 ASCII 升序复算 MD5 比对；
2. **幂等**：同一订单可能收到多次通知（平台补发），入账逻辑必须幂等（PaperPilot 已用 `paidAt` / 状态机保证）；
3. **金额与订单号核对**：`out_trade_no` 必须是本地未完结订单、`money` 必须与本地订单金额一致（防止篡改金额的伪通知）；
4. **应答**：处理成功后响应纯文本 `success`（各家要求 `success`/`ok` 略有差异 `[待确认]`）；未应答或应答非成功串时平台会按退避策略重发；
5. **不要信任同步跳转**：`return_url` 只是用户浏览器回跳（可能被关闭 / 断网），订单状态更新必须以 notify + 主动查单为准。

**同步回跳（return）**：GET 携带与 notify 相同的参数集，用于前端落地页展示；同样带 sign，可以复用验签逻辑，但**不得**作为入账依据。

**丢包兜底**：notify 收不到时用 `/Api/checkOrder` 主动查单（PaperPilot「刷新订单状态」按钮已内建此逻辑）。

## 7. 注意事项与常见错误（重点）

按踩坑概率排序，1–6 为本轮实测亲证：

1. **域名白名单是总闸门，且按商户配置**。未过白的一切下单请求（含 `notify_url` 指向平台自身域名、`127.0.0.1`、任意 IP 直连）一律报：
   `该域名不可发起支付，原因：域名没过白，请前往平台授权域名`
   **接入第一步永远是：登录用户中心 → 授权域名 → 把 `pp.xinglintools.top` 加进去**。白名单判定对象是 `notify_url` 的域名（实测无协议的 URL 报「异步通知地址域名无效」，过了 URL 解析才进白名单比对）。
2. **域名检查先于签名校验**（实测：全参数 + 无 sign 时报的是域名错误而非签名错误）。排障时签名错误会被域名错误掩盖——先把域名过白，才能暴露签名层的问题。
3. **`notify_url` 必须带协议**：`example.com/n` 这种裸域名直接报 `异步通知地址域名无效`。
4. **经典查单路径 `api.php?act=order` 在本平台不存在（404）**；查单必须用 `GET /Api/checkOrder`。从其它易支付网关移植代码时这是第一个要改的地方。
5. **`mapi.php` 完全忽略 `act` 参数**（实测 `act=order`/`act=refund`/`act=close` 全部走下单校验链）。想用经典「同端点 act 分流」的代码在本平台无效。
6. **`/Api/checkOrder` 只接受 GET**（POST 404）。
7. **错误码体系非经典**：本平台 `code=200` 成功 / `code=201` 业务失败；经典 V1 是 `code=1` 成功。**PaperPilot 现有 `queryOrder()` 的 checkOrder 变体判定 `code===0` 为成功，与本平台不匹配，接入时必须适配**（改判定或加平台探测分支）。
8. **CORS 关闭**：任何浏览器端 AJAX 直调 `mapi.php` 都会失败，下单必须由服务端发起（或跳转 submit.php）。
9. **订单号格式**：家族惯例纯字母数字 `[惯例]`。PaperPilot 的 `newTradeNo()`（`PP+36进制时间戳+随机hex`）符合要求，勿传内部 `o-xxx` 号。
10. **`return_url` 可选但强烈建议传**：不传用户付完款无处可跳，滞留在平台收银台。
11. **key 只进签名不进参数**：V1 家族惯例密钥绝不 URL 传输（本平台 checkOrder 实测传 key 无效果，侧面印证）。key 保管遵循项目密钥纪律（AES 加密于 `server/data/pay.json`，不进 git）。
12. **文档与后台都在登录墙后**：`user#/api-access/docs` 需登录；登录带滑块验证码 + 图形验证码（`captcha_type=1`）。对接前先在文档页核对 §4/§5 标注的 `[待确认]` 项。
13. **平台合规红线**（`getSoftwareConfig` 公开返回的注册弹窗原文）：禁止赌博/刷单/色情/诈骗类交易，禁止伪造订单、拦截回调，禁止批量注册小号。违规清退。收款业务场景需与之匹配。

## 8. 与 PaperPilot 现有网关代码的适配结论

PaperPilot `server/lib/pay.js` 的 **`provider: 'epay'`（V1 MD5）通道几乎可以直接复用**：

| 配置项 | 值 |
|---|---|
| `gateway` | `https://www.ljlliu.cn` |
| `pid` | `3` |
| `key` | 商户密钥（存 `server/data/pay.json`，AES 加密） |
| `queryMode` | `checkOrder`（现有变体分支） |

**2026-10-18 服务端适配已完成**（同轮提交，`pay.test.js` 113 断言全绿、preflight 58/58、接线扫描 0 问题）：

1. ✅ **`queryOrder()` checkOrder 变体成功码兼容**：`code===0` → `code===0 || code===200`（领航智能Pay 实测走 200/201 体系；201「订单不存在」自然落 `ok=false`，不误报）；
2. ✅ **`testConnection()` 深度自检修复两个误报/坑**（实测中发现的隐藏问题）：
   - 深度测试单的 `notify_url`/`return_url` 改用**真实回调基地址**（新增 `base` 参数，account-server 传 `siteBaseUrl()`）——原实现写死 `example.com`，对域名白名单类网关**必然失败**；
   - 下单错误识别补**域名白名单分支**（原文案「该域名不可发起支付，原因：域名没过白…」）——原正则漏了这一类错误，会把域名未过白的失败**误报成「全链路通过」**；
3. ✅ **标准查单 404 提示**：`queryMode=''` 且 `/api.php` 报 404 时，自检失败信息直接提示「改选 GET /Api/checkOrder 变体」（Go 系新网关无 api.php）；
4. ✅ 管理页「查询接口变体」选项文案标注领航智能Pay 适用（`admin.html`）；
5. ⏳ **查单成功后 `data.status`/`data.trade_no` 字段名**：按 §5.3 推断结构，仍需真实下单后核对一次（唯一剩余项）。

**接入操作顺序建议**：

1. 平台用户中心：授权域名 `pp.xinglintools.top`（§7.1 前置条件）；
2. 网页管理页「在线支付网关」：填协议 V1 MD5、网关地址、pid=3、密钥、查询接口变体选 **GET /Api/checkOrder** → 连接测试（浅测查可达性；**深度测试会如实报告域名未过白**，授权后应报「全链路通过」）；
3. 深度测试通过后跑 0.01 元真实订单全链路（下单 → 支付 → notify → 验签 → 入账 → 查单核对）；
4. 用真实成功响应回填本文档 §4/§5.3 的 `[待确认]` 项。

## 9. 待确认清单（登录文档页 / 实测后关闭）

- [ ] 签名串构造：密钥直接拼接 vs `&key=` 间隔（§4）
- [ ] notify 回调参数全集与应答串（`success` vs `ok`）（§6）
- [ ] `/Api/checkOrder` 成功响应字段与 `status` 取值域（§5.3）
- [ ] `/mapi.php` 成功响应字段名（`payurl`? `urls`?）（§5.2）
- [ ] 支持的 `type` 通道清单（alipay/wxpay 之外）
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

> 注：探测均使用脱敏后的凭证与不存在的订单号（PING 前缀），未在商户后台产生任何订单或资金变动；域名白名单探测未获通过，全程未能创建订单。
