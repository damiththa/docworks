# GitHub Actions CI/CD & Keyless GCP Deployment

DocWorks uses **GitHub Actions** with **GCP Workload Identity Federation (OIDC)** — zero static JSON service account keys stored in GitHub Secrets.

## Workflows

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| **CI Static Checks** | `.github/workflows/ci-verify.yml` | `push` / `pull_request` on `main`, `dev` | Runs Python bytecode compile check (`python3 -m compileall`), shell syntax validation (`bash -n deploy/*.sh`), legacy string guard, and required structure checks. |
| **Deploy DocWorks** | `.github/workflows/deploy.yml` | `workflow_dispatch` (manual), optional gated `push` to `dev` / `main` | Preflight-verifies Secret Manager versions, builds app Docker images (`scrubdoc` / `diffdoc`), pushes to Artifact Registry (`us-central1`), deploys to Cloud Run, and smoke-tests `/health`, `/api/health`, `/privacy`, `/terms`, `/template`. |

---

## Keyless GCP WIF Configuration (Pre-Provisioned)

Provisioned via [`deploy/setup_gcp_wif.sh`](../deploy/setup_gcp_wif.sh), scoped strictly to `assertion.repository == 'damiththa/docworks'`.

### DEV (`safeshare-box` / Project `#902354967061`)

- **WIF Provider:** `projects/902354967061/locations/global/workloadIdentityPools/github-actions/providers/github`
- **Deployer SA:** `github-deployer@safeshare-box.iam.gserviceaccount.com`
- **Runtime SA:** `902354967061-compute@developer.gserviceaccount.com`
- **Artifact Registry:** `us-central1-docker.pkg.dev/safeshare-box/cloud-run-source-deploy`
- **Cloud Run Services (`box`):**
  - `scrubdoc` -> `safeshare` (preserves `https://safeshare-4m25thqnbq-uc.a.run.app` and DEV Box credentials `BOX_CLIENT_ID` / `BOX_CLIENT_SECRET`)
  - `diffdoc` -> `boxdiff` (preserves `https://boxdiff-4m25thqnbq-uc.a.run.app` and DEV Box credentials `BOXDIFF_CLIENT_ID` / `BOXDIFF_CLIENT_SECRET`)

### PROD (`docworks-514722` / Project `#746704433311`)

- **WIF Provider:** `projects/746704433311/locations/global/workloadIdentityPools/github-actions/providers/github`
- **Deployer SA:** `github-deployer@docworks-514722.iam.gserviceaccount.com`
- **Runtime SA:** `docworks-prod-runner@docworks-514722.iam.gserviceaccount.com`
- **Artifact Registry:** `us-central1-docker.pkg.dev/docworks-514722/docworks-apps`
- **Cloud Run Services:** `<app>-<provider>` (e.g., `scrubdoc-box`, `diffdoc-box`, and future `scrubdoc-dropbox`, `diffdoc-gdrive`)
- **Secret Manager Bindings:** `<PROVIDER>_<APP>_CLIENT_ID`, `<PROVIDER>_<APP>_CLIENT_SECRET`, `HMAC_PEPPER_<PROVIDER>`

### Least-Privilege IAM on `github-deployer`

Each `github-deployer@<project>.iam.gserviceaccount.com` holds only:
- `roles/artifactregistry.writer` (push Docker images)
- `roles/run.admin` (deploy Cloud Run services & inspect URLs)
- `roles/secretmanager.viewer` (preflight check that secret versions are `ENABLED`; cannot read secret plaintext)
- `roles/iam.serviceAccountUser` (scoped **only** to the target runtime SA, not project-wide)
- `roles/iam.workloadIdentityUser` (bound to GitHub repo `damiththa/docworks`)

---

## Safety Gates & GitHub Settings

### 1. Push-to-Deploy Gate (`AUTO_DEPLOY_*` Repository Variables)

Automatic deploys on `push` to `dev` or `main` are **disabled by default** until you opt in via GitHub **Settings -> Secrets and variables -> Actions -> Variables**:

| Variable | Effect when `"true"` |
| --- | --- |
| `AUTO_DEPLOY_DEV` | Pushes touching `apps/**` or `shared/**` on `dev` auto-deploy `box` flavor to `safeshare-box`. |
| `AUTO_DEPLOY_PROD` | Pushes touching `apps/**` or `shared/**` on `main` auto-deploy `box` flavor to `docworks-514722`. |
| `AUTO_DEPLOY_ENABLED` | Enables push auto-deploy for both `dev` (`dev` branch) and `prod` (`main` branch). |

Manual deploys always work on demand via **Actions -> Deploy DocWorks -> Run workflow** regardless of those flags.

### 2. Recommended GitHub Environments (`Settings -> Environments`)

- **`dev`**: optional reviewer rules; accepts pushes from `dev` or manual dispatch.
- **`prod`**: add **Required reviewers** (your account) and restrict **Deployment branches** to `main` so every PROD deployment gets explicit human sign-off before authenticating to GCP.

Optional per-environment Variable overrides (`WIF_PROVIDER`, `DEPLOYER_SA`, `PROJECT_ID`, `RUNTIME_SA`, `AR_REPO`, `REGION`, `FREE_SCRUB_LIMIT`, `FREE_DIFF_LIMIT`, `FREE_RADAR_FIX_LIMIT`) are honored automatically if defined.

### 3. Secret Manager Readiness Before First PROD Deploy

Before triggering `Deploy DocWorks` for `prod` (`box`), ensure enabled versions exist in `docworks-514722` for:
- `BOX_SCRUBDOC_CLIENT_ID`
- `BOX_SCRUBDOC_CLIENT_SECRET`
- `BOX_DIFFDOC_CLIENT_ID`
- `BOX_DIFFDOC_CLIENT_SECRET`
- `HMAC_PEPPER_BOX` (already populated)

The workflow fails fast during preflight if any required secret has zero `ENABLED` versions.
