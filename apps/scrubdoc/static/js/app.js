import { createProviderClient } from "/static/providers/registry.js?v=12";
import { detectFileFormatFromBytes, runMetadataXray } from "./metadata_xray.js?v=11";
import { generateAnonymousStem, inspectFilenameForPii } from "./pii_detector.js?v=11";
import { RedactorWorkspace } from "./redactor_engine.js?v=11";
import { ShareRadarScanner } from "/static/shared/js/shareradar_engine.js?v=11";
import {
  el,
  showToast,
  hideToast,
  parseLaunchParams,
  closeOrReturnToProvider,
  initUserBadge,
  createSuiteController,
} from "/static/shared/js/suite_shell.js?v=11";

const state = {
  publicConfig: null,
  providerClient: null,
  providerId: "box",
  providerName: "Box",
  sessionProof: null,
  entitlement: null,
  returnUrl: null,
  contextualLaunch: false,
  activeFileMeta: null,
  activeFileFormat: null,
  saveMode: "new_copy", // "new_copy" | "overwrite"
  piiCategoryFilter: "all",
  lastSavedFileId: null,
  lastSharedLinkUrl: null,
  pickerFolderId: "0",
  radarScanner: null,
  redactor: null,
  suite: null,
};

function applyProviderLabels(cfg) {
  const pName = cfg?.provider_name || "Box";
  state.providerId = cfg?.provider_id || "box";
  state.providerName = pName;
  document.querySelectorAll("[data-provider-name]").forEach((node) => {
    node.textContent = pName;
  });
  el("btn-oauth-connect").textContent = `Continue with ${pName}`;
  const radarCsvBtn = document.getElementById("btn-save-radar-csv");
  if (radarCsvBtn) {
    radarCsvBtn.textContent = `Save CSV Report to ${pName}`;
  }
  if (!state.saveMode || state.saveMode === "new_copy") {
    el("btn-save-only").textContent = `Save New Copy to ${pName}`;
  } else {
    el("btn-save-only").textContent = `Replace Original in ${pName}`;
  }
  const pill = document.getElementById("header-privacy-pill");
  if (pill) {
    pill.title = `100% In-Browser: Files are streamed directly between ${pName} and your browser RAM. Zero file bytes are ever stored, cached, or analyzed on external servers.`;
  }
}

function updateQuotaBadge() {
  const badge = el("quota-badge");
  if (!state.entitlement) {
    badge.classList.add("hidden");
    return;
  }
  badge.classList.remove("hidden");
  if (state.entitlement.plan === "pro") {
    badge.textContent = "Pro Plan";
  } else {
    const scrubs = state.entitlement.scrub_remaining;
    badge.textContent = `${scrubs} free save${scrubs === 1 ? "" : "s"} left`;
  }
}

async function checkQuotaAvailable(action, units = 1) {
  const resp = await fetch("/api/entitlement/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_proof: state.sessionProof }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || `Session expired. Please reopen from ${state.providerName}.`);
  }
  if (data.entitlement) {
    state.entitlement = data.entitlement;
    updateQuotaBadge();
  }
  const ent = data.entitlement || state.entitlement;
  if (ent) {
    const isProForAction = action === "radar_fix" ? ent.radar_plan === "pro" : ent.plan === "pro";
    if (!isProForAction) {
      const remaining = action === "scrub" ? ent.scrub_remaining : ent.radar_fixes_remaining;
      const limitVal = action === "scrub" ? ent.scrub_limit : ent.radar_fixes_limit;
      if (typeof remaining === "number" && remaining < units) {
        const defaultLimit = 25;
        return {
          allowed: false,
          message: `Monthly Free limit reached (${limitVal || defaultLimit}/month). Upgrade to ScrubDoc Pro or DocWorks Bundle for unlimited access.`,
        };
      }
    }
  }
  return { allowed: true, message: "" };
}

async function consumeQuotaOrWarn(action, units = 1) {
  const resp = await fetch("/api/entitlement/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_proof: state.sessionProof,
      action,
      units,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data.entitlement) {
    state.entitlement = data.entitlement;
    updateQuotaBadge();
  }
  if (!resp.ok || !data.allowed) {
    showToast(data.message || "Monthly Free plan limit reached.", "error");
    return false;
  }
  return true;
}

function exitToProvider() {
  closeOrReturnToProvider(
    state.returnUrl,
    state.publicConfig?.return_url_regex,
    state.publicConfig?.provider_home_url || "https://app.box.com"
  );
}

async function bootstrap() {
  let pubCfg = {
    provider_id: "box",
    provider_name: "Box",
    provider_home_url: "https://app.box.com",
    return_url_regex: "",
    capabilities: {},
    authorize_url_template: "",
    redirect_uri: null,
  };
  const pubCfgPromise = fetch("/api/public-config")
    .then((r) => r.json())
    .then((cfg) => {
      pubCfg = cfg;
      state.publicConfig = cfg;
      applyProviderLabels(cfg);
      state.suite?.syncCapabilitiesUi?.(cfg.capabilities);
      return cfg;
    })
    .catch(() => pubCfg);

  state.suite = createSuiteController({
    suiteName: "DocWorks",
    appName: "ScrubDoc",
    providerName: state.providerName,
    primaryTab: "scrub",
    primaryTabLabel: "Clean & Redact",
    pickerSubtitle: "Browse the remaining files and folders in the folder you opened from — pick any file to clean or scan folder sharing.",
    getProviderClient: () => state.providerClient,
    getRadarScanner: () => state.radarScanner,
    getActiveFileId: () => state.activeFileMeta?.id || null,
    getContextFolderId: () => state.pickerFolderId,
    setContextFolderId: (id) => {
      state.pickerFolderId = String(id || "0");
    },
    checkQuota: checkQuotaAvailable,
    consumeQuota: consumeQuotaOrWarn,
    renderFileActions: (entry) => {
      const m = /\.([a-zA-Z0-9]+)$/.exec(entry.name || "");
      const ext = (entry.extension || (m ? m[1] : "")).toLowerCase();
      const supported = ["pdf", "jpg", "jpeg", "png", "webp", "docx"].includes(ext);
      const btnScrub = document.createElement("button");
      btnScrub.className = supported ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
      btnScrub.type = "button";
      btnScrub.disabled = !supported;
      btnScrub.textContent = supported ? "Clean & Redact" : "Unsupported";
      if (supported) {
        btnScrub.addEventListener("click", () => {
          state.suite.switchTab("scrub");
          openFileInScrubber(entry.id);
        });
      }
      return [btnScrub];
    },
  });

  state.suite.wireSuiteControls();

  el("btn-open-picker-from-scrub").addEventListener("click", () => {
    state.suite.switchTab("picker");
    state.suite.loadPickerFolder(state.pickerFolderId);
  });
  el("btn-done-window").addEventListener("click", exitToProvider);
  el("btn-done-after-save").addEventListener("click", exitToProvider);

  state.redactor = new RedactorWorkspace(el("redactor-canvas"), renderRedactorSidebarState);
  wireScrubControls();

  el("btn-oauth-connect").addEventListener("click", async () => {
    const cfg = state.publicConfig || (await pubCfgPromise);
    if (cfg && cfg.provider_ready === false) {
      showToast(`${cfg.provider_name || "Selected"} provider integration is coming soon.`, "warn");
      return;
    }
    if (!cfg?.authorize_url_template) {
      showToast(`${cfg?.provider_name || state.providerName} OAuth credentials are not configured yet.`, "error");
      return;
    }
    window.location.href = cfg.authorize_url_template;
  });

  const launch = parseLaunchParams();
  const resolvedCfg = await pubCfgPromise;

  if (launch.returnUrl) {
    const regexStr = resolvedCfg?.return_url_regex;
    let allowedReturn = false;
    if (regexStr) {
      try {
        allowedReturn = new RegExp(regexStr, "i").test(launch.returnUrl);
      } catch {
        allowedReturn = false;
      }
    } else {
      allowedReturn = /^https:\/\/([a-z0-9-]+\.)*(box\.com|app\.box\.com)\//i.test(launch.returnUrl);
    }
    if (allowedReturn) {
      state.returnUrl = launch.returnUrl;
    }
  }

  if (launch.oauthError && !launch.authCode) {
    showToast(`${state.providerName} sign-in error: ${launch.oauthError}`, "error");
    return;
  }

  if (!launch.authCode) {
    return;
  }

  el("connect-heading").textContent = launch.folderId
    ? `Opening your ${state.providerName} folder...`
    : `Opening your ${state.providerName} file...`;
  el("connect-subtext").textContent = "Just a moment while we prepare your workspace.";
  el("btn-oauth-connect").disabled = true;

  try {
    // Only standalone /callback redirects need redirect_uri; native Web Integration launches fire immediately!
    const redirectUri = launch.fromCallback ? resolvedCfg?.redirect_uri : null;
    const exchResp = await fetch("/api/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_code: launch.authCode,
        redirect_uri: redirectUri,
      }),
    });
    const exchData = await exchResp.json();
    if (!exchResp.ok) {
      throw new Error(exchData.detail || `Could not sign in with ${state.providerName}.`);
    }

    state.providerClient = createProviderClient(
      resolvedCfg?.provider_id || "box",
      exchData.access_token,
      resolvedCfg?.capabilities
    );
    state.sessionProof = exchData.session_proof;
    state.entitlement = exchData.entitlement;
    state.radarScanner = new ShareRadarScanner(state.providerClient);

    initUserBadge(state.providerClient, `${state.providerName} Connected`);

    el("screen-connect").classList.add("hidden");
    el("main-tabs").classList.remove("hidden");
    el("btn-done-window").classList.remove("hidden");
    updateQuotaBadge();

    // Always keep #main-tabs (Clean & Redact | ShareRadar Pro | Other Files in Folder) visible across every mode.
    if (launch.fileId) {
      state.contextualLaunch = true;
      state.suite.switchTab("scrub");
      await openFileInScrubber(launch.fileId);
    } else if (launch.folderId) {
      state.contextualLaunch = true;
      state.suite.switchTab("radar");
      await state.suite.runRadarOnFolder(launch.folderId);
    } else {
      const pendingTab = state.suite.consumePendingSuiteTab("picker");
      if (pendingTab === "radar") {
        await state.suite.runRadarOnFolder("0");
      } else if (pendingTab === "scrub") {
        state.suite.switchTab("scrub");
      } else {
        state.suite.switchTab("picker");
        await state.suite.loadPickerFolder("0");
      }
    }
  } catch (err) {
    el("connect-heading").textContent = `Share ${state.providerName} files with confidence`;
    el("connect-subtext").textContent =
      "Automatically remove hidden personal details, black out sensitive info, and review shared folders.";
    el("btn-oauth-connect").disabled = false;
    showToast(err.message || "Sign-in failed.", "error");
  }
}

/* ========================================================================= */
/* SCREEN 1: CLEAN & REDACT FILE                                             */
/* ========================================================================= */

async function openFileInScrubber(fileId) {
  hideToast();
  el("scrub-empty-prompt").classList.add("hidden");
  el("scrub-workspace").classList.remove("hidden");
  el("save-success-box").classList.add("hidden");
  el("save-error-box").classList.add("hidden");
  const xrayIcon = el("xray-badge-icon");
  xrayIcon.className = "check-circle is-neutral";
  xrayIcon.textContent = "•";
  el("xray-title").textContent = "File properties";
  el("xray-summary").textContent = "Checking file header...";
  el("xray-details-wrap").classList.add("hidden");
  el("xray-list").innerHTML = "";
  el("pii-checklist").innerHTML = "";
  state.lastSavedFileId = null;
  state.lastSharedLinkUrl = null;

  try {
    const [meta, bytes] = await Promise.all([
      state.providerClient.getFileMetadata(fileId),
      state.providerClient.downloadFileBytes(fileId),
    ]);
    state.activeFileMeta = meta;
    if (meta.parent?.id) {
      state.pickerFolderId = String(meta.parent.id);
    }
    el("active-context-label").textContent = meta.name;
    el("scrub-file-label").textContent = meta.name;

    const fmt = detectFileFormatFromBytes(bytes, meta.name);
    state.activeFileFormat = fmt;

    const isDocx = fmt === "docx";
    state.piiCategoryFilter = "all";
    el("canvas-wrapper").classList.toggle("hidden", isDocx);
    el("docx-friendly-card").classList.toggle("hidden", !isDocx);
    el("draw-helper-tip").classList.toggle("hidden", isDocx);
    el("pii-section-card").classList.remove("hidden");

    const rawStem = meta.name.replace(/\.[^.]+$/, "");
    el("inp-output-stem").value = /_Clean(\s*\(\d+\))?$/i.test(rawStem) ? rawStem : `${rawStem}_Clean`;
    el("lbl-output-ext").textContent =
      fmt === "pdf" ? ".pdf" : fmt === "docx" ? ".docx" : fmt === "png" ? ".png" : ".jpg";
    checkFilenameWarning();

    const [leaks] = await Promise.all([
      runMetadataXray(bytes, fmt),
      state.redactor.loadDocument(bytes, fmt),
    ]);
    const xrayList = el("xray-list");
    xrayList.innerHTML = "";

    if (leaks.length === 0) {
      xrayIcon.className = "check-circle";
      xrayIcon.textContent = "✓";
      el("xray-title").textContent = "File properties clean";
      el("xray-summary").textContent = "No hidden author, GPS, or device data.";
      el("xray-details-wrap").classList.add("hidden");
    } else {
      xrayIcon.className = "check-circle is-amber";
      xrayIcon.textContent = "!";
      el("xray-title").textContent =
        leaks.length === 1 ? "1 hidden file property" : `${leaks.length} hidden file properties`;
      el("xray-summary").textContent = "Removed automatically on save.";
      el("xray-details-summary").textContent = `Show hidden properties (${leaks.length})`;
      el("xray-details-wrap").classList.remove("hidden");

      for (const lk of leaks) {
        const li = document.createElement("li");
        const b = document.createElement("strong");
        b.textContent = `${lk.title}: `;
        const sp = document.createElement("span");
        sp.textContent = lk.detail;
        li.append(b, sp);
        xrayList.appendChild(li);
      }
    }

    renderRedactorSidebarState();
  } catch (err) {
    console.error("openFileInScrubber error:", err);
    showToast(err.message || `Unable to open this file from ${state.providerName}.`, "error");
  }
}

function checkFilenameWarning() {
  const stem = el("inp-output-stem").value || "";
  const check = inspectFilenameForPii(stem);
  el("btn-anonymize-name").classList.toggle("hidden", !check.hasRisk);
}

function renderRedactorSidebarState() {
  const r = state.redactor;
  if (!r) return;

  const showStepper = r.format === "pdf" && r.pageCount > 1;
  el("page-stepper").classList.toggle("hidden", !showStepper);
  if (showStepper) {
    el("page-indicator").textContent = `${r.currentPage + 1} / ${r.pageCount}`;
    el("btn-prev-page").disabled = r.currentPage <= 0;
    el("btn-next-page").disabled = r.currentPage >= r.pageCount - 1;
  }

  el("manual-box-controls").classList.toggle("hidden", r.manualBoxes.length === 0);

  el("ocr-progress-row").classList.toggle("hidden", !r.isOcrScanning);
  if (r.isOcrScanning) {
    el("ocr-progress-text").textContent = r.ocrStatusText || "Scanning image text for PII & PHI...";
  }

  const totalFound = r.autoFindings.length;
  const activeAuto = r.autoFindings.filter((f) => f.enabled).length;
  const totalActive = activeAuto + r.manualBoxes.length;

  if (totalFound === 0 && r.manualBoxes.length === 0) {
    el("pii-count-badge").textContent = r.isOcrScanning ? "Scanning..." : "None found";
  } else if (totalActive === 0) {
    el("pii-count-badge").textContent = `${totalFound} highlighted`;
  } else {
    el("pii-count-badge").textContent = `${totalActive} blacked out`;
  }

  const catCounts = {
    all: totalFound,
    phi: r.autoFindings.filter((f) => f.category === "phi").length,
    pii: r.autoFindings.filter((f) => f.category === "pii").length,
    financial: r.autoFindings.filter((f) => f.category === "financial").length,
  };
  if (state.piiCategoryFilter !== "all" && !catCounts[state.piiCategoryFilter]) {
    state.piiCategoryFilter = "all";
  }

  const nonZeroCats = ["phi", "pii", "financial"].filter((c) => catCounts[c] > 0);
  const pillsWrap = el("pii-category-pills");
  pillsWrap.classList.toggle("hidden", nonZeroCats.length < 2);
  if (nonZeroCats.length >= 2) {
    const labels = {
      all: `All (${catCounts.all})`,
      phi: `PHI (${catCounts.phi})`,
      pii: `Personal (${catCounts.pii})`,
      financial: `Financial (${catCounts.financial})`,
    };
    pillsWrap.querySelectorAll(".cat-pill").forEach((btn) => {
      const cat = btn.dataset.cat;
      const count = catCounts[cat] || 0;
      btn.classList.toggle("hidden", cat !== "all" && count === 0);
      btn.classList.toggle("active", state.piiCategoryFilter === cat);
      btn.textContent = labels[cat] || cat;
    });
  }

  const visibleFindings = r.autoFindings.filter(
    (f) => state.piiCategoryFilter === "all" || f.category === state.piiCategoryFilter
  );

  const bulkBar = el("pii-bulk-bar");
  bulkBar.classList.toggle("hidden", totalFound === 0);
  if (totalFound > 0) {
    const uncheckedVisible = visibleFindings.filter((f) => !f.enabled).length;
    const btnBlackoutAll = el("btn-blackout-all");
    btnBlackoutAll.disabled = uncheckedVisible === 0;
    if (uncheckedVisible === 0) {
      btnBlackoutAll.textContent = "All Selected Blacked Out";
    } else if (state.piiCategoryFilter === "all") {
      btnBlackoutAll.textContent = `Black Out All (${totalFound})`;
    } else {
      btnBlackoutAll.textContent = `Black Out ${visibleFindings.length} Shown`;
    }
    el("btn-unselect-all").disabled = activeAuto === 0;
  }

  const list = el("pii-checklist");
  list.innerHTML = "";

  if (totalFound === 0 && r.manualBoxes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pii-empty";
    empty.textContent = r.isOcrScanning
      ? "Reading image text privately in your browser to highlight PII & PHI..."
      : r.format === "docx"
      ? "No structured PII or PHI patterns found in document body."
      : "No SSNs, PHI IDs, dates, cards, emails, or phones detected. Drag anywhere on the page to black out custom areas.";
    list.appendChild(empty);
    return;
  }

  const catShortTag = { phi: "PHI", pii: "PII", financial: "FIN" };

  for (const f of visibleFindings) {
    const row = document.createElement("label");
    row.className = `pii-item ${f.enabled ? "is-covered" : ""}`;

    row.addEventListener("mouseenter", () => r.setHoveredFinding(f.id));
    row.addEventListener("mouseleave", () => r.setHoveredFinding(null));

    const infoDiv = document.createElement("div");
    const titleRow = document.createElement("div");
    titleRow.className = "pii-title-row";

    const catBadge = document.createElement("span");
    catBadge.className = `pii-cat-tag pii-cat-${f.category || "pii"}`;
    catBadge.textContent = catShortTag[f.category] || "PII";

    const titleText = document.createElement("span");
    titleText.textContent = f.label;
    titleRow.append(catBadge, titleText);

    const metaDiv = document.createElement("div");
    metaDiv.className = "pii-item-meta";
    const locLabel = f.isDocxText
      ? f.occurrences > 1
        ? `${f.occurrences} matches in document`
        : "In Word text"
      : r.pageCount > 1
      ? `Page ${f.pageIndex + 1}`
      : f.enabled
      ? "Blacked out"
      : "Highlighted on page";
    metaDiv.textContent = `${f.masked} · ${locLabel}`;
    infoDiv.append(titleRow, metaDiv);

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = f.enabled;
    chk.addEventListener("change", async () => {
      f.enabled = chk.checked;
      if (!f.isDocxText && r.format === "pdf" && r.currentPage !== f.pageIndex) {
        await r.renderPage(f.pageIndex);
      } else {
        r.redrawOverlay();
      }
      renderRedactorSidebarState();
    });

    row.append(infoDiv, chk);
    list.appendChild(row);
  }

  if (r.manualBoxes.length > 0) {
    const manualRow = document.createElement("div");
    manualRow.className = "pii-item is-covered";
    const lbl = document.createElement("span");
    lbl.textContent = `${r.manualBoxes.length} custom blackout area${r.manualBoxes.length === 1 ? "" : "s"}`;
    const pill = document.createElement("span");
    pill.className = "badge badge-safe";
    pill.textContent = "Covered";
    manualRow.append(lbl, pill);
    list.appendChild(manualRow);
  }
}

function wireScrubControls() {
  el("btn-prev-page").addEventListener("click", () => {
    state.redactor.renderPage(state.redactor.currentPage - 1);
    renderRedactorSidebarState();
  });
  el("btn-next-page").addEventListener("click", () => {
    state.redactor.renderPage(state.redactor.currentPage + 1);
    renderRedactorSidebarState();
  });
  el("btn-undo-box").addEventListener("click", () => state.redactor.undoLastManualBox());
  el("btn-clear-boxes").addEventListener("click", () => state.redactor.clearManualBoxes());
  el("btn-blackout-all").addEventListener("click", () => {
    state.redactor.setAllAutoFindings(true, state.piiCategoryFilter);
  });
  el("btn-unselect-all").addEventListener("click", () => {
    state.redactor.setAllAutoFindings(false, "all");
  });
  document.querySelectorAll(".cat-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.piiCategoryFilter = btn.dataset.cat || "all";
      renderRedactorSidebarState();
    });
  });

  const applySaveModeUi = (mode) => {
    state.saveMode = mode === "overwrite" ? "overwrite" : "new_copy";
    const isOverwrite = state.saveMode === "overwrite";
    const pName = state.providerName || "Box";
    el("btn-mode-new-copy").classList.toggle("active", !isOverwrite);
    el("btn-mode-overwrite").classList.toggle("active", isOverwrite);
    el("filename-field-wrap").classList.toggle("hidden", isOverwrite);
    el("btn-save-only").textContent = isOverwrite
      ? `Replace Original in ${pName}`
      : `Save New Copy to ${pName}`;
    el("btn-save-and-link").textContent = isOverwrite
      ? "Replace & Copy Link"
      : "Save Copy & Copy Link";
    el("save-mode-note").textContent = isOverwrite
      ? `Replaces this file in ${pName} with the cleaned version.`
      : "Saves a new clean file. Original stays untouched.";
    el("save-error-box").classList.add("hidden");
  };

  el("btn-mode-new-copy").addEventListener("click", () => applySaveModeUi("new_copy"));
  el("btn-mode-overwrite").addEventListener("click", () => applySaveModeUi("overwrite"));

  el("inp-output-stem").addEventListener("input", checkFilenameWarning);
  el("btn-anonymize-name").addEventListener("click", () => {
    el("inp-output-stem").value = generateAnonymousStem();
    checkFilenameWarning();
  });

  el("btn-open-saved-file").addEventListener("click", () => {
    if (!state.lastSavedFileId) return;
    openFileInScrubber(state.lastSavedFileId);
  });

  el("btn-copy-saved-link").addEventListener("click", async () => {
    if (!state.lastSavedFileId) return;
    try {
      if (!state.lastSharedLinkUrl) {
        const sl = await state.providerClient.createSharedLinkForFile(state.lastSavedFileId, "open", true);
        state.lastSharedLinkUrl = sl?.url || null;
      }
      if (state.lastSharedLinkUrl && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.lastSharedLinkUrl);
        showToast("Share link copied to clipboard!", "success");
      }
    } catch (err) {
      showToast(err.message || "Could not create share link.", "error");
    }
  });

  const showSaveError = (msg) => {
    const errBox = el("save-error-box");
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
    showToast(msg, "error");
  };

  const handleExport = async (createLinkAfter) => {
    if (!state.activeFileMeta || !state.redactor.rawBytes) return;
    const pName = state.providerName || "Box";
    const errBox = el("save-error-box");
    errBox.classList.add("hidden");
    el("save-success-box").classList.add("hidden");

    const btnA = el("btn-save-only");
    const btnB = el("btn-save-and-link");
    btnA.disabled = true;
    btnB.disabled = true;

    try {
      // 1. Pre-check quota WITHOUT decrementing so failed uploads never burn free saves!
      const quotaCheck = await checkQuotaAvailable("scrub", 1);
      if (!quotaCheck.allowed) {
        showSaveError(quotaCheck.message);
        return;
      }

      showToast(`Saving redacted file to ${pName}...`, "info");
      const result = await state.redactor.exportSanitizedBytes({ flattenAllPages: false });
      const parentId = state.activeFileMeta.parent?.id || state.pickerFolderId || "0";
      const stem = el("inp-output-stem").value.trim() || "Clean_Copy";

      let uploaded = null;
      let usedSingleFileFallback = false;

      if (state.saveMode === "overwrite") {
        uploaded = await state.providerClient.uploadNewFileVersion(
          state.activeFileMeta.id,
          state.activeFileMeta.name,
          result.mimeType,
          result.bytes
        );
      } else {
        const uploadNew = state.providerClient.uploadNewFile || state.providerClient.uploadNewSafeCopy;
        try {
          uploaded = await uploadNew.call(
            state.providerClient,
            parentId,
            stem,
            result.extension,
            result.mimeType,
            result.bytes
          );
        } catch (uploadErr) {
          // Box Web Integration tokens with single-file scope (or file-only shares without
          // parent-folder visibility) reject POST /files/content with HTTP 403 or 404.
          const isParentScopeError = uploadErr && (uploadErr.status === 403 || uploadErr.status === 404);
          if (!isParentScopeError) {
            throw uploadErr;
          }
          try {
            uploaded = await state.providerClient.uploadNewFileVersion(
              state.activeFileMeta.id,
              state.activeFileMeta.name,
              result.mimeType,
              result.bytes
            );
            usedSingleFileFallback = true;
          } catch (fallbackErr) {
            throw new Error(
              `Could not create a new copy in this ${pName} folder (${uploadErr.message}), ` +
                `and updating the existing file failed (${fallbackErr.message || "permission denied"}). ` +
                `Check that ${pName} Web Integration uses Parent Folder scope and Read/Write permissions.`
            );
          }
        }
      }

      // 2. Consume quota ONLY AFTER cloud storage confirms the file was saved!
      await consumeQuotaOrWarn("scrub", 1);

      state.lastSavedFileId = uploaded.id;
      state.lastSharedLinkUrl = null;

      const subEl = el("save-success-sub");
      if (usedSingleFileFallback) {
        subEl.textContent =
          `Updated original file as a new version in ${pName} (parent-folder access unavailable — ` +
          `enable Parent Folder scope in ${pName} Web Integration to create separate copies).`;
        subEl.classList.remove("hidden");
      } else {
        subEl.textContent = "";
        subEl.classList.add("hidden");
      }

      if (state.saveMode === "overwrite" || usedSingleFileFallback) {
        const xIcon = el("xray-badge-icon");
        xIcon.className = "check-circle";
        xIcon.textContent = "✓";
        el("xray-title").textContent = "File properties cleaned";
        el("xray-summary").textContent = "Hidden header data removed.";
        el("xray-details-wrap").classList.add("hidden");
      }

      if (createLinkAfter) {
        const sl = await state.providerClient.createSharedLinkForFile(uploaded.id, "open", true);
        state.lastSharedLinkUrl = sl?.url || null;
        if (state.lastSharedLinkUrl && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(state.lastSharedLinkUrl).catch(() => {});
        }
        hideToast();
        el("save-success-title").textContent = `Saved "${uploaded.name}" & copied link`;
      } else {
        hideToast();
        el("save-success-title").textContent =
          state.saveMode === "overwrite" || usedSingleFileFallback
            ? `Replaced "${uploaded.name}" in ${pName}`
            : `Saved "${uploaded.name}" to ${pName}`;
      }

      el("btn-copy-saved-link").classList.remove("hidden");
      el("save-success-box").classList.remove("hidden");
    } catch (err) {
      showSaveError(err.message || `Could not save redacted file to ${pName}.`);
    } finally {
      btnA.disabled = false;
      btnB.disabled = false;
    }
  };

  el("btn-save-only").addEventListener("click", () => handleExport(false));
  el("btn-save-and-link").addEventListener("click", () => handleExport(true));
}

bootstrap();
