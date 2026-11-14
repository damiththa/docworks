from __future__ import annotations

from contextlib import asynccontextmanager
import html
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import httpx
from pydantic import BaseModel, Field

from shared.backend.config import load_settings
from shared.backend.csp import build_csp_header
from shared.backend.entitlements import EntitlementStore
from shared.backend.providers import (
    build_provider_authorize_url,
    exchange_auth_code_stateless,
    get_provider_spec,
)
from shared.backend.security import (
    compute_user_hash,
    issue_session_proof,
    verify_session_proof,
)

SHARED_DIR = Path(__file__).resolve().parent.parent
SHARED_FRONTEND_DIR = SHARED_DIR / "frontend"
SHARED_PROVIDERS_DIR = SHARED_DIR / "providers"
LEGAL_DIR = Path(__file__).resolve().parent / "legal"

NO_CACHE_HTML_HEADERS = {"Cache-Control": "no-cache, no-store, must-revalidate"}


class OAuthExchangeRequest(BaseModel):
    auth_code: str = Field(..., min_length=4, max_length=512)
    redirect_uri: str | None = Field(default=None, max_length=512)


class QuotaStatusRequest(BaseModel):
    session_proof: str = Field(..., min_length=16, max_length=512)


class QuotaConsumeRequest(BaseModel):
    session_proof: str = Field(..., min_length=16, max_length=512)
    action: str = Field(..., pattern="^(scrub|diff|radar_fix)$")
    units: int = Field(default=1, ge=1, le=500)


def create_docworks_app(default_app_id: str, app_dir: Path) -> FastAPI:
    """
    Factory creating the stateless FastAPI service for ScrubDoc or DiffDoc.
    Shares OAuth exchange, CSP, health checks, legal rendering, and unified
    Zero-PII Firestore entitlements across all apps and storage providers.
    """
    settings = load_settings(default_app_id=default_app_id)
    provider_spec = get_provider_spec(settings.provider_id)
    entitlements = EntitlementStore(settings)
    app_static_dir = app_dir / "static"
    repo_root = SHARED_DIR.parent

    @asynccontextmanager
    async def lifespan(app_instance: FastAPI):
        entitlements.warm_up()
        limits = httpx.Limits(max_keepalive_connections=20, max_connections=50)
        async with httpx.AsyncClient(timeout=15.0, limits=limits) as shared_http:
            app_instance.state.http_client = shared_http
            yield

    app = FastAPI(
        title=settings.app_public_name,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(GZipMiddleware, minimum_size=500)
    csp_header_value = build_csp_header(provider_spec)

    @app.middleware("http")
    async def security_headers_middleware(request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = csp_header_value
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store, max-age=0"
        elif request.url.path.startswith("/static/vendor/") or (
            request.url.path.startswith("/static/") and "v" in request.query_params
        ):
            response.headers["Cache-Control"] = "public, max-age=86400"
        else:
            response.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
        return response

    @app.api_route("/health", methods=["GET", "HEAD"])
    @app.api_route("/api/health", methods=["GET", "HEAD"])
    @app.api_route("/healthz", methods=["GET", "HEAD"])
    async def healthz():
        return {
            "status": "ok",
            "suite": settings.suite_name,
            "service": settings.app_id,
            "app_name": settings.app_short_name,
            "provider": settings.provider_id,
            "zero_pii": True,
        }

    @app.get("/api/public-config")
    async def public_config(request: Request):
        origin = (
            f"{request.headers.get('x-forwarded-proto', request.url.scheme)}://"
            f"{request.headers.get('host', request.url.netloc)}"
        )
        redirect_uri = f"{origin}/callback"
        return {
            "suite_name": settings.suite_name,
            "app_id": settings.app_id,
            "app_short_name": settings.app_short_name,
            "app_name": settings.app_public_name,
            "provider_id": provider_spec.provider_id,
            "provider_name": provider_spec.display_name,
            "provider_ready": provider_spec.implemented,
            "provider_home_url": provider_spec.home_url,
            "return_url_regex": provider_spec.return_url_regex,
            "capabilities": provider_spec.capabilities,
            "oauth_configured": bool(
                settings.provider_client_id
                and settings.provider_client_secret
                and settings.hmac_pepper
            ),
            "authorize_base_ready": bool(settings.provider_client_id),
            "redirect_uri": redirect_uri,
            "authorize_url_template": (
                build_provider_authorize_url(settings, provider_spec, redirect_uri, "standalone")
                if settings.provider_client_id
                else ""
            ),
        }

    @app.post("/api/oauth/exchange")
    async def api_oauth_exchange(body: OAuthExchangeRequest, request: Request):
        try:
            session_info = await exchange_auth_code_stateless(
                settings=settings,
                spec=provider_spec,
                auth_code=body.auth_code,
                redirect_uri=body.redirect_uri,
                http_client=getattr(request.app.state, "http_client", None),
            )
            user_hash = compute_user_hash(
                settings.provider_id,
                str(session_info["provider_user_id"]),
                settings.hmac_pepper,
            )
            quota_status = await entitlements.get_status(user_hash)
            session_proof = issue_session_proof(
                user_hash=user_hash,
                app_id=settings.app_id,
                provider_id=settings.provider_id,
                pepper=settings.hmac_pepper,
                ttl_seconds=settings.session_ttl_seconds,
            )
            return JSONResponse(
                {
                    "access_token": session_info["access_token"],
                    "expires_in": session_info["expires_in"],
                    "session_proof": session_proof,
                    "entitlement": quota_status,
                }
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/entitlement/status")
    async def api_entitlement_status(body: QuotaStatusRequest):
        user_hash = verify_session_proof(
            body.session_proof,
            expected_app_id=settings.app_id,
            expected_provider_id=settings.provider_id,
            pepper=settings.hmac_pepper,
        )
        if not user_hash:
            raise HTTPException(status_code=401, detail="Session proof expired or invalid.")
        status = await entitlements.get_status(user_hash)
        return {"entitlement": status}

    @app.post("/api/entitlement/consume")
    async def api_entitlement_consume(body: QuotaConsumeRequest):
        user_hash = verify_session_proof(
            body.session_proof,
            expected_app_id=settings.app_id,
            expected_provider_id=settings.provider_id,
            pepper=settings.hmac_pepper,
        )
        if not user_hash:
            raise HTTPException(status_code=401, detail="Session proof expired or invalid.")
        try:
            allowed, status = await entitlements.consume_quota(user_hash, body.action, body.units)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if not allowed:
            upgrade_msg = (
                "Monthly Free ShareRadar limit reached. Upgrade ScrubDoc, DiffDoc, or the DocWorks Bundle to Pro for unlimited access."
                if body.action == "radar_fix"
                else f"Monthly Free {settings.app_short_name} limit reached. Upgrade to {settings.app_short_name} Pro or DocWorks Bundle for unlimited access."
            )
            return JSONResponse(
                status_code=402,
                content={
                    "allowed": False,
                    "message": upgrade_msg,
                    "entitlement": status,
                },
            )
        return {"allowed": True, "entitlement": status}

    @app.get("/callback")
    async def oauth_redirect_callback(
        code: str = "",
        state: str = "",
        error: str = "",
        error_description: str = "",
    ):
        """Handles standalone OAuth 2.0 redirect flow via URL hash fragment so tokens never stay in query logs."""
        params = {
            k: v
            for k, v in {
                "auth_code": code,
                "state": state,
                "from_callback": "1" if code else "",
                "oauth_error": error_description or error,
            }.items()
            if v
        }
        return RedirectResponse(url=f"/#{urlencode(params)}", status_code=302)

    @app.post("/launch")
    async def provider_post_launch(
        auth_code: str = Form(default=""),
        file_id: str = Form(default=""),
        folder_id: str = Form(default=""),
        mode: str = Form(default=""),
        redirect_to_box_url: str = Form(default=""),
        return_url: str = Form(default=""),
    ):
        """Supports POST callback launches from Box Web App Integrations."""
        params = {
            k: v
            for k, v in {
                "auth_code": auth_code,
                "file_id": file_id,
                "folder_id": folder_id,
                "mode": mode,
                "return_url": return_url or redirect_to_box_url,
            }.items()
            if v
        }
        return RedirectResponse(url=f"/#{urlencode(params)}", status_code=303)

    @app.api_route("/launch", methods=["GET", "HEAD"])
    async def provider_get_launch():
        return FileResponse(app_static_dir / "index.html", headers=NO_CACHE_HTML_HEADERS)

    def _render_legal_page(template_name: str) -> HTMLResponse:
        raw_html = (LEGAL_DIR / template_name).read_text(encoding="utf-8")
        app_name = html.escape(settings.app_public_name)
        short_name = html.escape(settings.app_short_name)
        provider_name = html.escape(provider_spec.display_name)
        provider_hosts = html.escape(provider_spec.api_hosts_display)

        if settings.app_id == "diffdoc":
            summary_desc = (
                "in-browser document text redlining, visual curtain/pixel comparison, "
                "multi-sheet spreadsheet cell and formula auditing, and PDF diff report export"
            )
            outputs_desc = (
                "Any exported <code>Redline_Report.pdf</code> verification summaries or optional ShareRadar snapshots "
                "(<code>_docworks_radar_snapshot.json</code>) are saved strictly inside"
            )
            verification_clause = (
                f"While {short_name} performs deterministic text, pixel, and OpenXML spreadsheet comparisons locally in your browser, "
                "automated clause, financial, date, and formula highlights are assistive review aids and do not constitute legal, "
                "accounting, or compliance advice. <strong>You remain solely responsible for reviewing final contracts, financial "
                "models, and documents prior to execution or external distribution.</strong>"
            )
        else:
            summary_desc = (
                "in-browser file metadata scrubbing, byte-destructive document and image "
                "redaction, and cloud Shared Link / external collaborator auditing"
            )
            outputs_desc = (
                "Any sanitized copies (<code>_Clean</code>), exported ShareRadar CSV audit reports, or optional traffic-delta "
                "snapshots (<code>_docworks_radar_snapshot.json</code>) are saved strictly inside"
            )
            verification_clause = (
                f"While {short_name} performs destructive bitmap flattening and metadata stripping locally in your browser, "
                "automated PII/PHI pattern detection is an assistive feature and cannot guarantee 100% recall across every formatting "
                "variation or handwriting style. <strong>You are solely responsible for visually inspecting every exported "
                "<code>_Clean</code> file prior to sharing or publishing it externally.</strong>"
            )

        if settings.support_email:
            email_esc = html.escape(settings.support_email)
            contact_block = (
                f'<p class="contact-line">Questions or support inquiries: '
                f'<a href="mailto:{email_esc}">{email_esc}</a></p>'
            )
        else:
            contact_block = ""

        rendered = (
            raw_html.replace("{{APP_NAME}}", app_name)
            .replace("{{APP_SHORT_NAME}}", short_name)
            .replace("{{PROVIDER_NAME}}", provider_name)
            .replace("{{PROVIDER_API_HOSTS}}", provider_hosts)
            .replace("{{SERVICE_SUMMARY}}", summary_desc)
            .replace("{{USER_OUTPUTS_DESC}}", outputs_desc)
            .replace("{{VERIFICATION_CLAUSE}}", verification_clause)
            .replace("{{CONTACT_BLOCK}}", contact_block)
        )
        return HTMLResponse(content=rendered, headers=NO_CACHE_HTML_HEADERS)

    @app.api_route("/privacy", methods=["GET", "HEAD"])
    async def privacy_policy():
        return _render_legal_page("privacy.html")

    @app.api_route("/terms", methods=["GET", "HEAD"])
    async def terms_of_service():
        return _render_legal_page("terms.html")

    @app.api_route("/template", methods=["GET", "HEAD"])
    async def suite_template():
        return FileResponse(SHARED_FRONTEND_DIR / "suite-template.html", headers=NO_CACHE_HTML_HEADERS)

    vendor_dir = next(
        (p for p in [app_dir / "vendor", repo_root / "vendor", Path("/app/vendor")] if p.exists()),
        None,
    )
    if vendor_dir is not None:
        app.mount("/static/vendor", StaticFiles(directory=str(vendor_dir)), name="vendor")

    app.mount("/static/shared", StaticFiles(directory=str(SHARED_FRONTEND_DIR)), name="shared_frontend")
    app.mount("/static/providers", StaticFiles(directory=str(SHARED_PROVIDERS_DIR)), name="shared_providers")
    app.mount("/static/app", StaticFiles(directory=str(app_static_dir)), name="app_static")

    @app.api_route("/", methods=["GET", "HEAD"])
    async def index():
        return FileResponse(app_static_dir / "index.html", headers=NO_CACHE_HTML_HEADERS)

    return app
