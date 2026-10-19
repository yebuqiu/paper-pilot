# Papilot

**An AI co-pilot for Zotero.** Selection translation, side-by-side PDF translation, library-wide Q&A, one-click reference import, automation rules, reading progress — one plugin for the whole "read the literature" loop.

![version](https://img.shields.io/badge/version-0.55.0-blue)
![zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-orange)
![license](https://img.shields.io/badge/license-Apache--2.0-green)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

[中文](README.md) ｜ [**English**](README.en.md)

> **Renamed in 0.55.0**: the project moved from **PaperPilot** to **Papilot** (repository `zotero-papilot`). The add-on ID, preference branch and local data files changed together; existing users should follow [section 8](#8-upgrading-from-paperpilot), which migrates settings and sessions automatically.

---

## 1. Introduction

Papilot is a third-party add-on running inside **Zotero 7–10**, positioned as a "literature co-pilot": Zotero collects and cites, Papilot handles everything after you open a PDF — understanding it, translating it, questioning it, turning conclusions into notes, and putting citations back into your library.

It consists of two parts that version independently:

| Part | What it is | Do you need to deploy it? |
|---|---|---|
| **The add-on** | `bootstrap.js` + `chrome/content/**`, a Manifest V2 extension with ~100 modules | No — install the `.xpi` and go |
| **Account backend** | `server/`, pure Node standard library, zero third-party dependencies: sign-up/sign-in, the official AI gateway and admin pages | **Not for regular users** (officially hosted at `pp.xinglintools.top`); only for self-hosting or development |

Three design rules:

- **Local-first**: papers, notes and reading history live in your Zotero library; only the AI requests and metadata lookups you explicitly trigger go online.
- **No model lock-in**: 14 channel presets (11 cloud vendors + local Ollama + official account + custom endpoint); translation additionally runs on 16 engines, 10 of which need no key.
- **Non-invasive**: every capability appears as a menu item, panel, column or dialog. Disable the plugin and Zotero behaves exactly as before.

---

## 2. Features

All entries are reachable from the **Feature Hub** (`Tools → Papilot ▸ → Papilot Feature Hub`). Below they are grouped exactly like the hub; the names in parentheses are the actual menu labels.

### 2.1 Reading (acts on the currently selected item)

- **AI Workbench**: standalone chat window that follows the main window's selection, streaming output, multiple sessions.
- **Summarize / Translate title & abstract / Deep interpretation**: a 300–500 word structured summary, an academic-tone translation that keeps terminology in English, and a five-part interpretation (problem / method / experiments / novelty / limitations) — each saved as a Zotero note.
- **PDF side-by-side translation (source | translation)**: original page on the left, the same page translated on the right, aligned paragraph by paragraph, figures and formulas preserved, synchronized scrolling, bilingual note export.
- **AI Chat floating window**: five triggers — `Ctrl+Shift+K` in the main window, the reader toolbar button, `Ctrl+Enter` in the reader, the item context menu, and the selection popup. Floating, edge-docked and split-window forms **share one session**.
- **Chat sidebar / Selection popup / PDF glance**: abstract and opening text appear in the right sidebar as soon as you select an item; selecting text in the reader translates, explains or follows up.
- **AI mind map**: hierarchical outline note, exportable as markmap `.md`.
- **Skill Store**: browse, install and author AI skill packs (prompt tags, glossaries, note templates, agent presets — declarative assets only).
- **Auto deep-read on import**: new items are summarized automatically and tagged `#AI精读` (off by default; daily cap and collection allow-list apply).

### 2.2 Search & Discovery (across the whole library)

- **Ask the library**: one question → two-stage retrieval (title/tag/abstract scoring, then full-text index verification) → the model answers from the candidates with clickable `[n]` citations; scope to the current collection, restrict to items with attachments, save the answer as a library-level note.
- **Retrieve only**: candidate list and matching snippets without calling the model.
- **Discovery (daily arXiv)**: build an interest profile from your library → pull the latest submissions by category → score and rank → automatically exclude items already in the library; results can be filed into an "arXiv recommendations" collection or saved as a note. Off by default.

### 2.3 Notes & Cards

- **Collect annotations** into one note; **AI interpretation of annotations** (what your highlights say about the through-line).
- **Note from template**: reading notes / close-reading cards / quick-read logs; templates are customizable.
- **AI flashcards to Anki**: generate Q/A cards from the full text and export Anki's import `.txt`.
- **Text side-by-side view (legacy entry)**: plain-text left/right view for cases without a text layer.
- **Note graph**: interactive graph of `zotero://` links and `[[wiki links]]` between items and notes; click a node to locate it in the main window.
- **Review Workbench**: multiple papers → outline → section drafts.

### 2.4 Batch Analysis (select 2+ items or a collection)

- **Compare PDFs**: up to 4 papers on screen (horizontal / vertical / 2×2), optional synchronized scroll and zoom, read-only preview of existing highlights.
- **AI literature matrix**: dimension-based comparison table note.
- **AI literature review**: a review paragraph with citation numbers across several papers.
- **Citation trace**: references / citing-papers analysis note.
- **Import references**: paste DOI, title, URL, PMID, arXiv ID or BibTeX — or jointly search Crossref / OpenAlex / PubMed / Europe PMC / arXiv / Semantic Scholar; automatic de-duplication, AI fills blanks without overwriting, export to BibTeX / EndNote.
- **Collection stats / Library report / Reading report**: per-collection counts, an HTML report of year–journal–author–tag distributions, and 30-day reading time with a calendar heatmap.

### 2.5 Library Health

- **Chinese literature**: parse CNKI/Wanfang-style filenames into metadata, fetch full Chinese metadata (public academic platform + CNKI, optionally with PDF), update CN translators, pass CNKI risk-control verification, **sign in with a personal CNKI account** (credentials stay local), match already-downloaded attachments by title.
- **Metadata**: fill missing fields via Semantic Scholar (never overwriting), normalization (DOI/date/title/URL), **metadata audit** (journal abbreviation ↔ full title, author-name normalization, DOI validity, required fields per item type, duplicate DOIs — checklist before fixing), **Metadata Doctor** (Crossref back-fill of DOI/journal/year with preview → confirm → undo).
- **Authenticity & cleanup**: fake-reference detection (hallucination check), verify a pasted reference list, smart cleanup (duplicates / missing attachments / missing metadata).
- **Attachments**: attachment doctor (no attachment, missing file, duplicate under the same parent, scanned PDFs without a text layer, storage orphans — **reports only, never deletes or moves**), rule-based renaming with `{author} - {year} - {title}`.
- **Full text**: Unpaywall (legal OA) first, then Sci-Hub / Sci-Net / publisher direct per settings; the resolvers can be injected into Zotero's native "Find Full Text".

### 2.6 Tags & State

- **AI auto-tagging**: structured JSON output + controlled vocabulary (reusing spellings already in your library) + confidence threshold + fingerprint cache.
- **Rule tagging**: line-based `tag | field | operator | value`, supporting `contains / !contains / regex / = / != / > / < / exists`.
- **Automation rules (trigger → condition → action)**: triggers are item import, PDF open, or manual on selected items; conditions combine 17 fields × 9 operators (regex included); actions tag, untag, write allow-listed fields, set reading state, add to a collection, run AI summary or AI tagging; includes a **dry run** that only counts matches.
- **Tag curator / normalization / nested tag view**: read-only report first (case, full-width/half-width, space vs hyphen variants, rare tags, missing parents), merge only after confirmation; `#a/b` hierarchy browsing is read-only.
- **Three reading states**: unread / reading / read, mutually exclusive; opening a PDF flips to "reading", and progress past the threshold flips to "read".

### 2.7 Integration

- **MCP server**: exposes the library as 10 MCP tools — `search_library`, `get_item`, `read_fulltext`, `list_annotations`, `create_note`, `list_collections`, `library_stats`, `list_recent`, `list_agent_tools`, `run_agent_tool` — for Claude Desktop, Cursor or your own agent. It rides Zotero's built-in local HTTP server (`127.0.0.1:23119`), so no extra process; **off by default**; once enabled every request needs a Bearer token, and write tools additionally require an explicit `allowWrite: true`.

### 2.8 Columns & Settings

- **Journal rank column**: easyScholar online data with offline fallback, Chinese and international systems (CAS tiers / PKU / CSCD / CSSCI / core), configurable badge count and colouring.
- **Citation column**: Semantic Scholar citation counts, refreshable.
- **Reading progress**: drawn directly into the **title column background** (one cell per page, darker the longer you read), fusing three sources (heartbeat page, Zotero's native last position, annotated pages); plus a sortable "reading progress" column.
- **Translated-title column / star rating column**.
- **Themes**: UI themes (standard / anime / landscape / animated wallpaper + custom image or video) and PDF reading themes (eye-care tint, night inversion, custom colour).
- **Menu customization**: `grouped` (default: quick-access items + 9 semantic groups) or `classic` (flat); hide groups, choose the three quick-access items.

### 2.9 Account (optional)

- Usable without signing in: translation, columns, themes, library health, automation and MCP are all local.
- When signed in: the official AI channel works without your own key, and you can review signed-in devices.
- You can also use your own API key or a local model and never create an account.

---

## 3. Installation

### 3.1 Requirements

| Item | Requirement |
|---|---|
| Zotero | **7 / 8 / 9 / 10** (`strict_min_version 6.999`, `strict_max_version 99.*`) |
| OS | Windows / macOS / Linux |
| Account backend (self-hosted only) | Node ≥ 14; **zero third-party dependencies** |

### 3.2 Install the add-on

1. Download the latest `papilot-x.y.z.xpi` from [Releases](../../releases) (older builds are in `dist/`).
2. Zotero → **Tools → Add-ons** → **gear icon → Install Add-on From File…**
3. Pick the `.xpi`, restart Zotero.
4. Open **Settings → Papilot** and configure the AI channel as described in 3.3.

> Zotero updates third-party add-ons **silently**. Papilot checks the update manifest 15 seconds after startup and shows a native notification **only when a newer version really exists**, at most once per version.

### 3.3 First-run configuration (pick one)

| Mode | Steps | Good for |
|---|---|---|
| **Official account** | Settings → Papilot → Account → sign up / sign in; select the "Papilot account" channel | You don't want to obtain an API key |
| **Your own key** | Settings → Papilot → Channels → add a channel, pick a vendor preset and paste the key, or enter a custom base URL | You already have a vendor account |
| **Local model** | Channel `Ollama (local)`, base URL `http://127.0.0.1:11434/v1` | Fully offline |

Then run **Connection test** (`Tools → Papilot ▸ → Connection test`) to confirm.

### 3.4 Build from source

No bundler, no compile step:

```bash
python scripts/build-xpi.py 0.55.0     # → dist/papilot-0.55.0.xpi
```

The script checks that all sources exist, writes the zip, then re-opens it to assert "package contents == expected list" and prints the manifest version and entry count.

---

## 4. Running

### 4.1 The add-on (everyone)

It starts with Zotero; no extra process and no background daemon. Startup logs `Papilot startup` to **Help → Debug Output**, and self-check logs also go to `papilot-boot.log` in the Zotero data directory.

### 4.2 Account backend (self-hosting / development only)

```bash
# Foreground debugging (cwd must be server/)
cd server && node account-server.js

# Production start (idempotent: exits if :8000 already answers)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-account-server.ps1

# Health check
curl http://127.0.0.1:8000/api/health
```

GUI launcher (recommended): double-click **`启动Papilot后台.bat`**, which uses `wscript` to open a windowless WinForms console. The left sidebar has runtime status, account backend, public tunnel and account management.

- Server data lives in `server/data/*.json` (users, orders, tokens, channel keys) and is **git-ignored**.
- After changing server code you must restart the production process in the same round, or the plugin keeps talking to the old logic.

### 4.3 Public tunnel (only when self-hosting and needing external access)

```bash
powershell -File scripts/tunnel/tunnel.ps1 status|start|stop|restart
# or double-click 启动公网隧道.bat / 停止公网隧道.bat
```

Tunnel `paperpilot` → `pp.xinglintools.top` → `127.0.0.1:8000`. Health means `readyConnections > 0` on `/ready` (**an open port is not health**). Online-payment callbacks require `PP_PUBLIC_URL` to be a public https address.

### 4.4 Where data lives

| Content | Location |
|---|---|
| Preferences | Zotero prefs `extensions.zotero.papilot.*` (197 entries) |
| Login session | `papilot-account.json` (plus `.1` / `.2` rolling copies), in both the Zotero data directory and the profile directory |
| Chat history / journal cache / reading stats / progress | `papilot-chat-sessions.json`, `papilot-easyscholar.json`, `papilot-rank-config.json`, `papilot-s2-citations.json` in the same directories |
| Papers, notes, attachments | Always inside the Zotero library — the plugin never copies or moves them |

---

## 5. Usage

### 5.1 Menu layout

- **Tools menu**: a single `Papilot ▸` entry (feature hub + group shortcuts) plus a separate "Papilot Settings".
- **Item context menu**: `grouped` by default — up to 3 quick-access items on top (default: "AI Summary", "PDF side-by-side translation") followed by 9 semantic groups: AI Reading / Notes & Export / Citation Analysis / Tags / Metadata / Chinese Literature Tools / Automation / Reading State / Rating.
- **Toolbar button**: one button in the item toolbar that opens the same quick items + hub + settings (can be disabled).
- Anything folded away is still reachable from **the hub / the Tools menu groups / classic flat mode**.

### 5.2 Six typical workflows

1. **Reading a foreign paper**: select the item → right-click "PDF side-by-side translation" → original left, translation right, translated as you scroll; use "translate whole document" inside the window when needed.
2. **Reading with questions**: `Ctrl+Shift+K` opens the chat overlay (locked to the current item) → multi-turn follow-ups → "save as note".
3. **Asking the whole library**: hub → Ask the library → type the question → follow the `[n]` citations back to the items.
4. **Cleaning metadata in bulk**: select items → Metadata audit → review the issue list → tick → apply; use Metadata Doctor for a reversible preview first.
5. **Building an automation rule**: Automation rules → new rule "on import → title contains X → tag + set state" → dry run → enable.
6. **Handing the library to an external agent**: Settings → MCP → enable → copy the client JSON → paste into Claude Desktop / Cursor.

### 5.3 Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Shift + K` | Open the AI chat overlay from the main window |
| `Ctrl/Cmd + Enter` | Open the chat overlay from the reader |
| `↑` / `↓` | Browse question history in the overlay |
| `Esc` | Close the overlay |

Rebind or disable them in **Settings → Papilot → Hotkeys**; individual automation rules can also carry their own shortcut.

---

## 6. Configuration

### 6.1 Settings sections (17 collapsible groups)

Account / CNKI / Third-party sources / Channels / Translation / AI parameters / Skill packs / Search subscriptions / Scheduled tasks / Selection popup / Columns / Tagging & automation / Enhancements / UI theme / PDF theme / Menu / Hotkeys.

The panel supports search and remembers which groups are expanded (`prefsFoldOpen`).

### 6.2 Key preferences (defaults taken from `prefs.js`)

| Group | Preference key | Default | Meaning |
|---|---|---|---|
| Channels | `aiChannels` | `""` | Channel registry JSON, see [7.2](#72-custom-ai-channel) |
| Channels | `aiModel` | `auto` | Current model; `auto` = channel default |
| Channels | `aiMaxTokens` | `4096` | Max tokens per reply |
| Channels | `aiTemperature` | `"0.3"` | Temperature (stored as string; prefs have no float) |
| Channels | `aiHistoryRounds` | `6` | Sliding context window (1–30 rounds) |
| Channels | `aiFullTextMaxChars` | `16000` | Max characters of full text sent to the model |
| Agent | `chatAgentMode` | `false` | Master switch for agent mode |
| Agent | `aiAgentMaxSteps` | `5` | Max tool-calling rounds (1–12) |
| Agent | `aiAgentConfirmWrite` | `true` | Confirm every write operation |
| Agent | `aiAgentTools` | 11 tools (CSV) | Tool allow-list |
| Translation | `readerPopupTargetLang` | `zh-CN` | Target language (canonical code) |
| Translation | `translateFromLang` | `auto` | Source language |
| Translation | `translateCfg` | `""` | `{active, fallback[], timeoutMs, retry, cache, secrets{}}` |
| Translation | `bilingualStructExtract` | `true` | Paragraph blocks (formulas / captions / junk lines separated) |
| Translation | `bilingualContext` | `true` | Use document title + previous paragraph as context |
| Translation | `translateGlossary` | `""` | Glossary, see [7.4](#74-glossary) |
| Dual view | `pdfInlineMode` | `off` | In-place translation: `overlay` / `bilingual` / `off` |
| Dual view | `pdfDualSyncScroll` | `true` | Synced scrolling (page + in-page ratio) |
| Dual view | `pdfDualRightMode` | `mono` | Right pane: replace text / overlay with faded source |
| Columns | `rankColumnEnabled` | `true` | Journal rank column |
| Columns | `citationColumnEnabled` | `true` | Citation count column |
| Columns | `progressRowEnabled` | `true` | Progress bar inside the title column |
| Columns | `progressBasis` | `auto` | Progress basis: position-first / position only / time only |
| Columns | `progressAutoFinishPct` | `95` | Threshold that flips an item to "read" |
| Tagging | `autoTagUseVocab` | `true` | Reuse the library's controlled vocabulary |
| Tagging | `autoTagConfidenceThreshold` | `0.7` | Pre-tick threshold for suggestions |
| Automation | `automationRules` | `""` | Rule array (JSON) |
| Automation | `automationDailyAiCap` | `20` | Daily AI call cap |
| Automation | `autoReadEnabled` | `false` | Auto deep-read on import |
| Discovery | `discoveryEnabled` | `false` | Daily arXiv recommendations |
| Discovery | `discoveryCategories` | `cs.AI, cs.CL, cs.LG` | Categories to pull |
| Integration | `mcpEnabled` | `false` | MCP server switch |
| Menu | `menuMode` | `grouped` | `grouped` / `classic` |
| Menu | `menuQuickItems` | `ai-summary,bilingual-view` | Quick-access items at the top of the context menu |
| Appearance | `uiTheme` / `pdfTheme` | `""` / `default` | UI theme / PDF reading theme |
| Updates | `updateNoticeEnabled` | `true` | Notify when a newer version exists |
| Full text | `fulltextResolverEnabled` | `true` | Inject resolvers into Zotero's native "Find Full Text" |

> Every preference can also be edited directly in Zotero's advanced config (`about:config`); anything with a pref observer takes effect immediately, no restart required.

---

## 7. Examples

### 7.1 MCP client configuration

After enabling MCP in **Settings → Papilot → MCP**, the window shows a ready-to-copy JSON block (the token is generated on first use and can be reset):

```json
{
  "mcpServers": {
    "papilot": {
      "type": "http",
      "url": "http://127.0.0.1:23119/papilot/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

A tool call (JSON-RPC):

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "search_library", "arguments": { "query": "tic disorder TCM", "limit": 5 } }
}
```

### 7.2 Custom AI channel

Adding a channel in the settings panel is the recommended path; the equivalent `aiChannels` structure is (`active` points at a channel id):

```json
{
  "active": "ds",
  "channels": [
    {
      "id": "ds",
      "name": "DeepSeek",
      "provider": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "timeoutMs": 60000
    }
  ]
}
```

`provider` is one of the built-in preset ids (`deepseek` / `qwen` / `glm` / `kimi` / `doubao` / `yi` / `ernie` / `minimax` / `siliconflow` / `spark` / `hunyuan` / `ollama` / `custom`) or `official`, whose base URL and key are injected from your session and never stored.

### 7.3 Rule-tagging syntax

`Settings → Papilot → Tagging & automation → Rule tagging`, one rule per line:

```
# tag | field | operator | value
# fields: title publicationTitle journalAbbreviation abstractNote year itemType DOI creators
# operators: contains !contains regex = != > < exists
#method/machine-learning | abstractNote | contains | machine learning
#domain/cardiology | publicationTitle | regex | (?i)heart|cardio
#recent | year | > | 2023
```

Lines starting with `//` or `#` are comments.

### 7.4 Glossary

`Settings → Papilot → Translation → Glossary`, one `source = target` per line (`=>` and tab separators also work; a JSON array is accepted too). Domain-aware form adds a third segment:

```
Transformer = transformer | Computer Science;AI
myocardial infarction = myocardial infarction | Medicine
```

The domain allow-list is `translateGlossaryDomains` (semicolon-separated; empty = all domains enabled; general entries without a domain are never filtered out). The glossary participates in the translation cache key via its content fingerprint and is injected into the LLM prompt so terminology stays consistent across the paper.

---

## 8. Upgrading from PaperPilot

0.55.0 is a brand-level rename; all of the following changed together:

| Item | Old | New |
|---|---|---|
| Add-on name | PaperPilot 文献副驾 | **Papilot 文献副驾** |
| Add-on ID | `paperpilot@dev.local` | `papilot@dev.local` |
| Preference branch | `extensions.zotero.paperpilot.*` | `extensions.zotero.papilot.*` |
| Data files | `paperpilot-*.json` | `papilot-*.json` |
| Repository | `paper-pilot` | `zotero-papilot` |

**Steps** (the add-on ID changed, so the old version will not auto-update):

1. Zotero → Tools → Add-ons → **remove** the old PaperPilot.
2. Install `papilot-0.55.0.xpi` and restart.
3. On first start a one-shot migration copies user values from the old preference branch to the new one and copies 7 old data files under their new names (guarded by `brandMigrated`; the old files are kept).
4. If a setting did not carry over, the old value is still on disk — re-enter it.

---

## 9. Privacy & Data

- **Offline by default**: apart from the AI requests, metadata lookups and update checks you trigger, nothing is uploaded; each of those can be disabled or narrowed in settings.
- **Credentials stay local**: AI keys, CNKI and third-party source accounts live in local prefs; the login session token is stored as JSON in the data directory (never in prefs, never in git).
- **Three MCP constraints**: off by default, bound to `127.0.0.1` only, Bearer token on every request; write tools additionally require explicit authorization.
- **Uninstalling keeps data**: the files above are not deleted on uninstall; remove them manually if you want them gone.

---

## 10. Development

```bash
# Quick gate (syntax + generated-asset sync + all Node tests + wiring scan, ~2.5 min)
python scripts/preflight.py --fast

# Full gate (adds browser E2E; needs NODE_PATH pointing at playwright-core)
python scripts/preflight.py

# Package
python scripts/build-xpi.py 0.55.0

# Static wiring scan (launcher × server × admin × plugin assembly)
python scripts/check-wiring.py

# arXiv toolkit (tools/arxiv is the single source for the generated core)
node tools/arxiv/test/run-all.js
python scripts/build-arxiv-core.py --check
```

Stack: JavaScript in Zotero's privileged scope (not a web page), XHTML/XUL and CSS. Tests are hand-written Node `vm` assertions — **no** Jest, **no** Mocha, and deliberately **no** `package.json` or npm dependencies.

```
bootstrap.js            # lifecycle entry; registers chrome://papilot/ and loads main.js
chrome/content/         # xhtml UI + scripts/ (core / ai / features / columns / panels)
locale/                 # zh-CN / en-US FTL strings
prefs.js                # every default preference, individually commented
server/                 # zero-dependency Node backend (accounts / AI gateway / admin)
scripts/                # packaging, gates, wiring scan, release, GitHub sync, tunnel
test/                   # 73 Node test suites
tools/arxiv/            # arXiv toolkit (source of the generated core)
docs/                   # design notes, verification reports, research
dist/                   # packaged xpi releases
```

Development conventions (seven-step release, on-device verification checklist, parallel-session rules) live in [AGENTS.md](AGENTS.md).

---

## 11. FAQ

**Nothing happens after installing?**
Make sure Zotero is 7 or newer. `Help → Debug Output` should show `Papilot startup`. On `STARTUP FAILED`, please attach the stack trace to an issue.

**The AI keeps spinning?**
Run "Connection test" first. Common causes: unreachable endpoint, invalid key, exhausted key quota, or a wrong model name inside the channel.

**Translation is empty or garbled?**
Scanned PDFs have no text layer — run the attachment doctor or Zotero OCR. Masked inline formulas are expected.

**I updated but the version did not change?**
Add-on updates are silent replacements and need a **Zotero restart**; Papilot shows a notice once when it detects a newer version.

**Does it upload my papers?**
Only the text fragments needed for a request you explicitly triggered, to the endpoint you configured. There is no background bulk upload.

**The progress bar does not appear?**
Check that `progressRowEnabled` is true (the default) and that the item has a PDF with a known page count; EPUBs have no page numbers, so progress is tracked by CFI.

---

## 12. License & Notices

### 12.1 Licensing scope

| Scope | License | Notes |
|---|---|---|
| Client (`bootstrap.js`, `chrome/`, `locale/`, `prefs.js`) | **Apache-2.0** | Commercial use, modification and redistribution allowed; keep `LICENSE` and `NOTICE` |
| Account & gateway backend (`papilot-server`) | **Commercial license** | Not covered by this repository; requires a separate license |
| Docs and skill-pack content (`docs/`, `community-packs/`) | **CC BY 4.0** | Free to use and commercialise with attribution |
| Third-party components | Their own licenses | See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |

### 12.2 Redistribution

- You may fork, modify, build and redistribute the add-on at no cost and without asking.
- You **may not** ship derivative builds under the Papilot / 文献副驾 name or icons (trademark reserved), nor point the default server address at the official service in a way that causes confusion.
- If you want to bundle the add-on in a product or offer a hosted service, please contact us for a license first.

### 12.3 Third parties & trademarks

- Third-party components, data providers and full license texts: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- **Zotero** is a registered trademark of the Corporation for Digital Scholarship. Papilot is an independent third-party add-on, not affiliated with or endorsed by the Zotero project.
- When using experimental sources (third-party literature providers, Sci-Hub, etc.), please verify your institutional subscriptions and local legal requirements.

### 12.4 Documentation

- [User guide (中文)](docs/使用教程.md) ｜ [Install & configuration guide (中文)](docs/Papilot-安装配置指南.md) ｜ [Feature list (中文)](docs/Papilot-功能清单与分类.md) ｜ [Roadmap (中文)](docs/Papilot-功能路线图.md)
- [Why we renamed from PaperPilot (中文)](docs/产品命名评估-重名现状与改名建议-2026-10-19.md)
