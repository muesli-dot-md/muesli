// Avatar file → small data URL, at the canvas boundary. Its own module (not a
// ProfileSection local) so component tests can mock the Image/canvas seam —
// jsdom has neither image decoding nor 2D contexts.

import { t } from "../i18n/index.svelte";

/** Cover-crop to a 128px square and encode small. WebP where the canvas
 *  supports encoding it; toDataURL silently falls back to PNG elsewhere
 *  (both accepted server-side), with a JPEG retry if PNG lands over 64 KB. */
export async function resizeToDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(t("settings.profile.avatarReadFailed")));
      img.src = objectUrl;
    });
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t("settings.profile.avatarReadFailed"));
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(
      img,
      (img.naturalWidth - s) / 2,
      (img.naturalHeight - s) / 2,
      s,
      s,
      0,
      0,
      size,
      size,
    );
    let dataUrl = canvas.toDataURL("image/webp", 0.85);
    if (dataUrl.length > 64 * 1024) dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    if (dataUrl.length > 64 * 1024) throw new Error(t("settings.profile.avatarTooLarge"));
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
