# ScrubDoc — Box App Center Configuration & Store Copy (DocWorks Suite)

> Replace `<SCRUBDOC_PROD_ORIGIN>` with your final Cloud Run or custom domain origin after PROD deployment (e.g. `https://scrubdoc.<your-domain>` or the `.run.app` origin).

---

## 1. Box Developer Console — Configuration Tab

- **App Type:** Custom App (`User Authentication (OAuth 2.0)`)
- **OAuth 2.0 Redirect URI:** `<SCRUBDOC_PROD_ORIGIN>/callback`
- **CORS Domains:** `<SCRUBDOC_PROD_ORIGIN>`
- **Application Scopes:**
  - `[x]` Read all files and folders stored in Box
  - `[x]` Write all files and folders stored in Box

---

## 2. Box Developer Console — Box Web Integrations Tab

### Integration #1: File Right-Click ("Clean & Redact with ScrubDoc")
- **Box item types:** `Files`
- **Integration Name:** `Clean & Redact with ScrubDoc`
- **Description:** `Strip hidden EXIF/GPS/Author leaks and burn permanent redactions into a clean _Clean file.`
- **Supported File Extensions:** `pdf, jpg, jpeg, png, webp, docx`
- **Permissions Required:** `Full permissions`
- **Web Integration Scopes:** `The parent folder of the file/folder from which this web integration is invoked`
- **Launch Type:** `Popup` (Modal inside Box)
- **Client Callback URL:** `<SCRUBDOC_PROD_ORIGIN>/launch`
- **Callback Parameters (`GET`):**
  - `mode` = `scrub`
  - `file_id` = `#file_id#`
  - `auth_code` = `#auth_code#`
  - `return_url` = `#redirect_to_box_url#`

### Integration #2: Folder Right-Click ("Audit Links & Guests — ShareRadar")
- **Box item types:** `Folders`
- **Integration Name:** `Audit Links & Guests (ScrubDoc ShareRadar)`
- **Description:** `Audit active Shared Links (Views, Downloads, Expiry) and external collaborators across subfolders.`
- **Permissions Required:** `Full permissions`
- **Web Integration Scopes:** `The folder from which this web integration is invoked`
- **Launch Type:** `Popup` (Modal inside Box)
- **Client Callback URL:** `<SCRUBDOC_PROD_ORIGIN>/launch`
- **Callback Parameters (`GET`):**
  - `mode` = `radar`
  - `folder_id` = `#folder_id#`
  - `auth_code` = `#auth_code#`
  - `return_url` = `#redirect_to_box_url#`

---

## 3. Box App Center — Publishing Tab Copy

- **App Name:** ScrubDoc — Metadata Scrub & Redaction
- **Suite:** DocWorks Suite
- **Tagline:** Strip hidden file metadata, burn true PDF/image/Word redactions, and audit exposed Shared Links — 100% in your browser.
- **Categories:** Security & Compliance, Productivity
- **Privacy Policy URL:** `<SCRUBDOC_PROD_ORIGIN>/privacy`
- **Terms of Service URL:** `<SCRUBDOC_PROD_ORIGIN>/terms`
- **Install ("Add") URL:** `<SCRUBDOC_PROD_ORIGIN>/`
- **Long Description:**
  ScrubDoc gives everyday cloud storage users a fast, zero-retention privacy shield before and after sharing content externally:
  1. **Privacy X-Ray & Metadata Scrubber:** Instantly detect and strip hidden GPS coordinates, camera serial numbers, embedded EXIF preview thumbnails, PDF author properties, and Word reviewer comments.
  2. **True Byte-Destructive Redaction:** Auto-detect SSNs, payment cards, MRNs, bank routing numbers, phone numbers, and emails — or draw custom redaction boxes — burning blackouts permanently into a clean `_Clean` file with zero unredacted version history.
  3. **ShareRadar Folder Telemetry & Bulk Cleanup:** Scan your folders in seconds to uncover forgotten "Anyone with the link" URLs, view live Opens, Downloads, `+Delta` traffic spikes, and external collaborator tenure — then revoke links, disable downloads, or stamp 30-day expirations in bulk.
