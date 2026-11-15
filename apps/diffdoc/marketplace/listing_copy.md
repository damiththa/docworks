# DiffDoc — Box Developer Console & App Center Setup Guide (DocWorks Suite)

> Create **two** separate Box Custom Apps in Box Developer Console:
> 1. **DiffDoc (DEV)** -> point Redirect URI & CORS to your `<DIFFDOC_DEV_ORIGIN>` (`diffdoc-box-dev`) and save credentials in Secret Manager (`BOX_DIFFDOC_CLIENT_ID_DEV`, `BOX_DIFFDOC_CLIENT_SECRET_DEV` in `docworks-514722`).
> 2. **DiffDoc (PROD)** -> point Redirect URI & CORS to your `<DIFFDOC_PROD_ORIGIN>` (`diffdoc-box`) and save credentials in Secret Manager (`BOX_DIFFDOC_CLIENT_ID`, `BOX_DIFFDOC_CLIENT_SECRET` in `docworks-514722`).
> Keep Section 3 (Box App Center Publishing) for the **PROD** app only.

---

## 1. Box Developer Console — `Configuration` Tab

- **App Type:** Custom App (`User Authentication (OAuth 2.0)`)
- **OAuth 2.0 Redirect URI:** `<DIFFDOC_PROD_ORIGIN>/callback`
- **Application Scopes:**
  - `[x]` Read all files and folders stored in Box
  - `[x]` Write all files and folders stored in Box
- **CORS Domains:** `<DIFFDOC_PROD_ORIGIN>`

---

## 2. Box Developer Console — `Box Web Integrations` Tab

### Integration #1: File Right-Click ("Compare with DiffDoc")
- **Web Integration Name:** `Compare with DiffDoc`
- **Description:** `Compare Box Version History (v1..vN) or sibling files with word-level contract redlines, visual curtain/pixel diffs, and Excel formula audits — 100% in your browser.`
- **Supported File Extensions:** `pdf, docx, xlsx, csv, txt, md, json, png, jpg, jpeg, webp`
- **Permissions Requirement:** `Full permissions are required` (enables saving `Redline_Report.pdf` back to the folder)
- **Web Integration Scopes:** `The parent folder of the file/folder from which this web integration is invoked`
- **Box item types:** `Files`
- **Client Callback URL:** `<DIFFDOC_PROD_ORIGIN>/launch`
- **Prompt Message:** `Open this file in DiffDoc to compare versions or redline against another file directly in your browser (zero files stored on external servers).`
- **New window settings:** Toggle ON (`The web integration will open in a new tab`) or Popup
- **Callback Parameters (`Method = Get`):**
  1. `auth_code` = `#auth_code#`
  2. `file_id` = `#file_id#`
  3. `return_url` = `#redirect_to_box_url#` *(if configured)*

### Integration #2: Folder Right-Click ("Audit Links & Guests — ShareRadar")
- **Box item types:** `Folders`
- **Integration Name:** `Audit Links & Guests (DiffDoc ShareRadar)`
- **Description:** `Audit active Shared Links and external collaborators across subfolders.`
- **Permissions Required:** `Full permissions`
- **Client Callback URL:** `<DIFFDOC_PROD_ORIGIN>/launch`
- **Callback Parameters (`Method = Get`):** `mode` = `radar`, `folder_id` = `#folder_id#`, `auth_code` = `#auth_code#`, `return_url` = `#redirect_to_box_url#`

---

## 3. Box App Center Marketplace Listing Copy

- **App Name:** DiffDoc — Visual, Contract & Spreadsheet Diff
- **Suite:** DocWorks Suite
- **Tagline:** Instant browser-only version history redlines, visual PDF/image curtain diffs, and Excel formula audits for Box.
- **Privacy Policy URL:** `<DIFFDOC_PROD_ORIGIN>/privacy`
- **Terms of Service URL:** `<DIFFDOC_PROD_ORIGIN>/terms`
- **Install ("Add") URL:** `<DIFFDOC_PROD_ORIGIN>/`
- **Categories:** Productivity, Legal & Compliance, Finance & Accounting

### Overview Copy
Cloud drives store document Version History (`v1`, `v2`, `v3`), yet spotting what silently changed between `MSA_v3.docx` and `MSA_v4_Signed.pdf` — or catching a single overwritten `=SUM()` formula inside `Q4_Budget.xlsx` — still forces teams to download files and eyeball changes manually.

**DiffDoc** adds 1-click **Compare with DiffDoc** directly inside your storage right-click **Integrations** menu:
1. **Contract & Text Redline (`.pdf`, `.docx`, `.txt`, `.md`, `.json`):** Word-level additions and deletions plus automatic callout cards for modified **$ Amounts**, **% Rates**, **Dates / Payment Terms**, and **Legal Clauses** — even across `.docx` vs `.pdf`.
2. **Visual Curtain & Pixel Diff (`.pdf`, `.png`, `.jpg`, `.webp`):** Interactive split-screen curtain slider and crimson pixel-delta overlay to spot moved signatures, engineering drawing revisions, and scanned page edits.
3. **Multi-Sheet Excel Formula & Cell Audit (`.xlsx`, `.csv`):** Inspects OpenXML formulas (`<f>`) and values (`<v>`) across every worksheet and flags dangerous **Formula -> Hardcoded Value** overrides.
4. **1-Click `Redline_Report.pdf` Export & ShareRadar:** Save an executive verification PDF straight back into your folder and audit open links & outside guests in one workspace.
5. **100% Browser-Only Zero-PII Architecture:** Every byte stays in your browser RAM communicating directly with storage APIs.
