/* PaperPilot PDF 页面渲染 worker（0.42.0，移植自 jasminum pdf-render-worker.js）
 * 仅供 CNAI 视觉识别路径使用（pref cnFetchAIVision 默认关）。
 * 复用 Zotero 内置 pdf.js 渲染器；Zotero 10+ 可用，低版本加载即抛错，
 * 调用方（CNAI._renderPagesPNG）已 try/catch 兜底返回 null。
 */
importScripts("resource://zotero/document-worker/worker.js");

// PDF.js 的资源加载器与字体加载器在 worker 里也期望有 document。
self.document = {
  baseURI: self.location.href,
  fonts: self.fonts,
  createElement(name) {
    if (name === "canvas") return new OffscreenCanvas(1, 1);
    throw new Error("Unsupported PDF renderer element: " + name);
  },
};

self.onmessage = async ({ data }) => {
  try {
    const images = [];
    for (const pageIndex of data.pageIndexes) {
      const canvas = await self.worker.pdf.renderArea(
        data.buf.slice(0),
        pageIndex,
        [
          Number.MIN_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        ],
        {
          scale: data.scale,
          password: data.password,
          cMapUrl: "resource://zotero/reader/pdf/web/cmaps/",
          standardFontDataUrl: "resource://zotero/reader/pdf/web/standard_fonts/",
          wasmUrl: "resource://zotero/document-worker/wasm/",
        },
      );
      if (!canvas) throw new Error("Failed to render PDF page " + (pageIndex + 1));
      const blob = await canvas.convertToBlob({ type: "image/png" });
      images.push({ pageIndex, buf: await blob.arrayBuffer() });
    }
    self.postMessage({ images }, images.map(({ buf }) => buf));
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
