// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译模块 · 引擎注册表子模块（0.28.0 建立；0.73.0 自 translate.js 拆出）
 *
 * 职责（单一）：16 个翻译引擎的**声明式注册表** + 引擎查询 + 复合密钥解析。
 * 每个引擎只声明：语言码映射 codes(ctx) / 请求构造 endpoint(ctx)（纯）/
 * 响应解析 extract(resp, ctx)（纯）/ 可选 prepare(ctx)（仅它允许联网）。
 * 上层（translate.js 门面）只调注册表接口，与具体厂商解耦 ——
 * **新增厂商 = 在 SERVICES 里加一条；其它文件零改动。**
 *
 * 依赖：TranslateLang（语言码归一与厂商映射表）、TranslateCrypto（签名算法）、
 *       Zotero（仅个别引擎调用期用：baidu 的 md5、bing/edge 的 prepare 联网）。
 * 装配：main.js files 列表，须在 translate-lang.js / translate-crypto.js 之后、
 *       translate.js（门面）之前。
 */
/* global Zotero, TranslateLang, TranslateCrypto */

var TranslateEngines = (function () {
  "use strict";

  /* 子模块别名（定义见 translate-lang.js / translate-crypto.js） */
  const { normalizeLang, identity, mkMap, lowerBase,
    M_ZH_HANS, M_DEEPL, M_BAIDU, M_TENCENT, M_YOUDAO, M_CAIYUN_ALLOWED } = TranslateLang;
  const { utf8Bytes, hmacSha1, base64, encodeRFC5987, googleTk, guid } = TranslateCrypto;

  /* ==================== 引擎间共享的小 helper（0.73.0 去重） ==================== */

  /** Google gtx 系（google / googleapi）响应解析：取首段译文拼接 */
  function googleExtract(resp) {
    const seg = resp && resp.response && resp.response[0];
    if (!Array.isArray(seg)) return "";
    let out = "";
    for (const s of seg) { if (s && s[0]) out += s[0]; }
    return out;
  }

  /** 微软 v3 接口（Edge 免密钥链路与 Azure 需密钥链路报文同构）：取首条译文 */
  function _msftV3Text(d) {
    const t = Array.isArray(d) && d[0] && d[0].translations && d[0].translations[0];
    return (t && t.text) || "";
  }

  /** 自建类引擎（libretranslate / deeplx / lingva）的服务地址：去尾斜杠 + 未配置报错 */
  function _selfHostedBase(parts, what) {
    const base = String((parts && parts.url) || "").replace(/\/+$/, "");
    if (!base) throw new Error("未配置 " + what);
    return base;
  }

  /* ==================== 引擎注册表 ==================== */
  /* ------------------------------------------------------------------
   * 新增引擎模板（复制后替换即可，无需改动上层）：
   * {
   *   id: "myengine", name: "我的引擎", group: "free" | "key" | "llm",
   *   docs: "https://...",           // 帮助链接（可省）
   *   needsSecret: false,             // 是否要密钥
   *   secretFields: [                 // 需密钥时：UI 逐项渲染，存成 "#" 拼接串
   *     { key: "apikey", label: "API Key", placeholder: "sk-..." },
   *     { key: "region", label: "区域", optional: true },
   *   ],
   *   codes(code, isSource) { return code; },      // 语言码映射（默认恒等）
   *   async prepare(ctx) { return {...}; },        // 可选：联网预处理
   *   endpoint(ctx) { return { method, url, headers, body, responseType }; },  // 纯
   *   extract(resp, ctx) { return "译文字符串"; },  // 纯
   * }
   * ---------------------------------------------------------------- */

  const SERVICES = [
    /* ---------- 免费、免配置 ---------- */
    {
      id: "google", name: "Google 翻译（免费接口）", group: "free",
      limits: { chars: 2000 }, // gtx 走 GET，URL 长度有限，超长须分段
      docs: "https://translate.google.com",
      codes: identity,
      endpoint(ctx) {
        const q = encodeURIComponent(ctx.text);
        const url = "https://translate.google.com/translate_a/single" +
          "?client=gtx&sl=" + encodeURIComponent(ctx.fromCode) +
          "&tl=" + encodeURIComponent(ctx.toCode) +
          "&hl=en&dt=t&source=bh&ssel=0&tsel=0&kc=1" +
          "&tk=" + googleTk(ctx.text) + "&q=" + q;
        return { method: "GET", url, responseType: "json" };
      },
      extract: googleExtract,
    },
    {
      id: "googleapi", name: "Google 翻译（translate.googleapis.com）", group: "free",
      limits: { chars: 2000 },
      codes: identity,
      endpoint(ctx) {
        const url = "https://translate.googleapis.com/translate_a/single" +
          "?client=gtx&sl=" + encodeURIComponent(ctx.fromCode) +
          "&tl=" + encodeURIComponent(ctx.toCode) +
          "&dt=t&tk=" + googleTk(ctx.text) + "&q=" + encodeURIComponent(ctx.text);
        return { method: "GET", url, responseType: "json" };
      },
      extract: googleExtract,
    },
    {
      id: "bing", name: "必应翻译（免费接口，实验性）", group: "free",
      experimental: true,
      hint: "网页版旧链路：语种最多但状态不稳（易 429）。已在「每段 1000 字符」内自动分段。",
      limits: { chars: 1000 }, // 网页版单次 1000 字符（中国区 5000，取保守值）
      codes: (code) => M_ZH_HANS[normalizeLang(code)] || normalizeLang(code),
      // 必应网页接口：先取翻译页里的 IG / IID / 反滥用 token，再发正式请求
      async prepare() {
        const page = await Zotero.HTTP.request("GET", "https://www.bing.com/translator", {
          responseType: "text", timeout: 12000,
        });
        const html = String((page && (page.responseText || page.response)) || "");
        const ig = (html.match(/IG:"([0-9A-Fa-f]+)"/) || [])[1] || "";
        const iid = (html.match(/data-iid="([^"]+)"/) || [])[1] || "";
        const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\]/);
        if (!abuse) throw new Error("必应接口取 token 失败（页面结构可能已变更）");
        return { ig, iid, key: abuse[1], token: abuse[2] };
      },
      endpoint(ctx) {
        const pre = ctx.pre || {};
        const params = new URLSearchParams();
        params.set("fromLang", ctx.from === "auto" ? "auto-detect" : ctx.fromCode);
        params.set("text", ctx.text);
        params.set("to", ctx.toCode);
        if (pre.token) params.set("token", pre.token);
        if (pre.key) params.set("key", pre.key);
        const qs = "isVertical=1" +
          (pre.ig ? "&IG=" + encodeURIComponent(pre.ig) : "") +
          (pre.iid ? "&IID=" + encodeURIComponent(pre.iid) : "");
        return {
          method: "POST",
          url: "https://www.bing.com/ttranslatev3?" + qs,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          responseType: "json",
        };
      },
      extract(resp) {
        const data = resp && resp.response;
        if (data && data.statusCode && data.statusCode !== 200) {
          throw new Error("必应返回错误（HTTP " + data.statusCode + "）");
        }
        const arr = Array.isArray(data) ? data : [data];
        const t = arr[0] && arr[0].translations && arr[0].translations[0];
        return (t && t.text) || "";
      },
    },
    {
      id: "edge", name: "必应 / Edge 翻译（免密钥，推荐）", group: "free",
      docs: "https://learn.microsoft.com/azure/ai-services/translator/reference/v3-0-translate",
      hint: "免注册、最稳的免密钥引擎：先取 Edge 的临时 token，再调微软 v3 接口（语种最全）。建议排在回退链首位。",
      limits: { chars: 5000 }, // v3 单次可达 5 万字符，这里压小以求请求体轻、与其它引擎一致
      codes: (code) => M_ZH_HANS[normalizeLang(code)] || normalizeLang(code),
      // Edge 网页翻译链路：GET /translate/auth 拿短期 token（约 10 分钟有效）
      async prepare() {
        const resp = await Zotero.HTTP.request("GET", "https://edge.microsoft.com/translate/auth", {
          responseType: "text", timeout: 12000,
        });
        const token = String((resp && (resp.responseText || resp.response)) || "").trim();
        // token 是 JWT（三段点分）。取不到就明确报错 —— 别发一个空 Bearer 出去，
        // 那样只会拿到 401，把"接口调整了"误报成"密钥无效"。
        if (!token || token.length < 40 || token.indexOf(".") < 0) {
          throw new Error("Edge 翻译取 token 失败（接口可能已调整）");
        }
        return { token };
      },
      endpoint(ctx) {
        const pre = ctx.pre || {};
        let url = "https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0" +
          "&to=" + encodeURIComponent(ctx.toCode);
        if (ctx.from !== "auto") url += "&from=" + encodeURIComponent(ctx.fromCode);
        return {
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + (pre.token || ""),
            // 必须像 Edge 客户端：该接口对 UA 敏感，缺失/异样会 401
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
          },
          body: JSON.stringify([{ Text: ctx.text }]),
          responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (d && d.error) {
          throw new Error("Edge 翻译：" + (d.error.message || d.error.code || "未知错误"));
        }
        return _msftV3Text(d);
      },
    },
    {
      id: "youdao", name: "有道翻译（免费接口）", group: "free",
      limits: { chars: 2000 },
      codes: mkMap(M_YOUDAO, lowerBase),
      endpoint(ctx) {
        return {
          method: "POST",
          url: "https://aidemo.youdao.com/trans",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "from=" + encodeURIComponent(ctx.from === "auto" ? "auto" : ctx.fromCode) +
            "&to=" + encodeURIComponent(ctx.toCode) +
            "&q=" + encodeURIComponent(ctx.text),
          responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (!d) return "";
        if (d.errorCode && String(d.errorCode) !== "0") {
          throw new Error("有道返回错误码 " + d.errorCode);
        }
        return Array.isArray(d.translation) ? d.translation.join("\n") : "";
      },
    },
    {
      id: "transmart", name: "腾讯交互翻译 TranSmart（免密钥，实验性）", group: "free",
      docs: "https://transmart.qq.com",
      experimental: true,
      hint: "腾讯 AI Lab 的交互翻译网页接口：免注册、中英方向质量好、无需密钥。属非官方 API，协议可能变动（故标注实验性）。",
      limits: { chars: 3000 }, // 网页接口按块翻译，压小以求稳
      codes: (code) => {
        const c = normalizeLang(code);
        if (c === "zh-CN") return "zh"; // 社区实测：简中要写成 zh
        if (c === "zh-TW") return "zh-TW";
        return c === "auto" ? "auto" : lowerBase(c);
      },
      endpoint(ctx) {
        const body = {
          header: {
            fn: "auto_translation",
            // client_key 形如 browser-chrome-<ver>-<os>-<uuid>-<ts>，由前端自行拼（服务端不校验真实性）
            client_key: "browser-chrome-121.0.0-Windows_10-" + guid() + "-" + Date.now(),
            session: "",
            user: "",
          },
          type: "plain",
          model_category: "normal",
          text_domain: "",
          source: { lang: ctx.from === "auto" ? "auto" : ctx.fromCode, text_list: [ctx.text] },
          target: { lang: ctx.toCode },
        };
        return {
          method: "POST",
          url: "https://transmart.qq.com/api/imt",
          headers: {
            "Content-Type": "application/json",
            "Origin": "https://transmart.qq.com",
            "Referer": "https://transmart.qq.com/",
          },
          body: JSON.stringify(body),
          responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (!d) return "";
        const arr = d.auto_translation;
        if (!Array.isArray(arr) || !arr.length) {
          const code = d.header && d.header.ret_code;
          throw new Error("TranSmart 返回异常" + (code ? "（ret_code " + code + "）" : ""));
        }
        return arr.join("\n");
      },
    },
    {
      id: "mymemory", name: "MyMemory（免费，量大限流）", group: "free",
      limits: { bytes: 500 }, // ★ 官方单次上限是 500 UTF-8 字节（不是 500 字符！）
      hint: "匿名 5000 字符/天，填邮箱升到 50000/天。已按官方 500 字节上限自动分段。",
      codes: (code) => normalizeLang(code),
      needsSecret: false,
      secretFields: [{ key: "email", label: "联系邮箱（可选，提升免费额度）", optional: true }],
      endpoint(ctx) {
        let url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(ctx.text) +
          "&langpair=" + encodeURIComponent((ctx.from === "auto" ? "Autodetect" : ctx.fromCode) +
            "|" + ctx.toCode);
        const email = (ctx.parts && ctx.parts.email) || "";
        if (email) url += "&de=" + encodeURIComponent(email);
        return { method: "GET", url, responseType: "json" };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (!d) return "";
        if (d.responseStatus && d.responseStatus !== 200) {
          throw new Error("MyMemory 返回错误：" + (d.responseDetails || d.responseStatus));
        }
        return (d.responseData && d.responseData.translatedText) || "";
      },
    },
    {
      id: "libretranslate", name: "LibreTranslate（自建/公共实例）", group: "free",
      limits: { chars: 2000 }, // 公共实例单次 2000 字符
      hint: "公共实例已强制 API Key 且单次 2000 字符；自建实例免费无限流（推荐填自己的地址）。",
      docs: "https://libretranslate.com",
      codes: (code) => {
        const c = normalizeLang(code);
        if (c === "auto") return "auto";
        if (c === "zh-CN") return "zh";
        if (c === "zh-TW") return "zt";
        return lowerBase(c);
      },
      needsSecret: true,
      secretFields: [
        { key: "url", label: "服务地址", placeholder: "https://libretranslate.com" },
        { key: "apiKey", label: "API Key（公共实例常需要）", optional: true },
      ],
      endpoint(ctx) {
        const base = _selfHostedBase(ctx.parts, "LibreTranslate 服务地址");
        const payload = {
          q: ctx.text, source: ctx.fromCode, target: ctx.toCode, format: "text",
        };
        if (ctx.parts && ctx.parts.apiKey) payload.api_key = ctx.parts.apiKey;
        return {
          method: "POST", url: base + "/translate",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload), responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (d && d.error) throw new Error("LibreTranslate：" + d.error);
        return (d && d.translatedText) || "";
      },
    },
    {
      id: "deeplx", name: "DeepLX（自建免密 Deepl）", group: "free",
      limits: { chars: 5000 },
      docs: "https://github.com/OwO-Network/DeepLX",
      codes: (code) => {
        const c = normalizeLang(code);
        return c === "auto" ? "auto" : (M_DEEPL[c] || c.split("-")[0].toUpperCase());
      },
      needsSecret: true,
      secretFields: [{ key: "url", label: "DeepLX 服务地址", placeholder: "https://your-deeplx-host" }],
      endpoint(ctx) {
        const base = _selfHostedBase(ctx.parts, "DeepLX 服务地址");
        return {
          method: "POST", url: base + "/translate",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: ctx.text, source_lang: ctx.fromCode, target_lang: ctx.toCode,
          }),
          responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (!d) return "";
        if (d.code && d.code !== 200) throw new Error("DeepLX：" + (d.message || d.code));
        const v = d.data !== undefined ? d.data
          : (d.translatedText !== undefined ? d.translatedText : d.result);
        if (Array.isArray(v)) return v.join("");
        return v || "";
      },
    },

    {
      id: "lingva", name: "Lingva Translate（自建/公共，Google 质量）", group: "free",
      docs: "https://github.com/thedaviddelta/lingva-translate",
      hint: "自建 Lingva 实例即得 Google 质量的 100+ 语种且**无限流**；也可填公共实例（限载）。自建：docker run -p 3000:3000 -e site_domain=你的域名 thedaviddelta/lingva-translate",
      limits: { chars: 4000 }, // 第三方客户端按 4000 字符设限
      // 语言码跟随 Lingva 的 Google 码约定：简中 = zh，繁中 = zh_HANT
      codes: (code) => {
        const c = normalizeLang(code);
        if (c === "zh-CN") return "zh";
        if (c === "zh-TW") return "zh_HANT";
        return c === "auto" ? "auto" : c;
      },
      needsSecret: true,
      secretFields: [{ key: "url", label: "Lingva 实例地址", placeholder: "https://lingva.ml（或你的自建地址）" }],
      endpoint(ctx) {
        const base = _selfHostedBase(ctx.parts, "Lingva 实例地址");
        // REST: GET /api/v1/{source}/{target}/{query}
        const url = base + "/api/v1/" + encodeURIComponent(ctx.fromCode) + "/" +
          encodeURIComponent(ctx.toCode) + "/" + encodeURIComponent(ctx.text);
        return { method: "GET", url, responseType: "json" };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (d && d.error) throw new Error("Lingva：" + d.error);
        return (d && d.translation) || "";
      },
    },

    /* ---------- 需要密钥 ---------- */
    {
      id: "deepl", name: "DeepL（Free / Pro）", group: "key",
      hint: "额度语义注意：新注册用户是一次性 100 万字符（每月刷新的 API Free 已退役）；key 以 :fx 结尾走免费端点。",
      docs: "https://www.deepl.com/pro-api",
      codes: (code) => {
        const c = normalizeLang(code);
        return c === "auto" ? "" : (M_DEEPL[c] || c.split("-")[0].toUpperCase());
      },
      needsSecret: true,
      secretFields: [{ key: "key", label: "DeepL API Key", placeholder: "xxxxxxxx-xxxx-...:fx" }],
      endpoint(ctx) {
        const key = (ctx.parts && ctx.parts.key) || "";
        if (!key) throw new Error("未配置 DeepL 密钥");
        const url = /:fx$/.test(key)
          ? "https://api-free.deepl.com/v2/translate"
          : "https://api.deepl.com/v2/translate";
        const body = { text: [ctx.text], target_lang: ctx.toCode };
        if (ctx.fromCode) body.source_lang = ctx.fromCode;
        return {
          method: "POST", url,
          headers: { "Content-Type": "application/json", "Authorization": "DeepL-Auth-Key " + key },
          body: JSON.stringify(body), responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        const t = d && d.translations && d.translations[0];
        return (t && t.text) || "";
      },
    },
    {
      id: "microsoft", name: "微软翻译 / Azure（需订阅）", group: "key",
      limits: { chars: 5000 },
      hint: "白嫖方式：Azure 门户 → 创建「翻译工具」资源 → 定价层选 F0（200 万字符/月，永久免费）→ 密钥与区域填这里。",
      docs: "https://learn.microsoft.com/azure/ai-services/translator/",
      codes: (code) => M_ZH_HANS[normalizeLang(code)] || normalizeLang(code),
      needsSecret: true,
      secretFields: [
        { key: "key", label: "订阅密钥（32 或 84 位）" },
        { key: "region", label: "区域（如 eastasia；全球版留空）", optional: true },
      ],
      endpoint(ctx) {
        const key = (ctx.parts && ctx.parts.key) || "";
        if (!key) throw new Error("未配置微软翻译订阅密钥");
        let url = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0" +
          "&to=" + encodeURIComponent(ctx.toCode);
        if (ctx.from !== "auto") url += "&from=" + encodeURIComponent(ctx.fromCode);
        const headers = {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": key,
        };
        const region = (ctx.parts && ctx.parts.region) || "";
        if (region && region !== "global") {
          headers["Ocp-Apim-Subscription-Region"] = region.replace(/\s+/g, "").toLowerCase();
        }
        return { method: "POST", url, headers, body: JSON.stringify([{ Text: ctx.text }]), responseType: "json" };
      },
      extract(resp) {
        return _msftV3Text(resp && resp.response);
      },
    },
    {
      id: "baidu", name: "百度翻译（开放平台）", group: "key",
      limits: { bytes: 4000 }, // 标准版 q 上限 6000 字节，GET URL 还要留余量
      docs: "https://fanyi-api.baidu.com/",
      codes: mkMap(M_BAIDU, lowerBase),
      needsSecret: true,
      secretFields: [
        { key: "appid", label: "AppID" },
        { key: "key", label: "密钥" },
      ],
      endpoint(ctx) {
        const appid = (ctx.parts && ctx.parts.appid) || "";
        const key = (ctx.parts && ctx.parts.key) || "";
        if (!appid || !key) throw new Error("未配置百度翻译 AppID/密钥");
        const salt = String(Date.now());
        const sign = Zotero.Utilities.Internal.md5(appid + ctx.text + salt + key, false);
        const url = "https://api.fanyi.baidu.com/api/trans/vip/translate" +
          "?q=" + encodeURIComponent(ctx.text) +
          "&appid=" + encodeURIComponent(appid) +
          "&from=" + encodeURIComponent(ctx.from === "auto" ? "auto" : ctx.fromCode) +
          "&to=" + encodeURIComponent(ctx.toCode) +
          "&salt=" + salt + "&sign=" + sign;
        return { method: "GET", url, responseType: "json" };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (!d) return "";
        if (d.error_code) throw new Error("百度返回错误 " + d.error_code + "：" + (d.error_msg || ""));
        if (!Array.isArray(d.trans_result)) return "";
        return d.trans_result.map((r) => (r && r.dst) || "").join("");
      },
    },
    {
      id: "tencent", name: "腾讯云机器翻译（TMT）", group: "key",
      limits: { chars: 2000 }, // TMT 单次 2000 字符
      docs: "https://cloud.tencent.com/document/product/551",
      codes: mkMap(M_TENCENT, lowerBase),
      needsSecret: true,
      secretFields: [
        { key: "secretId", label: "SecretId" },
        { key: "secretKey", label: "SecretKey" },
        { key: "region", label: "地域（默认 ap-shanghai）", optional: true },
        { key: "projectId", label: "项目 ID（默认 0）", optional: true },
      ],
      endpoint(ctx) {
        const p = ctx.parts || {};
        if (!p.secretId || !p.secretKey) throw new Error("未配置腾讯云 SecretId/SecretKey");
        const raw = {
          Action: "TextTranslate",
          Language: "zh-CN",
          Nonce: "9744",
          ProjectId: p.projectId || "0",
          Region: p.region || "ap-shanghai",
          SecretId: p.secretId,
          Source: ctx.from === "auto" ? "auto" : ctx.fromCode,
          SourceText: "\u0000",
          Target: ctx.toCode,
          Timestamp: String(Math.floor(Date.now() / 1000)),
          Version: "2018-03-21",
        };
        const rawStr = Object.keys(raw).sort().map((k) => k + "=" + raw[k]).join("&");
        const stringToSign = "POSTtmt.tencentcloudapi.com/?" + rawStr.replace("\u0000", ctx.text);
        const sig = encodeRFC5987(base64(hmacSha1(utf8Bytes(p.secretKey), utf8Bytes(stringToSign))));
        const body = rawStr.replace("\u0000", encodeRFC5987(ctx.text)) + "&Signature=" + sig;
        return {
          method: "POST", url: "https://tmt.tencentcloudapi.com",
          headers: { "content-type": "application/json" },
          body, responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        const r = d && d.Response;
        if (r && r.Error) throw new Error("腾讯云返回错误 " + r.Error.Code + "：" + r.Error.Message);
        return (r && r.TargetText) || "";
      },
    },
    {
      id: "caiyun", name: "彩云小译（中英日互译）", group: "key",
      limits: { chars: 5000 },
      docs: "https://docs.caiyunapp.com/blog/2018/09/03/lingocloud-api/",
      codes: (code) => {
        const c = normalizeLang(code);
        if (c === "zh-CN") return "zh";
        if (c === "zh-TW") return "zh-Hant";
        return lowerBase(c);
      },
      needsSecret: true,
      secretFields: [{ key: "token", label: "彩云小译 Token" }],
      endpoint(ctx) {
        const token = (ctx.parts && ctx.parts.token) || "";
        if (!token) throw new Error("未配置彩云小译 Token");
        if (!M_CAIYUN_ALLOWED[ctx.fromCode] || !M_CAIYUN_ALLOWED[ctx.toCode]) {
          throw new Error("彩云小译仅支持中文 / 英文 / 日文互译");
        }
        return {
          method: "POST", url: "https://api.interpreter.caiyunai.com/v1/translator",
          headers: { "Content-Type": "application/json", "x-authorization": "token " + token },
          body: JSON.stringify({
            source: [ctx.text],
            trans_type: ctx.fromCode + "2" + ctx.toCode,
            request_id: String(Math.floor(Date.now() / 10000)),
            detect: ctx.from === "auto",
          }),
          responseType: "json",
        };
      },
      extract(resp) {
        const d = resp && resp.response;
        if (d && d.message) throw new Error("彩云小译：" + d.message);
        return (d && d.target && d.target[0]) || "";
      },
    },

    /* ---------- 大模型引擎（走当前 AI 通道） ---------- */
    {
      id: "llm", name: "AI 大模型（当前 AI 通道）", group: "llm",
      codes: identity,
      llm: true,
      note: "质量最好、可保留术语；需已登录官方模型或配置自己的模型通道。",
    },
  ];

  /* ==================== 注册表查询 ==================== */

  function get(id) { return SERVICES.find((s) => s.id === id) || null; }
  function list() { return SERVICES.slice(); }

  /* ==================== 密钥（复合 "#" 串） ==================== */

  /** "#" 串 → {fieldKey: value}（按 secretFields 顺序对齐，缺位补空） */
  function parseSecret(id, raw) {
    const svc = get(id);
    const fields = (svc && svc.secretFields) || [];
    const parts = String(raw == null ? "" : raw).split("#");
    const out = {};
    fields.forEach((f, i) => { out[f.key] = String(parts[i] == null ? "" : parts[i]).trim(); });
    return out;
  }

  /** {fieldKey: value} → "#" 串（尾部空段裁掉，保持简洁；中间空段保留占位） */
  function joinSecret(id, obj) {
    const svc = get(id);
    const fields = (svc && svc.secretFields) || [];
    const arr = fields.map((f) => String((obj && obj[f.key]) || "").trim());
    while (arr.length && !arr[arr.length - 1]) arr.pop();
    return arr.join("#");
  }

  /** 是否需要密钥且尚未配置（用于设置界面标记 + 就绪判断） */
  function resolveSecret(id, raw) {
    const svc = get(id);
    if (!svc) return { ok: false, error: "未知引擎" };
    if (!svc.needsSecret) return { ok: true, parts: {} };
    const parts = parseSecret(id, raw);
    const miss = (svc.secretFields || [])
      .filter((f) => !f.optional)
      .filter((f) => !String(parts[f.key] || "").trim())
      .map((f) => f.label || f.key);
    if (miss.length) return { ok: false, error: "缺少：" + miss.join("、"), parts };
    return { ok: true, parts };
  }

  /* ==================== 语言码（对外） ==================== */

  /** 规范码 → 指定引擎的码 */
  function langCode(id, code, isSource) {
    const svc = get(id);
    const c = normalizeLang(code);
    if (!svc || !svc.codes) return c;
    try { return svc.codes(c, !!isSource); } catch (e) { return c; }
  }

  return { SERVICES, get, list, parseSecret, joinSecret, resolveSecret, langCode };
})();
