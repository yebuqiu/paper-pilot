# -*- coding: utf-8 -*-
"""把真实的 prefs.xhtml + prefs.css 转成静态设计预览页（开发期工具，产物不进插件包）。

用途：设置面板是 Zotero 内的 XUL fragment，改完样式只能装进 Zotero 才看得到；本脚本把它
降级成普通 HTML，配合无头浏览器即可做视觉评审 / 响应式与对比度量化审计，不必反复装机。

转换只做「外壳适配」：
  · html: 前缀去命名空间；
  · XUL 容器/控件降级为 HTML 等价物（vbox/hbox→div、checkbox→input+label、
    menulist→select、description→div、label value= → 文本）；
  · 自闭合的非空元素（textarea 等）展开成成对标签——不展开会把后面十几张卡吞进第一张里。
卡片结构与类名与线上完全一致，所以预览里的间距 / 配色 / 层级就是设置面板的真实表现。
动态区域（通道 / 订阅 / 设备 / 主题…）用示例数据填充，页首有「示例数据」提示。

用法：python scripts/build-prefs-preview.py
输出：docs/预览-设置面板-<版本>.html
"""
import io, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")
CSS = os.path.join(ROOT, "chrome", "content", "prefs.css")
_ver = re.search(r'"version"\s*:\s*"([^"]+)"', io.open(os.path.join(ROOT, "manifest.json"), encoding="utf-8").read()).group(1)
OUT = os.path.join(ROOT, "docs", "预览-设置面板-%s.html" % _ver)

x = io.open(SRC, encoding="utf-8").read()
css = io.open(CSS, encoding="utf-8").read()

# 1) 去掉文件头注释里的 XML 纪律说明（预览页不需要，但保留 0.65.0 架构注释作说明）
x = x.replace("<!-- SPDX-License-Identifier: Apache-2.0 | Copyright (c) 2026 Cassiuschen -->", "")
# 2) html: 前缀 → HTML 标签
x = re.sub(r"<(/?)html:([a-zA-Z0-9]+)", r"<\1\2", x)
# 3) XUL 容器 → div
x = re.sub(r"</?vbox\b", lambda m: m.group(0).replace("vbox", "div"), x)
x = re.sub(r"</?hbox\b", lambda m: m.group(0).replace("hbox", "div"), x)
x = x.replace("<description", "<div").replace("</description>", "</div>")
# 4) XUL label value= → 普通文本
x = re.sub(r'<label value="([^"]*)"\s*/>', r'<label class="pp-label">\1</label>', x)
# 5) XUL checkbox → 带样式的复选框
def _cb(m):
    attrs = m.group(1)
    idm = re.search(r'id="([^"]+)"', attrs)
    lm = re.search(r'label="([^"]*)"', attrs)
    i = ' id="%s"' % idm.group(1) if idm else ""
    return ('<label class="pp-check"><input type="checkbox"%s/><span>%s</span></label>'
            % (i, lm.group(1) if lm else ""))
x = re.sub(r"<checkbox\s+([^>]*?)/>", _cb, x)
# 6) XUL menulist → select
def _ml(m):
    attrs, inner = m.group(1), m.group(2)
    opts = re.findall(r'<menuitem\s+label="([^"]*)"\s+value="([^"]*)"\s*/>', inner)
    body = "".join('<option value="%s">%s</option>' % (v, l) for l, v in opts)
    return "<select %s>%s</select>" % (attrs, body)
x = re.sub(r"<menulist\s+([^>]*)>([\s\S]*?)</menulist>", _ml, x)
x = re.sub(r"</?menupopup>|</?menuitem[^>]*>", "", x)
# 7) 去掉 XUL 专属属性（对 HTML 无害但会干扰阅读）
x = re.sub(r'\s(flex|preference)="[^"]*"', "", x)
# 8) 自闭合的非空元素（textarea / div / span / label …）在 HTML 里会吞掉后续内容
#    → 一律展开成成对标签（否则第一张带 <textarea/> 的卡会把后面十几张卡嵌进自己里）
VOID = {"input", "img", "br", "hr", "meta", "link", "source", "area", "base",
        "col", "embed", "param", "track", "wbr"}
def _expand(m):
    tag, attrs = m.group(1), m.group(2)
    if tag.lower() in VOID:
        return m.group(0)
    return "<%s%s></%s>" % (tag, attrs, tag)
x = re.sub(r"<([a-zA-Z][\w-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)/>", _expand, x)
# 9) checkbox/menulist 里残留的空标签
x = x.replace('<span></span>', '<span>OCR 选项</span>')

DEMO = r"""
<script>
/* ---- 仅预览用：折叠 / 搜索 / 示例数据（与插件内 prefs-fold.js 的判定口径一致） ---- */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var cards = [].slice.call(document.querySelectorAll('.pp-card.pp-fold'));
  cards.forEach(function (c) { c.classList.add('pp-fold-closed'); });
  cards.forEach(function (c) {
    var head = c.querySelector('.pp-fold-head');
    if (!head) return;
    head.addEventListener('click', function () { c.classList.toggle('pp-fold-closed'); });
  });
  var exp = $('pp-fold-expand'), col = $('pp-fold-collapse');
  if (exp) exp.addEventListener('click', function () {
    cards.forEach(function (c) { c.classList.remove('pp-fold-closed'); });
  });
  if (col) col.addEventListener('click', function () {
    cards.forEach(function (c) { c.classList.add('pp-fold-closed'); });
  });

  /* 搜索：标题 + 说明 + 关键词，命中即展开，组内零命中隐藏标签 */
  var input = $('pp-prefs-search'), clearBtn = $('pp-prefs-search-clear'), count = $('pp-pref-count');
  var base = count ? count.textContent : '';
  var idx = cards.map(function (c) {
    var t = c.querySelector('.pp-card-title'), d = c.querySelector('.pp-card-desc');
    return { el: c, text: [t && t.textContent, d && d.textContent,
      c.getAttribute('data-search-strings-raw') || ''].join(' ').toLowerCase() };
  });
  function apply() {
    var terms = (input.value || '').toLowerCase().split(/\s+/).filter(Boolean);
    var on = terms.length > 0, hit = 0;
    idx.forEach(function (it) {
      var ok = !on || terms.every(function (t) { return it.text.indexOf(t) >= 0; });
      if (ok) hit++;
      it.el.classList.toggle('pp-hidden', !ok);
    });
    var kids = document.querySelector('.pp-root').children;
    for (var i = 0; i < kids.length; i++) {
      if (!kids[i].classList.contains('pp-cat-label')) continue;
      var any = false;
      for (var j = i + 1; j < kids.length; j++) {
        if (kids[j].classList.contains('pp-cat-label')) break;
        if (kids[j].classList.contains('pp-card') && !kids[j].classList.contains('pp-hidden')) any = true;
      }
      kids[i].classList.toggle('pp-hidden', on && !any);
    }
    document.querySelector('.pp-root').classList.toggle('pp-searching', on);
    if (count) count.textContent = on ? hit + ' / ' + idx.length + ' 项' : base;
    if (count) count.classList.toggle('pp-count-hit', on);
    if (clearBtn) clearBtn.style.display = on ? '' : 'none';
  }
  if (input) { input.addEventListener('input', apply); }
  if (clearBtn) clearBtn.addEventListener('click', function () { input.value = ''; apply(); });

  /* ---- 示例数据：真实面板里由各 prefs-*.js 渲染 ---- */
  var h = function (html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };
  var add = function (id, html) { var host = $(id); if (host) host.appendChild(h(html)); };

  /* 大类直达（真实面板由 prefs-hotkeys.js 生成） */
  var nav = $('pp-anchor-nav');
  if (nav) {
    nav.appendChild(h('<span class="pp-hint">直达：</span>'));
    [].slice.call(document.querySelectorAll('.pp-cat-label')).forEach(function (lab) {
      var nm = lab.querySelector('.pp-cat-name');
      var btn = h('<button class="pp-btn pp-btn-sm">' + (nm ? nm.textContent : lab.textContent) + '</button>');
      btn.addEventListener('click', function () {
        lab.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var n = lab.nextElementSibling;
        while (n && !n.classList.contains('pp-card')) n = n.nextElementSibling;
        if (n) n.classList.remove('pp-fold-closed');
      });
      nav.appendChild(btn);
    });
  }

  // 账号：切到已登录视图
  var lv = $('pp-login-view'), av = $('pp-account-view');
  if (lv) lv.style.display = 'none';
  if (av) av.style.display = '';
  if ($('pp-account-name')) $('pp-account-name').textContent = '陈老师';
  if ($('pp-account-email')) $('pp-account-email').textContent = 'chen@example.edu.cn';
  if ($('pp-account-meta')) $('pp-account-meta').textContent = '注册于 2026-09-12 · 本机 1 台设备登录中';
  if ($('pp-mb-badge')) { $('pp-mb-badge').textContent = 'PRO'; $('pp-mb-badge').classList.add('pp-mb-badge-pro'); }
  if ($('pp-mb-title')) $('pp-mb-title').textContent = '专业版';
  if ($('pp-mb-expiry')) $('pp-mb-expiry').textContent = '有效期至 2027-03-12（剩 143 天）';
  if ($('pp-mb-features')) $('pp-mb-features').innerHTML =
    '<div class="pp-mb-feat">全部官方模型（含推理档 / 长上下文）</div>'
    + '<div class="pp-mb-feat">每月 ¥20 AI 额度，当月有效</div>'
    + '<div class="pp-mb-feat">第三方文献源（试验）可用</div>';
  if ($('pp-mb-usage')) {
    $('pp-mb-usage').style.display = '';
    $('pp-mb-usage').innerHTML = '<div class="pp-mb-usage-head">今日 ¥1.24 · 近 7 天 ¥7.86</div>'
      + '<div class="pp-mb-bars">' + [0.2, 0.4, 0.15, 0.55, 0.35, 0.9, 0.7].map(function (v, i) {
        return '<div class="pp-mb-bar-col"><div class="pp-mb-bar' + (v ? '' : ' pp-mb-bar-zero')
          + '" style="height:' + Math.round(v * 40) + 'px"></div><div class="pp-mb-bar-day">'
          + ['一', '二', '三', '四', '五', '六', '日'][i] + '</div></div>';
      }).join('') + '</div>';
  }
  if ($('pp-bal-block')) {
    $('pp-bal-block').style.display = '';
    $('pp-bal-block').querySelector('.pp-bal-total').textContent = '¥ 23.40';
    $('pp-bal-detail').textContent = '订阅额度 ¥20.00（2026-11 到期）· 充值余额 ¥3.40';
    $('pp-bal-note').textContent = '按响应模型计价，逐次扣减；额度用完可切换到自己的 API Key。';
  }
  if ($('pp-dev-block')) {
    $('pp-dev-block').style.display = '';
    $('pp-dev-stat').textContent = '2 台在线';
    add('pp-dev-list', '<div class="pp-dev-row pp-dev-row-cur"><div class="pp-dev-info">'
      + '<div class="pp-dev-name">Windows · 本机</div>'
      + '<div class="pp-dev-meta">最后活跃：刚刚 · 192.168.1.6</div></div>'
      + '<div class="pp-dev-act"><span class="pp-link pp-link-danger">退出</span></div></div>');
    add('pp-dev-list', '<div class="pp-dev-row"><div class="pp-dev-info">'
      + '<div class="pp-dev-name">macOS · 办公室</div>'
      + '<div class="pp-dev-meta">最后活跃：2 天前 · 10.0.0.22</div></div>'
      + '<div class="pp-dev-act"><span class="pp-link pp-link-danger">退出</span></div></div>');
  }
  if ($('pp-ai-tier-note')) {
    $('pp-ai-tier-note').style.display = '';
    $('pp-ai-tier-note').textContent = '全模型可用 · 本月剩余额度 ¥20.00';
  }

  // 模型通道
  if ($('pp-ch-status')) {
    $('pp-ch-status').textContent = '活动通道：官方（deepseek-v4.1-flash）· 连接正常；另有 1 个自建通道';
  }
  add('pp-ch-list', '<div class="pp-ch-row"><div style="flex:1;min-width:0">'
    + '<div class="pp-ch-head"><span class="pp-ch-name">官方通道</span>'
    + '<span class="pp-pill pp-pill-ok">使用中</span></div>'
    + '<div class="pp-ch-sub">api.papilot.example/v1 · 密钥 已隐藏</div></div>'
    + '<select class="pp-select" style="width:170px"><option>deepseek-v4.1-flash</option>'
    + '<option>deepseek-v4.1-pro</option></select></div>');
  add('pp-ch-list', '<div class="pp-ch-row"><div style="flex:1;min-width:0">'
    + '<div class="pp-ch-head"><span class="pp-ch-name">自建 · Ollama</span>'
    + '<span class="pp-pill pp-pill-warn">离线</span></div>'
    + '<div class="pp-ch-sub">http://127.0.0.1:11434/v1 · 密钥 已隐藏</div></div>'
    + '<select class="pp-select" style="width:170px"><option>qwen2.5:14b</option></select></div>');

  // 翻译引擎
  add('pp-tr-list', '<div class="pp-ch-row"><div style="flex:1;min-width:0">'
    + '<div class="pp-ch-head"><span class="pp-ch-name">AI 大模型</span>'
    + '<span class="pp-pill pp-pill-ok">当前</span><span class="pp-pill">回退 1</span></div>'
    + '<div class="pp-ch-sub">走「官方通道」· 支持术语表约束 · 最近一次 1.2s</div></div>'
    + '<div class="pp-row" style="margin:0"><button class="pp-btn pp-btn-sm">设为当前</button>'
    + '<button class="pp-btn pp-btn-sm">测试</button></div></div>');
  add('pp-tr-list', '<div class="pp-ch-row"><div style="flex:1;min-width:0">'
    + '<div class="pp-ch-head"><span class="pp-ch-name">Google 翻译</span>'
    + '<span class="pp-pill">免密钥</span></div>'
    + '<div class="pp-ch-sub">无需配置 · 不支持术语表 · 最近一次 0.4s</div></div>'
    + '<div class="pp-row" style="margin:0"><button class="pp-btn pp-btn-sm">设为当前</button>'
    + '<button class="pp-btn pp-btn-sm">测试</button></div></div>');

  // 主题墙
  var themes = [['晨雾蓝', ['#eef4ff', '#dbe7ff', '#8fb4ff', '#2f6fed'], '浅色'],
                ['墨夜', ['#1b1f24', '#22272e', '#3d444d', '#4493f8'], '深色'],
                ['羊皮纸', ['#fbf6ec', '#f3e9d2', '#d8c9a8', '#8a6d3b'], '浅色'],
                ['樱', ['#fdf2f5', '#f9dbe4', '#f2a7bd', '#c2185b'], '浅色']];
  ['pp-cat-standard'].forEach(function (id) {
    themes.forEach(function (t) {
      add(id, '<div class="pp-theme-card' + (t[0] === '晨雾蓝' ? ' pp-theme-on' : '') + '">'
        + '<div class="pp-theme-swatches">' + t[1].map(function (c) {
          return '<span style="flex:1;background:' + c + '"></span>'; }).join('') + '</div>'
        + '<div class="pp-theme-name">' + t[0] + '</div>'
        + '<div class="pp-theme-tag">' + t[2] + ' · 壁纸</div></div>');
    });
  });

  // PDF 阅读主题
  [['关闭（原样）', '默认'], ['护眼浅绿', '推荐'], ['羊皮纸', ''], ['夜间反色', '深色页']].forEach(function (t, i) {
    add('pp-pdf-theme-list', '<div class="pp-pdf-item' + (i === 1 ? ' pp-pdf-on' : '') + '">'
      + '<span style="width:14px;height:14px;border-radius:4px;border:1px solid var(--pp-border);'
      + 'background:' + ['#fff', '#dff0d2', '#f3e9d2', '#111'][i] + '"></span>'
      + '<span>' + t[0] + '</span><span class="pp-pdf-badge">' + t[1] + '</span></div>');
  });

  // 第三方文献源
  function tsGroup(name, chips) {
    add('pp-ts-endpoints', '<div class="pp-ts-group">' + name + '</div>');
    add('pp-ts-endpoints', '<div class="pp-ts-chips">' + chips.map(function (c) {
      return '<button class="pp-ts-chip"><span class="pp-ts-dot" style="color:var(--pp-success)">●</span>'
        + '<span class="pp-ts-chip-name">' + c + '</span></button>'; }).join('') + '</div>');
  }
  tsGroup('中文库', ['知网', '万方', '维普', '百度学术']);
  tsGroup('英文全文', ['Sci-Hub', 'Sci-Net', 'PubMed Central']);
  tsGroup('预印本 / 搜索', ['arXiv', 'bioRxiv', 'Google Scholar']);

  // 技能包
  ['学术写作', '医学翻译', '文献精读', '审稿助手'].forEach(function (n, i) {
    add('pp-sk-installed', '<span class="pp-ds-chip' + (i === 0 ? ' pp-ds-on' : '') + '">'
      + (i === 0 ? '✓ ' : '') + n + ' v1.' + (i + 2) + '</span>');
  });

  // 检索订阅
  [['图神经网络', 'arXiv · OpenAlex', '每日 08:00', '今天 08:02 抓到 12 条', 1],
   ['可解释性', 'arXiv · Crossref', '每周一 09:00', '昨天 09:01 抓到 5 条', 0]].forEach(function (r) {
    add('pp-subs-list', '<div class="pp-row pp-subs-row"><span class="pp-label">' + r[0] + '</span>'
      + '<span class="pp-hint" style="border:1px solid var(--pp-border);border-radius:6px;padding:0 5px">'
      + r[1] + '</span><span class="pp-hint pp-subs-spec">关键词 3 · 排除 1</span>'
      + '<span class="pp-hint pp-subs-time">' + r[2] + '</span>'
      + '<span class="pp-hint pp-subs-last">' + r[3] + '</span>'
      + '<button class="pp-btn pp-btn-sm">预览</button><button class="pp-btn pp-btn-sm">立即运行</button>'
      + '<button class="pp-btn pp-btn-sm">历史</button><button class="pp-btn pp-btn-sm">编辑</button>'
      + '<button class="pp-btn pp-btn-sm">删除</button></div>');
  });

  // 定时任务
  [['研究晨报', '08:00', '今天 08:00 已生成'], ['阅读周报', '周一 09:00', '本周一已生成'],
   ['库体检', '', '未启用']].forEach(function (r) {
    add('pp-sch-rows', '<div class="pp-row pp-sch-row"><span class="pp-label" style="min-width:120px">'
      + r[0] + '</span><input class="pp-input pp-sch-time" value="' + r[1] + '" placeholder="HH:MM">'
      + '<span class="pp-hint pp-sch-state">' + r[2] + '</span>'
      + '<button class="pp-btn pp-btn-sm">立即运行</button></div>');
  });

  // 快捷键
  [['打开 AI 问答', '主窗口', 'Ctrl+Shift+K'], ['划词翻译', '阅读器', 'Ctrl+Enter'],
   ['功能中心', '主窗口', 'Ctrl+Shift+P'], ['快速打标', '主窗口', 'Ctrl+Shift+T']].forEach(function (r) {
    add('pp-hotkeys-list', '<div class="pp-row pp-hk-row"><span class="pp-label" style="min-width:200px">'
      + r[0] + '</span><span class="pp-hint" style="min-width:56px">' + r[1] + '</span>'
      + '<span class="pp-hint pp-hk-combo">' + r[2] + '</span>'
      + '<button class="pp-btn pp-btn-sm">录制</button><button class="pp-btn pp-btn-sm">重置</button>'
      + '<input type="checkbox" checked></div>');
  });

  // AI 记忆 / 命令标签
  [['偏好', '图表一律用矢量图，坐标轴标注单位', '09-28']].forEach(function (r) {
    add('pp-mem-list', '<div class="pp-row pp-mem-row"><span class="pp-mem-kind">' + r[0] + '</span>'
      + '<span class="pp-hint pp-mem-text">' + r[1] + '</span>'
      + '<span class="pp-hint pp-mem-time">' + r[2] + '</span>'
      + '<button class="pp-btn pp-btn-sm">删除</button></div>');
  });
  ['精读', '审稿', '术语核对', '周报'].forEach(function (n, i) {
    add('pp-agent-tags', '<span class="pp-ds-chip' + (i === 0 ? ' pp-ds-on' : '') + '">/' + n + '</span>');
  });
  ['检索文献库', '读全文', '加笔记', '打标签', '查引用'].forEach(function (n, i) {
    add('pp-agent-tools', '<span class="pp-ds-chip' + (i < 3 ? ' pp-ds-on' : '') + '">' + n + '</span>');
  });
  // 分区数据集 chips（真实面板由 prefs-pane.js 渲染）
  ['中科院分区', 'JCR', 'CCF', '北大核心', 'CSCD', '影响因子'].forEach(function (n, i) {
    add('pp-rank-datasets', '<span class="pp-ds-chip' + (i < 3 ? ' pp-ds-on' : '') + '">'
      + (i < 3 ? '✓ ' : '') + n + '</span>');
  });
  if ($('pp-rank-preview')) {
    $('pp-rank-preview').innerHTML = '<span style="color:var(--pp-muted);font-size:11px;margin-right:6px">配色图例：</span>'
      + [['Q1', '#c0392b'], ['Q2', '#d97706'], ['中科院1区', '#b91c1c'], ['CCF-A', '#15803d'],
         ['北大核心', '#1d4ed8'], ['IF 9.4', '#6b7280']].map(function (b) {
        return '<span class="pp-badge-demo" style="background:' + b[1] + '">' + b[0] + '</span>'; }).join('');
  }
  // 菜单分组勾选
  if ($('pp-menu-groups')) {
    ['文献处理', '阅读与翻译', '笔记与写作', '批量分析', '账号与设置'].forEach(function (n) {
      $('pp-menu-groups').appendChild(h('<label class="pp-check" style="margin-top:0">'
        + '<input type="checkbox" checked><span>' + n + '</span></label>'));
    });
  }
  // 云同步状态
  if ($('pp-cloud-state')) {
    $('pp-cloud-state').textContent = '已连接';
    $('pp-cloud-dot').style.color = 'var(--pp-success)';
    $('pp-cloud-last').textContent = '上次同步：3 分钟前 · 12 个文件';
    $('pp-cloud-progress').textContent = '设置项 4/4 · 对话 12/12 · 技能包 3/3';
    $('pp-cloud-bar').style.width = '100%';
    $('pp-cloud-log').textContent = '09:12:04  拉取远端索引… 14 项\n09:12:05  上传 2 个变更（settings.json, chat-index.json）\n09:12:06  完成，无冲突';
  }
  // 默认展开前两张卡，便于评审卡片展开态
  ['account', 'channels'].forEach(function (k) {
    var el = document.querySelector('[data-fold="' + k + '"]');
    if (el) el.classList.remove('pp-fold-closed');
  });
})();
</script>
"""

html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Papilot 设置面板 · 0.65.0 设计预览</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    background: #eff1f4;
    color: #1f2328;
    font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #15181c; color: #e6edf3; }
  }
  .pv-note {
    max-width: 1000px; margin: 0 auto; padding: 10px 14px;
    font-size: 12px; color: #5b6570; line-height: 1.7;
    background: #fffbe8; border-bottom: 1px solid #ecd9a0;
  }
  @media (prefers-color-scheme: dark) {
    .pv-note { background: #2a2618; border-bottom-color: #4a4020; color: #d8cba0; }
  }
  .pv-note b { color: #8a6d00; }
  @media (prefers-color-scheme: dark) { .pv-note b { color: #e0c060; } }
  /* 模拟 Zotero 设置窗格：面板自身是滚动容器（flex="1" + overflow-y:auto），
     这样吸顶工具条 / 锚点定位的表现与真机一致 */
  .pp-root { max-width: 1000px; margin: 0 auto; display: block;
             height: calc(100vh - 46px); overflow-y: auto !important; }
  body { overflow: hidden; }
</style>
<style>
/* ===== 以下是 chrome/content/prefs.css 原文（与插件内完全一致） ===== */
__CSS__
/* ===== prefs.css 结束 ===== */
</style>
</head>
<body>
<div class="pv-note">
  <b>静态设计预览（示例数据）</b> — 结构与样式直接取自插件真实的 <code>prefs.xhtml</code> /
  <code>prefs.css</code>；账号、订单、订阅等动态区域用示例数据填充，<b>不是真实账号信息</b>。
  可点卡片标题折叠、用顶部搜索框过滤。此页仅用于视觉评审，不进入插件包。
</div>
__BODY__
__DEMO__
</body>
</html>
"""
html = html.replace("__CSS__", css).replace("__BODY__", x).replace("__DEMO__", DEMO)
io.open(OUT, "w", encoding="utf-8", newline="\n").write(html)
print("预览页写入:", OUT, len(html), "字节")
