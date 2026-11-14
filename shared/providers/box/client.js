/**
 * Browser-Direct Box.com CORS API Client (Memory-Only Session Token).
 * Shared across the DocWorks Suite (ScrubDoc & DiffDoc) for Box.
 * Communicates directly between the user's browser and api.box.com / upload.box.com
 * so zero user files, version diffs, filenames, or shared links ever transit our GCP server.
 */

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";

export const SNAPSHOT_FILENAME = "_docworks_radar_snapshot.json";
export const LEGACY_SNAPSHOT_FILENAME = "_safeshare_radar_snapshot.json";

export class BoxProviderClient {
  constructor(accessToken, capabilities = {}) {
    this._token = accessToken;
    this._meCache = null;
    this.providerId = "box";
    this.providerName = "Box";
    this.snapshotFilename = SNAPSHOT_FILENAME;
    this.legacySnapshotFilename = LEGACY_SNAPSHOT_FILENAME;
    this.capabilities = {
      supports_version_history: true,
      supports_collaborators: true,
      supports_link_expiry: true,
      supports_download_disable: true,
      supports_link_password: true,
      supports_public_link_stats: true,
      ...capabilities,
    };
  }

  _authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this._token}`,
      ...extra,
    };
  }

  async _jsonFetch(url, options = {}) {
    const resp = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: this._authHeaders(options.headers || {}),
    });
    if (resp.status === 204) return null;
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    if (!resp.ok) {
      const msg = (body && (body.message || body.error_description)) || `Box API error (${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      err.boxBody = body;
      throw err;
    }
    return body;
  }

  async getCurrentUser() {
    if (this._meCache) return this._meCache;
    this._meCache = await this._jsonFetch(`${BOX_API}/users/me?fields=id,name,login`);
    return this._meCache;
  }

  async getFileMetadata(fileId) {
    const fields = [
      "id",
      "name",
      "size",
      "sha1",
      "extension",
      "parent",
      "file_version",
      "version_number",
      "created_at",
      "content_modified_at",
      "modified_at",
      "modified_by",
      "shared_link",
      "permissions",
    ].join(",");
    return this._jsonFetch(`${BOX_API}/files/${encodeURIComponent(fileId)}?fields=${fields}`);
  }

  async getFolderMetadata(folderId) {
    const fields = "id,name,parent,shared_link,created_at,content_modified_at,permissions";
    return this._jsonFetch(`${BOX_API}/folders/${encodeURIComponent(folderId)}?fields=${fields}`);
  }

  /**
   * Lists prior historical versions of a Box file (`GET /2.0/files/:id/versions`).
   * Gracefully returns `{ entries: [], restricted: true }` if the Box plan restricts version history.
   */
  async listFileVersions(fileId) {
    const fields = "id,sha1,name,size,created_at,modified_at,modified_by,version_number";
    try {
      const data = await this._jsonFetch(
        `${BOX_API}/files/${encodeURIComponent(fileId)}/versions?fields=${fields}&limit=100`
      );
      return {
        entries: data && Array.isArray(data.entries) ? data.entries : [],
        restricted: false,
      };
    } catch (err) {
      if (err && (err.status === 403 || err.status === 404)) {
        return { entries: [], restricted: err.status === 403 };
      }
      throw err;
    }
  }

  /**
   * Merges historical versions (`listFileVersions`) with the active current version (`fileMeta`)
   * ordered oldest (`v1`) -> newest (`vN Current`).
   */
  buildVersionTimeline(fileMeta, versionsResp) {
    const currentVerId = fileMeta.file_version ? String(fileMeta.file_version.id) : `current-${fileMeta.id}`;
    const rawPrior = versionsResp && Array.isArray(versionsResp.entries) ? versionsResp.entries : [];

    const dedup = new Map();
    for (const v of rawPrior) {
      const vid = String(v.id);
      if (vid === currentVerId) continue;
      dedup.set(vid, {
        versionId: vid,
        isCurrent: false,
        name: v.name || fileMeta.name,
        size: typeof v.size === "number" ? v.size : fileMeta.size,
        sha1: v.sha1 || "",
        timestamp: v.modified_at || v.created_at || "",
        author: (v.modified_by && v.modified_by.name) || "",
        explicitNumber: v.version_number ? parseInt(v.version_number, 10) : null,
      });
    }

    const priorList = Array.from(dedup.values()).sort((a, b) => {
      if (a.explicitNumber && b.explicitNumber && a.explicitNumber !== b.explicitNumber) {
        return a.explicitNumber - b.explicitNumber;
      }
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return ta - tb;
    });

    const currentEntry = {
      versionId: currentVerId,
      isCurrent: true,
      name: fileMeta.name,
      size: fileMeta.size || 0,
      sha1: fileMeta.sha1 || (fileMeta.file_version && fileMeta.file_version.sha1) || "",
      timestamp: fileMeta.modified_at || fileMeta.content_modified_at || fileMeta.created_at || "",
      author: (fileMeta.modified_by && fileMeta.modified_by.name) || "",
      explicitNumber: fileMeta.version_number ? parseInt(fileMeta.version_number, 10) : null,
    };

    const full = [...priorList, currentEntry];
    return full.map((item, idx) => {
      const vNum = item.explicitNumber || idx + 1;
      return {
        ...item,
        index: idx + 1,
        vLabel: item.isCurrent ? `v${vNum} (Current)` : `v${vNum}`,
        shortLabel: `v${vNum}`,
      };
    });
  }

  /**
   * Downloads raw file bytes into browser RAM using a CORS simple GET request so the browser
   * cleanly follows Box's 302 redirect to `dl.boxcloud.com`.
   */
  async downloadFileBytes(fileId, versionId = null) {
    const params = new URLSearchParams();
    if (versionId) {
      params.set("version", String(versionId));
    }
    params.set("access_token", this._token);
    const url = `${BOX_API}/files/${encodeURIComponent(fileId)}/content?${params.toString()}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const resp = await fetch(url, { method: "GET", redirect: "follow", cache: "no-store" });
      if (resp.status === 202) {
        const retrySec = parseInt(resp.headers.get("Retry-After") || "2", 10);
        await new Promise((r) => setTimeout(r, Math.min(retrySec, 5) * 1000));
        continue;
      }
      if (resp.status === 403 && versionId) {
        throw new Error(
          "Box returned HTTP 403 for historical version download. Your Box plan or folder role may restrict prior version downloads—try comparing two sibling files in the folder."
        );
      }
      if (!resp.ok) {
        throw new Error(
          `Unable to read file from Box (HTTP ${resp.status}). Ensure CORS domain is whitelisted in Box Developer Console.`
        );
      }
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error("File is still preparing on Box; please try again in a few seconds.");
  }

  /**
   * Uploads a brand-new v1 file (`_Clean`) to Box so zero unredacted Version History exists.
   * Automatically handles 409 name collisions by appending ` (2)`, ` (3)`, etc.
   */
  async uploadNewSafeCopy(parentFolderId, stemName, extWithDot, mimeType, uint8Bytes) {
    const cleanStem = stemName.replace(/[\\/:*?"<>|]/g, "_").trim() || "Sanitized_Copy";

    for (let suffixIdx = 1; suffixIdx <= 12; suffixIdx++) {
      const candidateName =
        suffixIdx === 1 ? `${cleanStem}${extWithDot}` : `${cleanStem} (${suffixIdx})${extWithDot}`;

      // Box Upload API strictly requires `attributes` BEFORE `file` in FormData.
      const form = new FormData();
      form.append(
        "attributes",
        JSON.stringify({
          name: candidateName,
          parent: { id: String(parentFolderId) },
        })
      );
      form.append("file", new Blob([uint8Bytes], { type: mimeType }), candidateName);

      const resp = await fetch(`${BOX_UPLOAD_API}/files/content`, {
        method: "POST",
        headers: this._authHeaders(),
        body: form,
      });

      if (resp.status === 409) {
        continue;
      }

      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (data && data.message) || `Upload to Box failed (HTTP ${resp.status})`;
        const err = new Error(msg);
        err.status = resp.status;
        throw err;
      }
      const uploadedEntry = data && data.entries && data.entries[0];
      if (!uploadedEntry) throw new Error("Upload succeeded but Box returned no file entry.");
      return uploadedEntry;
    }
    throw new Error("Too many files with the same name in this folder; please choose a new name.");
  }

  async uploadNewFile(parentFolderId, stemName, extWithDot, mimeType, uint8Bytes) {
    return this.uploadNewSafeCopy(parentFolderId, stemName, extWithDot, mimeType, uint8Bytes);
  }

  /**
   * Uploads a sanitized new version onto an existing Box `fileId` (used for Replace Original
   * or automatic single-file Box Integration scope fallback).
   */
  async uploadNewFileVersion(fileId, originalFileName, mimeType, uint8Bytes) {
    const cleanName = (originalFileName || "Clean_Document").replace(/[\\/:*?"<>|]/g, "_").trim();
    const form = new FormData();
    form.append("attributes", JSON.stringify({ name: cleanName }));
    form.append("file", new Blob([uint8Bytes], { type: mimeType }), cleanName);

    const resp = await fetch(`${BOX_UPLOAD_API}/files/${encodeURIComponent(fileId)}/content`, {
      method: "POST",
      headers: this._authHeaders(),
      body: form,
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = (data && data.message) || `Saving version to Box failed (HTTP ${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    const uploadedEntry = data && data.entries && data.entries[0];
    if (!uploadedEntry) throw new Error("Version upload succeeded but Box returned no file entry.");
    return uploadedEntry;
  }

  async uploadReportPdf(parentFolderId, baseStem, pdfUint8Bytes) {
    const cleanStem = baseStem.replace(/[\\/:*?"<>|]/g, "_").trim() || "Comparison_Report";
    const prefixedStem = cleanStem.startsWith("Redline_Report") ? cleanStem : `Redline_Report_${cleanStem}`;
    return this.uploadNewSafeCopy(parentFolderId, prefixedStem, ".pdf", "application/pdf", pdfUint8Bytes);
  }

  async upsertUtilityFile(parentFolderId, fileName, mimeType, textContent, existingFileId = null) {
    const blob = new Blob([textContent], { type: mimeType });
    if (existingFileId) {
      const form = new FormData();
      form.append("attributes", JSON.stringify({ name: fileName }));
      form.append("file", blob, fileName);
      const resp = await fetch(`${BOX_UPLOAD_API}/files/${encodeURIComponent(existingFileId)}/content`, {
        method: "POST",
        headers: this._authHeaders(),
        body: form,
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.entries && data.entries[0];
      }
    }
    return this.uploadNewSafeCopy(
      parentFolderId,
      fileName.replace(/\.[^.]+$/, ""),
      fileName.match(/\.[^.]+$/)?.[0] || ".txt",
      mimeType,
      new TextEncoder().encode(textContent)
    );
  }

  async createSharedLinkForFile(fileId, access = "open", canDownload = true) {
    const data = await this._jsonFetch(`${BOX_API}/files/${encodeURIComponent(fileId)}?fields=shared_link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shared_link: {
          access,
          permissions: { can_download: canDownload, can_preview: true },
        },
      }),
    });
    return data.shared_link;
  }

  async listFolderPage(folderId, offset = 0, limit = 200) {
    const fields = [
      "id",
      "name",
      "type",
      "size",
      "sha1",
      "extension",
      "parent",
      "file_version",
      "version_number",
      "path_collection",
      "shared_link",
      "has_collaborations",
      "permissions",
      "created_at",
      "content_modified_at",
      "modified_at",
    ].join(",");
    return this._jsonFetch(
      `${BOX_API}/folders/${encodeURIComponent(folderId)}/items?fields=${fields}&offset=${offset}&limit=${limit}`
    );
  }

  async listItemCollaborations(itemType, itemId) {
    const plural = itemType === "folder" ? "folders" : "files";
    const fields = "id,role,status,created_at,acknowledged_at,expires_at,accessible_by";
    return this._jsonFetch(`${BOX_API}/${plural}/${encodeURIComponent(itemId)}/collaborations?fields=${fields}`);
  }

  async updateSharedLinkSettings(itemType, itemId, sharedLinkPayload) {
    const plural = itemType === "folder" ? "folders" : "files";
    return this._jsonFetch(`${BOX_API}/${plural}/${encodeURIComponent(itemId)}?fields=id,name,shared_link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared_link: sharedLinkPayload }),
    });
  }

  async removeCollaboration(collabId) {
    return this._jsonFetch(`${BOX_API}/collaborations/${encodeURIComponent(collabId)}`, {
      method: "DELETE",
    });
  }
}
