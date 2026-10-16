/* PaperPilot 标题/摘要译文写回（extra 行级存取）
 *
 * 定位：「翻译标题与摘要」成功后，把译文以**各占一行**的形式写回条目 extra：
 *   PP Title Translation: <标题译文>
 *   PP Abstract Translation: <摘要译文>
 * 已存在则**替换该行**，其余 extra 行（DOI 冲突标记、其他插件数据等）原样不动。
 *
 * 收益：译文持久化后可被「标题译文」列直接渲染、被检索/导出携带，
 * 重复执行翻译时旧译文被覆盖而不是越堆越多。
 *
 * 设计口径：
 *   1. upsertLine / readLine / parseSections 是**纯函数**，可在 Node 里直接单测；
 *   2. 译文里的换行一律压平成单个空格（extra 行级格式，一行一条）；
 *   3. 值为空 = 删除该行（允许调用方清理旧译文）；
 *   4. 写回失败绝不影响上层任务（调用方自行 try/catch，本模块不吞异常语义，
 *      仅保证"无变化不落盘"——内容相同时返回 false 且不 saveTx）。
 */
/* global Zotero */

var TranslateX = {
  TITLE_PREFIX: "PP Title Translation:",
  ABSTRACT_PREFIX: "PP Abstract Translation:",

  /** 译文压平为单行（换行/回车 → 单空格，连续空白折叠） */
  flatten(text) {
    return String(text == null ? "" : text).replace(/\s*\r?\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  },

  /**
   * 在 extra 文本中替换/追加/删除一条 "前缀: 值" 行（纯函数）。
   * @param extra 原 extra 文本
   * @param prefix 行前缀（含冒号，如 "PP Title Translation:"）
   * @param value 新值；空串/null/undefined = 删除该行
   * @returns 新的 extra 文本（其余行逐字节保留，行序不变，新行追加在末尾）
   */
  upsertLine(extra, prefix, value) {
    const lines = String(extra == null ? "" : extra).split(/\r?\n/);
    const kept = [];
    for (const line of lines) {
      if (line.slice(0, prefix.length) === prefix) continue; // 命中前缀：替换（丢弃旧行）
      kept.push(line);
    }
    // 去掉因替换产生的尾部空行，保持文本紧凑
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    const v = this.flatten(value);
    if (v) kept.push(prefix + " " + v);
    return kept.join("\n");
  },

  /** 从 extra 文本读一条 "前缀: 值" 行（纯函数）；没有返回 "" */
  readLine(extra, prefix) {
    const lines = String(extra == null ? "" : extra).split(/\r?\n/);
    for (const line of lines) {
      if (line.slice(0, prefix.length) === prefix) {
        return line.slice(prefix.length).trim();
      }
    }
    return "";
  },

  /** 读出条目的标题/摘要译文（列渲染用） */
  readTranslations(item) {
    let extra = "";
    try { extra = item.getField("extra") || ""; } catch (e) { /* ignore */ }
    return {
      title: this.readLine(extra, this.TITLE_PREFIX),
      abstract: this.readLine(extra, this.ABSTRACT_PREFIX),
    };
  },

  /**
   * 翻译成功后写回 extra（标题/摘要可只给其一，undefined 的键不动）。
   * @returns {Promise<boolean>} 是否发生了实际修改
   */
  async writeBackTranslations(item, translations) {
    if (!item || !translations) return false;
    const t = translations.title;
    const a = translations.abstract;
    if (t === undefined && a === undefined) return false;
    let extra = "";
    try { extra = item.getField("extra") || ""; } catch (e) { return false; }
    let next = extra;
    if (t !== undefined) next = this.upsertLine(next, this.TITLE_PREFIX, t);
    if (a !== undefined) next = this.upsertLine(next, this.ABSTRACT_PREFIX, a);
    if (next === extra) return false;
    item.setField("extra", next);
    await item.saveTx();
    try { Zotero.debug("PaperPilot: 标题/摘要译文已写回 extra（itemID " + item.id + "）"); } catch (e) { /* ignore */ }
    return true;
  },

  /**
   * 解析「翻译标题摘要」的合并输出（纯函数）。
   * 兼容节标题写法：标题 / 摘要 / Title / Abstract，允许前导 # 与尾随冒号。
   * @returns {{title: string, abstract: string}} 识别不出的部分为空串
   */
  parseSections(text) {
    const out = { title: "", abstract: "" };
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    const isHead = (line, names) => {
      const m = /^\s*#{0,6}\s*(.+?)\s*[:：]?\s*$/.exec(line);
      if (!m) return false;
      return names.indexOf(m[1].toLowerCase()) >= 0;
    };
    let cur = null;
    const buf = { title: [], abstract: [] };
    for (const line of lines) {
      if (isHead(line, ["标题", "title"])) { cur = "title"; continue; }
      if (isHead(line, ["摘要", "abstract"])) { cur = "abstract"; continue; }
      if (cur) buf[cur].push(line);
    }
    out.title = buf.title.join("\n").trim();
    out.abstract = buf.abstract.join("\n").trim();
    return out;
  },
};
