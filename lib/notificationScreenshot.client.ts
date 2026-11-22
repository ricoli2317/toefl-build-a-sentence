"use client";

const SCREENSHOT_PADDING = 32;
const MAX_CANVAS_WIDTH = 4096;
const MAX_CANVAS_HEIGHT = 16000;
const IMAGE_WAIT_MS = 3500;

const COPIED_STYLES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "box-sizing",
  "width",
  "min-width",
  "max-width",
  "min-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "background-color",
  "background-image",
  "background-repeat",
  "background-position",
  "background-size",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration-line",
  "text-transform",
  "white-space",
  "word-break",
  "overflow-wrap",
  "vertical-align",
  "list-style-type",
  "list-style-position",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "justify-content",
  "justify-items",
  "justify-self",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "order",
  "object-fit",
  "object-position",
  "opacity",
  "visibility",
  "overflow",
  "overflow-x",
  "overflow-y"
] as const;

export async function captureNotificationScreenshot(
  target: HTMLElement
): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new Error("Screenshot is only available in the browser.");
  }

  await waitForContentImages(target);
  const clone = target.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-notification-screenshot-exclude]").forEach((node) => node.remove());
  inlineComputedStyles(target, clone);
  await inlineImageSources(target, clone);

  const targetWidth = Math.max(
    280,
    Math.ceil(target.getBoundingClientRect().width || target.scrollWidth || 640)
  );
  clone.style.width = `${targetWidth}px`;
  clone.style.minWidth = "0";
  clone.style.background = "#ffffff";

  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.cssText = [
    "box-sizing:border-box",
    `width:${targetWidth + SCREENSHOT_PADDING * 2}px`,
    `padding:${SCREENSHOT_PADDING}px`,
    "background:#ffffff",
    "color:#172033",
    "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif"
  ].join(";");
  wrapper.appendChild(clone);

  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;z-index:-1;pointer-events:none;opacity:0;";
  host.appendChild(wrapper);
  document.body.appendChild(host);

  try {
    await waitForContentImages(wrapper);
    await nextFrame();
    const width = `${targetWidth + SCREENSHOT_PADDING * 2}`;
    const height = `${Math.max(1, Math.ceil(wrapper.scrollHeight))}`;
    const serialized = new XMLSerializer().serializeToString(wrapper);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${serialized}</foreignObject>` +
      "</svg>";
    return await rasterizeSvg(svg, Number(width), Number(height));
  } finally {
    host.remove();
  }
}

function inlineComputedStyles(source: Element, target: Element) {
  const computed = window.getComputedStyle(source);
  const targetElement = target as HTMLElement;
  for (const property of COPIED_STYLES) {
    const value = computed.getPropertyValue(property);
    if (value) targetElement.style.setProperty(property, value);
  }
  // Height is intentionally not copied: text must be allowed to wrap the same
  // way in the off-screen capture root. Images keep their rendered width.
  if (source instanceof HTMLImageElement) {
    targetElement.style.height = "auto";
    (targetElement as HTMLImageElement).loading = "eager";
    target.removeAttribute("height");
    target.removeAttribute("srcset");
    target.removeAttribute("sizes");
  }
  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  const count = Math.min(sourceChildren.length, targetChildren.length);
  for (let index = 0; index < count; index += 1) {
    inlineComputedStyles(sourceChildren[index], targetChildren[index]);
  }
}

async function inlineImageSources(source: Element, target: Element) {
  const sourceImages = Array.from(source.querySelectorAll("img"));
  const targetImages = Array.from(target.querySelectorAll("img"));
  await Promise.all(
    sourceImages.map(async (image, index) => {
      const clone = targetImages[index] as HTMLImageElement | undefined;
      if (!clone) return;
      if (!image.currentSrc && !image.src) return;
      try {
        clone.src = await imageUrlAsDataUrl(image.currentSrc || image.src);
      } catch {
        // Keep the image element; failed authenticated images are rendered as a
        // visible placeholder by NotificationImage and should stay that way.
      }
    })
  );
}

async function imageUrlAsDataUrl(url: string) {
  if (url.startsWith("data:")) return url;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Image could not be read.");
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Image could not be encoded."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Image could not be encoded."));
    reader.readAsDataURL(blob);
  });
}

async function waitForContentImages(target: HTMLElement) {
  const images = Array.from(target.querySelectorAll("img"));
  if (images.length === 0) return;
  await Promise.all(
    images.map((image) =>
      image.complete && image.naturalWidth > 0
        ? Promise.resolve()
        : waitForImage(image)
    )
  );
}

function waitForImage(image: HTMLImageElement) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, IMAGE_WAIT_MS);
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
  });
}

async function rasterizeSvg(svg: string, width: number, height: number): Promise<Blob> {
  const scale = Math.max(
    0.5,
    Math.min(2, MAX_CANVAS_WIDTH / width, MAX_CANVAS_HEIGHT / height)
  );
  // Use a data URL rather than a blob URL: Chrome can otherwise treat an SVG
  // containing foreignObject as an opaque resource and taint the canvas.
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The notification image could not be rendered."));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("The screenshot could not be encoded.")),
      "image/png"
    );
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function notificationScreenshotFilename(title: string, now = new Date()) {
  const safeTitle = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "通知";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `通知-${safeTitle}-${stamp}.png`;
}
