/* 
** A client for the Zotero HTTP integration server.
** (https://www.zotero.org/support/dev/client_coding/http_integration_protocol)
*/

/**
 * Create a client to communicate with Zotero.
 * @param documentId The document ID of the document to be binded with the client.
 * @param processor Word processor interface.
 * @returns client object.
**/
function zc_createClient(documentId, processor) {
    // The proxy server listens on 21931 and forwards requests to 23119
    const commandUrl = 'http://127.0.0.1:21931/connector/document/execCommand';
    const respondUrl = 'http://127.0.0.1:21931/connector/document/respond';

    function requestStatusHint(status) {
        if (status >= 300) {
            if (status < 400) {
                zc_alert(`收到非预期的重定向响应（HTTP ${status}），请重试；若持续出现请反馈。`);
            }
            else if (status < 500) {
                zc_alert(`请求被拒绝（HTTP ${status}）。常见原因：文档 ID 无效，或 Zotero 侧上一次事务没走完——重启 Zotero 后重试。`);
            }
            else {
                if (status === 503) {
                    zc_alert('Zotero 提示正在服务另一个程序（HTTP 503）。若并非如此，请重启 Zotero。');
                }
                else {
                    zc_alert(`Zotero 服务端错误（HTTP ${status}），请重启 Zotero 后重试。`);
                }
            }
        }
    }

    function execCommand(command) {
        return postRequestXHR(commandUrl, {
            "command": command,
            "docId": documentId,
        })
    }

    function respond(payload) {
        return postRequestXHR(respondUrl, payload);
    }

    /**
     * Send client commands to Zotero and make changes to documents.
    **/
    function transact(command) {
        // TODO: If exception occurred and the command is not fully completed,
        // the server will be in an unsable state. Is there any way to avoid this?

        // Init transaction
        let state = true;
        processor.init(documentId);

        let flag = false;
        try {
            // Make request
            let req = execCommand(command);
            assert(req);
            flag = true;
            if (req.status < 300) {
                // Keep responding until the transaction is completed
                while (req && req.status < 300) {
                    req = autoRespond(req);
                }
            }
            else {
                state = false;
                if (req) {
                    console.error(`Unexpected response from Zotero: status = ${req.status}, msg = ${req.payload}`);
                    requestStatusHint(req.status);
                }
            }
        }
        catch (error) {
            state = false;
            console.error('Error occurred:', error);
            const guide = flag ? '\n请重启 Zotero。' : '';
            if (error.name === 'NetworkError') {
                zc_alert('连接不上本地代理或 Zotero。请确认 Zotero 已启动；\n若 Zotero 已在运行，打开 Papilot 设置 →「WPS 集成」→ 点「一键修复」。' + guide);
            }
            else {
                zc_alert(`发生错误（${error.name}）。请打开开发者工具查看控制台日志，并把它反馈给我们。` + guide);
            }
        }

        processor.reset(documentId);
        return state;
    }

    // Functions for responding to different word processor commands
    let responders = {
        getActiveDocument: function() {
            return respond({
                "documentID": documentId,
                "outputFormat": "html",
                "supportedNotes": ["footnotes"],
                "supportsImportExport": true,
                "supportsTextInsertion": true,
                "supportsCitationMerging": true,
                "processorName":"Google Docs"
            });
        },

        displayAlert: function(args) {
            const msg = args[1];
            const icon = args[2];
            const buttons = args[3];
            const ret = processor.displayDialog(msg, icon, buttons);
            return respond(ret);
        },

        activate: function(args) {
            const docId = args[0];
            assert(docId === documentId);
            processor.activate(documentId);
            return respond(null);
        },

        canInsertField: function(args) {
            const docId = args[0];
            assert(docId === documentId);
            // TODO: Other cases a field cannot be inserted?
            return respond(!processor.isInLink(documentId));
        },

        setDocumentData: function(args) {
            const docId = args[0];
            const dataStr = args[1];
            assert(docId === documentId);
            let curData = processor.getDocData(documentId);
            if (curData !== dataStr) {
                if (curData) console.debug('update existing document data:', curData);
                processor.setDocData(documentId, dataStr.trim());
            }
            return respond(null);
        },

        getDocumentData: function(args) {
            const defaultDocDataV3 = '<data data-version="3"/>';
            // const defaultDocDataV4 = JSON.stringify("{\"dataVersion\": 4}");
            const docId = args[0];
            assert(docId === documentId);
            let dataStr = processor.getDocData(docId);
            // IMPORTANT: Change bibliographyStyleHasBeenSet to false to always get a setBibliographyStyle command.
            dataStr = dataStr.replaceAll('bibliographyStyleHasBeenSet="1"', 'bibliographyStyleHasBeenSet="0"');
            dataStr = dataStr.replaceAll('\\"bibliographyStyleHasBeenSet\\": true', '\\"bibliographyStyleHasBeenSet\\": false');
            dataStr = dataStr.replaceAll('\\"bibliographyStyleHasBeenSet\\":true', '\\"bibliographyStyleHasBeenSet\\":false');
            // Compatible with MS word integration.
            // default to data version 3
            dataStr = dataStr ? dataStr : defaultDocDataV3;
            return respond(dataStr);
        },

        cursorInField: function(args) {
            const docId = args[0];
            assert(docId === documentId);
            return respond(processor.getFieldsNearCursor(documentId));
        },

        insertField: function(args) {
            const docId = args[0];
            const fieldType = args[1];
            const noteType = args[2];
            assert(docId === documentId);
            assert(fieldType === 'Http');
            if (noteType > 1) {
                console.warn('Only support in-text and footnote citations, will use footnote instead!');
                noteType = 1;
            }
            const data = processor.insertField(docId, noteType > 0 ? true : false);
            return respond(data);
        },

        insertText: function(args) {
            const docId = args[0];
            const text = args[1];
            assert(docId === documentId);
            processor.insertRich(docId, text);
            return respond(null);
        },

        getFields: function(args) {
            const docId = args[0];
            assert(docId === documentId);
            const data = processor.getFields(docId, true);
            return respond(data);
        },

        convert: function(args) {
            const docId = args[0];
            const fieldIds = args[1];
            const toFieldType = args[2];
            const toNoteType = args[3];
            // NOTE: Count is undefined
            assert(docId === documentId);
            assert(toFieldType === 'Http');
            processor.convertToNoteType(docId, fieldIds, toNoteType);
            return respond(null);
        },

        convertPlaceholdersToFields: function(args) {
            // TODO: The meaning of this?
            zc_alert('该文档里的引文是「占位符」形式，本加载项暂不支持批量转成可刷新的域。请在 Word（装有 Zotero 插件）里打开并点一次 Refresh，再回到 WPS 使用。');
            return respond(null);
        },

        setBibliographyStyle: function(args) {
            const docId = args[0];
            const firstLineIndent = args[1];
            const indent = args[2];
            const lineSpacing = args[3];
            const entrySpacing = args[4]
            const tabStops = args[5];
            const tabStopsCount = args[6];
            assert(docId === documentId);
            processor.setBibStyle(docId, firstLineIndent, indent, lineSpacing, entrySpacing, tabStops, tabStopsCount);
            return respond(null);
        },

        complete: function(args) {
            delete args;
            // const docId = args[0];
            // assert(docId === documentId);
        },

        delete: function(args) {
            const docId = args[0];
            const fieldId = args[1];
            assert(docId === documentId);
            processor.deleteField(docId, fieldId);
            return respond(null);
        },

        select: function(args) {
            const docId = args[0];
            const fieldId = args[1];
            assert(docId === documentId);
            processor.selectField(docId, fieldId);
            return respond(null);
        },

        removeCode: function(args) {
            const docId = args[0];
            const fieldId = args[1];
            assert(docId === documentId);
            processor.removeFieldCode(docId, fieldId);
            return respond(null);
        },

        setText: function(args) {
            const docId = args[0];
            const fieldId = args[1];
            const text = args[2];
            const isRich = args[3];
            processor.setFieldText(docId, fieldId, text, isRich);
            return respond(null);
        },

        getText: function(args) {
            const docId = args[0];
            const fieldId = args[1];
            const text = processor.getFieldText(docId, fieldId);
            return respond(text);
        },

        setCode: function(args) {
            const docId = args[0];
            assert(docId === documentId);
            const fieldId = args[1];
            const code = args[2];
            processor.setFieldCode(documentId, fieldId, code);
            return respond(null);
        },

        exportDocument: function(args) {
            const docId = args[0];
            // args[1] == Http
            const msg = args[2];
            processor.exportDocument(docId);
            alert(msg);
            return respond(null);
        }
    }

    /**
     * Respond to word processor commands
    **/
    function autoRespond(req) {
        assert(req);
        const payload = req.payload;
        const method = payload.command.split('.')[1];
        const args = Array.from(payload.arguments);
        if (args.length > 0) { 
            var docID = args[0];
            assert(docID === documentId);
        }
        const ret = responders[method](args);
        return ret;
    }

    return {
        id: documentId,
        command: transact,
        export: () => { processor.exportDocument(documentId); },
        import: () => { processor.importDocument(documentId); }
    };
}

    