const APP_IMG_PREFIX = "app://img/";

export async function getDataUrlById(id) {
  if (!id) return null;
  const reader = window.zion?.media?.readImageDataUrl;
  if (typeof reader !== "function") return null;
  return await reader(`${APP_IMG_PREFIX}${id}`);
}

export async function resolveAppImage(src) {
  if (!src || typeof src !== "string" || !src.startsWith(APP_IMG_PREFIX)) return null;
  const reader = window.zion?.media?.readImageDataUrl;
  if (typeof reader !== "function") return null;
  return await reader(src);
}
