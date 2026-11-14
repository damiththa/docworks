from __future__ import annotations

import os
from dataclasses import dataclass

VALID_APPS = ("scrubdoc", "diffdoc")
VALID_PROVIDERS = ("box", "dropbox", "gdrive")

PROVIDER_DISPLAY_NAMES = {
    "box": "Box",
    "dropbox": "Dropbox",
    "gdrive": "Google Drive",
}

APP_SHORT_NAMES = {
    "scrubdoc": "ScrubDoc",
    "diffdoc": "DiffDoc",
}


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        val = os.getenv(name, "").strip()
        if val:
            return val
    return default


@dataclass(frozen=True)
class Settings:
    suite_name: str
    app_id: str
    app_short_name: str
    app_public_name: str
    provider_id: str
    provider_name: str
    support_email: str
    provider_client_id: str
    provider_client_secret: str
    hmac_pepper: str
    gcp_project_id: str
    use_firestore: bool
    firestore_collection: str
    free_scrub_limit_per_month: int
    free_diff_limit_per_month: int
    free_radar_fix_limit_per_month: int
    session_ttl_seconds: int = 3600


def load_settings(default_app_id: str = "scrubdoc") -> Settings:
    app_id = os.getenv("APP_ID", default_app_id).strip().lower()
    if app_id not in VALID_APPS:
        raise ValueError(f"Unsupported APP_ID '{app_id}'. Expected one of {VALID_APPS}.")

    provider_id = os.getenv("STORAGE_PROVIDER", "box").strip().lower()
    if provider_id not in VALID_PROVIDERS:
        raise ValueError(
            f"Unsupported STORAGE_PROVIDER '{provider_id}'. Expected one of {VALID_PROVIDERS}."
        )

    provider_name = PROVIDER_DISPLAY_NAMES[provider_id]
    app_short_name = APP_SHORT_NAMES[app_id]
    default_public_name = f"{app_short_name} for {provider_name}"

    p_upper = provider_id.upper()
    a_upper = app_id.upper()

    # Supports canonical Cloud Run Secret Manager bindings (`PROVIDER_CLIENT_ID`)
    # as well as provider+app explicit keys (`BOX_SCRUBDOC_CLIENT_ID`, etc.)
    # and legacy DEV fallbacks during transition.
    client_id_candidates = [
        "PROVIDER_CLIENT_ID",
        f"{p_upper}_{a_upper}_CLIENT_ID",
    ]
    client_secret_candidates = [
        "PROVIDER_CLIENT_SECRET",
        f"{p_upper}_{a_upper}_CLIENT_SECRET",
    ]
    if provider_id == "box":
        if app_id == "diffdoc":
            client_id_candidates.extend(["BOXDIFF_CLIENT_ID", "BOX_CLIENT_ID"])
            client_secret_candidates.extend(["BOXDIFF_CLIENT_SECRET", "BOX_CLIENT_SECRET"])
        else:
            client_id_candidates.append("BOX_CLIENT_ID")
            client_secret_candidates.append("BOX_CLIENT_SECRET")

    return Settings(
        suite_name="DocWorks",
        app_id=app_id,
        app_short_name=app_short_name,
        app_public_name=os.getenv("APP_PUBLIC_NAME", default_public_name).strip(),
        # Left blank by default per owner privacy policy; rendered on legal pages only if set.
        support_email=os.getenv("SUPPORT_EMAIL", "").strip(),
        provider_id=provider_id,
        provider_name=provider_name,
        provider_client_id=_first_env(*client_id_candidates),
        provider_client_secret=_first_env(*client_secret_candidates),
        hmac_pepper=_first_env("HMAC_PEPPER", f"HMAC_PEPPER_{p_upper}"),
        gcp_project_id=os.getenv("GCP_PROJECT_ID", "docworks-514722").strip(),
        use_firestore=os.getenv("USE_FIRESTORE", "true").strip().lower() in ("1", "true", "yes"),
        firestore_collection=os.getenv(
            "FIRESTORE_COLLECTION", f"entitlements_{provider_id}"
        ).strip(),
        free_scrub_limit_per_month=int(os.getenv("FREE_SCRUB_LIMIT", "25")),
        free_diff_limit_per_month=int(os.getenv("FREE_DIFF_LIMIT", "5")),
        free_radar_fix_limit_per_month=int(os.getenv("FREE_RADAR_FIX_LIMIT", "25")),
    )
