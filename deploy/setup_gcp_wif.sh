#!/usr/bin/env bash
set -euo pipefail

# Idempotent setup of Keyless GitHub Actions OIDC (Workload Identity Federation)
# on DocWorks' single GCP project (`docworks-514722`) covering both DEV and PROD runtimes.
#
# Usage:
#   ./deploy/setup_gcp_wif.sh --project docworks-514722

PROJECT_ID="${PROJECT_ID:-docworks-514722}"
GITHUB_REPO="${GITHUB_REPO:-damiththa/docworks}"
POOL_ID="github-actions"
PROVIDER_ID="github"
DEPLOYER_SA_NAME="github-deployer"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --repo)
      GITHUB_REPO="${2:-damiththa/docworks}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
DEPLOYER_SA_EMAIL="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

retry_cmd() {
  local attempt=1
  local max_attempts=6
  while ! "$@"; do
    if (( attempt >= max_attempts )); then
      echo "Command failed after ${max_attempts} attempts: $*" >&2
      return 1
    fi
    echo "Waiting 5s for GCP IAM propagation (attempt ${attempt}/${max_attempts})..."
    sleep 5
    attempt=$((attempt + 1))
  done
}

echo "==> Enabling IAM, IAM Credentials & STS APIs on ${PROJECT_ID} (${PROJECT_NUMBER})..."
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

echo "==> Ensuring CI/CD deployer service account ${DEPLOYER_SA_EMAIL} exists..."
if ! gcloud iam service-accounts describe "${DEPLOYER_SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${DEPLOYER_SA_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="GitHub Actions Deployer" \
    --description="Keyless OIDC deployer for DocWorks CI/CD (DEV & PROD)" \
    --quiet
  sleep 8
fi

echo "==> Granting least-privilege deployment roles to ${DEPLOYER_SA_EMAIL}..."
for role in roles/artifactregistry.writer roles/run.admin roles/secretmanager.viewer; do
  retry_cmd gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOYER_SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

for runtime_name in docworks-prod-runner docworks-dev-runner; do
  runtime_sa="${runtime_name}@${PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${runtime_sa}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "==> Scoping ServiceAccountUser strictly on ${runtime_sa}..."
    retry_cmd gcloud iam service-accounts add-iam-policy-binding "${runtime_sa}" \
      --project="${PROJECT_ID}" \
      --member="serviceAccount:${DEPLOYER_SA_EMAIL}" \
      --role="roles/iam.serviceAccountUser" \
      --condition=None \
      --quiet >/dev/null
  fi
done

echo "==> Ensuring Workload Identity Pool '${POOL_ID}' exists..."
if ! gcloud iam workload-identity-pools describe "${POOL_ID}" --project="${PROJECT_ID}" --location="global" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project="${PROJECT_ID}" \
    --location="global" \
    --display-name="GitHub Actions Pool" \
    --quiet
fi

echo "==> Ensuring GitHub OIDC Provider '${PROVIDER_ID}' scoped to ${GITHUB_REPO} exists..."
if ! gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" --project="${PROJECT_ID}" --location="global" --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project="${PROJECT_ID}" \
    --location="global" \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="GitHub Actions OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'" \
    --quiet
fi

PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPO}"
echo "==> Binding roles/iam.workloadIdentityUser on ${DEPLOYER_SA_EMAIL}..."
retry_cmd gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${PRINCIPAL_SET}" \
  --condition=None \
  --quiet >/dev/null

WIF_PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo ""
echo "================================================================="
echo "WIF Configured for ${PROJECT_ID}"
echo "  WIF Provider: ${WIF_PROVIDER_NAME}"
echo "  Deployer SA : ${DEPLOYER_SA_EMAIL}"
echo "================================================================="
