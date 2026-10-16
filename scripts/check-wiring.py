#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""launcher.ps1 × account-server.js 接线一致性静态扫描（0.23.0）

目的：GUI 无法在无人环境里真实点击，所以用静态检查兜住三类「点了没反应」的静默失败：
  1. launcher 里调用的函数/按钮处理器是否真的定义了（含 Show-MembershipManager 是否挂到主界面）
  2. launcher 调用的每一个 /api/admin/* 接口，服务端路由里是否真的存在
  3. 会员管理对话框里用到的控件变量是否都在同一函数内先创建后使用

用法：python scripts/check-wiring.py     （在仓库根目录）
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PS1 = os.path.join(ROOT, "scripts", "launcher.ps1")
SRV = os.path.join(ROOT, "server", "account-server.js")
ADMIN_HTML = os.path.join(ROOT, "server", "public", "admin.html")

ps = io.open(PS1, encoding="utf-8").read()
srv = io.open(SRV, encoding="utf-8").read()
html = io.open(ADMIN_HTML, encoding="utf-8").read()

problems = []
passes = []


def ok(cond, label):
    (passes if cond else problems).append(label)
    return cond


# ---------- 1. 函数定义 vs 调用 ----------
# 注意：本文件里的自定义函数**大量是嵌套在对话框函数内部的**（带缩进），
# 所以必须匹配行首可带空白的 function，而不是 ^function。
defs = set(re.findall(r"(?m)^[ \t]*function\s+([A-Za-z][\w-]*)", ps))

# 系统 cmdlet 白名单：只列本文件真正用到的，避免把内置命令误判成「未定义函数」
CMDLETS = {
    "Get-ChildItem", "Get-CimInstance", "Get-Date", "Get-Item", "Get-ItemProperty",
    "Get-NetTCPConnection", "Get-Process", "Invoke-Item", "Invoke-RestMethod",
    "New-Item", "New-Object", "Set-Content", "Set-ItemProperty",
    "Start-Sleep", "Stop-Process", "Test-Path",
}

called = set(re.findall(
    r"\b(Show-[A-Za-z]\w*|Refresh-[A-Za-z]\w*|Get-[A-Za-z]\w*|Set-[A-Za-z]\w*|"
    r"New-[A-Za-z]\w*|Start-[A-Za-z]\w*|Stop-[A-Za-z]\w*|Update-[A-Za-z]\w*|"
    r"Format-[A-Za-z]\w*|Invoke-[A-Za-z]\w*|Require-[A-Za-z]\w*|Hide-[A-Za-z]\w*|"
    r"Exit-[A-Za-z]\w*|Test-[A-Za-z]\w*|Resolve-[A-Za-z]\w*)\b", ps))
missing = sorted(c for c in called if c not in defs and c not in CMDLETS)
ok(not missing, "1.1 launcher 调用的自定义函数均已定义 → 缺失: %s" % (missing or "无"))

for must in ["Show-MembershipManager", "Refresh-Membership", "New-MbBtn", "Show-PriceForm",
             "Get-MembershipText", "Get-OrderStatusText", "Get-CodeStatusText", "Format-Dt",
             "Get-PriceRangeText"]:
    ok(must in defs, "1.2 新函数已定义: %s" % must)

ok("价格与周期" in ps, "1.2b launcher 有「价格与周期」标签页")
ok("/api/admin/prices" in ps, "1.2c launcher 调用了价格表接口")

ok("Show-MembershipManager" in re.findall(r"New-Btn\s+\$grpUser\s+'[^']*'\s+\d+\s+\d+\s+\d+\s+\{\s*([A-Za-z]\w*)", ps) or
   bool(re.search(r"New-Btn\s+\$grpUser[^\n]*\{\s*Show-MembershipManager\s*\}", ps)),
   "1.3 主界面「账号管理」分组挂了会员管理入口")

# ---------- 2. launcher 调的接口 vs 服务端路由 ----------
calls = set()
for m in re.finditer(r"Invoke-AdminApi\s+'(\w+)'\s+([^)]*)", ps):
    method, rest = m.group(1), m.group(2)
    path = re.search(r"'([^']*?(?:/api/[^']*|/api/admin[^']*))'", rest)
    if not path:
        path = re.search(r"\('([^']+)'", rest)
    if not path:
        continue
    raw = path.group(1)
    # 把 '(\'/api/admin/users/\' + $u.id + \'/membership\')' 这类拼接归一成模式
    norm = re.sub(r"'\s*\+\s*[^+']+?\+\s*'", "*", raw)
    norm = re.sub(r"\$\w+", "*", norm)
    norm = re.sub(r"\*+", "*", norm)
    calls.add((method.upper(), norm))

ok(bool(calls), "2.1 扫描到 Invoke-AdminApi 调用 %d 处" % len(calls))

# 服务端路由：取出所有 url === '...' / regex 匹配
routes = set()
for m in re.finditer(r"url\s*===\s*'([^']+)'", srv):
    routes.add(m.group(1))
for m in re.finditer(r"url\.match\((/[^)]*/)", srv):
    pat = m.group(1).replace("\\", "")
    routes.add(pat)
for m in re.finditer(r"url\.startsWith\('([^']+)'\)", srv):
    routes.add(m.group(1) + "*")

for method, norm in sorted(calls):
    # 查询串不参与路由匹配（调用方可能把 '?limit=…' 拼进路径）
    norm = norm.split("?")[0]
    seg = norm.split("/api/")[-1]
    probe = "*" + seg
    hit = any(seg in r or (r.endswith("*") and seg.startswith(r[:-1])) or
              re.sub(r"\(\[\^/\]\+\)|\[a-zA-Z0-9-\]\+|[^\\]*", "*", r).replace("*", "") and
              re.sub(r"[^/]+", "*", r) == norm for r in routes)
    # 更宽松的兜底：把路由里的正则段也替换成 *
    loose = any(re.sub(r"\(\?:[^)]*\)|\[[^\]]*\][+*?]?|[^/]+", "*", r) == norm for r in routes)
    ok(hit or loose, "2.2 服务端存在该路由: %s %s" % (method, norm))

for must in ["/api/admin/membership", "/api/admin/codes", "/api/admin/orders",
             "/api/admin/users", "/api/admin/prices"]:
    ok(must in srv, "2.3 服务端含路由前缀 %s" % must)
ok("fulfill" in srv and "membership" in srv, "2.4 服务端含核销与会员开通逻辑")
ok("upsertPriceItem" in srv and "priceItemOut" in srv, "2.5 服务端接入价格表模块")
ok("priority" in srv and "effectiveFrom" in srv, "2.6 服务端支持优先级与生效时段")

# ---------- 3. admin.html 与 launcher 的口径一致 ----------
ok('id="tab-membership"' in html, "3.1 Web 管理页有「会员管理」标签")
ok("loadMembership" in html and "fulfillOrder" in html and "createCodes" in html,
   "3.2 Web 管理页含会员管理核心函数")
ok("grantMembership" in html, "3.3 Web 管理页含用户开通/续期")
ok("openPriceForm" in html and "savePrice" in html and "loadPrices" in html,
   "3.3b Web 管理页含价格表 CRUD")
ok('id="pr-table"' in html and 'id="price-mask"' in html and 'id="pf-cycle"' in html,
   "3.3c Web 管理页有价格表与编辑弹窗")
ok("Team" not in html, "3.4 Web 管理页已去掉 Team 档（只保留 Free/Pro）")
ok("'Team'" not in ps, "3.5 launcher 已去掉 Team 档")

# ---------- 4. 会员对话框控件变量先建后用 ----------
mblock = ps[ps.index("function Show-MembershipManager"):]
mblock = mblock[:mblock.index("\nfunction ", 10)] if "\nfunction " in mblock[10:] else mblock
used = set(re.findall(r"\$(lvO|lvC|lvP|lblTop|selCodePlan|txtCode\w*|txtFreeLimit|txtProLimit|txtProPrice|txtPay\w*|lblPrice)\b", mblock))
built = set()
for v in ["lvO", "lvC", "lvP", "lblTop", "selCodePlan", "txtCodeMonths", "txtCodeCount", "txtCodeNote",
          "txtFreeLimit", "txtProLimit", "txtProPrice", "txtPayChannel", "txtPayQr", "txtPayText",
          "txtPayNote", "lblPrice"]:
    if re.search(r"\$%s\s*=" % v, mblock):
        built.add(v)
unbuilt = sorted(used - built)
ok(not unbuilt, "4.1 会员对话框控件均已创建 → 未创建: %s" % (unbuilt or "无"))

# ---------- 5. Show-PriceForm 的控件先建后用 ----------
pblock = ps[ps.index("function Show-PriceForm"):]
pblock = pblock[:pblock.index("\nfunction ", 10)] if "\nfunction " in pblock[10:] else pblock
pused = set(re.findall(r"\$(selPlan|selCycle|txtMonths|txtPrice|txtLabel|txtPrio|txtNote|dtFrom|dtTo|chkEnabled|lblPer|lblMsg)\b", pblock))
pbuilt = set(v for v in pused if re.search(r"\$%s\s*=" % v, pblock))
ok(not (pused - pbuilt), "5.1 价格表单控件均已创建 → 未创建: %s" % (sorted(pused - pbuilt) or "无"))
ok("$script:mbCycles" in pblock and "$script:mbPricePlans" in pblock,
   "5.2 价格表单读取脚本级周期/等级数据（跨作用域用 $script:）")

# ---------- 6. 运维三件套接线（1.4.2）----------
LIBS = os.path.join(ROOT, "server", "lib")
lib_src = {}
for fname in ["backup.js", "alerts.js", "lockout.js"]:
    p = os.path.join(LIBS, fname)
    exists = os.path.exists(p)
    ok(exists, "6.1 存在 server/lib/%s" % fname)
    lib_src[fname] = io.open(p, encoding="utf-8").read() if exists else ""

for fname, fns in [("backup.js", ["snapshot", "restore", "prune", "list", "policy"]),
                   ("alerts.js", ["backlogOf", "shouldAlert", "record"]),
                   ("lockout.js", ["registerFailure", "durationFor"])]:
    for fn in fns:
        ok(re.search(r"function %s\b" % fn, lib_src[fname]) is not None,
           "6.2 %s 定义 %s()" % (fname, fn))

for must in ["/api/admin/backups", "/api/admin/alerts", "/unlock"]:
    ok(must in srv, "6.3 服务端含运维路由 %s" % must)
ok("backlogCount" in srv and "snapshots" in srv and "lastSnapshotAt" in srv,
   "6.4 health 暴露积压与快照观测字段")
ok("preflight" in io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read(),
   "6.5 存在 scripts/preflight.py")

# ---------- 6b. 管理操作审计（服务端 1.4.4）----------
AUDIT_LIB = os.path.join(ROOT, "server", "lib", "audit.js")
ok(os.path.exists(AUDIT_LIB), "6b.1 存在 server/lib/audit.js")
audit_src = io.open(AUDIT_LIB, encoding="utf-8").read() if os.path.exists(AUDIT_LIB) else ""
for fn in ["entry", "redact", "append", "list", "stats", "labelOf"]:
    ok(re.search(r"(function %s\b|const %s\s*=)" % (fn, fn), audit_src) is not None,
       "6b.2 audit.js 定义 %s()" % fn)
ok("SECRET_KEY" in audit_src and "***" in audit_src, "6b.3 audit.js 有密钥脱敏")
ok("/api/admin/audit" in srv, "6b.4 服务端有审计查询路由")
audit_calls = len(re.findall(r"auditLog\(req,", srv))
ok(audit_calls >= 20, "6b.5 管理写操作已接审计（%d 处）" % audit_calls)
for a in ["'user.delete'", "'order.fulfill'", "'price.update'", "'backup.restore'", "'membership.config'"]:
    ok(a in srv, "6b.6 覆盖动作 %s" % a)
ok("auditBytes" in srv, "6b.7 health 暴露审计日志体积")

# 三方 UI 都要能看审计：Web 管理页 + 启动器
ok('id="tab-audit"' in html and 'id="pane-audit"' in html, "6b.8 Web 管理页有审计标签页与面板")
ok("loadAudit" in html and "exportAuditCSV" in html, "6b.9 Web 管理页有加载与导出审计")
ok('id="audit-table"' in html and 'id="a-action"' in html and 'id="a-target"' in html,
   "6b.10 Web 管理页审计表格与筛选控件齐备")
for fn in ["Refresh-Audit", "Get-AuditText", "Format-Bytes", "ConvertTo-ShortJson"]:
    ok(fn in defs, "6b.11 launcher 定义 %s" % fn)
ok("Refresh-Audit" in ps and "/api/admin/audit" in ps, "6b.12 launcher 审计页调用审计接口")
ok(re.search(r"\$pgAudit\s*=", ps) is not None and "审计日志" in ps, "6b.13 launcher 有审计标签页")

# ---------- 9. 永久会员 + 收款流水对账（服务端 1.4.5 / 插件 0.24.5）----------
RC_LIB = os.path.join(ROOT, "server", "lib", "reconcile.js")
ok(os.path.exists(RC_LIB), "9.1 存在 server/lib/reconcile.js")
rc_src = io.open(RC_LIB, encoding="utf-8").read() if os.path.exists(RC_LIB) else ""
for fn in ["parseLine", "parseEntries", "matchPayments", "summarize"]:
    ok(re.search(r"function %s\b" % fn, rc_src) is not None, "9.2 reconcile.js 定义 %s()" % fn)
ok("/api/admin/reconcile" in srv, "9.3 服务端有对账路由")
ok("auditLog(req, 'order.reconcile'" in srv, "9.4 对账核销写审计")
ok("'order.reconcile'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read(),
   "9.5 audit.js 动作表含 order.reconcile")
# 动作中文名跨语言两份，必须同步（MEMORY 里记的纪律）
ok("'order.reconcile'" in ps, "9.6 launcher 的 Get-AuditText 也含 order.reconcile")

MEM_JS = os.path.join(ROOT, "server", "lib", "membership.js")
mem = io.open(MEM_JS, encoding="utf-8").read()
ok("const PERPETUAL = 'perpetual'" in mem, "9.7 membership 定义永久周期常量")
ok("function assignTail" in mem, "9.8 membership 有尾数分配")
ok("function amountCentsOf" in mem, "9.9 membership 有分位金额换算（旧订单兼容）")
ok("perpetual" in mem and "monthsLabel" in mem, "9.10 membership 永久语义（时长文案 / 授予不降级）")

# 后台 Web：永久周期 + 对账面板
for must in ['id="reconcile-mask"', 'id="rc-text"', 'id="rc-table"', 'id="rc-apply-btn"',
             'id="gm-perpetual"']:
    ok(must in html, "9.11 admin.html 含 %s" % must)
for fn in ["openReconcile", "runReconcile", "applyReconcile", "onGrantPerpetual"]:
    ok(("function %s" % fn) in html, "9.12 admin.html 定义 %s()" % fn)
ok("'perpetual'" in html, "9.13 admin.html 价格表单识别永久周期")

# 启动器：对账入口 + 永久周期
ok("Show-ReconcileDialog" in defs, "9.14 launcher 定义 Show-ReconcileDialog")
ok("Get-ReconcileStatusText" in defs, "9.15 launcher 定义 Get-ReconcileStatusText")
ok("对账导入" in ps and "/api/admin/reconcile" in ps, "9.16 launcher 订单页有对账入口并调用接口")
ok("'perpetual'" in ps, "9.17 launcher 价格表单识别永久周期")

# 插件：下单传周期 + 尾数提示 + 永久显示（本节位置在 7/8 之前，直接读文件避免依赖顺序）
_acct_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js"),
                    encoding="utf-8").read()
_pa_src = io.open(os.path.join(ROOT, "chrome", "content", "prefs-account.js"), encoding="utf-8").read()
ok("async createOrder(plan, months, cycle, couponCode)" in _acct_src,
   "9.18 插件 createOrder 支持周期参数与券码")
ok("perpetual" in _acct_src, "9.19 插件 account.js 读取 perpetual")
ok("tailCents" in _pa_src, "9.20 插件支付面板提示专属尾数")
ok("永久" in _pa_src, "9.21 插件显示「永久」相关文案")

# ---------- 7. 插件设置面板：引用的元素 id 是否真的存在于 prefs.xhtml ----------
# 这类失误的表现就是「点了没反应」——JS 里 $("pp-xxx") 拿到 null，静默什么都不做。
PREFS_JS = os.path.join(ROOT, "chrome", "content", "prefs-account.js")
PREFS_XHTML = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")
prefs_js = io.open(PREFS_JS, encoding="utf-8").read()
prefs_xhtml = io.open(PREFS_XHTML, encoding="utf-8").read()
xhtml_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', prefs_xhtml))
# 由 JS 动态创建（el() 里带 id）的元素不算缺失
dyn_ids = set(re.findall(r'el\(\s*"[a-z]+"\s*,\s*\{[^}]*id:\s*"([A-Za-z0-9_-]+)"', prefs_js))
used_ids = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', prefs_js))
used_ids |= set(re.findall(r'bind\("([A-Za-z0-9_-]+)"', prefs_js))
used_ids |= set(re.findall(r'mbSetMsg\("([A-Za-z0-9_-]+)"', prefs_js))
missing_ids = sorted(i for i in used_ids if i not in xhtml_ids and i not in dyn_ids)
ok(not missing_ids, "7.1 prefs-account.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (missing_ids or "无"))

for must in ["pp-mb-renew", "pp-mb-usage", "pp-mb-options", "pp-mb-order"]:
    ok(must in xhtml_ids, "7.2 prefs.xhtml 含会员元素 #%s" % must)

# ---------- 8. 0.24.4：价格表 / 到期提醒 / 用量趋势 跨模块接线 ----------
ACCOUNT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js")
MAIN_JS = os.path.join(ROOT, "chrome", "content", "scripts", "main.js")
PREFS_DEFAULTS = os.path.join(ROOT, "prefs.js")
acct = io.open(ACCOUNT_JS, encoding="utf-8").read()
mainjs = io.open(MAIN_JS, encoding="utf-8").read()
prefsdef = io.open(PREFS_DEFAULTS, encoding="utf-8").read()

for fn in ["renewalReminder()", "lastPurchasedMonths()", "usage()"]:
    ok(fn in acct, "8.1 account.js 定义 %s" % fn)
for k in ["priceItems", "upcoming"]:
    ok(k in acct, "8.2 account.js plans() 下发 %s" % k)
    ok(k in prefs_js, "8.3 prefs-account.js 使用 %s" % k)
ok("renewalReminder" in prefs_js and "lastPurchasedMonths" in prefs_js,
   "8.4 prefs-account.js 使用到期提醒与上次周期")
ok("_checkRenewal" in mainjs and "renewPromptShownFor" in mainjs,
   "8.5 main.js 启动时检查到期提醒")
ok("renewPromptShownFor" in prefsdef, "8.6 prefs.js 有 renewPromptShownFor 默认值")
ok("usageDays" in srv and "usageDaily" in srv, "8.7 服务端实现按日用量与后台下发")
ok("exportUsageCSV" in html, "8.8 Web 管理页有用量 CSV 导出")

# ---------- 9. 1.4.6：优惠券 / 折扣码 ----------
COUPON_LIB = os.path.join(ROOT, "server", "lib", "coupon.js")
ok(os.path.exists(COUPON_LIB), "9.1 存在 server/lib/coupon.js")
coupon_src = io.open(COUPON_LIB, encoding="utf-8").read()
for fn in ["sanitizeCoupon", "stateOf", "computeDiscount", "quote",
           "reserveUse", "consumeUseByOrder", "releaseUseByOrder",
           "couponOut", "couponPublicOut", "createCoupons", "updateCoupon", "removeCoupon"]:
    # 有的是 function 声明、有的是 const 箭头函数 —— 两种形态都要认，否则满屏假失败
    _defined = (re.search(r"function %s\b" % fn, coupon_src) is not None
                or re.search(r"const %s\s*=" % fn, coupon_src) is not None)
    ok(_defined, "9.2 coupon.js 定义 %s()" % fn)
ok("require('./lib/coupon')" in srv, "9.3 服务端引入 coupon 模块")
for must in ["/api/admin/coupons", "/api/coupons/validate", "couponCode"]:
    ok(must in srv, "9.4 服务端含优惠券接线 %s" % must)
ok("quoteOrder" in srv, "9.5 服务端有试算 helper（与下单共用同一取价口径）")
ok("coupons" in srv and "couponsActive" in srv, "9.6 health 暴露优惠券观测字段")
# 订单生命周期必须联动券占用（否则限额会被乱点耗光 / 释放不掉）
for must in ["coupon.releaseUseByOrder", "coupon.consumeUseByOrder", "coupon.reserveUse"]:
    ok(must in srv or must in io.open(os.path.join(ROOT, "server", "lib", "membership.js"),
                                      encoding="utf-8").read(),
       "9.7 订单生命周期联动券占用：%s" % must)
ok("coupon.create" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"),
                              encoding="utf-8").read(), "9.8 审计动作表含 coupon.*")
# 三处 UI
ok("tab-coupon" in html and "pane-coupon" in html and "openCouponForm" in html,
   "9.9 Web 管理页有优惠券标签页与弹窗")
ok("'优惠券'" in ps and "Show-CouponForm" in ps and "Refresh-Coupons" in ps,
   "9.10 启动器有优惠券标签页与对话框")
# 插件端：试算 + 下单带券 + 面板元素存在
ok("validateCoupon" in acct and "couponCode" in acct, "9.11 插件 account.js 支持试算与带券下单")
ok("createOrder(mbSel.plan, mbSel.months, mbSel.cycle," in prefs_js, "9.12 插件下单时传券码")
for eid in ["pp-mb-coupon", "pp-mb-coupon-btn", "pp-mb-quote"]:
    ok(('id="%s"' % eid) in io.open(os.path.join(ROOT, "chrome", "content", "prefs.xhtml"),
                                    encoding="utf-8").read(),
       "9.13 prefs.xhtml 存在优惠码元素 %s" % eid)
    ok(('"%s"' % eid) in prefs_js, "9.14 prefs-account.js 引用 %s" % eid)
ok("pp-mb-quote" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                            encoding="utf-8").read(), "9.15 prefs.css 有折后价样式")
# 折后金额的下限保护（不允许 100% 减免 → 免费请用激活码）
ok("MIN_PAYABLE_CENTS" in coupon_src and "MAX_PERCENT = 99" in coupon_src,
   "9.16 优惠券守住「折后至少 ¥1、最多 99%」的下限")
# ★ 尾数必须在**折后**金额上分配，否则「按金额唯一对账」在打折后会失效
mem_src = io.open(os.path.join(ROOT, "server", "lib", "membership.js"), encoding="utf-8").read()
ok("const baseCents = originalCents - discountCents;" in mem_src
   and "assignTail(doc, baseCents" in mem_src,
   "9.17 尾数在折后金额上分配（保住按金额唯一对账）")

# ---------- 10. 1.4.7：登录设备与会话管理 ----------
SESS_LIB = os.path.join(ROOT, "server", "lib", "sessions.js")
ok(os.path.exists(SESS_LIB), "10.1 存在 server/lib/sessions.js")
sess_src = io.open(SESS_LIB, encoding="utf-8").read()
for fn in ["sidOf", "maskIp", "deviceFromHeaders", "recordStart", "recordSeen",
           "sessionsOf", "sessionOut", "deviceAlertOf", "shouldAlert", "record",
           "revokeSid", "revokeOthers", "sidOfRec"]:
    _defined = (re.search(r"function %s\b" % fn, sess_src) is not None
                or re.search(r"const %s\s*=" % fn, sess_src) is not None)
    ok(_defined, "10.2 sessions.js 定义 %s()" % fn)
ok("require('./lib/sessions')" in srv, "10.3 服务端引入 sessions 模块")
for must in ["/api/sessions", "revoke-others", "/sessions/"]:
    ok(must in srv, "10.4 服务端含会话路由 %s" % must)
ok("sessionsActive" in srv and "devicesOverLimit" in srv, "10.5 health 暴露设备观测字段")
ok("sessionOut" in srv and "full: true" in srv,
   "10.6 管理侧用 full 视图（完整 IP），用户侧默认打码")
# ★ 展示与撤销必须同源，否则会出现"看得见却踢不掉"的设备
ok("sidOfRec" in sess_src and sess_src.count("sidOfRec(") >= 3,
   "10.7 展示与撤销共用同一个 sid 取值来源（sidOfRec）")
# ★ 只处理有效令牌，保证「已踢出 N 台」与用户数出来的台数一致
ok("if (!(Number(rec.expiresAt) > t)) continue;" in sess_src,
   "10.8 踢出只针对仍然有效的令牌（口径与设备列表一致）")
ok("deviceAlertOf" in srv and "sessions.record(" in srv and "sessions.logLine" in srv,
   "10.9 设备超阈值接入既有告警链（alerts.log + 邮件 + alerts.json）")
ok("alertStore.data.sessions" in srv,
   "10.10 设备告警状态用 sessions 命名空间，不覆盖既有积压状态")
_audit_src = io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read()
for act in ["session.revoke'", "session.revoke-others", "session.revoke-admin"]:
    ok(act in _audit_src, "10.11 审计动作表含 %s" % act)
    ok(act in ps, "10.12 launcher 审计中文表含 %s" % act)
# 两套 UI
ok("sessions-mask" in html and "openSessions" in html and "kickSession" in html,
   "10.13 Web 管理页有设备弹窗与踢出逻辑")
ok("活跃设备" in html, "10.14 Web 管理页用户表有活跃设备列")
ok("Show-SessionsDialog" in ps and "Refresh-Sessions" in ps, "10.15 启动器有设备子窗体")
for eid in ["sessions-mask", "ss-table", "ss-stat"]:
    ok(('id="%s"' % eid) in html, "10.16 Web 管理页存在设备元素 %s" % eid)
ok("openSessions" in html, "10.17 用户行有设备入口按钮")

# ---------- 11. 0.24.7：插件上报设备标识 + 登录设备面板 ----------
for fn in ["installId()", "_deviceHeaders()", "sessions()", "renameSession(", "revokeSession(", "revokeOtherSessions("]:
    ok(fn in acct, "11.1 account.js 定义 %s" % fn)
ok('X-PP-Device' in acct and 'X-PP-Platform' in acct, "11.2 account.js 上报设备头")
ok("const headers = this._deviceHeaders();" in acct,
   "11.3 _request 统一注入设备头（不是每处手写，避免漏传）")
ok("installId" in prefsdef, "11.4 prefs.js 有 installId 默认值")
ok("PUT" in srv and "session.label" in srv, "11.5 服务端支持给设备命名（PUT /api/sessions/:sid）")
ok("setLabel" in sess_src, "11.6 sessions.js 定义 setLabel()")
for eid in ["pp-dev-block", "pp-dev-list", "pp-dev-stat", "pp-dev-refresh",
            "pp-dev-kick-others", "pp-dev-msg"]:
    ok(('id="%s"' % eid) in prefs_xhtml, "11.7 prefs.xhtml 存在设备元素 %s" % eid)
ok("renderDevices" in prefs_js, "11.8 prefs-account.js 渲染设备列表")
ok("onKickOtherDevices" in prefs_js and "onKickDevice" in prefs_js, "11.9 有踢出（单台/全部）逻辑")
# ★ 反馈必须在刷新之后写，否则「已踢出」会被刷新清空（改前踩过）
ok("await renderDevices(\"✓ 已踢出该设备\")" in prefs_js,
   "11.10 操作反馈交给刷新函数最后写（不会被刷新冲掉）")
# ★ 面板作用域没有 Services，必须走安全包装；直接 window.prompt 在 Zotero 里不可靠
ok("Services_promptInput(" in prefs_js and "Services_promptConfirm(" in prefs_js,
   "11.11 提示框走 Services 安全包装（不用裸 window.prompt）")
ok("pp-dev-row" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                           encoding="utf-8").read(), "11.12 prefs.css 有设备行样式")
# 设备标识不是凭据：不能出现在会话文件/审计的敏感位置（这里核对它只存 pref）
ok('Prefs.set("installId"' in acct, "11.13 installId 只持久化到 pref（非凭据，与「令牌不进 pref」不冲突）")

# ---------- 12. 套餐 AI 能力（1.4.9：高级模型白名单 + 新用户全模型试用） ----------
MEM_LIB = os.path.join(ROOT, "server", "lib", "membership.js")
mem_src = io.open(MEM_LIB, encoding="utf-8").read()

# --- membership.py：试用纯函数 + 全局 ai 配置 ---
for fn in ["trialState", "trialDaysFor"]:
    ok(re.search(r"function %s\b" % fn, mem_src) is not None, "12.1 membership.js 定义 %s()" % fn)
ok("trialState," in mem_src and "trialDaysFor," in mem_src, "12.2 membership.js 导出试用函数")
ok("DEFAULT_AI" in mem_src and "trialDays: 7" in mem_src, "12.3 试用天数有默认值（7 天）")
ok("out.ai = { trialDays: clampInt(" in mem_src,
   "12.4 normalize 归一化 ai.trialDays（越界夹取、非法回落默认）")

# --- 服务端：解析函数 ---
for fn in ["highTierModels", "trialOf", "highTierAccess", "modelsForUser", "gatewayModelsAll"]:
    ok(re.search(r"function %s\b" % fn, srv) is not None, "12.5 服务端定义 %s()" % fn)

# auto 恒定免费：这是防「误配把全体用户锁死」的关键守卫
ok("m !== 'auto' && hi.includes(m)" in srv, "12.6 auto 恒免费（不进 locked，不被拦）")
ok("acc.allowed ? all : free" in srv or "acc.allowed ? all.slice() : all.filter((m) => !isHi(m))" in srv,
   "12.7 可用模型按套餐过滤")

# --- 服务端：网关强制 ---
ok("MODEL_REQUIRES_PRO" in srv, "12.8 越权调用返回可编程识别的 code")
# 明确拒绝而非静默换模型（金额/模型类纪律：静默修正比报错危险）
ok(re.search(r"return json\(res, 403, \{ ok: false, code: 'MODEL_REQUIRES_PRO'", srv) is not None,
   "12.9 高级模型越权 → 403 明确拒绝（不静默降级到便宜模型）")
ok("const av = modelsForUser(user);\n        return json(res, 200, { object: 'list'," in srv,
   "12.10 /v1/models 按套餐返回（不再是全局清单）")

# /v1/models 不得再直接吐全量清单
ok("gatewayModelsAll().map" not in srv, "12.11 /v1/models 不再直接返回全量模型")

# --- 服务端：对外契约与后台 ---
ok("out.ai = {" in srv and "lockedModels: av.locked" in srv and "defaultModel: 'auto'" in srv,
   "12.12 /api/auth/me 带 ai 块（含 lockedModels 供面板灰显）")
ok("highTierModels: highTierModels().length" in srv, "12.13 health 暴露高级模型数量")
ok("url === '/api/admin/channels/high-tier' && method === 'PUT'" in srv,
   "12.14 管理端点 PUT /api/admin/channels/high-tier 存在")
ok("highTierModels: highTierModels(),   // 1.4.9" in srv, "12.15 管理端 GET channels 回传高级清单")
ok("ai: { trialDays: membership.trialDaysFor(membershipStore.data) }" in srv,
   "12.16 管理端 GET membership 回传 ai.trialDays（否则后台没法回显）")
ok("if (p.highTierModels !== undefined) doc.plans[pid].highTierModels" in srv,
   "12.17 套餐更新白名单含 highTierModels（此前该字段无处可改）")
ok("input.ai.trialDays !== undefined" in srv, "12.18 套餐更新白名单含 ai.trialDays")
ok("outsidePublished" in srv, "12.19 高级清单越出上线范围时给出提示（不阻断）")

# --- 审计动作（两处都要有） ---
AUDIT_LIB = os.path.join(ROOT, "server", "lib", "audit.js")
audit_src = io.open(AUDIT_LIB, encoding="utf-8").read()
ok("'channel.high-tier'" in audit_src, "12.20 audit.js 动作表含 channel.high-tier")
ok("'channel.high-tier'" in ps, "12.21 launcher 的 Get-AuditText 也含 channel.high-tier")

# --- Web 管理页 ---
for k in ["ht-chips", "saveHighTier", "clearHighTier", "p-trial-days", "p-free-hi", "p-pro-hi", "ch-ht"]:
    ok(k in html, "12.22 admin.html 含 %s" % k)
ok("'/api/admin/channels/high-tier'" in html, "12.23 Web 页调用高级清单接口")
ok("body.ai = { trialDays:" in html, "12.24 Web 页保存试用天数")
ok("highTierModels: !!$('p-free-hi').checked" in html, "12.25 Web 页保存免费版高级模型开关")

# --- 启动器 ---
ok("txtHigh" in ps and "btnSaveHigh" in ps, "12.26 启动器通道窗体有高级模型输入与保存")
ok("'/api/admin/channels/high-tier'" in ps, "12.27 启动器调用高级清单接口")
ok("highTierModels = [bool]$chkFreeHi.Checked" in ps, "12.28 启动器套餐页保存高级模型开关")
ok("ai = @{ trialDays = $script:planTrialDays }" in ps, "12.29 启动器套餐页保存试用天数")
ok("$script:mbAiTrialDays = [int]$r.plans.ai.trialDays" in ps, "12.30 启动器回显当前试用天数")

# ---------- 13. 插件端套餐 AI 能力（0.24.8） ----------
ok(re.search(r"^  ai\(\) \{", acct, re.M) is not None, "13.1 account.js 定义 ai() 访问器")
# 旧服务端没有 ai 块时必须回落「不限制」——客户端绝不能在没有依据时锁用户
ok('reason: "unknown"' in acct, "13.2 旧服务端无 ai 块 → reason=unknown（不限制）")
ok('return { highTier: true, reason: "unknown"' in acct, "13.3 未知时按「不限制」返回")

ok(re.search(r"function aiTier\(\)", prefs_js) is not None, "13.4 面板有 aiTier() 形状归一化")
ok("typeof raw !== \"object\"" in prefs_js, "13.5 非对象返回（含 Promise）→ 安全降级")
ok("Array.isArray(raw.lockedModels)" in prefs_js, "13.6 锁定列表强制成数组（否则 for…of 会抛）")
ok(re.search(r"function renderAiTierNote\(note\)", prefs_js) is not None, "13.7 面板有分层说明条渲染")
ok('"🔒 " + m' in prefs_js, "13.8 需升级的模型以 🔒 灰显列出（让用户看见差距）")
ok("全模型试用中，剩 " in prefs_js, "13.9 试用中显示剩余天数")
ok("已回落到 " in prefs_js and "C.upsert({ id: C.OFFICIAL_ID, model: AI.defaultModel })" in prefs_js,
   "13.10 当前模型已锁 → 回落到默认并**写明原因**（不静默改配置）")
ok("if (!known) { sel.value = list[0]; return \"\"; }" in prefs_js,
   "13.11 无从判断可用性时不动用户配置（旧服务端兼容）")
ok("AI.lockedModels.indexOf(v) >= 0" in prefs_js, "13.12 选中锁定模型时拦下（服务端也会 403，双保险）")
# 反馈必须写在刷新之后（本项目踩过的坑：渲染函数会重置消息区）
ok(re.search(r"Promise\.resolve\(fillOfficialModelSelect\(\)\)\.then\(\(\) => \{\s*\n\s*renderAiTierNote\(",
             prefs_js) is not None,
   "13.13 锁定反馈写在刷新之后（不会被刷新冲掉）")
ok("pp-ai-tier-note" in prefs_xhtml, "13.14 prefs.xhtml 有分层说明条容器")
ok("pp-ai-tier" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                           encoding="utf-8").read(), "13.15 prefs.css 有分层说明条样式")

# ---------- 14. 测试基建：端口由系统分配（避免与本机常驻服务撞端口） ----------
# 起因：sessions.test.js 用 18500..18799 随机端口，而本机常驻的 Prism 网关占 18790/18791，
# 抽中即 EADDRINUSE —— preflight 偶发失败，看着像被测代码坏了，实际是测试基建踩了别人的端口。
TEST_DIR = os.path.join(ROOT, "test")
_n = 0
for _fn in sorted(os.listdir(TEST_DIR)):
    if not _fn.endswith(".test.js"):
        continue
    _src = io.open(os.path.join(TEST_DIR, _fn), encoding="utf-8").read()
    if "server.listen(" not in _src:
        continue
    _n += 1
    ok("server.listen(0, '127.0.0.1'" in _src,
       "14.%d %s 端口由系统分配（listen(0)）" % (_n * 3 - 2, _fn))
    ok("PORT = server.address().port;" in _src,
       "14.%d %s 回读实际端口" % (_n * 3 - 1, _fn))
    # ★ 请求助手必须关掉 keep-alive：
    #   Node 19+ 客户端默认 keep-alive，而 Node 服务端 keepAliveTimeout 默认 5s——
    #   复用一条「正被服务端关闭」的空闲 socket 会拿到 ECONNRESET。
    #   表现是**偶发**的「异常中断」，让门禁假红（server-ops 实测 4/6 失败，HEAD 同样复现）。
    #   agent:false = 每个请求新连接，彻底避开该竞态。这是测试基建，不改产品行为。
    ok("agent: false" in _src,
       "14.%d %s 请求助手关闭 keep-alive（防 ECONNRESET 假红）" % (_n * 3, _fn))

# ---------- 15. 主题切换按钮：界面主题 / PDF 阅读主题 两个按钮分开（0.25.1） ----------
# 起因：这两块各有一批典型静默失败——
#   ① 用了自造 DOM 注入而不是官方 renderToolbar 扩展位（原生 React 重渲染会把节点冲掉）；
#   ② append 被异步调用（CustomSections 的 append 在事件同步返回后即失效，会抛
#      "Append must be called directly and synchronously"）；
#   ③ 阅读器那套变量名写成了主窗口的 --fill-quaternary（reader.css 用的是
#      --fill-quarternary，少一个 r）→ hover 底色全失效且不报错；
#   ④ 「按钮分开」的要求很容易被下一个改动悄悄并回去（一个弹层里又塞两套主题），
#      所以把「谁只列谁」也做成断言。
THEME_TOGGLE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "theme-toggle.js")
UI_THEME_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "ui-theme.js")
PDF_THEME_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-theme.js")
toggle_js = io.open(THEME_TOGGLE_JS, encoding="utf-8").read()
uitheme_js = io.open(UI_THEME_JS, encoding="utf-8").read()
pdftheme_js = io.open(PDF_THEME_JS, encoding="utf-8").read()
mainjs = io.open(MAIN_JS, encoding="utf-8").read()
prefsdef = io.open(PREFS_DEFAULTS, encoding="utf-8").read()
utils_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "core", "utils.js"),
                   encoding="utf-8").read()

ok('"features/theme-toggle.js"' in mainjs, "15.1 main.js 装配清单含 theme-toggle.js")
ok("this.themeToggle = ThemeToggle;" in mainjs, "15.2 main.js 把 ThemeToggle 挂到 Zotero.PaperPilot")
ok("ThemeToggle.register(id);" in mainjs, "15.3 main.js 启动时注册主题按钮")
ok("ThemeToggle.unregister();" in mainjs, "15.4 main.js 关闭时注销主题按钮（按钮/弹层/样式全摘）")
ok("ThemeToggle.refresh()" in mainjs, "15.5 主题 pref 变化时同步两处按钮提示")
ok('"themeButtonEnabled"' in mainjs, "15.6 themeButtonEnabled 进 pref 观察清单")
ok("themeButtonEnabled" in prefsdef, "15.7 prefs.js 有 themeButtonEnabled 默认值")
# 阅读器：必须走官方扩展位（官方事件 + 同步 append）
ok('registerEventListener("renderToolbar"' in toggle_js, "15.8 阅读器按钮走官方 renderToolbar 事件")
ok('unregisterEventListener("renderToolbar"' in toggle_js, "15.9 注销同一个 handler 引用（否则泄漏）")
ok(re.search(r"const btn = this\._readerButton\(doc\);\s*\n\s*append\(btn\);", toggle_js) is not None,
   "15.10 append 在事件回调里同步调用（异步会抛且按钮不出现）")
_render_fn = toggle_js.split("_onRenderToolbar(event)")[1].split("_readerButton(doc)")[0]
ok("getElementById" not in _render_fn,
   "15.11 工具栏重渲染必须重建按钮（不能「已存在就跳过」）")
# 规范对齐：class 用宿主原生按钮类，不发明样式
ok('setAttribute("class", "toolbar-button pp-theme-pdf-toggle")' in toggle_js,
   "15.12 阅读器按钮用原生 .toolbar-button（hover/active/disabled 全免费）")
ok('btn.style.listStyleImage = \'url("chrome://paperpilot/content/icons/theme.svg")\'' in toggle_js,
   "15.13 主窗口按钮用 context-fill 单色图标")
ok('btn.setAttribute("class", "zotero-tb-button")' in toggle_js,
   "15.14 主窗口按钮用原生 .zotero-tb-button（28×28 与相邻控件一致）")
ok('"zotero-collections-toolbar"' in toggle_js, "15.15 主窗口按钮落在左上角收藏夹工具栏")
ok('"zotero-tb-collection-add"' in toggle_js, "15.16 锚定「新建分类」之后（左上角第一排）")
ok('setAttribute("type", "menu")' not in toggle_js,
   "15.17 不用 type=menu（宽度会变 40px，与相邻 28px 不齐）")
ok("max-width:min(92vw,280px)" in toggle_js and "max-height:min(70vh,440px)" in toggle_js,
   "15.18 阅读器弹层限宽限高（窄屏不溢出）")
ok('btn.style.flex = "none";' in toggle_js, "15.19 阅读器按钮不参与收缩（窄屏不被挤扁）")
# 变量拼写：reader 侧必须用原生 --fill-quarternary
ok("--fill-quarternary: " in uitheme_js, "15.20 ui-theme 阅读器变量用原生拼写 --fill-quarternary")
ok(re.search(r"_readerCSS\(theme\)", uitheme_js) is not None, "15.21 ui-theme 有阅读器变量组 _readerCSS")
ok("applyToReaderDoc(doc)" in uitheme_js, "15.22 阅读器文档可单独注入（新开 reader 也能吃到主题）")
ok("this.refreshReaders();" in uitheme_js, "15.23 apply() 同步刷新已打开的阅读器界面")
# ---- 15.24~15.32：两块主题必须分开、各管各的 pref ----
# 取块时锚点**必须带方法签名里的 ` {`**：函数名在文件里会先作为调用点出现一次
# （`_mainButton` 里的 addEventListener、`_toggleReaderPopup` 里的自调用），
# 只按名字切会切到调用点、拿到空块 → 断言静默变成"永远不命中"。
_reader_render = toggle_js.split("_renderReaderPopup(doc, pop) {")[1].split("_placePopup(doc, pop, btn)")[0]
_main_menu = toggle_js.split("_fillMainMenu(doc, popup) {")[1].split("/* ==================== 状态同步")[0]
ok("_pdfItems()" in _reader_render, "15.24 阅读器弹层列 PDF 阅读主题")
ok("_uiGroups()" not in _reader_render,
   "15.25 阅读器弹层**不**列界面主题（按钮已分开，不能又并回去）")
ok("_applyUi(" not in _reader_render, "15.26 阅读器弹层不会写 uiTheme")
ok("_uiGroups()" in _main_menu, "15.27 主窗口弹层列界面主题")
ok("_pdfItems()" not in _main_menu,
   "15.28 主窗口弹层**不**列 PDF 阅读主题（同上）")
ok("_applyPdf(" not in _main_menu, "15.29 主窗口弹层不会写 pdfTheme")
ok("_uiTip()" in toggle_js and "_pdfTip()" in toggle_js,
   "15.30 两处按钮提示各自只说自己那套主题")
ok('themeUiButtonTip' in utils_js and 'themePdfButtonTip' in utils_js,
   "15.31 文案表有两条按钮提示键（旧 themeButtonTip 已退役）")
ok("themeButtonTip" not in toggle_js and "themeButtonTip:" not in utils_js,
   "15.32 旧的合并文案键已清干净")
# 旧的自造工具栏注入必须已经拆掉，否则会出现两个按钮
ok("_addToolbarButton" not in pdftheme_js, "15.33 pdf-theme 已移除旧的自造工具栏按钮（避免双按钮）")
ok("paperpilot-pdf-theme-toggle" not in pdftheme_js, "15.34 pdf-theme 不再持有旧按钮 id")
# ---- 15.35~15.36：「自定义主题」必须是跳板，不能直接套用空色板 ----
# 起因：uiThemeCustom 为空时 setTheme("custom") 会渲染出「全白 + 无壁纸」的主题，
# 用户点完的观感就是「没反应 / 背景反而没了」（0.25.1 用户实测）。
ok("_customReady()" in toggle_js and "uiThemeCustom" in toggle_js,
   "15.35 菜单判断自定义色板是否已配置")
ok("if (jump) this._openThemeSettings();" in toggle_js,
   "15.36 未配置色板时「自定义主题」改为打开设置面板（不套用空主题）")

# ---------- 16. arXiv 核心（0.25.0）：生成物 × 装配 × Discovery 迁移 ----------
# 起因：插件侧的 arXiv 查询构建/Atom 解析/去重由 scripts/build-arxiv-core.py 从
# tools/arxiv/src 生成（单一真源在 tools 侧）。这类「代码生成代码」有四种典型静默失败：
#   ① 改了 tools 侧却忘记重新生成 → CLI 里对、插件里错，两边测试都绿；
#   ② 生成物残留 require/module.exports → 插件作用域加载即抛，只写一行 boot 日志；
#   ③ 装配顺序错（被依赖者排后面）→ 加载期 ReferenceError，同样是静默降级；
#   ④ Discovery 迁移后语义回退（多分类从 OR 变 AND）→ 推荐结果集直接变样，没人会报错。
ARXIV_CORE_DIR = os.path.join(ROOT, "chrome", "content", "scripts", "arxiv")
ARXIV_GEN = ["arxiv-errors", "arxiv-dates", "arxiv-query", "arxiv-categories",
             "arxiv-atom", "arxiv-analyze", "arxiv-rate-limiter"]
ARXIV_FETCH_JS = os.path.join(ARXIV_CORE_DIR, "arxiv-fetch.js")
DISCOVERY_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "discovery.js")
GEN_SCRIPT = os.path.join(ROOT, "scripts", "build-arxiv-core.py")

for _i, _name in enumerate(ARXIV_GEN, 1):
    _p = os.path.join(ARXIV_CORE_DIR, _name + ".js")
    _exists = os.path.exists(_p)
    ok(_exists, "16.%d 生成物存在: %s.js" % (_i, _name))
    if _exists:
        _src = io.open(_p, encoding="utf-8").read()
        ok("AUTOGENERATED" in _src[:400], "16.%d 生成物带 AUTOGENERATED 标记: %s" % (_i, _name))
        ok(("require(" not in _src) and ("module.exports" not in _src) and ("process." not in _src),
           "16.%d 生成物无 Node 专有标识: %s" % (_i, _name))

ok(os.path.exists(ARXIV_FETCH_JS), "16.90 arxiv-fetch.js 存在（手写适配层）")
fetch_js = io.open(ARXIV_FETCH_JS, encoding="utf-8").read() if os.path.exists(ARXIV_FETCH_JS) else ""
disc_js = io.open(DISCOVERY_JS, encoding="utf-8").read() if os.path.exists(DISCOVERY_JS) else ""

# 装配：清单齐全 + 依赖序（核心必须排在 discovery.js 之前）
_main_js = io.open(MAIN_JS, encoding="utf-8").read()
for _name in ARXIV_GEN + ["arxiv-fetch"]:
    ok(('"arxiv/%s.js"' % _name) in _main_js, "16.91 main.js 装配清单含 arxiv/%s.js" % _name)
ok(_main_js.index('"arxiv/arxiv-errors.js"') < _main_js.index('"features/discovery.js"'),
   "16.92 核心排在 discovery.js 之前（否则加载期 ReferenceError）")
ok(_main_js.index('"arxiv/arxiv-fetch.js"') < _main_js.index('"features/discovery.js"'),
   "16.93 arxiv-fetch 排在 discovery.js 之前")
ok(_main_js.index('"arxiv/arxiv-errors.js"') < _main_js.index('"arxiv/arxiv-query.js"') < _main_js.index('"arxiv/arxiv-atom.js"'),
   "16.94 核心内部按依赖序（errors → query → atom）")
ok("this.arxiv = ArxivFetch;" in _main_js, "16.95 main.js 把 ArxivFetch 挂到 Zotero.PaperPilot")
ok("ArxivFetch.selfTest()" in _main_js, "16.96 启动时跑 arXiv 核心离线自检（结论写进 boot 日志）")

# Discovery 迁移：自带解析/查询/拉取必须已经拆掉，且改用新的核心
for _bad, _desc in [("parseAtom", "自写 Atom 解析"), ("buildQuery", "自写查询构建"),
                    ("fetchFeed", "自写拉取"), ("ARXIV_API", "硬编码 API 地址")]:
    ok(_bad not in disc_js, "16.97 discovery.js 已移除%s" % _desc)
ok("ArxivFetch.search(" in disc_js, "16.98 discovery.js 改用 ArxivFetch.search（分页+重试+限速）")
ok("ArxivCategories.checkAll(" in disc_js, "16.99 discovery.js 用内置分类目录做拼写核对")
# ★ 语义守护：多分类必须 OR（并集）。旧实现手写 +OR+，改成 AND 会静默缩小结果集
ok('categoryMode: "OR"' in disc_js, "16.100 discovery.js 多分类用 OR 并集（防止语义回退成 AND）")

# 适配层：必须自行判状态 + 必须经过限速器
ok("_classify(" in fetch_js, "16.101 arxiv-fetch 自行判定 HTTP 状态（Zotero.HTTP 对 4xx 不抛异常）")
ok("limiter().run(" in fetch_js, "16.102 arxiv-fetch 的请求经 RateLimiter（3 秒 1 次的 arXiv 礼节）")
ok(fetch_js.count("Zotero.HTTP.request(") == 1,
   "16.103 arxiv-fetch 只有一个 HTTP 出口（便于统计与限速）")
ok("ArxivAtom.extractApiError(" in fetch_js, "16.104 400 错误体里的 arXiv 原话被带出（不当成 0 结果）")
ok("extractApiError" in io.open(os.path.join(ROOT, "tools", "arxiv", "src", "atom.js"), encoding="utf-8").read(),
   "16.105 extractApiError 的单一真源在 tools/arxiv/src/atom.js")

# 门禁：生成器 + preflight 步骤 + 冒烟覆盖
ok(os.path.exists(GEN_SCRIPT), "16.106 生成器 scripts/build-arxiv-core.py 存在")
ok("--check" in io.open(GEN_SCRIPT, encoding="utf-8").read(), "16.107 生成器支持 --check（漂移检测）")
_pf = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("build-arxiv-core.py" in _pf, "16.108 preflight 含「arXiv 核心生成物同步」步骤")
ok("arxiv-core.test.js" in _pf, "16.109 preflight 含插件侧 arXiv 核心测试")
_smoke = io.open(os.path.join(ROOT, "test", "smoke-load.test.js"), encoding="utf-8").read()
ok("arxiv)" in _smoke or "|arxiv)" in _smoke, "16.110 全模块冒烟的文件正则含 arxiv/（新模块才会被覆盖）")
ok("ArxivAtom.parseAtom" in _smoke, "16.111 冒烟改用 ArxivAtom.parseAtom（Discovery 不再自带解析）")

# ---------- 17. 全文对照翻译 · 双栏对照窗口（0.25.2） ----------
# 起因：这个窗口几乎踩满了「点了没反应」的高发区——
#   ① 窗口脚本里的 $("pp-xxx") 拿到 null（xhtml 里没这个 id）→ 静默什么都不做；
#   ② 把「段落成对 + 单一滚动容器」改成两个各自滚动的容器 → 左右对齐随内容高度漂走，
#      而且不报错（表现为「同步失效」，最难被人发现）；
#   ③ 窗口脚本直接调 AIClient/AIChat → 窗口作用域里根本没这两个全局，翻译永远不动；
#   ④ 单实例复用通道写歪（getEnumerator 名 vs xhtml windowtype）→ 每次点都开新窗；
#   ⑤ 新 pref 键没在 prefs.js 给默认值 → Prefs.get 拿到 undefined。
# 所以把「骨架 + 接线 + 语义」在这里静态钉死。
BL_XHTML = os.path.join(ROOT, "chrome", "content", "bilingual.xhtml")
BL_VIEW_JS = os.path.join(ROOT, "chrome", "content", "bilingual-view.js")
BL_MOD_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "bilingual-translate.js")
PPREFS_XHTML = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")

ok(os.path.exists(BL_XHTML), "17.1 双栏对照窗口 bilingual.xhtml 存在")
ok(os.path.exists(BL_VIEW_JS), "17.2 窗口脚本 bilingual-view.js 存在")
bl_xhtml = io.open(BL_XHTML, encoding="utf-8").read() if os.path.exists(BL_XHTML) else ""
bl_js = io.open(BL_VIEW_JS, encoding="utf-8").read() if os.path.exists(BL_VIEW_JS) else ""
bl_mod = io.open(BL_MOD_JS, encoding="utf-8").read()
menus_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "menus.js"), encoding="utf-8").read()
wb_js = io.open(os.path.join(ROOT, "chrome", "content", "workbench.js"), encoding="utf-8").read()
hub_js = io.open(os.path.join(ROOT, "chrome", "content", "hub.js"), encoding="utf-8").read()
pprefs_xhtml = io.open(PPREFS_XHTML, encoding="utf-8").read()

ok('windowtype="paperpilot:bilingual"' in bl_xhtml, "17.3 窗口 windowtype=paperpilot:bilingual")
ok("chrome://paperpilot/content/bilingual-view.js" in bl_xhtml, "17.4 窗口挂了窗口脚本")
ok('WINDOW_TYPE: "paperpilot:bilingual"' in bl_mod, "17.5 模块 WINDOW_TYPE 与 windowtype 一致")
ok("getEnumerator(this.WINDOW_TYPE)" in bl_mod, "17.6 单实例复用按同一常量枚举（名字不会写歪）")

# 17.7 窗口脚本引用的元素 id 必须都在 xhtml 里（§7 同款守卫）
bl_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', bl_xhtml))
bl_refs = set(re.findall(r'\$\(\s*"([A-Za-z0-9_-]+)"\s*\)', bl_js))
bl_refs |= set(re.findall(r'(?:setText|setLabel|getElementById)\(\s*"([A-Za-z0-9_-]+)"', bl_js))
bl_missing = sorted(i for i in bl_refs if i not in bl_ids)
ok(not bl_missing, "17.7 窗口脚本引用的元素 id 都存在于 bilingual.xhtml → 缺失: %s" % (bl_missing or "无"))

# 17.8~17.10 翻译链路必须回传（窗口作用域没有 AIClient/AIChat）
bl_code = re.sub(r"/\*[\s\S]*?\*/", "", bl_js)
bl_code = re.sub(r"(?m)//.*$", "", bl_code)
ok(not re.search(r"AIClient\s*\.|\bAIChat\b|Zotero\.HTTP|fetch\s*\(", bl_code),
   "17.8 窗口脚本不直连 AI/网络（去掉注释后无 AIClient/AIChat/Zotero.HTTP/fetch）")
ok("A.translateChunk(" in bl_js and "A.getFullText(" in bl_js and "A.makeNote(" in bl_js,
   "17.9 取全文/翻译/写笔记都走注入回调")
ok("translateChunk:" in bl_mod and "getFullText:" in bl_mod and "makeNote:" in bl_mod,
   "17.10 模块侧注入了 translateChunk/getFullText/makeNote")

# 17.11~17.16 布局语义：两栏等宽 + 单栏回退 + 单一滚动容器（行级同步的结构保证）
ok("grid-template-columns: 1fr 1fr" in bl_js, "17.11 两栏等宽（1fr 1fr）")
ok("grid-template-columns: 1fr;" in bl_js, "17.12 单栏回退为一列")
ok('setAttribute("data-cols"' in bl_js, "17.13 栏数经 data-cols 切换")
ok("MIN_TWO_COL_PX" in bl_js and 'addEventListener("resize"' in bl_js,
   "17.14 窄屏自动切单栏（宽度阈值 + resize 监听）")
ok("pp-bl-scroll" in bl_xhtml and "overflow-y:auto" in bl_xhtml,
   "17.15 单一滚动容器负责滚动（两栏不各自滚动）")
ok(len(re.findall(r"scrollTop\s*=", bl_js)) == 1,
   "17.16 只有一处 scrollTop 赋值（没有两栏互相追的同步逻辑）")

# 17.17~17.22 入口接线：三处指向双栏窗口，且原「双语笔记」出口保留
ok("PdfDual.openForSelected" in menus_js,
   "17.17 右键菜单主入口指向左原右译对照窗口（PdfDual，0.36.0）")
# 0.42.0：「文本双栏」右键入口撤掉（与对照翻译重叠），功能中心 Hub 仍可达 → 改验 hub.js
_hub_js_early = io.open(os.path.join(ROOT, "chrome", "content", "hub.js"), encoding="utf-8").read() \
    if os.path.exists(os.path.join(ROOT, "chrome", "content", "hub.js")) else ""
ok("BilingualTranslate.runForSelected()" not in menus_js and "bilingual" in _hub_js_early,
   "17.18 文本双栏右键入口已撤（0.42.0），功能中心仍可达")
ok("pdfDual.openForSelected" in wb_js, "17.19 工作台「全文对照翻译」chip 指向左原右译窗口")
ok("pdfDual.openForSelected" in hub_js, "17.20 功能中心卡片指向左原右译窗口")
ok("runForSelected()" in bl_mod, "17.21 原笔记流程仍在（未删）")
ok("openViewerForSelected" in bl_mod,
   "17.21b 旧「文本双栏」出口仍在模块里（0.36.0 起不再挂菜单，保留备用）")
ok("_noteMd(" in bl_mod, "17.22 笔记正文由共用函数生成（窗口导出与笔记出口零漂移）")

# 17.23~17.25 pref 默认值 + 设置面板可配
ok("bilingualViewFontSize" in prefsdef, "17.23 prefs.js 有 bilingualViewFontSize 默认值")
ok("bilingualViewLayout" in prefsdef, "17.24 prefs.js 有 bilingualViewLayout 默认值")
ok("bilingualViewFontSize" in pprefs_xhtml, "17.25 设置面板可配双栏窗口字号")

# 17.26~17.27 主题作用域
ok("paperpilot:bilingual" in uitheme_js, "17.26 双栏窗口纳入 ui-theme 主题作用域")
ok('wtype === "paperpilot:bilingual"' in uitheme_js, "17.27 ui-theme 的窗口判定含双栏窗口")

# 17.28~17.29 文案键
ok("menuBilingualView" in utils_js, "17.28 文案表有 menuBilingualView")
ok("blLayoutAuto" in utils_js and "blNoteDone" in utils_js, "17.29 双栏窗口文案键已入表")

# 17.30 门禁：窗口渲染测试进 preflight
_pf2 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("bilingual-view.test.js" in _pf2, "17.30 preflight 含双栏对照窗口渲染测试")

# ---------- 18. AI 计费计量与成本看板（服务端 1.5.0） ----------
PRICING_LIB = os.path.join(ROOT, "server", "lib", "pricing.js")
pricing_src = io.open(PRICING_LIB, encoding="utf-8").read()
BACKUP_LIB = os.path.join(ROOT, "server", "lib", "backup.js")
backup_src = io.open(BACKUP_LIB, encoding="utf-8").read()

# --- pricing.js：纯函数与口径 ---
for fn in ["normalize", "priceFor", "setModel", "removeModel", "usageOf", "costOf", "microText"]:
    ok(re.search(r"function %s\b" % fn, pricing_src) is not None, "18.1 pricing.js 定义 %s()" % fn)
ok("MICRO_PER_YUAN = 1e6" in pricing_src, "18.2 成本单位是微元（1e-6 元），避免小额被四舍五入抹平")
ok("MICRO_PER_CENT = 1e4" in pricing_src, "18.3 微元与分的换算常量存在")
# ★ 前缀匹配会让贵模型按便宜模型的价结算 —— 必须只做精确（含大小写不敏感）匹配
ok("刻意**不做前缀" in pricing_src or "不做前缀" in pricing_src,
   "18.4 ★ 明确不做前缀/模糊匹配（glm-5.3 不得吃掉 glm-5.3-flash 的价）")
ok("function usageOf" in pricing_src and "prompt_tokens" in pricing_src and "input_tokens" in pricing_src,
   "18.5 usage 解析兼容两种命名")
ok("if (!inTok && !outTok && !totalTok) return null" in pricing_src,
   "18.6 ★ 无有效 token 时返回 null（计量盲区），不冒充 0 成本")

# --- 服务端接入 ---
ok("require('./lib/pricing')" in srv, "18.7 服务端引入 pricing 模块")
ok("new JsonStore(path.join(DATA_DIR, 'pricing.json')" in srv, "18.8 pricing.json 独立存储")
ok("pricingStore.data = pricing.normalize(pricingStore.data)" in srv, "18.9 启动即归一化单价表")

# --- 网关计量 ---
ok("stream_options = Object.assign({}, upstreamBody.stream_options, { include_usage: true })" in srv,
   "18.10 流式自动注入 stream_options.include_usage（否则流式完全无法计费）")
ok("c.streamUsage !== false" in srv, "18.11 通道级可关掉注入（兼容不认该参数的上游）")
ok("const scanSse = (text) =>" in srv, "18.12 流式逐行扫描 usage")
ok("meterTail = meterTail.slice(-4096)" in srv, "18.13 ★ 流式扫描缓冲有界（不随响应体量增长）")
ok("const billModel = respModel || requestedModel;" in srv,
   "18.14 ★ 按「响应里的真实模型」计价（auto 会被上游解析成真名）")
ok("countUsage(user, { model: billModel, usage: respUsage, costMicro: cost ? cost.micro : 0 })" in srv,
   "18.15 计量信息落库（次数 + token + 成本）")
ok("if (!ok) return;   // 上游 4xx" in srv, "18.16 上游 4xx 不计次（保持 1.4.x 旧口径）")
ok("plainSize > PLAIN_METER_MAX" in srv, "18.17 非流式响应体过大时放弃解析（保护内存）")

# --- 用量结构：旧字段不能被破坏 ---
ok("u.daily[d] = (Number(u.daily[d]) || 0) + 1;" in srv, "18.18 ★ daily 仍是 number（旧读取点零改动）")
ok("u.missingUsage += 1;" in srv, "18.19 ★ 无 usage 单独计入 missingUsage，不污染成本")
ok("u.byModel[key] = m;" in srv, "18.20 按模型累计")
ok("function usageTotalsIn" in srv and "function usageSeriesDays" in srv, "18.21 窗口合计/序列辅助函数")
ok("function costViewOf" in srv, "18.22 成本视图（微元 + 格式化文案）")
ok("cost: costViewOf(user)," in srv, "18.23 /api/auth/me 下发 cost（客户端可展示）")
ok("function usageSummary" in srv and "function pricingAdminOut" in srv, "18.24 看板与单价表视图函数")

# --- 看板必须暴露「未配价」而不是假装省钱 ---
ok("unconfigured: usedModels.filter((x) => !x.configured)" in srv,
   "18.25 ★ 单价表视图列出「被调用过但未配价」的模型")
ok("suspectUnpriced: t.costMicro === 0 && (t.inTok + t.outTok) > 0" in srv,
   "18.26 ★ 窗口内有调用却 0 成本 → 标疑未配价")

# --- 管理端点 ---
ok("url === '/api/admin/pricing' && method === 'GET'" in srv, "18.27 GET /api/admin/pricing 存在")
ok("url === '/api/admin/pricing' && method === 'PUT'" in srv, "18.28 PUT /api/admin/pricing 存在")
ok("url === '/api/admin/usage-summary' && method === 'GET'" in srv, "18.29 GET /api/admin/usage-summary 存在")
ok("function queryOf" in srv, "18.30 查询参数解析（days=）")

# --- health ---
ok("version: '1.7.1'" in srv, "18.31 服务端版本号已随批次更新（1.7.1）")
ok("pricedModels: pricing.modelList(pricingStore.data).length" in srv, "18.32 health 暴露已配价模型数")
ok("meteringGaps:" in srv, "18.33 health 暴露计量盲区累计")

# --- 审计（两处都要有） ---
ok("'pricing.update'" in audit_src, "18.34 audit.js 动作表含 pricing.update")
ok("'pricing.update'" in ps, "18.35 launcher 的 Get-AuditText 也含 pricing.update")

# --- 快照 / 回滚 ---
ok("'pricing.json'" in backup_src, "18.36 单价表纳入数据快照（可回滚）")
ok("pricingStore.reload();" in srv, "18.37 reloadStores 一并重载单价表（回滚后内存同步）")

# --- Web 管理页 ---
for k in ["tab-cost", "pane-cost", "cost-total", "cost-price-body", "mp-model", "cost-days",
          "cost-unpriced", "cost-model-body", "cost-user-body", "cost-day-body"]:
    ok(k in html, "18.38 admin.html 含 %s" % k)
ok("loadCostTab" in html and "loadPricing" in html and "saveModelPrice" in html,
   "18.39 管理页成本页函数齐备")
ok("'/api/admin/usage-summary?days='" in html, "18.40 管理页调用成本看板接口")
ok("'/api/admin/pricing'" in html, "18.41 管理页调用单价表接口")
ok("if (feedback) msg('cost-msg', feedback, true);" in html,
   "18.42 ★ 反馈写在渲染之后（否则会被本轮刷新重置掉）")

# ★★ 18.43 管理页内联脚本不得有重名函数
#    同作用域下重复声明会**静默**用后者覆盖前者（本次新增成本页时 savePrice/delPrice
#    就与既有价格表函数撞名），前端无任何报错，只表现为某个功能「点了没反应/改错地方」。
_admin_js = re.findall(r"<script>(.*?)</script>", html, re.S)
if _admin_js:
    _names = re.findall(r"^function\s+(\w+)", _admin_js[-1], re.M)
    _dups = sorted(set([n for n in _names if _names.count(n) > 1]))
    ok(not _dups, "18.43 ★ admin.html 内联脚本无重名函数" + ("" if not _dups else "（重名：%s）" % ",".join(_dups)))
    # 18.44 onclick 引用的函数必须都已定义（否则是「点了没反应」的头号成因）
    _called = set(re.findall(r'onclick="(\w+)\(', html)) | set(re.findall(r"onclick=\"(\w+)\(", _admin_js[-1]))
    _missing = sorted([c for c in _called if c not in _names and c not in
                       ("location", "alert", "confirm")])
    ok(not _missing, "18.44 ★ admin.html 的 onclick 引用都已定义" + ("" if not _missing else "（缺：%s）" % ",".join(_missing)))
else:
    ok(False, "18.43 admin.html 应有内联脚本")

# ★★ 18.43b DOM id 不得重复
#    `$('x')` 只取第一个匹配。重复 id 会让 getElementById 永远命中旧元素，
#    表现为「新表单填了没反应 / 保存的是别的表单的值」——前端零报错。
#    本次新增成本页时 cost 页的 cp-note 与优惠券页撞 id，直接让后台 E2E 超时。
_ids = re.findall(r'\bid="([^"]+)"', html)
_dupid = sorted(set([k for k in _ids if _ids.count(k) > 1]))
ok(not _dupid, "18.43b ★ admin.html 无重复 DOM id" + ("" if not _dupid else "（重复：%s）" % ",".join(_dupid)))

# --- 门禁接入 ---
_pf3 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/pricing.test.js" in _pf3, "18.45 preflight 含 AI 计费单价测试")
ok("test/metering.test.js" in _pf3, "18.46 preflight 含网关计量测试")

# ---------- 19. 余额域（服务端 1.6.0：注册赠送 / 充值 / 按成本扣减） ----------
BAL_LIB = os.path.join(ROOT, "server", "lib", "balance.js")
bal_src = io.open(BAL_LIB, encoding="utf-8").read()

for fn in ["normalizeCfg", "ensure", "sweep", "grantSignup", "adminAdjust", "consume", "precheck", "userView", "adminView"]:
    ok(re.search(r"function %s\b" % fn, bal_src) is not None, "19.1 balance.js 定义 %s()" % fn)
ok("signupGrantMicro: 6 * pricing.MICRO_PER_YUAN" in bal_src, "19.2 默认注册赠送 ¥6（用户决策）")
ok("signupValidDays: 30" in bal_src, "19.3 赠送默认 30 天有效（防批量注册囤积）")

# ★ 铁律：钱不过期，赠品才过期 —— paidMicro 没有任何到期机制
ok("grantedExpiresAt" in bal_src and "paidExpiresAt" not in bal_src,
   "19.4 ★ 充值余额无到期字段（钱不过期，赠品才过期）")
# ★ 透支不得被读取路径消毒成 0（曾因 ensure 用非负夹取把欠费清零，测试揪出）
ok("b.paidMicro = signedMicro(b.paidMicro);" in bal_src, "19.5 ★ ensure 保留负的充值余额（透支如实）")
ok("micro(b.grantedMicro, 0)" in bal_src, "19.6 赠送余额仍非负（过期由 sweep 清零）")
# ★ precheck 必须先看 enforce（曾漏判，把观察模式变成拦截）
ok("if (!c.enforce) return { allowed: true" in bal_src, "19.7 ★ 观察模式（enforce=false）恒放行")
# ★ 高级模型：注册赠送不算数，且必须有订阅额度/充值（阈值 0 时不能放行 0 额度用户）
ok("const okPaid = avail > 0 && avail >= c.minBalanceMicro;" in bal_src,
   "19.8 ★ 高级模型要求订阅额度+充值过阈值且 > 0（注册赠送限基础模型）")
# ★ 订阅额度：不结转 —— 只认期号，本期发过就不再补（否则"花完自动续杯"）
ok("if (b.planPeriodKey === key) return null;" in srv,
   "19.8b ★ 订阅额度只按期号判重（花完不补，落实不结转）")
ok("'BALANCE_REQUIRED_FOR_HIGH_TIER'" in bal_src, "19.9 高级模型拦截有独立 code")
ok("'INSUFFICIENT_BALANCE'" in bal_src, "19.10 余额不足拦截有可编程 code")
ok("自带 Key 不受额度限制" in bal_src, "19.11 拦截文案给「充值 / 自有 Key」两条出路")

# --- 服务端接线 ---
ok("require('./lib/balance')" in srv, "19.12 服务端引入 balance 模块")
ok("balance.normalizeCfg(pricingStore.data)" in srv, "19.13 启动归一化余额配置")
ok("balance.grantSignup(user, balanceCfg())" in srv, "19.14 注册自动赠送")
ok("const gate = balance.precheck(user, balanceCfg(), { highTier: isHighTier });" in srv,
   "19.15 网关 pre-check（在 auto 解析之后，高级判定才准确）")
ok("return json(res, 402, { ok: false, code: gate.code" in srv, "19.16 余额不足 → 402（非 429，语义独立）")
ok("balance.consume(user, cost.micro" in srv, "19.17 网关按真实成本扣减")
# 用位置关系断言顺序（正则跨多行块太脆）：扣减必须先于 countUsage，
# 借 countUsage 内部的 usersStore.save() 把余额变动一并落盘
_consume_pos = srv.find("balance.consume(user, cost.micro")
_count_pos = srv.find("countUsage(user, { model: billModel")
ok(_consume_pos >= 0 and _count_pos >= 0 and _consume_pos < _count_pos,
   "19.18 ★ 扣减在 countUsage 之前（借它的 save 一并落盘）")
ok("balance: balance.userView(user, balanceCfg())," in srv, "19.19 /api/auth/me 下发 balance")
ok("balance: balance.adminView(u)," in srv, "19.20 管理端用户视图带余额")
ok("/balance$/" in srv, "19.21 管理端充值/调账路由存在（/balance）")
ok("input.balance && typeof input.balance === 'object'" in srv, "19.22 PUT /api/admin/pricing 接受 balance 配置块")
ok("balanceEnforce: balanceCfg().enforce" in srv, "19.23 health 暴露 enforce 状态")
ok("version: '1.7.1'" in srv, "19.24 服务端版本随批次推进（1.7.1）")

# --- 审计（两处都要有） ---
ok("'balance.adjust'" in audit_src, "19.25 audit.js 动作表含 balance.adjust")
ok("'balance.adjust'" in ps, "19.26 launcher 的 Get-AuditText 也含 balance.adjust")

# --- Web 管理页（余额 UI） ---
for k in ["bl-enforce", "bl-grant", "bl-valid", "bl-min", "u-bal", "u-bal-delta"]:
    ok(k in html, "19.27 admin.html 含 %s" % k)

# --- 1.6.0 管理页补充：订阅额度 / 充值档位 / 权益文案 ---
for k in ["p-pro-grant", "p-free-grant", "bl-opts", "p-free-feats", "p-pro-feats"]:
    ok(k in html, "19.28 admin.html 含 %s" % k)
ok("monthlyGrantMicro: Math.round((Number($('p-pro-grant').value) || 0) * 1e6)" in html,
   "19.29 ★ 套餐表单提交每月订阅额度（元 → 微元）")
ok("features: readFeatures('p-pro-feats')" in html,
   "19.30 ★ 权益文案可在后台编辑（否则权益说明只能靠 API 改）")
ok("rechargeOptions: readRechargeOptions()" in html, "19.31 充值档位随余额配置一并提交")
ok("function applyOrderFulfill(order, by) {" in srv, "19.32 ★ 核销副作用唯一入口存在")
ok(srv.count("applyOrderFulfill(") >= 3, "19.33 ★ 手动核销与对账核销共用同一入口（防副作用逻辑漂移）")
ok("membership.createCreditOrder(" in srv, "19.34 服务端接入充值下单")

# --- 门禁接入 ---
ok("test/balance.test.js" in _pf3, "19.28 preflight 含余额域测试")

# ---------- 20. 插件端余额展示与充值（0.26.0） ----------
ACCT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js")
acct_js = io.open(ACCT_JS, encoding="utf-8").read()
PREFS_CSS = os.path.join(ROOT, "chrome", "content", "prefs.css")
prefs_css = io.open(PREFS_CSS, encoding="utf-8").read()
MANIFEST = io.open(os.path.join(ROOT, "manifest.json"), encoding="utf-8").read()

ok(re.search(r"^  balance\(\) \{", acct_js, re.M) is not None, "20.1 account.js 定义 balance() 访问器")
ok('if (!b || typeof b !== "object") return null;' in acct_js,
   "20.2 ★ 旧服务端无 balance → 返回 null（面板整块隐藏，不显示假数据）")
ok("async createCreditOrder(optionId)" in acct_js, "20.3 account.js 提供充值下单")
ok("rechargeOptions: Array.isArray(j.rechargeOptions) ? j.rechargeOptions : []" in acct_js,
   "20.4 plans() 透出充值档位（旧服务端为空数组）")
ok("overdraft: num(b.paidMicro) < 0" in acct_js, "20.5 透支状态透出给面板（不静默）")

for fn in ["renderBalance", "renderBalOptions", "ensureRechargeOptions", "onBalCreate",
           "renderBalPay", "onBalClaim", "onBalPoll", "onBalCancel", "onBalRefresh"]:
    ok(re.search(r"function %s\b" % fn, prefs_js) is not None, "20.6 prefs-account.js 定义 %s()" % fn)
ok("try { renderBalance(); } catch (e)" in prefs_js, "20.7 renderAll 纳入 renderBalance（并自带 try）")
ok("stopBalPolling(); // 充值订单轮询同理" in prefs_js, "20.8 面板关闭停掉充值订单轮询（定时器不泄漏）")
ok("bind(\"pp-bal-create\", \"click\", onBalCreate)" in prefs_js, "20.9 充值按钮已绑定")

for eid in ["pp-bal-block", "pp-bal-total", "pp-bal-detail", "pp-bal-note",
            "pp-bal-recharge-toggle", "pp-bal-recharge", "pp-bal-options",
            "pp-bal-create", "pp-bal-pay", "pp-bal-pay-info", "pp-bal-claim",
            "pp-bal-poll", "pp-bal-cancel", "pp-bal-refresh"]:
    ok(eid in xhtml_ids, "20.10 prefs.xhtml 含 #%s" % eid)
ok(".pp-root .pp-bal {" in prefs_css, "20.11 prefs.css 有 .pp-bal 样式")

# 0.38.3 起改为**自洽校验**：manifest 版本必须等于 dist/ 里最新 xpi 的版本号
# （早先钉死字面量，每发一版都要手改这里，改漏就假红/过时）。
def _latest_dist_version():
    d = os.path.join(ROOT, "dist")
    vs = []
    try:
        for f in os.listdir(d):
            m = re.match(r"paper-pilot-(\d+\.\d+\.\d+)\.xpi$", f)
            if m:
                vs.append(tuple(int(x) for x in m.group(1).split(".")))
    except OSError:
        pass
    if not vs:
        return None
    return ".".join(str(x) for x in max(vs))


_mf_ver = (re.search(r'"version"\s*:\s*"([^"]+)"', MANIFEST) or [None, ""])[1]
_dist_ver = _latest_dist_version()
ok(bool(_mf_ver) and _mf_ver == _dist_ver,
   "20.12 manifest 版本与 dist 最新产物一致（%s / %s）" % (_mf_ver, _dist_ver))
ok("J14 ★ 旧服务端无 balance → 整块隐藏" in io.open(os.path.join(TEST_DIR, "membership-panel.test.js"), encoding="utf-8").read(),
   "20.13 面板测试含余额用例（旧服务端隐藏 + 三档展示 + 充值下单）")

# ---------- 21. 在线支付（服务端 1.7.0：易支付/码支付接入） ----------
PAY_LIB = os.path.join(ROOT, "server", "lib", "pay.js")
SB_LIB = os.path.join(ROOT, "server", "lib", "secretbox.js")
pay_src = io.open(PAY_LIB, encoding="utf-8").read()
sb_src = io.open(SB_LIB, encoding="utf-8").read()
bk_src = io.open(os.path.join(ROOT, "server", "lib", "backup.js"), encoding="utf-8").read()

for fn in ["newCfg", "sanitizeCfg", "isReady", "adminOut", "buildSign", "verifySign",
           "rsaSign", "rsaVerify", "verifyNotify", "newTradeNo", "createPayUrl",
           "queryOrder", "testConnection", "checkKeys"]:
    ok(re.search(r"^(?:async )?function %s\b" % fn, pay_src, re.M) is not None, "21.1 pay.js 定义 %s()" % fn)

# ★ 本仓库服务端声明支持 Node ≥14：不得用全局 fetch（医疗项目原实现用了，这里必须换掉）
ok(pay_src.count("mod.request(") >= 1 and "? https : http" in pay_src,
   "21.2 ★ 用原生 http/https 模块按协议选传输（不依赖全局 fetch）")
ok("fetch(" not in pay_src, "21.3 ★ pay.js 里没有裸 fetch 调用")
ok("timingSafeEqual" in pay_src, "21.4 MD5 验签用定长比对（防时序侧信道）")
ok("NOTIFY_OK = 'success'" in pay_src and "NOTIFY_FAIL = 'fail'" in pay_src,
   "21.5 回调应答常量（协议要求收 success 才停止重试）")
ok("/^[A-Za-z0-9]+$/" in io.open(os.path.join(TEST_DIR, "pay.test.js"), encoding="utf-8").read(),
   "21.6 商户订单号纯字母数字有测试守（网关只收字母数字）")
ok("deep" in pay_src and "0.01" in pay_src,
   "21.7 深度自检会探一笔 0.01 元测试单，且**默认关闭**（由管理员显式触发）")

# 加密盒子
ok("aes-256-gcm" in sb_src, "21.8 secretbox 用 AES-256-GCM")
ok(".secret.key" in sb_src, "21.9 主密钥独立文件（不进备份）")
ok("  } catch (e) {\n    return null;\n  }" in sb_src, "21.10 ★ 解密失败返回 null（不抛异常上去）")
# ★ 密钥文件与支付配置都不能进快照：回滚把它们换成旧的，是「改钱」级意外
ok("pay.json" not in bk_src, "21.11 ★ pay.json 不在备份文件清单里")
ok(".secret" not in bk_src, "21.12 ★ 主密钥不进备份（备份被拿走也解不开商户密钥）")

# 服务端接线
ok("require('./lib/pay')" in srv and "require('./lib/secretbox')" in srv, "21.13 服务端引入 pay/secretbox")
ok("const payStore = new JsonStore(path.join(DATA_DIR, 'pay.json')" in srv, "21.14 支付配置存 pay.json")
ok("payStore.data = pay.sanitizeCfg(payStore.data);" in srv, "21.15 启动归一化支付配置")
for fn in ["payCfg", "siteBaseUrl", "onlinePayReady", "fulfillByGateway", "payReturnHtml"]:
    ok(re.search(r"^function %s\b" % fn, srv, re.M) is not None, "21.16 服务端定义 %s()" % fn)
# ★ notify_url 不能按 Host 头推断（公网请求可伪造 Host，会把回调指向攻击者域名）
ok("process.env.PP_PUBLIC_URL" in srv and "/^https:\\/\\//i.test(siteBaseUrl())" in srv,
   "21.17 ★ 回调地址用 PP_PUBLIC_URL 显式配置，且要求 https")
ok("secretbox.encrypt(DATA_DIR," in srv, "21.18 商户密钥加密后落盘")
ok("next.keyEnc = k ? secretbox.encrypt(DATA_DIR, k) : '';" in srv,
   "21.19 密钥三态：非空=保存 / 空串=清除 / 未提交=保持")

# ★ notify 是公开路由：必须在 isLocalAdmin 守卫**之前**注册（网关从公网来，永不来自回环）
_i_guard = srv.find("if (!isLocalAdmin(req)) return json(res, 403, { ok: false, error: '管理接口仅限本机调用' });")
_i_notify = srv.find("url === '/api/pay/notify'")
ok(_i_guard > 0 and _i_notify > 0 and _i_notify < _i_guard,
   "21.20 ★ 回调路由注册在管理守卫之前（否则公网网关打不进来 → 支付全部不到账）")

# 五重校验 + 幂等履约
_notify_body = srv[_i_notify:_i_notify + 2600] if _i_notify > 0 else ""
for probe, label in [("pay.verifyNotify(cfg, q)", "验签"), ("!== cfg.pid", "商户号比对"),
                     ("TRADE_SUCCESS", "交易状态"), ("amount_mismatch", "金额比对（防少付）"),
                     ("fulfillByGateway(order", "幂等履约")]:
    ok(probe in _notify_body, "21.21 回调校验：%s" % label)
ok("res.end(pay.NOTIFY_FAIL)" in _notify_body and "res.end(pay.NOTIFY_OK)" in _notify_body,
   "21.22 回调应答用固定 'fail'/'success'（不泄露拒绝原因）")
ok(srv.count("fulfillByGateway(") >= 3,
   "21.23 ★ 回调与主动查单共用同一履约入口（副作用不漂移）")
ok("applyOrderFulfill(order, source || 'gateway')" in srv,
   "21.24 支付履约复用既有唯一入口 applyOrderFulfill")

# 订单模型
mem_src = io.open(os.path.join(ROOT, "server", "lib", "membership.js"), encoding="utf-8").read()
ok("outTradeNo: ''," in mem_src and "function findOrderByTradeNo" in mem_src,
   "21.25 订单带 outTradeNo + 可按商户订单号反查")
ok("tradeNo: ''" in mem_src and "paidAt: null" in mem_src, "21.26 订单记录网关交易号与支付时间")

# 审计（三处）
ok("'order.pay'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read()
   and "'pay.config'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read(),
   "21.27 audit.js 含 order.pay / pay.config")
ok("'order.pay'" in ps and "'pay.config'" in ps, "21.28 launcher 的 Get-AuditText 同步两份文案")

# 客户端契约与后台
ok("onlinePay: onlinePayReady()" in srv, "21.29 health 暴露 onlinePay")
ok("onlinePay: onlinePayReady()" in srv and "'/api/plans'" in srv, "21.30 /api/plans 暴露 onlinePay 可用性")
for k in ["pay-enabled", "pay-provider", "pay-gateway", "pay-pid", "pay-key", "pay-test", "pay-msg"]:
    ok(k in html, "21.31 admin.html 含 %s" % k)

ok("version: '1.7.1'" in srv, "21.32 服务端版本 1.7.1")
ok("test/pay.test.js" in _pf3, "21.33 preflight 含在线支付测试")

# ---------- 22. 多引擎翻译（插件 0.28.0） ----------
# 起因：翻译从「只能走 AI 大模型」扩为「多引擎注册表」。这类改造有三类静默失败：
#   ① 引擎注册表加了新厂商，但装配/暴露/设置脚本漏了一处 → 界面上看不到、或选了不生效；
#   ② 消费方（浮窗/对照/标题摘要/对比整页）漏改一处 → 有的地方仍强绑 AI，未登录就废；
#   ③ 语言/密钥这类「契约数据」在模块与设置界面之间对不上 → 选了引擎却发不出请求。
TRANSLATE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "translate.js")
PREFS_TRANSLATE_JS = os.path.join(ROOT, "chrome", "content", "prefs-translate.js")
tr_js = io.open(TRANSLATE_JS, encoding="utf-8").read()
trp_js = io.open(PREFS_TRANSLATE_JS, encoding="utf-8").read()

ok('"ai/translate.js"' in mainjs, "22.1 main.js 装配清单含 ai/translate.js")
ok("this.translateSvc = TranslateSvc;" in mainjs, "22.2 main.js 把 TranslateSvc 挂到 Zotero.PaperPilot")
ok("TranslateSvc.migrate();" in mainjs, "22.3 启动时执行翻译配置一次性迁移")
ok('"chrome/content/prefs-translate.js"' in mainjs, "22.4 设置面板注册 prefs-translate.js 脚本")

for _sid in ["google", "googleapi", "bing", "edge", "youdao", "transmart", "mymemory",
             "libretranslate", "lingva", "deeplx", "deepl", "microsoft", "baidu",
             "tencent", "caiyun", "llm"]:
    ok(('id: "%s"' % _sid) in tr_js, "22.5 引擎注册表含 %s" % _sid)
ok("CFG_DEFAULTS" in tr_js and "fallback" in tr_js, "22.6 有回退链默认配置")
ok("function hmacSha1" in tr_js and "function googleTk" in tr_js,
   "22.7 自实现 HMAC-SHA1（腾讯云签名）与 Google tk 签名")
ok("function normalizeLang" in tr_js, "22.8 语言归一化入口")
ok("function buildEndpoint" in tr_js and "function extractResult" in tr_js,
   "22.9 请求构造/响应解析拆成纯函数（可离线单测）")
# ★ 默认活动引擎必须是 llm：老用户升级后行为不变（否则翻译质量会无声变化）
ok('active: "llm"' in tr_js, "22.10 ★ 默认活动引擎为 AI 大模型（向后兼容）")
ok("function available()" in tr_js, "22.11 提供 available() 供上层判定「翻译是否可用」")

# 消费方：四处都要走 TranslateSvc，且对照翻译要脱离 AIClient.chat 直连
rp_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "reader-popup.js"),
                encoding="utf-8").read()
bl_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "bilingual-translate.js"),
                encoding="utf-8").read()
ch_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "chat.js"),
                encoding="utf-8").read()
pc_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-compare.js"),
                encoding="utf-8").read()
ok("TranslateSvc.available()" in rp_js, "22.12 划词浮窗按引擎可用性放行翻译")
ok("opts && opts.svc" in rp_js, "22.13 划词浮窗翻译支持专用引擎路径")
ok("TranslateSvc.translate(chunk" in bl_js, "22.14 全文对照翻译走 TranslateSvc")
_bl_chunk = bl_js.split("_translateChunk(chunk, lang)")[1].split("_titleOf(")[0] if "_translateChunk(chunk, lang)" in bl_js else ""
ok("AIClient.chat(" not in _bl_chunk, "22.15 ★ 对照翻译的分段翻译不再直连 AIClient.chat")
ok("TranslateSvc.translate(meta.title" in ch_js, "22.16 标题摘要翻译走 TranslateSvc")
ok("TranslateSvc.translate(text" in pc_js, "22.17 对比窗口整页翻译走 TranslateSvc")

# pref 默认值与设置界面
ok('paperpilot.readerPopupTargetLang", "zh-CN"' in prefsdef, "22.18 目标语言默认规范码 zh-CN")
for _k in ["translateFromLang", "translateCfg", "translateMigrated28"]:
    ok(("paperpilot.%s" % _k) in prefsdef, "22.19 prefs.js 含 %s 默认值" % _k)
for _k in ["pp-tr-status", "pp-tr-active", "pp-tr-from", "pp-tr-to", "pp-tr-fallback",
           "pp-tr-timeout", "pp-tr-retry", "pp-tr-cache", "pp-tr-list", "pp-tr-test-result",
           "pp-tr-route", "pp-tr-total", "pp-tr-cooldown", "pp-tr-local-scan", "pp-tr-local"]:
    ok(_k in xhtml_ids, "22.20 prefs.xhtml 含 #%s" % _k)
_trp_used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', trp_js))
_trp_used |= set(re.findall(r'bind\("([A-Za-z0-9_-]+)"', trp_js))
_trp_missing = sorted(i for i in _trp_used if i not in xhtml_ids)
ok(not _trp_missing,
   "22.21 prefs-translate.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (_trp_missing or "无"))
ok("test/translate.test.js" in _pf3, "22.22 preflight 含翻译引擎测试")

# ---- 22.23~22.34：0.31.0 引擎补强（免密钥 Edge / 单次上限分段 / prepare 修复 / 额度说明）----
# 起因：① bing 依赖 prepare 取页面 token，而 prepare 只声明、从未被调用 → 该引擎必然失败；
#      ② MyMemory 单次上限是 500 **UTF-8 字节**（不是 500 字符），我们按字符分段 → 长句必失败；
#      ③ 免密钥阵营缺一个"语种最全又稳定"的引擎（必应网页版易 429）。
ok('id: "edge"' in tr_js, "22.23 新增免密钥 edge 引擎（必应/Edge）")
ok("edge.microsoft.com/translate/auth" in tr_js, "22.24 ★ edge 走官方 token 端点取临时票据")
ok("api-edge.cognitive.microsofttranslator.com" in tr_js, "22.25 ★ edge 走微软 v3 接口（非网页逆向）")
ok('"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)' in tr_js,
   "22.26 edge 携带 Edge UA（该接口对 UA 敏感）")
ok("if (typeof svc.prepare === \"function\" && !ctx.pre)" in tr_js,
   "22.27 ★★ prepare 真正被调用（此前只声明未调用 → bing 引擎失效）")
ok("ctx = Object.assign({}, ctx, { pre: await svc.prepare(ctx) });" in tr_js,
   "22.28 prepare 整次调用只做一次（多段复用同一 token）")
ok("function _splitText" in tr_js, "22.29 长文本分段纯函数存在")
ok("splitText: _splitText, segmentsFor: _segmentsFor" in tr_js, "22.30 分段函数已导出（可单测）")
ok("limits: { bytes: 500 }" in tr_js, "22.31 ★ MyMemory 声明 500 字节上限（官方是字节不是字符）")
ok("limits: { chars: 1000 }" in tr_js, "22.32 必应网页版声明 1000 字符上限")
ok("SEG_MAX" in tr_js, "22.33 分段数上限保护（避免退化成上百次串行请求）")
ok("s.hint" in trp_js, "22.34 设置面板渲染引擎自带的使用说明（额度/申请方式）")

# ---- 22.35~22.46：0.31.0 P1（回退链调度三件套 + Lingva/TranSmart）----
# 起因：只有"重试一次 + 依次回退"，缺**冷却**与**总预算**——一次网络抖动会把整条链跑满，
#      表现为"翻译转半天然后失败"；另外免密钥阵营缺"自建即无限流"的 Google 质量后端，
#      以及中文方向强的免密钥引擎。
ok("function _markCooldown" in tr_js and "function _inCooldown" in tr_js,
   "22.35 ★ 实现失败冷却（刚失败的引擎短时间内不再用）")
ok("clearCooldown, cooldownLeft," in tr_js, "22.36 冷却状态可查询/可清除（测试与界面都需要）")
ok("routeMs: 20000" in tr_js and "totalMs: 45000" in tr_js and "cooldownMs: 60000" in tr_js,
   "22.37 预算三件套有默认值（单路 20s / 总 45s / 冷却 60s）")
ok("chain = cands.filter((id) => {" in tr_js, "22.38 translate() 会跳过冷却中的引擎")
ok("if (!o.engine && c.cooldownMs > 0)" in tr_js,
   "22.39 ★ 显式指定 engine 时不受冷却影响（尊重调用方意图）")
ok("if (c.totalMs > 0 && c.totalMs - spent < 2000)" in tr_js,
   "22.40 总预算不足时停止整条链（而不是继续试下一个）")
ok("budget = Math.min(budget, c.routeMs);" in tr_js, "22.41 单路预算会压到该引擎的调用预算上")
ok("_markCooldown(id, c.cooldownMs);" in tr_js, "22.42 引擎失败后自动进入冷却")
ok("cooled," in tr_js and "detail:" in tr_js, "22.43 结果里回报「被跳过的引擎」与逐条原因明细")
ok("https://transmart.qq.com/api/imt" in tr_js and '"auto_translation"' in tr_js,
   "22.44 新增 TranSmart 引擎（免密钥，腾讯交互翻译）")
ok("transmart.qq.com/api/imt" in tr_js and "\"Origin\": \"https://transmart.qq.com\"" in tr_js,
   "22.45 TranSmart 带 Origin/Referer（网页接口要求）")
ok('"zh_HANT"' in tr_js and "/api/v1/" in tr_js,
   "22.46 新增 Lingva 引擎（REST /api/v1/，繁中用 zh_HANT）")
ok("translateFallbackUpgraded" in prefsdef, "22.47 prefs.js 含回退链升级迁移标记")
ok("translateFallbackUpgraded" in tr_js, "22.48 迁移逻辑只升级「从未自定义过」的回退链")

# ---- 22.49~22.57：0.31.0 P2（自建一键可用 + 隐私提示 + 引擎分组）----
# 起因：「自建离线」在调研里是 P3，但真正挡住用户的是"要自己记 5000/3000/1188 端口"；
#      把它做成一次探测 + 一键填入，P3 就不需要新增任何引擎也能落地。
#      另外：免密钥引擎会把文本发给第三方，学术场景必须如实告知（此前界面里没有任何提示）。
ok("probeLocal, LOCAL_PROBES," in tr_js, "22.49 自建服务探测已导出（设置面板与测试都用）")
ok("const LOCAL_PROBES = [" in tr_js, "22.50 定义本机候选服务清单")
for _e, _p in [("libretranslate", 5000), ("lingva", 3000), ("deeplx", 1188)]:
    ok(('engine: "%s"' % _e) in tr_js and ("port: %d" % _p) in tr_js,
       "22.51 探测 %s（默认端口 %d）" % (_e, _p))
ok('"http://127.0.0.1:" + p.port' in tr_js, "22.52 只探本机回环地址（不对外网扫描）")
ok("probeLocal(2000)" in trp_js, "22.53 设置面板发起探测（2s 超时，不卡界面）")
ok("S.setSecret(f.engine, { url: f.url })" in trp_js, "22.54 ★ 探测结果一键填入该引擎地址")
ok("onLocalScan" in trp_js and 'bind("pp-tr-local-scan", "click", onLocalScan)' in trp_js,
   "22.55 「检测本机自建服务」按钮已接线")
ok("catOf" in trp_js and "完全免配置" in trp_js and "需自备密钥" in trp_js,
   "22.56 引擎列表按「免配置 / 需地址 / 需密钥 / AI」分组")
ok("数据去向" in prefs_xhtml and "不出本机" in prefs_xhtml,
   "22.57 ★ 界面明确提示数据去向（免密钥引擎会把文本发给第三方）")

# ---- 22.58~22.66：0.31.0 界面改版（折叠式布局 + 测试按钮反馈修复）----
# 起因：16 个引擎平铺 + 每行密钥表单/说明 → "界面过于杂乱"；
#      而「测试」按钮的结果只写进卡片底部那个共用结果区，它在十几行之后 ——
#      用户点了按钮，反馈出现在屏幕外、按钮又飞快复原，观感就是"测试没反应"。
ok("COMMON_ENGINES" in trp_js and "COMMON_MAX" in trp_js, "22.58 定义「常用引擎」集合与上限")
ok("let showAllEngines = false;" in trp_js, "22.59 ★ 默认收起（只显示常用引擎）")
ok("function commonIds(" in trp_js and "commonIds(ov, S)" in trp_js,
   "22.60 常用集合 = 活动引擎 + 回退链 + 内置常用（去重后限上限）")
ok('showAllEngines = !showAllEngines;' in trp_js and "renderList();" in trp_js,
   "22.61 展开/收起按钮只重建列表（不整卡重渲染）")
ok("展开全部 " in trp_js and "收起，只看常用" in trp_js, "22.62 按钮文案含引擎总数与当前状态")
ok("pp-tr-more" in trp_js, "22.63 收起时提示「已收起 N 个」")
ok("onTest(s.id, bTest, rowMsg)" in trp_js, "22.64 ★ 测试结果写到**该行内**的元素上")
ok('class: "pp-tr-rowmsg"' in trp_js, "22.65 引擎行带行内结果位")
ok("msgEl.textContent = text" in trp_js and "setMsg(text, color);" in trp_js,
   "22.66 行内与底部双写（反馈不再跑到屏幕外）")
ok("test/prefs-translate.test.js" in _pf3, "22.67 preflight 含翻译设置面板测试")

# ---------- 23. 菜单瘦身（插件 0.29.0）----------
# 改动面：menus.js 注册表化 + classic 回退、prefs.js 三个菜单 pref、
# prefs.xhtml 菜单定制卡片、prefs-menu.js 面板脚本、main.js 暴露 menus/i18n。
# 钉死「重组不减功能」：注册表必须恰好 41 条（0.28 的 40 条 + 0.31.0 新增 ai-chat），
# classic 平铺回退必须真实存在（menuMode=classic 不是空话）。
ok('paperpilot.menuMode", "grouped"' in prefsdef, "23.1 prefs.js 有 menuMode 默认值 grouped")
for _k in ["menuHiddenGroups", "menuQuickItems"]:
    ok(("paperpilot.%s" % _k) in prefsdef, "23.2 prefs.js 含 %s 默认值" % _k)
ok("ITEM_REGISTRY" in menus_js and "GROUPS" in menus_js, "23.3 menus.js 改为注册表驱动")
ok('_buildClassicItemMenu' in menus_js and '_buildClassicTools' in menus_js,
   "23.4 classic 平铺回退构建器存在（menuMode=classic 可一键切回）")
ok('"menuMode", "menuHiddenGroups", "menuQuickItems"' in menus_js,
   "23.5 三个菜单 pref 均注册观察者（改动即时重建）")
for _gid in ["ai", "notes", "citation", "tags", "meta", "cn", "automation", "state"]:
    ok(('id: "%s"' % _gid) in menus_js, "23.6 语义分组注册表含 %s" % _gid)
_item_reg_src = menus_js.split("GROUPS:")[0]
ok(_item_reg_src.count("labelKey:") == 48,
   "23.7 ★ 注册表恰好 48 条命令（实测 %d；0.36.0 撤 pdf-inline；0.42.0 撤文本双栏、+嵌套标签、+评级组×6；0.43.0 +知网登录；0.43.1 登录类收敛到设置面板，撤 cn-login；0.44.0（实验）+第三方文献源）" % _item_reg_src.count("labelKey:"))
ok("type\", \"radio\"" in menus_js and "ReadingState.getState" in menus_js,
   "23.8 阅读状态为 radio 子菜单并按当前选中条目打点")
ok('"chrome/content/prefs-menu.js"' in mainjs, "23.9 设置面板注册 prefs-menu.js 脚本")
ok("this.menus = Menus;" in mainjs and "this.i18n = I18n;" in mainjs,
   "23.10 main.js 把 Menus/I18n 挂到 Zotero.PaperPilot（面板单一真源）")
for _k in ["pp-menu-mode", "pp-menu-groups", "pp-menu-quick-0", "pp-menu-quick-1",
           "pp-menu-quick-2", "pp-menu-result"]:
    ok(_k in xhtml_ids, "23.11 prefs.xhtml 含 #%s" % _k)
_pmp_js = io.open(os.path.join(ROOT, "chrome", "content", "prefs-menu.js"), encoding="utf-8").read()
_pmp_used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', _pmp_js))
_pmp_missing = sorted(i for i in _pmp_used if i not in xhtml_ids)
ok(not _pmp_missing,
   "23.12 prefs-menu.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (_pmp_missing or "无"))
ok("Zotero.PaperPilot.menus" in _pmp_js or "PP().menus" in _pmp_js,
   "23.13 prefs-menu.js 经 Zotero.PaperPilot.menus 读注册表（不维护第二份列表）")
ok("test/menu-registry.test.js" in _pf3, "23.14 preflight 含菜单注册表测试")

# ---------- 24. 阅读器右侧栏 · 翻译面板（插件 0.30.0） ----------
# 起因：把翻译的「操作+选项+结果」从右键菜单/设置搬进右侧栏（ItemPane section）。
# 这类改动有四类静默失败：
#   ① ItemPaneManager.registerSection 缺 onRender → Z10 schema 校验不通过、**静默返回 false**
#      （面板根本不出现，且控制台只多一行 boot 日志）；
#   ② l10nID 没有对应的 .ftl 条目 → header/sidenav 不渲染（官网明示，本项目 ftl 注释也写了）；
#   ③ 注销时用注册时的 paneID 而非返回值 → 注销不掉；
#   ④ 划词缓存放在浮窗开关之后 → 用户关掉浮窗后侧栏永远拿不到选中文本。
PANE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "panels", "translate-pane.js")
pane_js = io.open(PANE_JS, encoding="utf-8").read()
ZH_FTL = io.open(os.path.join(ROOT, "locale", "zh-CN", "paperpilot.ftl"), encoding="utf-8").read()
EN_FTL = io.open(os.path.join(ROOT, "locale", "en-US", "paperpilot.ftl"), encoding="utf-8").read()

ok('"panels/translate-pane.js"' in mainjs, "24.1 main.js 装配清单含 panels/translate-pane.js")
ok("this.translatePane = TranslatePane;" in mainjs, "24.2 main.js 把 TranslatePane 挂到 Zotero.PaperPilot")
ok("TranslatePane.register(id);" in mainjs, "24.3 main.js 启动时注册翻译面板")
ok("TranslatePane.unregister();" in mainjs, "24.4 main.js 关闭时注销翻译面板")
ok("Zotero.ItemPaneManager.registerSection({" in pane_js, "24.5 走官方 ItemPaneManager.registerSection")
ok('paneID: "paperpilot-translate"' in pane_js or 'PANE_ID: "paperpilot-translate"' in pane_js,
   "24.6 paneID 为 paperpilot-translate")
ok("onRender(" in pane_js, "24.7 ★ 提供 onRender（Z10 缺了会静默返回 false，面板不出现）")
ok("sidenav:" in pane_js, "24.8 提供 sidenav（右侧栏图标位）")
ok('l10nID: "paperpilot-translate-section-header"' in pane_js, "24.9 header l10nID 正确")
ok('l10nID: "paperpilot-translate-section-sidenav"' in pane_js, "24.10 sidenav l10nID 正确")
for _ftl, _tag in [(ZH_FTL, "zh-CN"), (EN_FTL, "en-US")]:
    ok("paperpilot-translate-section-header =" in _ftl and "paperpilot-translate-section-sidenav =" in _ftl,
       "24.11 %s ftl 有 header+sidenav 条目（缺了图标不渲染）" % _tag)
# ★ 注销必须用 registerSection 的返回值（带命名空间的主键）
ok("this._registeredPaneID = registeredPaneID;" in pane_js
   and "unregisterSection(this._registeredPaneID" in pane_js,
   "24.12 ★ 注销用返回值（不是注册时的 paneID）")
ok("if (!registeredPaneID)" in pane_js, "24.13 显式检查 registerSection 返回值（false 时不静默）")

# ★ 划词缓存在浮窗开关判断之前（否则关掉浮窗后侧栏永远拿不到选中文本）
_rp_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "reader-popup.js"),
                  encoding="utf-8").read()
_i_cap = _rp_src.find("TranslatePane.captureSelection(")
_i_gate = _rp_src.find('if (!Prefs.get("readerPopupEnabled", true)) return;')
ok(_i_cap > 0 and _i_gate > 0 and _i_cap < _i_gate,
   "24.14 ★ 划词缓存先于浮窗开关判断（关掉浮窗也能在侧栏翻译）")

# 单一真源：分段与笔记正文复用全文对照翻译的实现，避免两处格式漂移
ok("BilingualTranslate._chunk(" in pane_js, "24.15 分段复用 BilingualTranslate._chunk（不重造）")
ok("BilingualTranslate._noteMd(" in pane_js, "24.16 笔记正文复用 BilingualTranslate._noteMd（格式零漂移）")
ok("pdfDual.openForItem(" in pane_js,
   "24.17 侧栏「双栏窗口」按钮走左原右译窗口（PdfDual，0.36.0）")
ok("AIClient.chat(" not in pane_js, "24.18 面板不直连 AIClient（一律经 TranslateSvc/AIChat）")
ok("TranslateSvc.translate(" in pane_js, "24.19 翻译经 TranslateSvc（多引擎 + 回退）")
ok("test/translate-pane.test.js" in _pf3, "24.20 preflight 含翻译面板测试")

# ---------- 25. 复杂 PDF 全文翻译优化（插件 0.33.0） ----------
# 起因：全文对照翻译此前直接把全文索引的扁平文本按字符切块送翻，学术论文的三类
# 静默劣化没人看得见——公式被改写、图表轴标签混进正文、页眉页脚每页重复烧预算。
# 本批次加 PdfText（结构化分析）+ 术语表/上下文（TranslateSvc）+ 窗口 blocks 渲染，
# 四类典型静默失败都要钉死：
#   ① 新模块没进装配清单或排到消费者之后 → ReferenceError，只写一行 boot 日志；
#   ② 窗口 blocks 路径写歪 → 退回旧路径，功能"看起来还在"但结构化白做；
#   ③ 术语表改了不吃新缓存（缓存键没带指纹）→ 用户以为术语表无效；
#   ④ 新 pref 没默认值 / 设置面板引用了不存在的元素 id → 静默 undefined。
PDFT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "pdf-text.js")
pdft_js = io.open(PDFT_JS, encoding="utf-8").read() if os.path.exists(PDFT_JS) else ""

ok(os.path.exists(PDFT_JS), "25.1 PdfText 模块存在（chrome/content/scripts/ai/pdf-text.js）")
ok('"ai/pdf-text.js"' in mainjs, "25.2 main.js 装配清单含 ai/pdf-text.js")
# 装配顺序：PdfText 必须在 translate.js（无依赖）与 bilingual-translate.js（消费）之前
_mj_lines = mainjs.split("\n")
def _line_of(marker):
    for i, l in enumerate(_mj_lines):
        if marker in l:
            return i
    return -1
ok(0 <= _line_of('"ai/pdf-text.js"') < _line_of('"ai/translate.js"'),
   "25.3 ★ PdfText 装配先于 translate.js（后者无依赖，但保持确定性顺序）")
ok(0 <= _line_of('"ai/pdf-text.js"') < _line_of('"features/bilingual-translate.js"'),
   "25.4 ★ PdfText 装配先于 bilingual-translate.js（消费者）")
ok("this.pdfText = PdfText;" in mainjs, "25.5 main.js 把 PdfText 挂到 Zotero.PaperPilot")

# 词法判定与分类顺序（误判公式/垃圾 = 丢内容）
ok("function isCaptionLine" in pdft_js and "function isFormulaText" in pdft_js
   and "function looksLikeJunkLine" in pdft_js, "25.6 三类词法判定齐全（caption/formula/junk）")
ok("function classify" in pdft_js, "25.7 有统一分类入口")
# ★ formula 必须先于 junk 判定：短公式长得像轴标签碎片，顺序错了会把公式当垃圾丢
_cl_block = pdft_js.split("function classify")[1].split("\n  }")[0] if "function classify" in pdft_js else ""
ok(_cl_block.index("isFormulaText") < _cl_block.index("looksLikeJunkLine"),
   "25.8 ★ classify 顺序 = caption → formula → junk（公式优先，宁可保留不误删）")
ok("function charsToParagraphs" in pdft_js, "25.9 阅读器字符流段落装配存在")
ok("function blocksToUnits" in pdft_js, "25.10 blocks → 翻译单元合并存在")
ok("kind === \"formula\"" in pdft_js, "25.11 单元带 formula kind（上层据此直出不送翻）")

# 双栏翻译模块：结构化提取 + 定位 + 回退
ok("PdfText.blocksFromReader" in bl_mod and "PdfText.analyzeText" in bl_mod
   and "PdfText.blocksToUnits" in bl_mod, "25.12 对照翻译消费 PdfText（reader 优先 + 扁平兜底 + 单元合并）")
ok("bilingualStructExtract" in bl_mod, "25.13 结构化提取受 pref 控制（可关闭回旧行为）")
ok("PdfText.locatePage" in bl_mod, "25.14 段落级定位经 PdfText.locatePage（复用 compare.js 页跳转打法）")
ok("getBlocks:" in bl_mod and "locate:" in bl_mod, "25.15 窗口载荷注入 getBlocks 与 locate 回调")
ok("context: o.context || null" in tr_js, "25.16 TranslateSvc 上下文经 makeCtx 透传（llm 消费）")
ok("bilingualContext" in bl_mod, "25.17 上下文感知受 pref 控制")

# 术语表（缓存键指纹 + 两处 prompt 注入 + 界面）
ok("function parseGlossary" in tr_js and "function glossaryBlock" in tr_js
   and "function glossaryFingerprint" in tr_js, "25.18 术语表三件套（解析/提示块/指纹）")
ok("glossaryFingerprint();" in tr_js, "25.19 ★ translate() 以术语表指纹参与缓存键（改表不吃旧缓存）")
ok("glossaryBlock(gl)" in tr_js, "25.20 llm 引擎 prompt 注入术语块")
ok("glossaryBlock()" in rp_js, "25.21 划词浮窗 LLM 翻译注入术语块（浮窗走 AIClient 直连，不经 _runEngine）")
ok("prefBool(\"bilingualStructExtract\"" in trp_js or "translateGlossary" in trp_js,
   "25.22 设置面板接线术语表/结构化开关")

# 行内公式保护（非 llm 引擎掩码）
ok("function maskInlineFormulas" in tr_js and "function unmaskFormulas" in tr_js,
   "25.23 行内公式掩码/还原存在（纯函数）")
ok("maskInlineFormulas(ctx.text)" in tr_js, "25.24 ★ 非 llm 引擎发送前掩码")
ok("unmaskFormulas(out, fMap)" in tr_js, "25.25 引擎返回后还原")
ok("maskInlineFormulas, unmaskFormulas," in tr_js, "25.26 掩码函数已导出（可单测）")

# pref 默认值 + 设置面板元素
for _k in ["translateGlossary", "bilingualStructExtract", "bilingualContext",
           "translateFormulaProtect"]:
    ok(("paperpilot.%s" % _k) in prefsdef, "25.27 prefs.js 含 %s 默认值" % _k)
for _id in ["pp-tr-glossary", "pp-tr-glossary-msg", "pp-tr-bl-struct",
            "pp-tr-bl-context", "pp-tr-formula"]:
    ok(_id in xhtml_ids, "25.28 prefs.xhtml 含 #%s" % _id)

# 门禁：两套测试都进 preflight
ok("pdf-text.test.js" in _pf3, "25.29 preflight 含 PDF 文本分析测试")
ok("bilingual-view.test.js" in _pf3, "25.30 preflight 含双栏窗口 blocks 渲染测试")
# 窗口脚本仍然只有一处 scrollTop 赋值（本批次不允许引入第二处）。
# ⚠️ §22 已把 bl_js 重赋为 bilingual-translate.js —— 这里必须按路径重读窗口脚本
_blv_src = io.open(BL_VIEW_JS, encoding="utf-8").read()
ok(len(re.findall(r"scrollTop\s*=", _blv_src)) == 1,
   "25.31 ★ 双栏窗口仍只有一处 scrollTop 赋值（定位经回调回插件侧，窗口不自滚）")


# ---------- 26. 参考文献一键入库（插件 0.33.0 重写） ----------
# 起因：旧实现（citation-trace.js 的 importForSelected）有三处硬伤——
#   ① `return d && !doiSet.has(d)` 把**所有没有 DOI 的参考文献直接丢弃**，用户看到的是
#      「参考文献均已在本地文库（或缺 DOI 无法可靠入库）」，功能等于不可用；
#   ② 只按 DOI 判重 → 库里已有的靠标题/arXiv/PMID 匹配不上，一键入库变一键造重复；
#   ③ 不分 itemType 地 setField("publicationTitle") 等字段 → 会议论文/书章/预印本被建成
#      期刊论文且字段静默丢失。
# 重写为三层（ref-format 纯函数 / ref-sources 多源 / ref-import 编排）+ 独立对话框。
# 这里守住的都是「点了没反应」类静默失败的接线：
RI_DIALOG_JS = os.path.join(ROOT, "chrome", "content", "ref-import.js")
RI_DIALOG_XHTML = os.path.join(ROOT, "chrome", "content", "ref-import.xhtml")
RI_MOD = os.path.join(ROOT, "chrome", "content", "scripts", "features", "ref-import.js")
ri_dialog_js = io.open(RI_DIALOG_JS, encoding="utf-8").read()
ri_dialog_xhtml = io.open(RI_DIALOG_XHTML, encoding="utf-8").read()
ri_mod = io.open(RI_MOD, encoding="utf-8").read()
ri_fmt = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "ref-format.js"),
                 encoding="utf-8").read()
ri_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "ref-sources.js"),
                 encoding="utf-8").read()
ri_ct = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "citation-trace.js"),
                encoding="utf-8").read()

# 25.1~25.4 装配：三层按依赖序加载 + 暴露给窗口/菜单
_ri_i_fmt = mainjs.find('"features/ref-format.js"')
_ri_i_src = mainjs.find('"features/ref-sources.js"')
_ri_i_imp = mainjs.find('"features/ref-import.js"')
ok(_ri_i_fmt > 0 and _ri_i_src > _ri_i_fmt and _ri_i_imp > _ri_i_src,
   "26.1 main.js 按依赖序装配 ref-format → ref-sources → ref-import")
ok("this.refImport = RefImport;" in mainjs, "26.2 main.js 把 RefImport 挂到 Zotero.PaperPilot")

# 25.5~25.7 入口：注册表、classic 菜单、功能中心三处都必须走新对话框
ok('run: () => RefImport.openDialog()' in menus_js, "26.3 注册表 ref-import 入口指向新对话框")
ok(menus_js.count("RefImport.openDialog()") >= 2, "26.4 classic 平铺菜单同样指向新对话框（两处）")
ok("PP.refImport.openDialog()" in hub_js, "26.5 功能中心卡片指向新对话框")

# 25.8 旧实现已删除：不能再有「无 DOI 即丢弃」的过滤与 refs-picker 依赖
ok("return d && !doiSet.has(d)" not in ri_ct, "26.6 ★ 旧「无 DOI 即丢弃」的过滤已从 citation-trace 删除")
ok("refs-picker" not in ri_ct, "26.7 citation-trace 不再依赖 refs-picker")
ok(not os.path.exists(os.path.join(ROOT, "chrome", "content", "refs-picker.xhtml")),
   "26.8 refs-picker 旧对话框已移除（唯一消费方已改走 ref-import）")
ok("importForSelected" in ri_ct and "RefImport.importForSelected()" in ri_ct,
   "26.9 citation-trace.importForSelected 保留为委托入口（兼容旧调用方）")

# 25.10~25.13 修复点的静态存在性：多键判重 / 无 DOI 也入库 / 字段按类型白名单 / 多源联合检索
ok("pmids" in ri_mod and "arxiv" in ri_mod and "isbns" in ri_mod and "titles" in ri_mod,
   "26.10 ★ 库内索引含 DOI/PMID/arXiv/ISBN/标题 五把键（旧实现只有 DOI 一把）")
ok("FIELD_PLAN" in ri_mod and "conferencePaper" in ri_mod and "bookSection" in ri_mod
   and "preprint" in ri_mod, "26.11 ★ 按 itemType 白名单映射字段（期刊/会议/书章/预印本各一套）")
ok("SOURCES" in ri_src and ri_src.count('id: "') >= 5, "26.12 ★ 五个免密钥数据源已注册")
ok("dedupeRecords" in ri_src and "_score" in ri_src and "源一致" in ri_src,
   "26.13 ★ 联合检索按「多源一致命中」打分（准确率机制）")
ok("aiComplete" in ri_mod and "aiInvestigate" in ri_mod, "26.14 AI 补全与 AI 调研均已实现")
ok("toBibtex" in ri_fmt and "toRIS" in ri_fmt and "toEndNoteXML" in ri_fmt and "toCSLAll" in ri_fmt,
   "26.15 ★ 导出支持 BibTeX / EndNote(RIS) / EndNote XML / CSL-JSON")

# 25.16~25.19 对话框：windowtype / 脚本引用 id 全部存在 / 不直连网络 / API 一一对应
ok('windowtype="paperpilot:ref-import"' in ri_dialog_xhtml,
   "26.16 对话框 windowtype 为 paperpilot:ref-import")
_ri_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', ri_dialog_xhtml))
# 对话框脚本里的 $("…") 与 getElementById("…") 都必须在 xhtml 里存在
_ri_refs = set(re.findall(r'\$\(\s*"([A-Za-z0-9_-]+)"\s*\)', ri_dialog_js))
_ri_refs |= set(re.findall(r'getElementById\(\s*"([A-Za-z0-9_-]+)"', ri_dialog_js))
_ri_missing = sorted(i for i in _ri_refs if i not in _ri_ids)
ok(not _ri_missing, "26.17 对话框脚本引用的元素 id 都存在 → 缺失: %s" % (_ri_missing or "无"))

_ri_code = re.sub(r"/\*[\s\S]*?\*/", "", ri_dialog_js)
_ri_code = re.sub(r"(?m)//.*$", "", _ri_code)
ok(not re.search(r"Zotero\.HTTP|AIClient\s*\.|\bAIChat\b|fetch\s*\(", _ri_code),
   "26.18 ★ 对话框脚本不直连网络/AI（一律经注入的 api）")

# 对话框调用的每个 api.xxx，编排层的 windowApi() 都必须真的提供（漏一个 = 按钮点了没反应）
_ri_api_calls = set(re.findall(r"\bapi\.([A-Za-z_]\w*)", ri_dialog_js))
_ri_api_calls = {c for c in _ri_api_calls if c not in ("isZh",)}
_ri_api_defined = set(re.findall(r"(?m)^\s{6}([A-Za-z_]\w*)\s*[:(]", ri_mod))
_ri_api_missing = sorted(c for c in _ri_api_calls if c not in _ri_api_defined)
ok(not _ri_api_missing,
   "26.19 ★ 对话框用到的 api 方法都已注入 → 缺失: %s" % (_ri_api_missing or "无"))

# 25.20~25.22 主题作用域 / 文案 / 默认值 / 门禁
ok("paperpilot:ref-import" in uitheme_js, "26.20 新对话框纳入 ui-theme 主题作用域")
ok("menuRefImport" in utils_js, "26.21 文案表保留 menuRefImport")
ok("refImportSources" in prefsdef, "26.22 prefs.js 有 refImportSources 默认值")
ok("refImportMailto" in prefsdef, "26.23 prefs.js 有 refImportMailto 默认值")
_pf4 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/ref-import.test.js" in _pf4, "26.24 preflight 含参考文献入库测试")
# 单实例枚举必须用 windowtype（写成窗口名 → 每点一次菜单就开一个新窗口，
# 这类错误静态单测看不出来，只有真机连点两次才会发现）
ok('WINDOW_TYPE: "paperpilot:ref-import"' in ri_mod
   and "getEnumerator(this.WINDOW_TYPE)" in ri_mod,
   "26.25 ★ 单实例枚举用 windowtype（不是窗口名）")
ok('WINDOW_NAME: "paperpilot-ref-import"' in ri_mod
   and "openDialog(this.DLOG_URL, this.WINDOW_NAME" in ri_mod,
   "26.26 openDialog 用窗口名，与 windowtype 分开")

# ---- 26.27~26.38 「该文献引用的参考文献要都能进来」这一轮的补强 ----
# 用户实测反馈：选中的文献没有把该文章引用的参考文献都一键入库。三个原因：
#   ① 参考文献表只取自 Semantic Scholar 一家 → 它没收录/没匹配上的一律看不到；
#   ② 只取「选中条目里的第一篇」（items[0]）→ 多选时后面的文献全丢；
#   ③ 抓完还要手动逐个勾选 → 不叫「一键」。
ok("fetchReferenceLists" in ri_mod, "26.27 多源参考文献列表入口 fetchReferenceLists 存在")
ok('["s2", () =>' in ri_mod and '["crossref", () =>' in ri_mod
   and '["openalex", () =>' in ri_mod and '["europepmc", () =>' in ri_mod
   and '["pdf", async () =>' in ri_mod,
   "26.28 ★ 参考文献走五通道（S2 / Crossref / OpenAlex / Europe PMC / PDF 段落）")
ok("crossrefReferenceList" in ri_src and "openalexReferenceList" in ri_src
   and "europepmcReferenceList" in ri_src and "s2ReferenceList" in ri_src,
   "26.29 四个取数函数都在 RefSources 里（单一真源）")
ok("referenced_works" in ri_src and "openalex_id:" in ri_src,
   "26.30 OpenAlex 走 referenced_works + openalex_id 批量（2 次请求拿整份参考文献表）")
ok("s2BatchByDois" in ri_src and "S2Client.batch(" in ri_src,
   "26.31 DOI 批量补全走 S2 /paper/batch（参考文献表里只有 DOI 的条目能补出标题作者）")
ok('noTruncate: true' in ri_mod,
   "26.32 ★ PDF 通道传 noTruncate（参考文献段在文末，默认截断会正好切掉它）")
ok(".slice(0, o.maxItems || 8)" in ri_mod or "maxItems" in ri_mod,
   "26.33 ★ 支持**多篇**选中（不再只取 items[0]）")
ok("onImportAll" in ri_dialog_js and 'on("pp-ri-import-all", onImportAll)' in ri_dialog_js,
   "26.34 ★ 对话框有「全部导入」一键入口")
ok("channelText" in ri_dialog_js and "channels: channels" in ri_dialog_js,
   "26.35 抓取时把勾选的来源当通道传下去，并把各源命中数写进状态行")
ok("splitBibliography" in ri_fmt
   and "splitBibliographyEntries" in ri_fmt and "recordsFromBibliographyEntries" in ri_fmt,
   "26.36 参考文献段解析（切段/切条目/成记录）在 RefFormat 里")
ok("titleFromUnstructured" in ri_fmt and "authorsFromReferenceString" in ri_fmt
   and "yearFromReference" in ri_fmt and "_looksLikeAuthors" in ri_fmt,
   "26.37 ★ 一行式题录的标题/作者/年份抽取（无 DOI 的参考文献也能入库）")
ok("refsOnly: true" in ri_src and "SEARCHABLE" in ri_src,
   "26.38 新来源 europepmc/pdf 已注册；PDF 标 refsOnly（不参与联合检索）")
ok("test/ref-import.test.js" in _pf4 and "A2.29" in io.open(os.path.join(ROOT, "test", "ref-import.test.js"), encoding="utf-8").read(),
   "26.39 测试覆盖题录解析（A2.x）与新通道")
ok("resolveItemIdentifiers" in ri_src and "resolveByTitle" in ri_mod,
   "26.40 ★ 条目没记 DOI 时先用标题定位（否则四条通道都没入口）")
ok("diagnosis" in ri_mod and "diagnosisText" in ri_dialog_js,
   "26.41 ★ 抓不到时给出可执行诊断（no_identifier / scanned_pdf / no_bib_section / not_indexed）")

# ---- 26.42~26.50 中文文献路线（GB/T 7714 + 知网） ----
# 真机背景：用户库里大量中文临床指南，S2/Crossref/OpenAlex 基本不收录其参考文献表，
# 且样本 PDF 无文本层（扫描件）。所以必须补两条中文路径：
#   ① 粘贴 GB/T 7714 题录（用户从知网复制的就是这形态）——纯解析，100% 可靠；
#   ② 知网通道——能拿到最全的中文参考文献表，但会走风控，故**默认关闭**。
ok("parseChineseReference" in ri_fmt and "parseGBTSource" in ri_fmt and "gbtTypeCode" in ri_fmt,
   "26.42 ★ GB/T 7714 中文题录解析（[J]/[M]/[D]/[S]/[EB-OL] 类型码 + 卷(期):页）")
ok("GBT_TYPES" in ri_fmt and '"journalArticle"' in ri_fmt and '"thesis"' in ri_fmt,
   "26.43 类型码映射表在（含 thesis/report/webpage）")
ok('id: "cnki"' in ri_src and "cnkiReferenceList" in ri_src and "extractReferencesFromCNKIHTML" in ri_src,
   "26.44 知网参考文献通道已实现")
ok("defaultOff: true" in ri_src and "filter((s) => !s.defaultOff)" in ri_src,
   "26.45 ★ 知网默认关闭（风控：不能让用户莫名其妙被拦）")
ok("CNFetch._searchCNKI" in ri_src and "CNFetch._seedCNKI" in ri_src,
   "26.46 知网通道复用既有 CNFetch 会话/检索（不重复实现）")
ok('"need_verify"' in ri_src and '"need_login"' in ri_src and '"no_hit"' in ri_src,
   "26.47 风控/登录/未命中都显式回报原因")
ok("cnki_verify" in ri_mod and "cnki_login" in ri_dialog_js and "cnki_no_hit" in ri_dialog_js,
   "26.48 ★ 诊断文案指路（去过滑块 / 先登录 / 换粘贴题录）")
ok('"kns.cnki.net": 3000' in ri_src, "26.49 知网限速 3s/次（别把风控招来）")
ok("A4.13" in io.open(os.path.join(ROOT, "test", "ref-import.test.js"), encoding="utf-8").read(),
   "26.50 测试覆盖知网区块抽取与失败原因（A4/A5）")

# ---------- 27. PDF 原位对照翻译（插件 0.34.0） ----------
# 起因：用户要求「在**原版 PDF 的对应位置**按原始排版逐段对照」——不是另开窗口罗列。
# 做法是把每段译文按**原文段落坐标**叠加回 pdf.js 页面。这类改造的静默失败点：
#   ① 装配晚于依赖（PdfText / TranslateSvc）→ ReferenceError，只写一行 boot 日志；
#   ② 依赖 pdf.js 私有坐标契约（自己解析 PDF）→ 版本一变就错位；
#   ③ 缩放/懒加载后不重铺 → 用户滚两页就发现「后面没有译文」，且没人报错；
#   ④ 公式/页码当正文翻 → 原页出现垃圾译文；
#   ⑤ 停止/卸载不清层 → 残留覆盖物，用户关掉插件也去不掉。
PI_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-inline.js")
pi_js = io.open(PI_JS, encoding="utf-8").read() if os.path.exists(PI_JS) else ""

ok(os.path.exists(PI_JS), "27.1 PdfInline 模块存在（features/pdf-inline.js）")
ok('"features/pdf-inline.js"' in mainjs, "27.2 main.js 装配清单含 features/pdf-inline.js")
_mj2 = mainjs.split("\n")


def _mj_line(marker):
    for i, l in enumerate(_mj2):
        if marker in l:
            return i
    return -1


ok(0 <= _mj_line('"ai/pdf-text.js"') < _mj_line('"features/pdf-inline.js"'),
   "27.3 ★ 装配序：PdfInline 在 ai/pdf-text.js 之后（复用 viewerOf/classify 单一真源）")
ok(0 <= _mj_line('"ai/translate.js"') < _mj_line('"features/pdf-inline.js"'),
   "27.4 ★ 装配序：PdfInline 在 ai/translate.js 之后（翻译一律走 TranslateSvc）")
ok("this.pdfInline = PdfInline;" in mainjs, "27.5 main.js 把 PdfInline 挂到 Zotero.PaperPilot")
ok("PdfInline.register(id);" in mainjs, "27.6 main.js 启动时注册（阅读器工具栏按钮）")
ok("PdfInline.unregister();" in mainjs, "27.7 main.js 关闭时注销（摘除注入物）")

# 官方扩展位 + 同步 append（与主题按钮同一纪律）
ok('Zotero.Reader.registerEventListener("renderToolbar"' not in pi_js.split("function register")[1].split("function unregister")[0],
   "27.8 ★ 0.36.0 起不再注入阅读器工具栏（页内形态撤掉，改由 PdfDual 双栏窗口承载）")
ok("attach: start" in pi_js and "extractBlocks, stateMode" in pi_js,
   "27.9 导出 attach/extractBlocks/stateMode 供 PdfDual 右栏复用（内核 API）")

# 坐标来源：pdf.js 已渲染的 textLayer（不自己解析 PDF）+ 复用 PdfText.viewerOf
ok('querySelector(".textLayer")' in pi_js, "27.10 ★ 段落坐标读 pdf.js textLayer（不自造 PDF 解析）")
ok("getBoundingClientRect()" in pi_js, "27.11 用真实 rect 换算页内坐标（与缩放/DPR 解耦）")
ok("PdfText.viewerOf(reader)" in pi_js, "27.12 复用 PdfText.viewerOf 拿 viewer（单一真源）")
ok("PdfText.classify" in pi_js, "27.13 复用 PdfText.classify 分类（公式/图注/垃圾行同一口径）")
ok('b.kind === "formula"' in pi_js and 'if (b.kind === "formula") continue;' in pi_js,
   "27.14 ★ 公式段落不翻译、不叠加（原文原样保留）")

# 懒加载与缩放：事件驱动重铺 + 几何签名判废
ok('eventBus.on("textlayerrendered"' in pi_js and 'eventBus.on("pagerendered"' in pi_js,
   "27.15 ★ 监听 textlayerrendered/pagerendered（懒加载与缩放重建后自动补铺）")
ok("function pageSignature" in pi_js, "27.16 几何签名检测坐标失效（缩放后重铺而非错位）")
ok("function recount" in pi_js, "27.17 计数派生而非累加（重铺不虚高进度）")

# 清理纪律
ok("states.clear();" in pi_js and "btn.remove();" in pi_js,
   "27.18 unregister 摘除按钮与全部 reader 状态（宿主回到原生）")
ok("clearPage(pageEl)" in pi_js, "27.19 每页注入前先清旧层（幂等）")
ok("stop(reader" in pi_js and "markSourceSpans(pageEl, false)" in pi_js,
   "27.20 停止时清层并还原原文标记")

# 入口：菜单 + 工具栏按钮 + 设置面板
menus27 = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "menus.js"), encoding="utf-8").read()
ok('id: "pdf-inline"' not in menus27, "27.21 菜单里已无 pdf-inline 页内入口（0.36.0 撤掉）")
ok("PdfInline.startForSelected" not in menus27, "27.22 菜单不再指向页内叠加")
ok("menuPdfInline" in utils_js, "27.23 文案表含 menuPdfInline")
ok("paperpilot-inline-reader-button" in pi_js, "27.24 阅读器工具栏按钮 id 固定（供清理与测试定位）")

for _k in ["pdfInlineMode", "pdfInlineFontScale", "pdfInlineSelectable", "pdfInlineGapMs"]:
    ok(("paperpilot.%s" % _k) in prefsdef, "27.25 prefs.js 含 %s 默认值" % _k)
# 0.36.0：设置面板暴露的是「左原右译」的四项（pp-pd-*）；内核 pref 不再直接暴露
for _id in ["pp-pd-rightmode", "pp-pd-scale", "pp-pd-sync", "pp-pd-zoom"]:
    ok(_id in xhtml_ids, "27.26 prefs.xhtml 含 #%s" % _id)
_pi_used = set(re.findall(r'\$\("(pp-pd-[A-Za-z0-9_-]+)"\)', trp_js))
ok(_pi_used, "27.27 prefs-translate.js 接线对照翻译设置（%s）" % (", ".join(sorted(_pi_used)) or "无"))
ok("pdfInline" in trp_js and "piRefresh" in trp_js, "27.28 设置改动即时 refresh 已打开的阅读器")

# 纪律：不直连网络/AI（翻译一律经 TranslateSvc）
pi_code = re.sub(r"/\*[\s\S]*?\*/", "", pi_js)
pi_code = re.sub(r"(?m)//.*$", "", pi_code)
ok(not re.search(r"Zotero\.HTTP|fetch\s*\(", pi_code),
   "27.29 不直连网络（去掉注释后无 Zotero.HTTP/fetch）")
ok("TranslateSvc.translate(" in pi_js, "27.30 翻译走 TranslateSvc（多引擎 + 回退 + 术语表）")
ok("pdf-inline.test.js" in _pf3, "27.31 preflight 含原位对照翻译测试")
ok("pdfInlineSelfTest" in prefsdef and "pdfInline selfTest:" in mainjs,
   "27.32 自检开关（真实 PDF 上验段落抽取与卡片落点）")


# ---------- 28. PDF 对照翻译 · 左原右译双栏窗口（插件 0.36.0） ----------
# 起因：用户要的是「左栏原版 PDF / 右栏同一页译文」的双栏对照（PDF2zh 那种形态），
# 而不是阅读器内的整页叠加。右栏用**同一个 PDF** 的第二个预览 + 内核的 mono 模式
# （译文按原文段落坐标替换文字、图表与公式图形保留）⇒ 版面/分页天然一致。
# 这类改造的静默失败点：
#   ① 窗口脚本直连 AIClient/TranslateSvc（作用域里根本没有）→ 翻译永远不动；
#   ② 预览就绪判据写错（只看 readyState）→ about:blank 被当就绪，右栏空白且不报错；
#   ③ `reader._open()` 吞异常返回 false 而不判返回值 → 失败与空白无法区分；
#   ④ 同步滚动的「布尔 guard + rAF」在窗口被遮挡时永久卡死（compare.js 实踩）；
#   ⑤ 预览 scrollMode 落到 3（单页）→ 两栏都不能滚，用户只看到第一页。
PD_MOD = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-dual.js")
PD_XHTML = os.path.join(ROOT, "chrome", "content", "pdf-dual.xhtml")
PD_VIEW = os.path.join(ROOT, "chrome", "content", "pdf-dual-view.js")
pd_mod = io.open(PD_MOD, encoding="utf-8").read() if os.path.exists(PD_MOD) else ""
pd_xhtml = io.open(PD_XHTML, encoding="utf-8").read() if os.path.exists(PD_XHTML) else ""
pd_view = io.open(PD_VIEW, encoding="utf-8").read() if os.path.exists(PD_VIEW) else ""

ok(os.path.exists(PD_MOD) and os.path.exists(PD_XHTML) and os.path.exists(PD_VIEW),
   "28.1 三件套齐全（pdf-dual.js / pdf-dual.xhtml / pdf-dual-view.js）")
ok('"features/pdf-dual.js"' in mainjs, "28.2 main.js 装配清单含 features/pdf-dual.js")
_mj3 = mainjs.split("\n")


def _mj3_line(marker):
    for i, l in enumerate(_mj3):
        if marker in l:
            return i
    return -1


ok(0 <= _mj3_line('"features/pdf-inline.js"') < _mj3_line('"features/pdf-dual.js"'),
   "28.3 ★ 装配序：PdfDual 在内核 pdf-inline.js 之后（右栏复用其 attach）")
ok("this.pdfDual = PdfDual;" in mainjs, "28.4 main.js 把 PdfDual 挂到 Zotero.PaperPilot")
ok("this.pdfDual.selfTest(undefined, att)" in mainjs and "pdfDualSelfTest" in prefsdef,
   "28.5 自检开关（真实 PDF 上验左右 pane 挂载与右栏落卡；可指定附件排障）")

# 窗口骨架与元素守卫
ok('windowtype="paperpilot:pdf-dual"' in pd_xhtml, "28.6 窗口 windowtype=paperpilot:pdf-dual")
ok("chrome://paperpilot/content/pdf-dual-view.js" in pd_xhtml, "28.7 窗口挂了窗口脚本")
ok('id="pp-pd-left-browser"' in pd_xhtml and 'id="pp-pd-right-browser"' in pd_xhtml,
   "28.8 ★ 左右各一个 reader browser（左原版 / 右译文）")
ok('class="reader"' in pd_xhtml and "<splitter" in pd_xhtml,
   "28.9 browser 用宿主 reader 类 + 分隔条（可拖拽分栏）")
_pd_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', pd_xhtml))
_pd_refs = set(re.findall(r'\$\(\s*"([A-Za-z0-9_-]+)"\s*\)', pd_view))
_pd_missing = sorted(i for i in _pd_refs if i not in _pd_ids)
ok(not _pd_missing, "28.10 窗口脚本引用的元素 id 都存在于 pdf-dual.xhtml → 缺失: %s" % (_pd_missing or "无"))

# 窗口脚本纪律：不直连 AI/网络，翻译经注入回调
pd_code = re.sub(r"/\*[\s\S]*?\*/", "", pd_view)
pd_code = re.sub(r"(?m)//.*$", "", pd_code)
ok(not re.search(r"AIClient\s*\.|\bAIChat\b|TranslateSvc\s*\.|Zotero\.HTTP|fetch\s*\(", pd_code),
   "28.11 ★ 窗口脚本不直连 AI/翻译/网络（一律回插件作用域）")
for _cb in ["A.onPanesReady(", "A.exportNote(", "A.setFontScale(", "A.retranslate(", "A.onUnload("]:
    ok(_cb in pd_view, "28.12 窗口经注入回调调用 %s" % _cb)
for _cb in ["onPanesReady:", "exportNote:", "setFontScale:", "retranslate:", "onUnload:"]:
    ok(_cb in pd_mod, "28.13 模块侧注入 %s" % _cb)

# 复用内核：右栏 = 同一 PDF 的 mono 译文视图
ok("PdfInline.attach(" in pd_mod, "28.14 ★ 右栏复用内核 PdfInline.attach（不重造提取/翻译）")
ok("mode: this._rightMode()" in pd_mod and '"mono"' in pd_mod,
   "28.15 右栏默认 mono（译文替换原文文字、图表与公式保留）")
ok("PdfInline._textCache" in pd_mod and "PdfInline.refresh()" in pd_mod,
   "28.16 重新翻译 = 清内核缓存 + 重铺")
ok("BilingualTranslate._noteMd(" in pd_mod, "28.17 导出笔记复用 _noteMd（格式零漂移）")

# 预览挂载的三条硬约束（compare.js 结论）
ok("typeof uw.createReader === \"function\"" in pd_view,
   "28.18 ★ 就绪判据 = createReader 是函数（不看 readyState，about:blank 会骗人）")
ok("opened === false" in pd_view, "28.19 ★ 判 reader._open() 返回值（它吞异常后 return false）")
ok("scrollMode = 0" in pd_view and "overflow:auto !important" in pd_view,
   "28.20 ★ 强制连续垂直（scrollMode=0）+ 解禁 #viewerContainer 的 overflow")

# 同步滚动：页 + 页内比例 + 待吞计数（禁用布尔 guard + rAF）
ok("function currentPosition" in pd_view and "function gotoPosition" in pd_view,
   "28.21 同步滚动按「页号 + 页内比例」定位（几何二分）")
ok("pendingLeft" in pd_view and "pendingRight" in pd_view and "SYNC_GUARD_MS" in pd_view,
   "28.22 ★ 待吞计数 guard + 兜底清零（不用布尔+rAF：窗口被遮挡时会永久卡死）")
ok('addEventListener("scroll"' in pd_view, "28.23 两栏滚动双向联动")

# 入口接线（四处）
ok("PdfDual.openForSelected" in menus_js, "28.24 右键菜单指向 PdfDual")
ok("pdfDual.openForSelected" in wb_js, "28.25 工作台 chip 指向 PdfDual")
ok("pdfDual.openForSelected" in hub_js, "28.26 功能中心卡片指向 PdfDual")
pane_js2 = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "panels", "translate-pane.js"),
                   encoding="utf-8").read()
ok("pdfDual.openForItem(" in pane_js2, "28.27 阅读器侧栏翻译面板指向 PdfDual")
ok("WINDOW_TYPE: \"paperpilot:pdf-dual\"" in pd_mod and "getEnumerator(this.WINDOW_TYPE)" in pd_mod,
   "28.28 单实例复用（按常量枚举，名字不会写歪）")

# pref 默认值与设置面板
for _k in ["pdfDualSyncScroll", "pdfDualSyncZoom", "pdfDualRightMode", "pdfDualSelfTest"]:
    ok(("paperpilot.%s" % _k) in prefsdef, "28.29 prefs.js 含 %s 默认值" % _k)
_utils_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "core", "utils.js"),
                     encoding="utf-8").read()
ok("menuPdfDual" in _utils_src and "pdSync" in _utils_src,
   "28.31 文案表含 menuPdfDual 与窗口文案键（pd*）")
ok("pdf-dual.test.js" in _pf3, "28.32 preflight 含左原右译窗口测试")

# ---- 0.37.0：整篇翻译（逐页滚动触发渲染）+ 就绪信号 ----
ok("translateAll" in pi_js and "viewer.currentPageNumber = i" in pi_js,
   "28.33 ★ 整篇翻译靠**逐页滚动**触发 pdf.js 渲染（PDFPageView 的渲染入口全是私有的，只能滚）")
ok("out.skipped++" in pi_js, "28.34 无文本层的页被跳过并计数（不自欺为「已翻译」）")
ok("container.scrollTop = keep" in pi_js, "28.35 结束后滚回原位（不打扰用户当前阅读位置）")
ok("translateAll: () => this.translateAll()" in pd_mod and "async translateAll(opts)" in pd_mod,
   "28.36 窗口「翻译全文」按钮经回调走插件侧（窗口不直连内核）")
ok("PdfInline.translateAll(" in pd_mod, "28.37 PdfDual 转发到内核 translateAll（翻译全文）")
ok('id="pp-pd-all"' in pd_xhtml and 'pp-pd-all' in pd_view,
   "28.38 工具栏「翻译全文」按钮存在且已接线")
ok("window.ppDualPhase" in pd_view, "28.39 页级进度回调（第 X/Y 页 + 累计段数）")
ok("window.ppDualReady" in pd_view, "28.40 ★ 就绪信号：挂载完成**且**初始化跑完（只看 mounted 会假就绪）")
ok("ppDualReady" in io.open(os.path.join(ROOT, "test", "pdf-dual.test.js"), encoding="utf-8").read(),
   "28.41 窗口测试等的是就绪信号（不是只等 mounted）")
ok("translateAll" in io.open(os.path.join(ROOT, "test", "pdf-inline.test.js"),
                             encoding="utf-8").read(),
   "28.42 内核测试覆盖整篇翻译（遍历/跳过页/滚动复位/卡片落地）")


# ---------- 29. 更新提示（插件 0.37.1） ----------
# 起因：用户报「没有接收到版本更新」——实测更新通道完全正常（把 profile 降回 0.36.0，
# 启动 150 秒后 Zotero 自动替换成 0.37.0），真正的问题是 Zotero 对第三方插件的更新是
# **静默后台替换**，不给任何提示，用户感知不到。本模块补这个反馈。
# 静默失败点：① 本机已是最新还弹窗 = 纯骚扰；② 同一版本每次启动都弹 = 用户想卸载；
# ③ 断网时弹错误窗 = 比不提示更糟；④ 关掉开关还偷偷联网。
UN_MOD = os.path.join(ROOT, "chrome", "content", "scripts", "features", "update-notice.js")
un_js = io.open(UN_MOD, encoding="utf-8").read() if os.path.exists(UN_MOD) else ""

ok(os.path.exists(UN_MOD), "29.1 UpdateNotice 模块存在")
ok('"features/update-notice.js"' in mainjs, "29.2 main.js 装配清单含 features/update-notice.js")
ok("UpdateNotice.register(id, version," in mainjs, "29.3 启动时排程检查（带当前版本与结果回调）")
ok("UpdateNotice.unregister();" in mainjs, "29.4 关闭时清掉定时器")
ok("function compareVersion" in un_js or "compareVersion(a, b)" in un_js,
   "29.5 版本比较是纯函数（可单测）")
ok("function latestVersion" in un_js or "latestVersion(json)" in un_js,
   "29.6 清单取最新版本是纯函数")
# 与 manifest 的 update_url 完全一致（两处漂移 = 检查错地址，且很难发现）
_mf_url_hit = re.search(r'"update_url"\s*:\s*"([^"]+)"', MANIFEST)
_mf_url = _mf_url_hit.group(1) if _mf_url_hit else ""
ok('UPDATE_URL: "%s"' % _mf_url in un_js,
   "29.7 ★ 模块 UPDATE_URL 与 manifest 的 update_url 完全一致")
ok("updateNoticeLastVersion" in un_js, "29.8 记录已提示版本（同一版本只提示一次）")
ok('out.skipped = "already-notified"' in un_js, "29.9 ★ 已提示过则静默")
ok('out.skipped = "up-to-date"' in un_js, "29.10 ★ 已是最新则静默（不骚扰）")
ok('out.skipped = "disabled"' in un_js, "29.11 开关关掉直接跳过")
ok("catch (e)" in un_js and "network: " in un_js, "29.12 ★ 网络异常静默（不弹错误窗）")
ok("ProgressWindow" in un_js, "29.13 用 Zotero 原生通知（与插件其它提示一致）")
ok("updateNoticeEnabled" in prefsdef,
   "29.14 prefs.js 含 updateNoticeEnabled 默认值")
ok("update-notice.test.js" in _pf3, "29.15 preflight 含更新提示测试")
# 0.44.1：更新内容展示（用户报「以前能看到更新了哪些内容」）
ok("updateNoticeLastSeen" in un_js and "updateNoticeLastSeen" in prefsdef,
   "29.16 ★ 记录「上次运行版本」pref（静默更新完成后的“已更新到”提示）")
ok("entryOf" in un_js and "whatsNewOf" in un_js and "_notifyUpdated" in un_js,
   "29.17 ★ whatsNew 摘要解析与更新完成提示（纯函数可单测）")
ok("本次更新内容" in un_js, "29.18 更新完成提示展示「本次更新内容」摘要")


# ---------- 30. XHTML 的 XML 合法性（插件 0.37.2） ----------
# 起因：prefs.xhtml 里一个 `&nbsp;`（XML 只预定义 amp/lt/gt/quot/apos）导致**整个设置面板
# 解析失败 → 面板空白**，而且日志里没有任何提示，用户只能报「设置界面不显示插件设置」。
# 这类错误必须在构建期挡住：这里对每个 xhtml 做「XML 可解析 + 无未定义实体」双检，
# 并在 main.js 侧要求注册面板前预解析一次（失败写 boot 日志），把静默故障变可见。
_XHTML_DIR = os.path.join(ROOT, "chrome", "content")
_xhtml_files = sorted(f for f in os.listdir(_XHTML_DIR) if f.endswith(".xhtml"))
ok(len(_xhtml_files) >= 15, "30.1 找到 %d 个 xhtml 窗口文件" % len(_xhtml_files))
_bad_xml = []
_bad_ent = []
_ALLOWED_ENT = {"amp", "lt", "gt", "quot", "apos"}
for _f in _xhtml_files:
    _p = os.path.join(_XHTML_DIR, _f)
    _src = io.open(_p, encoding="utf-8").read()
    try:
        import xml.etree.ElementTree as _ET
        _ET.fromstring(_src)
    except Exception as _e:
        _bad_xml.append("%s: %s" % (_f, _e))
    for _i, _line in enumerate(_src.split("\n"), 1):
        for _m in re.finditer(r"&([a-zA-Z][a-zA-Z0-9]*);", _line):
            if _m.group(1) not in _ALLOWED_ENT:
                _bad_ent.append("%s:%d %s" % (_f, _i, _m.group(0)))
ok(not _bad_xml, "30.2 ★ 所有 xhtml 都能被 XML 解析 → %s" % (_bad_xml or "全部通过"))
ok(not _bad_ent, "30.3 ★ 无未定义实体（&nbsp; 在 XML 里非法，会让整个面板空白）→ %s"
   % (_bad_ent or "无"))
ok("prefs.xhtml" in " ".join(_xhtml_files) and "&nbsp;" not in
   io.open(os.path.join(_XHTML_DIR, "prefs.xhtml"), encoding="utf-8").read(),
   "30.4 设置面板 prefs.xhtml 无 &nbsp;（曾因此整面板空白）")
ok('&html:label class="pp-label">&#160;<' in io.open(
    os.path.join(_XHTML_DIR, "prefs.xhtml"), encoding="utf-8").read()
   or "&#160;" in io.open(os.path.join(_XHTML_DIR, "prefs.xhtml"), encoding="utf-8").read(),
   "30.5 占位空白用数字实体 &#160;（XML 合法）")
ok("prefs.xhtml 有 XML 未定义实体" in mainjs and "prefs.xhtml ok（" in mainjs,
   "30.6 ★ 启动时自查 prefs.xhtml（零依赖实体扫描，不用 DOMParser），异常写 boot 日志")
ok("new DOMParser()" not in mainjs,
   "30.7 不用 DOMParser（bootstrap 作用域实测不可用，会让自查本身静默失败）")

# ---------- 31. 0.38.0 设置面板折叠分组 ----------
# 设计约束：折叠只切 .pp-fold-closed 类，卡片内 DOM / 元素 id / preference= 绑定一律
# 原样保留——所以这里的守卫盯三件事：脚本注册了、工具条与分组键齐了、默认值声明了。
PFOLD_JS = os.path.join(ROOT, "chrome", "content", "prefs-fold.js")
ok(os.path.exists(PFOLD_JS), "31.1 prefs-fold.js 存在")
_pfold_js = io.open(PFOLD_JS, encoding="utf-8").read() if os.path.exists(PFOLD_JS) else ""
ok("prefs-fold.js" in mainjs, "31.2 main.js 注册 prefs-fold.js（scripts 列表）")
for _eid in ("pp-fold-expand", "pp-fold-collapse"):
    ok(_eid in xhtml_ids, "31.3 prefs.xhtml 含折叠工具条 #%s" % _eid)
_FOLD_KEYS = ["account", "cnki", "thirdsrc", "channels", "translate", "aiparams", "popup",
              "columns", "tagging", "enhance", "uitheme", "pdftheme", "menu", "hotkeys"]
_fold_found = re.findall(r'data-fold="([a-z]+)"', prefs_xhtml)
ok(sorted(_fold_found) == sorted(_FOLD_KEYS),
   "31.4 prefs.xhtml 的 14 个折叠分组键齐全（0.44.0 实验 +第三方文献源）→ 实际: %s" % ",".join(sorted(set(_fold_found))))
ok(prefs_xhtml.count('class="pp-card pp-fold"') == 14,
   "31.5 折叠卡片共 14 张（0.44.0 实验 +第三方文献源；不多不少，防止漏包一张）")
ok('pref("extensions.zotero.paperpilot.prefsFoldOpen", "");' in prefsdef,
   "31.6 prefs.js 有 prefsFoldOpen 默认值（空 = 全收起）")
ok("prefsFoldOpen" in _pfold_js and "pp-fold-closed" in _pfold_js,
   "31.7 prefs-fold.js 读写 prefsFoldOpen 并切换 pp-fold-closed")
ok(".pp-fold-closed .pp-card-body { display: none; }" in prefs_css,
   "31.8 prefs.css 收起态隐藏卡片体")
# 深链：reader-popup 打开设置前放 _prefsFocus，prefs-fold.js 消费后清掉
_rp_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts",
                               "features", "reader-popup.js"), encoding="utf-8").read()
ok("_prefsFocus" in _rp_src and "_prefsFocus" in _pfold_js,
   "31.9 深链定位接线：reader-popup 写 _prefsFocus → prefs-fold.js 消费")

# ---------- 32. 0.38.0 主题按钮冒泡修复 + 顶部快捷按钮 ----------
# 主题按钮「点得开但子菜单进不去」的根因：XUL popup 事件与 menuitem command 都会冒泡。
# 守卫盯两处模块的 ev.target 防御（Zotero 自身 menuManager.js 同款写法）。
_tt_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts",
                               "features", "theme-toggle.js"), encoding="utf-8").read()
ok("if (ev.target !== popup) return" in _tt_src,
   "32.1 ★ theme-toggle popup 事件带 ev.target 冒泡守卫（子菜单悬停不再触发整菜单重建）")
ok("if (ev.target !== btn) return" in _tt_src,
   "32.2 ★ theme-toggle 按钮 command 带 ev.target 冒泡守卫（选完主题菜单正常关闭）")
TQ_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "toolbar-quick.js")
ok(os.path.exists(TQ_JS), "32.3 toolbar-quick.js 存在")
_tq_js = io.open(TQ_JS, encoding="utf-8").read() if os.path.exists(TQ_JS) else ""
ok("toolbar-quick.js" in mainjs, "32.4 main.js 注册 toolbar-quick.js（scripts 列表）")
ok("ToolbarQuick.register()" in mainjs and "ToolbarQuick.unregister()" in mainjs,
   "32.5 main.js 挂 ToolbarQuick 生命周期（register/unregister）")
ok('pref("extensions.zotero.paperpilot.quickBarButtonEnabled", true);' in prefsdef,
   "32.6 prefs.js 有 quickBarButtonEnabled 默认值")
ok("quickBarButtonEnabled" in mainjs and "ToolbarQuick.syncEnabled" in mainjs,
   "32.7 pref 观察者接线：quickBarButtonEnabled → ToolbarQuick.syncEnabled")
ok("if (ev.target !== popup) return" in _tq_js and "if (ev.target !== btn) return" in _tq_js,
   "32.8 ★ toolbar-quick 同款双冒泡守卫（新代码不吃同一个坑）")
ok("zotero-items-toolbar" in _tq_js,
   "32.9 toolbar-quick 锚定 #zotero-items-toolbar（顶部条目工具栏）")
ok("_quickItems" in _tq_js,
   "32.10 ★ 快捷菜单直达项与右键菜单共用 Menus._quickItems（单一真源，不维护第二份列表）")
ok("quickBarButtonEnabled" in prefs_xhtml,
   "32.11 prefs.xhtml 有快捷按钮开关（增强功能卡）")

# ---------- 35. 0.38.0 提示词深度优化 + 快捷按钮图标 ----------
# 图标：48px icon.png 会按原始尺寸撑大 28px 工具栏按钮 → 换 16px 单色 quick.svg
QUICK_SVG = os.path.join(ROOT, "chrome", "content", "icons", "quick.svg")
ok(os.path.exists(QUICK_SVG), "35.1 icons/quick.svg 存在")
if os.path.exists(QUICK_SVG):
    _qsvg = io.open(QUICK_SVG, encoding="utf-8").read()
    ok('width="16" height="16"' in _qsvg and "context-fill" in _qsvg,
       "35.2 quick.svg 是 16px context-fill 单色图标（与 theme.svg 同规格）")
ok('icons/quick.svg")' in _tq_js and 'icons/icon.png")' not in _tq_js,
   "35.3 toolbar-quick 引用 quick.svg（listStyleImage 不再用 48px icon.png）")
# 提示词：根系统提示词的纪律条款 + 各任务提示词的证据要求
ok("绝不编造" in prefsdef and "注明位置" in prefsdef,
   "35.4 aiSystemPrompt 默认值含反编造与注明出处纪律")
ok('"你是一位严谨的学术研究助手' in prefsdef and "回答纪律：" in prefsdef,
   "35.5 aiSystemPrompt 是「人设+纪律」结构（非一句话人设）")
PROMPTS_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "prompts.js")
_prompts_js = io.open(PROMPTS_JS, encoding="utf-8").read()
ok(_prompts_js.count('name: "') == 7,
   "35.6 技能库内置恰 7 个（chat-float 快捷标签取前 8，防被截断）")
ok("方法深挖" in _prompts_js and "下一步研究" in _prompts_js,
   "35.6b 新技能「方法深挖」「下一步研究」在库")
CHAT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "chat.js")
_chat_js = io.open(CHAT_JS, encoding="utf-8").read()
ok("研究问题" in _chat_js and "结论与边界" in _chat_js and "只写论文里有的内容" in _chat_js,
   "35.7 summarize 四要素结构化（问题/方法/结果/边界）+ 不补写纪律")
TR_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "translate.js")
_tr_js = io.open(TR_JS, encoding="utf-8").read()
ok("术语表（以下术语必须按给定译法翻译" in _tr_js and "上一段的译文" in _tr_js,
   "35.8 translate.js 术语表与上下文注入未随优化丢失")
RP_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "reader-popup.js")
_rp2 = io.open(RP_JS, encoding="utf-8").read()
ok("禁止使用任何 Markdown 标记" in _rp2,
   "35.9 划词浮窗纯文本禁令仍在（防 Markdown 标记泄漏到浮窗）")
ok("论证中的作用" in _rp2,
   "35.10 浮窗解读两段式（在讲什么 + 论证作用）")


# ---------- 33. 对照翻译导出（0.39.0：双语 PDF 附件 / HTML / Markdown / Word） ----------

PE_JS = os.path.join(ROOT, "chrome", "content", "scripts", "features", "pdf-export.js")
ok(os.path.exists(PE_JS), "33.1 pdf-export.js 存在")
_pe_js = io.open(PE_JS, encoding="utf-8").read() if os.path.exists(PE_JS) else ""
_pe_test = os.path.join(TEST_DIR, "pdf-export.test.js")
ok("pdf-export.js" in mainjs, "33.2 main.js 注册 pdf-export.js")
ok(mainjs.find('"features/pdf-inline.js"') < mainjs.find('"features/pdf-export.js"'),
   "33.3 ★ 装配序：导出模块在内核 pdf-inline.js 之后（要读它的 state）")
ok("PdfExport.exportAs" in pd_mod, "33.4 pdf-dual 经 PdfExport.exportAs 导出（不在窗口里塞业务）")
ok("exportAs: (kind) => this.exportAs(kind, item, title)" in pd_mod,
   "33.5 ★ 载荷把 exportAs 注入窗口（窗口不直连 PdfExport/附件 API）")
ok('id="pp-pd-export"' in pd_xhtml and "<menulist" in pd_xhtml,
   "33.6 窗口工具栏有导出菜单（menulist，与 compare 窗口同款）")
for _v in ["pdf", "html", "md", "docx"]:
    ok('value="%s"' % _v in pd_xhtml, "33.7 导出菜单含 %s 项" % _v)
ok("window.ppDualExport" in pd_view, "33.8 窗口导出入口 window.ppDualExport(kind)")
ok('exp.addEventListener("command", onExportPick)' in pd_view,
   "33.8b ★ 导出菜单绑 command（XUL menulist 事件名——0.39/0.40 只绑 change，真机点了没反应）")
ok('exp.addEventListener("change", onExportPick)' in pd_view,
   "33.8c 同时兜住 change（双绑且靠清空 value 幂等）")
ok("A.exportAs(kind)" in pd_view, "33.9 窗口导出经注入回调回插件作用域")
ok("setLabelAndText" in pd_view and 'opt("pp-pd-exp-pdf"' in pd_view,
   "33.10 ★ 菜单项文案走文案表（中英双语，不硬编码）")
ok("buildImagePdf" in _pe_js and "/DCTDecode" in _pe_js,
   "33.11 ★ 零依赖自建 PDF：JPEG 以 /DCTDecode 内嵌（不引 npm 包，守零依赖约束）")
ok("Zotero.Attachments.importFromFile" in _pe_js,
   "33.12 ★ 双语 PDF 走 importFromFile 挂到条目下（与补全文同一条通道）")
ok("Zotero.File.zipDirectory(" not in _pe_js and "nsIZipWriter" in _pe_js,
   "33.13 ★ docx 自建 zip（不用 zipDirectory —— 它跳过点文件，会漏掉 OOXML 必需的 _rels/.rels）")
ok("\"_rels/.rels\"" in _pe_js and "addEntryFile" in _pe_js,
   "33.13b ★_rels/.rels 在部件表里 + addEntryFile 显式条目名（点文件能进包）")
ok("[Content_Types].xml" in _pe_js and "word/document.xml" in _pe_js,
   "33.14 docx 部件齐全（content-types / rels / document）")
ok("modeSave" in _pe_js and "fp.open(" in _pe_js, "33.15 文本类导出用文件选择器保存（含取消路径）")
ok(os.path.exists(_pe_test), "33.16 导出单测存在（test/pdf-export.test.js）")
ok("buildImagePdf" in (io.open(_pe_test, encoding="utf-8").read() if os.path.exists(_pe_test) else ""),
   "33.17 ★ 单测覆盖 PDF 生成器（xref / 流长度 / 流式偏移结构自校验）")

# ---------- 34. 期刊分区列：内置 Key 的套餐门控（插件 0.41.0） ----------
# 内置 easyScholar SecretKey 由运营者持有、消耗运营者配额。0.41.0 起改为
# 「自带 Key 永远优先；已登录的 Pro / 试用期可用内置 Key；免费版与未登录须自带」。
# 这里钉死三件事：判定同时看登录态与套餐、探测不到时放行、以及**内置 Key 不被绕过**。
_rk_js = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "columns", "rank-column.js"),
                 encoding="utf-8").read()
ok("_officialKeyAllowed" in _rk_js, "34.1 分区列有内置 Key 的资格判定 _officialKeyAllowed()")
ok("Account.isLoggedIn" in _rk_js and "Account.isPro" in _rk_js,
   "34.2 ★ 门控同时看「已登录」与「专业版」（未登录不能白拿内置 Key）")
ok('reason === "trial"' in _rk_js, "34.3 新用户试用期可用内置 Key")
ok('reason === "unknown"' in _rk_js,
   "34.4 ★ 旧服务端 / 探测不到 ⇒ 放行，不惩罚老用户（同模型分级纪律）")
ok("esStatus" in _rk_js, "34.5 提供 esStatus() 供设置页给出可执行指引")
_rek_refs = _rk_js.count("ES_OFFICIAL_KEY")
ok(_rek_refs == 2,
   "34.6 ★ 内置 Key 仅 2 处引用（常量定义 + esKey），别处直接引用＝绕过门控（实际 %d 处）" % _rek_refs)
ok("esStatus" in io.open(os.path.join(ROOT, "chrome", "content", "prefs-pane.js"),
                         encoding="utf-8").read(),
   "34.7 设置页状态行展示门控状态（免费版不会只看到空白以为坏了）")
ok(os.path.exists(os.path.join(ROOT, "test", "rank-gate.test.js")),
   "34.8 门控单测存在（test/rank-gate.test.js）")

# ---------- 35. 中文文献 AI 增强四层（插件 0.42.0，P1-P3） ----------
# jasminum 分析落地（docs/jasminum-cnki-analysis-and-ai-proposal.md）：
#   L1 检索词规划 / L3 语义裁决 / L4 元数据融合（GetExport 双通道）/ P3 兜底与自愈。
# 核心纪律：协议层（签名/Cookie/检索参数）确定性代码，LLM 不碰；
# AI 全部输出过 JSON 校验 + 字段白名单，兜底识别恒带 unverified 标记。
_cn_ai = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "cn-ai.js"),
                 encoding="utf-8").read()
_cn_f = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "features", "cn-fetch.js"),
                encoding="utf-8").read()
ok("fallbackPlan" in _cn_ai and "parsePlan" in _cn_ai and "buildPlannerMessages" in _cn_ai,
   "35.1 L1 规划三件套（提示词/解析/启发式回退）在 CNAI 里")
ok("parseJudgment" in _cn_ai and "decide" in _cn_ai and '"reject"' in _cn_ai,
   "35.2 L3 裁决置信度分档（auto/confirm/reject/manual）在 CNAI 里")
ok("fuseMeta" in _cn_ai and "数据库为准" in _cn_ai,
   "35.3 L4 融合在 CNAI 里且注释钉死「数据库为准」纪律")
ok("parseRecognized" in _cn_ai and "_unverified: true" in _cn_ai,
   "35.4 ★ P3 兜底识别恒带 unverified 标记（未与数据库核对不得静默入库）")
ok("parseRescueResults" in _cn_ai and "CNKI-LLM" in _cn_ai,
   "35.5 P3 自愈解析在（来源标 CNKI-LLM 便于审计）")
ok("_renderPagesPNG" in _cn_ai and "pdf-render-worker.js" in _cn_ai,
   "35.6 视觉路径渲染走随包 worker（chrome://paperpilot/content/scripts/pdf-render-worker.js）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "scripts", "pdf-render-worker.js")),
   "35.7 pdf-render-worker.js 已随包（视觉路径缺它即静默 null）")
ok('cnFetchAIVision", false' in prefsdef,
   "35.8 ★ 视觉路径 pref 默认关（实验特性，先灰度）")
ok('cnFetchAI", true' in prefsdef and 'cnFetchAIJudge", true' in prefsdef
   and 'cnFetchCNKIExport", true' in prefsdef,
   "35.9 AI 增强三开关 pref 默认值在 prefs.js")
_mj_cn_ai = mainjs.find("features/cn-ai.js")
_mj_cn_fetch = mainjs.find("features/cn-fetch.js")
ok(_mj_cn_ai > 0 and 0 < _mj_cn_ai < _mj_cn_fetch,
   "35.10 ★ main.js 中 cn-ai.js 必须排在 cn-fetch.js 之前（cn-fetch 消费 CNAI）")
ok("_getExportEndNote" in _cn_f and "_parseEndNote" in _cn_f
   and "dm8/API/GetExport" in _cn_f,
   "35.11 P2 GetExport 双通道（导出接口反爬弱于详情页，是兜底也是补全）")
ok("CNAI.fuseMeta(dbMeta, pick, plan)" in _cn_f,
   "35.12 融合顺序 = EndNote 权威 > 搜索结果 > AI 规划（只填空）")
ok("structureChanged" in _cn_f and "CNAI.rescue" in _cn_f,
   "35.13 CNKI 结构改版 → rescue 自愈接线在 _fetchForItem 里")
ok("pdfDown1" in _cn_f and "oversea.cnki.net" in _cn_f,
   "35.14 PDF 直链兼容 oversea #pdfDown 锚点")
ok("CNAI.judge" in _cn_f and "cnAIAutoThreshold" in _cn_f and "cnAIConfirmThreshold" in _cn_f,
   "35.15 L3 裁决接入 _fetchForItem 且阈值走 pref")
ok("CNAI.recognize(item)" in _cn_f and "AI-recognized, unverified" in _cn_f,
   "35.16 ★ 检索全灭 → AI 兜底 + extra 写 unverified 标记")
_pf5 = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/cn-ai.test.js" in _pf5, "35.17 preflight 含中文文献 AI 增强测试")
ok(os.path.exists(os.path.join(ROOT, "test", "cn-ai.test.js")),
   "35.18 cn-ai 单测存在（test/cn-ai.test.js）")

# ---------- 0.43.0 知网账号登录（CNAuth）与反爬基础 ----------
ok("var CNAuth" in _cn_f and "loginSilent" in _cn_f and "loginInteractive" in _cn_f,
   "36.1 CNAuth 模块在 cn-fetch.js（静默 + 交互双通道）")
ok("TopLoginCore/api/LoginApi/LoginPo" in _cn_f and "SM2_PUBKEY" in _cn_f
   and "t8b52yrsoyx66f35tk0p4nubrmrcglv5" in _cn_f and '"appID": "LoginWap"' in _cn_f,
   "36.2 ★ 登录协议三要素齐全（LoginPo 端点 / SM2 公钥 / 签名密钥与 appID）")
ok("cnkiUsername" in prefsdef and 'cnkiPassword", ""' in prefsdef,
   "36.3 ★ 凭据 pref 默认空值（凭据只进本机 profile，绝不进 git）")
ok("parseLoginCookie" in _cn_f and "parseLoginStatus" in _cn_f
   and "Ecp_LoginStuts" in _cn_f and "c_m_Lin" in _cn_f,
   "36.4 登录态判定走 cookie（Ecp_LoginStuts 主 + c_m_Lin 兜底，纯函数可离线测）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "scripts", "vendor", "sm2.js")),
   "36.5 vendor/sm2.js 存在（sm-crypto UMD，与知网官方登录页同款库）")
_sm2f = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "vendor", "sm2.js"),
                encoding="utf-8").read()
ok("doEncrypt" in _sm2f and "exports.sm2" in _sm2f,
   "36.6 vendor sm2 是 UMD 打包且含 doEncrypt（loadSubScript 式 scope 可挂载）")
ok('UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0)' in _cn_f
   and "MIN_INTERVAL_MS: 3000" in _cn_f and "_cnkiHeaders" in _cn_f,
   "36.7 ★ CNKI 全链路桌面 UA + kns 3s 限速（Zotero 默认 UA 会被 WAF 一眼识破）")
ok("CNAuth.ensureLogin({ silent: true })" in _cn_f,
   "36.8 抓取链路接入静默登录（搜索分支 + _tryCNKIPdf 两处）")
ok('"menuCNLogin"' not in menus_js and "menuCNLogin:" in utils_js,
   "36.9 ★ 0.43.1 登录类收敛：右键/工具菜单无 cn-login（文案保留供面板用）")
ok("IpLoginPo" in _cn_f and "ipLogin" in _cn_f and "detectAccess" in _cn_f,
   "36.14 ★ 校园网 IP 登录通道（IpLoginPo 无账号参数，validate.js SubmitCheck2 同款）+ 权限三态探测")
ok(os.path.exists(os.path.join(ROOT, "test", "cn-auth.test.js")),
   "36.10 cn-auth 单测存在（test/cn-auth.test.js）")
ok("test/cn-auth.test.js" in _pf5,
   "36.11 preflight 含知网登录测试")
ok("PP.cnAuth.loginInteractive()" in hub_js,
   "36.12 功能中心（Hub）保留「知网账号登录」入口卡（全能入口，与右键菜单分离）")
ok("this.cnAuth = CNAuth" in mainjs,
   "36.13 main.js 暴露 cnAuth（面板/Hub/排障经 Zotero.PaperPilot 访问）")
# 设置面板「知网账号」卡片（0.43.1）
_prefs_xhtml = io.open(os.path.join(ROOT, "chrome", "content", "prefs.xhtml"), encoding="utf-8").read()
ok('data-fold="cnki"' in _prefs_xhtml and 'id="pp-cnki-login-btn"' in _prefs_xhtml
   and 'id="pp-cnki-status"' in _prefs_xhtml and 'id="pp-cnki-detect-btn"' in _prefs_xhtml,
   "36.15 ★ 设置面板有「知网账号」卡片（状态行 + 登录按钮 + 权限检测按钮）")
ok('id="pp-cnki-verify-btn"' in _prefs_xhtml and 'id="pp-cnki-translators-btn"' in _prefs_xhtml,
   "36.16 风控验证/转换器更新按钮在面板（菜单已撤）")
ok(os.path.exists(os.path.join(ROOT, "chrome", "content", "prefs-cnki.js")),
   "36.17 面板脚本 prefs-cnki.js 存在")
ok("prefs-cnki.js" in mainjs,
   "36.18 main.js 注册 prefs-cnki.js 到设置面板脚本列表")
ok("loginFromPanel" in _cn_f,
   "36.19 面板登录走 loginFromPanel（不弹对话框，面板已填凭据）")
ok('data-fold="account"' in _prefs_xhtml and 'pp-cnki-status' in _prefs_xhtml,
   "36.20 知网卡片在账号分类下（账号卡片之后）")
ok("cnkiBootSelfTest" in prefsdef and "bootSelfTest" in _cn_f
   and "cnkiBootSelfTest" in mainjs,
   "36.21 ★ 启动自检三端接线（pref 默认关 / CNAuth.bootSelfTest / main.js 条件调度）")
# 0.43.2 防窥屏升级：接口地址无明文出口 + 完全隐藏
_pacc = io.open(os.path.join(ROOT, "chrome", "content", "prefs-account.js"), encoding="utf-8").read()
ok('showFullUrl()' not in _pacc and 'return maskUrl(u || "—")' in _pacc,
   "36.22 ★ 防窥屏：displayUrl 恒掩码（0.14.7 的明文开关出口已移除）")
ok('"***.***.***"' in _pacc,
   "36.23 掩码升级完全隐藏（主机名整体打码，防厂商/域名侧信道）")
ok('pp-ch-show-url' not in _prefs_xhtml and 'pp-ch-show-url' not in _pacc,
   "36.24 prefs.xhtml 已无「显示完整接口地址」勾选框")
ok('留空保持原地址' in _pacc,
   "36.25 编辑通道 baseUrl 不回填明文（留空=保持原地址，同密钥模式）")
_pcj = io.open(os.path.join(ROOT, "chrome", "content", "prefs-cnki.js"), encoding="utf-8").read()
ok("cnAuth().logout()" in _pcj and "logout" in _cn_f,
   "36.26 「清除凭据/退出登录」清 prefs 凭据 + cnki.net 会话 cookie（台账一致）")
ok("清除凭据/退出登录" in _prefs_xhtml,
   "36.27 按钮文案与行为一致（清除凭据/退出登录）")

# ---------- 37. 0.44.0（实验）第三方文献源（Pro 试用）----------
# 实验功能：模块装配 / 面板卡片 / 菜单注册 / Pro 软门控（判定不出时放行）/ 默认关闭。
_ts_path = os.path.join(ROOT, "chrome", "content", "scripts", "features", "third-source.js")
ok(os.path.exists(_ts_path), "37.1 third-source.js 存在")
_ts_js = io.open(_ts_path, encoding="utf-8").read() if os.path.exists(_ts_path) else ""
ok('"features/third-source.js"' in mainjs, "37.2 main.js 装配清单含 features/third-source.js")
ok("this.thirdSource = ThirdSource;" in mainjs, "37.3 main.js 暴露 thirdSource")
ok('"chrome/content/prefs-third-source.js"' in mainjs, "37.4 设置面板注册 prefs-third-source.js")
_pts_path = os.path.join(ROOT, "chrome", "content", "prefs-third-source.js")
ok(os.path.exists(_pts_path), "37.5 prefs-third-source.js 存在")
_pts_js = io.open(_pts_path, encoding="utf-8").read() if os.path.exists(_pts_path) else ""
ok('data-fold="thirdsrc"' in prefs_xhtml and 'id="pp-ts-login-btn"' in prefs_xhtml
   and 'id="pp-ts-enabled"' in prefs_xhtml and 'id="pp-ts-site"' in prefs_xhtml,
   "37.6 ★ 设置面板有「第三方文献源」卡片（启用开关 + 站点选择 + 登录按钮）")
ok('{ id: "third-source", group: "cn", labelKey: "menuThirdSource", run: () => ThirdSource.openPortal() }' in menus_js,
   "37.7 菜单注册 third-source（中文文献工具组 → openPortal）")
ok("menuThirdSource:" in utils_js, "37.8 I18n 表含 menuThirdSource 文案")
for _k in ["thirdSourceEnabled", "thirdSourceSite", "thirdSourceUsername", "thirdSourcePassword",
           "thirdSourceLastTest", "thirdSourceEntitlements"]:
    ok(("paperpilot.%s" % _k) in prefsdef, "37.9 prefs.js 含 %s 默认值" % _k)
ok('pref("extensions.zotero.paperpilot.thirdSourceEnabled", false);' in prefsdef,
   "37.10 ★ 实验功能默认关闭")
ok("proGate()" in _ts_js and '"not-logged-in"' in _ts_js and "unknown-allow" in _ts_js,
   "37.11 ★ Pro 软门控（判定不出时放行；仅明确非 Pro 拦截）")
ok("parseLoginResult" in _ts_js and "只能一人在线" in _ts_js,
   "37.12 登录结果纯函数解析（含单会话话术识别）")
_pts_used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', _pts_js))
_pts_missing = sorted(i for i in _pts_used if i not in xhtml_ids)
ok(not _pts_missing,
   "37.13 prefs-third-source.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (_pts_missing or "无"))
_pf_ts = io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read()
ok("test/third-source.test.js" in _pf_ts, "37.14 preflight 含第三方文献源测试")
# 0.44.0 实机验证后的面板补强：权限展示 + 上次测试记录 + 检测权限按钮
ok('id="pp-ts-ent"' in prefs_xhtml and 'id="pp-ts-refresh-btn"' in prefs_xhtml,
   "37.15 ★ 卡片含「账号权限」行与「检测权限」按钮（实机验证后补）")
ok("parseEntitlements" in _ts_js and "fetchEntitlements" in _ts_js and "readLastTest" in _ts_js,
   "37.16 模块含权限解析/拉取与上次测试记录（纯函数可离线测）")
ok("打开入口」后需在浏览器里用同一卡号再登录一次" in prefs_xhtml,
   "37.17 面板提示含浏览器再登录说明（插件会话与浏览器互不相通）")

print("=" * 60)
for p in passes:
    print("  OK  " + p)
if problems:
    print("-" * 60)
    for p in problems:
        print("  !!  " + p)
print("=" * 60)
print("接线扫描：%d 通过 / %d 问题" % (len(passes), len(problems)))
sys.exit(1 if problems else 0)
