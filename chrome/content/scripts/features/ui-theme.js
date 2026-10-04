/* PaperPilot 界面主题系统（0.17.0 重构：主题库 + 动态壁纸 + 视频壁纸）
 * 设计来源（详见 docs/0.16.0-theme-credits.md）：
 *  - Sum-su/yaobian-zotero（MIT）：CSS 变量映射换肤契约（--material- 系 / --fill- 系）；
 *    壁纸图层体系（#zotero-pane-stack 底层图层 + GLASS 面板透明清单 +
 *    工具栏 backdrop-filter 毛玻璃 + 调色板随可见度半透明化，menupopup 恒不透明）；
 *    Services.wm.getEnumerator 枚举 + load 事件 watch 兼容设置窗口 reload。
 *  - tefkah/zotero-night（GPL-3.0，思路借鉴）：Nord 色板基调。
 *
 * 0.17.0 主题模型：主题 = 配色色板 + 壁纸 一体包（cat: anime/scenery/dynamic）。
 * 壁纸四引擎：
 *  ① svg      静态 SVG 插画（background-image data-URI）
 *  ② svg-anim SMIL 动态插画（内联 SVG DOM——作为背景图引用的 SVG 不跑动画，
 *              必须 DOMParser 解析后插进壁纸层 DOM，SMIL/CSS 动画才生效）
 *  ③ image    用户本地图片（file:// URI，background cover）
 *  ④ video    用户本地视频（<video autoplay loop muted>，object-fit cover）
 * 全部插画为本项目程序化生成的原创 SVG（零第三方素材，无版权风险）。
 */
/* global Zotero, Services, Prefs, Components */

var UiTheme = {
  STYLE_ID: "paperpilot-ui-theme-style",
  // 0.25.0：阅读器界面（reader.html）自己的注入点。阅读器是独立文档（iframe），
  // 主窗口的 #main-window 规则够不到，必须单独往 reader 文档 :root 上打一遍变量。
  READER_STYLE_ID: "paperpilot-ui-theme-reader",
  WALLPAPER_ID: "paperpilot-ui-wallpaper",
  PREF_KEY: "uiTheme",           // "" = 原生；"custom"；主题库 id
  PREF_CUSTOM: "uiThemeCustom",  // 自定义主题色板 JSON
  PREF_WP: "uiWallpaper",        // "theme"（跟随主题包）/"off"/"custom"
  PREF_WP_PATH: "uiWallpaperPath", // custom 壁纸本地路径（图片或视频）
  PREF_WP_OPACITY: "uiWallpaperOpacity", // 10-90 可见度（面板透明程度）

  _winListener: null,
  _obsObserver: null,

  /* ==================== 主题库 ====================
   * colors 角色：background 全窗底 / side 侧栏 / toolbar 工具栏 / tab 标签栏 /
   *   surface 卡片 / menu 菜单 / ink 正文 / ink2 ink3 次级 / line 分割线 /
   *   accent 强调 / select 选中底
   * wp: { kind:"svg"|"svg-anim", svg, anim } 或缺省（无壁纸）
   * wpOpacity: 该主题的推荐壁纸可见度（null = 用全局滑条值） */

  THEMES: [
    /* ---------- 标准（纯色主题，无壁纸） ---------- */
    { id: "primer-light", cat: "standard", dark: false, name: "Primer 浅色", wpOpacity: null,
      colors: { background: "#ffffff", side: "#f6f8fa", toolbar: "#f6f8fa", tab: "#eceff2", surface: "#ffffff", menu: "#ffffff", ink: "#1f2328", ink2: "#59636e", ink3: "#818b98", line: "#d1d9e0", accent: "#0969da", select: "#0969da26" } },
    { id: "primer-dark", cat: "standard", dark: true, name: "Primer 深色", wpOpacity: null,
      colors: { background: "#0d1117", side: "#161b22", toolbar: "#161b22", tab: "#21262d", surface: "#161b22", menu: "#1c2128", ink: "#e6edf3", ink2: "#9198a1", ink3: "#6e7681", line: "#3d444d", accent: "#4493f8", select: "#4493f840" } },
    { id: "nord-night", cat: "standard", dark: true, name: "Nord 夜色", wpOpacity: null,
      colors: { background: "#2e3440", side: "#3b4252", toolbar: "#3b4252", tab: "#434c5e", surface: "#3b4252", menu: "#434c5e", ink: "#eceff4", ink2: "#aeb8c6", ink3: "#7b88a1", line: "#434c5e", accent: "#88c0d0", select: "#88c0d040" } },
    { id: "sepia-paper", cat: "standard", dark: false, name: "护眼米纸", wpOpacity: null,
      colors: { background: "#f5f0e1", side: "#efe8d5", toolbar: "#efe8d5", tab: "#e5dcc4", surface: "#faf6ea", menu: "#f5f0e1", ink: "#433422", ink2: "#6d5c44", ink3: "#94836b", line: "#dccfb2", accent: "#a05a2c", select: "#a05a2c30" } },

    /* ---------- 动漫风 ---------- */
    { id: "sakura", cat: "anime", dark: false, name: "樱花前线", wpOpacity: 65,
      colors: { background: "#fff6f8", side: "#fdeef2", toolbar: "#fdeef2", tab: "#f8e2e9", surface: "#fffafb", menu: "#fdeef2", ink: "#59343f", ink2: "#8a5f6b", ink3: "#b28d96", line: "#f3d9e0", accent: "#e35d87", select: "#e35d8733" },
      wp: { kind: "svg", svg: "__SAKURA__" } },
    { id: "mint-soda", cat: "anime", dark: false, name: "薄荷苏打", wpOpacity: 60,
      colors: { background: "#f2fbf6", side: "#e6f7ee", toolbar: "#e6f7ee", tab: "#d6f0e2", surface: "#f7fdf9", menu: "#e6f7ee", ink: "#1e4536", ink2: "#476e5d", ink3: "#72a08d", line: "#c9e8d8", accent: "#14a06e", select: "#14a06e30" },
      wp: { kind: "svg", svg: "__MINT__" } },
    { id: "violet-eternity", cat: "anime", dark: true, name: "紫罗兰夜", wpOpacity: 70,
      colors: { background: "#1d1629", side: "#261e35", toolbar: "#261e35", tab: "#322845", surface: "#2c2340", menu: "#322845", ink: "#ece5f6", ink2: "#b3a6d1", ink3: "#877ba6", line: "#3d3054", accent: "#a78bfa", select: "#a78bfa3d" },
      wp: { kind: "svg", svg: "__VIOLET__" } },
    { id: "azure-fleet", cat: "anime", dark: true, name: "苍蓝晨风", wpOpacity: 70,
      colors: { background: "#0c1828", side: "#12233a", toolbar: "#12233a", tab: "#1a2f4c", surface: "#17293f", menu: "#1a2f4c", ink: "#e3edf9", ink2: "#9fb6d4", ink3: "#748cab", line: "#26405e", accent: "#5ba3f5", select: "#5ba3f53d" },
      wp: { kind: "svg", svg: "__STARRY__" } },
    { id: "crimson-maple", cat: "anime", dark: true, name: "绯红枫火", wpOpacity: 65,
      colors: { background: "#2a1410", side: "#361b15", toolbar: "#361b15", tab: "#452419", surface: "#40221a", menu: "#452419", ink: "#f9e8dd", ink2: "#d4a795", ink3: "#a87a67", line: "#4d2b20", accent: "#e8552f", select: "#e8552f40" },
      wp: { kind: "svg", svg: "__MAPLE__" } },
    { id: "golden-sun", cat: "anime", dark: false, name: "金盏朝日", wpOpacity: 60,
      colors: { background: "#fdf6e4", side: "#f8ecd0", toolbar: "#f8ecd0", tab: "#f0e0b8", surface: "#fff9ec", menu: "#f8ecd0", ink: "#4a3a1a", ink2: "#7a6540", ink3: "#a3906a", line: "#ecdcb2", accent: "#d9992b", select: "#d9992b30" },
      wp: { kind: "svg", svg: "__SUNFLOWER__" } },

    /* ---------- 风景 ---------- */
    { id: "ink-mountain", cat: "scenery", dark: true, name: "远山墨色", wpOpacity: 70,
      colors: { background: "#16222c", side: "#1c2c38", toolbar: "#1c2c38", tab: "#243848", surface: "#223444", menu: "#243848", ink: "#dde8f0", ink2: "#93a9ba", ink3: "#68808f", line: "#2c4152", accent: "#5d94ad", select: "#5d94ad3d" },
      wp: { kind: "svg", svg: "__MOUNTAIN__" } },
    { id: "aurora-night", cat: "scenery", dark: true, name: "极光之夜", wpOpacity: 70,
      colors: { background: "#0a1626", side: "#10203a", toolbar: "#10203a", tab: "#16294a", surface: "#14283f", menu: "#16294a", ink: "#dcebf5", ink2: "#8fb3cc", ink3: "#64869e", line: "#1f3a5c", accent: "#43d9a3", select: "#43d9a33d" },
      wp: { kind: "svg", svg: "__AURORA__" } },
    { id: "canyon-dusk", cat: "scenery", dark: true, name: "暮光峡谷", wpOpacity: 65,
      colors: { background: "#241428", side: "#2f1a33", toolbar: "#2f1a33", tab: "#3c2340", surface: "#3a2140", menu: "#3c2340", ink: "#f2e3ec", ink2: "#b993b3", ink3: "#8f6a8c", line: "#45284d", accent: "#e8763a", select: "#e8763a40" },
      wp: { kind: "svg", svg: "__CANYON__" } },
    { id: "snow-dawn", cat: "scenery", dark: false, name: "雪原晨光", wpOpacity: 60,
      colors: { background: "#f4f8fb", side: "#e9f1f6", toolbar: "#e9f1f6", tab: "#dce8f0", surface: "#fafdff", menu: "#e9f1f6", ink: "#2c3e4d", ink2: "#5d7484", ink3: "#8ba0ad", line: "#d4e2ec", accent: "#4a90c2", select: "#4a90c22e" },
      wp: { kind: "svg", svg: "__SNOW__" } },

    /* ---------- 动态壁纸（SMIL 动画） ---------- */
    { id: "sakura-fall", cat: "dynamic", dark: false, name: "樱落·动态", wpOpacity: 65,
      colors: { background: "#fff6f8", side: "#fdeef2", toolbar: "#fdeef2", tab: "#f8e2e9", surface: "#fffafb", menu: "#fdeef2", ink: "#59343f", ink2: "#8a5f6b", ink3: "#b28d96", line: "#f3d9e0", accent: "#e35d87", select: "#e35d8733" },
      wp: { kind: "svg-anim", svg: "__SAKURA_FALL__", anim: true } },
    { id: "star-river", cat: "dynamic", dark: true, name: "星语·动态", wpOpacity: 70,
      colors: { background: "#0c1828", side: "#12233a", toolbar: "#12233a", tab: "#1a2f4c", surface: "#17293f", menu: "#1a2f4c", ink: "#e3edf9", ink2: "#9fb6d4", ink3: "#748cab", line: "#26405e", accent: "#5ba3f5", select: "#5ba3f53d" },
      wp: { kind: "svg-anim", svg: "__STAR_TWINKLE__", anim: true } },
    { id: "aurora-flow", cat: "dynamic", dark: true, name: "极光流·动态", wpOpacity: 70,
      colors: { background: "#0a1626", side: "#10203a", toolbar: "#10203a", tab: "#16294a", surface: "#14283f", menu: "#16294a", ink: "#dcebf5", ink2: "#8fb3cc", ink3: "#64869e", line: "#1f3a5c", accent: "#43d9a3", select: "#43d9a33d" },
      wp: { kind: "svg-anim", svg: "__AURORA_FLOW__", anim: true } },
    { id: "snow-drift", cat: "dynamic", dark: false, name: "雪落·动态", wpOpacity: 60,
      colors: { background: "#f4f8fb", side: "#e9f1f6", toolbar: "#e9f1f6", tab: "#dce8f0", surface: "#fafdff", menu: "#e9f1f6", ink: "#2c3e4d", ink2: "#5d7484", ink3: "#8ba0ad", line: "#d4e2ec", accent: "#4a90c2", select: "#4a90c22e" },
      wp: { kind: "svg-anim", svg: "__SNOW_DRIFT__", anim: true } },
    { id: "firefly-night", cat: "dynamic", dark: true, name: "萤火·动态", wpOpacity: 70,
      colors: { background: "#0f1a12", side: "#15221a", toolbar: "#15221a", tab: "#1c2e24", surface: "#1a2a20", menu: "#1c2e24", ink: "#e4f2e0", ink2: "#a5c4a2", ink3: "#759172", line: "#28402e", accent: "#b7e04a", select: "#b7e04a38" },
      wp: { kind: "svg-anim", svg: "__FIREFLY__", anim: true } },

    /* ---------- 巨物动漫风（0.20.1） ---------- */
    { id: "giant-moon", cat: "giant", dark: true, name: "巨月悬空", wpOpacity: 70,
      colors: { background: "#2a1a3e", side: "#35234d", toolbar: "#35234d", tab: "#432c5e", surface: "#3a2653", menu: "#432c5e", ink: "#f7ecf5", ink2: "#c4a8d4", ink3: "#96759f", line: "#4d3366", accent: "#e88ab0", select: "#e88ab033" },
      wp: { kind: "svg", svg: "__GIANT_MOON__", art: true } },
    { id: "giant-tower", cat: "giant", dark: true, name: "巨塔霞光", wpOpacity: 70,
      colors: { background: "#3a1028", side: "#4a1730", toolbar: "#4a1730", tab: "#5c1e3a", surface: "#521a34", menu: "#5c1e3a", ink: "#fbe9dc", ink2: "#d6a891", ink3: "#ad7a68", line: "#662745", accent: "#f0904c", select: "#f0904c3d" },
      wp: { kind: "svg", svg: "__GIANT_TOWER__", art: true } },
    { id: "giant-gate", cat: "giant", dark: true, name: "巨门星空", wpOpacity: 70,
      colors: { background: "#081426", side: "#0e1e34", toolbar: "#0e1e34", tab: "#142a45", surface: "#112338", menu: "#142a45", ink: "#e6f4f0", ink2: "#9dc4b8", ink3: "#6d9188", line: "#1c3550", accent: "#6fd8b8", select: "#6fd8b83d" },
      wp: { kind: "svg", svg: "__GIANT_GATE__", art: true } },
  ],

  /* ==================== 在线美图（0.19.0） ====================
   * 参考项目 E:/project/工具集合 的精选图库：Unsplash CDN 直链，可直接热链
   * （响应头 Access-Control-Allow-Origin: *，本机实测 200 / <0.5s）。
   * 缩略图取 w=400 省流量，应用为壁纸时取 w=1920。
   * 点击即写 uiWallpaperUrl + uiWallpaper="custom"（与自定义壁纸同一通道）。 */
  PHOTOS: [
    { id: "mountain", name: "雪山之巅", pid: "1506905925346-21bda4d32df4" },
    { id: "forest", name: "雾林", pid: "1441974231531-c6227db76b6e" },
    { id: "mist", name: "山间晨雾", pid: "1470071459604-3b5ec3a7fe05" },
    { id: "wave", name: "海浪", pid: "1518837695005-2083093ee35b" },
    { id: "lake", name: "湖光山色", pid: "1493246507139-91e8fad9978e" },
    { id: "canoe", name: "静谧小舟", pid: "1476514525535-07fb3b4ae5f1" },
    { id: "beach", name: "海岸", pid: "1507525428034-b723cf961d3e" },
    { id: "night", name: "星夜群山", pid: "1519681393784-d120267933ba" },
    { id: "valley", name: "峡谷", pid: "1426604966848-d7adac402bff" },
    { id: "meadow", name: "暮色原野", pid: "1472214103451-9374bd1c798e" },
    { id: "milkyway", name: "银河", pid: "1419242902214-272b3f66ee7a" },
    { id: "flower", name: "花野", pid: "1465146344425-f00d5f5c8f07" },
  ],

  photoURL(pid, w) {
    return "https://images.unsplash.com/photo-" + pid + "?auto=format&fit=crop&w=" + w + "&q=80";
  },

  /* ==================== SVG 插画库（程序化原创） ==================== */

  _svgOpen(defs) {
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 600'><defs>" + defs + "</defs>";
  },

  _buildSVGs() {
    const P = {}; // 占位符 -> SVG 全文
    const petal =
      "<path id='ptl' d='M0,-8 C2.5,-8 4.5,-5.5 4.5,-2.5 C6.5,-4.5 8.5,-2.5 7.5,0.5 " +
      "C6,4.5 3,7.5 0,8.5 C-3,7.5 -6,4.5 -7.5,0.5 C-8.5,-2.5 -6.5,-4.5 -4.5,-2.5 C-4.5,-5.5 -2.5,-8 0,-8 Z'/>";

    // —— 樱吹雪 2.0（三层景深花瓣 + 柔光） ——
    P.__SAKURA__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0.3' y2='1'>" +
      "<stop offset='0' stop-color='#fff8fa'/><stop offset='0.55' stop-color='#ffeef3'/><stop offset='1' stop-color='#ffdfe9'/></linearGradient>" +
      "<radialGradient id='gl'><stop offset='0' stop-color='#fff' stop-opacity='0.95'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>" +
      petal
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='150' cy='110' r='140' fill='url(#gl)'/>" +
      "<circle cx='650' cy='470' r='180' fill='url(#gl)' opacity='0.8'/>" +
      "<circle cx='430' cy='60' r='90' fill='url(#gl)' opacity='0.6'/>" +
      // 远景（小、淡）
      "<g fill='#f7c6d8' opacity='0.4'>" +
      "<use href='#ptl' transform='translate(90,60) rotate(15) scale(0.55)'/>" +
      "<use href='#ptl' transform='translate(300,40) rotate(-30) scale(0.5)'/>" +
      "<use href='#ptl' transform='translate(520,90) rotate(45) scale(0.6)'/>" +
      "<use href='#ptl' transform='translate(700,50) rotate(-15) scale(0.5)'/>" +
      "<use href='#ptl' transform='translate(180,200) rotate(60) scale(0.55)'/>" +
      "<use href='#ptl' transform='translate(620,240) rotate(-50) scale(0.6)'/>" +
      "<use href='#ptl' transform='translate(380,320) rotate(20) scale(0.5)'/></g>" +
      // 中景
      "<g fill='#f5a8c4' opacity='0.68'>" +
      "<use href='#ptl' transform='translate(140,140) rotate(30) scale(0.95)'/>" +
      "<use href='#ptl' transform='translate(330,170) rotate(-45) scale(0.9)'/>" +
      "<use href='#ptl' transform='translate(500,140) rotate(70) scale(1)'/>" +
      "<use href='#ptl' transform='translate(660,330) rotate(-20) scale(0.95)'/>" +
      "<use href='#ptl' transform='translate(230,360) rotate(40) scale(1.05)'/>" +
      "<use href='#ptl' transform='translate(430,470) rotate(-60) scale(0.9)'/></g>" +
      // 近景（大、实）
      "<g fill='#f28db3' opacity='0.92'>" +
      "<use href='#ptl' transform='translate(90,420) rotate(-25) scale(1.5)'/>" +
      "<use href='#ptl' transform='translate(300,530) rotate(50) scale(1.6)'/>" +
      "<use href='#ptl' transform='translate(560,540) rotate(-40) scale(1.45)'/>" +
      "<use href='#ptl' transform='translate(720,470) rotate(20) scale(1.55)'/></g>" +
      "</svg>";

    // —— 薄荷气泡（气泡群 + 高光 + 柔光） ——
    P.__MINT__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0.2' y2='1'>" +
      "<stop offset='0' stop-color='#f4fdf8'/><stop offset='1' stop-color='#c7f1de'/></linearGradient>" +
      "<radialGradient id='gl'><stop offset='0' stop-color='#fff' stop-opacity='0.9'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>" +
      "<linearGradient id='liq' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#9fe3c8' stop-opacity='0.35'/><stop offset='1' stop-color='#5fc9a5' stop-opacity='0.5'/></linearGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<rect y='380' width='800' height='220' fill='url(#liq)'/>" +
      "<circle cx='640' cy='110' r='150' fill='url(#gl)'/>" +
      "<circle cx='130' cy='480' r='170' fill='url(#gl)' opacity='0.7'/>" +
      "<g stroke='#ffffff' stroke-opacity='0.8' fill='#ffffff' fill-opacity='0.15'>" +
      "<circle cx='120' cy='110' r='34'/><circle cx='260' cy='220' r='20'/>" +
      "<circle cx='420' cy='90' r='26'/><circle cx='580' cy='260' r='42'/>" +
      "<circle cx='720' cy='180' r='18'/><circle cx='90' cy='330' r='22'/>" +
      "<circle cx='330' cy='420' r='36'/><circle cx='530' cy='500' r='24'/>" +
      "<circle cx='700' cy='430' r='30'/><circle cx='200' cy='560' r='16'/>" +
      "<circle cx='470' cy='330' r='14'/><circle cx='640' cy='560' r='20'/></g>" +
      "<g fill='#ffffff' opacity='0.9'>" +
      "<circle cx='108' cy='98' r='6'/><circle cx='253' cy='213' r='4'/>" +
      "<circle cx='410' cy='81' r='5'/><circle cx='564' cy='244' r='8'/>" +
      "<circle cx='713' cy='174' r='4'/><circle cx='82' cy='322' r='5'/>" +
      "<circle cx='316' cy='406' r='7'/><circle cx='521' cy='492' r='5'/>" +
      "<circle cx='688' cy='418' r='6'/><circle cx='194' cy='554' r='4'/></g>" +
      "</svg>";

    // —— 紫夜月轮 2.0（环形山月 + 云浪） ——
    P.__VIOLET__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#150f24'/><stop offset='0.55' stop-color='#241a3e'/><stop offset='1' stop-color='#352660'/></linearGradient>" +
      "<radialGradient id='halo'><stop offset='0' stop-color='#d9c9ff' stop-opacity='0.55'/>" +
      "<stop offset='0.5' stop-color='#a78bfa' stop-opacity='0.18'/><stop offset='1' stop-color='#a78bfa' stop-opacity='0'/></radialGradient>" +
      "<linearGradient id='moon' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='#f4edff'/><stop offset='1' stop-color='#cdbcf2'/></linearGradient>" +
      "<radialGradient id='mist'><stop offset='0' stop-color='#8b7ad9' stop-opacity='0.22'/><stop offset='1' stop-color='#8b7ad9' stop-opacity='0'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='590' cy='160' r='220' fill='url(#halo)'/>" +
      "<circle cx='590' cy='160' r='70' fill='url(#moon)'/>" +
      "<g fill='#c3aef0' opacity='0.55'>" +
      "<ellipse cx='612' cy='138' rx='11' ry='9'/>" +
      "<ellipse cx='566' cy='172' rx='8' ry='7'/>" +
      "<ellipse cx='598' cy='188' rx='5.5' ry='5'/>" +
      "<ellipse cx='578' cy='142' rx='4.5' ry='4'/></g>" +
      "<circle cx='90' cy='80' r='1.6' fill='#fff' opacity='0.85'/>" +
      "<circle cx='180' cy='140' r='1.2' fill='#e8d5ff' opacity='0.75'/>" +
      "<circle cx='300' cy='70' r='1.5' fill='#fff' opacity='0.9'/>" +
      "<circle cx='430' cy='110' r='1.2' fill='#e8d5ff' opacity='0.7'/>" +
      "<circle cx='760' cy='90' r='1.5' fill='#fff' opacity='0.8'/>" +
      "<circle cx='70' cy='250' r='1.3' fill='#fff' opacity='0.75'/>" +
      "<circle cx='240' cy='300' r='1.5' fill='#e8d5ff' opacity='0.8'/>" +
      "<circle cx='380' cy='240' r='1.1' fill='#fff' opacity='0.65'/>" +
      "<circle cx='730' cy='330' r='1.4' fill='#fff' opacity='0.75'/>" +
      "<circle cx='150' cy='420' r='1.5' fill='#fff' opacity='0.7'/>" +
      // 云浪（三层波浪）
      "<path d='M0,480 C120,440 260,500 400,470 C540,440 680,495 800,465 L800,600 L0,600 Z' fill='#4a3670' opacity='0.5'/>" +
      "<path d='M0,520 C150,485 300,540 450,510 C600,480 720,535 800,510 L800,600 L0,600 Z' fill='#5d4490' opacity='0.55'/>" +
      "<path d='M0,560 C180,530 350,575 520,550 C660,530 750,565 800,550 L800,600 L0,600 Z' fill='#7155ab' opacity='0.5'/>" +
      "<ellipse cx='220' cy='460' rx='280' ry='120' fill='url(#mist)'/>" +
      "</svg>";

    // —— 星海 2.0（银河带 + 流星 + 海面倒影） ——
    P.__STARRY__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#060d20'/><stop offset='0.6' stop-color='#11214a'/><stop offset='1' stop-color='#1b3766'/></linearGradient>" +
      "<linearGradient id='milky' x1='0' y1='0' x2='1' y2='0'>" +
      "<stop offset='0' stop-color='#7fb8ff' stop-opacity='0'/><stop offset='0.5' stop-color='#a8ccff' stop-opacity='0.28'/>" +
      "<stop offset='1' stop-color='#7fb8ff' stop-opacity='0'/></linearGradient>" +
      "<radialGradient id='neb'><stop offset='0' stop-color='#5ba3f5' stop-opacity='0.3'/><stop offset='1' stop-color='#5ba3f5' stop-opacity='0'/></radialGradient>" +
      "<radialGradient id='neb2'><stop offset='0' stop-color='#a78bfa' stop-opacity='0.24'/><stop offset='1' stop-color='#a78bfa' stop-opacity='0'/></radialGradient>" +
      "<path id='sp' d='M0,-5 L1.3,-1.3 L5,0 L1.3,1.3 L0,5 L-1.3,1.3 L-5,0 L-1.3,-1.3 Z'/>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<g transform='rotate(-24 400 300)'><ellipse cx='400' cy='300' rx='560' ry='90' fill='url(#milky)'/></g>" +
      "<ellipse cx='620' cy='140' rx='260' ry='180' fill='url(#neb)'/>" +
      "<ellipse cx='180' cy='420' rx='240' ry='160' fill='url(#neb2)'/>" +
      // 星空（三层亮度）
      "<g fill='#ffffff' opacity='0.9'>" +
      "<circle cx='80' cy='70' r='1.6'/><circle cx='320' cy='90' r='1.8'/>" +
      "<circle cx='540' cy='110' r='1.5'/><circle cx='270' cy='250' r='1.5'/></g>" +
      "<g fill='#cfe3ff' opacity='0.8'>" +
      "<circle cx='200' cy='45' r='1.2'/><circle cx='700' cy='60' r='1.3'/>" +
      "<circle cx='140' cy='200' r='1.2'/><circle cx='560' cy='260' r='1.4'/>" +
      "<circle cx='90' cy='360' r='1.5'/><circle cx='500' cy='440' r='1.6'/></g>" +
      "<g fill='#ffffff' opacity='0.65'>" +
      "<circle cx='430' cy='40' r='1.1'/><circle cx='760' cy='180' r='1.4'/>" +
      "<circle cx='400' cy='190' r='1.1'/><circle cx='650' cy='340' r='1.2'/>" +
      "<circle cx='220' cy='430' r='1.3'/><circle cx='350' cy='380' r='1.1'/>" +
      "<circle cx='720' cy='470' r='1.2'/><circle cx='60' cy='520' r='1.3'/></g>" +
      "<use href='#sp' fill='#fff' opacity='0.95' transform='translate(150,130) scale(1.4)'/>" +
      "<use href='#sp' fill='#cfe3ff' opacity='0.9' transform='translate(640,90) scale(1.1)'/>" +
      "<use href='#sp' fill='#fff' opacity='0.85' transform='translate(480,300) scale(0.9)'/>" +
      // 流星（静态瞬间）
      "<g stroke-linecap='round'>" +
      "<line x1='640' y1='70' x2='590' y2='112' stroke='#eaf4ff' stroke-width='1.6' opacity='0.85'/>" +
      "<line x1='646' y1='66' x2='590' y2='112' stroke='#eaf4ff' stroke-width='0.8' opacity='0.4'/>" +
      "<line x1='230' y1='150' x2='200' y2='186' stroke='#d5e6ff' stroke-width='1.2' opacity='0.6'/></g>" +
      // 海面与星光倒影
      "<ellipse cx='400' cy='665' rx='560' ry='140' fill='#2a4a7f' opacity='0.4'/>" +
      "<ellipse cx='400' cy='700' rx='480' ry='100' fill='#3a62a8' opacity='0.25'/>" +
      "<g stroke='#9cc4ff' stroke-width='1' opacity='0.35'>" +
      "<line x1='150' y1='575' x2='150' y2='600'/><line x1='320' y1='570' x2='320' y2='605'/>" +
      "<line x1='480' y1='578' x2='480' y2='600'/><line x1='640' y1='572' x2='640' y2='598'/></g>" +
      "</svg>";

    // —— 绯红枫火（暖红渐变 + 枫叶） ——
    P.__MAPLE__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0.3' y2='1'>" +
      "<stop offset='0' stop-color='#3a1410'/><stop offset='0.5' stop-color='#571d12'/><stop offset='1' stop-color='#7a2a16'/></linearGradient>" +
      "<radialGradient id='gl'><stop offset='0' stop-color='#ffb37e' stop-opacity='0.35'/><stop offset='1' stop-color='#ffb37e' stop-opacity='0'/></radialGradient>" +
      "<path id='leaf' d='M0,-11 L2.5,-4.5 L9,-7 L4.5,0 L11,2.5 L4.5,4.5 L7,11 L0,6.5 L-7,11 L-4.5,4.5 L-11,2.5 L-4.5,0 L-9,-7 L-2.5,-4.5 Z'/>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='620' cy='140' r='220' fill='url(#gl)'/>" +
      "<circle cx='160' cy='480' r='200' fill='url(#gl)' opacity='0.7'/>" +
      "<g fill='#e8552f' opacity='0.85'>" +
      "<use href='#leaf' transform='translate(120,100) rotate(20) scale(1.2)'/>" +
      "<use href='#leaf' transform='translate(340,70) rotate(-35) scale(0.9)'/>" +
      "<use href='#leaf' transform='translate(560,180) rotate(55) scale(1.4)'/>" +
      "<use href='#leaf' transform='translate(720,90) rotate(-15) scale(1)'/>" +
      "<use href='#leaf' transform='translate(220,280) rotate(40) scale(1.1)'/></g>" +
      "<g fill='#c73e22' opacity='0.7'>" +
      "<use href='#leaf' transform='translate(80,320) rotate(-50) scale(1.3)'/>" +
      "<use href='#leaf' transform='translate(430,240) rotate(25) scale(0.8)'/>" +
      "<use href='#leaf' transform='translate(660,360) rotate(-30) scale(1.2)'/>" +
      "<use href='#leaf' transform='translate(300,450) rotate(60) scale(1.5)'/></g>" +
      "<g fill='#ff7a45' opacity='0.6'>" +
      "<use href='#leaf' transform='translate(520,480) rotate(15) scale(1)'/>" +
      "<use href='#leaf' transform='translate(740,520) rotate(-45) scale(1.3)'/>" +
      "<use href='#leaf' transform='translate(140,540) rotate(30) scale(0.9)'/></g>" +
      "</svg>";

    // —— 金盏朝日（向日葵抽象 + 暖光） ——
    P.__SUNFLOWER__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0.2' y2='1'>" +
      "<stop offset='0' stop-color='#fff8e6'/><stop offset='0.6' stop-color='#ffefc4'/><stop offset='1' stop-color='#ffe3a0'/></linearGradient>" +
      "<radialGradient id='gl'><stop offset='0' stop-color='#fff' stop-opacity='0.9'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>" +
      "<radialGradient id='core'><stop offset='0' stop-color='#8a5a1e'/><stop offset='1' stop-color='#6b4413'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='180' cy='130' r='160' fill='url(#gl)'/>" +
      "<circle cx='650' cy='480' r='190' fill='url(#gl)' opacity='0.75'/>" +
      // 大向日葵（右上）
      "<g transform='translate(620,170)'>" +
      "<g fill='#f5b52e'>" +
      "<ellipse rx='16' ry='44' transform='rotate(0)'/><ellipse rx='16' ry='44' transform='rotate(30)'/>" +
      "<ellipse rx='16' ry='44' transform='rotate(60)'/><ellipse rx='16' ry='44' transform='rotate(90)'/>" +
      "<ellipse rx='16' ry='44' transform='rotate(120)'/><ellipse rx='16' ry='44' transform='rotate(150)'/></g>" +
      "<g fill='#e89b1e' opacity='0.85'>" +
      "<ellipse rx='14' ry='40' transform='rotate(15)'/><ellipse rx='14' ry='40' transform='rotate(45)'/>" +
      "<ellipse rx='14' ry='40' transform='rotate(75)'/><ellipse rx='14' ry='40' transform='rotate(105)'/>" +
      "<ellipse rx='14' ry='40' transform='rotate(135)'/><ellipse rx='14' ry='40' transform='rotate(165)'/></g>" +
      "<circle r='26' fill='url(#core)'/>" +
      "<circle r='26' fill='#000' opacity='0.08'/>" +
      "<g fill='#4a2e0c' opacity='0.5'><circle cx='-8' cy='-6' r='2'/><circle cx='6' cy='-8' r='2'/>" +
      "<circle cx='10' cy='5' r='2'/><circle cx='-5' cy='9' r='2'/><circle cx='-1' cy='0' r='2'/></g></g>" +
      // 小向日葵（左下）
      "<g transform='translate(160,440) scale(0.55)'>" +
      "<g fill='#f5b52e'><ellipse rx='16' ry='44'/><ellipse rx='16' ry='44' transform='rotate(45)'/>" +
      "<ellipse rx='16' ry='44' transform='rotate(90)'/><ellipse rx='16' ry='44' transform='rotate(135)'/></g>" +
      "<circle r='26' fill='url(#core)'/></g>" +
      // 光斑
      "<g fill='#ffd76a' opacity='0.55'>" +
      "<circle cx='350' cy='120' r='8'/><circle cx='430' cy='300' r='5'/>" +
      "<circle cx='240' cy='240' r='6'/><circle cx='530' cy='420' r='7'/>" +
      "<circle cx='700' cy='330' r='4'/><circle cx='90' cy='300' r='5'/></g>" +
      "</svg>";

    // —— 远山墨色（层叠山峦 + 水面 + 孤舟） ——
    P.__MOUNTAIN__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#101c26'/><stop offset='0.65' stop-color='#1b2e3c'/><stop offset='1' stop-color='#27414f'/></linearGradient>" +
      "<radialGradient id='gl'><stop offset='0' stop-color='#cfe6f5' stop-opacity='0.2'/><stop offset='1' stop-color='#cfe6f5' stop-opacity='0'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='620' cy='110' r='150' fill='url(#gl)'/>" +
      "<circle cx='620' cy='110' r='38' fill='#dceaf5' opacity='0.85'/>" +
      // 远山（三层递进）
      "<path d='M0,300 L140,190 L260,270 L400,160 L540,260 L680,180 L800,250 L800,600 L0,600 Z' fill='#22394a' opacity='0.65'/>" +
      "<path d='M0,360 L120,270 L280,340 L420,250 L580,335 L700,270 L800,330 L800,600 L0,600 Z' fill='#1b2f3f' opacity='0.85'/>" +
      "<path d='M0,430 L160,340 L320,410 L500,320 L660,400 L800,350 L800,600 L0,600 Z' fill='#14252f'/>" +
      // 水面
      "<rect y='470' width='800' height='130' fill='#0e1d28'/>" +
      "<path d='M0,470 L800,470 L800,478 L0,478 Z' fill='#33505f' opacity='0.6'/>" +
      // 山影倒影（翻转淡出）
      "<path d='M120,478 L260,540 L400,478 Z' fill='#1b2f3f' opacity='0.35'/>" +
      "<path d='M500,478 L620,530 L720,478 Z' fill='#1b2f3f' opacity='0.3'/>" +
      // 孤舟
      "<g transform='translate(330,500)'>" +
      "<path d='M-26,0 L26,0 L18,10 L-18,10 Z' fill='#3d5668'/>" +
      "<line x1='0' y1='0' x2='0' y2='-22' stroke='#3d5668' stroke-width='2'/>" +
      "<path d='M0,-22 L14,-6 L0,-6 Z' fill='#4a6578'/></g>" +
      // 星点
      "<g fill='#fff' opacity='0.7'>" +
      "<circle cx='90' cy='60' r='1.3'/><circle cx='220' cy='40' r='1.1'/>" +
      "<circle cx='380' cy='80' r='1.4'/><circle cx='500' cy='45' r='1.1'/>" +
      "<circle cx='730' cy='70' r='1.3'/><circle cx='150' cy='150' r='1'/></g>" +
      "</svg>";

    // —— 极光之夜（极光带 + 雪原剪影） ——
    P.__AURORA__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#050e1e'/><stop offset='0.7' stop-color='#0c1e3a'/><stop offset='1' stop-color='#14294a'/></linearGradient>" +
      "<linearGradient id='au1' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#43d9a3' stop-opacity='0.55'/><stop offset='1' stop-color='#43d9a3' stop-opacity='0'/></linearGradient>" +
      "<linearGradient id='au2' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#7a5fd0' stop-opacity='0.45'/><stop offset='1' stop-color='#7a5fd0' stop-opacity='0'/></linearGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<g fill='#fff' opacity='0.8'>" +
      "<circle cx='90' cy='60' r='1.4'/><circle cx='210' cy='40' r='1.1'/>" +
      "<circle cx='360' cy='75' r='1.5'/><circle cx='500' cy='45' r='1.2'/>" +
      "<circle cx='650' cy='80' r='1.4'/><circle cx='750' cy='50' r='1.1'/>" +
      "<circle cx='140' cy='150' r='1.2'/><circle cx='430' cy='130' r='1.3'/>" +
      "<circle cx='580' cy='160' r='1.1'/></g>" +
      // 极光带（绿主紫辅，帘幕形）
      "<path d='M-20,120 C150,60 300,170 480,110 C620,65 720,120 820,90 L820,300 C700,340 560,260 420,310 C280,360 120,270 -20,330 Z' fill='url(#au1)'/>" +
      "<path d='M-20,180 C180,120 340,230 520,170 C660,125 740,180 820,150 L820,330 C700,370 580,300 440,345 C300,390 130,320 -20,370 Z' fill='url(#au2)'/>" +
      "<path d='M-20,90 C160,40 320,130 500,80 C640,40 730,90 820,60 L820,150 C700,190 560,120 420,165 C280,210 120,140 -20,180 Z' fill='url(#au1)' opacity='0.6'/>" +
      // 雪原与松林剪影
      "<path d='M0,520 C200,490 400,530 600,505 C700,492 760,510 800,500 L800,600 L0,600 Z' fill='#1c3050'/>" +
      "<g fill='#0a182c'>" +
      "<path d='M100,520 L120,470 L140,520 Z'/><path d='M108,492 L120,462 L132,492 Z'/>" +
      "<path d='M650,510 L672,452 L694,510 Z'/><path d='M660,478 L672,442 L684,478 Z'/>" +
      "<path d='M300,515 L314,478 L328,515 Z'/></g>" +
      "</svg>";

    // —— 暮光峡谷（峡谷剪影 + 夕阳） ——
    P.__CANYON__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#2b1440'/><stop offset='0.45' stop-color='#7a2d54'/>" +
      "<stop offset='0.75' stop-color='#d65a3a'/><stop offset='1' stop-color='#f5a05a'/></linearGradient>" +
      "<radialGradient id='sun'><stop offset='0' stop-color='#ffd9a0' stop-opacity='0.95'/>" +
      "<stop offset='0.4' stop-color='#ff9e5e' stop-opacity='0.5'/><stop offset='1' stop-color='#ff9e5e' stop-opacity='0'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='400' cy='380' r='180' fill='url(#sun)'/>" +
      "<circle cx='400' cy='380' r='46' fill='#ffe3b8'/>" +
      // 云
      "<g fill='#f5b8c9' opacity='0.35'>" +
      "<ellipse cx='180' cy='150' rx='90' ry='14'/><ellipse cx='230' cy='130' rx='60' ry='10'/>" +
      "<ellipse cx='620' cy='200' rx='100' ry='13'/><ellipse cx='560' cy='180' rx='55' ry='9'/></g>" +
      // 峡谷壁（左右剪影，层叠）
      "<path d='M0,220 L90,260 L60,340 L130,420 L70,600 L0,600 Z' fill='#33184a'/>" +
      "<path d='M0,300 L60,330 L30,430 L90,500 L40,600 L0,600 Z' fill='#241040'/>" +
      "<path d='M800,200 L700,250 L740,340 L660,430 L720,600 L800,600 Z' fill='#33184a'/>" +
      "<path d='M800,290 L730,320 L760,420 L690,490 L750,600 L800,600 Z' fill='#241040'/>" +
      // 谷底
      "<path d='M0,600 L200,520 L400,560 L600,510 L800,600 Z' fill='#1a0c33'/>" +
      // 飞鸟
      "<g stroke='#2b1440' stroke-width='2' fill='none' opacity='0.7'>" +
      "<path d='M330,240 q6,-8 12,0 q6,-8 12,0'/>" +
      "<path d='M460,210 q5,-7 10,0 q5,-7 10,0'/></g>" +
      "</svg>";

    // —— 雪原晨光（雪地起伏 + 晨光 + 松影） ——
    P.__SNOW__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#dcecF7'/><stop offset='0.5' stop-color='#eef5fa'/><stop offset='1' stop-color='#f8fbfd'/></linearGradient>" +
      "<radialGradient id='dawn'><stop offset='0' stop-color='#ffe9c4' stop-opacity='0.9'/>" +
      "<stop offset='0.5' stop-color='#ffd9a0' stop-opacity='0.35'/><stop offset='1' stop-color='#ffd9a0' stop-opacity='0'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='580' cy='150' r='200' fill='url(#dawn)'/>" +
      "<circle cx='580' cy='150' r='42' fill='#fff3dc'/>" +
      // 远山淡影
      "<path d='M0,320 L150,240 L300,300 L450,230 L600,290 L800,240 L800,600 L0,600 Z' fill='#c9dcea' opacity='0.6'/>" +
      // 雪地两层起伏
      "<path d='M0,430 C200,400 350,450 520,425 C650,406 740,430 800,420 L800,600 L0,600 Z' fill='#e8f1f8'/>" +
      "<path d='M0,500 C220,470 420,515 620,490 C710,478 770,492 800,485 L800,600 L0,600 Z' fill='#f4f9fc'/>" +
      // 松树剪影
      "<g fill='#7d9db8' opacity='0.85'>" +
      "<path d='M140,440 L165,375 L190,440 Z'/><path d='M150,405 L165,360 L180,405 Z'/><rect x='161' y='440' width='8' height='16'/>" +
      "<path d='M680,455 L700,400 L720,455 Z'/><path d='M688,425 L700,388 L712,425 Z'/><rect x='697' y='455' width='7' height='14'/>" +
      "<path d='M400,470 L414,428 L428,470 Z'/><path d='M406,448 L414,418 L422,448 Z'/></g>" +
      // 雪点
      "<g fill='#fff' opacity='0.9'>" +
      "<circle cx='90' cy='80' r='2.2'/><circle cx='230' cy='140' r='1.8'/>" +
      "<circle cx='370' cy='70' r='2.4'/><circle cx='480' cy='200' r='1.6'/>" +
      "<circle cx='700' cy='90' r='2'/><circle cx='150' cy='250' r='1.7'/>" +
      "<circle cx='620' cy='300' r='2.1'/><circle cx='300' cy='340' r='1.5'/></g>" +
      "</svg>";

    /* ---------- 动态壁纸（SMIL 动画） ---------- */

    // —— 樱落（樱吹雪底 + 8 瓣飘落） ——
    P.__SAKURA_FALL__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0.3' y2='1'>" +
      "<stop offset='0' stop-color='#fff8fa'/><stop offset='0.55' stop-color='#ffeef3'/><stop offset='1' stop-color='#ffdfe9'/></linearGradient>" +
      "<radialGradient id='gl'><stop offset='0' stop-color='#fff' stop-opacity='0.9'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>" +
      petal
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='150' cy='110' r='140' fill='url(#gl)'/>" +
      "<circle cx='650' cy='470' r='180' fill='url(#gl)' opacity='0.8'/>" +
      // 飘落花瓣（各自轨迹/时长/相位）
      "<g fill='#f28db3' opacity='0.85'><g><animateTransform attributeName='transform' type='translate' values='100 -30; 160 630' dur='9s' begin='0s' repeatCount='indefinite'/><use href='#ptl'><animateTransform attributeName='transform' type='rotate' values='0;360' dur='4.2s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f5a8c4' opacity='0.75'><g><animateTransform attributeName='transform' type='translate' values='260 -50; 190 630' dur='12s' begin='-4s' repeatCount='indefinite'/><use href='#ptl' transform='scale(0.8)'><animateTransform attributeName='transform' type='rotate' values='360;0' dur='5s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f28db3' opacity='0.9'><g><animateTransform attributeName='transform' type='translate' values='420 -40; 490 630' dur='10s' begin='-7s' repeatCount='indefinite'/><use href='#ptl' transform='scale(1.3)'><animateTransform attributeName='transform' type='rotate' values='0;-360' dur='3.6s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f7c6d8' opacity='0.6'><g><animateTransform attributeName='transform' type='translate' values='580 -20; 520 630' dur='14s' begin='-2s' repeatCount='indefinite'/><use href='#ptl' transform='scale(0.6)'><animateTransform attributeName='transform' type='rotate' values='0;360' dur='6s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f5a8c4' opacity='0.8'><g><animateTransform attributeName='transform' type='translate' values='700 -60; 760 630' dur='11s' begin='-8.5s' repeatCount='indefinite'/><use href='#ptl' transform='scale(1.1)'><animateTransform attributeName='transform' type='rotate' values='360;0' dur='4.8s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f28db3' opacity='0.7'><g><animateTransform attributeName='transform' type='translate' values='40 -80; 120 630' dur='13s' begin='-5.5s' repeatCount='indefinite'/><use href='#ptl' transform='scale(0.9)'><animateTransform attributeName='transform' type='rotate' values='0;360' dur='5.4s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f7c6d8' opacity='0.55'><g><animateTransform attributeName='transform' type='translate' values='340 -70; 280 630' dur='15s' begin='-10s' repeatCount='indefinite'/><use href='#ptl' transform='scale(0.55)'><animateTransform attributeName='transform' type='rotate' values='0;-360' dur='7s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "<g fill='#f5a8c4' opacity='0.85'><g><animateTransform attributeName='transform' type='translate' values='640 -35; 600 630' dur='9.5s' begin='-3s' repeatCount='indefinite'/><use href='#ptl' transform='scale(1.2)'><animateTransform attributeName='transform' type='rotate' values='360;0' dur='3.9s' repeatCount='indefinite' additive='sum'/></use></g></g>" +
      "</svg>";

    // —— 星语（星空底 + 闪烁 + 流星巡回） ——
    P.__STAR_TWINKLE__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#060d20'/><stop offset='0.6' stop-color='#11214a'/><stop offset='1' stop-color='#1b3766'/></linearGradient>" +
      "<radialGradient id='neb'><stop offset='0' stop-color='#5ba3f5' stop-opacity='0.3'/><stop offset='1' stop-color='#5ba3f5' stop-opacity='0'/></radialGradient>" +
      "<radialGradient id='neb2'><stop offset='0' stop-color='#a78bfa' stop-opacity='0.24'/><stop offset='1' stop-color='#a78bfa' stop-opacity='0'/></radialGradient>" +
      "<path id='sp' d='M0,-5 L1.3,-1.3 L5,0 L1.3,1.3 L0,5 L-1.3,1.3 L-5,0 L-1.3,-1.3 Z'/>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<ellipse cx='620' cy='140' rx='260' ry='180' fill='url(#neb)'/>" +
      "<ellipse cx='180' cy='420' rx='240' ry='160' fill='url(#neb2)'/>" +
      "<ellipse cx='400' cy='665' rx='560' ry='140' fill='#2a4a7f' opacity='0.4'/>" +
      // 静态底星
      "<g fill='#cfe3ff' opacity='0.55'>" +
      "<circle cx='430' cy='40' r='1.1'/><circle cx='760' cy='180' r='1.4'/>" +
      "<circle cx='400' cy='190' r='1.1'/><circle cx='650' cy='340' r='1.2'/>" +
      "<circle cx='220' cy='430' r='1.3'/><circle cx='350' cy='380' r='1.1'/></g>" +
      // 闪烁星（不同周期）
      "<circle cx='80' cy='70' r='1.8' fill='#fff'><animate attributeName='opacity' values='1;0.15;1' dur='2.4s' repeatCount='indefinite'/></circle>" +
      "<circle cx='320' cy='90' r='2' fill='#fff'><animate attributeName='opacity' values='0.2;1;0.2' dur='3.1s' repeatCount='indefinite'/></circle>" +
      "<circle cx='540' cy='110' r='1.7' fill='#cfe3ff'><animate attributeName='opacity' values='1;0.2;1' dur='2.8s' begin='-1s' repeatCount='indefinite'/></circle>" +
      "<circle cx='200' cy='45' r='1.5' fill='#fff'><animate attributeName='opacity' values='0.3;1;0.3' dur='3.7s' begin='-0.6s' repeatCount='indefinite'/></circle>" +
      "<circle cx='700' cy='60' r='1.6' fill='#fff'><animate attributeName='opacity' values='1;0.1;1' dur='2.1s' begin='-1.4s' repeatCount='indefinite'/></circle>" +
      "<circle cx='140' cy='200' r='1.5' fill='#cfe3ff'><animate attributeName='opacity' values='0.25;1;0.25' dur='4.2s' begin='-2s' repeatCount='indefinite'/></circle>" +
      "<circle cx='560' cy='260' r='1.6' fill='#fff'><animate attributeName='opacity' values='1;0.2;1' dur='3.4s' begin='-0.9s' repeatCount='indefinite'/></circle>" +
      "<circle cx='90' cy='360' r='1.7' fill='#fff'><animate attributeName='opacity' values='0.3;1;0.3' dur='2.6s' begin='-1.8s' repeatCount='indefinite'/></circle>" +
      "<use href='#sp' fill='#fff' transform='translate(150,130) scale(1.4)'><animate attributeName='opacity' values='1;0.4;1' dur='3s' repeatCount='indefinite'/></use>" +
      "<use href='#sp' fill='#cfe3ff' transform='translate(640,90) scale(1.1)'><animate attributeName='opacity' values='0.4;1;0.4' dur='3.8s' repeatCount='indefinite'/></use>" +
      // 流星巡回（两条错开）
      "<g stroke-linecap='round'><line x1='0' y1='0' x2='-58' y2='34' stroke='#eaf4ff' stroke-width='1.8'>" +
      "<animateMotion path='M680,60 L240,330' dur='7s' begin='0s' repeatCount='indefinite' rotate='auto'/>" +
      "<animate attributeName='opacity' values='0;0;0.95;0.95;0' keyTimes='0;0.08;0.2;0.6;0.9' dur='7s' repeatCount='indefinite'/></line></g>" +
      "<g stroke-linecap='round'><line x1='0' y1='0' x2='-44' y2='26' stroke='#d5e6ff' stroke-width='1.3'>" +
      "<animateMotion path='M420,40 L80,260' dur='9s' begin='-4.5s' repeatCount='indefinite' rotate='auto'/>" +
      "<animate attributeName='opacity' values='0;0;0.8;0.8;0' keyTimes='0;0.1;0.25;0.6;0.9' dur='9s' begin='-4.5s' repeatCount='indefinite'/></line></g>" +
      "</svg>";

    // —— 极光流（极光带缓慢漂移） ——
    P.__AURORA_FLOW__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#050e1e'/><stop offset='0.7' stop-color='#0c1e3a'/><stop offset='1' stop-color='#14294a'/></linearGradient>" +
      "<linearGradient id='au1' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#43d9a3' stop-opacity='0.55'/><stop offset='1' stop-color='#43d9a3' stop-opacity='0'/></linearGradient>" +
      "<linearGradient id='au2' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#7a5fd0' stop-opacity='0.45'/><stop offset='1' stop-color='#7a5fd0' stop-opacity='0'/></linearGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<g fill='#fff' opacity='0.8'>" +
      "<circle cx='90' cy='60' r='1.4'/><circle cx='360' cy='75' r='1.5'/>" +
      "<circle cx='650' cy='80' r='1.4'/><circle cx='430' cy='130' r='1.3'/>" +
      "<circle cx='210' cy='40' r='1.1'/><circle cx='750' cy='50' r='1.1'/></g>" +
      // 漂移极光带
      "<path d='M-60,120 C150,60 300,170 480,110 C620,65 720,120 860,90 L860,300 C700,340 560,260 420,310 C280,360 120,270 -60,330 Z' fill='url(#au1)'>" +
      "<animateTransform attributeName='transform' type='translate' values='0 0; -50 25; 0 0' dur='14s' repeatCount='indefinite'/></path>" +
      "<path d='M-60,180 C180,120 340,230 520,170 C660,125 740,180 860,150 L860,330 C700,370 580,300 440,345 C300,390 130,320 -60,370 Z' fill='url(#au2)'>" +
      "<animateTransform attributeName='transform' type='translate' values='0 0; 45 -20; 0 0' dur='11s' repeatCount='indefinite'/></path>" +
      "<path d='M-60,90 C160,40 320,130 500,80 C640,40 730,90 860,60 L860,150 C700,190 560,120 420,165 C280,210 120,140 -60,180 Z' fill='url(#au1)' opacity='0.6'>" +
      "<animateTransform attributeName='transform' type='translate' values='0 0; -35 15; 0 0' dur='17s' repeatCount='indefinite'/></path>" +
      // 雪原剪影
      "<path d='M0,520 C200,490 400,530 600,505 C700,492 760,510 800,500 L800,600 L0,600 Z' fill='#1c3050'/>" +
      "<g fill='#0a182c'>" +
      "<path d='M100,520 L120,470 L140,520 Z'/><path d='M108,492 L120,462 L132,492 Z'/>" +
      "<path d='M650,510 L672,452 L694,510 Z'/><path d='M660,478 L672,442 L684,478 Z'/></g>" +
      "</svg>";

    // —— 雪落（雪原底 + 飘雪） ——
    P.__SNOW_DRIFT__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#dcecf7'/><stop offset='0.5' stop-color='#eef5fa'/><stop offset='1' stop-color='#f8fbfd'/></linearGradient>" +
      "<radialGradient id='dawn'><stop offset='0' stop-color='#ffe9c4' stop-opacity='0.85'/>" +
      "<stop offset='0.5' stop-color='#ffd9a0' stop-opacity='0.3'/><stop offset='1' stop-color='#ffd9a0' stop-opacity='0'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='580' cy='150' r='200' fill='url(#dawn)'/>" +
      "<circle cx='580' cy='150' r='42' fill='#fff3dc'/>" +
      "<path d='M0,320 L150,240 L300,300 L450,230 L600,290 L800,240 L800,600 L0,600 Z' fill='#c9dcea' opacity='0.6'/>" +
      "<path d='M0,430 C200,400 350,450 520,425 C650,406 740,430 800,420 L800,600 L0,600 Z' fill='#e8f1f8'/>" +
      "<path d='M0,500 C220,470 420,515 620,490 C710,478 770,492 800,485 L800,600 L0,600 Z' fill='#f4f9fc'/>" +
      "<g fill='#7d9db8' opacity='0.85'>" +
      "<path d='M140,440 L165,375 L190,440 Z'/><path d='M150,405 L165,360 L180,405 Z'/>" +
      "<path d='M680,455 L700,400 L720,455 Z'/><path d='M688,425 L700,388 L712,425 Z'/></g>" +
      // 飘雪（大小两档，S 形轨迹）
      "<g fill='#ffffff' opacity='0.95'>" +
      "<circle r='2.6'><animateMotion path='M100,-20 C160,150 60,350 120,620' dur='8s' repeatCount='indefinite'/></circle>" +
      "<circle r='2'><animateMotion path='M250,-30 C190,160 300,380 230,620' dur='11s' begin='-3s' repeatCount='indefinite'/></circle>" +
      "<circle r='3'><animateMotion path='M400,-15 C460,180 360,360 430,620' dur='9s' begin='-5s' repeatCount='indefinite'/></circle>" +
      "<circle r='1.8'><animateMotion path='M540,-25 C490,150 590,370 520,620' dur='12s' begin='-7s' repeatCount='indefinite'/></circle>" +
      "<circle r='2.4'><animateMotion path='M660,-20 C720,170 620,380 690,620' dur='10s' begin='-1.5s' repeatCount='indefinite'/></circle>" +
      "<circle r='1.6'><animateMotion path='M50,-40 C100,140 20,360 80,620' dur='13s' begin='-9s' repeatCount='indefinite'/></circle>" +
      "<circle r='2.2'><animateMotion path='M320,-35 C260,160 370,370 300,620' dur='9.5s' begin='-4.5s' repeatCount='indefinite'/></circle>" +
      "<circle r='1.9'><animateMotion path='M740,-30 C690,160 780,360 720,620' dur='11.5s' begin='-6s' repeatCount='indefinite'/></circle>" +
      "<circle r='2.8'><animateMotion path='M180,-25 C240,170 140,370 210,620' dur='8.5s' begin='-2s' repeatCount='indefinite'/></circle>" +
      "<circle r='1.7'><animateMotion path='M480,-45 C530,150 440,360 510,620' dur='14s' begin='-8s' repeatCount='indefinite'/></circle></g>" +
      "</svg>";

    // —— 萤火（深夜草丛 + 萤火虫漂移呼吸） ——
    P.__FIREFLY__ = this._svgOpen(
      "<linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#070f0a'/><stop offset='0.6' stop-color='#0e1a12'/><stop offset='1' stop-color='#16281c'/></linearGradient>" +
      "<radialGradient id='glow'><stop offset='0' stop-color='#d9f99d' stop-opacity='0.5'/>" +
      "<stop offset='0.4' stop-color='#b7e04a' stop-opacity='0.15'/><stop offset='1' stop-color='#b7e04a' stop-opacity='0'/></radialGradient>" +
      "<radialGradient id='moon'><stop offset='0' stop-color='#e8f2d8' stop-opacity='0.3'/><stop offset='1' stop-color='#e8f2d8' stop-opacity='0'/></radialGradient>"
    ) +
      "<rect width='800' height='600' fill='url(#bg)'/>" +
      "<circle cx='640' cy='110' r='130' fill='url(#moon)'/>" +
      "<circle cx='640' cy='110' r='34' fill='#e8f2d8' opacity='0.8'/>" +
      // 星点
      "<g fill='#cfe3c0' opacity='0.6'>" +
      "<circle cx='90' cy='70' r='1.2'/><circle cx='240' cy='50' r='1'/>" +
      "<circle cx='400' cy='90' r='1.3'/><circle cx='520' cy='45' r='1'/></g>" +
      // 草丛剪影
      "<path d='M0,600 L0,520 Q30,470 45,530 Q60,480 80,535 Q100,485 115,540 Q140,490 160,545 L200,600 Z' fill='#0a140d'/>" +
      "<path d='M800,600 L800,510 Q770,465 755,525 Q740,475 720,530 Q700,480 685,538 Q660,488 645,542 L600,600 Z' fill='#0a140d'/>" +
      "<path d='M250,600 Q400,545 550,600 Z' fill='#0c1710'/>" +
      // 萤火虫（光晕 + 漂移 + 呼吸）
      "<g><circle r='14' fill='url(#glow)'><animateMotion path='M150,320 C220,260 180,400 260,340 C320,290 200,380 150,320' dur='11s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.1;1;0.4;0.9;0.1' dur='4.5s' repeatCount='indefinite'/></circle>" +
      "<circle r='3' fill='#e4ffa8'><animateMotion path='M150,320 C220,260 180,400 260,340 C320,290 200,380 150,320' dur='11s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.2;1;0.5;1;0.2' dur='4.5s' repeatCount='indefinite'/></circle></g>" +
      "<g><circle r='12' fill='url(#glow)'><animateMotion path='M480,260 C560,210 520,350 600,300 C660,250 540,340 480,260' dur='13s' begin='-4s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.9;0.2;0.8;0.3;0.9' dur='5.5s' begin='-1s' repeatCount='indefinite'/></circle>" +
      "<circle r='2.6' fill='#e4ffa8'><animateMotion path='M480,260 C560,210 520,350 600,300 C660,250 540,340 480,260' dur='13s' begin='-4s' repeatCount='indefinite'/><animate attributeName='opacity' values='1;0.3;0.9;0.4;1' dur='5.5s' begin='-1s' repeatCount='indefinite'/></circle></g>" +
      "<g><circle r='10' fill='url(#glow)'><animateMotion path='M330,420 C400,370 360,480 440,430 C500,390 380,480 330,420' dur='9s' begin='-2s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.3;1;0.2;0.8;0.3' dur='3.8s' begin='-2.2s' repeatCount='indefinite'/></circle>" +
      "<circle r='2.3' fill='#e4ffa8'><animateMotion path='M330,420 C400,370 360,480 440,430 C500,390 380,480 330,420' dur='9s' begin='-2s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.4;1;0.3;0.9;0.4' dur='3.8s' begin='-2.2s' repeatCount='indefinite'/></circle></g>" +
      "<g><circle r='11' fill='url(#glow)'><animateMotion path='M650,380 C710,330 670,450 740,400 C780,360 700,450 650,380' dur='12s' begin='-7s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.8;0.25;0.9;0.35;0.8' dur='4.9s' begin='-0.5s' repeatCount='indefinite'/></circle>" +
      "<circle r='2.4' fill='#e4ffa8'><animateMotion path='M650,380 C710,330 670,450 740,400 C780,360 700,450 650,380' dur='12s' begin='-7s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.9;0.35;1;0.45;0.9' dur='4.9s' begin='-0.5s' repeatCount='indefinite'/></circle></g>" +
      "<g><circle r='9' fill='url(#glow)'><animateMotion path='M90,180 C150,140 120,260 190,220 C240,180 140,260 90,180' dur='10s' begin='-5s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.5;1;0.2;0.7;0.5' dur='4.2s' begin='-3s' repeatCount='indefinite'/></circle>" +
      "<circle r='2' fill='#e4ffa8'><animateMotion path='M90,180 C150,140 120,260 190,220 C240,180 140,260 90,180' dur='10s' begin='-5s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.6;1;0.3;0.8;0.6' dur='4.2s' begin='-3s' repeatCount='indefinite'/></circle></g>" +
      "</svg>";


    /* —— 巨物动漫风（0.20.1）：靠"发光巨物 + 深色天空"的强对比做巨物感。
     *    实测教训：面板的 backdrop-filter blur(20px) 会把细节糊掉，所以巨物必须
     *    是大块逆光剪影（法一：亮天空压暗剪影；法二：暗天空托发光体），
     *    细长/低对比的构图在面板区域会完全消失。 —— */
    P.__GIANT_MOON__ =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><defs><filter id="soft" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="26"/></filter><filter id="softs" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="10"/></filter><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1040"/><stop offset="0.22" stop-color="#4b2872"/><stop offset="0.42" stop-color="#8b4a8e"/><stop offset="0.58" stop-color="#c9769a"/><stop offset="0.72" stop-color="#eda183"/><stop offset="0.85" stop-color="#f9c88f"/><stop offset="1" stop-color="#ffe7b8"/></linearGradient><radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffaf0" stop-opacity="0.95"/><stop offset="0.32" stop-color="#ffd9a4" stop-opacity="0.42"/><stop offset="1" stop-color="#ffd9a4" stop-opacity="0"/></radialGradient><radialGradient id="face" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffdf6" stop-opacity="undefined"/><stop offset="0.7" stop-color="#fef2da" stop-opacity="undefined"/><stop offset="1" stop-color="#f2ddba" stop-opacity="undefined"/></radialGradient></defs><rect width="1600" height="1000" fill="url(#sky)"/><circle cx="800" cy="470" r="620" fill="url(#halo)"/><circle cx="800" cy="470" r="268" fill="url(#face)"/><g fill="#edd7b0" opacity="0.5"><circle cx="720" cy="408" r="44"/><circle cx="878" cy="392" r="26"/><circle cx="852" cy="534" r="50"/><circle cx="726" cy="548" r="24"/><circle cx="790" cy="470" r="76"/></g><g filter="url(#soft)"><ellipse cx="-100" cy="235" rx="137" ry="21" fill="#f6cede" opacity="0.42"/><ellipse cx="157" cy="258" rx="192" ry="26" fill="#f6cede" opacity="0.42"/><ellipse cx="414" cy="251" rx="160" ry="31" fill="#f6cede" opacity="0.42"/><ellipse cx="671" cy="244" rx="215" ry="21" fill="#f6cede" opacity="0.42"/><ellipse cx="929" cy="237" rx="182" ry="26" fill="#f6cede" opacity="0.42"/><ellipse cx="1186" cy="260" rx="150" ry="31" fill="#f6cede" opacity="0.42"/><ellipse cx="1443" cy="253" rx="205" ry="22" fill="#f6cede" opacity="0.42"/><ellipse cx="1700" cy="246" rx="173" ry="27" fill="#f6cede" opacity="0.42"/></g><g filter="url(#soft)"><ellipse cx="-10" cy="337" rx="151" ry="24" fill="#ffffff" opacity="0.5"/><ellipse cx="290" cy="360" rx="212" ry="30" fill="#ffffff" opacity="0.5"/><ellipse cx="590" cy="353" rx="176" ry="35" fill="#ffffff" opacity="0.5"/><ellipse cx="890" cy="346" rx="237" ry="24" fill="#ffffff" opacity="0.5"/><ellipse cx="1190" cy="339" rx="202" ry="30" fill="#ffffff" opacity="0.5"/><ellipse cx="1490" cy="362" rx="166" ry="36" fill="#ffffff" opacity="0.5"/><ellipse cx="1790" cy="355" rx="227" ry="24" fill="#ffffff" opacity="0.5"/></g><g filter="url(#soft)"><ellipse cx="-60" cy="585" rx="166" ry="28" fill="#ffe6c8" opacity="0.55"/><ellipse cx="197" cy="608" rx="232" ry="35" fill="#ffe6c8" opacity="0.55"/><ellipse cx="454" cy="601" rx="193" ry="42" fill="#ffe6c8" opacity="0.55"/><ellipse cx="711" cy="594" rx="260" ry="28" fill="#ffe6c8" opacity="0.55"/><ellipse cx="969" cy="587" rx="221" ry="35" fill="#ffe6c8" opacity="0.55"/><ellipse cx="1226" cy="610" rx="182" ry="42" fill="#ffe6c8" opacity="0.55"/><ellipse cx="1483" cy="603" rx="248" ry="29" fill="#ffe6c8" opacity="0.55"/><ellipse cx="1740" cy="596" rx="209" ry="36" fill="#ffe6c8" opacity="0.55"/></g><g filter="url(#soft)"><ellipse cx="40" cy="685" rx="180" ry="32" fill="#fff0d8" opacity="0.6"/><ellipse cx="340" cy="708" rx="253" ry="40" fill="#fff0d8" opacity="0.6"/><ellipse cx="640" cy="701" rx="210" ry="48" fill="#fff0d8" opacity="0.6"/><ellipse cx="940" cy="694" rx="283" ry="33" fill="#fff0d8" opacity="0.6"/><ellipse cx="1240" cy="687" rx="240" ry="40" fill="#fff0d8" opacity="0.6"/><ellipse cx="1540" cy="710" rx="198" ry="48" fill="#fff0d8" opacity="0.6"/><ellipse cx="1840" cy="703" rx="270" ry="33" fill="#fff0d8" opacity="0.6"/></g><g filter="url(#soft)"><ellipse cx="800" cy="612" rx="420" ry="34" fill="#ffd8b0" opacity="0.5"/><ellipse cx="800" cy="368" rx="360" ry="26" fill="#ffffff" opacity="0.42"/></g><path d="M0,706 L190,628 L340,700 L500,636 L660,708 L840,640 L1010,712 L1200,644 L1390,714 L1600,662 L1600,1000 L0,1000 Z" fill="#6b4470" opacity="0.85"/><path d="M0,790 L200,724 L380,792 L560,728 L780,796 L1000,732 L1220,800 L1420,740 L1600,802 L1600,1000 L0,1000 Z" fill="#482c52" opacity="0.95"/><path d="M0,880 C260,846 480,892 720,868 C960,844 1220,888 1600,856 L1600,1000 L0,1000 Z" fill="#2a1734"/><g fill="#170d1f"><path d="M352,880 L352,798 L359,798 L359,880 Z"/><ellipse cx="355" cy="874" rx="30" ry="8"/><path d="M356,806 C328,806 310,786 307,758 C334,755 352,772 356,798 Z"/><path d="M356,806 C384,806 402,786 405,758 C378,755 360,772 356,798 Z"/><path d="M356,792 C340,752 342,716 356,690 C370,716 372,752 356,792 Z"/></g><g fill="#170d1f"><circle cx="1180" cy="852" r="6"/><path d="M1172,860 L1188,860 L1185,888 L1175,888 Z"/></g></svg>`;
    P.__GIANT_TOWER__ =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><defs><filter id="soft" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="26"/></filter><filter id="softs" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="10"/></filter><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a1030"/><stop offset="0.2" stop-color="#8f2b3a"/><stop offset="0.38" stop-color="#d4593a"/><stop offset="0.55" stop-color="#f08b46"/><stop offset="0.72" stop-color="#fcc06a"/><stop offset="0.88" stop-color="#ffe4a4"/><stop offset="1" stop-color="#fff6d8"/></linearGradient><radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffdf4" stop-opacity="1"/><stop offset="0.28" stop-color="#ffdf9c" stop-opacity="0.55"/><stop offset="1" stop-color="#ffdf9c" stop-opacity="0"/></radialGradient></defs><rect width="1600" height="1000" fill="url(#sky)"/><circle cx="760" cy="700" r="520" fill="url(#sun)"/><g filter="url(#soft)"><ellipse cx="-100" cy="193" rx="144" ry="18" fill="#f6a878" opacity="0.45"/><ellipse cx="157" cy="216" rx="202" ry="23" fill="#f6a878" opacity="0.45"/><ellipse cx="414" cy="209" rx="168" ry="27" fill="#f6a878" opacity="0.45"/><ellipse cx="671" cy="202" rx="226" ry="18" fill="#f6a878" opacity="0.45"/><ellipse cx="929" cy="195" rx="192" ry="23" fill="#f6a878" opacity="0.45"/><ellipse cx="1186" cy="218" rx="158" ry="27" fill="#f6a878" opacity="0.45"/><ellipse cx="1443" cy="211" rx="216" ry="19" fill="#f6a878" opacity="0.45"/><ellipse cx="1700" cy="204" rx="182" ry="23" fill="#f6a878" opacity="0.45"/></g><g filter="url(#soft)"><ellipse cx="-30" cy="285" rx="158" ry="22" fill="#ffc48c" opacity="0.5"/><ellipse cx="270" cy="308" rx="222" ry="28" fill="#ffc48c" opacity="0.5"/><ellipse cx="570" cy="301" rx="185" ry="33" fill="#ffc48c" opacity="0.5"/><ellipse cx="870" cy="294" rx="249" ry="23" fill="#ffc48c" opacity="0.5"/><ellipse cx="1170" cy="287" rx="211" ry="28" fill="#ffc48c" opacity="0.5"/><ellipse cx="1470" cy="310" rx="174" ry="34" fill="#ffc48c" opacity="0.5"/><ellipse cx="1770" cy="303" rx="238" ry="23" fill="#ffc48c" opacity="0.5"/></g><g filter="url(#soft)"><ellipse cx="-80" cy="675" rx="173" ry="29" fill="#ffe0ae" opacity="0.58"/><ellipse cx="177" cy="698" rx="242" ry="37" fill="#ffe0ae" opacity="0.58"/><ellipse cx="434" cy="691" rx="202" ry="44" fill="#ffe0ae" opacity="0.58"/><ellipse cx="691" cy="684" rx="271" ry="30" fill="#ffe0ae" opacity="0.58"/><ellipse cx="949" cy="677" rx="230" ry="37" fill="#ffe0ae" opacity="0.58"/><ellipse cx="1206" cy="700" rx="190" ry="44" fill="#ffe0ae" opacity="0.58"/><ellipse cx="1463" cy="693" rx="259" ry="30" fill="#ffe0ae" opacity="0.58"/><ellipse cx="1720" cy="686" rx="218" ry="37" fill="#ffe0ae" opacity="0.58"/></g><g filter="url(#soft)"><ellipse cx="20" cy="767" rx="187" ry="35" fill="#fff0cc" opacity="0.7"/><ellipse cx="320" cy="790" rx="263" ry="44" fill="#fff0cc" opacity="0.7"/><ellipse cx="620" cy="783" rx="218" ry="52" fill="#fff0cc" opacity="0.7"/><ellipse cx="920" cy="776" rx="294" ry="36" fill="#fff0cc" opacity="0.7"/><ellipse cx="1220" cy="769" rx="250" ry="44" fill="#fff0cc" opacity="0.7"/><ellipse cx="1520" cy="792" rx="205" ry="52" fill="#fff0cc" opacity="0.7"/><ellipse cx="1820" cy="785" rx="281" ry="36" fill="#fff0cc" opacity="0.7"/></g><g fill="#43122c"><path d="M742,196 L818,196 L864,470 L864,1000 L636,1000 L636,470 Z"/><path d="M736,214 L788,168 L836,214 Z"/><path d="M688,470 L836,470 L842,510 L682,510 Z"/><path d="M692,640 L838,640 L844,676 L686,676 Z"/></g><path d="M812,214 L836,470 L836,1000" fill="none" stroke="#ffcf8a" stroke-width="6" opacity="0.6"/><path d="M760,214 L736,470 L736,1000" fill="none" stroke="#ffb96a" stroke-width="4" opacity="0.35"/><g fill="#ffe8b0" opacity="0.85"><circle cx="762" cy="300" r="6"/><circle cx="762" cy="392" r="6"/><circle cx="762" cy="500" r="6"/><circle cx="800" cy="344" r="5"/><circle cx="800" cy="446" r="5"/><circle cx="800" cy="560" r="5"/></g><g fill="#5a1a34" opacity="0.85"><path d="M300,600 L520,586 L536,598 L316,614 Z"/><ellipse cx="418" cy="612" rx="52" ry="12"/><path d="M1090,520 L1320,506 L1336,518 L1106,534 Z"/><ellipse cx="1213" cy="532" rx="56" ry="13"/></g><g filter="url(#soft)"><ellipse cx="760" cy="840" rx="520" ry="70" fill="#ffeec4" opacity="0.9"/><ellipse cx="440" cy="880" rx="480" ry="66" fill="#fff4d8" opacity="0.82"/><ellipse cx="1180" cy="890" rx="500" ry="68" fill="#fff4d8" opacity="0.82"/></g><path d="M0,928 C260,894 520,936 780,916 C1040,896 1320,938 1600,910 L1600,1000 L0,1000 Z" fill="#2c0b1e"/><g fill="#1a0612"><circle cx="230" cy="880" r="6"/><path d="M222,889 L238,889 L235,928 L225,928 Z"/><path d="M1420,912 L1420,846 L1432,846 L1432,912 Z"/><path d="M1408,856 L1444,856 L1426,824 Z"/></g><g fill="none" stroke="#43122c" stroke-width="2.6" opacity="0.6"><path d="M1180,270 q10,-8 20,0 q10,-8 20,0"/><path d="M1270,318 q9,-7 18,0 q9,-7 18,0"/></g></svg>`;
    P.__GIANT_GATE__ =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><defs><filter id="soft" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="26"/></filter><filter id="softs" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="10"/></filter><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#081226"/><stop offset="0.28" stop-color="#102546"/><stop offset="0.52" stop-color="#1d3f63"/><stop offset="0.72" stop-color="#3a6a80"/><stop offset="0.88" stop-color="#7fb0ac"/><stop offset="1" stop-color="#d9e8d4"/></linearGradient><radialGradient id="portal" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#eafff4" stop-opacity="0.95"/><stop offset="0.35" stop-color="#9be8c8" stop-opacity="0.42"/><stop offset="1" stop-color="#9be8c8" stop-opacity="0"/></radialGradient></defs><rect width="1600" height="1000" fill="url(#sky)"/><circle cx="169" cy="397" r="1.3" fill="#fff" opacity="0.35"/><circle cx="217" cy="486" r="1.0" fill="#fff" opacity="0.89"/><circle cx="527" cy="187" r="1.1" fill="#fff" opacity="0.39"/><circle cx="621" cy="283" r="1.8" fill="#fff" opacity="0.64"/><circle cx="700" cy="220" r="0.9" fill="#fff" opacity="0.53"/><circle cx="538" cy="579" r="1.3" fill="#fff" opacity="0.22"/><circle cx="113" cy="206" r="1.9" fill="#fff" opacity="0.82"/><circle cx="1510" cy="597" r="2.0" fill="#fff" opacity="0.41"/><circle cx="927" cy="318" r="0.7" fill="#fff" opacity="0.47"/><circle cx="95" cy="387" r="1.6" fill="#fff" opacity="0.84"/><circle cx="240" cy="423" r="2.3" fill="#fff" opacity="0.74"/><circle cx="192" cy="440" r="2.1" fill="#fff" opacity="0.50"/><circle cx="561" cy="531" r="1.2" fill="#fff" opacity="0.51"/><circle cx="1200" cy="210" r="2.0" fill="#fff" opacity="0.38"/><circle cx="1104" cy="543" r="1.5" fill="#fff" opacity="0.32"/><circle cx="489" cy="5" r="0.9" fill="#fff" opacity="0.90"/><circle cx="696" cy="49" r="1.8" fill="#fff" opacity="0.31"/><circle cx="905" cy="425" r="1.6" fill="#fff" opacity="0.78"/><circle cx="997" cy="501" r="1.7" fill="#fff" opacity="0.85"/><circle cx="1155" cy="230" r="2.4" fill="#fff" opacity="0.77"/><circle cx="1394" cy="10" r="2.2" fill="#fff" opacity="0.74"/><circle cx="993" cy="316" r="2.3" fill="#fff" opacity="0.41"/><circle cx="1571" cy="157" r="2.2" fill="#fff" opacity="0.88"/><circle cx="1583" cy="549" r="1.5" fill="#fff" opacity="0.60"/><circle cx="732" cy="156" r="1.3" fill="#fff" opacity="0.54"/><circle cx="1173" cy="588" r="2.0" fill="#fff" opacity="0.41"/><circle cx="307" cy="97" r="0.9" fill="#fff" opacity="0.52"/><circle cx="309" cy="159" r="1.5" fill="#fff" opacity="0.30"/><circle cx="985" cy="141" r="2.4" fill="#fff" opacity="0.71"/><circle cx="287" cy="50" r="1.5" fill="#fff" opacity="0.50"/><circle cx="658" cy="495" r="2.0" fill="#fff" opacity="0.55"/><circle cx="527" cy="437" r="1.3" fill="#fff" opacity="0.47"/><circle cx="799" cy="491" r="2.4" fill="#fff" opacity="0.25"/><circle cx="20" cy="184" r="2.0" fill="#fff" opacity="0.32"/><circle cx="678" cy="542" r="1.6" fill="#fff" opacity="0.45"/><circle cx="1426" cy="492" r="2.4" fill="#fff" opacity="0.23"/><circle cx="1519" cy="468" r="1.1" fill="#fff" opacity="0.28"/><circle cx="1133" cy="48" r="1.6" fill="#fff" opacity="0.23"/><circle cx="391" cy="248" r="1.7" fill="#fff" opacity="0.50"/><circle cx="1078" cy="220" r="0.7" fill="#fff" opacity="0.50"/><circle cx="1175" cy="62" r="1.1" fill="#fff" opacity="0.27"/><circle cx="1229" cy="522" r="1.0" fill="#fff" opacity="0.48"/><circle cx="1556" cy="505" r="1.0" fill="#fff" opacity="0.48"/><circle cx="980" cy="292" r="0.7" fill="#fff" opacity="0.35"/><circle cx="1545" cy="344" r="1.1" fill="#fff" opacity="0.36"/><circle cx="746" cy="517" r="2.3" fill="#fff" opacity="0.29"/><circle cx="801" cy="339" r="2.0" fill="#fff" opacity="0.68"/><circle cx="133" cy="572" r="2.3" fill="#fff" opacity="0.32"/><circle cx="391" cy="1" r="1.2" fill="#fff" opacity="0.73"/><circle cx="661" cy="86" r="1.1" fill="#fff" opacity="0.74"/><circle cx="39" cy="439" r="1.1" fill="#fff" opacity="0.48"/><circle cx="139" cy="226" r="1.4" fill="#fff" opacity="0.72"/><circle cx="1428" cy="178" r="1.7" fill="#fff" opacity="0.29"/><circle cx="235" cy="511" r="1.7" fill="#fff" opacity="0.84"/><circle cx="1371" cy="412" r="0.9" fill="#fff" opacity="0.46"/><circle cx="1168" cy="445" r="0.9" fill="#fff" opacity="0.40"/><circle cx="649" cy="504" r="2.4" fill="#fff" opacity="0.65"/><circle cx="554" cy="356" r="1.2" fill="#fff" opacity="0.61"/><circle cx="5" cy="152" r="2.1" fill="#fff" opacity="0.41"/><circle cx="830" cy="57" r="1.5" fill="#fff" opacity="0.65"/><circle cx="1530" cy="313" r="1.3" fill="#fff" opacity="0.25"/><circle cx="940" cy="167" r="1.6" fill="#fff" opacity="0.73"/><circle cx="335" cy="567" r="1.4" fill="#fff" opacity="0.53"/><circle cx="530" cy="518" r="1.0" fill="#fff" opacity="0.65"/><circle cx="58" cy="179" r="1.0" fill="#fff" opacity="0.83"/><circle cx="423" cy="8" r="1.7" fill="#fff" opacity="0.89"/><circle cx="1372" cy="150" r="1.9" fill="#fff" opacity="0.80"/><circle cx="47" cy="596" r="1.7" fill="#fff" opacity="0.47"/><circle cx="1222" cy="260" r="2.2" fill="#fff" opacity="0.38"/><circle cx="547" cy="196" r="2.3" fill="#fff" opacity="0.28"/><circle cx="261" cy="438" r="2.4" fill="#fff" opacity="0.30"/><circle cx="947" cy="130" r="2.4" fill="#fff" opacity="0.46"/><circle cx="390" cy="391" r="1.9" fill="#fff" opacity="0.40"/><circle cx="649" cy="350" r="1.8" fill="#fff" opacity="0.63"/><circle cx="25" cy="507" r="1.1" fill="#fff" opacity="0.37"/><circle cx="1065" cy="280" r="2.0" fill="#fff" opacity="0.57"/><circle cx="1248" cy="566" r="2.2" fill="#fff" opacity="0.29"/><circle cx="258" cy="258" r="2.2" fill="#fff" opacity="0.46"/><circle cx="246" cy="446" r="1.1" fill="#fff" opacity="0.73"/><circle cx="552" cy="317" r="2.0" fill="#fff" opacity="0.45"/><circle cx="1121" cy="179" r="0.9" fill="#fff" opacity="0.40"/><circle cx="762" cy="569" r="2.1" fill="#fff" opacity="0.85"/><circle cx="181" cy="298" r="2.5" fill="#fff" opacity="0.88"/><circle cx="103" cy="233" r="1.2" fill="#fff" opacity="0.37"/><circle cx="124" cy="585" r="1.2" fill="#fff" opacity="0.47"/><circle cx="1498" cy="85" r="1.0" fill="#fff" opacity="0.87"/><circle cx="74" cy="494" r="2.4" fill="#fff" opacity="0.87"/><circle cx="1560" cy="367" r="1.1" fill="#fff" opacity="0.48"/><circle cx="1592" cy="376" r="1.3" fill="#fff" opacity="0.53"/><circle cx="208" cy="396" r="1.6" fill="#fff" opacity="0.34"/><circle cx="1344" cy="358" r="2.4" fill="#fff" opacity="0.87"/><circle cx="898" cy="224" r="1.2" fill="#fff" opacity="0.59"/><circle cx="846" cy="185" r="1.9" fill="#fff" opacity="0.38"/><circle cx="504" cy="392" r="1.0" fill="#fff" opacity="0.33"/><circle cx="338" cy="460" r="1.7" fill="#fff" opacity="0.25"/><ellipse cx="800" cy="560" rx="470" ry="520" fill="url(#portal)" opacity="0.55"/><path d="M470,1000 L470,560 C470,378 618,232 800,232 C982,232 1130,378 1130,560 L1130,1000 Z" fill="#0f1830"/><path d="M520,1000 L520,566 C520,406 646,282 800,282 C954,282 1080,406 1080,566 L1080,1000 Z" fill="#16233f"/><path d="M562,1000 L562,572 C562,436 668,330 800,330 C932,330 1038,436 1038,572 L1038,1000 Z" fill="url(#portal)" opacity="0.75"/><path d="M562,1000 L562,572 C562,436 668,330 800,330 C932,330 1038,436 1038,572 L1038,1000 Z" fill="none" stroke="#bff0dc" stroke-width="3" opacity="0.5"/><g fill="none" stroke="#2c3c60" stroke-width="9" opacity="0.9"><path d="M470,1000 L470,560 C470,378 618,232 800,232 C982,232 1130,378 1130,560 L1130,1000"/><path d="M520,1000 L520,566 C520,406 646,282 800,282 C954,282 1080,406 1080,566 L1080,1000"/></g><g filter="url(#soft)"><ellipse cx="-100" cy="645" rx="144" ry="24" fill="#cfe8dd" opacity="0.42"/><ellipse cx="200" cy="668" rx="202" ry="30" fill="#cfe8dd" opacity="0.42"/><ellipse cx="500" cy="661" rx="168" ry="35" fill="#cfe8dd" opacity="0.42"/><ellipse cx="800" cy="654" rx="226" ry="24" fill="#cfe8dd" opacity="0.42"/><ellipse cx="1100" cy="647" rx="192" ry="30" fill="#cfe8dd" opacity="0.42"/><ellipse cx="1400" cy="670" rx="158" ry="36" fill="#cfe8dd" opacity="0.42"/><ellipse cx="1700" cy="663" rx="216" ry="24" fill="#cfe8dd" opacity="0.42"/></g><g filter="url(#soft)"><ellipse cx="-40" cy="797" rx="173" ry="32" fill="#e8f6ea" opacity="0.62"/><ellipse cx="217" cy="820" rx="242" ry="40" fill="#e8f6ea" opacity="0.62"/><ellipse cx="474" cy="813" rx="202" ry="48" fill="#e8f6ea" opacity="0.62"/><ellipse cx="731" cy="806" rx="271" ry="33" fill="#e8f6ea" opacity="0.62"/><ellipse cx="989" cy="799" rx="230" ry="40" fill="#e8f6ea" opacity="0.62"/><ellipse cx="1246" cy="822" rx="190" ry="48" fill="#e8f6ea" opacity="0.62"/><ellipse cx="1503" cy="815" rx="259" ry="33" fill="#e8f6ea" opacity="0.62"/><ellipse cx="1760" cy="808" rx="218" ry="41" fill="#e8f6ea" opacity="0.62"/></g><g filter="url(#soft)"><ellipse cx="-90" cy="885" rx="194" ry="38" fill="#f6fdf4" opacity="0.72"/><ellipse cx="210" cy="908" rx="273" ry="47" fill="#f6fdf4" opacity="0.72"/><ellipse cx="510" cy="901" rx="227" ry="56" fill="#f6fdf4" opacity="0.72"/><ellipse cx="810" cy="894" rx="305" ry="38" fill="#f6fdf4" opacity="0.72"/><ellipse cx="1110" cy="887" rx="259" ry="48" fill="#f6fdf4" opacity="0.72"/><ellipse cx="1410" cy="910" rx="213" ry="57" fill="#f6fdf4" opacity="0.72"/><ellipse cx="1710" cy="903" rx="292" ry="39" fill="#f6fdf4" opacity="0.72"/></g><g filter="url(#soft)"><ellipse cx="800" cy="960" rx="1100" ry="150" fill="#f4fcf0" opacity="0.8"/></g><g fill="#0a1020"><circle cx="800" cy="848" r="8"/><path d="M790,858 L810,858 L806,900 L794,900 Z"/></g></svg>`;
    return P;
  },

  /* ==================== 色彩工具 ==================== */

  _hex2rgb(hex) {
    let h = String(hex || "").replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  },

  _rgba(hex, a) {
    const rgb = this._hex2rgb(hex);
    if (!rgb) return hex;
    return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
  },

  /** c1 占比 t 的线性混合（0-1），任一无效则回退 c1 */
  _mix(c1, c2, t) {
    const a = this._hex2rgb(c1), b = this._hex2rgb(c2);
    if (!a) return c1;
    if (!b) return c1;
    const r = Math.round(a[0] * t + b[0] * (1 - t));
    const g = Math.round(a[1] * t + b[1] * (1 - t));
    const bl = Math.round(a[2] * t + b[2] * (1 - t));
    return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
  },

  _svgURI(svg) {
    return "data:image/svg+xml," + encodeURIComponent(svg).replace(/'/g, "%27");
  },

  /* ==================== 壁纸引擎 v2（0.19.0）：mesh 氛围光 ====================
   * 0.16~0.18 的壁纸是"具象插画"（樱花/远山/雪落），实测效果：800×600 的插画
   * 被 cover 拉伸到全屏后元素巨大且模糊，浅色主题下几乎不可见，观感廉价。
   * v2 改为「色相分层的 mesh 氛围光」：
   *   · 取主题 accent 作主色，用 _shiftHue 派生 2~3 个邻近色相副色
   *   · 四团大半径柔光叠加成有机的渐变场，靠色相差异而非具象形状建立层次
   *   · 画布 1600×1000（与主流屏比例接近，cover 拉伸不变形不糊）
   *   · 动态版给每团光加 SMIL 位置漂移，形成缓慢呼吸的氛围流动
   * pref wpEngine = "mesh"（默认）/ "art"（回退到 0.18 的具象插画） */

  /** HSL 色相偏移 + 饱和度/明度缩放：从强调色派生协调副色 */
  _shiftHue(hex, deg, satMul, lightMul) {
    const h0 = String(hex || "#888888").replace("#", "");
    const n = parseInt(h0.length === 3 ? h0.split("").map((c) => c + c).join("") : h0.slice(0, 6), 16);
    if (!isFinite(n)) return hex;
    let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = 0; s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    h = (h + (deg || 0) / 360 + 1) % 1;
    s = Math.min(1, Math.max(0, s * (satMul === undefined ? 1 : satMul)));
    l = Math.min(1, Math.max(0, l * (lightMul === undefined ? 1 : lightMul)));
    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    let rr, gg, bb;
    if (s === 0) { rr = gg = bb = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      rr = hue2rgb(p, q, h + 1 / 3); gg = hue2rgb(p, q, h); bb = hue2rgb(p, q, h - 1 / 3);
    }
    const to = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
    return "#" + to(rr) + to(gg) + to(bb);
  },

  /** 生成 mesh 氛围光壁纸（anim=true 时光团缓慢漂移） */
  _meshSVG(theme, anim) {
    const c = theme.colors || {};
    const dark = !!theme.dark;
    const A = c.accent || "#0969da";
    const B = this._shiftHue(A, dark ? -30 : 36, dark ? 0.92 : 0.80, dark ? 0.94 : 1.02);
    const C = this._shiftHue(A, dark ? 46 : -48, dark ? 0.86 : 0.74, dark ? 0.98 : 1.06);
    const D = this._shiftHue(A, dark ? 18 : 20, dark ? 0.90 : 0.85, dark ? 1.00 : 1.04);
    const blobs = [
      { cx: 0.13, cy: 0.08, r: 0.74, color: A, op: dark ? 0.42 : 0.30, drift: 0.05 },
      { cx: 0.94, cy: 0.28, r: 0.64, color: B, op: dark ? 0.34 : 0.24, drift: 0.06 },
      { cx: 0.54, cy: 1.10, r: 1.00, color: C, op: dark ? 0.32 : 0.22, drift: 0.04 },
      { cx: 0.02, cy: 0.86, r: 0.70, color: D, op: dark ? 0.24 : 0.17, drift: 0.07 },
    ];
    const W = 1600, H = 1000;
    let defs = "", body = "";
    blobs.forEach((b, i) => {
      const id = "ppb" + i;
      defs += "<radialGradient id='" + id + "' cx='" + b.cx + "' cy='" + b.cy + "' r='" + b.r + "'>" +
        "<stop offset='0' stop-color='" + this._rgba(b.color, b.op) + "'/>" +
        "<stop offset='0.45' stop-color='" + this._rgba(b.color, b.op * 0.45) + "'/>" +
        "<stop offset='1' stop-color='" + this._rgba(b.color, 0) + "'/></radialGradient>";
      if (anim) {
        const d = b.drift;
        const xs = b.cx + ";" + (b.cx + d).toFixed(3) + ";" + (b.cx - d * 0.6).toFixed(3) + ";" + b.cx;
        const ys = b.cy + ";" + (b.cy - d * 0.7).toFixed(3) + ";" + (b.cy + d * 0.5).toFixed(3) + ";" + b.cy;
        defs += "<animate href='#" + id + "' attributeName='cx' values='" + xs + "' dur='" + (26 + i * 7) + "s' repeatCount='indefinite'/>";
        defs += "<animate href='#" + id + "' attributeName='cy' values='" + ys + "' dur='" + (31 + i * 6) + "s' repeatCount='indefinite'/>";
      }
      body += "<rect width='" + W + "' height='" + H + "' fill='url(#" + id + ")'/>";
    });
    defs += "<linearGradient id='ppvig' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#ffffff' stop-opacity='" + (dark ? 0.05 : 0.26) + "'/>" +
      "<stop offset='0.42' stop-color='#ffffff' stop-opacity='0'/>" +
      "<stop offset='1' stop-color='#000000' stop-opacity='" + (dark ? 0.20 : 0.06) + "'/></linearGradient>";
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + W + " " + H + "' " +
      "preserveAspectRatio='xMidYMid slice'><defs>" + defs + "</defs>" +
      "<rect width='" + W + "' height='" + H + "' fill='" + (c.background || "#ffffff") + "'/>" + body +
      "<rect width='" + W + "' height='" + H + "' fill='url(#ppvig)'/></svg>";
  },

  /* ==================== 当前主题 / 壁纸解析 ==================== */

  /** 返回 {id,name,dark,cat,colors,wp,wpOpacity} 或 null（跟随原生） */
  current() {
    const id = String(Prefs.get(this.PREF_KEY, "") || "");
    if (!id) return null;
    if (id === "custom") {
      const c = this.customColors();
      return { id: "custom", name: "自定义", dark: !!c.__dark, cat: "custom", colors: c, wp: null, wpOpacity: null };
    }
    const t = this.THEMES.find((x) => x.id === id) || null;
    if (t) this._resolveSVGs(t); // 幂等：展开过的 wp.svg 不再是占位符
    return t;
  },

  /** 壁纸解析（幂等）：默认走 v2 mesh 氛围光；wpEngine="art" 时回退 0.18 具象插画 */
  _resolveSVGs() {
    const engine = String((Prefs.get("wpEngine", "mesh") || "mesh"));
    for (const t of this.THEMES) {
      if (!t.wp) continue;
      // 巨物系列：手工调过的 SVG，不走 mesh 派生（也不受 wpEngine 影响）
      if (t.wp.art) {
        if (!this._svgPool) this._svgPool = this._buildSVGs();
        if (typeof t.wp.svg === "string" && this._svgPool[t.wp.svg]) {
          t.wp.svg = this._svgPool[t.wp.svg];
        }
        continue;
      }
      if (engine === "art") {
        if (!this._svgPool) this._svgPool = this._buildSVGs();
        if (typeof t.wp.svg === "string" && this._svgPool[t.wp.svg]) {
          t.wp.svg = this._svgPool[t.wp.svg];
        }
        continue;
      }
      if (!t.wp.__mesh) {
        t.wp.__mesh = true;
        t.wp.svg = this._meshSVG(t, t.wp.kind === "svg-anim");
      }
    }
  },

  /** 读取自定义色板并补全派生角色（用户只填 7 个核心角色） */
  customColors() {
    let saved = {};
    try { saved = JSON.parse(Prefs.get(this.PREF_CUSTOM, "") || "{}"); } catch (e) { /* ignore */ }
    const bg = saved.background || "#ffffff";
    const side = saved.side || bg;
    const ink = saved.ink || "#1f2328";
    const accent = saved.accent || "#0969da";
    return {
      __dark: !!saved.__dark,
      background: bg,
      side: side,
      toolbar: side,
      tab: this._mix(side, bg, 0.65),
      surface: saved.surface || this._mix(bg, "#ffffff", 0.85),
      menu: this._mix(side, bg, 0.8),
      ink: ink,
      ink2: this._mix(ink, bg, 0.65),
      ink3: this._mix(ink, bg, 0.4),
      line: saved.line || this._mix(ink, bg, 0.18),
      accent: accent,
      select: saved.select || (this._hex2rgb(accent) ? accent : "#0969da"),
    };
  },

  /** 壁纸解析：返回 {kind, svg?, url?, opacity} 或 null。
   *  uiWallpaper = "theme"（主题包壁纸）/"off"/"custom"（本地文件或在线 URL） */
  wallpaper(theme) {
    const sel = String(Prefs.get(this.PREF_WP, "theme") || "theme");
    let base = null;
    if (sel === "off") return null;
    if (sel === "custom") {
      // 0.18.0：在线 URL 优先（http/https 直链），其次本地文件
      const url = String(Prefs.get("uiWallpaperUrl", "") || "").trim();
      if (/^https?:\/\//i.test(url)) {
        const isVideo = /\.(mp4|webm|mkv|mov|m4v|ogv)(\?|#|$)/i.test(url);
        base = { kind: isVideo ? "video" : "image", url: url, key: "url:" + url };
      } else {
        const path = String(Prefs.get(this.PREF_WP_PATH, "") || "");
        if (!path || !this._isReadableFile(path)) return null;
        const fileUrl = Services.io.newFileURI(Zotero.File.pathToFile(path)).spec;
        const isVideo = /\.(mp4|webm|mkv|mov|m4v|ogv)$/i.test(path);
        base = { kind: isVideo ? "video" : "image", url: fileUrl, key: "path:" + path };
      }
    } else {
      // "theme"：主题包自带壁纸
      if (!theme || !theme.wp) return null;
      // key 用主题 id：v2 的 mesh 壁纸各主题结构一致、只有颜色不同，SVG 长度会撞车
      // （15 套只有 11 种长度），拿长度当签名会导致切主题时壁纸不重建
      base = { kind: theme.wp.kind, svg: theme.wp.svg, anim: !!theme.wp.anim, key: "theme:" + theme.id };
    }
    let opacity = Number(Prefs.get(this.PREF_WP_OPACITY, 70));
    if (!isFinite(opacity)) opacity = 70;
    opacity = Math.min(90, Math.max(10, Math.round(opacity)));
    base.opacity = opacity;
    return base;
  },

  /** 主题推荐可见度（有则覆盖全局滑条，一次性写入 pref） */
  recommendedOpacity(theme) {
    return theme && typeof theme.wpOpacity === "number" ? theme.wpOpacity : null;
  },

  _isReadableFile(path) {
    try {
      const file = Zotero.File.pathToFile(path);
      return file.exists() && file.isFile();
    } catch (e) {
      return false;
    }
  },

  /* ==================== CSS 生成 ==================== */

  /** 壁纸开启时的半透明调色：面板 = (100-opacity)% 不透明，工具栏减半保可读性 */
  _wpSurface(hex, wp) { return wp ? this._rgba(hex, (100 - wp.opacity) / 100) : hex; },
  _wpBar(hex, wp) { return wp ? this._rgba(hex, 1 - wp.opacity / 200) : hex; },

  /** PaperPilot 设置面板变量组（0.17.1 修复：--pp- 从主题色板派生，
   *  覆盖 prefs.css 里只跟 prefers-color-scheme 的默认值——主题强制深/浅色
   *  与系统明暗不一致时，设置卡片不再与窗口背景割裂） */
  _ppVars(theme) {
    const c = theme.colors;
    const dark = theme.dark;
    const mix = (a, b, t) => this._mix(a, b, t);
    const success = dark ? "#3fb950" : "#1a7f37";
    const danger = dark ? "#f85149" : "#cf222e";
    const warn = dark ? "#d29922" : "#9a6700";
    return [
      "--pp-surface: " + c.surface,
      "--pp-surface-2: " + mix(c.surface, c.background, 0.55),
      "--pp-border: " + c.line,
      "--pp-text: " + c.ink,
      "--pp-muted: " + c.ink2,
      "--pp-accent: " + c.accent,
      "--pp-accent-emphasis: " + mix(c.accent, dark ? "#ffffff" : "#000000", 0.82),
      "--pp-accent-weak: " + this._rgba(c.accent, 0.16),
      "--pp-success: " + success,
      "--pp-danger: " + danger,
      "--pp-warn: " + warn,
      "--pp-btn-hover: " + this._rgba(c.ink, 0.07),
      "--pp-focus-ring: " + this._rgba(c.accent, 0.22),
      "--pp-ok-bg: " + this._rgba(success, 0.15),
      "--pp-warn-bg: " + this._rgba(warn, 0.15),
    ];
  },

  /** 主窗口/对话框/功能中心通用变量组（--material-* / --fill-* / --color-* / --accent-*）。
   *  0.25.0 从 _css() 里抽出：阅读器界面要用同一套「色板角色 → 变量」映射，
   *  只是变量名要按 reader.css 的原生拼写来（见 _readerCSS）。 */
  _varDecls(theme, wp) {
    const c = theme.colors;
    return [
      "--material-background: " + this._wpSurface(c.background, wp),
      "--material-sidepane: " + this._wpSurface(c.side, wp),
      "--material-toolbar: " + this._wpBar(c.toolbar, wp),
      "--material-tabbar: " + this._wpSurface(c.tab, wp),
      "--material-menu: " + c.menu,
      "--material-surface: " + c.surface,
      "--material-border: 1px solid " + c.line,
      "--material-accent: " + c.accent,
      "--fill-primary: " + c.ink,
      "--fill-secondary: " + c.ink2,
      "--fill-tertiary: " + c.ink3,
      "--fill-quaternary: " + this._mix(c.ink, c.background, 0.16),
      "--fill-quinary: " + this._mix(c.ink, c.background, 0.09),
      "--color-accent: " + c.accent,
      "--color-background: " + c.background,
      "--accent-blue: " + c.accent,
      "--accent-azure: " + this._mix(c.accent, c.background, 0.7),
      "--accent-red: " + (theme.dark ? "#f85149" : "#cf222e"),
      "--accent-green: " + (theme.dark ? "#3fb950" : "#1a7f37"),
      "--accent-yellow: " + (theme.dark ? "#d29922" : "#9a6700"),
      "--arrowpanel-background: " + c.surface,
      "--arrowpanel-color: " + c.ink,
      "--arrowpanel-border-color: " + c.line,
      "--toolbar-bgcolor: " + this._wpBar(c.toolbar, wp),
      "--toolbar-color: " + c.ink,
      "--lwt-accent-color: " + this._wpBar(c.toolbar, wp),
      "--lwt-selected-tab-background-color: " + this._wpSurface(c.background, wp),
      "--tabpanel-background-color: " + this._wpSurface(c.background, wp),
    ];
  },

  /** 阅读器界面（reader.html）的变量组。
   *  ⚠️ 这里刻意不复用 _varDecls()：reader.css 用的是**原生拼写**
   *  `--fill-quarternary`（少一个 r，Zotero 自己的拼写），而主窗口那套是
   *  `--fill-quaternary`；写错一个字母，reader 的所有 hover 底色就全失效。
   *  只覆盖颜色，不碰布局；`color-scheme` 一并同步，让滚动条/表单控件跟着明暗走。 */
  _readerCSS(theme) {
    const c = theme.colors;
    const dark = !!theme.dark;
    const mix = (a, b, t) => this._mix(a, b, t);
    const decls = [
      // 结构底色
      "--color-background: " + c.background,
      "--color-background50: " + this._rgba(c.background, 0.5),
      "--color-background70: " + this._rgba(c.background, 0.7),
      "--color-sidepane: " + c.side,
      "--color-toolbar: " + c.toolbar,
      "--color-tabbar: " + c.tab,
      "--color-menu: " + c.menu,
      "--color-button: " + c.surface,
      "--color-control: " + c.surface,
      "--color-border: " + c.line,
      "--color-border50: " + this._rgba(c.line, 0.5),
      "--color-panedivider: " + c.line,
      "--color-quinary-on-background: " + mix(c.ink, c.background, 0.05),
      "--color-quarternary-on-background: " + mix(c.ink, c.background, 0.10),
      "--color-quarternary-on-sidepane: " + mix(c.ink, c.side, 0.10),
      // 文字 / 填充层
      "--fill-primary: " + c.ink,
      "--fill-secondary: " + c.ink2,
      "--fill-tertiary: " + c.ink3,
      "--fill-quarternary: " + mix(c.ink, c.background, 0.10),
      "--fill-quinary: " + mix(c.ink, c.background, 0.05),
      "--fill-senary: " + this._rgba(c.ink, 0.02),
      // 强调色（reader 只用 accent-blue 一支）
      "--accent-blue: " + c.accent,
      "--accent-blue10: " + this._rgba(c.accent, 0.10),
      "--accent-blue30: " + this._rgba(c.accent, 0.30),
      "--accent-blue50: " + this._rgba(c.accent, 0.50),
      "--accent-red: " + (dark ? "#f85149" : "#cf222e"),
      "--accent-green: " + (dark ? "#3fb950" : "#1a7f37"),
      "--accent-yellow: " + (dark ? "#d29922" : "#9a6700"),
      // material 层（reader.css 里多半只是 var() 别名，这里直接给值更稳）
      "--material-background: " + c.background,
      "--material-background50: " + this._rgba(c.background, 0.5),
      "--material-background70: " + this._rgba(c.background, 0.7),
      "--material-sidepane: " + c.side,
      "--material-toolbar: " + c.toolbar,
      "--material-tabbar: " + c.tab,
      "--material-menu: " + c.menu,
      "--material-button: " + c.surface,
      "--material-control: " + c.surface,
      "--material-border: 1px solid " + c.line,
      "--material-panedivider: 1px solid " + c.line,
      "--material-border-quinary: 1px solid " + this._rgba(c.ink, 0.05),
      "color-scheme: " + (dark ? "dark" : "light"),
    ];
    return ":root {\n  " + decls.map((d) => d + " !important;").join("\n  ") + "\n}\n";
  },

  /** 把界面主题注入单个阅读器文档（reader.html）。
   *  reader.css 把变量声明在 :root 上；我们在**同一个元素**上用 !important 覆盖，
   *  必胜它的 `:root[data-color-scheme=...]`（important 压制 non-important，
   *  与特异性无关），也就避开了「子元素自身声明胜过父级继承」那条层叠铁律。 */
  applyToReaderDoc(doc) {
    if (!doc || !doc.documentElement) return;
    try {
      const theme = this.current();
      let style = doc.getElementById(this.READER_STYLE_ID);
      if (!theme) {
        if (style) style.remove();
        return;
      }
      if (!style) {
        style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
        style.id = this.READER_STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
      }
      const css = this._readerCSS(theme);
      if (style.textContent !== css) style.textContent = css;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** 已打开的阅读器文档列表（与 PdfTheme.refresh 同一双路径枚举） */
  _readerDocs() {
    const out = [];
    const push = (win) => {
      if (win && win.document && out.indexOf(win.document) < 0) out.push(win.document);
    };
    try {
      for (const r of (Zotero.Reader && Zotero.Reader._readers) || []) push(r && r._iframeWindow);
    } catch (e) { /* ignore */ }
    try {
      for (const win of Zotero.getMainWindows()) {
        if (!win.ZoteroPane) continue;
        for (const bro of win.document.querySelectorAll("browser.reader")) push(bro.contentWindow);
      }
    } catch (e) { /* ignore */ }
    return out;
  },

  /** 界面主题变化时，让所有已打开的阅读器界面同步换肤（实时生效，无需重开文档） */
  refreshReaders() {
    for (const doc of this._readerDocs()) this.applyToReaderDoc(doc);
  },

  _css(theme, wp) {
    if (!theme) return "";
    const c = theme.colors;
    // 选中行底色（条目树/分类树）：7 位 hex 补成 8 位带透明度
    let select = c.select || "";
    if (select.length === 7) select += "26";
    const decls = this._varDecls(theme, wp);
    // 设置面板变量组随主题派生
    // ⚠️ 必须直接命中 .pp-root 元素自身：CSS 自定义属性按声明元素层叠，
    // .pp-root 在 prefs.css 里的自身声明永远胜过从父级继承的值（哪怕父级带
    // !important）——注入到 #zotero-prefs 容器上是无效的（0.17.1 仿真实测确认）
    const ppDecls = this._ppVars(theme);
    const mainDecls = decls.map((d) => d + " !important;").join("\n  ");
    const prefsDecls = decls.concat(ppDecls).map((d) => d + " !important;").join("\n  ");
    const ppRootDecls = ppDecls.map((d) => d + " !important;").join("\n  ");

    let css =
      "/* PaperPilot 主题 · " + theme.name + (wp ? " + 壁纸 " + wp.kind : "") + " */\n" +
      "#main-window {\n  " + mainDecls + "\n}\n" +
      "#zotero-prefs {\n  " + decls.map((d) => d + " !important;").join("\n  ") + "\n}\n" +
      "#zotero-prefs .pp-root {\n  " + ppRootDecls + "\n}\n" +
      // 功能中心 + 小对话框窗口（0.17.1 纳入主题作用域）：decls + pp 变量组
      "window[windowtype='paperpilot:hub'],\n" +
      "window[windowtype='paperpilot:dialog'] {\n  " + prefsDecls + "\n}\n" +
      // 对话框表单控件：深色主题下原生白底输入框突兀，随主题化
      "window[windowtype='paperpilot:dialog'] textarea,\n" +
      "window[windowtype='paperpilot:dialog'] input:not([type='checkbox']):not([type='radio']),\n" +
      "window[windowtype='paperpilot:hub'] textarea,\n" +
      "window[windowtype='paperpilot:hub'] input:not([type='checkbox']):not([type='radio']) {\n" +
      "  background-color: " + c.surface + " !important;\n" +
      "  color: " + c.ink + " !important;\n" +
      "  border-color: " + c.line + " !important;\n}\n";

    if (wp) {
      css += this._glassCSS(wp);
    } else {
      css +=
        "#main-window #zotero-pane,\n" +
        "#main-window #zotero-collections-pane,\n" +
        "#main-window #zotero-tag-selector-container,\n" +
        "#main-window #zotero-items-pane,\n" +
        "#main-window #zotero-items-tree,\n" +
        "#main-window #zotero-item-pane,\n" +
        "#main-window .virtualized-table-container,\n" +
        "#main-window .virtualized-table,\n" +
        "#main-window .item-pane-content {\n" +
        "  background-color: " + c.background + " !important;\n}\n";
    }

    css +=
      // 条目树行：hover 加强（0.17.1：6% → 14%，深浅主题下都可辨识）
      "#main-window .virtualized-table .row:hover:not(.selected) {\n" +
      "  background-color: " + this._mix(c.ink, c.background, 0.14) + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n" +
      "#main-window #zotero-items-tree .selected,\n" +
      "#main-window #zotero-collections-tree .selected {\n" +
      "  background-color: " + select + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n" +
      "#main-window .tab:not([selected]):hover {\n" +
      "  background-color: " + this._mix(c.ink, c.tab, 0.08) + " !important;\n}\n" +
      "#main-window .tabs .tab.selected {\n" +
      "  background-color: " + (wp ? this._wpBar(c.surface, wp) : c.surface) + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n" +
      // ---- 0.17.1 Zotero 原生硬编码元素补丁（保守清单：只补实测不吃变量的）----
      // 菜单弹窗项：hover 在部分 Z7 版本硬编码浅灰
      "#main-window menupopup menuitem[_moz-menuactive='true']:not([disabled='true']),\n" +
      "#main-window menupopup menu[_moz-menuactive='true']:not([disabled='true']) {\n" +
      "  background-color: " + this._rgba(c.accent, 0.2) + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n" +
      // 标签选择器 chips
      "#main-window #zotero-tag-selector-container .tag-selector-item {\n" +
      "  color: " + c.ink + " !important;\n}\n" +
      // 条目详情面板字段标签/分隔
      "#main-window #zotero-item-pane label,\n" +
      "#main-window .item-pane-content label {\n" +
      "  color: " + c.ink2 + " !important;\n}\n" +
      // tooltip（html-tooltip 独立于 arrowpanel 变量）
      "#main-window tooltip {\n" +
      "  background-color: " + c.surface + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n";
    return css;
  },

  /** 壁纸模式的面板透明化 + 毛玻璃（GLASS 清单源自 yaobian 实测） */
  _glassCSS(wp) {
    const GLASS = [
      "#tabs-deck", "#tabs-deck > browser", "#tabs-deck > iframe", "#zotero-pane",
      "#zotero-pane #zotero-trees", "#zotero-pane #zotero-layout-switcher",
      "#zotero-pane #zotero-collections-pane",
      "#zotero-pane #zotero-collections-tree-container",
      "#zotero-pane #zotero-tag-selector-container",
      "#zotero-pane #zotero-items-pane-container", "#zotero-pane #zotero-items-pane",
      "#zotero-pane #zotero-items-tree", "#zotero-pane #zotero-item-pane",
      "#zotero-pane #zotero-item-pane-content",
      "#zotero-pane .virtualized-table-container", "#zotero-pane .virtualized-table",
      "#zotero-pane .virtualized-table-header", "#zotero-pane .virtualized-table .body",
      "#zotero-pane .item-pane-content", "#zotero-pane .zotero-view-item-main",
      "#zotero-pane .item-details", "#zotero-pane item-details",
    ];
    const list = (sels, body) =>
      sels.map((s) => "#main-window " + s).join(",\n") + " {\n" + body + "\n}\n";
    const blur = Math.max(2, Math.round(wp.opacity / 7));
    return (
      "#main-window #zotero-pane-stack {\n\tisolation: isolate;\n}\n" +
      "#main-window #" + this.WALLPAPER_ID + " {\n" +
      "\tposition: absolute;\n\tinset: 0;\n\tz-index: 0;\n" +
      "\toverflow: hidden;\n\tpointer-events: none;\n}\n" +
      "#main-window #" + this.WALLPAPER_ID + " > * {\n\tposition: absolute;\n\tinset: 0;\n}\n" +
      "#main-window #zotero-pane-stack > :not(#" + this.WALLPAPER_ID + "):not(#html-tooltip) {\n" +
      "\tposition: relative;\n\tz-index: 1;\n}\n" +
      list(GLASS, "\tbackground-color: transparent !important;\n\tbackground-image: none !important;") +
      list(
        [
          "#zotero-pane .virtualized-table .row:not(.selected):not(:hover)",
          "#zotero-pane .virtualized-table .row:not(.selected):not(:hover) .cell",
        ],
        "\tbackground-color: transparent !important;"
      ) +
      list(
        [".zotero-toolbar", "#zotero-context-pane-sidenav"],
        "\tbackdrop-filter: blur(" + blur + "px);"
      )
    );
  },

  /* ==================== 壁纸图层管理（四引擎） ==================== */

  _applyWallpaper(win, wp) {
    try {
      const doc = win.document;
      let layer = doc.getElementById(this.WALLPAPER_ID);
      if (!wp) {
        if (layer) layer.remove();
        return;
      }
      const stack = doc.getElementById("zotero-pane-stack");
      if (!stack) return;
      if (!layer || layer.parentNode !== stack) {
        if (layer) layer.remove();
        layer = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        layer.id = this.WALLPAPER_ID;
        stack.prepend(layer);
      }
      // 引擎签名：内容相同则跳过重建（避免动画/视频被反复重置）
      // 0.19.0：优先用 wallpaper() 给的 key（主题 id / URL），SVG 长度会撞车不可靠
      const sig = wp.kind + "|" + (wp.key || (wp.svg ? wp.svg.length : wp.url || ""));
      if (layer.getAttribute("data-pp-sig") === sig) return;
      layer.setAttribute("data-pp-sig", sig);
      while (layer.firstChild) layer.removeChild(layer.firstChild);

      if (wp.kind === "svg-anim") {
        // SMIL 动态插画：内联 SVG DOM（背景图引用的 SVG 不跑动画，必须进 DOM）
        try {
          const parser = new win.DOMParser();
          const svgDoc = parser.parseFromString(wp.svg, "image/svg+xml");
          const root = svgDoc.documentElement;
          if (root && root.tagName === "svg") {
            root.setAttribute("width", "100%");
            root.setAttribute("height", "100%");
            root.setAttribute("preserveAspectRatio", "xMidYMid slice");
            layer.appendChild(root); // 自动 adoptNode
          }
        } catch (e) {
          try { Zotero.logError(e); } catch (_) { /* ignore */ }
        }
      } else if (wp.kind === "svg") {
        const holder = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        holder.style.backgroundImage = 'url("' + this._svgURI(wp.svg) + '")';
        holder.style.backgroundSize = "cover";
        holder.style.backgroundPosition = "center";
        holder.style.backgroundRepeat = "no-repeat";
        layer.appendChild(holder);
      } else if (wp.kind === "image") {
        const holder = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        holder.style.backgroundImage = 'url("' + wp.url + '")';
        holder.style.backgroundSize = "cover";
        holder.style.backgroundPosition = "center";
        holder.style.backgroundRepeat = "no-repeat";
        layer.appendChild(holder);
      } else if (wp.kind === "video") {
        const v = doc.createElementNS("http://www.w3.org/1999/xhtml", "video");
        v.src = wp.url;
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.setAttribute("playsinline", "");
        v.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
        layer.appendChild(v);
        try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /* ==================== 应用 / 清除 / 生命周期 ==================== */

  _applyToWindow(win) {
    try {
      this._watchWindow(win);
      const root = win.document && win.document.documentElement;
      if (!root) return;
      const isMain = root.id === "main-window";
      const isPrefs = root.id === "zotero-prefs";
      // 0.17.1：功能中心 + 小对话框纳入主题作用域（workbench 有自治 wbTheme 体系，不纳入）
      const wtype = root.getAttribute("windowtype") || "";
      const isThemedWindow = wtype === "paperpilot:hub" || wtype === "paperpilot:dialog";
      if (!isMain && !isPrefs && !isThemedWindow) return;
      const theme = this.current();
      let style = win.document.getElementById(this.STYLE_ID);
      if (!theme) {
        if (style) style.remove();
        if (isMain) this._applyWallpaper(win, null);
        return;
      }
      // 壁纸只出现在主窗口；设置/功能中心（独立顶层）用不透明调色板
      const wp = isMain ? this.wallpaper(theme) : null;
      if (!style) {
        style = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
        style.id = this.STYLE_ID;
        root.appendChild(style);
      }
      const css = this._css(theme, wp);
      if (style.textContent !== css) style.textContent = css;
      if (isMain) this._applyWallpaper(win, wp);
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  _watchWindow(win) {
    if (!win || win.__ppThemeWatched) return;
    win.__ppThemeWatched = true;
    win.addEventListener("load", () => {
      win.__ppThemeWatched = false;
      this._applyToWindow(win);
    });
  },

  _allWindows() {
    const out = [];
    try {
      const en = Services.wm.getEnumerator(null);
      while (en.hasMoreElements()) {
        const w = en.getNext();
        if (w) out.push(w);
      }
    } catch (e) { /* ignore */ }
    return out;
  },

  /** 主入口：立即对全部窗口应用/清除当前主题（含已打开的阅读器界面） */
  apply() {
    for (const win of this._allWindows()) this._applyToWindow(win);
    this.refreshReaders();
  },

  /** 一键切换主题：配色+壁纸+推荐可见度 打包生效，pref 持久化（重启自动恢复） */
  setTheme(id) {
    Prefs.set(this.PREF_KEY, id || "");
    const theme = this.THEMES.find((t) => t.id === id);
    if (theme) {
      // 主题包壁纸默认跟随主题。0.19.0 起：custom 也一并拉回 theme——
      // 「在线美图/自定义壁纸」是独立通道，点主题卡片 = 配色+壁纸一起切
      // （否则从美图切主题时壁纸不变，用户会以为没生效）；只有 off 尊重用户选择
      const wpSel = String(Prefs.get(this.PREF_WP, "theme") || "theme");
      if (wpSel !== "off") {
        Prefs.set(this.PREF_WP, "theme");
      }
      // 主题推荐可见度写入滑条（用户仍可再调）
      const rec = this.recommendedOpacity(theme);
      if (rec !== null) Prefs.set(this.PREF_WP_OPACITY, rec);
    }
    this.apply();
  },

  /** 0.17.0 壁纸语义迁移（auto→theme、""→off、0.16 内置壁纸 id→theme），幂等 */
  migrateLegacy() {
    try {
      const wpv = String(Prefs.get(this.PREF_WP, "theme"));
      if (wpv === "auto") Prefs.set(this.PREF_WP, "theme");
      else if (wpv === "") Prefs.set(this.PREF_WP, "off");
      else if (["sakura-petals", "starry-sea", "violet-moon", "mint-bubbles"].indexOf(wpv) >= 0) {
        Prefs.set(this.PREF_WP, "theme");
      }
    } catch (e) { /* ignore */ }
  },

  register() {
    this.migrateLegacy();
    this.apply();
    const onWindow = (win) => {
      try {
        if (!win) return;
        win.addEventListener("load", () => this._applyToWindow(win), { once: true });
        this._applyToWindow(win);
      } catch (e) { /* ignore */ }
    };
    try {
      this._winListener = {
        onOpenWindow(xulWin) {
          try {
            onWindow(xulWin && xulWin.docShell
              ? xulWin.docShell.contentViewer.DOMDocument.defaultView
              : null);
          } catch (e) { /* ignore */ }
        },
        onCloseWindow() {},
        onWindowTitleChange() {},
      };
      Services.wm.addListener(this._winListener);
    } catch (e) {
      this._winListener = null; // FF128+：接口已移除，走 domwindowopened
    }
    try {
      this._obsObserver = {
        observe(subject) {
          try {
            const doc = subject && subject.QueryInterface
              ? subject.QueryInterface(Components.interfaces.nsIDOMWindow)
              : null;
            const win = doc || (subject && subject.defaultView);
            onWindow(win || subject);
          } catch (e) {
            try { onWindow(subject); } catch (e2) { /* ignore */ }
          }
        },
      };
      Services.obs.addObserver(this._obsObserver, "domwindowopened", false);
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  unregister() {
    try {
      if (this._winListener) Services.wm.removeListener(this._winListener);
    } catch (e) { /* ignore */ }
    this._winListener = null;
    try {
      if (this._obsObserver) Services.obs.removeObserver(this._obsObserver, "domwindowopened");
    } catch (e) { /* ignore */ }
    this._obsObserver = null;
    for (const win of this._allWindows()) {
      try {
        const s = win.document && win.document.getElementById(this.STYLE_ID);
        if (s) s.remove();
        this._applyWallpaper(win, null);
      } catch (e) { /* ignore */ }
    }
    // 阅读器文档的注入也一并清掉
    for (const doc of this._readerDocs()) {
      try {
        const s = doc.getElementById(this.READER_STYLE_ID);
        if (s) s.remove();
      } catch (e) { /* ignore */ }
    }
  },
};
