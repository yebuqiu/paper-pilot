// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译模块 · 语言模型子模块（0.73.0 自 translate.js 拆出）
 *
 * 职责（单一）：语言码的「规范层」。
 *   - LANGS：13 个规范码 + UI 展示名（label）+ 提示词名（name）；
 *   - normalizeLang：把任意输入（显示名 / 规范码 / 厂商码 / 地区变体）归一到规范码，
 *     zh 前缀必须区分简繁，不能盲归简体；
 *   - 各厂商语言码映射表（M_*）与映射助手（mkMap/lowerBase/identity）——
 *     引擎注册表（translate-engines.js）的 codes() 全部以此为数据源。
 *
 * 纯数据 + 纯函数，零外部依赖（不碰 Prefs / Zotero / 网络），可直接离线单测。
 * 装配：main.js files 列表，须在 translate-engines.js 与 translate.js 之前。
 */
/* global */

var TranslateLang = (function () {
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

  /* ==================== 厂商语言码映射（引擎注册表的数据源） ==================== */

  const identity = (code) => code;

  /** 厂商码表 → codes(code) 映射函数：先查表，未命中走 fallbackFn（默认回规范码） */
  function mkMap(map, fallbackFn) {
    return (code) => {
      const c = normalizeLang(code);
      if (map[c]) return map[c];
      return fallbackFn ? fallbackFn(c) : c;
    };
  }

  /** 转小写基础码（用于 LibreTranslate 等用 zh/en 的引擎） */
  const lowerBase = (c) => String(c).split("-")[0].toLowerCase();

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

  return {
    LANGS, normalizeLang, langMeta, langLabel, langName,
    identity, mkMap, lowerBase,
    M_ZH_HANS, M_DEEPL, M_BAIDU, M_TENCENT, M_YOUDAO, M_CAIYUN_ALLOWED,
  };
})();
