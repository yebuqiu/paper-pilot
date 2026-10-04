"use strict";

/**
 * arXiv 分类目录（离线内置，`arxiv categories` 无需联网即可用）。
 *
 * 为什么内置而不是运行时抓取：① 分类列表变化极慢（每年个位数调整）；
 * ② 离线可用才能做「本地校验 + 拼写纠错」，而拼错分类是新手最常见的失败原因
 * （如把 cs.CL 写成 cs.cl、cs.NLP —— arXiv 对大小写敏感且不存在 cs.NLP）。
 */

const RAW = [
  // ---- Computer Science ----
  "cs.AI|Artificial Intelligence|cs",
  "cs.AR|Hardware Architecture|cs",
  "cs.CC|Computational Complexity|cs",
  "cs.CE|Computational Engineering, Finance, and Science|cs",
  "cs.CG|Computational Geometry|cs",
  "cs.CL|Computation and Language (NLP)|cs",
  "cs.CR|Cryptography and Security|cs",
  "cs.CV|Computer Vision and Pattern Recognition|cs",
  "cs.CY|Computers and Society|cs",
  "cs.DB|Databases|cs",
  "cs.DC|Distributed, Parallel, and Cluster Computing|cs",
  "cs.DL|Digital Libraries|cs",
  "cs.DM|Discrete Mathematics|cs",
  "cs.DS|Data Structures and Algorithms|cs",
  "cs.ET|Emerging Technologies|cs",
  "cs.FL|Formal Languages and Automata Theory|cs",
  "cs.GL|General Literature|cs",
  "cs.GR|Graphics|cs",
  "cs.GT|Computer Science and Game Theory|cs",
  "cs.HC|Human-Computer Interaction|cs",
  "cs.IR|Information Retrieval|cs",
  "cs.IT|Information Theory|cs",
  "cs.LG|Machine Learning|cs",
  "cs.LO|Logic in Computer Science|cs",
  "cs.MA|Multiagent Systems|cs",
  "cs.MM|Multimedia|cs",
  "cs.MS|Mathematical Software|cs",
  "cs.NA|Numerical Analysis|cs",
  "cs.NE|Neural and Evolutionary Computing|cs",
  "cs.NI|Networking and Internet Architecture|cs",
  "cs.OH|Other Computer Science|cs",
  "cs.OS|Operating Systems|cs",
  "cs.PF|Performance|cs",
  "cs.PL|Programming Languages|cs",
  "cs.RO|Robotics|cs",
  "cs.SC|Symbolic Computation|cs",
  "cs.SD|Sound|cs",
  "cs.SE|Software Engineering|cs",
  "cs.SI|Social and Information Networks|cs",
  "cs.SY|Systems and Control|cs",
  // ---- Statistics ----
  "stat.AP|Applications|stat",
  "stat.CO|Computation|stat",
  "stat.ME|Methodology|stat",
  "stat.ML|Machine Learning|stat",
  "stat.OT|Other Statistics|stat",
  "stat.TH|Statistics Theory|stat",
  // ---- Mathematics ----
  "math.AG|Algebraic Geometry|math",
  "math.AT|Algebraic Topology|math",
  "math.AP|Analysis of PDEs|math",
  "math.CT|Category Theory|math",
  "math.CA|Classical Analysis and ODEs|math",
  "math.CO|Combinatorics|math",
  "math.AC|Commutative Algebra|math",
  "math.CV|Complex Variables|math",
  "math.DG|Differential Geometry|math",
  "math.DS|Dynamical Systems|math",
  "math.FA|Functional Analysis|math",
  "math.GM|General Mathematics|math",
  "math.GN|General Topology|math",
  "math.GT|Geometric Topology|math",
  "math.GR|Group Theory|math",
  "math.HO|History and Overview|math",
  "math.IT|Information Theory|math",
  "math.KT|K-Theory and Homology|math",
  "math.LO|Logic|math",
  "math.MP|Mathematical Physics|math",
  "math.MG|Metric Geometry|math",
  "math.NT|Number Theory|math",
  "math.NA|Numerical Analysis|math",
  "math.OA|Operator Algebras|math",
  "math.OC|Optimization and Control|math",
  "math.PR|Probability|math",
  "math.QA|Quantum Algebra|math",
  "math.RT|Representation Theory|math",
  "math.RA|Rings and Algebras|math",
  "math.SP|Spectral Theory|math",
  "math.ST|Statistics Theory|math",
  "math.SG|Symplectic Geometry|math",
  // ---- Electrical Engineering and Systems Science ----
  "eess.AS|Audio and Speech Processing|eess",
  "eess.IV|Image and Video Processing|eess",
  "eess.SP|Signal Processing|eess",
  "eess.SY|Systems and Control|eess",
  // ---- Quantitative Biology ----
  "q-bio.BM|Biomolecules|q-bio",
  "q-bio.CB|Cell Behavior|q-bio",
  "q-bio.GN|Genomics|q-bio",
  "q-bio.MN|Molecular Networks|q-bio",
  "q-bio.NC|Neurons and Cognition|q-bio",
  "q-bio.OT|Other Quantitative Biology|q-bio",
  "q-bio.PE|Populations and Evolution|q-bio",
  "q-bio.QM|Quantitative Methods|q-bio",
  "q-bio.SC|Subcellular Processes|q-bio",
  "q-bio.TO|Tissues and Organs|q-bio",
  // ---- Quantitative Finance ----
  "q-fin.CP|Computational Finance|q-fin",
  "q-fin.EC|Economics|q-fin",
  "q-fin.GN|General Finance|q-fin",
  "q-fin.MF|Mathematical Finance|q-fin",
  "q-fin.PM|Portfolio Management|q-fin",
  "q-fin.PR|Pricing of Securities|q-fin",
  "q-fin.RM|Risk Management|q-fin",
  "q-fin.ST|Statistical Finance|q-fin",
  "q-fin.TR|Trading and Market Microstructure|q-fin",
  // ---- Economics ----
  "econ.EM|Econometrics|econ",
  "econ.GN|General Economics|econ",
  "econ.TH|Theoretical Economics|econ",
  // ---- Physics（含常用子领域）----
  "astro-ph.CO|Cosmology and Nongalactic Astrophysics|astro-ph",
  "astro-ph.EP|Earth and Planetary Astrophysics|astro-ph",
  "astro-ph.GA|Astrophysics of Galaxies|astro-ph",
  "astro-ph.HE|High Energy Astrophysical Phenomena|astro-ph",
  "astro-ph.IM|Instrumentation and Methods for Astrophysics|astro-ph",
  "astro-ph.SR|Solar and Stellar Astrophysics|astro-ph",
  "cond-mat.dis-nn|Disordered Systems and Neural Networks|cond-mat",
  "cond-mat.mes-hall|Mesoscale and Nanoscale Physics|cond-mat",
  "cond-mat.mtrl-sci|Materials Science|cond-mat",
  "cond-mat.quant-gas|Quantum Gases|cond-mat",
  "cond-mat.soft|Soft Condensed Matter|cond-mat",
  "cond-mat.stat-mech|Statistical Mechanics|cond-mat",
  "cond-mat.str-el|Strongly Correlated Electrons|cond-mat",
  "cond-mat.supr-con|Superconductivity|cond-mat",
  "gr-qc|General Relativity and Quantum Cosmology|physics",
  "hep-ex|High Energy Physics - Experiment|physics",
  "hep-lat|High Energy Physics - Lattice|physics",
  "hep-ph|High Energy Physics - Phenomenology|physics",
  "hep-th|High Energy Physics - Theory|physics",
  "math-ph|Mathematical Physics|physics",
  "nlin.AO|Adaptation and Self-Organizing Systems|nlin",
  "nlin.CD|Chaotic Dynamics|nlin",
  "nucl-ex|Nuclear Experiment|physics",
  "nucl-th|Nuclear Theory|physics",
  "physics.ao-ph|Atmospheric and Oceanic Physics|physics",
  "physics.bio-ph|Biological Physics|physics",
  "physics.comp-ph|Computational Physics|physics",
  "physics.data-an|Data Analysis, Statistics and Probability|physics",
  "physics.flu-dyn|Fluid Dynamics|physics",
  "physics.gen-ph|General Physics|physics",
  "physics.med-ph|Medical Physics|physics",
  "physics.optics|Optics|physics",
  "physics.soc-ph|Physics and Society|physics",
  "quant-ph|Quantum Physics|physics",
];

const ALL = RAW.map((line) => {
  const [code, name, archive] = line.split("|");
  return { code, name, archive, group: archive };
});

const BY_CODE = new Map(ALL.map((c) => [c.code.toLowerCase(), c]));

/** 全部分类（拷贝，避免外部改动内部表）。 */
function list() { return ALL.map((c) => Object.assign({}, c)); }

/** 按大类（archive）分组。 */
function groupByArchive() {
  const out = {};
  for (const c of ALL) {
    if (!out[c.archive]) out[c.archive] = [];
    out[c.archive].push(Object.assign({}, c));
  }
  return out;
}

/** 精确查（大小写不敏感）。 */
function get(code) {
  const c = BY_CODE.get(String(code || "").toLowerCase());
  return c ? Object.assign({}, c) : null;
}

/**
 * 宽松校验：`cs.LG` 这类两级编码，或 `gr-qc` / `quant-ph` 这类无点的一级编码。
 * 注意只校验「形状」与「是否在目录内」；目录是常用子集，不在目录内不等于非法，
 * 因此返回 `{ok, known, shape}` 三元组把两种信息分开。
 */
function validate(code) {
  const s = String(code || "").trim();
  const shape = /^([a-z][a-z-]{1,12})(\.[A-Za-z][A-Za-z-]{0,12})?$/.test(s) ||
    /^[a-z-]+$/.test(s);
  const known = BY_CODE.has(s.toLowerCase());
  return { ok: shape && known, known, shape, code: s };
}

/** Levenshtein 距离（用于拼写纠错建议）。 */
function editDistance(a, b) {
  const s = String(a), t = String(b);
  const m = s.length, n = t.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

/**
 * 拼写建议：先按同大类缩小范围，再按编辑距离排序。
 * @param {string} code
 * @param {number} [limit=5]
 */
function suggest(code, limit) {
  const s = String(code || "").trim();
  if (!s) return [];
  const lower = s.toLowerCase();
  const archive = lower.split(".")[0];
  const same = ALL.filter((c) => c.archive === archive);
  const pool = same.length ? same : ALL;
  return pool
    .map((c) => ({ code: c.code, name: c.name, distance: editDistance(lower, c.code.toLowerCase()) }))
    .filter((x) => x.distance <= Math.max(2, Math.ceil(lower.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.code.localeCompare(b.code))
    .slice(0, limit == null ? 5 : limit);
}

/**
 * 批量校验分类列表，返回问题清单（不抛错——调用方决定是警告还是中止）。
 * @param {string[]} codes
 * @returns {{valid:string[], unknown:string[], malformed:string[], suggestions:Array<{input:string,suggestions:Array}>}}
 */
function checkAll(codes) {
  const valid = [], unknown = [], malformed = [], suggestions = [];
  for (const raw of codes || []) {
    const code = String(raw || "").trim();
    if (!code) continue;
    const v = validate(code);
    if (v.ok) { valid.push(code); continue; }
    if (!v.shape) malformed.push(code); else unknown.push(code);
    const sug = suggest(code);
    if (sug.length) suggestions.push({ input: code, suggestions: sug });
  }
  return { valid, unknown, malformed, suggestions };
}

module.exports = { list, groupByArchive, get, validate, suggest, checkAll, editDistance, ALL };
