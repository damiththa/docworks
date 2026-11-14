from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable
from urllib.parse import urlencode
import httpx

from shared.backend.config import Settings

ExchangeFn = Callable[[httpx.AsyncClient, Settings, str, str | None], Awaitable[dict[str, str | int]]]


@dataclass(frozen=True)
class ProviderSpec:
    provider_id: str
    display_name: str
    implemented: bool
    authorize_url: str
    token_url: str
    api_hosts_display: str
    connect_src: tuple[str, ...]
    frame_ancestors: tuple[str, ...]
    return_url_regex: str
    home_url: str
    capabilities: dict[str, bool]
    extra_auth_params: dict[str, str]
    exchange_fn: ExchangeFn


async def _exchange_box_code(
    client: httpx.AsyncClient,
    settings: Settings,
    auth_code: str,
    redirect_uri: str | None,
) -> dict[str, str | int]:
    payload: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "client_id": settings.provider_client_id,
        "client_secret": settings.provider_client_secret,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri

    token_resp = await client.post("https://api.box.com/oauth2/token", data=payload)
    if token_resp.status_code != 200:
        raise ValueError("Box OAuth code exchange failed or expired. Please relaunch from Box.")

    token_json = token_resp.json()
    access_token = token_json.get("access_token", "")
    expires_in = int(token_json.get("expires_in", 3600))
    if not access_token:
        raise ValueError("Box did not return an access token.")

    # Strictly fetch numeric `id` only — never fetch personal name or email on Cloud Run.
    me_resp = await client.get(
        "https://api.box.com/2.0/users/me",
        params={"fields": "id"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    if me_resp.status_code != 200:
        raise ValueError("Unable to verify Box session identity.")

    box_user_id = str(me_resp.json().get("id", "")).strip()
    if not box_user_id:
        raise ValueError("Missing numeric Box user ID.")

    # Any refresh_token returned by Box is intentionally discarded and never stored.
    return {
        "access_token": access_token,
        "expires_in": expires_in,
        "provider_user_id": box_user_id,
    }


async def _exchange_dropbox_code(
    client: httpx.AsyncClient,
    settings: Settings,
    auth_code: str,
    redirect_uri: str | None,
) -> dict[str, str | int]:
    payload: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "client_id": settings.provider_client_id,
        "client_secret": settings.provider_client_secret,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri

    token_resp = await client.post("https://api.dropboxapi.com/oauth2/token", data=payload)
    if token_resp.status_code != 200:
        raise ValueError("Dropbox OAuth code exchange failed or expired. Please reconnect Dropbox.")

    token_json = token_resp.json()
    access_token = token_json.get("access_token", "")
    expires_in = int(token_json.get("expires_in", 14400))
    account_id = str(token_json.get("account_id") or token_json.get("uid") or "").strip()
    if not access_token or not account_id:
        raise ValueError("Dropbox token exchange did not return a valid session token and account ID.")

    return {
        "access_token": access_token,
        "expires_in": expires_in,
        "provider_user_id": account_id,
    }


async def _exchange_gdrive_code(
    client: httpx.AsyncClient,
    settings: Settings,
    auth_code: str,
    redirect_uri: str | None,
) -> dict[str, str | int]:
    payload: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "client_id": settings.provider_client_id,
        "client_secret": settings.provider_client_secret,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri

    token_resp = await client.post("https://oauth2.googleapis.com/token", data=payload)
    if token_resp.status_code != 200:
        raise ValueError("Google Drive OAuth code exchange failed or expired. Please reconnect Google Drive.")

    token_json = token_resp.json()
    access_token = token_json.get("access_token", "")
    expires_in = int(token_json.get("expires_in", 3600))
    if not access_token:
        raise ValueError("Google did not return an access token.")

    info_resp = await client.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    if info_resp.status_code != 200:
        raise ValueError("Unable to verify Google account subject identifier.")
    sub_id = str(info_resp.json().get("sub", "")).strip()
    if not sub_id:
        raise ValueError("Missing OpenID subject identifier (`openid` scope required).")

    return {
        "access_token": access_token,
        "expires_in": expires_in,
        "provider_user_id": sub_id,
    }


PROVIDERS: dict[str, ProviderSpec] = {
    "box": ProviderSpec(
        provider_id="box",
        display_name="Box",
        implemented=True,
        authorize_url="https://account.box.com/api/oauth2/authorize",
        token_url="https://api.box.com/oauth2/token",
        api_hosts_display="api.box.com and upload.box.com",
        connect_src=(
            "https://api.box.com",
            "https://upload.box.com",
            "https://*.boxcloud.com",
            "https://*.box.com",
        ),
        frame_ancestors=("'self'", "https://*.box.com", "https://*.app.box.com", "https://box.com"),
        return_url_regex=r"^https://([a-z0-9-]+\.)*(box\.com|app\.box\.com)(/|$)",
        home_url="https://app.box.com",
        capabilities={
            "supports_version_history": True,
            "supports_collaborators": True,
            "supports_link_expiry": True,
            "supports_download_disable": True,
            "supports_link_password": True,
            "supports_public_link_stats": True,
            "supports_post_launch": True,
            "supports_embedded_iframe": True,
        },
        extra_auth_params={},
        exchange_fn=_exchange_box_code,
    ),
    "dropbox": ProviderSpec(
        provider_id="dropbox",
        display_name="Dropbox",
        implemented=False,
        authorize_url="https://www.dropbox.com/oauth2/authorize",
        token_url="https://api.dropboxapi.com/oauth2/token",
        api_hosts_display="api.dropboxapi.com and content.dropboxapi.com",
        connect_src=(
            "https://api.dropboxapi.com",
            "https://content.dropboxapi.com",
            "https://*.dropboxusercontent.com",
        ),
        frame_ancestors=("'self'", "https://*.dropbox.com", "https://dropbox.com"),
        return_url_regex=r"^https://([a-z0-9-]+\.)*dropbox\.com(/|$)",
        home_url="https://www.dropbox.com/home",
        capabilities={
            "supports_version_history": True,
            "supports_collaborators": True,
            "supports_link_expiry": True,
            "supports_download_disable": True,
            "supports_link_password": True,
            "supports_public_link_stats": False,
            "supports_post_launch": False,
            "supports_embedded_iframe": False,
        },
        extra_auth_params={"token_access_type": "online"},
        exchange_fn=_exchange_dropbox_code,
    ),
    "gdrive": ProviderSpec(
        provider_id="gdrive",
        display_name="Google Drive",
        implemented=False,
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        api_hosts_display="www.googleapis.com and oauth2.googleapis.com",
        connect_src=(
            "https://www.googleapis.com",
            "https://oauth2.googleapis.com",
        ),
        frame_ancestors=("'self'", "https://drive.google.com", "https://docs.google.com"),
        return_url_regex=r"^https://(drive|docs)\.google\.com(/|$)",
        home_url="https://drive.google.com",
        capabilities={
            "supports_version_history": True,
            "supports_collaborators": True,
            "supports_link_expiry": False,
            "supports_download_disable": True,
            "supports_link_password": False,
            "supports_public_link_stats": False,
            "supports_post_launch": False,
            "supports_embedded_iframe": False,
        },
        extra_auth_params={
            "scope": "https://www.googleapis.com/auth/drive.file openid",
            "access_type": "online",
            "include_granted_scopes": "true",
        },
        exchange_fn=_exchange_gdrive_code,
    ),
}


def get_provider_spec(provider_id: str) -> ProviderSpec:
    spec = PROVIDERS.get(provider_id)
    if not spec:
        raise ValueError(f"Unsupported storage provider: {provider_id}")
    return spec


def build_provider_authorize_url(settings: Settings, spec: ProviderSpec, redirect_uri: str, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": settings.provider_client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        **spec.extra_auth_params,
    }
    return f"{spec.authorize_url}?{urlencode(params)}"


async def exchange_auth_code_stateless(
    settings: Settings,
    spec: ProviderSpec,
    auth_code: str,
    redirect_uri: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, str | int]:
    """
    Exchanges a short-lived provider OAuth 2.0 `auth_code` strictly in memory, reads ONLY an
    opaque provider user identifier (never email or name), and returns the volatile `access_token`
    to browser RAM without persisting anything.
    """
    if not settings.provider_client_id or not settings.provider_client_secret:
        raise RuntimeError(f"{spec.display_name} OAuth credentials are not configured in Secret Manager.")

    if http_client is not None:
        return await spec.exchange_fn(http_client, settings, auth_code, redirect_uri)

    async with httpx.AsyncClient(timeout=15.0) as temp_client:
        return await spec.exchange_fn(temp_client, settings, auth_code, redirect_uri)
