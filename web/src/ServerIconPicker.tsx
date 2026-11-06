import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Device, Display } from "./device-identity";
import { ServerIcon } from "./ServerIcon";

async function readIcon(source: Blob | string): Promise<ImageBitmap> {
  if (typeof source !== "string") {
    if (
      source.size > 2 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(source.type)
    )
      throw Error("Use a PNG, JPEG or WebP image up to 2 MB.");
    return createImageBitmap(source);
  }
  let url: URL;
  try {
    url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error();
  } catch {
    throw Error("Use an HTTPS image URL without a username or password.");
  }
  const remote = new Image();
  remote.crossOrigin = "anonymous";
  remote.referrerPolicy = "no-referrer";
  await new Promise<void>((resolve, reject) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      remote.onload = remote.onerror = null;
      if (ok) resolve();
      else {
        remote.removeAttribute("src");
        reject(
          Error(
            "Could not import this image link. Upload or paste the image instead.",
          ),
        );
      }
    };
    const timer = setTimeout(() => finish(false), 10000);
    remote.onload = () => finish(true);
    remote.onerror = () => finish(false);
    remote.src = url.href;
  });
  if (remote.naturalWidth > 4096 || remote.naturalHeight > 4096)
    throw Error("Choose an image no larger than 4096 pixels per side.");
  return createImageBitmap(remote);
}

async function clipboardImage() {
  if (!navigator.clipboard?.read)
    throw Error(
      "Focus this section and paste an image, or choose an image file.",
    );
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((type) =>
      ["image/png", "image/jpeg", "image/webp"].includes(type),
    );
    if (type) return item.getType(type);
  }
  throw Error("Copy an image first, then paste it here.");
}

export function ServerIconPicker({
  device,
  value,
  onChange,
}: {
  device: Device;
  value: Display;
  onChange: Dispatch<SetStateAction<Display>>;
}) {
  const image = useRef<ImageBitmap | null>(null);
  const generation = useRef(0);
  const [crop, setCrop] = useState({ zoom: 1, x: 50, y: 50 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  useEffect(
    () => () => {
      generation.current++;
      image.current?.close();
    },
    [],
  );
  function renderCrop(next: typeof crop, source: ImageBitmap) {
    const size = Math.min(source.width, source.height) / next.zoom;
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw Error("Image preview unavailable");
    context.drawImage(
      source,
      ((source.width - size) * next.x) / 100,
      ((source.height - size) * next.y) / 100,
      size,
      size,
      0,
      0,
      96,
      96,
    );
    const iconImage = canvas.toDataURL("image/png");
    if (iconImage.length > 65536) throw Error("Image could not be resized");
    onChange((previous) => ({ ...previous, icon: "custom", iconImage }));
    setCrop(next);
  }
  async function importImage(source: Blob | string | Promise<Blob>) {
    const current = ++generation.current;
    setError("");
    let decoded: ImageBitmap | undefined;
    try {
      decoded = await readIcon(await source);
      if (current !== generation.current) {
        decoded.close();
        return;
      }
      if (decoded.width > 4096 || decoded.height > 4096)
        throw Error("Choose an image no larger than 4096 pixels per side.");
      renderCrop({ zoom: 1, x: 50, y: 50 }, decoded);
      image.current?.close();
      image.current = decoded;
      setReady(true);
    } catch (reason) {
      decoded?.close();
      if (current === generation.current)
        setError(
          reason instanceof Error ? reason.message : "Could not read image",
        );
    }
  }
  return (
    <fieldset
      className="server-icon-picker"
      onPaste={(event) => {
        const file = Array.from(event.clipboardData.items)
          .find((item) => item.type.startsWith("image/"))
          ?.getAsFile();
        if (file) {
          event.preventDefault();
          void importImage(file);
        }
      }}
    >
      <legend>Sidebar icon & short text</legend>
      <span role="img" aria-label="Sidebar icon preview">
        <ServerIcon device={device} display={value} />
      </span>
      <label>
        Icon image
        <select
          aria-label="Icon image"
          value={value.icon ?? "automatic"}
          onChange={(e) => {
            generation.current++;
            image.current?.close();
            image.current = null;
            setReady(false);
            setError("");
            const icon = e.target.value as Display["icon"];
            onChange((previous) => ({ ...previous, icon }));
          }}
        >
          <option value="automatic">Automatic</option>
          <option value="supermicro">Supermicro logo</option>
          <option value="t320">Dell T320</option>
          <option value="t440">Dell T440</option>
          <option value="initials">Initials</option>
          <option value="custom">Custom image</option>
        </select>
      </label>
      <label>
        Short text
        <input
          aria-label="Short text"
          maxLength={6}
          placeholder="e.g. DEMO-A"
          value={value.iconText ?? ""}
          onChange={(e) => {
            const iconText = e.target.value;
            onChange((previous) => ({ ...previous, iconText }));
          }}
        />
        <small>Up to 6 characters</small>
      </label>
      <label>
        Choose icon image
        <input
          aria-label="Choose icon image"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void importImage(file);
          }}
        />
        <small>PNG, JPEG or WebP · up to 2 MB</small>
      </label>
      <div className="icon-image-import">
        <label>
          Image URL
          <input
            type="text"
            inputMode="url"
            placeholder="https://example.com/icon.png"
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!imageUrl.trim()}
          onClick={() => void importImage(imageUrl.trim())}
        >
          Use image URL
        </button>
        <button
          type="button"
          onClick={() => void importImage(clipboardImage())}
        >
          Paste image
        </button>
        <small>
          Or paste a copied image anywhere in this section. Some websites block
          image imports; upload or paste instead.
        </small>
      </div>
      {ready && (
        <div className="icon-crop-controls">
          {(
            [
              ["zoom", "Zoom", 1, 3, 0.1],
              ["x", "Horizontal position", 0, 100, 1],
              ["y", "Vertical position", 0, 100, 1],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <label key={key}>
              {label}
              <input
                type="range"
                aria-label={label}
                min={min}
                max={max}
                step={step}
                value={crop[key]}
                onChange={(e) => {
                  if (image.current)
                    renderCrop(
                      { ...crop, [key]: Number(e.target.value) },
                      image.current,
                    );
                }}
              />
            </label>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
