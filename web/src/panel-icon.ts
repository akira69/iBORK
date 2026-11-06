import type { Device, Display } from "./device-identity";
import { resolveServerIcon } from "./ServerIcon";

export async function panelIcon(
  device: Device,
  display: Display = {},
  signal: AbortSignal,
) {
  const { kind, source, shortLabel, initials } = resolveServerIcon(
    device,
    display,
  );
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("Could not draw panel icons in this browser.");
  ctx.fillStyle = "#192b39";
  ctx.fillRect(0, 0, 40, 40);
  ctx.beginPath();
  ctx.arc(20, 20, 20, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#203038";
  ctx.fillRect(0, 0, 40, 40);
  if (source) {
    if (
      kind === "custom" &&
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(source)
    )
      throw Error("Choose a saved PNG for the custom sidebar icon.");
    const image = new Image();
    const abort = () => image.removeAttribute("src");
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    try {
      image.src = source;
      await image.decode();
      const scale =
        kind === "supermicro"
          ? 36 / Math.max(image.naturalWidth, image.naturalHeight)
          : 40 / Math.min(image.naturalWidth, image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      ctx.drawImage(image, (40 - w) / 2, (40 - h) / 2, w, h);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  } else {
    ctx.font = "bold 18px system-ui";
    ctx.fillStyle = "#dce5e9";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials, 20, 20, 36);
  }
  const jpeg = canvas.toDataURL("image/jpeg", 0.7);
  const image = jpeg.slice("data:image/jpeg;base64,".length);
  if (!jpeg.startsWith("data:image/jpeg;base64,") || atob(image).length > 2048)
    throw Error("Could not fit the sidebar image on the panel.");
  return {
    id: device.id,
    label: shortLabel,
    image,
  };
}
