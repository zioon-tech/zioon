import "./shared-resource-marker.css";

/** One source mark for received models, folders and conversations. */
export function sharedResourceMarker(providerName = "") {
  const marker = document.createElement("span");
  marker.className = "shared-resource-marker";
  marker.title = providerName ? `${providerName} 分享的资源` : "收到的分享";
  marker.setAttribute("aria-label", marker.title);
  marker.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>';
  return marker;
}
