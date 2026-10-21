// Shouldn't be needing this if using the latest version of WPS
const WPS_Enum = {
    msoCTPDockPositionLeft: 0,
    msoCTPDockPositionRight: 2,
    msoPropertyTypeString: 4,
    wdAlignParagraphJustify: 3,
    wdAlignTabLeft: 0,
    wdCharacter: 1,
    wdCollapseEnd: 0,
    wdCollapseStart: 1,
    wdFieldAddin: 81,
    wdLineBreak: 6,
    wdParagraph: 4
};

// Storing global variables
const GLOBAL_MAP = {};

/**
 * Callback for plugin loading.
**/
function OnAddinLoad(ribbonUI) {
    if (typeof (wps.Enum) !== "object") {
        wps.Enum = WPS_Enum;
        zc_alert('当前 WPS 版本较旧，这个加载项可能无法正常工作。建议升级 WPS 后重试。');
    }
    if (typeof (wps.ribbonUI) !== "object"){
        wps.ribbonUI = ribbonUI;
    }

    GLOBAL_MAP.isWin = Boolean(wps.Env.GetProgramDataPath());
    GLOBAL_MAP.osSep = GLOBAL_MAP.isWin ? '\\' : '/';
    GLOBAL_MAP.instDir = GLOBAL_MAP.isWin ?
        wps.Env.GetAppDataPath().replaceAll('/', '\\') + `\\kingsoft\\wps\\jsaddons\\wps-zotero_${VERSION}`:
        wps.Env.GetHomePath() + `/.local/share/Kingsoft/wps/jsaddons/wps-zotero_${VERSION}`;
    GLOBAL_MAP.proxyPath = GLOBAL_MAP.instDir + GLOBAL_MAP.osSep + 'proxy.py';

    // Start http proxy server
    if (GLOBAL_MAP.isWin) {
        wps.OAAssist.ShellExecute('pythonw.exe', GLOBAL_MAP.proxyPath);
    }
    else {
        wps.OAAssist.ShellExecute('python3', GLOBAL_MAP.proxyPath);
    }
    
    // Exit the proxy server when the application quits.
    Application.ApiEvent.AddApiEventListener("ApplicationQuit", () => {
        // NOTE: This event is never received on Windows, so the proxy server can't be stopped and there's nothing I can do.
        postRequestXHR('http://127.0.0.1:21931/stopproxy', null);
    });
    
    return true
}

/**
 * Callback for button clicking events.
**/
function OnAction(control) {
    const eleId = control.Id
    switch (eleId) {
        case "btnAddEditCitation":
            // IMPORTANT: Release references on the document objects!!!
            zc_bind().command('addEditCitation');
            zc_clearRegistry();
            break;
        case "btnAddEditBib":
            zc_bind().command('addEditBibliography');
            zc_clearRegistry();
            break;
        case "btnRefresh":
            zc_bind().import();
            // Must open a new client, since import will not register fields to zc_bind().
            zc_bind().command('refresh');
            zc_clearRegistry();
            break;
        case "btnPref":
            zc_bind().command('setDocPrefs');
            zc_clearRegistry();
            break;
        case "btnExport":
            if (confirm('把本文档转换成其它文字处理器可导入的格式？\n建议先备份一份，转换后引文会变成纯文本域。'))
            {
               zc_bind().export();
            }
            break;
        case "btnUnlink":
            zc_bind().command('removeCodes');
            zc_clearRegistry();
            break;
        case "btnAddNote":
            zc_bind().command('addNote');
            zc_clearRegistry();
            break;
        case "btnAbout":
            alert(`Zotero 引用 for WPS · Papilot 中文版 ${VERSION}\n\n`
        + `用法：光标放到正文 → 点「插入/编辑引文」；文末点「插入/编辑文献表」；\n`
        + `换了样式或改了文献库 → 点「刷新」。\n\n`
        + `汉化与维护：Papilot\n上游作者：Tang, Kewei\nhttps://github.com/tankwyn/WPS-Zotero\n\n`
        + `许可：GPL-3.0 <http://www.gnu.org/licenses/>，不提供任何担保。`);
        default:
            break
    }
    return true
}

function GetImage(control) {
    const eleId = control.Id
    switch (eleId) {
        case "btnAddEditCitation":
            return "images/addEditCitation.svg";
        case "btnAddEditBib":
            return "images/addEditBib.svg";
        case "btnRefresh":
            return "images/refresh.svg";
        case "btnPref":
            return "images/pref.svg";
        case "btnAddNote":
            return "images/addNote.svg";
        case "btnUnlink":
            return "images/unlink.svg";
        case "btnExport":
            return "images/export.svg";
        default:
            break;
    }
    return "images/default.svg";
}

