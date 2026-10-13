/* PaperPilot 多引擎翻译（0.28.0）
 *
 * 定位：**独立于 AI 大模型**的翻译引擎接入层。此前 PaperPilot 的所有翻译
 * （划词浮窗 / 全文对照 / 标题摘要 / 对比窗口整页）都只能走 OpenAI 兼容大模型，
 * 一旦没登录官方模型、没配自己的模型通道，翻译就完全不可用。
 * 本模块参考 zotero-pdf-translate 的「翻译服务注册表」形态，把翻译拆成
 * 「引擎」这一等公民：每个引擎声明自己的语言码映射、请求构造与响应解析，
 * 上层只调 TranslateSvc.translate()，与具体厂商解耦。
 *
 * 设计要点：
 *   1. 统一接口：{ id, name, group, needsSecret, secretFields, codes(ctx),
 *      prepare?(ctx), endpoint(ctx) -> {method,url,headers,body,responseType},
 *      extract(resp, ctx) -> string }
 *      —— endpoint/extract 是**纯函数**（不碰网络），因此可在 Node 里直接单测；
 *      只有 prepare 允许联网（Bing 需要先取页面里的 IG/token）。
 *   2. 稳定性：单请求超时（可配）+ 预算内重试一次 + **回退链**（主引擎失败自动
 *      依次尝试备用引擎）+ 结果缓存 + 错误归一化（把 HTTP/网络错误翻成人话）。
 *   3. 可扩展：新增厂商 = 在 SERVICES 里加一条；上层零改动。
 *   4. 准确性：语言码统一走 LANGS/normalizeLang（"中文"/"zh"/"zh-Hans" 都归一），
 *      每引擎再映射到自己的码（百度 zh/cht/jp、腾讯 jp/kr、DeepL ZH-HANS…）。
 *   5. 兼容：目标语言沿用既有 pref readerPopupTargetLang（值域由"中文"等显示名
 *      迁移为规范码），源语言/回退链/超时/重试/各引擎密钥存 pref translateCfg。
 *
 * 消费方：reader-popup.js（划词翻译）、bilingual-translate.js（全文对照）、
 *         chat.js（标题摘要）、pdf-compare.js（整页翻译）、prefs-translate.js（设置）。
 */
/* global Zotero, Prefs, AIClient, I18n */

var TranslateSvc = (function () {
  "use strict";

  /* ==================== 语言模型 ==================== */

  // 规范码 → 展示名（UI 用 label）/ 提示名（拼进 prompt 用 name）
  const LANGS = [
    { code: "auto", label: "自动检测", name: "自动" },
    { code: "zh-CN", label: "中文（简体）", name: "中文" },
    { code: "zh-TW", label: "中文（繁體）", name: "繁体中文" },
    { code: "en", label: "English", name: "英文" },
    { code: "ja", label: "日本語", name: "日文" },
    { code: "ko", label: "한국어", name: "韩文" },
    { code: "fr", label: "Français", name: "法文" },
    { code: "de", label: "Deutsch", name: "德文" },
    { code: "es", label: "Español", name: "西班牙文" },
    { code: "ru", label: "Русский", name: "俄文" },
    { code: "pt", label: "Português", name: "葡萄牙文" },
    { code: "it", label: "Italiano", name: "意大利文" },
    { code: "ar", label: "العربية", name: "阿拉伯文" },
  ];

  // 别名表（键一律小写）：显示名 / 各厂商码 / 语言地区变体 → 规范码
  const ALIAS = {
    "中文": "zh-CN", "简体中文": "zh-CN", "简体": "zh-CN",
    "zh": "zh-CN", "zh-cn": "zh-CN", "zh-hans": "zh-CN", "zh-chs": "zh-CN",
    "chinese": "zh-CN", "zh_s": "zh-CN",
    "繁体中文": "zh-TW", "繁體中文": "zh-TW", "繁体": "zh-TW", "正體中文": "zh-TW",
    "zh-tw": "zh-TW", "zh-hant": "zh-TW", "zh-cht": "zh-TW", "zh-hk": "zh-TW",
    "zh-mo": "zh-TW", "zh_t": "zh-TW",
    "english": "en", "英文": "en", "英语": "en", "英語": "en", "en-us": "en", "en-gb": "en",
    "日本語": "ja", "日文": "ja", "日语": "ja", "japanese": "ja", "jp": "ja",
    "한국어": "ko", "韩语": "ko", "韓語": "ko", "korean": "ko", "kr": "ko",
    "français": "fr", "法文": "fr", "法语": "fr", "french": "fr",
    "deutsch": "de", "德文": "de", "德语": "de", "german": "de",
    "español": "es", "西班牙文": "es", "西班牙语": "es", "spanish": "es",
    "русский": "ru", "俄文": "ru", "俄语": "ru", "russian": "ru",
    "português": "pt", "葡萄牙文": "pt", "葡萄牙语": "pt", "portuguese": "pt",
    "italiano": "it", "意大利文": "it", "意大利语": "it", "italian": "it",
    "العربية": "ar", "阿拉伯文": "ar", "阿拉伯语": "ar", "arabic": "ar",
    "自动检测": "auto", "自动识别": "auto", "自动": "auto",
    "auto": "auto", "autodetect": "auto", "auto-detect": "auto", "自动判断": "auto",
  };

  /** 任意输入（显示名/规范码/厂商码/地区变体）→ 规范码；未知则原样返回并去空白 */
  function normalizeLang(input) {
    const s = String(input == null ? "" : input).trim();
    if (!s) return "auto";
    const hit = ALIAS[s.toLowerCase()];
    if (hit) return hit;
    // 未知码：保留（允许用户填厂商专用码），但已知基础语的地区变体归一到规范码
    const b = s.split("-")[0].toLowerCase();
    for (const l of LANGS) {
      if (l.code !== "auto" && l.code.split("-")[0] === b) {
        // zh 前缀必须区分简繁，不能盲归简体
        if (b === "zh") return ALIAS[s.toLowerCase()] || "zh-CN";
        return l.code;
      }
    }
    return s;
  }

  function langMeta(code) {
    const c = normalizeLang(code);
    return LANGS.find((l) => l.code === c) || { code: c, label: c, name: c };
  }
  function langLabel(code) { return langMeta(code).label; }
  function langName(code) { return langMeta(code).name; }

  /* ==================== 编码 / 摘要工具（纯函数，可单测） ==================== */

  /** 字符串 → UTF-8 字节数组 */
  function utf8Bytes(str) {
    const out = [];
    const s = String(str == null ? "" : str);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function rotl(v, b) { return (v << b) | (v >>> (32 - b)); }

  /** SHA-1 → 20 字节数组（FIPS 180-1；插件环境 crypto.subtle 受限，手写） */
  function sha1Bytes(bytes) {
    const b = bytes.slice();
    const bitLen = b.length * 8;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    for (let i = 3; i >= 0; i--) b.push((hi >>> (i * 8)) & 0xff);
    for (let i = 3; i >= 0; i--) b.push((lo >>> (i * 8)) & 0xff);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (let i = 0; i < b.length; i += 64) {
      const w = new Array(80);
      for (let j = 0; j < 16; j++) {
        w[j] = (b[i + j * 4] << 24) | (b[i + j * 4 + 1] << 16) |
               (b[i + j * 4 + 2] << 8) | b[i + j * 4 + 3];
      }
      for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let a = h0, c1 = h1, c2 = h2, c3 = h3, c4 = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (c1 & c2) | (~c1 & c3); k = 0x5a827999; }
        else if (j < 40) { f = c1 ^ c2 ^ c3; k = 0x6ed9eba1; }
        else if (j < 60) { f = (c1 & c2) | (c1 & c3) | (c2 & c3); k = 0x8f1bbcdc; }
        else { f = c1 ^ c2 ^ c3; k = 0xca62c1d6; }
        const tmp = (rotl(a, 5) + f + c4 + k + w[j]) | 0;
        c4 = c3; c3 = c2; c2 = rotl(c1, 30); c1 = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + c1) | 0; h2 = (h2 + c2) | 0;
      h3 = (h3 + c3) | 0; h4 = (h4 + c4) | 0;
    }
    const out = [];
    for (const h of [h0, h1, h2, h3, h4]) {
      for (let i = 3; i >= 0; i--) out.push((h >>> (i * 8)) & 0xff);
    }
    return out;
  }

  /** HMAC-SHA1 → 20 字节数组 */
  function hmacSha1(keyBytes, msgBytes) {
    let key = keyBytes.slice();
    if (key.length > 64) key = sha1Bytes(key);
    while (key.length < 64) key.push(0);
    const ipad = key.map((k) => k ^ 0x36);
    const opad = key.map((k) => k ^ 0x5c);
    const inner = sha1Bytes(ipad.concat(msgBytes));
    return sha1Bytes(opad.concat(inner));
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  /** 字节数组/字符串 → base64（无填充差异，标准表） */
  function base64(input) {
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
  }

  /** 腾讯云老签名要求：encodeURIComponent 后再把 ' ( ) * 转义、空格变 + */
  function encodeRFC5987(str) {
    return encodeURIComponent(str)
      .replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
      .replace(/%20/g, "+");
  }

  /** Google gtx 接口的 tk 令牌（算法取自 google translate 前端，勿改） */
  function googleTk(text) {
    const a = String(text == null ? "" : text);
    const bytes = utf8Bytes(a);
    const RL = (x, s) => {
      for (let c = 0; c < s.length - 2; c += 3) {
        let d = s.charAt(c + 2);
        d = d >= "a" ? d.charCodeAt(0) - 87 : Number(d);
        d = s.charAt(c + 1) === "+" ? x >>> d : x << d;
        x = s.charAt(c) === "+" ? (x + d) & 0xffffffff : (x ^ d);
      }
      return x;
    };
    let b = 406644;
    const b1 = 3293161072;
    for (let f = 0; f < bytes.length; f++) {
      b = RL((b + bytes[f]) & 0xffffffff, "+-a^+6");
    }
    b = RL(b, "+-3^+b+-f");
    b ^= b1 || 0;
    if (b < 0) b = (b & 0x7fffffff) + 0x80000000;
    const v = b % 1e6;
    return String(v) + "." + (v ^ 406644);
  }

  /* ==================== 语言码映射（各厂商） ==================== */

  const identity = (code) => code;

  function mkMap(map, fallbackFn) {
    return (code) => {
      const c = normalizeLang(code);
      if (map[c]) return map[c];
      return fallbackFn ? fallbackFn(c) : c;
    };
  }

  const M_ZH_HANS = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };
  const M_DEEPL = {
    "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT", "pt": "PT-PT", "en": "EN",
  };
  const M_BAIDU = {
    "zh-CN": "zh", "zh-TW": "cht", "en": "en", "ja": "jp", "ko": "kor",
    "fr": "fra", "de": "de", "es": "spa", "ru": "ru", "pt": "pt",
    "it": "it", "ar": "ara",
  };
  const M_TENCENT = {
    "zh-CN": "zh", "zh-TW": "zh-TW", "en": "en", "ja": "ja", "ko": "ko",
    "fr": "fr", "de": "de", "es": "es", "ru": "ru", "pt": "pt",
    "it": "it", "ar": "ar",
  };
  const M_YOUDAO = { "zh-CN": "zh-CHS", "zh-TW": "zh-CHT", "en": "en" };
  const M_CAIYUN_ALLOWED = { "auto": 1, "zh": 1, "en": 1, "ja": 1, "zh-Hant": 1 };

  /** 转小写基础码（用于 LibreTranslate 等用 zh/en 的引擎） */
  const lowerBase = (c) => String(c).split("-")[0].toLowerCase();

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
      extract(resp) {
        const seg = resp && resp.response && resp.response[0];
        if (!Array.isArray(seg)) return "";
        let out = "";
        for (const s of seg) { if (s && s[0]) out += s[0]; }
        return out;
      },
    },
    {
      id: "googleapi", name: "Google 翻译（translate.googleapis.com）", group: "free",
      codes: identity,
      endpoint(ctx) {
        const url = "https://translate.googleapis.com/translate_a/single" +
          "?client=gtx&sl=" + encodeURIComponent(ctx.fromCode) +
          "&tl=" + encodeURIComponent(ctx.toCode) +
          "&dt=t&tk=" + googleTk(ctx.text) + "&q=" + encodeURIComponent(ctx.text);
        return { method: "GET", url, responseType: "json" };
      },
      extract(resp) {
        const seg = resp && resp.response && resp.response[0];
        if (!Array.isArray(seg)) return "";
        let out = "";
        for (const s of seg) { if (s && s[0]) out += s[0]; }
        return out;
      },
    },
    {
      id: "bing", name: "必应翻译（免费接口，实验性）", group: "free",
      experimental: true,
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
      id: "youdao", name: "有道翻译（免费接口）", group: "free",
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
      id: "mymemory", name: "MyMemory（免费，量大限流）", group: "free",
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
        const base = String((ctx.parts && ctx.parts.url) || "").replace(/\/+$/, "");
        if (!base) throw new Error("未配置 LibreTranslate 服务地址");
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
      docs: "https://github.com/OwO-Network/DeepLX",
      codes: (code) => {
        const c = normalizeLang(code);
        return c === "auto" ? "auto" : (M_DEEPL[c] || c.split("-")[0].toUpperCase());
      },
      needsSecret: true,
      secretFields: [{ key: "url", label: "DeepLX 服务地址", placeholder: "https://your-deeplx-host" }],
      endpoint(ctx) {
        const base = String((ctx.parts && ctx.parts.url) || "").replace(/\/+$/, "");
        if (!base) throw new Error("未配置 DeepLX 服务地址");
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

    /* ---------- 需要密钥 ---------- */
    {
      id: "deepl", name: "DeepL（Free / Pro）", group: "key",
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
        const d = resp && resp.response;
        const t = Array.isArray(d) && d[0] && d[0].translations && d[0].translations[0];
        return (t && t.text) || "";
      },
    },
    {
      id: "baidu", name: "百度翻译（开放平台）", group: "key",
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

  function get(id) { return SERVICES.find((s) => s.id === id) || null; }
  function list() { return SERVICES.slice(); }
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

  /* ==================== 语言码（对外） ==================== */

  /** 规范码 → 指定引擎的码 */
  function langCode(id, code, isSource) {
    const svc = get(id);
    const c = normalizeLang(code);
    if (!svc || !svc.codes) return c;
    try { return svc.codes(c, !!isSource); } catch (e) { return c; }
  }

  /* ==================== 配置（pref translateCfg） ==================== */

  const CFG_DEFAULTS = {
    active: "llm",
    fallback: ["google", "bing", "youdao"],
    timeoutMs: 15000,
    retry: 1,
    cache: true,
    secrets: {},
  };

  function cfg() {
    let raw = null;
    try { raw = Prefs.get("translateCfg", ""); } catch (e) { raw = ""; }
    let doc = null;
    try { doc = raw ? JSON.parse(raw) : null; } catch (e) { doc = null; }
    const out = Object.assign({}, CFG_DEFAULTS);
    if (doc && typeof doc === "object") {
      if (doc.active && get(doc.active)) out.active = doc.active;
      if (Array.isArray(doc.fallback)) out.fallback = doc.fallback.filter((x) => get(x));
      if (Number(doc.timeoutMs) > 0) out.timeoutMs = Math.min(120000, Math.max(3000, Number(doc.timeoutMs)));
      if (doc.retry !== undefined) out.retry = doc.retry ? 1 : 0;
      if (doc.cache !== undefined) out.cache = !!doc.cache;
      if (doc.secrets && typeof doc.secrets === "object") out.secrets = doc.secrets;
    }
    return out;
  }

  function saveCfg(patch) {
    const cur = cfg();
    const next = Object.assign({}, cur, patch || {});
    if (next.active && !get(next.active)) next.active = CFG_DEFAULTS.active;
    next.fallback = (Array.isArray(next.fallback) ? next.fallback : []).filter((x) => get(x));
    try { Prefs.set("translateCfg", JSON.stringify(next)); } catch (e) { /* ignore */ }
    return next;
  }

  function setActive(id) {
    if (!get(id)) return { ok: false, error: "未知引擎" };
    saveCfg({ active: id });
    return { ok: true };
  }

  function setSecret(id, value) {
    const svc = get(id);
    if (!svc) return { ok: false, error: "未知引擎" };
    const cur = cfg();
    const secrets = Object.assign({}, cur.secrets);
    const str = typeof value === "object" ? joinSecret(id, value) : String(value == null ? "" : value);
    if (str) secrets[id] = str; else delete secrets[id];
    saveCfg({ secrets });
    return { ok: true };
  }

  function secretOf(id) {
    const c = cfg();
    return (c.secrets && c.secrets[id]) || "";
  }

  /** 目标语言（规范码）：沿用 readerPopupTargetLang，兼容旧的显示名值 */
  function targetCode() {
    let v = "zh-CN";
    try { v = Prefs.get("readerPopupTargetLang", "zh-CN") || "zh-CN"; } catch (e) { /* ignore */ }
    return normalizeLang(v);
  }

  /** 源语言（规范码）：独立 pref translateFromLang，默认自动检测 */
  function sourceCode() {
    let v = "auto";
    try { v = Prefs.get("translateFromLang", "auto") || "auto"; } catch (e) { /* ignore */ }
    return normalizeLang(v);
  }

  /** 目标语言的 prompt 用名（"中文" / "英文" …） */
  function targetName() { return langName(targetCode()); }

  /* ==================== 请求构造 / 响应解析（纯，可直接单测） ==================== */

  /** 组装引擎调用上下文（不联网） */
  function makeCtx(id, o) {
    o = o || {};
    const c = cfg();
    const from = normalizeLang(o.from || sourceCode());
    const to = normalizeLang(o.to || targetCode());
    const rawSecret = o.secret !== undefined ? String(o.secret) : secretOf(id);
    return {
      id,
      text: String(o.text == null ? "" : o.text),
      from, to,
      fromCode: langCode(id, from, true),
      toCode: langCode(id, to, false),
      secret: rawSecret,
      parts: parseSecret(id, rawSecret),
      pre: o.pre || null,
      timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : c.timeoutMs,
    };
  }

  /** 构造请求描述（纯）；llm 引擎返回 null（由 _runEngine 特判） */
  function buildEndpoint(id, ctx) {
    const svc = get(id);
    if (!svc || svc.llm) return null;
    return svc.endpoint(ctx);
  }

  /** 解析响应（纯） */
  function extractResult(id, resp, ctx) {
    const svc = get(id);
    if (!svc || svc.llm) return "";
    return svc.extract(resp, ctx);
  }

  /* ==================== 运行 ==================== */

  const cache = new Map();
  const CACHE_LIMIT = 200;

  function _cacheKey(id, from, to, text) {
    return id + "|" + from + "|" + to + "|" + text;
  }
  function _cacheGet(k) { return cache.has(k) ? cache.get(k) : undefined; }
  function _cacheSet(k, v) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }
  function clearCache() { cache.clear(); }

  /** 网络/HTTP 异常 → 可读中文；带 retryable 标记供重试判定 */
  function _wrapError(e) {
    const status = e && e.xmlhttp && e.xmlhttp.status;
    let detail = "";
    try {
      const resp = e && e.xmlhttp && e.xmlhttp.response;
      detail = (resp && resp.error && (resp.error.message || resp.error)) ||
        (e.xmlhttp && e.xmlhttp.responseText) || "";
    } catch (_) { /* ignore */ }
    if (typeof detail !== "string") detail = "";
    detail = detail.slice(0, 200);
    let msg;
    let retryable = true;
    if (/timed?\s*out|timeout/i.test((e && e.message) || "")) { msg = "请求超时"; }
    else if (status === 401 || status === 403) { msg = "密钥无效或未授权（HTTP " + status + "）"; retryable = false; }
    else if (status === 429) { msg = "请求过于频繁或额度不足（HTTP 429）"; }
    else if (status) { msg = "HTTP " + status; retryable = status >= 500; }
    else { msg = (e && e.message) || String(e); }
    const err = new Error(msg + (detail ? "（" + detail + "）" : ""));
    err.retryable = retryable;
    err.status = status || 0;
    return err;
  }

  async function _http(spec, timeoutMs) {
    const opts = { timeout: timeoutMs || 15000, responseType: spec.responseType || "json" };
    if (spec.headers) opts.headers = spec.headers;
    if (spec.body != null) opts.body = spec.body;
    return await Zotero.HTTP.request(spec.method || "POST", spec.url, opts);
  }

  /** 单次调用某引擎（含预算内重试）；失败抛异常 */
  async function _runEngine(id, ctx, timeoutMs) {
    const svc = get(id);
    if (!svc) throw new Error("未知翻译引擎：" + id);

    if (svc.llm) {
      // 大模型引擎：走当前 AI 通道（划词浮窗的流式路径不在这里，见 reader-popup.js）
      const msgs = [
        { role: "system", content: (Prefs.get("aiSystemPrompt", "") || "") },
        { role: "user", content:
          "请将以下内容翻译成" + langName(ctx.to) +
          "，忠实原文，专业术语保留英文并用括号标注。" +
          "纯文本输出，禁止使用任何 Markdown 标记；只输出译文，不要任何解释。\n\n" + ctx.text },
      ];
      const out = await AIClient.chat(msgs);
      return String(out == null ? "" : out).trim();
    }

    const spec = buildEndpoint(id, ctx);
    if (!spec) throw new Error("该引擎未实现请求构造");

    const budget = timeoutMs || ctx.timeoutMs || 15000;
    const deadline = Date.now() + budget;
    const retry = cfg().retry;
    let lastErr = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        const resp = await _http(spec, Math.max(3000, deadline - Date.now()));
        let out;
        try {
          out = extractResult(id, resp, ctx);
        } catch (pe) {
          // 解析/业务错误（密钥错、参数错、配额用尽…）重试无意义且会白烧额度
          if (pe && pe.retryable === undefined) pe.retryable = false;
          throw pe;
        }
        if (!out || !String(out).trim()) {
          const empty = new Error("引擎返回空结果");
          empty.retryable = true; // 空结果常是网关抖动，允许重试
          throw empty;
        }
        return String(out).trim();
      } catch (e) {
        const wrapped = (e && e.retryable !== undefined) ? e : _wrapError(e);
        lastErr = wrapped;
        if (!wrapped.retryable || attempt >= retry || deadline - Date.now() < 800) break;
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    throw lastErr || new Error("翻译失败");
  }

  /**
   * 解析候选引擎顺序：显式指定 > 活动引擎 + 回退链（去重、跳过不可用）
   */
  function _candidates(o) {
    if (o && o.engine) return [o.engine];
    const c = cfg();
    const seq = [c.active].concat(Array.isArray(o && o.noFallback) && o.noFallback ? [] : c.fallback);
    const seen = new Set();
    const out = [];
    for (const id of seq) {
      if (!id || seen.has(id) || !get(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * 翻译入口。
   * @param text 原文
   * @param o { to?, from?, engine?, secret?, noFallback?, noCache?, timeoutMs? }
   * @returns {Promise<{ok, text?, engine?, engineName?, fallback?, cached?, tried, error?}>}
   *   tried: [{engine, error}] —— 失败过的引擎，供 UI 展示与排障
   */
  async function translate(text, o) {
    o = o || {};
    const clean = String(text == null ? "" : text).trim();
    if (!clean) return { ok: false, error: "没有可翻译的内容", tried: [] };

    const c = cfg();
    const to = normalizeLang(o.to || targetCode());
    const from = normalizeLang(o.from || sourceCode());
    const tried = [];

    const cands = _candidates(o);
    if (!cands.length) return { ok: false, error: "没有可用的翻译引擎", tried };

    for (let i = 0; i < cands.length; i++) {
      const id = cands[i];
      const svc = get(id);
      const useCache = c.cache && !o.noCache;
      const key = _cacheKey(id, from, to, clean);
      if (useCache) {
        const hit = _cacheGet(key);
        if (hit !== undefined) {
          return { ok: true, text: hit, engine: id, engineName: svc.name,
            fallback: i > 0, cached: true, tried };
        }
      }
      // llm 引擎需要 AI 就绪；未就绪直接跳过（避免把「没登录」当成引擎故障）
      if (svc.llm && typeof AIClient !== "undefined" && AIClient && !AIClient.hasKey()) {
        tried.push({ engine: id, error: "AI 不可用（" + (AIClient.guidance ? AIClient.guidance() : "未登录/未配置") + "）" });
        continue;
      }
      if (svc.needsSecret) {
        const r = resolveSecret(id, secretOf(id));
        if (!r.ok) { tried.push({ engine: id, error: r.error }); continue; }
      }
      try {
        const ctx = makeCtx(id, { text: clean, from, to, secret: o.secret, timeoutMs: o.timeoutMs });
        const out = await _runEngine(id, ctx, o.timeoutMs);
        if (useCache) _cacheSet(key, out);
        return { ok: true, text: out, engine: id, engineName: svc.name,
          fallback: i > 0, cached: false, tried };
      } catch (e) {
        tried.push({ engine: id, error: (e && e.message) || String(e) });
      }
    }
    const first = tried[0];
    return {
      ok: false,
      error: first ? first.error : "翻译失败",
      tried,
    };
  }

  /** 设置界面「测试」：指定引擎实测一小段 */
  async function testEngine(id, sample) {
    const svc = get(id);
    if (!svc) return { ok: false, error: "未知引擎" };
    if (svc.needsSecret) {
      const r = resolveSecret(id, secretOf(id));
      if (!r.ok) return { ok: false, error: "请先填写密钥 —— " + r.error };
    }
    if (svc.llm && typeof AIClient !== "undefined" && AIClient && !AIClient.hasKey()) {
      return { ok: false, error: "AI 不可用：" + (AIClient.guidance ? AIClient.guidance() : "未登录/未配置") };
    }
    const text = sample || "Hello, world. This is a translation test.";
    const to = targetCode() === "auto" ? "zh-CN" : targetCode();
    const t0 = Date.now();
    try {
      const ctx = makeCtx(id, { text, to: to === "en" ? "zh-CN" : to, from: "auto" });
      const out = await _runEngine(id, ctx, 20000);
      return { ok: true, engine: id, text: out, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** 活动引擎能否实际翻译（用于浮窗按钮可用性判断） */
  function ready(id) {
    const svc = get(id || cfg().active);
    if (!svc) return false;
    if (svc.llm) return !!(typeof AIClient !== "undefined" && AIClient && AIClient.hasKey());
    if (svc.needsSecret) return resolveSecret(svc.id, secretOf(svc.id)).ok;
    return true;
  }

  function isLLM(id) {
    const svc = get(id || cfg().active);
    return !!(svc && svc.llm);
  }

  /** 是否**存在可用的翻译路径**：活动引擎或任一备用引擎就绪。
   *  浮窗/菜单据此决定翻译入口是否可用（与大模型是否就绪解耦）。 */
  function available() {
    const c = cfg();
    const seq = [c.active].concat(Array.isArray(c.fallback) ? c.fallback : []);
    const seen = new Set();
    for (const id of seq) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (ready(id)) return true;
    }
    return false;
  }

  /** 活动引擎不可用时，给一句可执行指引（浮窗/菜单提示用） */
  function unavailableHint() {
    const svc = activeEngine();
    if (svc && svc.llm) {
      return typeof AIClient !== "undefined" && AIClient && AIClient.guidance
        ? AIClient.guidance()
        : "当前翻译引擎需要 AI，但 AI 不可用";
    }
    if (svc && svc.needsSecret) {
      const r = resolveSecret(svc.id, secretOf(svc.id));
      return "翻译引擎「" + svc.name + "」" + (r.error || "未配置");
    }
    return "请在 设置 → PaperPilot → 翻译引擎 中选择并配置一个翻译引擎";
  }

  function activeEngine() {
    const c = cfg();
    return get(c.active) || null;
  }

  /* ==================== 迁移 ==================== */

  /** 一次性迁移：把 readerPopupTargetLang 的旧显示名值（"中文"）改成规范码 */
  function migrate() {
    try {
      if (!Prefs.get("translateMigrated28", false)) {
        const cur = String(Prefs.get("readerPopupTargetLang", "") || "");
        if (cur && normalizeLang(cur) !== cur) {
          Prefs.set("readerPopupTargetLang", normalizeLang(cur));
        }
        Prefs.set("translateMigrated28", true);
      }
    } catch (e) { /* ignore */ }
    try {
      const raw = Prefs.get("translateCfg", "");
      if (!raw) saveCfg({});
    } catch (e) { /* ignore */ }
  }

  /** 供设置界面渲染：全部引擎 + 当前状态 */
  function overview() {
    const c = cfg();
    return {
      cfg: c,
      active: c.active,
      target: targetCode(),
      targetLabel: langLabel(targetCode()),
      source: sourceCode(),
      sourceLabel: langLabel(sourceCode()),
      services: SERVICES.map((s) => {
        const needsSecret = !!s.needsSecret;
        const configured = needsSecret ? resolveSecret(s.id, secretOf(s.id)).ok : true;
        return {
          id: s.id, name: s.name, group: s.group || "free",
          needsSecret, configured, experimental: !!s.experimental,
          docs: s.docs || "", note: s.note || "",
          secretFields: s.secretFields || [],
          secretRaw: secretOf(s.id),
          isLLM: !!s.llm,
          enabled: s.id === c.active,
          inFallback: c.fallback.indexOf(s.id) >= 0,
        };
      }),
      langs: LANGS.slice(),
    };
  }

  return {
    // 语言
    LANGS, normalizeLang, langMeta, langLabel, langName, langCode,
    // 引擎
    SERVICES, get, list, activeEngine, isLLM, ready, available, unavailableHint, overview,
    // 密钥
    parseSecret, joinSecret, resolveSecret,
    // 纯构造/解析（测试用）
    makeCtx, buildEndpoint, extractResult,
    // 算法（测试用）
    googleTk, sha1Bytes, hmacSha1, base64, encodeRFC5987, utf8Bytes,
    // 配置
    cfg, saveCfg, setActive, setSecret, secretOf, targetCode, sourceCode, targetName,
    // 运行
    translate, testEngine, clearCache,
    // 迁移
    migrate,
  };
})();
