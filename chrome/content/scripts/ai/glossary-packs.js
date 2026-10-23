// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 内置领域术语种子词包（0.4x，配套「术语表与全文翻译优化」领域化升级）
 *
 * 是什么：按学科领域组织的中英术语种子数据（参考机器之心 AITD「专项领域篇」、
 * hotvulcan/finance_i18n、meddict 等开源术语库的领域分档组织方式），供设置面板
 * 「领域词包」一键追加到用户术语表。每条 {s, t, d}：d 为领域标签（与行式
 * `原文 = 译文 | 领域` 第三段同语义，受 translateGlossaryDomains 启停过滤）。
 *
 * 数据纪律：
 *   - 全部为**自编高置信常用译法**（社区通行、教科书主流），不抄录任何
 *     版权受限词库（微软术语集许可、商业词典等一概不取）；
 *   - 每包控制在 ~20 条「高频且译法分歧大」的术语——种子是起点不是词典，
 *     面板导入后用户可自由增删改；
 *   - 只对 en→zh 方向有意义（本项目主场景）；其他语言对由用户自行导入。
 *
 * 加载：main.js files 列表（translate.js 之后）；挂 Zotero.Papilot.glossaryPacks。
 * 消费：prefs-translate.js（内置词包「添加」按钮 → TranslateSvc.mergeGlossary 行级 upsert；
 *        在线词包目录 → fetchCatalog/fetchDomain → 同一条导入链）。
 */
/* global Zotero, Prefs */

var GlossaryPacks = (function () {
  "use strict";

  const PACKS = [
    {
      id: "cs-ai",
      label: "计算机 / 人工智能",
      desc: "CS 与 AI 高频术语（transformer / fine-tuning 等译法分歧大户）",
      terms: [
        { s: "transformer", t: "Transformer", d: "计算机" },
        { s: "large language model", t: "大语言模型", d: "计算机" },
        { s: "fine-tuning", t: "微调", d: "计算机" },
        { s: "pre-training", t: "预训练", d: "计算机" },
        { s: "reinforcement learning", t: "强化学习", d: "计算机" },
        { s: "supervised learning", t: "监督学习", d: "计算机" },
        { s: "graph neural network", t: "图神经网络", d: "计算机" },
        { s: "convolutional neural network", t: "卷积神经网络", d: "计算机" },
        { s: "attention mechanism", t: "注意力机制", d: "计算机" },
        { s: "embedding", t: "嵌入表示", d: "计算机" },
        { s: "inference", t: "推理", d: "计算机" },
        { s: "hallucination", t: "幻觉", d: "计算机" },
        { s: "prompt", t: "提示词", d: "计算机" },
        { s: "tokenizer", t: "分词器", d: "计算机" },
        { s: "benchmark", t: "基准测试", d: "计算机" },
        { s: "ablation study", t: "消融实验", d: "计算机" },
        { s: "state-of-the-art", t: "最先进水平", d: "计算机" },
        { s: "zero-shot learning", t: "零样本学习", d: "计算机" },
        { s: "retrieval-augmented generation", t: "检索增强生成", d: "计算机" },
        { s: "mixture of experts", t: "专家混合", d: "计算机" },
      ],
    },
    {
      id: "med",
      label: "医学",
      desc: "临床与基础医学高频术语（译法易错、一致性要求最高的一类）",
      terms: [
        { s: "myocardial infarction", t: "心肌梗死", d: "医学" },
        { s: "hypertension", t: "高血压", d: "医学" },
        { s: "diabetes mellitus", t: "糖尿病", d: "医学" },
        { s: "cerebrovascular accident", t: "脑血管意外", d: "医学" },
        { s: "randomized controlled trial", t: "随机对照试验", d: "医学" },
        { s: "meta-analysis", t: "荟萃分析", d: "医学" },
        { s: "odds ratio", t: "比值比", d: "医学" },
        { s: "confidence interval", t: "置信区间", d: "医学" },
        { s: "sensitivity", t: "灵敏度", d: "医学" },
        { s: "specificity", t: "特异度", d: "医学" },
        { s: "adverse event", t: "不良事件", d: "医学" },
        { s: "contraindication", t: "禁忌证", d: "医学" },
        { s: "comorbidity", t: "合并症", d: "医学" },
        { s: "prognosis", t: "预后", d: "医学" },
        { s: "informed consent", t: "知情同意", d: "医学" },
        { s: "case-control study", t: "病例对照研究", d: "医学" },
        { s: "cohort study", t: "队列研究", d: "医学" },
        { s: "placebo", t: "安慰剂", d: "医学" },
        { s: "biomarker", t: "生物标志物", d: "医学" },
        { s: "systematic review", t: "系统综述", d: "医学" },
      ],
    },
    {
      id: "fin",
      label: "经济 / 金融",
      desc: "经济学与金融学高频术语（对应 finance_i18n 等开源财务词表的常用子集）",
      terms: [
        { s: "return on investment", t: "投资回报率", d: "金融" },
        { s: "earnings per share", t: "每股收益", d: "金融" },
        { s: "price-to-earnings ratio", t: "市盈率", d: "金融" },
        { s: "volatility", t: "波动率", d: "金融" },
        { s: "hedging", t: "套期保值", d: "金融" },
        { s: "arbitrage", t: "套利", d: "金融" },
        { s: "derivative", t: "衍生品", d: "金融" },
        { s: "liquidity", t: "流动性", d: "金融" },
        { s: "asset allocation", t: "资产配置", d: "金融" },
        { s: "fiscal policy", t: "财政政策", d: "金融" },
        { s: "monetary policy", t: "货币政策", d: "金融" },
        { s: "quantitative easing", t: "量化宽松", d: "金融" },
        { s: "gross domestic product", t: "国内生产总值", d: "金融" },
        { s: "inflation", t: "通货膨胀", d: "金融" },
        { s: "default risk", t: "违约风险", d: "金融" },
        { s: "portfolio diversification", t: "投资组合分散化", d: "金融" },
        { s: "bear market", t: "熊市", d: "金融" },
        { s: "initial public offering", t: "首次公开募股", d: "金融" },
        { s: "securitization", t: "资产证券化", d: "金融" },
        { s: "opportunity cost", t: "机会成本", d: "金融" },
      ],
    },
    {
      id: "law",
      label: "法律",
      desc: "法学与合规高频术语（大陆法 / 普通法通行概念）",
      terms: [
        { s: "jurisdiction", t: "管辖权", d: "法律" },
        { s: "precedent", t: "判例", d: "法律" },
        { s: "tort", t: "侵权", d: "法律" },
        { s: "consideration", t: "对价", d: "法律" },
        { s: "force majeure", t: "不可抗力", d: "法律" },
        { s: "arbitration clause", t: "仲裁条款", d: "法律" },
        { s: "intellectual property", t: "知识产权", d: "法律" },
        { s: "due diligence", t: "尽职调查", d: "法律" },
        { s: "burden of proof", t: "举证责任", d: "法律" },
        { s: "strict liability", t: "严格责任", d: "法律" },
        { s: "breach of contract", t: "违约", d: "法律" },
        { s: "injunctive relief", t: "禁令救济", d: "法律" },
        { s: "statute of limitations", t: "诉讼时效", d: "法律" },
        { s: "class action", t: "集体诉讼", d: "法律" },
        { s: "confidentiality clause", t: "保密条款", d: "法律" },
        { s: "indemnification", t: "补偿条款", d: "法律" },
        { s: "legal person", t: "法人", d: "法律" },
        { s: "applicable law", t: "适用法律", d: "法律" },
        { s: "waiver", t: "权利放弃", d: "法律" },
        { s: "hearsay evidence", t: "传闻证据", d: "法律" },
      ],
    },
  ];

  function list() { return PACKS.map((p) => ({ id: p.id, label: p.label, desc: p.desc, count: p.terms.length })); }
  function get(id) {
    const p = PACKS.find((x) => x.id === id);
    return p ? { id: p.id, label: p.label, count: p.terms.length, terms: p.terms.slice() } : null;
  }

  /* ==================== 在线词包目录（0.4x：对接 GitHub 开源库 open-termbank） ====================
   * 数据源：https://github.com/yebuqiu/open-termbank ——多学科中英术语对照数据库
   * （数据 CC BY 4.0）。同步协议 = 轮询 index.json（version + 每域 sha256 + count），
   * 按域增量拉取 CSV（source,target,domain 三列，恰好是 TranslateSvc.parseGlossaryImport
   * 认识的带表头形态；领域标签与本地内置词包同用中文域标签，chips 无缝衔接）。
   *
   * URL 策略：① pref translateGlossaryPackBase 自定义镜像（空=不用；被墙网络可指
   * Gitee 镜像或本地代理）→ ② jsDelivr CDN（终端用户网络通常可达，带缓存）→
   * ③ raw.githubusercontent.com 直链。index.json 请求带时间戳参数防 CDN 旧档
   * （域 CSV 内容寻址、无需防缓存）。
   */

  // 2026-10-23 实测：cdn.jsdelivr.net 在国内直连**不可达**（000/间歇 404），
  // raw.githubusercontent.com 同样不可达 —— 只留这两条 = 国内用户点「获取在线目录」必失败。
  // fastly.jsdelivr.net 是 jsDelivr 的另一个边缘域名，内容完全一致且实测 200（2.2.0 / 28 域）。
  // 顺序：fastly → cdn（哪条通走哪条，失败自动换下一条）。
  const ONLINE_BASES = [
    "https://fastly.jsdelivr.net/gh/yebuqiu/open-termbank@main/data/",
    "https://cdn.jsdelivr.net/gh/yebuqiu/open-termbank@main/data/",
    "https://raw.githubusercontent.com/yebuqiu/open-termbank/main/data/",
  ];

  /** 生效的取用基址列表：自定义镜像（pref）优先，然后 jsDelivr、raw。 */
  function onlineBases() {
    let custom = "";
    try { custom = String(Prefs.get("translateGlossaryPackBase", "") || "").trim(); } catch (e) { /* ignore */ }
    const out = [];
    if (custom) {
      if (!/^https?:\/\//i.test(custom)) custom = "https://" + custom;
      out.push(custom.charAt(custom.length - 1) === "/" ? custom : custom + "/");
    }
    return out.concat(ONLINE_BASES);
  }

  function _httpGet(url, timeoutMs) {
    return Zotero.HTTP.request("GET", url, {
      responseType: "text",
      timeout: timeoutMs || 15000,
    });
  }

  /** 拉取在线目录（index.json）。@returns {Promise<{ok, index?, error?, via?}>} */
  async function fetchCatalog() {
    if (typeof Zotero === "undefined" || !Zotero || !Zotero.HTTP) {
      return { ok: false, error: "HTTP 不可用" };
    }
    const bases = onlineBases();
    let lastErr = "";
    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      // index.json 必须新鲜（否则「有更新」检测滞后）；带时间戳参数破 CDN 缓存
      // （任一 jsdelivr 边缘都要加：现在第一个 base 就是 fastly）
      const bust = (base.indexOf("jsdelivr") >= 0) ? "?_=" + Date.now() : "";
      try {
        const req = await _httpGet(base + "index.json" + bust, 12000);
        if (req.status !== 200 && req.status !== undefined) throw new Error("HTTP " + req.status);
        const text = String(req.responseText || "");
        const idx = JSON.parse(text);
        if (!idx || !Array.isArray(idx.domains) || !idx.domains.length) {
          throw new Error("目录结构异常（无 domains）");
        }
        // 基本形状校验：每域带 file/count/sha256
        for (const d of idx.domains) {
          if (!d || !d.file || !d.slug || !(d.count >= 0) || !d.sha256) {
            throw new Error("目录条目缺字段（file/slug/count/sha256）");
          }
        }
        return { ok: true, index: idx, via: base };
      } catch (e) {
        lastErr = String((e && e.message) || e);
        // 试下一个基址（jsDelivr 挂了走 raw；都挂了报最后错误）
      }
    }
    return { ok: false, error: lastErr || "全部取用地址不可达" };
  }

  /** 拉取某域 CSV 文本。@param base fetchCatalog 返回的 via（同一基址，吃 CDN 缓存） */
  async function fetchDomain(slug, base) {
    if (typeof Zotero === "undefined" || !Zotero || !Zotero.HTTP) {
      return { ok: false, error: "HTTP 不可用" };
    }
    const bases = base ? [base].concat(onlineBases()) : onlineBases();
    let lastErr = "";
    for (const b of bases) {
      try {
        const req = await _httpGet(b + slug + ".csv", 20000);
        if (req.status !== 200 && req.status !== undefined) throw new Error("HTTP " + req.status);
        const text = String(req.responseText || "");
        if (!text || text.charAt(0) === "{" || text.indexOf("404") === 0) throw new Error("响应不是 CSV");
        return { ok: true, text, via: b };
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
    return { ok: false, error: lastErr || "取用地址不可达" };
  }

  return { list, get, fetchCatalog, fetchDomain, onlineBases };
})();
