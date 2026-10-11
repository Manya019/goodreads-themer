// Goodreads Themer: background worker.
// Fetches book cover images (the worker is allowed to, the page isn't) and works out
// their two dominant colors. Results are cached so each cover is only analysed once.
const api = globalThis.browser ?? globalThis.chrome;
const CACHE_KEY = "grx_colors";
let store = null;

const keyOf = (u) => (u || "").replace(/\._S[XY]\d+_/, "");
const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function hue(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

async function extract(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bmp = await createImageBitmap(await res.blob());
  const W = 40, H = Math.max(1, Math.round((40 * bmp.height) / bmp.width));
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;

  // Bucket pixels into a 16x16x16 color grid, favouring saturated, mid-brightness pixels.
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 510;
    const s = mx === mn ? 0 : (mx - mn) / (255 - Math.abs(mx + mn - 255));
    if (l < 0.1 || l > 0.92) continue;
    const w = 0.15 + s * s;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(k) || { r: 0, g: 0, b: 0, w: 0 };
    e.r += r * w; e.g += g * w; e.b += b * w; e.w += w;
    buckets.set(k, e);
  }
  const list = [...buckets.values()]
    .map((e) => ({ r: e.r / e.w, g: e.g / e.w, b: e.b / e.w, w: e.w }))
    .sort((a, b) => b.w - a.w);
  if (!list.length) return ["#4a4458", "#2c283a"];
  const first = list[0];
  const h1 = hue(first.r, first.g, first.b);
  const second = list.find((c) => {
    const d = Math.abs(hue(c.r, c.g, c.b) - h1);
    return Math.min(d, 360 - d) > 35;
  }) || first;
  return [hex(first.r, first.g, first.b), hex(second.r, second.g, second.b)];
}

async function colorsFor(urls) {
  if (!store) store = (await api.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const out = {};
  const todo = [];
  for (const u of urls) {
    const k = keyOf(u);
    if (store[k]) out[u] = store[k]; else todo.push(u);
  }
  // Analyse a few covers at a time.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async (u) => {
      try { out[u] = store[keyOf(u)] = await extract(u); } catch (_) {}
    }));
  }
  if (todo.length) await api.storage.local.set({ [CACHE_KEY]: store });
  return out;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "grx-colors") {
    colorsFor(msg.urls || []).then(sendResponse, () => sendResponse({}));
    return true; // async response
  }
});
