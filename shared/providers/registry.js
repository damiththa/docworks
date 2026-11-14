/**
 * DocWorks Frontend Storage Provider Client Factory.
 * Instantiates the browser-direct CORS client matching `/api/public-config -> provider_id`.
 */

import { BoxProviderClient } from "./box/client.js?v=11";
import { DropboxProviderClient } from "./dropbox/client.js?v=11";
import { GoogleDriveProviderClient } from "./gdrive/client.js?v=11";

export const DEFAULT_CAPABILITIES = Object.freeze({
  supports_version_history: true,
  supports_collaborators: true,
  supports_link_expiry: true,
  supports_download_disable: true,
  supports_link_password: true,
  supports_public_link_stats: true,
  supports_post_launch: true,
  supports_embedded_iframe: true,
});

export function createProviderClient(providerId, accessToken, capabilities = null) {
  const id = String(providerId || "box").toLowerCase();
  const caps = { ...DEFAULT_CAPABILITIES, ...(capabilities || {}) };

  if (id === "box") {
    return new BoxProviderClient(accessToken, caps);
  }
  if (id === "dropbox") {
    return new DropboxProviderClient(accessToken, caps);
  }
  if (id === "gdrive") {
    return new GoogleDriveProviderClient(accessToken, caps);
  }
  throw new Error(`Unsupported storage provider: ${providerId}`);
}
