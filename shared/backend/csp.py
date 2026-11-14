from __future__ import annotations

from shared.backend.providers import ProviderSpec


def build_csp_header(spec: ProviderSpec) -> str:
    """Builds a strict Content-Security-Policy whitelisting ONLY the active storage provider origins."""
    connect_origins = " ".join(["'self'", "blob:", "data:", *spec.connect_src])
    frame_ancestors = " ".join(spec.frame_ancestors)
    return (
        "default-src 'self'; "
        "script-src 'self' 'wasm-unsafe-eval'; "
        "worker-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data:; "
        "img-src 'self' blob: data:; "
        f"connect-src {connect_origins}; "
        f"frame-ancestors {frame_ancestors};"
    )
