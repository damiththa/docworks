/**
 * Shared DocWorks Suite Shell Template & Controller.
 *
 * Provides a self-contained, reusable template for DocWorks apps (ScrubDoc,
 * DiffDoc, and future standalone tools across Box, Dropbox, and Google Drive):
 * unified top navigation with always-visible ShareRadar Pro & Other Files in Folder
 * tabs, toast notifications, OAuth launch parsing, provider user badge initialization,
 * ShareRadar Folder Sharing & Guest Hygiene workflow, 5-column Folder Browser,
 * Zero-PII footer, and interactive demo mode.
 */

import { ShareRadarScanner } from "./shareradar_engine.js?v=11";

const PENDING_TAB_STORAGE_KEY = "docworks_pending_tab";

export const el = (id) => {
  const node = document.getElementById(id);
  if (!node) {
    return new Proxy(document.createElement("div"), {
      get(target, prop) {
        if (prop === "classList") {
          return {
            add: () => {},
            remove: () => {},
            toggle: () => false,
            contains: () => false,
          };
        }
        if (prop === "style") return {};
        if (prop === "addEventListener") return () => {};
        if (prop === "removeEventListener") return () => {};
        if (prop === "querySelectorAll") return () => [];
        if (prop === "querySelector") return () => null;
        if (prop === "appendChild") return () => {};
        if (prop === "append") return () => {};
        return target[prop];
      },
    });
  }
  return node;
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPendingTab() {
  try {
    return window.sessionStorage?.getItem(PENDING_TAB_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function setPendingTab(tabName) {
  try {
    if (tabName) {
      window.sessionStorage?.setItem(PENDING_TAB_STORAGE_KEY, String(tabName));
    } else {
      window.sessionStorage?.removeItem(PENDING_TAB_STORAGE_KEY);
    }
  } catch {
    // Ignore restricted sessionStorage environments
  }
}

export function consumePendingSuiteTab(defaultTab = "picker") {
  const pending = getPendingTab();
  setPendingTab("");
  return pending || defaultTab;
}

export function showToast(message, variant = "info") {
  const banner = el("toast-banner");
  const variantMap = {
    error: "toast-error",
    success: "toast-success",
    warn: "toast-warn",
    info: "toast-info",
  };
  const cls = variantMap[variant] || "toast-info";
  banner.className = `toast ${cls}`;
  el("toast-text").textContent = message;
  banner.classList.remove("hidden");
}

export function hideToast() {
  el("toast-banner").classList.add("hidden");
}

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isValidReturnUrl(returnUrl, returnUrlRegex = null) {
  if (!returnUrl || typeof returnUrl !== "string") return false;
  if (returnUrlRegex instanceof RegExp) {
    return returnUrlRegex.test(returnUrl);
  }
  if (typeof returnUrlRegex === "string" && returnUrlRegex.trim()) {
    try {
      return new RegExp(returnUrlRegex, "i").test(returnUrl);
    } catch {
      // Fall back to default Box allowlist
    }
  }
  return /^https:\/\/([a-z0-9-]+\.)*box\.com(\/|$)/i.test(returnUrl);
}

export function parseLaunchParams() {
  const merged = new URLSearchParams(window.location.search);
  if (window.location.hash && window.location.hash.length > 1) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    for (const [k, v] of hashParams.entries()) {
      merged.set(k, v);
    }
  }

  const params = {
    authCode: merged.get("auth_code") || merged.get("code") || "",
    fileId: merged.get("file_id") || "",
    folderId: merged.get("folder_id") || "",
    mode: merged.get("mode") || "",
    state: merged.get("state") || "",
    returnUrl: merged.get("return_url") || merged.get("redirect_to_box_url") || "",
    fromCallback: merged.get("from_callback") === "1",
    oauthError: merged.get("oauth_error") || merged.get("error_description") || merged.get("error") || "",
  };

  if ((params.authCode || params.oauthError || window.location.search || window.location.hash) && window.history?.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return params;
}

export function closeOrReturnToProvider(
  returnUrl,
  returnUrlRegex = null,
  providerHomeUrl = "https://app.box.com",
  fallbackFn = null
) {
  if (isValidReturnUrl(returnUrl, returnUrlRegex)) {
    window.location.href = returnUrl;
    return;
  }
  try {
    window.close();
  } catch {
    // Ignore if browser blocks script close on a regular tab
  }
  setTimeout(() => {
    if (!document.hidden) {
      if (typeof fallbackFn === "function") {
        fallbackFn();
      } else {
        window.location.href = providerHomeUrl || "https://app.box.com";
      }
    }
  }, 180);
}

export function closeOrReturnToBox(returnUrl, fallbackFn = null) {
  closeOrReturnToProvider(returnUrl, null, "https://app.box.com", fallbackFn);
}

export function initUserBadge(providerClient, fallbackLabel = "") {
  const badge = el("userBadge");
  const defaultText = fallbackLabel || `${providerClient?.providerName || "Box"} Connected`;
  badge.textContent = defaultText;
  badge.classList.remove("hidden");

  if (!providerClient || typeof providerClient.getCurrentUser !== "function") {
    return;
  }

  providerClient
    .getCurrentUser()
    .then((me) => {
      if (me && me.login) {
        badge.textContent = me.login;
        badge.title = me.name ? `${me.name} (${me.login})` : me.login;
        badge.classList.remove("hidden");
      }
    })
    .catch(() => {});
}

/* ==========================================================================
 * Canonical DocWorks Suite Template Markup Injection
 * ========================================================================== */

function resolveProviderName(config) {
  return config?.providerName || config?.getProviderClient?.()?.providerName || config?.getBoxClient?.()?.providerName || "Box";
}

function ensureHeaderTemplate(config) {
  const topbar = document.querySelector("header.topbar");
  if (!topbar || topbar.children.length > 0) return;

  const primaryTab = escapeHtml(config?.primaryTab || "workspace");
  const primaryLabel = escapeHtml(config?.primaryTabLabel || "Workspace");
  const suiteName = escapeHtml(config?.suiteName || "DocWorks");
  const appName = escapeHtml(config?.appName || "DocWorks App");
  const pName = escapeHtml(resolveProviderName(config));
  const appSubtitle = escapeHtml(config?.appSubtitle || `100% client-side ${resolveProviderName(config)} workspace`);

  topbar.innerHTML = `
    <div class="brand-row">
      <div class="brand-icon" aria-hidden="true">
        <img src="/static/app/icon.svg?v=11" alt="" width="36" height="36" />
      </div>
      <div class="brand-text">
        <div class="brand-title-line">
          <span class="brand-name">${appName}</span>
          <span class="suite-pill">${suiteName}</span>
          <span class="privacy-pill" title="100% In-Browser: Files flow directly between ${pName} and your browser RAM. Zero file bytes ever leave your device.">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            100% In-Browser &middot; Zero-PII
          </span>
        </div>
        <div class="brand-sub" id="active-context-label">${appSubtitle}</div>
      </div>
    </div>

    <nav class="nav-tabs" id="main-tabs" aria-label="Workspace navigation">
      <button class="tab-btn active" id="btn-tab-${primaryTab}" type="button">${primaryLabel}</button>
      <button class="tab-btn" id="btn-tab-radar" type="button">ShareRadar <span class="tab-badge-pro">Pro</span></button>
      <button class="tab-btn" id="btn-tab-picker" type="button" title="Browse the remaining files and folders in the ${pName} folder you opened from">Other Files in Folder</button>
    </nav>

    <div class="header-actions">
      <span class="quota-pill hidden" id="quota-badge">Free Plan</span>
      <span id="userBadge" class="pill-user hidden">${pName} Connected</span>
      <button class="btn btn-secondary hidden" id="btn-done-window" type="button">Done</button>
    </div>
  `;
}

function ensureToastTemplate() {
  const banner = document.getElementById("toast-banner");
  if (!banner || banner.children.length > 0) return;
  banner.innerHTML = `
    <span id="toast-text"></span>
    <button class="toast-dismiss" id="btn-toast-close" type="button" aria-label="Dismiss">&times;</button>
  `;
}

function ensureRadarTemplate(config) {
  const sec = document.getElementById("screen-radar");
  if (!sec || sec.children.length > 0) return;
  const pName = escapeHtml(resolveProviderName(config));
  sec.innerHTML = `
    <div class="privacy-notice-strip">
      <span class="shield-dot" aria-hidden="true"></span>
      <span><strong>Zero-PII Active:</strong> ShareRadar reads folder link metadata only. Zero file contents are ever downloaded or inspected.</span>
    </div>

    <div class="section-topbar">
      <div>
        <h2 class="section-heading" id="radar-folder-heading">Folder Sharing Summary</h2>
        <p class="section-sub" id="kpi-scan-progress">Checking shared links and outside guests...</p>
      </div>
      <div class="section-actions">
        <button class="btn btn-ghost" id="btn-rescan-radar" type="button">Refresh</button>
        <button class="btn btn-secondary" id="btn-save-radar-csv" type="button">Save CSV Report to ${pName}</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Public Links</div>
        <div class="kpi-value" id="kpi-open-links">0</div>
        <div class="kpi-sub" id="kpi-open-sub">Anyone with the link can open</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Views</div>
        <div class="kpi-value" id="kpi-total-opens">0</div>
        <div class="kpi-sub" id="kpi-delta-opens">Times shared links were opened</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Downloads</div>
        <div class="kpi-value" id="kpi-total-downloads">0</div>
        <div class="kpi-sub" id="kpi-delta-downloads">Times shared files were downloaded</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Outside Guests</div>
        <div class="kpi-value" id="kpi-external-guests">0</div>
        <div class="kpi-sub">Collaborators outside your domain</div>
      </div>
    </div>

    <div class="radar-toolbar">
      <div class="filter-pills" role="tablist">
        <button class="filter-pill active" data-filter="all" type="button">All shared items</button>
        <button class="filter-pill" data-filter="open_links" type="button">Public links</button>
        <button class="filter-pill" data-filter="high_traffic" type="button">Viewed or downloaded</button>
        <button class="filter-pill" data-filter="guests" type="button">Outside guests</button>
      </div>

      <div class="bulk-actions">
        <button class="btn btn-secondary btn-sm" id="btn-bulk-expire30" type="button">Set 30-Day Expiry</button>
        <button class="btn btn-secondary btn-sm" id="btn-bulk-viewonly" type="button">Disable Downloads</button>
        <button class="btn btn-danger-soft btn-sm" id="btn-bulk-revoke" type="button">Turn Off Selected</button>
      </div>
    </div>

    <div class="table-card">
      <table class="clean-table">
        <thead>
          <tr>
            <th style="width: 38px;"><input type="checkbox" id="chk-radar-all" aria-label="Select all" /></th>
            <th>File or Folder</th>
            <th>Who Has Access</th>
            <th>Views &amp; Downloads</th>
            <th>Expiration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="radar-tbody">
          <tr>
            <td colspan="6" class="empty-cell">Scanning folder sharing settings...</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function ensurePickerTemplate(config) {
  const sec = document.getElementById("screen-picker");
  if (!sec || sec.children.length > 0) return;
  const pName = escapeHtml(resolveProviderName(config));
  const subtitle = escapeHtml(
    config?.pickerSubtitle || `Browse the remaining files and folders in the ${resolveProviderName(config)} folder you opened from.`
  );
  sec.innerHTML = `
    <div class="picker-header">
      <div>
        <h2 class="folder-title" id="picker-folder-title">All Files</h2>
        <p class="muted-sm">${subtitle}</p>
      </div>
      <div class="browser-nav-btns">
        <button class="btn btn-ghost btn-sm" id="btn-picker-up" type="button">&uarr; Parent Folder</button>
        <button class="btn btn-ghost btn-sm" id="btn-picker-root" type="button">Root (All Files)</button>
        <button class="btn btn-secondary btn-sm" id="btn-audit-current-folder" type="button">Check Sharing on This Folder</button>
      </div>
    </div>
    <div class="table-scroll">
      <table class="clean-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
            <th>Modified</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="picker-tbody">
          <tr>
            <td colspan="5" class="empty-cell">Open a folder to browse ${pName} files.</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function ensureFooterTemplate(config) {
  const footer = document.querySelector("footer.app-footer");
  if (!footer || footer.children.length > 0) return;
  const pName = escapeHtml(resolveProviderName(config));
  footer.innerHTML = `
    <div class="footer-trust">
      <svg class="footer-shield" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <span><strong>Zero-PII Guarantee:</strong> 100% In-Browser RAM Execution &middot; Zero File Bytes Sent to Cloud Servers &middot; Direct ${pName} CORS</span>
    </div>
    <div class="footer-links">
      <a href="/privacy" target="_blank" rel="noopener">Privacy</a> &middot;
      <a href="/terms" target="_blank" rel="noopener">Terms</a>
    </div>
  `;
}

function ensureSuiteNavVisible(config) {
  const nav = document.getElementById("main-tabs");
  if (!nav) return;
  nav.classList.remove("hidden");

  const primaryTab = config?.primaryTab || "scrub";
  const primaryBtn = document.getElementById(`btn-tab-${primaryTab}`);
  if (primaryBtn && config?.primaryTabLabel) {
    primaryBtn.textContent = config.primaryTabLabel;
  }

  const radarBtn = document.getElementById("btn-tab-radar");
  if (radarBtn) {
    radarBtn.innerHTML = 'ShareRadar <span class="tab-badge-pro">Pro</span>';
  }

  const pName = resolveProviderName(config);
  const pickerBtn = document.getElementById("btn-tab-picker");
  if (pickerBtn) {
    pickerBtn.textContent = "Other Files in Folder";
    pickerBtn.title = `Browse the remaining files and folders in the ${pName} folder you opened from`;
  }

  document.getElementById("btn-switch-item")?.remove();
}

function syncCapabilitiesUi(capabilities) {
  const caps = capabilities || {};
  const expireBtn = document.getElementById("btn-bulk-expire30");
  if (expireBtn) {
    expireBtn.classList.toggle("hidden", caps.supports_link_expiry === false);
  }
  const viewOnlyBtn = document.getElementById("btn-bulk-viewonly");
  if (viewOnlyBtn) {
    viewOnlyBtn.classList.toggle("hidden", caps.supports_download_disable === false);
  }
}

function injectShellTemplates(config) {
  ensureHeaderTemplate(config);
  ensureToastTemplate();
  ensureRadarTemplate(config);
  ensurePickerTemplate(config);
  ensureFooterTemplate(config);
  ensureSuiteNavVisible(config);
  syncCapabilitiesUi(config?.capabilities);
}

/* ==========================================================================
 * Standalone Demo Data (Used when template runs without OAuth session)
 * ========================================================================== */

function createDemoState() {
  const demoFindings = [
    {
      findingId: "demo-link-1",
      kind: "shared_link",
      itemType: "file",
      itemId: "demo-101",
      name: "Patient_Intake_Form_Q4.pdf",
      path: "/Clinical Ops / Q4 Intake",
      accessLevel: "open",
      canDownload: true,
      hasPassword: false,
      canEdit: false,
      opens: 118,
      downloads: 34,
      deltaOpens: 12,
      deltaDownloads: 4,
      unsharedAt: null,
      expiryDaysLeft: null,
      dormantDays: null,
      severity: "high",
      remediated: false,
      statusLabel: "Active",
    },
    {
      findingId: "demo-link-2",
      kind: "shared_link",
      itemType: "folder",
      itemId: "demo-102",
      name: "Vendor MSA Redlines",
      path: "/Legal / Procurement",
      accessLevel: "open",
      canDownload: true,
      hasPassword: false,
      canEdit: false,
      opens: 66,
      downloads: 8,
      deltaOpens: 0,
      deltaDownloads: 0,
      unsharedAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      expiryDaysLeft: 5,
      dormantDays: 42,
      severity: "high",
      remediated: false,
      statusLabel: "Active",
    },
    {
      findingId: "demo-guest-1",
      kind: "external_guest",
      itemType: "folder",
      itemId: "demo-103",
      name: "Board Audit 2026",
      path: "/Finance / Audit",
      guestName: "Alex Rivera",
      guestEmail: "arivera@external-counsel.com",
      guestRole: "viewer uploader",
      tenureDays: 47,
      collabStatus: "accepted",
      guestExpiryLeft: null,
      severity: "medium",
      remediated: false,
      statusLabel: "Active",
    },
  ];

  const demoEntries = [
    {
      id: "demo-folder-1",
      type: "folder",
      name: "Shared Client Docs",
      size: 0,
      modified_at: "2026-11-10T14:20:00Z",
    },
    {
      id: "demo-file-1",
      type: "file",
      name: "Sample_Patient_Intake.pdf",
      extension: "pdf",
      size: 245760,
      modified_at: "2026-11-12T09:15:00Z",
    },
    {
      id: "demo-file-2",
      type: "file",
      name: "Master_Services_Agreement_v3.docx",
      extension: "docx",
      size: 84210,
      modified_at: "2026-11-13T16:40:00Z",
    },
  ];

  const demoScanner = {
    rootFolderId: "",
    findings: demoFindings,
    getSummaryStats() {
      const openLinks = this.findings.filter(
        (f) => f.kind === "shared_link" && f.accessLevel === "open" && !f.remediated
      ).length;
      const totalOpens = this.findings.reduce((s, f) => s + (f.opens || 0), 0);
      const totalDownloads = this.findings.reduce((s, f) => s + (f.downloads || 0), 0);
      const extGuests = this.findings.filter(
        (f) => f.kind === "external_guest" && !f.remediated
      ).length;
      return {
        openPublicLinks: openLinks,
        totalOpens,
        totalDownloads,
        externalGuests: extGuests,
        totalScannedItems: 14,
        hasPriorSnapshot: true,
        deltaOpensSum: 12,
        deltaDownloadsSum: 4,
        priorSnapshotDate: "Nov 10",
      };
    },
    async remediateFinding(item, actionType) {
      item.remediated = true;
      if (actionType === "expire_30d") {
        item.expiryDaysLeft = 30;
        item.unsharedAt = new Date(Date.now() + 30 * 86400000).toISOString();
        item.statusLabel = "30d expiry set";
      } else if (actionType === "view_only") {
        item.canDownload = false;
        item.statusLabel = "View only";
      } else {
        item.statusLabel = "Access removed";
      }
    },
    async saveSnapshotAndCsvToProvider() {
      return { name: "ShareRadar_Demo_Report.csv" };
    },
    async saveSnapshotAndCsvToBox() {
      return this.saveSnapshotAndCsvToProvider();
    },
  };

  return { demoScanner, demoEntries };
}

/* ==========================================================================
 * Icons & Suite Controller
 * ========================================================================== */

function createFolderIconSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "#eff6ff");
  svg.setAttribute("stroke", "#2563eb");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flexShrink = "0";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z");
  svg.appendChild(path);
  return svg;
}

function createFileIconSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#64748b");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flexShrink = "0";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
  const poly = document.createElementNS(ns, "polyline");
  poly.setAttribute("points", "14 2 14 8 20 8");
  svg.appendChild(path);
  svg.appendChild(poly);
  return svg;
}

export function createSuiteController(config = {}) {
  const primaryTab = config?.primaryTab || "scrub";
  let pickerFolderId = "0";
  let pickerParentId = null;
  let radarFilter = "all";
  let internalScanner = null;
  let demoState = null;
  let controlsWired = false;

  injectShellTemplates({ ...config, primaryTab });

  function getClient() {
    return config?.getProviderClient?.() || config?.getBoxClient?.() || null;
  }

  function activeProviderName() {
    return getClient()?.providerName || config?.providerName || "Box";
  }

  function getDemo() {
    if (!demoState) demoState = createDemoState();
    return demoState;
  }

  function isAuthenticated() {
    return Boolean(config?.demoMode || getClient());
  }

  function resolveScanner() {
    const client = getClient();
    if (!client && config?.demoMode) {
      return getDemo().demoScanner;
    }
    if (typeof config?.getRadarScanner === "function") {
      const external = config.getRadarScanner();
      if (external) return external;
    }
    if (!client) return null;
    if (!internalScanner || internalScanner.provider !== client) {
      internalScanner = new ShareRadarScanner(client);
    }
    return internalScanner;
  }

  function switchTab(tabName) {
    ensureSuiteNavVisible({ ...config, primaryTab });
    const targetTab = [primaryTab, "radar", "picker"].includes(tabName) ? tabName : primaryTab;

    if (!isAuthenticated()) {
      [primaryTab, "radar", "picker"].forEach((t) => {
        el(`screen-${t}`).classList.add("hidden");
        el(`btn-tab-${t}`).classList.toggle("active", t === targetTab);
      });
      el("screen-connect").classList.remove("hidden");
      setPendingTab(targetTab);

      const pName = activeProviderName();
      const promptMap = {
        radar: `Connect your ${pName} account below to open ShareRadar on your folders.`,
        picker: `Connect your ${pName} account below to browse your ${pName} files.`,
      };
      showToast(
        promptMap[targetTab] || `Connect your ${pName} account below to open your workspace.`,
        "info"
      );
      return false;
    }

    el("screen-connect").classList.add("hidden");
    [primaryTab, "radar", "picker"].forEach((t) => {
      el(`screen-${t}`).classList.toggle("hidden", t !== targetTab);
      el(`btn-tab-${t}`).classList.toggle("active", t === targetTab);
    });
    return true;
  }

  function filterFindings(findings) {
    return findings.filter((f) => {
      if (radarFilter === "open_links" || radarFilter === "public") {
        return f.kind === "shared_link" && f.accessLevel === "open";
      }
      if (radarFilter === "high_traffic") {
        return f.kind === "shared_link" && (f.opens > 0 || f.downloads > 0);
      }
      if (radarFilter === "guests") {
        return f.kind === "external_guest";
      }
      if (radarFilter === "expiring") {
        return f.kind === "shared_link" && f.expiryDaysLeft !== null && f.expiryDaysLeft <= 14;
      }
      if (radarFilter === "dormant") {
        return f.kind === "shared_link" && f.dormantDays !== null && f.dormantDays >= 30;
      }
      return true;
    });
  }

  function refreshRadarUi() {
    const scanner = resolveScanner();
    if (!scanner) return;
    const client = getClient();
    syncCapabilitiesUi(client?.capabilities || config?.capabilities);

    const stats = scanner.getSummaryStats();

    el("kpi-open-links").textContent = stats.openPublicLinks.toLocaleString();
    el("kpi-open-sub").textContent =
      stats.openPublicLinks > 0 ? "Anyone with the link can open" : "No public anyone-links found";

    el("kpi-total-opens").textContent = stats.totalOpens.toLocaleString();
    el("kpi-total-downloads").textContent = stats.totalDownloads.toLocaleString();
    el("kpi-external-guests").textContent = stats.externalGuests.toLocaleString();

    if (stats.hasPriorSnapshot) {
      el("kpi-delta-opens").textContent =
        stats.deltaOpensSum > 0
          ? `+${stats.deltaOpensSum.toLocaleString()} since last check`
          : `No new opens since ${stats.priorSnapshotDate || "last check"}`;
      el("kpi-delta-downloads").textContent =
        stats.deltaDownloadsSum > 0
          ? `+${stats.deltaDownloadsSum.toLocaleString()} since last check`
          : `No new downloads since ${stats.priorSnapshotDate || "last check"}`;
    } else {
      el("kpi-delta-opens").textContent = "Times shared links were opened";
      el("kpi-delta-downloads").textContent = "Times shared files were downloaded";
    }

    el("kpi-scan-progress").textContent = `Checked ${stats.totalScannedItems.toLocaleString()} item${
      stats.totalScannedItems === 1 ? "" : "s"
    } · ${scanner.findings.length} sharing item${scanner.findings.length === 1 ? "" : "s"} found`;

    const visible = filterFindings(scanner.findings);
    const tbody = el("radar-tbody");
    tbody.innerHTML = "";
    el("chk-radar-all").checked = false;

    if (visible.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty-cell">Everything looks clean — no matching shared links or outside guests found.</td></tr>';
      return;
    }

    for (const f of visible) {
      const tr = document.createElement("tr");

      // Col 0: Checkbox
      const tdChk = document.createElement("td");
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "radar-row-chk";
      chk.dataset.findingId = f.findingId;
      chk.disabled = Boolean(f.remediated);
      chk.checked = !f.remediated && f.severity === "high";
      tdChk.appendChild(chk);
      tr.appendChild(tdChk);

      // Col 1: File or Folder
      const tdItem = document.createElement("td");
      const nameDiv = document.createElement("div");
      nameDiv.style.fontWeight = "600";
      nameDiv.textContent = `${f.itemType === "folder" ? "📁 " : ""}${f.name}`;
      tdItem.appendChild(nameDiv);
      if (f.path) {
        const pathDiv = document.createElement("div");
        pathDiv.className = "mono-sm";
        pathDiv.textContent = f.path;
        tdItem.appendChild(pathDiv);
      }
      tr.appendChild(tdItem);

      // Col 2: Who Has Access
      const tdAccess = document.createElement("td");
      const accBadge = document.createElement("span");
      if (f.kind === "shared_link") {
        accBadge.className = `badge ${f.accessLevel === "open" ? "badge-warn" : "badge-neutral"}`;
        accBadge.textContent =
          f.accessLevel === "open"
            ? "Public Link (Anyone)"
            : f.accessLevel === "company"
              ? "Company Link"
              : "Collaborators Only";
        tdAccess.appendChild(accBadge);

        const permsDiv = document.createElement("div");
        permsDiv.className = "mono-sm";
        const permParts = [f.canDownload ? "Downloadable" : "View only"];
        if (f.hasPassword) permParts.push("Password protected");
        if (f.canEdit) permParts.push("Editable");
        permsDiv.textContent = permParts.join(" · ");
        tdAccess.appendChild(permsDiv);
      } else {
        accBadge.className = "badge badge-neutral";
        accBadge.textContent = `Outside Guest (${f.guestRole || "viewer"})`;
        tdAccess.appendChild(accBadge);

        const guestDiv = document.createElement("div");
        guestDiv.className = "mono-sm";
        guestDiv.textContent =
          f.guestName && f.guestEmail && f.guestName !== f.guestEmail
            ? `${f.guestName} (${f.guestEmail})`
            : f.guestEmail || f.guestName || "External user";
        tdAccess.appendChild(guestDiv);
      }
      tr.appendChild(tdAccess);

      // Col 3: Views & Downloads
      const tdActivity = document.createElement("td");
      if (f.kind === "shared_link") {
        const mainStat = document.createElement("div");
        mainStat.textContent = `${f.opens.toLocaleString()} views · ${f.downloads.toLocaleString()} downloads`;
        tdActivity.appendChild(mainStat);
        if (f.deltaOpens > 0 || f.deltaDownloads > 0) {
          const deltaDiv = document.createElement("div");
          deltaDiv.className = "mono-sm";
          deltaDiv.style.color = "var(--amber)";
          deltaDiv.textContent = `+${f.deltaOpens} views / +${f.deltaDownloads} downloads since last check`;
          tdActivity.appendChild(deltaDiv);
        }
      } else {
        tdActivity.textContent =
          typeof f.tenureDays === "number" ? `Invited ${f.tenureDays}d ago` : f.collabStatus || "Active";
      }
      tr.appendChild(tdActivity);

      // Col 4: Expiration
      const tdExp = document.createElement("td");
      if (f.kind === "shared_link") {
        if (f.unsharedAt) {
          const expSpan = document.createElement("span");
          expSpan.className = `badge ${
            f.expiryDaysLeft !== null && f.expiryDaysLeft <= 7 ? "badge-warn" : "badge-neutral"
          }`;
          expSpan.textContent =
            f.expiryDaysLeft !== null ? `${f.expiryDaysLeft}d left` : formatShortDate(f.unsharedAt);
          tdExp.appendChild(expSpan);
        } else {
          tdExp.textContent = "No expiration";
        }
        if (f.dormantDays !== null && f.dormantDays >= 30) {
          const dormDiv = document.createElement("div");
          dormDiv.className = "mono-sm";
          dormDiv.textContent = `Idle ${f.dormantDays}d`;
          tdExp.appendChild(dormDiv);
        }
      } else if (f.guestExpiryLeft !== null && typeof f.guestExpiryLeft === "number") {
        tdExp.textContent = `${f.guestExpiryLeft}d left`;
      } else {
        tdExp.textContent = "No expiration";
      }
      tr.appendChild(tdExp);

      // Col 5: Status
      const tdStatus = document.createElement("td");
      const stSpan = document.createElement("span");
      stSpan.className = `badge ${f.remediated ? "badge-safe" : "badge-neutral"}`;
      stSpan.textContent = f.remediated ? (f.statusLabel || "Updated").replace(/^✓\s*/, "") : "Active";
      tdStatus.appendChild(stSpan);
      tr.appendChild(tdStatus);

      tbody.appendChild(tr);
    }
  }

  async function runRadarOnFolder(folderId) {
    const client = getClient();
    const scanner = resolveScanner();
    if (!scanner || (!client && !config?.demoMode)) return;

    const targetFolder = String(folderId || "0");
    pickerFolderId = targetFolder;
    if (typeof config?.setContextFolderId === "function") {
      config.setContextFolderId(targetFolder);
    }

    if (!switchTab("radar")) return;

    if (!client && config?.demoMode) {
      scanner.rootFolderId = targetFolder;
      el("active-context-label").textContent = "ShareRadar Preview (Demo)";
      el("radar-folder-heading").textContent = "Sharing: Demo Workspace Folder";
      refreshRadarUi();
      return;
    }

    el("active-context-label").textContent = "Folder Sharing Summary";
    el("radar-folder-heading").textContent = "Folder Sharing Summary";
    el("kpi-scan-progress").textContent = "Checking shared links and outside guests...";
    el("radar-tbody").innerHTML =
      '<tr><td colspan="6" class="empty-cell">Checking shared links and guests in this folder...</td></tr>';

    try {
      if (targetFolder !== "0") {
        client
          .getFolderMetadata(targetFolder)
          .then((meta) => {
            if (meta && meta.name) {
              el("radar-folder-heading").textContent = `Sharing: ${meta.name}`;
              el("active-context-label").textContent = meta.name;
            }
          })
          .catch(() => {});
      } else {
        el("radar-folder-heading").textContent = "Sharing: All Files (Root)";
        el("active-context-label").textContent = "All Files";
      }

      await scanner.scanFolderTree(targetFolder, (scannedCount, findingsLen) => {
        el("kpi-scan-progress").textContent = `Checked ${scannedCount.toLocaleString()} item${
          scannedCount === 1 ? "" : "s"
        } (${findingsLen} sharing item${findingsLen === 1 ? "" : "s"} found)...`;
      });

      refreshRadarUi();
    } catch (err) {
      el("kpi-scan-progress").textContent = "Could not finish folder check.";
      el("radar-tbody").innerHTML =
        '<tr><td colspan="6" class="empty-cell">Unable to read folder sharing settings.</td></tr>';
      showToast(err.message || "ShareRadar scan failed.", "error");
    }
  }

  async function handleBulkRemediate(actionType) {
    const scanner = resolveScanner();
    if (!scanner) return;

    const checked = Array.from(document.querySelectorAll("#radar-tbody .radar-row-chk:checked"));
    const selectedIds = checked.map((c) => c.dataset.findingId);
    const targets = scanner.findings.filter((f) => {
      if (!selectedIds.includes(f.findingId) || f.remediated) return false;
      if ((actionType === "expire_30d" || actionType === "view_only") && f.kind !== "shared_link") {
        return false;
      }
      return true;
    });

    if (targets.length === 0) {
      showToast(
        actionType === "revoke"
          ? "Select at least one active item first."
          : "Select at least one active shared link first.",
        "info"
      );
      return;
    }

    if (typeof config?.checkQuota === "function") {
      try {
        const quota = await config.checkQuota("radar_fix", targets.length);
        if (quota && !quota.allowed) {
          showToast(quota.message || "Monthly Free limit reached. Upgrade to DocWorks Pro.", "error");
          return;
        }
      } catch (err) {
        showToast(err.message || "Unable to verify quota.", "error");
        return;
      }
    }

    const bulkBtns = [el("btn-bulk-expire30"), el("btn-bulk-viewonly"), el("btn-bulk-revoke")];
    bulkBtns.forEach((b) => {
      b.disabled = true;
    });

    const pName = activeProviderName();
    let completedCount = 0;
    let firstError = null;
    try {
      showToast(`Updating ${targets.length} item${targets.length === 1 ? "" : "s"}...`, "info");
      for (const item of targets) {
        try {
          await scanner.remediateFinding(item, actionType);
          completedCount += 1;
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }

      if (completedCount > 0 && typeof config?.consumeQuota === "function") {
        await config.consumeQuota("radar_fix", completedCount);
      }

      refreshRadarUi();
      if (firstError && completedCount === 0) {
        showToast(firstError.message || `Could not update sharing settings in ${pName}.`, "error");
      } else if (firstError) {
        showToast(
          `Updated ${completedCount} of ${targets.length} items (${firstError.message}).`,
          "warn"
        );
      } else {
        showToast(
          `Updated ${completedCount} item${completedCount === 1 ? "" : "s"}${
            config?.demoMode ? " (demo)" : ` in ${pName}`
          }.`,
          "success"
        );
      }
    } finally {
      bulkBtns.forEach((b) => {
        b.disabled = false;
      });
    }
  }

  function renderPickerEntries(entries) {
    const tbody = el("picker-tbody");
    tbody.innerHTML = "";
    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">This folder is empty.</td></tr>';
      return;
    }

    const activeFileId = String(
      (typeof config?.getActiveFileId === "function" ? config.getActiveFileId() : "") || ""
    );

    for (const entry of entries) {
      const isFolder = entry.type === "folder";
      const tr = document.createElement("tr");

      // Col 0: Name
      const tdName = document.createElement("td");
      const nameWrap = document.createElement("div");
      nameWrap.style.display = "flex";
      nameWrap.style.alignItems = "center";
      nameWrap.style.gap = "8px";

      if (isFolder) {
        nameWrap.appendChild(createFolderIconSvg());
        const folderBtn = document.createElement("button");
        folderBtn.type = "button";
        folderBtn.className = "btn-link";
        folderBtn.style.padding = "0";
        folderBtn.style.fontWeight = "600";
        folderBtn.style.color = "var(--text)";
        folderBtn.textContent = entry.name || "Untitled Folder";
        folderBtn.addEventListener("click", () => loadPickerFolder(entry.id));
        nameWrap.appendChild(folderBtn);
      } else {
        nameWrap.appendChild(createFileIconSvg());
        const nameSpan = document.createElement("span");
        nameSpan.style.fontWeight = "500";
        nameSpan.textContent = entry.name || "Untitled File";
        nameWrap.appendChild(nameSpan);
        if (activeFileId && String(entry.id) === activeFileId) {
          const curBadge = document.createElement("span");
          curBadge.className = "badge badge-neutral";
          curBadge.textContent = "Current file";
          nameWrap.appendChild(curBadge);
        }
      }
      tdName.appendChild(nameWrap);
      tr.appendChild(tdName);

      // Col 1: Type
      const tdType = document.createElement("td");
      if (isFolder) {
        tdType.textContent = "Folder";
      } else {
        const m = /\.([a-zA-Z0-9]+)$/.exec(entry.name || "");
        tdType.textContent = (entry.extension || (m ? m[1] : "File")).toUpperCase();
      }
      tr.appendChild(tdType);

      // Col 2: Size
      const tdSize = document.createElement("td");
      tdSize.textContent = isFolder ? "—" : formatBytes(entry.size);
      tr.appendChild(tdSize);

      // Col 3: Modified
      const tdMod = document.createElement("td");
      tdMod.textContent = formatShortDate(entry.modified_at || entry.content_modified_at) || "—";
      tr.appendChild(tdMod);

      // Col 4: Actions
      const tdAct = document.createElement("td");
      const actWrap = document.createElement("div");
      actWrap.className = "row-actions";

      if (isFolder) {
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "btn btn-secondary btn-sm";
        openBtn.textContent = "Open Folder";
        openBtn.addEventListener("click", () => loadPickerFolder(entry.id));

        const scanBtn = document.createElement("button");
        scanBtn.type = "button";
        scanBtn.className = "btn btn-ghost btn-sm";
        scanBtn.textContent = "Scan Sharing";
        scanBtn.addEventListener("click", () => runRadarOnFolder(entry.id));

        actWrap.appendChild(openBtn);
        actWrap.appendChild(scanBtn);
      } else if (typeof config?.renderFileActions === "function") {
        const customNodes = config.renderFileActions(entry);
        const list = Array.isArray(customNodes)
          ? customNodes
          : customNodes
            ? [customNodes]
            : [];
        for (const node of list) {
          if (node) actWrap.appendChild(node);
        }
      } else {
        const openPrimaryBtn = document.createElement("button");
        openPrimaryBtn.type = "button";
        openPrimaryBtn.className = "btn btn-primary btn-sm";
        openPrimaryBtn.textContent = "Open in Workspace";
        openPrimaryBtn.addEventListener("click", () => {
          switchTab(primaryTab);
          showToast(`Selected "${entry.name}".`, "info");
        });
        actWrap.appendChild(openPrimaryBtn);
      }

      tdAct.appendChild(actWrap);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  }

  async function loadPickerFolder(folderId = "0") {
    const client = getClient();
    if (!client && !config?.demoMode) return;

    const targetId = String(folderId || "0");
    pickerFolderId = targetId;
    if (typeof config?.setContextFolderId === "function") {
      config.setContextFolderId(targetId);
    }

    if (!client && config?.demoMode) {
      el("picker-folder-title").textContent =
        targetId === "0" ? "All Files (Demo)" : "Shared Client Docs (Demo)";
      el("btn-picker-up").disabled = targetId === "0";
      el("btn-picker-root").disabled = targetId === "0";
      renderPickerEntries(getDemo().demoEntries);
      return;
    }

    const pName = activeProviderName();
    const tbody = el("picker-tbody");
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">Loading ${escapeHtml(pName)} folder...</td></tr>`;

    try {
      const [folderMeta, page] = await Promise.all([
        targetId === "0"
          ? Promise.resolve({ id: "0", name: "All Files", parent: null })
          : client.getFolderMetadata(targetId),
        client.listFolderPage(targetId, 0, 200),
      ]);

      pickerFolderId = String(folderMeta.id || targetId);
      pickerParentId = folderMeta.parent ? String(folderMeta.parent.id) : null;

      el("picker-folder-title").textContent =
        pickerFolderId === "0" ? "All Files" : folderMeta.name || `${pName} Folder`;
      el("btn-picker-up").disabled = !pickerParentId || pickerFolderId === "0";
      el("btn-picker-root").disabled = pickerFolderId === "0";

      const rawEntries =
        page && Array.isArray(page.entries)
          ? page.entries
          : folderMeta.item_collection?.entries || [];

      if (typeof config?.onFolderLoaded === "function") {
        config.onFolderLoaded({ ...folderMeta, entries: rawEntries });
      }

      const entries = rawEntries.slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });

      renderPickerEntries(entries);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">Unable to load ${escapeHtml(pName)} folder.</td></tr>`;
      showToast(err.message || "Could not load folder contents.", "error");
    }
  }

  function resolveContextFolderId() {
    return String(
      (typeof config?.getContextFolderId === "function" ? config.getContextFolderId() : "") ||
        pickerFolderId ||
        "0"
    );
  }

  function wireSuiteControls() {
    if (controlsWired) return;
    controlsWired = true;

    el("btn-toast-close").addEventListener("click", hideToast);

    el(`btn-tab-${primaryTab}`).addEventListener("click", () => {
      switchTab(primaryTab);
    });

    el("btn-tab-radar").addEventListener("click", () => {
      if (!switchTab("radar")) return;
      const scanner = resolveScanner();
      const targetFolder = resolveContextFolderId();
      if (scanner && (!scanner.rootFolderId || scanner.rootFolderId !== targetFolder)) {
        runRadarOnFolder(targetFolder);
      }
    });

    el("btn-tab-picker").addEventListener("click", () => {
      if (!switchTab("picker")) return;
      loadPickerFolder(resolveContextFolderId());
    });

    // ShareRadar controls
    el("btn-rescan-radar").addEventListener("click", () => {
      const scanner = resolveScanner();
      const targetFolder = scanner?.rootFolderId || resolveContextFolderId();
      runRadarOnFolder(targetFolder);
    });

    el("btn-save-radar-csv").addEventListener("click", async () => {
      const scanner = resolveScanner();
      if (!scanner || !scanner.rootFolderId) return;
      const btn = el("btn-save-radar-csv");
      const pName = activeProviderName();
      btn.disabled = true;
      try {
        showToast(`Saving sharing summary CSV report to ${pName}...`, "info");
        const saveFn = scanner.saveSnapshotAndCsvToProvider || scanner.saveSnapshotAndCsvToBox;
        const uploaded = await saveFn.call(scanner);
        showToast(`Saved ${uploaded?.name || "CSV report"} to ${pName}.`, "success");
      } catch (err) {
        showToast(err.message || `Could not save CSV report to ${pName}.`, "error");
      } finally {
        btn.disabled = false;
      }
    });

    document.querySelectorAll(".filter-pill[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-pill[data-filter]").forEach((b) => {
          b.classList.remove("active");
        });
        btn.classList.add("active");
        radarFilter = btn.dataset.filter || "all";
        refreshRadarUi();
      });
    });

    el("chk-radar-all").addEventListener("change", (ev) => {
      const checked = Boolean(ev.target.checked);
      document.querySelectorAll("#radar-tbody .radar-row-chk:not(:disabled)").forEach((c) => {
        c.checked = checked;
      });
    });

    el("btn-bulk-expire30").addEventListener("click", () => handleBulkRemediate("expire_30d"));
    el("btn-bulk-viewonly").addEventListener("click", () => handleBulkRemediate("view_only"));
    el("btn-bulk-revoke").addEventListener("click", () => handleBulkRemediate("revoke"));

    // Picker controls
    el("btn-picker-up").addEventListener("click", () => {
      loadPickerFolder(pickerParentId || "0");
    });

    el("btn-picker-root").addEventListener("click", () => {
      loadPickerFolder("0");
    });

    el("btn-audit-current-folder").addEventListener("click", () => {
      runRadarOnFolder(pickerFolderId || "0");
    });
  }

  return {
    primaryTab,
    switchTab,
    runRadarOnFolder,
    refreshRadarUi,
    loadPickerFolder,
    getRadarScanner: resolveScanner,
    consumePendingSuiteTab,
    wireSuiteControls,
    syncCapabilitiesUi,
  };
}

/**
 * Convenience entry point for creating a new standalone DocWorks Suite app or
 * previewing the reusable template cleanly from minimal mount points.
 */
export function mountSuiteTemplate(config = {}) {
  const controller = createSuiteController(config);
  controller.wireSuiteControls();
  if (config.demoMode) {
    el("quota-badge").textContent = config.demoQuotaText || "Template Preview";
    el("quota-badge").classList.remove("hidden");
    el("userBadge").textContent = "Demo Session";
    el("userBadge").classList.remove("hidden");
    const initialTab = config.initialTab || controller.primaryTab;
    if (initialTab === "radar") {
      controller.runRadarOnFolder("0");
    } else if (initialTab === "picker") {
      controller.switchTab("picker");
      controller.loadPickerFolder("0");
    } else {
      controller.switchTab(controller.primaryTab);
    }
  }
  return controller;
}

if (typeof document !== "undefined") {
  const autoBoot = () => {
    const ds = document.body?.dataset;
    if (!ds || ds.suiteAutoMount !== "true") return;
    const ctrl = mountSuiteTemplate({
      suiteName: ds.suiteName || "DocWorks",
      appName: ds.appName || "DocWorks App Template",
      appSubtitle: ds.appSubtitle || "Zero-PII Client-Side Document Workspace",
      providerName: ds.providerName || "Box",
      primaryTab: ds.primaryTab || "workspace",
      primaryTabLabel: ds.primaryTabLabel || "Primary Workspace",
      pickerSubtitle: ds.pickerSubtitle || "",
      demoMode: ds.demoMode === "true",
      demoQuotaText: ds.demoQuotaText || "Template Preview",
      initialTab: ds.initialTab || ds.primaryTab || "workspace",
    });

    const radarShortcut = document.getElementById("btn-template-open-radar");
    if (radarShortcut) {
      radarShortcut.addEventListener("click", () => ctrl.runRadarOnFolder("0"));
    }
    const pickerShortcut = document.getElementById("btn-template-open-picker");
    if (pickerShortcut) {
      pickerShortcut.addEventListener("click", () => {
        if (ctrl.switchTab("picker")) {
          ctrl.loadPickerFolder("0");
        }
      });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBoot);
  } else {
    autoBoot();
  }
}
