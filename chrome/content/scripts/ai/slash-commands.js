/* PaperPilot 「/」命令面板（H1）
 *
 * 通用斜杠命令弹层：输入框以 "/" 开头时在输入框上方弹出可搜索命令列表，
 * ↑↓ 导航、Enter 执行、Esc 关闭，继续输入实时过滤；点选也可执行。
 *
 * 命令 = {id, title, hint, run({input})}。命令由消费方供给（getCommands 每次
 * 打开重新取，保证 Prompt 标签等动态项是最新的）；本模块只做过滤与弹层装配，
 * 无 Zotero 依赖，工作台等独立窗口可直接使用（经 PP.slashCommands 访问）。
 *
 * 用法：
 *   const handle = SlashCommands.attach({
 *     doc, input, anchor,            // anchor 缺省 = input.parentNode
 *     getCommands: () => [{id, title, hint, run}],
 *   });
 *   handle.close() / handle.isOpen() / handle.refresh()
 */
/* 无外部依赖（纯 DOM 装配） */

var SlashCommands = {
  XHTML: "http://www.w3.org/1999/xhtml",

  /** 过滤：id/title/hint 子串匹配（大小写不敏感），空串返回全量 */
  filter(commands, query) {
    const list = (commands || []).slice();
    const q = String(query || "").trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      (String(c.id || "") + " " + String(c.title || "") + " " + String(c.hint || ""))
        .toLowerCase().indexOf(q) >= 0
    );
  },

  /**
   * 在输入框上挂「/」命令面板。返回 {close, isOpen, refresh}；入参不全返回 null。
   * 行为约定：执行命令前先清空输入框（去掉 "/xxx"），再调 cmd.run({input})——
   * 「插入文本」类命令在 run 里自行回填 input.value。
   */
  attach(opts) {
    const doc = opts && opts.doc;
    const input = opts && opts.input;
    if (!doc || !input || typeof opts.getCommands !== "function") return null;
    const anchor = opts.anchor || input.parentNode;
    if (!anchor) return null;
    try {
      if (!anchor.style.position) anchor.style.position = "relative";
    } catch (e) { /* ignore */ }

    const h = (tag, style, text) => {
      const el = doc.createElementNS(this.XHTML, tag);
      if (style) el.style.cssText = style;
      if (text != null) el.textContent = text;
      return el;
    };

    let pop = null;
    let list = [];
    let active = 0;

    const isOpen = () => !!pop;
    const close = () => {
      if (pop) {
        try { pop.remove(); } catch (e) { /* ignore */ }
        pop = null;
      }
    };
    const query = () => {
      const v = String(input.value || "");
      return v.startsWith("/") ? v.slice(1) : null;
    };

    const runActive = () => {
      const cmd = list[active];
      if (!cmd) return;
      close();
      input.value = "";
      try { cmd.run({ input }); } catch (e) { /* ignore */ }
      try { input.focus(); } catch (e) { /* ignore */ }
    };

    const render = () => {
      const q = query();
      if (q === null) { close(); return; }
      list = this.filter(opts.getCommands() || [], q).slice(0, 9);
      if (!list.length) { close(); return; }
      if (active >= list.length) active = list.length - 1;
      if (!pop) {
        pop = h("div",
          "position:absolute;left:0;right:0;bottom:100%;margin-bottom:6px;z-index:20;" +
          "background:var(--pp-surface,var(--material-surface,#ffffff));" +
          "color:var(--pp-text,var(--fill-primary,#222222));" +
          "border:1px solid var(--pp-border,rgba(128,128,128,.4));border-radius:8px;" +
          "box-shadow:0 8px 28px rgba(0,0,0,.25);max-height:280px;overflow-y:auto;" +
          "scrollbar-width:thin;");
        anchor.appendChild(pop);
      }
      pop.textContent = "";
      list.forEach((c, i) => {
        const row = h("div",
          "display:flex;gap:8px;align-items:baseline;padding:6px 10px;cursor:pointer;" +
          "font-size:12.5px;line-height:1.5;" +
          (i === active ? "background:var(--pp-accent-soft,rgba(37,99,235,.12));" : ""));
        row.appendChild(h("span", "font-weight:600;white-space:nowrap;", "/" + c.id));
        row.appendChild(h("span",
          "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
          c.title || ""));
        if (c.hint) {
          row.appendChild(h("span",
            "opacity:.55;font-size:11px;white-space:nowrap;overflow:hidden;" +
            "text-overflow:ellipsis;max-width:40%;", c.hint));
        }
        row.addEventListener("click", () => { active = i; runActive(); });
        row.addEventListener("mousemove", () => {
          if (active !== i) { active = i; render(); }
        });
        pop.appendChild(row);
      });
    };

    input.addEventListener("input", () => { active = 0; render(); });
    input.addEventListener("keydown", (ev) => {
      if (!pop) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        active = Math.min(active + 1, list.length - 1);
        render();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      } else if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        ev.stopPropagation();
        runActive();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    });
    doc.addEventListener("click", (ev) => {
      if (!pop || ev.target === input) return;
      try {
        if (typeof pop.contains === "function" && pop.contains(ev.target)) return;
      } catch (e) { /* ignore */ }
      close();
    });

    return { close, isOpen, refresh: render };
  },
};
