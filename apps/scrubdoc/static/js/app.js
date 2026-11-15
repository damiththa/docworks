import { createProviderClient } from "/static/providers/registry.js?v=12";
import { detectFileFormatFromBytes, runMetadataXray } from "./metadata_xray.js?v=14";
import { generateAnonymousStem, inspectFilenameForPii } from "./pii_detector.js?v=14";
import { RedactorWorkspace, findTermRangesInText } from "./redactor_engine.js?v=15";
import { ShareRadarScanner } from "/static/shared/js/shareradar_engine.js?v=11";
import {
  el,
  showToast,
  hideToast,
  parseLaunchParams,
  closeOrReturnToProvider,
  initUserBadge,
  createSuiteController,
} from "/static/shared/js/suite_shell.js?v=13";

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
  pendingDocxSelection: null,
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
    pickerSubtitle: "Browse files and folders in this folder — pick any file to clean or scan folder sharing.",
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

  state.redactor = new RedactorWorkspace(
    el("redactor-canvas"),
    renderRedactorSidebarState,
    updateDocxHoverHighlight
  );
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

    // Always keep #main-tabs (Clean & Redact | ShareRadar Pro | Browse Files/Folders) visible across every mode.
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
  el("docx-preview-sections").innerHTML = "";
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
    el("scrub-file-label").textContent = meta.name;

    const fmt = detectFileFormatFromBytes(bytes, meta.name);
    state.activeFileFormat = fmt;

    const isDocx = fmt === "docx";
    state.piiCategoryFilter = "all";
    state.pendingDocxSelection = null;
    el("canvas-wrapper").classList.toggle("hidden", isDocx);
    el("docx-friendly-card").classList.toggle("hidden", !isDocx);
    el("docx-selection-bar").classList.add("hidden");
    el("docx-custom-bar").classList.toggle("hidden", !isDocx);
    el("inp-docx-custom-term").value = "";
    el("draw-helper-tip").classList.remove("hidden");
    el("draw-helper-tip").textContent = isDocx
      ? "Click highlighted items, drag text below, or add terms on the right"
      : "Click highlighted items or drag anywhere to black out";
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
    clearDocxSelectionBar();
    el("scrub-workspace").classList.add("hidden");
    el("scrub-empty-prompt").classList.remove("hidden");
    showToast(err.message || `Unable to open this file from ${state.providerName}.`, "error");
  }
}

function clearDocxSelectionBar(clearDomSelection = false) {
  state.pendingDocxSelection = null;
  const bar = el("docx-selection-bar");
  if (bar) bar.classList.add("hidden");
  if (clearDomSelection) {
    window.getSelection?.()?.removeAllRanges?.();
  }
}

function measureParaCharOffset(paraEl, targetNode, targetOffset) {
  if (!paraEl || !paraEl.contains(targetNode)) return null;
  if (targetNode === paraEl && targetOffset >= paraEl.childNodes.length) {
    return paraEl.textContent.length;
  }
  let acc = 0;
  let found = false;
  const walk = (node) => {
    if (found) return;
    if (node === targetNode && node.nodeType === 3) {
      acc += Math.min(targetOffset, (node.nodeValue || "").length);
      found = true;
      return;
    }
    if (node === targetNode && node.nodeType === 1) {
      const limit = Math.min(targetOffset, node.childNodes.length);
      for (let i = 0; i < limit; i++) {
        acc += (node.childNodes[i].textContent || "").length;
      }
      found = true;
      return;
    }
    if (node.nodeType === 3) {
      acc += (node.nodeValue || "").length;
      return;
    }
    for (const ch of node.childNodes) {
      walk(ch);
      if (found) return;
    }
  };
  walk(paraEl);
  return found ? acc : null;
}

function captureDocxSelectionSnapshot() {
  const r = state.redactor;
  const container = el("docx-preview-sections");
  if (!r || r.format !== "docx" || !container) {
    clearDocxSelectionBar();
    return;
  }

  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    clearDocxSelectionBar();
    return;
  }

  const range = sel.getRangeAt(0);
  const findPara = (node) => {
    const elem = node.nodeType === 1 ? node : node.parentElement;
    return elem?.closest?.(".docx-para") || null;
  };
  const startPara = findPara(range.startContainer);
  const endPara = findPara(range.endContainer);
  if (!startPara || !endPara || !container.contains(startPara) || !container.contains(endPara)) {
    clearDocxSelectionBar();
    return;
  }

  const allParas = Array.from(container.querySelectorAll(".docx-para"));
  const pStartIdx = allParas.indexOf(startPara);
  const pEndIdx = allParas.indexOf(endPara);
  if (pStartIdx === -1 || pEndIdx === -1) {
    clearDocxSelectionBar();
    return;
  }

  const [firstIdx, lastIdx] = pStartIdx <= pEndIdx ? [pStartIdx, pEndIdx] : [pEndIdx, pStartIdx];
  const rawStartOff = measureParaCharOffset(startPara, range.startContainer, range.startOffset);
  const rawEndOff = measureParaCharOffset(endPara, range.endContainer, range.endOffset);
  if (rawStartOff === null || rawEndOff === null) {
    clearDocxSelectionBar();
    return;
  }

  const startOffsetInFirst =
    pStartIdx === pEndIdx ? Math.min(rawStartOff, rawEndOff) : pStartIdx < pEndIdx ? rawStartOff : rawEndOff;
  const endOffsetInLast =
    pStartIdx === pEndIdx ? Math.max(rawStartOff, rawEndOff) : pStartIdx < pEndIdx ? rawEndOff : rawStartOff;

  const slices = [];
  const selectedParts = [];

  for (let i = firstIdx; i <= lastIdx; i++) {
    const pEl = allParas[i];
    const sectionPath = pEl.dataset.sectionPath;
    const blockIndex = parseInt(pEl.dataset.blockIndex || "-1", 10);
    const sec = r.docxPreviewSections.find((s) => s.path === sectionPath);
    const lineText = sec?.lines?.[blockIndex];
    if (typeof lineText !== "string") continue;

    let sChar = i === firstIdx ? startOffsetInFirst : 0;
    let eChar = i === lastIdx ? endOffsetInLast : lineText.length;
    if (firstIdx === lastIdx) {
      const sub = lineText.slice(sChar, eChar);
      const leadWs = sub.length - sub.trimStart().length;
      const trailWs = sub.length - sub.trimEnd().length;
      sChar += leadWs;
      eChar -= trailWs;
    }
    if (sChar >= eChar) continue;
    const sliceText = lineText.slice(sChar, eChar);
    if (!sliceText.trim()) continue;
    slices.push({
      sectionPath,
      sectionTitle: sec.title,
      blockIndex,
      startChar: sChar,
      endChar: eChar,
    });
    selectedParts.push(sliceText);
  }

  if (slices.length === 0) {
    clearDocxSelectionBar();
    return;
  }

  const rawValue = selectedParts.join("\n");
  const allCount = slices.length === 1 ? r.countDocxTermOccurrences(rawValue, false) : 0;
  state.pendingDocxSelection = {
    rawValue,
    sectionPath: slices[0].sectionPath,
    sectionTitle: slices[0].sectionTitle,
    slices,
    allCount,
  };

  const compact = rawValue.replace(/\s+/g, " ").trim();
  const snippet = compact.length > 36 ? `${compact.slice(0, 33)}...` : compact;
  el("docx-sel-preview").textContent = `Selected: "${snippet}"`;

  const btnHere = el("btn-docx-redact-here");
  const btnAll = el("btn-docx-redact-all");
  if (slices.length === 1 && allCount > 1) {
    btnHere.textContent = "Black Out Here";
    btnAll.textContent = `All Matches (${allCount})`;
    btnAll.classList.remove("hidden");
  } else {
    btnHere.textContent = slices.length > 1 ? `Black Out Selection (${slices.length} lines)` : "Black Out Selection";
    btnAll.classList.add("hidden");
  }
  el("docx-selection-bar").classList.remove("hidden");
}

function updateDocxHoverHighlight(findingId) {
  const container = el("docx-preview-sections");
  if (!container) return;
  container.querySelectorAll(".docx-pii-token").forEach((tok) => {
    tok.classList.toggle("is-hovered", Boolean(findingId) && tok.dataset.findingId === findingId);
  });
}

function appendHighlightedDocxLine(pEl, line, secPath, blkIdx, findingsDesc, customItems, hoveredId, redactor) {
  const candidates = [];

  for (const m of customItems) {
    if (m.scope === "instance") {
      for (const sl of m.slices || []) {
        if (sl.sectionPath === secPath && sl.blockIndex === blkIdx) {
          const s = Math.max(0, sl.startChar);
          const e = Math.min(line.length, sl.endChar);
          if (s < e) {
            candidates.push({ start: s, end: e, finding: m, priority: 2 });
          }
        }
      }
    } else if (m.rawValue) {
      for (const r of findTermRangesInText(line, m.rawValue, Boolean(m.caseInsensitive))) {
        candidates.push({ start: r.start, end: r.end, finding: m, priority: 1 });
      }
    }
  }

  for (const f of findingsDesc) {
    if (!f.rawValue) continue;
    for (const r of findTermRangesInText(line, f.rawValue, false)) {
      candidates.push({ start: r.start, end: r.end, finding: f, priority: 0 });
    }
  }

  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start
  );

  const spans = [];
  for (const c of candidates) {
    const overlaps = spans.some((s) => Math.max(s.start, c.start) < Math.min(s.end, c.end));
    if (!overlaps) spans.push(c);
  }
  spans.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const sp of spans) {
    if (sp.start > cursor) {
      pEl.appendChild(document.createTextNode(line.slice(cursor, sp.start)));
    }
    const f = sp.finding;
    const rawSeg = line.slice(sp.start, sp.end);
    const tok = document.createElement("span");
    tok.setAttribute("role", "button");
    tok.tabIndex = 0;
    tok.dataset.findingId = f.id;
    tok.className = `docx-pii-token${f.isCustomDocx ? " is-custom" : ""}${f.enabled ? " is-redacted" : ""}${
      hoveredId === f.id ? " is-hovered" : ""
    }`;
    tok.setAttribute("aria-pressed", f.enabled ? "true" : "false");
    tok.title = `${f.label} — ${f.enabled ? "click to restore" : "click to black out"}`;
    tok.textContent = f.enabled ? "█".repeat(rawSeg.length) : rawSeg;
    const toggleToken = () => {
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) return;
      f.enabled = !f.enabled;
      redactor.onStateChange?.();
    };
    tok.addEventListener("click", toggleToken);
    tok.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleToken();
      }
    });
    tok.addEventListener("mouseenter", () => redactor.setHoveredFinding(f.id));
    tok.addEventListener("mouseleave", () => redactor.setHoveredFinding(null));
    pEl.appendChild(tok);
    cursor = sp.end;
  }
  if (cursor < line.length) {
    pEl.appendChild(document.createTextNode(line.slice(cursor)));
  }
}

function renderDocxPreview() {
  const r = state.redactor;
  const container = el("docx-preview-sections");
  if (!r || !container || r.format !== "docx") return;

  container.innerHTML = "";
  const sections = r.docxPreviewSections || [];
  if (sections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "docx-empty-note";
    empty.textContent = "No readable text found inside this Word document.";
    container.appendChild(empty);
    return;
  }

  const findingsDesc = (r.autoFindings || [])
    .filter((f) => f.rawValue)
    .slice()
    .sort((a, b) => b.rawValue.length - a.rawValue.length);
  const customItems = r.manualDocxRedactions || [];

  for (const sec of sections) {
    const secBlock = document.createElement("div");
    secBlock.className = "docx-sec-block";

    const label = document.createElement("div");
    label.className = "docx-sec-label";
    label.textContent = sec.title;
    secBlock.appendChild(label);

    for (let blkIdx = 0; blkIdx < sec.lines.length; blkIdx++) {
      const line = sec.lines[blkIdx];
      const pEl = document.createElement("p");
      pEl.className = "docx-para";
      pEl.dataset.sectionPath = sec.path;
      pEl.dataset.blockIndex = String(blkIdx);
      appendHighlightedDocxLine(
        pEl,
        line,
        sec.path,
        blkIdx,
        findingsDesc,
        customItems,
        r.hoveredFindingId,
        r
      );
      secBlock.appendChild(pEl);
    }
    container.appendChild(secBlock);
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

  if (r.format === "docx") {
    renderDocxPreview();
    clearDocxSelectionBar();
  }

  const showStepper = r.format === "pdf" && r.pageCount > 1;
  el("page-stepper").classList.toggle("hidden", !showStepper);
  if (showStepper) {
    el("page-indicator").textContent = `${r.currentPage + 1} / ${r.pageCount}`;
    el("btn-prev-page").disabled = r.currentPage <= 0;
    el("btn-next-page").disabled = r.currentPage >= r.pageCount - 1;
  }

  const manualCount = r.getManualRedactionCount();
  el("manual-box-controls").classList.toggle("hidden", manualCount === 0);
  el("btn-clear-boxes").textContent = r.format === "docx" ? "Clear custom" : "Clear drawn";
  el("docx-custom-bar").classList.toggle("hidden", r.format !== "docx");

  el("ocr-progress-row").classList.toggle("hidden", !r.isOcrScanning);
  if (r.isOcrScanning) {
    el("ocr-progress-text").textContent = r.ocrStatusText || "Scanning image text for PII & PHI...";
  }

  const customItems = r.manualDocxRedactions || [];
  const allItems = [...r.autoFindings, ...customItems];
  const totalFound = allItems.length;
  const activeItems = allItems.filter((f) => f.enabled).length;
  const totalActive = activeItems + r.manualBoxes.length;

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
    custom: customItems.length,
  };
  if (state.piiCategoryFilter !== "all" && !catCounts[state.piiCategoryFilter]) {
    state.piiCategoryFilter = "all";
  }

  const nonZeroCats = ["phi", "pii", "financial", "custom"].filter((c) => catCounts[c] > 0);
  const pillsWrap = el("pii-category-pills");
  pillsWrap.classList.toggle("hidden", nonZeroCats.length < 2);
  if (nonZeroCats.length >= 2) {
    const labels = {
      all: `All (${catCounts.all})`,
      phi: `PHI (${catCounts.phi})`,
      pii: `Personal (${catCounts.pii})`,
      financial: `Financial (${catCounts.financial})`,
      custom: `Custom (${catCounts.custom})`,
    };
    pillsWrap.querySelectorAll(".cat-pill").forEach((btn) => {
      const cat = btn.dataset.cat;
      const count = catCounts[cat] || 0;
      btn.classList.toggle("hidden", cat !== "all" && count === 0);
      btn.classList.toggle("active", state.piiCategoryFilter === cat);
      btn.textContent = labels[cat] || cat;
    });
  }

  const visibleFindings = allItems.filter(
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
    el("btn-unselect-all").disabled = activeItems === 0;
  }

  const list = el("pii-checklist");
  list.innerHTML = "";

  if (totalFound === 0 && r.manualBoxes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pii-empty";
    empty.textContent = r.isOcrScanning
      ? "Reading image text privately in your browser to highlight PII & PHI..."
      : r.format === "docx"
      ? "No structured PII or PHI patterns detected automatically. Drag text in the preview or add a custom phrase above to black out."
      : "No SSNs, PHI IDs, dates, cards, emails, or phones detected. Drag anywhere on the page to black out custom areas.";
    list.appendChild(empty);
    return;
  }

  const catShortTag = { phi: "PHI", pii: "PII", financial: "FIN", custom: "CUSTOM" };

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
    let locLabel;
    if (f.isCustomDocx) {
      if (f.scope === "instance") {
        locLabel = f.enabled ? "Selected spot · Blacked out" : "Selected spot · Highlighted";
      } else {
        locLabel = f.enabled
          ? f.occurrences > 1
            ? `${f.occurrences} matches blacked out`
            : "Blacked out"
          : f.occurrences > 1
          ? `${f.occurrences} matches in document`
          : "Highlighted in document";
      }
    } else if (f.isDocxText) {
      locLabel = f.enabled
        ? f.occurrences > 1
          ? `${f.occurrences} matches blacked out`
          : "Blacked out"
        : f.occurrences > 1
        ? `${f.occurrences} matches in document`
        : "Highlighted in document";
    } else if (r.pageCount > 1) {
      locLabel = `Page ${f.pageIndex + 1}`;
    } else {
      locLabel = f.enabled ? "Blacked out" : "Highlighted on page";
    }
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

    if (f.isCustomDocx) {
      const controls = document.createElement("div");
      controls.className = "pii-item-controls";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "pii-remove-btn";
      removeBtn.title = "Remove custom redaction";
      removeBtn.setAttribute("aria-label", `Remove ${f.masked}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        r.removeDocxCustomRedaction(f.id);
      });
      controls.append(removeBtn, chk);
      row.append(infoDiv, controls);
    } else {
      row.append(infoDiv, chk);
    }
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

  const scheduleSelectionCheck = () => window.setTimeout(captureDocxSelectionSnapshot, 0);
  const previewSectionsEl = el("docx-preview-sections");
  previewSectionsEl.addEventListener("mouseup", scheduleSelectionCheck);
  previewSectionsEl.addEventListener("keyup", scheduleSelectionCheck);
  previewSectionsEl.addEventListener("touchend", scheduleSelectionCheck);

  for (const btnId of ["btn-docx-redact-here", "btn-docx-redact-all", "btn-docx-redact-cancel"]) {
    el(btnId).addEventListener("mousedown", (e) => e.preventDefault());
  }

  el("btn-docx-redact-here").addEventListener("click", () => {
    const snap = state.pendingDocxSelection;
    if (!snap || !state.redactor) return;
    state.redactor.addDocxCustomRedaction({
      rawValue: snap.rawValue,
      scope: "instance",
      sectionPath: snap.sectionPath,
      sectionTitle: snap.sectionTitle,
      slices: snap.slices,
    });
    clearDocxSelectionBar(true);
  });

  el("btn-docx-redact-all").addEventListener("click", () => {
    const snap = state.pendingDocxSelection;
    if (!snap || !state.redactor) return;
    state.redactor.addDocxCustomRedaction({
      rawValue: snap.rawValue,
      scope: "all",
      caseInsensitive: false,
    });
    clearDocxSelectionBar(true);
  });

  el("btn-docx-redact-cancel").addEventListener("click", () => clearDocxSelectionBar(true));

  const submitCustomDocxTerm = () => {
    const inp = el("inp-docx-custom-term");
    const term = inp.value.trim();
    if (!term || !state.redactor || state.redactor.format !== "docx") return;
    const added = state.redactor.addDocxCustomRedaction({
      rawValue: term,
      scope: "all",
      caseInsensitive: true,
    });
    if (!added) {
      showToast(`"${term}" was not found in this document.`, "error");
      return;
    }
    inp.value = "";
    inp.focus();
  };

  el("btn-add-docx-custom").addEventListener("click", submitCustomDocxTerm);
  el("inp-docx-custom-term").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitCustomDocxTerm();
    }
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
