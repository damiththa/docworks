/**
 * Client-Side Binary & XML Metadata Inspector (100% In-Browser Memory).
 * Detects file formats from magic bytes and identifies hidden personal or device details
 * (GPS coordinates, author names, camera serials, embedded thumbnails, and comments)
 * that ScrubDoc strips automatically when saving a clean copy.
 */

function getElementsByLocalName(root, localName) {
  if (!root) return [];
  const out = [];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) out.push(all[i]);
  }
  return out;
}

function firstTextByLocalName(root, localName) {
  const match = getElementsByLocalName(root, localName)[0];
  return match ? (match.textContent || "").trim() : "";
}

export function detectFileFormatFromBytes(uint8, fallbackName = "") {
  const lower = (fallbackName || "").toLowerCase();
  if (uint8.length >= 5) {
    if (
      uint8[0] === 0x25 &&
      uint8[1] === 0x50 &&
      uint8[2] === 0x44 &&
      uint8[3] === 0x46 &&
      uint8[4] === 0x2d
    ) {
      return "pdf";
    }
    if (uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) {
      return "jpeg";
    }
    if (
      uint8[0] === 0x89 &&
      uint8[1] === 0x50 &&
      uint8[2] === 0x4e &&
      uint8[3] === 0x47
    ) {
      return "png";
    }
    if (
      uint8[0] === 0x52 &&
      uint8[1] === 0x49 &&
      uint8[2] === 0x46 &&
      uint8[3] === 0x46 &&
      uint8.length >= 12 &&
      uint8[8] === 0x57 &&
      uint8[9] === 0x45 &&
      uint8[10] === 0x42 &&
      uint8[11] === 0x50
    ) {
      return "webp";
    }
    if (uint8[0] === 0x50 && uint8[1] === 0x4b && uint8[2] === 0x03 && uint8[3] === 0x04) {
      if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
      if (lower.endsWith(".pptx") || lower.endsWith(".pptm")) return "pptx";
      return "docx";
    }
    if (uint8[0] === 0xd0 && uint8[1] === 0xcf && uint8[2] === 0x11 && uint8[3] === 0xe0) {
      return lower.endsWith(".doc") ? "doc" : "ole_encrypted";
    }
  }
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx") || lower.endsWith(".docm")) return "docx";
  if (lower.endsWith(".doc")) return "doc";
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  return "unknown";
}

export async function runMetadataXray(uint8, format) {
  const items = [];

  if (format === "jpeg" || format === "png" || format === "webp") {
    try {
      if (window.exifr) {
        const meta = await window.exifr.parse(uint8, {
          tiff: true,
          exif: true,
          gps: true,
          xmp: true,
          iptc: true,
          icc: false,
        });
        if (meta) {
          if (typeof meta.latitude === "number" && typeof meta.longitude === "number") {
            items.push({
              severity: "high",
              title: "Photo GPS location",
              detail: `${meta.latitude.toFixed(4)}°, ${meta.longitude.toFixed(4)}°`,
            });
          }
          const author = meta.Artist || meta.XPAuthor || meta.Creator || meta.Copyright;
          if (author) {
            items.push({
              severity: "high",
              title: "Author / photographer name",
              detail: String(author),
            });
          }
          const deviceParts = [meta.Make, meta.Model, meta.LensModel].filter(Boolean);
          if (deviceParts.length) {
            items.push({
              severity: "medium",
              title: "Camera or phone model",
              detail: deviceParts.join(" · "),
            });
          }
          const serial = meta.BodySerialNumber || meta.SerialNumber || meta.LensSerialNumber;
          if (serial) {
            items.push({
              severity: "high",
              title: "Device serial number",
              detail: String(serial),
            });
          }
          if (meta.Software || meta.DateTimeOriginal) {
            const info = [
              meta.Software ? String(meta.Software) : null,
              meta.DateTimeOriginal ? new Date(meta.DateTimeOriginal).toLocaleDateString() : null,
            ]
              .filter(Boolean)
              .join(" · ");
            if (info) {
              items.push({
                severity: "low",
                title: "App & capture date",
                detail: info,
              });
            }
          }
        }
        const thumb = await window.exifr.thumbnail(uint8).catch(() => null);
        if (thumb && thumb.byteLength > 0) {
          items.push({
            severity: "high",
            title: "Embedded preview thumbnail",
            detail: `${(thumb.byteLength / 1024).toFixed(0)} KB original preview image`,
          });
        }
      }
    } catch {
      // Non-fatal metadata parse fallback
    }
  } else if (format === "pdf") {
    try {
      const { PDFDocument } = window.PDFLib;
      const pdfDoc = await PDFDocument.load(uint8, { ignoreEncryption: true, updateMetadata: false });
      const author = (pdfDoc.getAuthor() || "").trim();
      const creator = (pdfDoc.getCreator() || "").trim();
      const producer = (pdfDoc.getProducer() || "").trim();
      const title = (pdfDoc.getTitle() || "").trim();
      const subject = (pdfDoc.getSubject() || "").trim();
      const keywords = (pdfDoc.getKeywords() || "").trim();
      const created = pdfDoc.getCreationDate();

      if (author) {
        items.push({ severity: "high", title: "Author name", detail: author });
      }
      if (title || subject || keywords) {
        items.push({
          severity: "medium",
          title: "Document title & tags",
          detail: [title, subject, keywords].filter(Boolean).join(" · "),
        });
      }
      if (creator || producer) {
        items.push({
          severity: "low",
          title: "Created with",
          detail: [creator, producer].filter(Boolean).join(" / "),
        });
      }
      if (created) {
        items.push({
          severity: "low",
          title: "Creation date",
          detail: created.toISOString().slice(0, 10),
        });
      }
      const rawSample = new TextDecoder("latin1").decode(uint8.subarray(0, Math.min(uint8.length, 500000)));
      if (rawSample.includes("<x:xmpmeta") || rawSample.includes("http://ns.adobe.com/xap/1.0/")) {
        items.push({
          severity: "low",
          title: "Embedded editing history",
          detail: "Document XMP property history",
        });
      }
    } catch {
      // Encrypted or malformed PDF fallback
    }
  } else if (format === "docx") {
    try {
      if (!window.JSZip) return items;
      const zip = await window.JSZip.loadAsync(uint8);
      const parser = new DOMParser();

      if (zip.file("docProps/core.xml")) {
        const xmlText = await zip.file("docProps/core.xml").async("string");
        const doc = parser.parseFromString(xmlText, "application/xml");
        const creator = firstTextByLocalName(doc, "creator");
        const lastModBy = firstTextByLocalName(doc, "lastModifiedBy");
        const revision = firstTextByLocalName(doc, "revision");
        const extraCore = [
          firstTextByLocalName(doc, "subject"),
          firstTextByLocalName(doc, "keywords"),
          firstTextByLocalName(doc, "description"),
        ].filter(Boolean);
        if (creator || lastModBy) {
          items.push({
            severity: "high",
            title: "Author & last editor",
            detail: [
              creator ? `Created by ${creator}` : null,
              lastModBy && lastModBy !== creator ? `Edited by ${lastModBy}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
        if (revision && parseInt(revision, 10) > 1) {
          items.push({
            severity: "low",
            title: "Revision count",
            detail: `${revision} saved editing sessions`,
          });
        }
        if (extraCore.length > 0) {
          items.push({
            severity: "low",
            title: "Document subject & tags",
            detail: extraCore.join(" · "),
          });
        }
      }

      if (zip.file("docProps/app.xml")) {
        const appXml = await zip.file("docProps/app.xml").async("string");
        const doc = parser.parseFromString(appXml, "application/xml");
        const company = firstTextByLocalName(doc, "Company");
        const manager = firstTextByLocalName(doc, "Manager");
        if (company || manager) {
          items.push({
            severity: "medium",
            title: "Organization details",
            detail: [company, manager].filter(Boolean).join(" · "),
          });
        }
      }

      if (zip.file("docProps/custom.xml")) {
        items.push({
          severity: "medium",
          title: "Custom Word properties",
          detail: "Hidden custom document properties attached",
        });
      }

      const hasThumb = Object.keys(zip.files).some((n) => /^docProps\/thumbnail\.[^/]+$/i.test(n));
      if (hasThumb) {
        items.push({
          severity: "low",
          title: "Embedded thumbnail",
          detail: "Cached preview image stored in file header",
        });
      }

      const hasComments = Object.keys(zip.files).some((n) =>
        /^word\/(comments(?:Extended|Ids|Extensible)?|people)\.xml$/i.test(n)
      );
      if (hasComments) {
        items.push({
          severity: "high",
          title: "Reviewer comments",
          detail: "Hidden Word comments or reviewer list attached to document",
        });
      }

      const contentXmlPaths = Object.keys(zip.files).filter((n) =>
        /^word\/(document\d*|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(n)
      );
      let hasTrackChanges = false;
      for (const path of contentXmlPaths) {
        const partXml = await zip.file(path).async("string");
        if (/<\s*(?:[A-Za-z0-9_-]+:)?(?:del|ins|moveFrom|moveTo|rPrChange|pPrChange)\b/i.test(partXml)) {
          hasTrackChanges = true;
          break;
        }
      }
      if (hasTrackChanges) {
        items.push({
          severity: "high",
          title: "Tracked changes",
          detail: "Unaccepted Word Track Changes present",
        });
      }
    } catch {
      // Handled cleanly during RedactorWorkspace.loadDocument
    }
  }

  return items;
}
