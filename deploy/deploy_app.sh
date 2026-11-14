#!/usr/bin/env bash
set -euo pipefail

# Build & deploy ScrubDoc or DiffDoc to GCP Cloud Run (PROD: `docworks-514722`).
# Explicitly requires `--confirm` so deployments never run unintentionally.
# Usage:
#   ./deploy/deploy_app.sh --app scrubdoc --provider box --confirm
#   ./deploy/deploy_app.sh --app diffdoc  --provider box --confirm

APP_ID=""
PROVIDER_ID="box"
PROJECT_ID="${PROJECT_ID:-docworks-514722}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-docworks-apps}"
CONFIRMED="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_ID="${2:-}"
      shift 2
      ;;
    --provider)
      PROVIDER_ID="${2:-box}"
      shift 2
      ;;
    --project)
      PROJECT_ID="${2:-docworks-514722}"
      shift 2
      ;;
    --confirm)
      CONFIRMED="true"
      shift 1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "${APP_ID}" != "scrubdoc" && "${APP_ID}" != "diffdoc" ]]; then
  echo "Usage: $0 --app <scrubdoc|diffdoc> [--provider <box|dropbox|gdrive>] --confirm" >&2
  exit 1
fi

if [[ "${CONFIRMED}" != "true" ]]; then
  echo "Refusing to build/deploy without explicit --confirm flag." >&2
  echo "Review target: project=${PROJECT_ID}, app=${APP_ID}, provider=${PROVIDER_ID}" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_SA="docworks-prod-runner@${PROJECT_ID}.iam.gserviceaccount.com"
SERVICE_NAME="${APP_ID}-${PROVIDER_ID}"
APP_UPPER="$(echo "${APP_ID}" | tr '[:lower:]' '[:upper:]')"
PROV_UPPER="$(echo "${PROVIDER_ID}" | tr '[:lower:]' '[:upper:]')"
SECRET_CLIENT_ID="${PROV_UPPER}_${APP_UPPER}_CLIENT_ID"
SECRET_CLIENT_SECRET="${PROV_UPPER}_${APP_UPPER}_CLIENT_SECRET"
SECRET_PEPPER="HMAC_PEPPER_${PROV_UPPER}"
IMAGE_TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

for req_secret in "${SECRET_CLIENT_ID}" "${SECRET_CLIENT_SECRET}" "${SECRET_PEPPER}"; do
  ver_count="$(gcloud secrets versions list "${req_secret}" --project="${PROJECT_ID}" --filter="state=ENABLED" --format="value(name)" | wc -l | tr -d ' ')"
  if [[ "${ver_count}" == "0" ]]; then
    echo "ERROR: Secret '${req_secret}' in project '${PROJECT_ID}' has zero ENABLED versions." >&2
    exit 1
  fi
done

echo "==> Submitting Cloud Build for ${SERVICE_NAME} (${IMAGE_URI})..."
gcloud builds submit "${REPO_ROOT}" \
  --project="${PROJECT_ID}" \
  --config="${REPO_ROOT}/deploy/cloudbuild.yaml" \
  --substitutions="_APP_ID=${APP_ID},_PROVIDER_ID=${PROVIDER_ID},_REGION=${REGION},_AR_REPO=${AR_REPO},_TAG=${IMAGE_TAG}" \
  --quiet

echo "==> Deploying Cloud Run service ${SERVICE_NAME}..."
gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_URI}" \
  --platform=managed \
  --service-account="${RUNTIME_SA}" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=10 \
  --set-env-vars="APP_ID=${APP_ID},STORAGE_PROVIDER=${PROVIDER_ID},GCP_PROJECT_ID=${PROJECT_ID},USE_FIRESTORE=true,FIRESTORE_COLLECTION=entitlements_${PROVIDER_ID}" \
  --set-secrets="PROVIDER_CLIENT_ID=${SECRET_CLIENT_ID}:latest,PROVIDER_CLIENT_SECRET=${SECRET_CLIENT_SECRET}:latest,HMAC_PEPPER=${SECRET_PEPPER}:latest" \
  --quiet

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
echo "==> Deployed ${SERVICE_NAME}: ${SERVICE_URL}"
echo "==> Running remote /health check..."
curl -fsS "${SERVICE_URL}/health"
echo ""
