/* PaperPilot 设置窗格脚本·AI 参数卡片扩展（0.48.0 新增）
 * 与 prefs-pane 等同窗格运行。渲染内容：
 *   ① 智能体工具开关 chips（pref aiAgentTools CSV，点击切换并写回）；
 *   ② System Prompt 预设按钮（严谨学术 / 批判审稿 / 轻松讲解 / 清空）；
 *   ③ 快捷指令（命令标签）列表：查看 / 删除 / 导入导出（CommandTags 经
 *      Zotero.PaperPilot.commandTags 访问 bootstrap 作用域，删除自动打墓碑）。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测关键节点，
 *    不存在就延迟重试（同 prefs-pane.js 纪律）。
 * ⚠️ 动态创建的节点一律经变量持有，不要用 $(…) 取动态节点（check-wiring 守卫）。
 */
/* global Zotero, Components, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const CT = () => (Zotero.PaperPilot && Zotero.PaperPilot.commandTags) || null;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function setMsg(box, text, color) {
    if (!box) return;
    box.textContent = text || "";
    box.style.color = color || "var(--pp-muted)";
  }

  /* ---------------- ① 工具开关 chips ---------------- */

  /** 工具注册表（id/label/读写标记）：与 AgentTools.TOOLS 对齐的展示层副本 */
  const TOOL_LIST = [
    { id: "search_library", label: "检索文献库", ro: true },
    { id: "get_item_details", label: "读取条目详情", ro: true },
    { id: "read_item_fulltext", label: "读取条目全文", ro: true },
    { id: "list_collections", label: "列出分类", ro: true },
    { id: "search_arxiv", label: "检索 arXiv", ro: true },
    { id: "get_citation_count", label: "查被引量", ro: true },
    { id: "search_notes", label: "检索笔记", ro: true },
    { id: "export_bibliography", label: "导出参考文献", ro: true },
    { id: "add_note", label: "添加笔记（写）", ro: false },
    { id: "add_tags", label: "添加标签（写）", ro: false },
    { id: "move_to_collection", label: "移动到文集（写）", ro: false },
    { id: "memory_read", label: "读取长期记忆", ro: true },
    { id: "memory_write", label: "写入长期记忆（写）", ro: false },
  ];

  function enabledToolSet() {
    let raw = "";
    try { raw = String(Zotero.Prefs.get(PREFIX + "aiAgentTools", true) || ""); }
    catch (e) { raw = ""; }
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return new Set(ids);
  }

  function renderTools() {
    const host = $("pp-agent-tools");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const on = enabledToolSet();
    for (const t of TOOL_LIST) {
      const chip = el("span", {
        class: "pp-ds-chip" + (on.has(t.id) ? " pp-ds-on" : ""),
        title: t.id + (t.ro ? "（读，无副作用）" : "（写，默认逐次确认）"),
      }, (on.has(t.id) ? "✓ " : "") + t.label);
      chip.addEventListener("click", () => {
        const cur = enabledToolSet();
        if (cur.has(t.id)) cur.delete(t.id); else cur.add(t.id);
        // 保持 TOOL_LIST 声明顺序写回（与 prefs-pane.js 数据集 chips 同款纪律）
        const ordered = TOOL_LIST.map((x) => x.id).filter((id) => cur.has(id));
        Zotero.Prefs.set(PREFIX + "aiAgentTools", ordered.join(","), true);
        renderTools();
      });
      host.appendChild(chip);
    }
  }

  /* ---------------- ② System Prompt 预设 ---------------- */

  const PRESETS = {
    strict: "你是一位严谨的学术研究助手，协助分析论文、解读文献、整理研究思路。回答纪律：\n" +
      "1. 严格基于所给材料回答；材料中没有的信息明确说明「材料未提及」，绝不编造数据、结论或引文；\n" +
      "2. 引用论文观点时注明位置（如「见第 3 节」「摘要提到」），你的推断要与论文原文明确区分，不混在一起；\n" +
      "3. 直接给结论：不写开场白、不复述问题、不用「希望有帮助」类结尾；\n" +
      "4. 用具体术语和数字说话（含单位与比较基准），避免「效果显著」「十分重要」这类空泛表述；\n" +
      "5. 默认中文回答，术语与专有名词保留英文；默认 Markdown 格式（当前指令要求纯文本时以指令为准）。",
    critical: "你是一位苛刻但公正的学术审稿人，以挑剔的证据标准审读文献。回答纪律：\n" +
      "1. 先给结论与总体判断，再给依据；每个批评点必须落到具体章节、图表或论证步骤，拒绝泛泛而谈；\n" +
      "2. 区分「作者已承认的局限」与「未被讨论的风险」，并把问题按致命 / 重大 / 次要分层；\n" +
      "3. 主动寻找替代解释：还有哪些机制能解释同样的结果，作者是否排除了它们；\n" +
      "4. 证据不足时明确说「证据不足」，不替作者补写；数字、单位与统计量原样保留；\n" +
      "5. 默认中文回答，术语保留英文；默认 Markdown 格式。",
    explain: "你是一位耐心的学术导师，擅长把复杂论文讲给刚入门的学生。回答纪律：\n" +
      "1. 先用一两句生活化类比点出论文在做什么，再逐层展开细节；\n" +
      "2. 专业术语首次出现时用一句话解释，必要时保留英文原词；\n" +
      "3. 忠实于论文内容，论文没写的不要补，你的引申举例单独标注「（引申）」；\n" +
      "4. 关键结论配论文里的具体证据（章节 / 图表 / 数字）；\n" +
      "5. 默认中文回答，语气平易但不过度口语化；默认 Markdown 格式。",
    reset: "",
  };

  function applyPreset(key) {
    const ta = $("pp-sysprompt");
    if (!ta) return;
    const text = PRESETS[key] !== undefined ? PRESETS[key] : "";
    ta.value = text;
    try { Zotero.Prefs.set(PREFIX + "aiSystemPrompt", text, true); } catch (e) { /* ignore */ }
    setMsg($("pp-syspreset-result"),
      key === "reset" ? (zh ? "已清空（AI 将只使用内置指令）" : "Cleared")
        : (zh ? "✓ 已应用预设（可继续手动微调）" : "Preset applied"),
      "var(--pp-success)");
  }

  /* ---------------- ③ 快捷指令（命令标签） ---------------- */

  function renderTags() {
    const host = $("pp-agent-tags");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const ct = CT();
    if (!ct || typeof ct.all !== "function") {
      host.appendChild(el("span", { class: "pp-hint" },
        zh ? "命令标签模块未就绪（插件启动后可管理）" : "Tags module not ready"));
      return;
    }
    let tags = [];
    try { tags = ct.all() || []; } catch (e) { tags = []; }
    if (!tags.length) {
      host.appendChild(el("span", { class: "pp-hint" },
        zh ? "暂无标签；浮窗标签区点「＋」或长按标签可新建 / 编辑" : "No tags yet"));
      return;
    }
    for (const t of tags) {
      const chip = el("span", {
        class: "pp-ds-chip",
        title: String(t.prompt || "").slice(0, 200),
      }, "🔷 " + (t.label || t.id));
      const x = el("span", { class: "pp-chip-x", title: zh ? "删除该标签" : "Delete tag" }, "✕");
      x.addEventListener("click", () => {
        try {
          ct.remove(t.id);
          renderTags();
          setMsg($("pp-tags-result"), zh ? "已删除「" + (t.label || t.id) + "」" : "Deleted", "var(--pp-success)");
        } catch (e) {
          setMsg($("pp-tags-result"), String(e && e.message || e), "var(--pp-danger)");
        }
      });
      chip.appendChild(x);
      host.appendChild(chip);
    }
  }

  /** 写剪贴板（XPCOM 助手；与 note-templates 同款） */
  function writeClipboard(text) {
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(String(text || ""));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 读剪贴板（navigator.clipboard 优先，XPCOM 回落；与 note-templates 同款） */
  async function readClipboard() {
    try {
      const win = Zotero.getMainWindow();
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.readText) {
        return String(await win.navigator.clipboard.readText() || "");
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboard;1"]
        .getService(Components.interfaces.nsIClipboard);
      const trans = Components.classes["@mozilla.org/widget/transferable;1"]
        .createInstance(Components.interfaces.nsITransferable);
      if (trans.init) trans.init(null);
      for (const flavor of ["text/plain", "text/unicode"]) {
        try {
          trans.addDataFlavor(flavor);
          clip.getData(trans, clip.kGlobalClipboard);
          const data = {};
          const len = {};
          try { trans.getTransferData(flavor, data, len); } catch (e) { data.value = trans.getTransferData(flavor); }
          if (data.value) {
            const str = data.value.QueryInterface(Components.interfaces.nsISupportsString);
            if (str && str.data) return String(str.data);
          }
        } catch (e) { /* 换下一个 flavor */ }
      }
    } catch (e) { /* ignore */ }
    return "";
  }

  function wireTags() {
    const btnExp = $("pp-tags-export");
    const btnImp = $("pp-tags-import");
    if (!btnExp || !btnImp) return;
    btnExp.addEventListener("click", () => {
      const ct = CT();
      if (!ct || typeof ct.exportJSON !== "function") {
        setMsg($("pp-tags-result"), zh ? "命令标签模块未就绪" : "Tags module not ready", "var(--pp-danger)");
        return;
      }
      const ok = writeClipboard(ct.exportJSON());
      setMsg($("pp-tags-result"),
        ok ? (zh ? "已复制到剪贴板（JSON）" : "Copied to clipboard (JSON)")
          : (zh ? "复制失败" : "Copy failed"),
        ok ? "var(--pp-success)" : "var(--pp-danger)");
    });
    btnImp.addEventListener("click", async () => {
      const ct = CT();
      if (!ct || typeof ct.importJSON !== "function") {
        setMsg($("pp-tags-result"), zh ? "命令标签模块未就绪" : "Tags module not ready", "var(--pp-danger)");
        return;
      }
      const text = await readClipboard();
      if (!text.trim()) {
        setMsg($("pp-tags-result"), zh ? "剪贴板为空" : "Clipboard is empty", "var(--pp-danger)");
        return;
      }
      const r = ct.importJSON(text);
      if (r && r.ok) {
        renderTags();
        setMsg($("pp-tags-result"),
          (zh ? "导入完成：共 " : "Imported: ") + (r.count || 0) + (zh ? " 个标签" : " tags"),
          "var(--pp-success)");
      } else {
        setMsg($("pp-tags-result"),
          (zh ? "导入失败：" : "Import failed: ") + (r && r.error || ""), "var(--pp-danger)");
      }
    });
  }

  /* ---------------- init（探测重试，同 prefs-pane.js 纪律） ---------------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-agent-tools") || !$("pp-sysprompt") || !$("pp-agent-tags")) {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
      return;
    }
    if (init._done) return;
    init._done = true;

    try { renderTools(); } catch (e) { /* 渲染失败不影响面板其余部分 */ }
    try { renderTags(); } catch (e) { /* ignore */ }
    try { wireTags(); } catch (e) { /* ignore */ }

    const preset = (id, key) => {
      const btn = $(id);
      if (btn) btn.addEventListener("click", () => applyPreset(key));
    };
    preset("pp-syspreset-strict", "strict");
    preset("pp-syspreset-critical", "critical");
    preset("pp-syspreset-explain", "explain");
    preset("pp-syspreset-reset", "reset");
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
