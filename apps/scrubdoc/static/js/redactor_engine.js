/**
 * Interactive Preview Canvas, PII/PHI Candidate Highlighter & Permanent Redaction Exporter.
 *
 * Security & UX design:
 *  - Pre-identified PII & PHI items open as clear amber see-through highlights (`enabled: false`)
 *    so users can inspect them in context, click any box on the page (or in the sidebar) 1-by-1,
 *    or click "Black Out All" in one step—while still dragging custom blackout boxes anywhere.
 *  - Digital PDFs scan instantaneously (< 40 ms); images & scanned PDF pages lazily invoke
 *    in-browser Wasm OCR (`ocr_engine.js`) asynchronously in the background without blocking UI.
 *  - Export burns #000000 directly into 250-DPI pixels (PDF/Image) or overwrites `<w:t>` XML runs
 *    with solid `█` block characters (`.docx`) so zero underlying characters survive.
 */

import { detectPiiInPlainText, detectPiiInTextItems } from "./pii_detector.js?v=14";
import { extractOcrTextItemsFromCanvas } from "./ocr_engine.js?v=11";

const DOCX_SKIP_READ_TAGS = new Set([
  "del",
  "moveFrom",
  "rPrChange",
  "pPrChange",
  "tblPrChange",
  "trPrChange",
  "tcPrChange",
  "sectPrChange",
]);

const DOCX_STRIP_TAGS = new Set([
  ...DOCX_SKIP_READ_TAGS,
  "moveFromRangeStart",
  "moveFromRangeEnd",
  "moveToRangeStart",
  "moveToRangeEnd",
]);

const DOCX_COMMENT_MARKER_TAGS = new Set([
  "commentRangeStart",
  "commentRangeEnd",
  "commentReference",
]);

const DOCX_REMOVABLE_REL_SUFFIXES = [
  "/comments",
  "/commentsExtended",
  "/commentsIds",
  "/commentsExtensible",
  "/people",
  "/custom-properties",
  "/thumbnail",
];

function getElementsByLocalName(root, localName) {
  const out = [];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) out.push(all[i]);
  }
  return out;
}

function isInsideSkippedDocxSubtree(node, stopAt) {
  let cur = node.parentNode;
  while (cur && cur !== stopAt) {
    if (cur.nodeType === 1 && (DOCX_SKIP_READ_TAGS.has(cur.localName) || cur.localName === "p")) {
      return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

function normalizeZipPath(rawPath) {
  const parts = String(rawPath || "").replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function resolveDocxMainPartPath(zip) {
  if (zip.file("word/document.xml")) return "word/document.xml";
  const relEntry = zip.file("_rels/.rels");
  if (!relEntry) return null;
  // Async resolution happens in resolveDocxMainPartPathAsync; keep sync fast-path clean.
  return null;
}

async function resolveDocxMainPartPathAsync(zip) {
  const direct = resolveDocxMainPartPath(zip);
  if (direct) return direct;
  const relEntry = zip.file("_rels/.rels");
  if (!relEntry) return null;
  const relXml = await relEntry.async("string");
  const relDoc = new DOMParser().parseFromString(relXml, "application/xml");
  for (const rel of getElementsByLocalName(relDoc, "Relationship")) {
    const type = rel.getAttribute("Type") || "";
    const target = rel.getAttribute("Target") || "";
    if (type.endsWith("/officeDocument") && target) {
      const normalized = normalizeZipPath(target);
      if (zip.file(normalized)) return normalized;
    }
  }
  return null;
}

function listDocxContentPaths(zip, mainPath) {
  const paths = Object.keys(zip.files).filter(
    (name) =>
      name === mainPath ||
      /^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(name)
  );
  const rank = (p) => {
    if (/^word\/header/i.test(p)) return 0;
    if (p === mainPath) return 1;
    if (/^word\/footnotes/i.test(p)) return 2;
    if (/^word\/endnotes/i.test(p)) return 3;
    return 4;
  };
  return paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function labelDocxPart(path, mainPath) {
  if (path === mainPath) return "Document Body";
  if (/^word\/header/i.test(path)) return "Header";
  if (/^word\/footer/i.test(path)) return "Footer";
  if (/^word\/footnotes/i.test(path)) return "Footnotes";
  if (/^word\/endnotes/i.test(path)) return "Endnotes";
  return "Word Section";
}

function collectDocxParagraphRuns(pNode) {
  let combined = "";
  const spans = [];

  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const ln = child.localName;
      if (DOCX_SKIP_READ_TAGS.has(ln) || ln === "p") continue;
      if (ln === "t") {
        const txt = child.textContent || "";
        spans.push({
          node: child,
          start: combined.length,
          end: combined.length + txt.length,
          chars: txt.split(""),
        });
        combined += txt;
      } else if (ln === "tab") {
        combined += "\t";
      } else if (ln === "br" || ln === "cr") {
        combined += "\n";
      } else {
        walk(child);
      }
    }
  };

  walk(pNode);
  return { combined, spans };
}

function extractReadableBlocksFromDoc(doc) {
  const lines = [];
  const root = getElementsByLocalName(doc, "body")[0] || doc.documentElement;
  if (!root) return lines;

  const visit = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const ln = child.localName;
      if (DOCX_SKIP_READ_TAGS.has(ln)) continue;
      if (ln === "p") {
        const { combined } = collectDocxParagraphRuns(child);
        if (combined.trim()) lines.push(combined);
        // Also inspect nested textboxes/drawings inside this paragraph for inner <w:p>s
        for (const innerP of getElementsByLocalName(child, "p")) {
          if (innerP === child || isInsideSkippedDocxSubtree(innerP, child)) continue;
          const inner = collectDocxParagraphRuns(innerP);
          if (inner.combined.trim()) lines.push(inner.combined);
        }
      } else if (ln === "tbl") {
        for (let rChild = child.firstChild; rChild; rChild = rChild.nextSibling) {
          if (rChild.nodeType !== 1) continue;
          if (rChild.localName === "tr") {
            const cells = [];
            for (let cChild = rChild.firstChild; cChild; cChild = cChild.nextSibling) {
              if (cChild.nodeType === 1 && cChild.localName === "tc") {
                const cellLines = [];
                for (const pNode of getElementsByLocalName(cChild, "p")) {
                  if (isInsideSkippedDocxSubtree(pNode, cChild)) continue;
                  const { combined } = collectDocxParagraphRuns(pNode);
                  if (combined.trim()) cellLines.push(combined.trim());
                }
                const cellText = cellLines.join(" ");
                if (cellText) cells.push(cellText);
              }
            }
            if (cells.length > 0) lines.push(cells.join(" | "));
          }
        }
      } else {
        visit(child);
      }
    }
  };

  visit(root);
  return lines;
}

function ensurePdfWorkerConfigured() {
  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";
  }
}
ensurePdfWorkerConfigured();

export class RedactorWorkspace {
  constructor(canvasEl, onStateChange, onHoverChange = null) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.onStateChange = onStateChange;
    this.onHoverChange = onHoverChange;

    this.format = null;
    this.rawBytes = null;
    this.pdfDocProxy = null;
    this.imageBitmap = null;
    this.pageCount = 1;
    this.currentPage = 0; // 0-indexed
    this.basePageCanvas = document.createElement("canvas");

    this.autoFindings = [];
    this.manualBoxes = [];
    this.docxPreviewSections = [];
    this.hoveredFindingId = null;
    this.isOcrScanning = false;
    this.ocrStatusText = "";
    this._loadToken = 0;

    this._dragStart = null;
    this._dragCurrent = null;

    this._bindPointerEvents();
  }

  _findHitAutoFinding(normX, normY) {
    const pad = 0.004;
    // Search reverse order so top-most drawn box wins
    for (let i = this.autoFindings.length - 1; i >= 0; i--) {
      const f = this.autoFindings[i];
      if (f.isDocxText || f.pageIndex !== this.currentPage || !f.rectNorm) continue;
      const r = f.rectNorm;
      if (
        normX >= r.x - pad &&
        normX <= r.x + r.w + pad &&
        normY >= r.y - pad &&
        normY <= r.y + r.h + pad
      ) {
        return f;
      }
    }
    return null;
  }

  _bindPointerEvents() {
    const getNormCoords = (evt) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (evt.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(1, (evt.clientY - rect.top) / Math.max(1, rect.height))),
      };
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.rawBytes || this.format === "docx") return;
      this.canvas.setPointerCapture?.(e.pointerId);
      this._dragStart = getNormCoords(e);
      this._dragCurrent = this._dragStart;
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.rawBytes || this.format === "docx") return;
      const pt = getNormCoords(e);
      if (!this._dragStart) {
        const hit = this._findHitAutoFinding(pt.x, pt.y);
        this.canvas.style.cursor = hit ? "pointer" : "crosshair";
        return;
      }
      this._dragCurrent = pt;
      this.redrawOverlay();
    });

    const finishDrag = () => {
      if (!this._dragStart || !this._dragCurrent) return;
      const x = Math.min(this._dragStart.x, this._dragCurrent.x);
      const y = Math.min(this._dragStart.y, this._dragCurrent.y);
      const w = Math.abs(this._dragCurrent.x - this._dragStart.x);
      const h = Math.abs(this._dragCurrent.y - this._dragStart.y);
      const clickPt = this._dragCurrent;
      this._dragStart = null;
      this._dragCurrent = null;

      if (w <= 0.009 && h <= 0.009) {
        // Quick click/tap: toggle highlighted PII/PHI box 1-by-1 directly on the page!
        const hit = this._findHitAutoFinding(clickPt.x, clickPt.y);
        if (hit) {
          hit.enabled = !hit.enabled;
          this.onStateChange?.();
        }
      } else if (w > 0.01 && h > 0.008) {
        // Drag gesture: add custom blackout rectangle
        this.manualBoxes.push({
          id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          pageIndex: this.currentPage,
          rectNorm: { x, y, w, h },
        });
        this.onStateChange?.();
      }
      this.redrawOverlay();
    };

    this.canvas.addEventListener("pointerup", finishDrag);
    this.canvas.addEventListener("pointercancel", finishDrag);
  }

  async loadDocument(uint8, format) {
    const token = ++this._loadToken;
    this.rawBytes = uint8;
    this.format = format;
    this.autoFindings = [];
    this.manualBoxes = [];
    this.docxPreviewSections = [];
    this.hoveredFindingId = null;
    this.isOcrScanning = false;
    this.ocrStatusText = "";
    this.currentPage = 0;
    this.pdfDocProxy = null;
    this.imageBitmap = null;

    if (format === "doc") {
      throw new Error("Legacy binary .doc files are not supported in browser. Save as .docx and reopen.");
    }
    if (format === "ole_encrypted") {
      throw new Error("This Word file is password-protected or encrypted. Remove the password first.");
    }
    if (format === "unknown" || format === "xlsx" || format === "pptx") {
      throw new Error("Unsupported file type. ScrubDoc supports PDF, Word (.docx), JPEG, PNG, and WebP.");
    }

    if (format === "pdf") {
      ensurePdfWorkerConfigured();
      const workerCopy = uint8.slice();
      this.pdfDocProxy = await window.pdfjsLib.getDocument({ data: workerCopy }).promise;
      this.pageCount = this.pdfDocProxy.numPages;

      // Render Page 1 AND extract Page 1 text concurrently so multi-page PDFs open instantaneously!
      const [firstPageScan] = await Promise.all([
        this._extractSinglePdfPageItems(0),
        this.renderPage(0),
      ]);
      this.autoFindings = detectPiiInTextItems(firstPageScan.items);
      this.redrawOverlay();
      this.onStateChange?.();

      // Progressively scan Pages 2..40 + run lazy OCR on any scanned pages in the background
      this._scanRemainingPdfPagesInBackground(token, firstPageScan.isScanned);
      return;
    }

    if (format === "jpeg" || format === "png" || format === "webp") {
      const blob = new Blob([uint8]);
      this.imageBitmap = await createImageBitmap(blob);
      this.pageCount = 1;
      await this.renderPage(0);
      this.onStateChange?.();

      // Lazy-run Wasm OCR in background so image opens instantaneously with 0 blocking
      this._runBackgroundImageOcr(token);
      return;
    }

    if (format === "docx") {
      this.pageCount = 1;
      await this._extractDocxTextAndDetectPii(uint8);
      this.onStateChange?.();
    }
  }

  async _extractSinglePdfPageItems(pageIdx) {
    const page = await this.pdfDocProxy.getPage(pageIdx + 1);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    const items = [];
    let charCountOnPage = 0;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      charCountOnPage += item.str.trim().length;
      const tx = item.transform[4];
      const ty = item.transform[5];
      const fontH = Math.hypot(item.transform[2], item.transform[3]) || Math.abs(item.height) || 11;
      const itemW = item.width || item.str.length * (fontH * 0.52);

      const normX = tx / viewport.width;
      const normY = (viewport.height - ty - fontH * 0.88) / viewport.height;
      const normW = itemW / viewport.width;
      const normH = (fontH * 1.18) / viewport.height;

      items.push({
        str: item.str,
        pageIndex: pageIdx,
        bbox: [normX, normY, normW, normH],
      });
    }

    return { items, isScanned: charCountOnPage < 8 };
  }

  async _scanRemainingPdfPagesInBackground(token, firstPageWasScanned) {
    const scannedPageIndices = firstPageWasScanned ? [0] : [];
    const maxScanPages = Math.min(this.pageCount, 40);

    for (let p = 1; p < maxScanPages; p++) {
      if (token !== this._loadToken || !this.pdfDocProxy) return;
      const { items, isScanned } = await this._extractSinglePdfPageItems(p);
      if (token !== this._loadToken) return;

      if (isScanned) {
        scannedPageIndices.push(p);
      } else if (items.length > 0) {
        const pageFindings = detectPiiInTextItems(items).map((f, idx) => ({
          ...f,
          id: `pii-p${p}-${idx + 1}`,
        }));
        if (pageFindings.length > 0) {
          this.autoFindings.push(...pageFindings);
          if (this.currentPage === p) {
            this.redrawOverlay();
          }
          this.onStateChange?.();
        }
      }
    }

    if (scannedPageIndices.length > 0 && token === this._loadToken) {
      await this._runBackgroundPdfOcr(scannedPageIndices.slice(0, 8), token);
    }
  }

  async _runBackgroundImageOcr(token) {
    if (!this.imageBitmap || token !== this._loadToken) return;
    this.isOcrScanning = true;
    this.ocrStatusText = "Scanning image text for PII & PHI...";
    this.onStateChange?.();

    try {
      const maxOcrDim = 1800;
      const scale = Math.min(1, maxOcrDim / Math.max(this.imageBitmap.width, this.imageBitmap.height));
      const ocrCanvas = document.createElement("canvas");
      ocrCanvas.width = Math.max(1, Math.floor(this.imageBitmap.width * scale));
      ocrCanvas.height = Math.max(1, Math.floor(this.imageBitmap.height * scale));
      const octx = ocrCanvas.getContext("2d");
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
      octx.drawImage(this.imageBitmap, 0, 0, ocrCanvas.width, ocrCanvas.height);

      const ocrWords = await extractOcrTextItemsFromCanvas(ocrCanvas, 0);
      if (token !== this._loadToken) return;

      this.autoFindings = detectPiiInTextItems(ocrWords);
    } catch {
      // Non-fatal: manual redaction remains fully available even if OCR fails
    } finally {
      if (token === this._loadToken) {
        this.isOcrScanning = false;
        this.ocrStatusText = "";
        this.redrawOverlay();
        this.onStateChange?.();
      }
    }
  }

  async _runBackgroundPdfOcr(pageIndices, token) {
    if (!this.pdfDocProxy || token !== this._loadToken) return;
    this.isOcrScanning = true;
    this.onStateChange?.();

    try {
      for (let i = 0; i < pageIndices.length; i++) {
        if (token !== this._loadToken) return;
        const pageIdx = pageIndices[i];
        this.ocrStatusText =
          pageIndices.length > 1
            ? `Scanning scanned page ${pageIdx + 1} for PII & PHI...`
            : "Scanning page image for PII & PHI...";
        this.onStateChange?.();

        const page = await this.pdfDocProxy.getPage(pageIdx + 1);
        const viewport = page.getViewport({ scale: 2.0 });
        const ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.floor(viewport.width);
        ocrCanvas.height = Math.floor(viewport.height);
        const octx = ocrCanvas.getContext("2d");
        octx.fillStyle = "#ffffff";
        octx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
        await page.render({ canvasContext: octx, viewport }).promise;

        const ocrWords = await extractOcrTextItemsFromCanvas(ocrCanvas, pageIdx);
        if (token !== this._loadToken) return;

        const pageFindings = detectPiiInTextItems(ocrWords).map((f, idx) => ({
          ...f,
          id: `ocr-pii-${pageIdx}-${idx + 1}`,
        }));

        if (pageFindings.length > 0) {
          this.autoFindings.push(...pageFindings);
          this.autoFindings.sort(
            (a, b) =>
              a.pageIndex - b.pageIndex ||
              (a.rectNorm?.y || 0) - (b.rectNorm?.y || 0) ||
              (a.rectNorm?.x || 0) - (b.rectNorm?.x || 0)
          );
          if (this.currentPage === pageIdx) {
            this.redrawOverlay();
          }
          this.onStateChange?.();
        }
      }
    } catch {
      // Non-fatal fallback
    } finally {
      if (token === this._loadToken) {
        this.isOcrScanning = false;
        this.ocrStatusText = "";
        this.redrawOverlay();
        this.onStateChange?.();
      }
    }
  }

  async _extractDocxTextAndDetectPii(uint8) {
    if (!window.JSZip) {
      throw new Error("Word archive engine (JSZip) is still loading. Please try again.");
    }

    let zip;
    try {
      zip = await window.JSZip.loadAsync(uint8.slice());
    } catch {
      throw new Error("Unable to open this .docx archive. It may be corrupted or encrypted.");
    }

    if (zip.file("EncryptedPackage")) {
      throw new Error("This Word (.docx) file is password-protected or encrypted. Decrypt it first.");
    }

    const mainPath = await resolveDocxMainPartPathAsync(zip);
    if (!mainPath || !zip.file(mainPath)) {
      throw new Error("Invalid Word (.docx) document: missing main document XML.");
    }

    const parser = new DOMParser();
    const xmlTargets = listDocxContentPaths(zip, mainPath);
    const sections = [];
    const allLines = [];

    for (const path of xmlTargets) {
      const xmlStr = await zip.file(path).async("string");
      const doc = parser.parseFromString(xmlStr, "application/xml");
      if (doc.getElementsByTagName("parsererror").length > 0) continue;
      const lines = extractReadableBlocksFromDoc(doc);
      if (lines.length > 0) {
        sections.push({ path, title: labelDocxPart(path, mainPath), lines });
        allLines.push(...lines);
      }
    }

    this.docxPreviewSections = sections;
    this.autoFindings = detectPiiInPlainText(allLines.join("\n"));
  }

  setAllAutoFindings(enabled, categoryFilter = "all") {
    for (const f of this.autoFindings) {
      if (categoryFilter === "all" || f.category === categoryFilter) {
        f.enabled = enabled;
      }
    }
    this.redrawOverlay();
    this.onStateChange?.();
  }

  setHoveredFinding(findingId) {
    if (this.hoveredFindingId === findingId) return;
    this.hoveredFindingId = findingId;
    if (this.format === "docx") {
      this.onHoverChange?.(findingId);
    } else {
      this.redrawOverlay();
    }
  }

  async renderPage(pageIdx) {
    this.currentPage = Math.max(0, Math.min(this.pageCount - 1, pageIdx));
    if (this.format === "docx") return;

    if (this.format === "pdf" && this.pdfDocProxy) {
      const page = await this.pdfDocProxy.getPage(this.currentPage + 1);
      const viewport = page.getViewport({ scale: 1.4 });
      this.basePageCanvas.width = Math.floor(viewport.width);
      this.basePageCanvas.height = Math.floor(viewport.height);
      const baseCtx = this.basePageCanvas.getContext("2d");
      baseCtx.fillStyle = "#ffffff";
      baseCtx.fillRect(0, 0, this.basePageCanvas.width, this.basePageCanvas.height);
      await page.render({ canvasContext: baseCtx, viewport }).promise;
    } else if (this.imageBitmap) {
      const maxDim = 1100;
      const scale = Math.min(1, maxDim / Math.max(this.imageBitmap.width, this.imageBitmap.height));
      this.basePageCanvas.width = Math.max(1, Math.floor(this.imageBitmap.width * scale));
      this.basePageCanvas.height = Math.max(1, Math.floor(this.imageBitmap.height * scale));
      const baseCtx = this.basePageCanvas.getContext("2d");
      baseCtx.drawImage(this.imageBitmap, 0, 0, this.basePageCanvas.width, this.basePageCanvas.height);
    }

    this.canvas.width = this.basePageCanvas.width;
    this.canvas.height = this.basePageCanvas.height;
    this.redrawOverlay();
  }

  redrawOverlay() {
    if (this.format === "docx") return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(this.basePageCanvas, 0, 0);

    // Draw Auto-Detected PII & PHI boxes on current page
    for (const f of this.autoFindings) {
      if (f.isDocxText || f.pageIndex !== this.currentPage || !f.rectNorm) continue;
      const rx = f.rectNorm.x * w;
      const ry = f.rectNorm.y * h;
      const rw = f.rectNorm.w * w;
      const rh = f.rectNorm.h * h;

      if (f.enabled) {
        // Selected -> Solid blackout bar
        this.ctx.fillStyle = "#0f172a";
        this.ctx.fillRect(rx, ry, rw, rh);
        this.ctx.strokeStyle = "#059669";
        this.ctx.lineWidth = 1.25;
        this.ctx.strokeRect(rx, ry, rw, rh);
      } else {
        // Default -> Readable warm highlighter tint so user can inspect & click to black out
        this.ctx.fillStyle = "rgba(245, 158, 11, 0.24)";
        this.ctx.fillRect(rx, ry, rw, rh);
        this.ctx.strokeStyle = "#d97706";
        this.ctx.lineWidth = 1.6;
        this.ctx.strokeRect(rx, ry, rw, rh);
      }

      if (this.hoveredFindingId === f.id) {
        this.ctx.strokeStyle = "#0061d5";
        this.ctx.lineWidth = 2.5;
        this.ctx.strokeRect(Math.max(0, rx - 3), Math.max(0, ry - 3), rw + 6, rh + 6);
      }
    }

    // Draw Manual Custom Redaction boxes on current page
    for (const m of this.manualBoxes) {
      if (m.pageIndex !== this.currentPage) continue;
      this.ctx.fillStyle = "#0f172a";
      this.ctx.fillRect(m.rectNorm.x * w, m.rectNorm.y * h, m.rectNorm.w * w, m.rectNorm.h * h);
    }

    // Calm Box-Blue selection rectangle while dragging custom blackout area
    if (this._dragStart && this._dragCurrent) {
      const dx = Math.min(this._dragStart.x, this._dragCurrent.x) * w;
      const dy = Math.min(this._dragStart.y, this._dragCurrent.y) * h;
      const dw = Math.abs(this._dragCurrent.x - this._dragStart.x) * w;
      const dh = Math.abs(this._dragCurrent.y - this._dragStart.y) * h;
      if (dw > 4 || dh > 4) {
        this.ctx.fillStyle = "rgba(0, 97, 213, 0.18)";
        this.ctx.fillRect(dx, dy, dw, dh);
        this.ctx.strokeStyle = "#0061d5";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(dx, dy, dw, dh);
      }
    }
  }

  undoLastManualBox() {
    for (let i = this.manualBoxes.length - 1; i >= 0; i--) {
      if (this.manualBoxes[i].pageIndex === this.currentPage) {
        this.manualBoxes.splice(i, 1);
        this.redrawOverlay();
        this.onStateChange?.();
        return;
      }
    }
    if (this.manualBoxes.length > 0) {
      this.manualBoxes.pop();
      this.redrawOverlay();
      this.onStateChange?.();
    }
  }

  clearManualBoxes() {
    this.manualBoxes = [];
    this.redrawOverlay();
    this.onStateChange?.();
  }

  _boxesForPage(pageIdx) {
    const boxes = [];
    for (const f of this.autoFindings) {
      if (!f.isDocxText && f.enabled && f.pageIndex === pageIdx && f.rectNorm) {
        boxes.push(f.rectNorm);
      }
    }
    for (const m of this.manualBoxes) {
      if (m.pageIndex === pageIdx) boxes.push(m.rectNorm);
    }
    return boxes;
  }

  _scrubDocxXmlDocument(xmlStr, secretsToScrub) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return xmlStr;

    let mutatedXml = false;

    // 1. Strip Word comment anchors (`commentRangeStart`, `commentRangeEnd`, `commentReference`)
    const markerNodes = Array.from(doc.getElementsByTagName("*")).filter((el) =>
      DOCX_COMMENT_MARKER_TAGS.has(el.localName)
    );
    for (const marker of markerNodes) {
      const parentRun = marker.parentNode;
      if (parentRun) {
        parentRun.removeChild(marker);
        mutatedXml = true;
        if (parentRun.nodeType === 1 && parentRun.localName === "r" && parentRun.parentNode) {
          const hasSubstantiveChild = Array.from(parentRun.childNodes).some(
            (ch) =>
              (ch.nodeType === 1 && ch.localName !== "rPr") ||
              (ch.nodeType === 3 && (ch.nodeValue || "").trim().length > 0)
          );
          if (!hasSubstantiveChild) {
            parentRun.parentNode.removeChild(parentRun);
          }
        }
      }
    }

    // 2. Remove unaccepted deletions & metadata-bearing property change history nodes
    const stripNodes = Array.from(doc.getElementsByTagName("*")).filter((el) =>
      DOCX_STRIP_TAGS.has(el.localName)
    );
    for (const node of stripNodes) {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
        mutatedXml = true;
      }
    }

    // 3. Accept/unwrap <w:ins> & <w:moveTo> so inserted text stays cleanly without author/date leaks
    const insNodes = Array.from(doc.getElementsByTagName("*")).filter(
      (el) => el.localName === "ins" || el.localName === "moveTo"
    );
    for (let i = insNodes.length - 1; i >= 0; i--) {
      const ins = insNodes[i];
      const parent = ins.parentNode;
      if (!parent) continue;
      while (ins.firstChild) {
        parent.insertBefore(ins.firstChild, ins);
      }
      parent.removeChild(ins);
      mutatedXml = true;
    }

    // 4. Permanently overwrite selected PII & PHI text inside <w:t> runs with `█`
    if (secretsToScrub.length > 0) {
      const pNodes = getElementsByLocalName(doc, "p");
      for (const p of pNodes) {
        const { combined, spans } = collectDocxParagraphRuns(p);
        if (!combined || spans.length === 0) continue;

        let pMutated = false;
        for (const secret of secretsToScrub) {
          if (!secret) continue;
          let fromIdx = 0;
          while (fromIdx <= combined.length - secret.length) {
            const hitIdx = combined.indexOf(secret, fromIdx);
            if (hitIdx === -1) break;
            const hitEnd = hitIdx + secret.length;
            for (const sp of spans) {
              const ovStart = Math.max(hitIdx, sp.start);
              const ovEnd = Math.min(hitEnd, sp.end);
              for (let pos = ovStart; pos < ovEnd; pos++) {
                sp.chars[pos - sp.start] = "█";
                pMutated = true;
                mutatedXml = true;
              }
            }
            fromIdx = hitEnd;
          }
        }

        if (pMutated) {
          for (const sp of spans) {
            const nextText = sp.chars.join("");
            sp.node.textContent = nextText;
            if (/^\s|\s$/.test(nextText)) {
              sp.node.setAttribute("xml:space", "preserve");
            }
          }
        }
      }
    }

    return mutatedXml ? new XMLSerializer().serializeToString(doc) : xmlStr;
  }

  async _cleanDocxPackageMetadata(zip) {
    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    const removedPathsLower = new Set();

    for (const path of Object.keys(zip.files)) {
      if (
        /^docProps\/custom\.xml$/i.test(path) ||
        /^docProps\/thumbnail\.[^/]+$/i.test(path) ||
        /^word\/(comments(?:Extended|Ids|Extensible)?|people)\.xml$/i.test(path)
      ) {
        zip.remove(path);
        removedPathsLower.add(normalizeZipPath(path).toLowerCase());
      }
    }

    if (zip.file("[Content_Types].xml") && removedPathsLower.size > 0) {
      const ctXml = await zip.file("[Content_Types].xml").async("string");
      const ctDoc = parser.parseFromString(ctXml, "application/xml");
      if (ctDoc.getElementsByTagName("parsererror").length === 0) {
        let ctChanged = false;
        for (const ov of getElementsByLocalName(ctDoc, "Override")) {
          const partNorm = normalizeZipPath(ov.getAttribute("PartName") || "").toLowerCase();
          if (removedPathsLower.has(partNorm) && ov.parentNode) {
            ov.parentNode.removeChild(ov);
            ctChanged = true;
          }
        }
        if (ctChanged) {
          zip.file("[Content_Types].xml", serializer.serializeToString(ctDoc));
        }
      }
    }

    const relPaths = Object.keys(zip.files).filter((n) => /(?:^|\/)_rels\/[^/]*\.rels$/i.test(n));
    for (const relPath of relPaths) {
      const relXml = await zip.file(relPath).async("string");
      const relDoc = parser.parseFromString(relXml, "application/xml");
      if (relDoc.getElementsByTagName("parsererror").length > 0) continue;

      const baseDir = relPath.replace(/(^|\/)_rels\/[^/]*$/i, "$1");
      let relChanged = false;
      for (const rel of getElementsByLocalName(relDoc, "Relationship")) {
        const targetMode = (rel.getAttribute("TargetMode") || "").toLowerCase();
        const target = rel.getAttribute("Target") || "";
        const type = rel.getAttribute("Type") || "";
        const resolved =
          targetMode === "external"
            ? ""
            : normalizeZipPath(target.startsWith("/") ? target : baseDir + target).toLowerCase();
        const shouldDrop =
          (resolved && removedPathsLower.has(resolved)) ||
          DOCX_REMOVABLE_REL_SUFFIXES.some((sfx) => type.endsWith(sfx));
        if (shouldDrop && rel.parentNode) {
          rel.parentNode.removeChild(rel);
          relChanged = true;
        }
      }
      if (relChanged) {
        zip.file(relPath, serializer.serializeToString(relDoc));
      }
    }
  }

  /**
   * Produces a 100% metadata-scrubbed, permanently redacted output binary.
   */
  async exportSanitizedBytes({ flattenAllPages = false } = {}) {
    if (this.format === "jpeg" || this.format === "png" || this.format === "webp") {
      const outCanvas = document.createElement("canvas");
      outCanvas.width = this.imageBitmap.width;
      outCanvas.height = this.imageBitmap.height;
      const octx = outCanvas.getContext("2d");
      octx.drawImage(this.imageBitmap, 0, 0);

      const boxes = this._boxesForPage(0);
      octx.fillStyle = "#000000";
      for (const b of boxes) {
        octx.fillRect(
          Math.floor(b.x * outCanvas.width),
          Math.floor(b.y * outCanvas.height),
          Math.ceil(b.w * outCanvas.width),
          Math.ceil(b.h * outCanvas.height)
        );
      }

      const outMime = this.format === "png" ? "image/png" : "image/jpeg";
      const outExt = this.format === "png" ? ".png" : ".jpg";
      const blob = await new Promise((res) => outCanvas.toBlob(res, outMime, 0.94));
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: outMime,
        extension: outExt,
      };
    }

    if (this.format === "pdf") {
      const { PDFDocument, PDFName } = window.PDFLib;
      // updateMetadata: false prevents pdf-lib from injecting Producer/Creator/CreationDate into /Info
      const outPdf = await PDFDocument.create({ updateMetadata: false });

      let srcPdfLibDoc = null;

      for (let p = 0; p < this.pageCount; p++) {
        const boxes = this._boxesForPage(p);
        const mustRasterize = flattenAllPages || boxes.length > 0;

        if (mustRasterize) {
          const pdfPage = await this.pdfDocProxy.getPage(p + 1);
          const origVp = pdfPage.getViewport({ scale: 1.0 });
          const renderScale = 250 / 72;
          const hiVp = pdfPage.getViewport({ scale: renderScale });

          const offCanvas = document.createElement("canvas");
          offCanvas.width = Math.floor(hiVp.width);
          offCanvas.height = Math.floor(hiVp.height);
          const offCtx = offCanvas.getContext("2d");
          offCtx.fillStyle = "#ffffff";
          offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
          await pdfPage.render({ canvasContext: offCtx, viewport: hiVp }).promise;

          offCtx.fillStyle = "#000000";
          for (const b of boxes) {
            offCtx.fillRect(
              Math.floor(b.x * offCanvas.width),
              Math.floor(b.y * offCanvas.height),
              Math.ceil(b.w * offCanvas.width),
              Math.ceil(b.h * offCanvas.height)
            );
          }

          const jpgBlob = await new Promise((res) => offCanvas.toBlob(res, "image/jpeg", 0.91));
          const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
          const embeddedJpg = await outPdf.embedJpg(jpgBytes);
          const addedPage = outPdf.addPage([origVp.width, origVp.height]);
          addedPage.drawImage(embeddedJpg, {
            x: 0,
            y: 0,
            width: origVp.width,
            height: origVp.height,
          });
        } else {
          if (!srcPdfLibDoc) {
            srcPdfLibDoc = await PDFDocument.load(this.rawBytes, {
              ignoreEncryption: true,
              updateMetadata: false,
            });
          }
          const [copiedPage] = await outPdf.copyPages(srcPdfLibDoc, [p]);
          copiedPage.node.delete(PDFName.of("Annots"));
          copiedPage.node.delete(PDFName.of("Metadata"));
          copiedPage.node.delete(PDFName.of("PieceInfo"));
          outPdf.addPage(copiedPage);
        }
      }

      // Physically delete document-level XMP /Metadata, /PieceInfo, and trailer /Info dictionary
      outPdf.catalog.delete(PDFName.of("Metadata"));
      outPdf.catalog.delete(PDFName.of("PieceInfo"));
      if (outPdf.context?.trailerInfo) {
        delete outPdf.context.trailerInfo.Info;
      }

      const finalPdfBytes = await outPdf.save({ useObjectStreams: true });
      return {
        bytes: finalPdfBytes,
        mimeType: "application/pdf",
        extension: ".pdf",
      };
    }

    if (this.format === "docx") {
      if (!window.JSZip) {
        throw new Error("Word archive engine (JSZip) is not loaded.");
      }
      const zip = await window.JSZip.loadAsync(this.rawBytes.slice());
      const mainPath = (await resolveDocxMainPartPathAsync(zip)) || "word/document.xml";

      const cleanCoreXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        "<dc:title></dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy>" +
        "</cp:coreProperties>";
      const cleanAppXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        "<Company></Company><Manager></Manager></Properties>";

      if (zip.file("docProps/core.xml")) {
        zip.file("docProps/core.xml", cleanCoreXml);
      }
      if (zip.file("docProps/app.xml")) {
        zip.file("docProps/app.xml", cleanAppXml);
      }

      await this._cleanDocxPackageMetadata(zip);

      // Always strip comments/tracked-change history AND overwrite any selected PII/PHI runs with `█`
      const secretsToScrub = this.autoFindings
        .filter((f) => f.enabled && f.rawValue)
        .map((f) => f.rawValue)
        .sort((a, b) => b.length - a.length);

      const xmlTargets = listDocxContentPaths(zip, mainPath);
      for (const path of xmlTargets) {
        const rawXml = await zip.file(path).async("string");
        const scrubbedXml = this._scrubDocxXmlDocument(rawXml, secretsToScrub);
        if (scrubbedXml !== rawXml) {
          zip.file(path, scrubbedXml);
        }
      }

      const outArrayBuffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return {
        bytes: outArrayBuffer,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: ".docx",
      };
    }

    throw new Error("Unsupported file format.");
  }
}
