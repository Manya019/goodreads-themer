const api = globalThis.browser ?? globalThis.chrome;
const KEY = "grx";
const DEFAULTS = {
  theme: "dark-academia", accent: "", deco: true, tint: true, declutter: true, libraryHome: true, userId: "", hidden: [], browseView: "blocks",
  custom: { bg: "#14121a", fg: "#e8e2d4", accent: "#d4a24c" },
};
const THEMES = [
  { id: "off",           name: "Original",      tag: "Neutral paper, no site-wide reskin", dots: ["#f4f1ea", "#382110", "#409d69"] },
  { id: "fiction",       name: "Fiction",       tag: "Paper, ink, teal",      dots: ["#e6e2d6", "#2a2823", "#1f6068"] },
  { id: "dark-academia", name: "Dark academia", tag: "Candlelit brass",       dots: ["#1a1511", "#ddd0b8", "#b8924f"] },
  { id: "thriller",      name: "Thriller",      tag: "Black and blood red",   dots: ["#0b0c0e", "#d8dadc", "#d1121b"] },
  { id: "mystical",      name: "Mystical",      tag: "Night sky and gilt",    dots: ["#110c22", "#e6dff7", "#d9b25f"] },
  { id: "aurora",        name: "Aurora",        tag: "Black stage, glowing color", dots: ["#050507", "#f3f1ee", "#ff6a3d"] },
  { id: "storybook",     name: "Storybook",     tag: "Retro print, teal and red",  dots: ["#f1e6cd", "#243b42", "#d9482f"] },
  { id: "custom",        name: "Custom",        tag: "Pick your own colors",  dots: ["#444", "#bbb", "#fff"] },
];

let state = structuredClone(DEFAULTS);
const $ = (id) => document.getElementById(id);

// Page scripts also write "hidden" (element picker) and "browseView" (Blocks/Table). Keep their latest
// values instead of overwriting them with whatever this popup loaded earlier.
const SHARED_KEYS = ["hidden", "browseView"];
async function save(override = {}) {
  const cur = (await api.storage.local.get(KEY))[KEY] || {};
  const merged = { ...state };
  for (const k of SHARED_KEYS) if (k in cur) merged[k] = cur[k];
  Object.assign(merged, override);
  state = merged;
  await api.storage.local.set({ [KEY]: merged });
}

function renderThemes() {
  const box = $("themes");
  box.innerHTML = "";
  for (const t of THEMES) {
    const dots = t.id === "custom"
      ? [state.custom.bg, state.custom.fg, state.custom.accent] : t.dots;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(state.theme === t.id));
    btn.innerHTML =
      `<span class="dots">${dots.map((c) => `<i style="background:${c}"></i>`).join("")}</span>` +
      `<span><b>${t.name}</b><small>${t.tag}</small></span>`;
    btn.addEventListener("click", () => { state.theme = t.id; save(); render(); });
    box.appendChild(btn);
  }
}

function render() {
  renderThemes();
  const isCustom = state.theme === "custom";
  $("customBox").hidden = !isCustom;
  $("accentBox").hidden = isCustom || state.theme === "off";
  $("deco").disabled = state.theme === "off" || isCustom;
  $("deco").checked = state.deco !== false;
  $("accent").value = state.accent || "#d9b25f";
  $("cBg").value = state.custom.bg;
  $("cFg").value = state.custom.fg;
  $("cAccent").value = state.custom.accent;
  for (const id of ["libraryHome", "tint", "declutter"]) $(id).checked = state[id] !== false;
  $("userId").value = state.userId || "";
  $("hiddenCount").textContent = (state.hidden || []).length;
  $("unhide").disabled = !(state.hidden || []).length;
}

$("accent").addEventListener("input", (e) => { state.accent = e.target.value; save(); });
$("resetAccent").addEventListener("click", () => { state.accent = ""; save(); render(); });
$("deco").addEventListener("change", (e) => { state.deco = e.target.checked; save(); });
for (const [id, key] of [["cBg", "bg"], ["cFg", "fg"], ["cAccent", "accent"]]) {
  $(id).addEventListener("input", (e) => { state.custom[key] = e.target.value; save(); renderThemes(); });
}

for (const id of ["libraryHome", "tint", "declutter"]) {
  $(id).addEventListener("change", (e) => { state[id] = e.target.checked; save(); });
}
$("userId").addEventListener("change", (e) => { state.userId = e.target.value.replace(/\D/g, ""); save(); render(); });
$("unhide").addEventListener("click", async () => { await save({ hidden: [] }); render(); });
$("pick").addEventListener("click", async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) { try { await api.tabs.sendMessage(tab.id, { type: "grx-pick" }); window.close(); } catch (_) {
    const btn = $("pick"), label = btn.textContent;
    btn.textContent = "Open a Goodreads page first";
    setTimeout(() => { btn.textContent = label; }, 2500); } }
});
$("openLib").addEventListener("click", () => { api.tabs.create({ url: "https://www.goodreads.com/review/list" }); window.close(); });

api.storage.local.get(KEY).then((r) => {
  state = { ...DEFAULTS, ...(r[KEY] || {}) };
  state.custom = { ...DEFAULTS.custom, ...(state.custom || {}) };
  render();
});
