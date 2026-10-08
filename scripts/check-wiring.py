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
ok("openViewerForSelected" in menus_js, "17.17 右键菜单接了双栏对照窗口")
ok("BilingualTranslate.runForSelected()" in menus_js, "17.18 右键菜单仍保留原「AI 双语笔记」出口")
ok("openViewerForSelected" in wb_js, "17.19 工作台「全文对照翻译」chip 指向双栏窗口")
ok("openViewerForSelected" in hub_js, "17.20 功能中心卡片指向双栏窗口")
ok("runForSelected()" in bl_mod, "17.21 原笔记流程仍在（未删）")
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
ok("version: '1.7.0'" in srv, "18.31 服务端版本号已随批次更新（1.7.0）")
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
ok("version: '1.7.0'" in srv, "19.24 服务端版本随批次推进（1.7.0）")

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

ok('"version": "0.27.0"' in MANIFEST, "20.12 manifest 版本 0.27.0")
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

ok("version: '1.7.0'" in srv, "21.32 服务端版本 1.7.0")
ok("test/pay.test.js" in _pf3, "21.33 preflight 含在线支付测试")

# ---------- 输出 ----------
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
