// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 元数据规则补齐（0.24.0，功能借鉴 zotero-format-metadata 的规则视野）
 *
 * 与既有「元数据规范清洗」(meta-lint) 的分工：
 *   meta-lint  = 格式规范化（DOI 去前缀、日期 2024/3/5→2024-03-05、标题去尾点、URL 去跟踪参数），
 *                命中即静默修，无信息损失。
 *   meta-rules = **语义体检 + 勾选修复**：
 *     1) 期刊缩写 ↔ 全称互转（内置常用刊表 + 用户自定义 pref；默认方向=展开为全称）
 *     2) 作者名归一化（"Last, First" 逆序、单栏姓名拆分、全角空格/多余空白、尾随句点）
 *     3) DOI 有效性体检（格式校验；纯报告，规范化交给 meta-lint）
 *     4) 条目类型字段完整性（journalArticle 缺期刊名等）+ 扫描范围内重复 DOI
 *
 * 交互纪律（与标签治理一致）：**先出问题清单 → 用户勾选 → 才写库**；
 * 无自动修复值的「提示类」只展示、不给勾选框。
 *
 * 可测性：所有 detect() 只吃 plain snapshot（见 snapshot()），不碰 Zotero 对象，
 * 因此核心逻辑可完全离线单测；applyHit() 才落到真实条目。
 */
/* global Zotero, Prefs, I18n, ItemSel, MdLite */

var MetaRules = {
  /* ---------------- 内置常用刊名表 [缩写, 全称] ----------------
   * 全称统一不带前缀 "The"（匹配时归一化会剥掉），"&" 与 "and" 归一化等价。
   * 用户可在设置里用 metaRulesJournals 追加/覆盖，每行 "缩写=全称"。 */
  JOURNAL_MAP: [
    ["N Engl J Med", "New England Journal of Medicine"],
    ["Lancet", "Lancet"],
    ["Lancet Oncol", "Lancet Oncology"],
    ["Lancet Neurol", "Lancet Neurology"],
    ["Lancet Infect Dis", "Lancet Infectious Diseases"],
    ["Nat Med", "Nature Medicine"],
    ["Nat Genet", "Nature Genetics"],
    ["Nat Commun", "Nature Communications"],
    ["Nat Biotechnol", "Nature Biotechnology"],
    ["Nat Methods", "Nature Methods"],
    ["Nat Neurosci", "Nature Neuroscience"],
    ["Nat Cell Biol", "Nature Cell Biology"],
    ["Nat Immunol", "Nature Immunology"],
    ["Nat Mater", "Nature Materials"],
    ["Nat Phys", "Nature Physics"],
    ["Nat Chem", "Nature Chemistry"],
    ["Nat Energy", "Nature Energy"],
    ["Nat Clim Chang", "Nature Climate Change"],
    ["Nat Sustain", "Nature Sustainability"],
    ["Nat Rev Mol Cell Biol", "Nature Reviews Molecular Cell Biology"],
    ["Nat Rev Drug Discov", "Nature Reviews Drug Discovery"],
    ["Nat Rev Genet", "Nature Reviews Genetics"],
    ["Cell Rep", "Cell Reports"],
    ["Cell Metab", "Cell Metabolism"],
    ["Cell Host Microbe", "Cell Host & Microbe"],
    ["Proc Natl Acad Sci U S A", "Proceedings of the National Academy of Sciences"],
    ["Sci Adv", "Science Advances"],
    ["Sci Transl Med", "Science Translational Medicine"],
    ["Sci Rep", "Scientific Reports"],
    ["Sci Total Environ", "Science of the Total Environment"],
    ["J Am Chem Soc", "Journal of the American Chemical Society"],
    ["Angew Chem Int Ed", "Angewandte Chemie International Edition"],
    ["Chem Soc Rev", "Chemical Society Reviews"],
    ["Chem Rev", "Chemical Reviews"],
    ["Phys Rev Lett", "Physical Review Letters"],
    ["Phys Rev B", "Physical Review B"],
    ["Phys Rev D", "Physical Review D"],
    ["Phys Rev X", "Physical Review X"],
    ["Rev Mod Phys", "Reviews of Modern Physics"],
    ["IEEE Trans Pattern Anal Mach Intell", "IEEE Transactions on Pattern Analysis and Machine Intelligence"],
    ["IEEE Trans Neural Netw Learn Syst", "IEEE Transactions on Neural Networks and Learning Systems"],
    ["IEEE Trans Image Process", "IEEE Transactions on Image Processing"],
    ["IEEE Trans Inf Theory", "IEEE Transactions on Information Theory"],
    ["IEEE Trans Knowl Data Eng", "IEEE Transactions on Knowledge and Data Engineering"],
    ["IEEE Trans Med Imaging", "IEEE Transactions on Medical Imaging"],
    ["IEEE Trans Signal Process", "IEEE Transactions on Signal Processing"],
    ["IEEE Trans Commun", "IEEE Transactions on Communications"],
    ["IEEE Trans Antennas Propag", "IEEE Transactions on Antennas and Propagation"],
    ["IEEE Trans Power Syst", "IEEE Transactions on Power Systems"],
    ["IEEE Trans Ind Electron", "IEEE Transactions on Industrial Electronics"],
    ["IEEE Internet Things J", "IEEE Internet of Things Journal"],
    ["JMLR", "Journal of Machine Learning Research"],
    ["Neural Comput", "Neural Computation"],
    ["Mach Learn", "Machine Learning"],
    ["Artif Intell", "Artificial Intelligence"],
    ["Pattern Recognit", "Pattern Recognition"],
    ["J Neurosci", "Journal of Neuroscience"],
    ["J Biol Chem", "Journal of Biological Chemistry"],
    ["Nucleic Acids Res", "Nucleic Acids Research"],
    ["Genome Biol", "Genome Biology"],
    ["Genome Res", "Genome Research"],
    ["Mol Biol Cell", "Molecular Biology of the Cell"],
    ["EMBO J", "EMBO Journal"],
    ["Eur Heart J", "European Heart Journal"],
    ["J Clin Oncol", "Journal of Clinical Oncology"],
    ["J Clin Invest", "Journal of Clinical Investigation"],
    ["J Hepatol", "Journal of Hepatology"],
    ["Cochrane Database Syst Rev", "Cochrane Database of Systematic Reviews"],
    ["Ann Intern Med", "Annals of Internal Medicine"],
    ["Am J Respir Crit Care Med", "American Journal of Respiratory and Critical Care Medicine"],
    ["Environ Sci Technol", "Environmental Science & Technology"],
    ["J Clean Prod", "Journal of Cleaner Production"],
    ["Renew Sustain Energy Rev", "Renewable and Sustainable Energy Reviews"],
    ["Energy Environ Sci", "Energy & Environmental Science"],
    ["Appl Energy", "Applied Energy"],
    ["Water Res", "Water Research"],
    ["Atmos Chem Phys", "Atmospheric Chemistry and Physics"],
    ["J Geophys Res", "Journal of Geophysical Research"],
    ["Geophys Res Lett", "Geophysical Research Letters"],
    ["Mon Not R Astron Soc", "Monthly Notices of the Royal Astronomical Society"],
    ["MNRAS", "Monthly Notices of the Royal Astronomical Society"],
    ["Astrophys J", "Astrophysical Journal"],
    ["Astron J", "Astronomical Journal"],
    ["ACM Trans Graph", "ACM Transactions on Graphics"],
    ["Commun ACM", "Communications of the ACM"],
    ["J ACM", "Journal of the ACM"],
    ["SIAM Rev", "SIAM Review"],
    ["Ann Stat", "Annals of Statistics"],
    ["J Am Stat Assoc", "Journal of the American Statistical Association"],
    ["Am Econ Rev", "American Economic Review"],
    ["Q J Econ", "Quarterly Journal of Economics"],
    ["J Finance", "Journal of Finance"],
    ["Psychol Bull", "Psychological Bulletin"],
    ["Psychol Sci", "Psychological Science"],
    ["J Pers Soc Psychol", "Journal of Personality and Social Psychology"],
    ["Annu Rev Psychol", "Annual Review of Psychology"],
    ["Adv Mater", "Advanced Materials"],
    ["Adv Funct Mater", "Advanced Functional Materials"],
    ["Nano Lett", "Nano Letters"],
    ["J Mater Chem A", "Journal of Materials Chemistry A"],
    ["Acta Mater", "Acta Materialia"],
    ["Comput Phys Commun", "Computer Physics Communications"],
    ["J Comput Phys", "Journal of Computational Physics"],
    ["SIAM J Sci Comput", "SIAM Journal on Scientific Computing"],
  ],

  /* 条目类型 → 该类型「按理必须有」的字段（缺了只提示，不自动填） */
  REQUIRED_FIELDS: {
    journalArticle: [["publicationTitle", "期刊名"]],
    conferencePaper: [["proceedingsTitle", "会议论文集名"]],
    book: [["publisher", "出版社"]],
    thesis: [["university", "授予单位"]],
    report: [["institution", "机构"]],
    patent: [["issuingAuthority", "授予机构"]],
  },

  /* DOI 合法性：必须允许 **shortDOI**（Crossref 的 `10/xxxxxx` 短形式）。
     真机验证教训：原正则 `^10\.\d{4,9}\/…` 把真实库里的 71 条 shortDOI
     全部误报成「语法不符」——这是一整类合法 DOI。
     尾段用 `\S+`（不出现空白即可），避免对 Wiley 旧式含 < > ( ) 的合法 DOI 误报。 */
  DOI_RE: /^10(\.\d+)?\/\S+$/,

  /** 是否缩写体刊名：存在「1–4 字符 + 句点」的词（Ann. / J. / Res.）即视为缩写，不应去尾点 */
  looksAbbrevJournal(s) {
    return /(?:^|\s)\S{1,4}\./.test(String(s || ""));
  },

  /* ---------------- 纯函数工具 ---------------- */

  /** 期刊名归一化：小写、去掉点号、& → and、仅留字母数字与单空格 */
  normJournal(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[.,]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  },

  /** 通用空白归一：全角空格 → 半角、折叠连续空白、去首尾 */
  normSpace(s) {
    return String(s == null ? "" : s)
      .replace(/[\u00a0\u3000]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  /** 构建期刊索引（内置 + 用户 pref "缩写=全称" 每行一条；用户可覆盖内置） */
  journalIndex(prefText) {
    const abbr = new Map(); // normAbbrev -> 全称（显示用）
    const full = new Map(); // normFull    -> 缩写（显示用）
    const add = (a, f) => {
      a = this.normSpace(a); f = this.normSpace(f);
      if (!a || !f || a === f) return;
      abbr.set(this.normJournal(a), f);
      full.set(this.normJournal(f), a);
    };
    for (const [a, f] of this.JOURNAL_MAP) add(a, f);
    for (const line of String(prefText || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      add(t.slice(0, i), t.slice(i + 1));
    }
    return { abbr, full, size: abbr.size };
  },

  /**
   * 期刊方向提示
   * @param {string} value 当前 publicationTitle
   * @param {{abbr:Map, full:Map}} idx
   * @param {"expand"|"abbrev"|"both"|"off"} dir
   * @returns {{to:string, dir:string}|null}
   */
  journalHint(value, idx, dir) {
    const v = this.normSpace(value);
    if (!v || dir === "off") return null;
    const n = this.normJournal(v);
    if ((dir === "expand" || dir === "both") && idx.abbr.has(n)) {
      const to = idx.abbr.get(n);
      if (to !== v) return { to, dir: "expand" };
    }
    if ((dir === "abbrev" || dir === "both") && idx.full.has(n)) {
      const to = idx.full.get(n);
      if (to !== v) return { to, dir: "abbrev" };
    }
    return null;
  },

  /**
   * 作者名归一化（纯函数）
   * @param {Array<{creatorType?:string,firstName?:string,lastName?:string,name?:string}>} creators
   * @returns {{creators:Array, notes:string[]}|null} 无变化返回 null
   */
  normalizeCreators(creators) {
    if (!Array.isArray(creators) || !creators.length) return null;
    const out = [];
    const notes = [];
    let changed = false;
    for (const c of creators) {
      const n = {
        creatorType: c.creatorType || "author",
        firstName: this.normSpace(c.firstName),
        lastName: this.normSpace(c.lastName),
        name: this.normSpace(c.name),
      };
      // 单栏模式：name 有值、姓名为空
      if (n.name && !n.lastName && !n.firstName) {
        const parts = n.name.split(" ");
        // 只处理「两段」的拉丁姓名（"John Smith" → First=John, Last=Smith），
        // 中文/机构名/多段名一律不动，避免破坏性拆分
        if (parts.length === 2 && /^[A-Za-z][A-Za-z'’.-]*$/.test(parts[0]) && /^[A-Za-z][A-Za-z'’.-]*$/.test(parts[1])) {
          n.firstName = parts[0];
          n.lastName = parts[1];
          n.name = "";
          notes.push("单栏姓名拆分为「名 姓」");
        }
      } else if (n.lastName && n.lastName.includes(",")) {
        // "Smith, John" 被整体塞进 lastName
        const i = n.lastName.indexOf(",");
        const last = this.normSpace(n.lastName.slice(0, i));
        const first = this.normSpace(n.lastName.slice(i + 1));
        if (last && first) {
          n.lastName = last;
          n.firstName = this.normSpace(n.firstName ? n.firstName + " " + first : first);
          notes.push("逗号姓名还原为「姓 / 名」两栏");
        }
      }
      // 尾随句点（"Smith Jr." 保留；只去「姓名末尾孤立句点」）
      const stripDot = (s) => (s && /[A-Za-z]\.$/.test(s) && !/\b(Jr|Sr|III|II|IV|Ph\.D|M\.D)\.?$/i.test(s) ? s.replace(/\.$/, "") : s);
      n.lastName = stripDot(n.lastName);
      n.firstName = stripDot(n.firstName);
      // 变更判定的基线必须是**原样值**（不 trim）：否则「首尾空白/全角空格」
      // 这类改动会被 trim 后的基线抹平 → 检测不到（实踩）。
      const orig = {
        firstName: String(c.firstName == null ? "" : c.firstName),
        lastName: String(c.lastName == null ? "" : c.lastName),
        name: String(c.name == null ? "" : c.name),
      };
      if (n.firstName !== orig.firstName || n.lastName !== orig.lastName || n.name !== orig.name) changed = true;
      out.push(n);
    }
    return changed ? { creators: out, notes: [...new Set(notes)] } : null;
  },

  /** DOI 有效性体检（返回提示串或 null） */
  doiHint(value) {
    const s = this.normSpace(value);
    if (!s) return null;
    if (/^https?:\/\//i.test(s) || /^doi:\s*/i.test(s)) return "DOI 含 URL/doi: 前缀（用「元数据规范清洗」可自动去掉）";
    if (/\s/.test(String(value))) return "DOI 含空格，DOI 不应有空白字符";
    // 接受 shortDOI（10/xxxxxx，Crossref 官方短形式）与常规 10.xxxx/…
    if (!this.DOI_RE.test(s)) return "不符合 DOI 语法（应为 10.xxxx/… 或 shortDOI 形式 10/…）";
    return null;
  },

  /** 页码/卷号格式归一（纯函数） */
  fixPages(v) {
    const s = this.normSpace(v);
    if (!s) return null;
    const n = s.replace(/\s*[-–—]+\s*/g, "-");
    return n !== s ? n : null;
  },

  fixVolume(v) {
    const s = this.normSpace(v);
    if (!s) return null;
    const n = s.replace(/\s*[-–—]+\s*/g, "-");
    return n !== s ? n : null;
  },

  /* ---------------- 快照与检测 ---------------- */

  /** Zotero 条目 → plain snapshot（只读；测试可直接构造同形对象） */
  snapshot(item) {
    const g = (f) => { try { return String(item.getField(f) || ""); } catch (e) { return ""; } };
    let itemType = "";
    try { itemType = item.itemType || (item.getItemType && item.getItemType()) || ""; } catch (e) { itemType = ""; }
    let key = "";
    try { key = item.key || ""; } catch (e) { key = ""; }
    let title = "";
    try { title = (item.getDisplayTitle && item.getDisplayTitle()) || g("title"); } catch (e) { title = g("title"); }
    let creators = [];
    try {
      creators = (item.getCreators() || []).map((c) => ({
        creatorType: c.creatorType || "author",
        firstName: c.firstName || "",
        lastName: c.lastName || "",
        name: c.name || "",
      }));
    } catch (e) { creators = []; }
    return {
      key, title, itemType,
      fields: {
        title: g("title"),
        publicationTitle: g("publicationTitle"),
        proceedingsTitle: g("proceedingsTitle"),
        DOI: g("DOI"),
        pages: g("pages"),
        volume: g("volume"),
        language: g("language"),
        // REQUIRED_FIELDS 会用到的字段必须一并读出，否则「类型必备字段」规则
        // 会对所有条目误报「缺少 X」（字段没被快照 → 判定为空）
        publisher: g("publisher"),
        university: g("university"),
        institution: g("institution"),
        issuingAuthority: g("issuingAuthority"),
      },
      creators,
    };
  },

  /**
   * 规则集。每个规则：
   *   kind: "fix"  → detect 返回 {field, from, to, note}（可勾选修复）
   *   kind: "warn" → detect 返回 {note}（只提示）
   * detect(snap, ctx) 为纯函数。
   */
  RULES: [
    {
      id: "journal", label: "期刊缩写/全称", kind: "fix", group: "期刊",
      detect(s, ctx) {
        const h = MetaRules.journalHint(s.fields.publicationTitle, ctx.journal, ctx.journalDir);
        if (!h) return [];
        return [{
          field: "publicationTitle",
          from: s.fields.publicationTitle,
          to: h.to,
          note: h.dir === "expand" ? "缩写 → 全称" : "全称 → 缩写",
        }];
      },
    },
    {
      id: "journalDot", label: "期刊名尾随句点", kind: "fix", group: "期刊",
      detect(s) {
        const v = s.fields.publicationTitle;
        if (!v) return [];
        // ★ 真机验证后加的保护：缩写体刊名（Ann. Neurol. / J. Child Neurol. / Psychiatry Res.）
        // 的末尾句点是**缩写规范的一部分**，去掉反而破坏；只有「全称末尾多了一个句点」
        // （如 Nature. / Science.）才该清理。
        if (MetaRules.looksAbbrevJournal(v)) return [];
        const to = String(v).replace(/[.\s]+$/, "");
        return to && to !== v ? [{ field: "publicationTitle", from: v, to, note: "去掉全称末尾多余句点" }] : [];
      },
    },
    {
      id: "titleSpace", label: "标题空白归一", kind: "fix", group: "字段格式",
      detect(s) {
        const v = s.fields.title;
        if (!v) return [];
        const to = MetaRules.normSpace(v);
        return to !== v ? [{ field: "title", from: v, to, note: "折叠多余空白/换行" }] : [];
      },
    },
    {
      id: "creators", label: "作者名归一化", kind: "fix", group: "作者",
      detect(s) {
        const r = MetaRules.normalizeCreators(s.creators);
        if (!r) return [];
        return [{ field: "creators", creators: r.creators, from: MetaRules._creatorsSummary(s.creators), to: MetaRules._creatorsSummary(r.creators), note: r.notes.join("；") || "空白/格式归一" }];
      },
    },
    {
      id: "pages", label: "页码格式", kind: "fix", group: "字段格式",
      detect(s) {
        const v = s.fields.pages;
        if (!v) return [];
        const to = MetaRules.fixPages(v);
        return to ? [{ field: "pages", from: v, to, note: "统一连字符" }] : [];
      },
    },
    {
      id: "volume", label: "卷号格式", kind: "fix", group: "字段格式",
      detect(s) {
        const v = s.fields.volume;
        if (!v) return [];
        const to = MetaRules.fixVolume(v);
        return to ? [{ field: "volume", from: v, to, note: "去空格/统一连字符" }] : [];
      },
    },
    {
      id: "doiFormat", label: "DOI 有效性", kind: "warn", group: "DOI",
      detect(s) {
        const h = MetaRules.doiHint(s.fields.DOI);
        return h ? [{ note: h }] : [];
      },
    },
    {
      id: "required", label: "类型必备字段", kind: "warn", group: "完整性",
      detect(s) {
        const req = MetaRules.REQUIRED_FIELDS[s.itemType];
        if (!req) return [];
        const out = [];
        for (const [f, label] of req) {
          if (!String(s.fields[f] || "").trim()) out.push({ note: "缺少「" + label + "」" });
        }
        return out;
      },
    },
    {
      id: "dupeDoi", label: "重复 DOI", kind: "warn", group: "完整性",
      detect(s, ctx) {
        const doi = MetaRules.normSpace(s.fields.DOI).toLowerCase();
        if (!doi) return [];
        const same = (ctx.doiIndex.get(doi) || []).filter((k) => k !== s.key);
        return same.length ? [{ note: "与本次扫描范围内另 " + same.length + " 条条目的 DOI 相同" }] : [];
      },
    },
  ],

  _creatorsSummary(cs) {
    return (cs || []).slice(0, 3).map((c) => [c.firstName, c.lastName, c.name].filter(Boolean).join(" ")).join("; ") +
      ((cs || []).length > 3 ? " …" : "");
  },

  /** 单快照检测 → hits（纯函数） */
  detect(snap, ctx) {
    const hits = [];
    for (const rule of this.RULES) {
      let r = [];
      try { r = rule.detect(snap, ctx || { journal: { abbr: new Map(), full: new Map() }, journalDir: "off", doiIndex: new Map() }) || []; } catch (e) { r = []; }
      for (const h of r) hits.push(Object.assign({ rule: rule.id, label: rule.label, kind: rule.kind, group: rule.group }, h));
    }
    return hits;
  },

  /** 批量扫描（items 可为 Zotero 条目或已构造的 snapshot；row.item 保留真实条目引用） */
  scanAll(items, opts) {
    const o = opts || {};
    const pairs = items.map((it) => ({ src: it, snap: (it && it.fields ? it : this.snapshot(it)) }));
    // DOI 索引（用于重复检测）
    const doiIndex = new Map();
    for (const p of pairs) {
      const doi = this.normSpace(p.snap.fields.DOI).toLowerCase();
      if (!doi) continue;
      if (!doiIndex.has(doi)) doiIndex.set(doi, []);
      doiIndex.get(doi).push(p.snap.key);
    }
    const ctx = {
      journal: this.journalIndex(o.journalPref),
      journalDir: o.journalDir || "expand",
      doiIndex,
    };
    const rows = [];
    let fixCount = 0, warnCount = 0;
    for (const p of pairs) {
      const hits = this.detect(p.snap, ctx);
      for (const h of hits) { if (h.kind === "fix") fixCount++; else warnCount++; }
      if (hits.length) rows.push({ snap: p.snap, item: p.src && !p.src.fields ? p.src : null, hits });
    }
    return { rows, fixCount, warnCount, scanned: pairs.length, journalSize: ctx.journal.size };
  },

  /* ---------------- 数据层（真实条目） ---------------- */

  /** 扫描范围：选中条目 或 整个用户库 */
  async collectItems(useLibrary) {
    const out = [];
    if (!useLibrary) {
      const zp = Zotero.getActiveZoteroPane();
      return ItemSel.regularOnly((zp && zp.getSelectedItems && zp.getSelectedItems()) || []);
    }
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    s.addCondition("itemType", "isNot", "note");
    for (const id of await s.search()) {
      const it = await Zotero.Items.getAsync(id);
      if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) out.push(it);
    }
    return out;
  },

  /** 把一条 fix hit 落到真实条目 */
  async applyHit(item, hit) {
    if (hit.field === "creators") {
      item.setCreators(hit.creators.map((c) => {
        const o = { creatorType: c.creatorType || "author" };
        if (c.name) o.name = c.name;
        else { o.firstName = c.firstName || ""; o.lastName = c.lastName || ""; }
        return o;
      }));
    } else {
      item.setField(hit.field, hit.to);
    }
    await item.saveTx();
  },

  /** 报告 → Markdown（用于「存为笔记」） */
  reportMarkdown(scan, opts) {
    const zh = I18n.isZh;
    const o = opts || {};
    let md = "## " + (zh ? "元数据体检报告" : "Metadata Report") + "\n" +
      "- " + (zh ? "扫描条目" : "Scanned") + "：" + scan.scanned + "\n" +
      "- " + (zh ? "可修复" : "Fixable") + "：" + scan.fixCount + " ｜ " + (zh ? "提示" : "Notes") + "：" + scan.warnCount + "\n\n";
    const byGroup = {};
    for (const row of scan.rows) {
      for (const h of row.hits) {
        (byGroup[h.group] = byGroup[h.group] || []).push({ title: row.snap.title, h });
      }
    }
    for (const g of Object.keys(byGroup)) {
      md += "### " + g + "\n";
      const seen = {};
      for (const { title, h } of byGroup[g]) {
        const k = h.rule + "|" + (h.from || "") + "|" + (h.to || "") + "|" + (h.note || "");
        if (seen[k]) { seen[k].n++; continue; }
        seen[k] = { n: 1, title, h };
      }
      for (const k of Object.keys(seen)) {
        const { n, h } = seen[k];
        const cnt = n > 1 ? " ×" + n : "";
        md += "- **" + h.label + "**" + cnt + "：" +
          (h.from != null ? "`" + h.from + "` → `" + h.to + "`" : (h.note || "")) +
          (h.from != null && h.note ? "（" + h.note + "）" : "") + "\n";
      }
      md += "\n";
    }
    md += "> " + (zh
      ? "由 Papilot 元数据体检生成。提示类条目需人工核实，未自动修改。"
      : "Generated by Papilot. Advisory items need manual review.");
    return md;
  },

  /** 保存报告为库级笔记 */
  async saveReport(scan) {
    const zh = I18n.isZh;
    const md = this.reportMarkdown(scan);
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    try {
      const M = (typeof MdLite !== "undefined") ? MdLite : null;
      note.setNote(M ? M.toNoteHtml(zh ? "元数据体检报告" : "Metadata Report", md) : "<pre>" + md + "</pre>");
    } catch (e) {
      note.setNote("<pre>" + String(md).replace(/</g, "&lt;") + "</pre>");
    }
    await note.saveTx();
    return note;
  },

  /** 菜单/功能中心入口：打开体检对话框 */
  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator("papilot:metarules");
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    return win.openDialog(
      "chrome://papilot/content/meta-rules.xhtml",
      "papilot-meta-rules",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },
};
