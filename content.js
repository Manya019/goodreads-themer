// Goodreads Themer: content script.
// Sets theme attributes on <html>, tints native book pages from cover colors,
// hides user-picked elements, and enables the catalogue on My Books only.
// It never sends your data anywhere.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const KEY = "grx";
  const CACHE = "grx_cache";
  const root = document.documentElement;
  const OVERRIDES = ["--grx-accent", "--grx-accent-fg", "--grx-bg", "--grx-fg", "--grx-muted", "--grx-link"];
  const DEFAULTS = { theme: "dark-academia", accent: "", deco: true, tint: true, declutter: true, libraryHome: true, hidden: [], browseView: "blocks" };
  let settings = DEFAULTS;

  const rgb = (hex) => {
    const h = /^#?[0-9a-f]{6}$/i.test(String(hex || "")) ? String(hex).replace("#", "") : "000000";
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  };
  const luminance = (hex) => rgb(hex).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + .05) / (lo + .05);
  };
  const readable = (hex) => contrast(hex, "#000000") >= contrast(hex, "#ffffff") ? "#000000" : "#ffffff";
  const accessibleForeground = (fg, bg) => contrast(fg, bg) >= 4.5 ? fg : readable(bg);
  const mixHex = (a, b, amountA) => {
    const aa = rgb(a), bb = rgb(b);
    return "#" + aa.map((v, i) => Math.round((v * amountA + bb[i] * (1 - amountA)) * 255)
      .toString(16).padStart(2, "0")).join("");
  };
  const PALETTES = {
    fiction: { bg: "#e6e2d6", bg2: "#efebe0", bg3: "#f8f5ec", fg: "#2a2823", muted: "#59564d", link: "#1f6068", accent: "#1f6068" },
    "dark-academia": { bg: "#1a1511", bg2: "#231c16", bg3: "#2e251d", fg: "#e6dac4", muted: "#b9aa91", link: "#d3ab62", accent: "#b8924f" },
    thriller: { bg: "#0b0c0e", bg2: "#131518", bg3: "#1b1e22", fg: "#e8eaed", muted: "#b2b8bf", link: "#ee5258", accent: "#d1121b" },
    mystical: { bg: "#110c22", bg2: "#1a1333", bg3: "#251b47", fg: "#f0eafd", muted: "#c0b4e0", link: "#c3a6ff", accent: "#d9b25f" },
    aurora: { bg: "#050507", bg2: "#0e0e12", bg3: "#17171d", fg: "#f6f4f1", muted: "#bcb9c5", link: "#ffb86b", accent: "#ff6a3d" },
    storybook: { bg: "#f1e6cd", bg2: "#f8f0dc", bg3: "#fffaf0", fg: "#1f3238", muted: "#4a5d61", link: "#1f6a73", accent: "#d9482f" }
  };
  function contrastFloor(foreground, surfaces) {
    return Math.min(...surfaces.map((surface) => contrast(foreground, surface)));
  }
  function selectContrastColor(original, fallback, surfaces) {
    if (contrastFloor(original, surfaces) >= 4.5) return original;
    return [...new Set([fallback, original, "#000000", "#ffffff"])]
      .sort((a, b) => contrastFloor(b, surfaces) - contrastFloor(a, surfaces))[0];
  }
  function repairThemeContrast(s) {
    let p = PALETTES[s.theme];
    if (s.theme === "custom" && s.custom) {
      const bg = s.custom.bg || "#14121a", fg = accessibleForeground(s.custom.fg || "#e8e2d4", bg);
      p = { bg, bg2: mixHex(bg, fg, .93), bg3: mixHex(bg, fg, .86), fg,
        muted: mixHex(fg, bg, .62), link: s.custom.accent || "#d4a24c", accent: s.custom.accent || "#d4a24c" };
    }
    if (!p) return;
    const surfaces = [p.bg, p.bg2, p.bg3];
    const fg = selectContrastColor(p.fg, readable(p.bg), surfaces);
    const muted = selectContrastColor(p.muted, fg, surfaces);
    const link = selectContrastColor(p.link, fg, surfaces);
    root.style.setProperty("--grx-fg", fg);
    root.style.setProperty("--grx-muted", muted);
    root.style.setProperty("--grx-link", link);
    const activeAccent = (s.theme === "custom" && s.custom?.accent) || s.accent || p.accent;
    root.style.setProperty("--grx-accent-fg", readable(activeAccent));
  }

  function loadFonts() { /* Theme typography uses system font stacks only. */ }

  // Preserve only Goodreads' original logo image/SVG artwork. Wordmarks and
  // header controls use theme-aware colors for readable contrast.
  const PRESERVE_COLORS = "grx-preserve-native-colors";
  const LOGO_SELECTORS = [
    "#logo", ".siteHeader__logo", ".headerLogo", "a.siteHeader__logo", "a.headerLogo",
    '[data-testid="headerLogo"]', '[data-testid="logo"]'
  ].join(",");
  const HEADER_SELECTORS = '#topNavContainer, #siteHeader, .siteHeader, .Header, header[class*="Header"], nav[class*="Header"]';
  function markNativeArtwork(element) {
    if (!element || element.id === "grx-host" || element.closest?.("#grx-host")) return;
    // Preserve the artwork only. Never exempt the clickable wrapper or wordmark
    // text from theme colors, since some Goodreads headers render the logo as text.
    const artwork = [];
    if (element.matches?.("img, svg")) artwork.push(element);
    element.querySelectorAll?.("img, svg").forEach((node) => artwork.push(node));
    artwork.forEach((node) => {
      node.classList.add(PRESERVE_COLORS);
      if (node.tagName.toLowerCase() === "svg") node.querySelectorAll("*").forEach((child) => child.classList.add(PRESERVE_COLORS));
    });
  }
  // ---------- navbar ----------
  // Goodreads' own layout positions the bar. This script only finds the bar, tags the logo, dropdown
  // panels and icon buttons so CSS can treat them explicitly.
  const TAB_LABEL = /^(home|my books|browse|community)(?:\s*[▾▼⌄])?$/;
  const SEARCH_INPUT = 'input[type="search"], input[name="q"], input[placeholder*="search" i]';
  const PERSONAL = [
    'a[href*="/notifications"]', 'a[href*="/message"]', '[aria-label*="notification" i]',
    '[aria-label*="message" i]', '[aria-label*="inbox" i]', '[aria-label*="profile" i]',
    '[aria-label*="account" i]', '[data-testid*="profile" i]', '[data-testid*="notification" i]',
    '[data-testid*="message" i]'
  ].join(",");
  let enhanceTimer = 0;

  const labelOf = (el) => (el.innerText || el.getAttribute("aria-label") || el.title || "")
    .replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();

  // Finds the top bar by class name first, then by geometry (a full-width strip near the top of the
  // page that holds the My Books link). The geometric fallback keeps the bar themed on pages where
  // Goodreads swaps in a differently-named header.
  function geometricBar() {
    const link = [...document.querySelectorAll('a[href*="/review/list"]')].find((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top + window.scrollY < 180;
    });
    if (!link) return null;
    let best = null;
    for (let el = link.parentElement; el && el !== document.body && el !== root; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.height > 160) break;
      if (r.height >= 36 && r.width >= window.innerWidth * 0.9) best = el;
    }
    return best;
  }

  function findBars() {
    const all = [...document.querySelectorAll(HEADER_SELECTORS)].filter((el) => {
      if (el.closest("#grx-host")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 200;
    });
    const geo = geometricBar();
    if (geo && !all.some((el) => el === geo || el.contains(geo) || geo.contains(el))) all.push(geo);
    // Only the outermost header element is "the bar"; nested wrappers are part of it.
    const bars = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
    document.querySelectorAll(".grx-bar").forEach((el) => { if (!bars.includes(el)) el.classList.remove("grx-bar"); });
    bars.forEach((el) => { el.classList.add("grx-bar"); markBarParts(el); });
    return bars;
  }

  // Tag the logo link and any dropdown panels inside the bar so CSS can treat them explicitly:
  // the logo always gets a light tile (so it is visible in every theme) and dropdown panels always
  // get an opaque surface.
  function markBarParts(bar) {
    const home = bar.querySelector('a[href="/"], a[href="https://www.goodreads.com/"]');
    if (home && !home.closest(".grx-dropdown")) {
      const looksLikeLogo = home.querySelector('img, svg, [class*="logo" i]')
        || /goodreads/i.test(home.getAttribute("aria-label") || home.title || "")
        || (getComputedStyle(home).backgroundImage || "none") !== "none";
      if (looksLikeLogo) { home.classList.add("grx-logo-link"); markNativeArtwork(home); }
    }
    // A dropdown is a floating panel (menu, notifications, account, Browse, Community) that does not
    // itself hold the tabs, the search box or the logo.
    const barBottom = bar.getBoundingClientRect().bottom;
    bar.querySelectorAll("div, ul, nav, section, aside").forEach((el) => {
      el.classList.toggle("grx-dropdown", looksLikePanel(el, barBottom));
    });
  }

  const PANEL_HINT = /dropdown|menu|popover|popup|flyout|panel|notification|account|profile|inbox|messages|tray|overlay/i;
  function holdsPrimaryControls(el) {
    return !!el.querySelector(SEARCH_INPUT) || !!el.querySelector(".grx-logo-link")
      || [...el.querySelectorAll("a, button")].some((n) => TAB_LABEL.test(labelOf(n)));
  }
  function looksLikePanel(el, barBottom) {
    if (el.id === "grx-host" || el.closest("#grx-host")) return false;
    const cs = getComputedStyle(el);
    const role = el.getAttribute("role") || "";
    const hint = PANEL_HINT.test(`${el.className && el.className.baseVal === undefined ? el.className : ""} ${el.getAttribute("data-testid") || ""} ${el.id || ""}`);
    const floating = cs.position === "absolute" || cs.position === "fixed";
    if (!(floating || /^(menu|dialog|listbox)$/.test(role) || hint)) return false;
    if (!floating && !/^(menu|dialog|listbox)$/.test(role)) return false;
    if (el.querySelectorAll("a, button, li, [role='menuitem']").length < 1) return false;
    const r = el.getBoundingClientRect();
    const hidden = cs.display === "none" || cs.visibility === "hidden" || !r.width || !r.height || parseFloat(cs.opacity) === 0;
    if (holdsPrimaryControls(el)) return false;
    // Tiny top-row wrappers often carry class names such as "notifications" or "account" but are
    // icon controls, not dropdown surfaces. Never classify a small control shell as a floating panel.
    const controls = el.querySelectorAll('a, button, [role="button"]');
    if (r.width <= 120 && r.height <= 100 && controls.length <= 2 && r.top < barBottom + 24) return false;
    return hidden || r.top >= barBottom - 2 || /^(menu|dialog|listbox)$/.test(role) || hint;
  }
  // Notification and account panels are often rendered by Goodreads outside the header (a portal on
  // <body>), so they are looked for on the whole page too.
  function markPortalPanels() {
    const bar = document.querySelector(".grx-bar");
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 90;
    document.querySelectorAll("body > div, body > ul, body > nav, body > section, body > aside, body > div > div").forEach((el) => {
      if (el.closest(".grx-bar") || el.id === "grx-host") return;
      const cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed") return;
      const r = el.getBoundingClientRect();
      if (r.width <= 120 && r.height <= 100) { el.classList.remove("grx-dropdown"); return; }
      const nearTop = r.top < Math.max(barBottom + 520, 560);
      const small = r.width < 560 && r.height < 720;
      const on = nearTop && small && r.width > 0 && r.height > 0 && PANEL_HINT.test(`${el.className && el.className.baseVal === undefined ? el.className : ""} ${el.getAttribute("data-testid") || ""} ${el.getAttribute("role") || ""} ${el.id || ""}`)
        && !holdsPrimaryControls(el);
      el.classList.toggle("grx-dropdown", on);
    });
  }

  // ---------- header icon buttons (notifications, messages, inbox, friends, profile) ----------
  // Tag named personal controls even when they include unread counts or visually hidden labels.
  // Preserve CSS sprites and image avatars, and only tint SVGs when their computed paints are monochrome.
  function styleIconButtons(bar) {
    bar.querySelectorAll('a, button, [role="button"]').forEach((item) => {
      if (item.closest("form, .grx-logo-link") || item.classList.contains("grx-logo-link")) return;
      if (TAB_LABEL.test(labelOf(item))) return;
      const r = item.getBoundingClientRect();
      const text = (item.innerText || "").replace(/[\s\u00a0]/g, "");
      const personal = item.matches(PERSONAL) || !!item.querySelector(PERSONAL);
      const href = item.getAttribute("href") || "";
      const accessibleLabel = `${item.getAttribute("aria-label") || ""} ${item.title || ""} ${href} ${item.getAttribute("data-testid") || ""}`;
      const namedPersonal = personal || /notification|message|inbox|account|profile|friend/i.test(accessibleLabel);
      const iconArtwork = item.querySelector('svg, img, [class*="icon" i], [class*="sprite" i]');
      const sizeOkay = r.width > 0 && r.width <= 112 && r.height > 0 && r.height <= 112;
      // Known account/notification actions remain icon controls even if Goodreads includes an
      // unread count or visually-hidden label in their text. Only guess at unknown controls when
      // they are genuinely icon-only, to avoid tagging ordinary navigation links.
      const icon = sizeOkay && (namedPersonal || (!!iconArtwork && text.length <= 3 && !TAB_LABEL.test(labelOf(item))));
      item.classList.toggle("grx-icon-btn", !!icon);
      item.classList.remove("grx-icon-plain");
      if (!icon) return;
      // Preserve detailed/multicolor artwork, but mark genuinely monochrome SVGs so CSS can tint only those.
      item.querySelectorAll("svg").forEach((svg) => {
        svg.classList.add("grx-header-icon-native");
        const parts = [svg, ...svg.querySelectorAll("path, circle, ellipse, rect, polygon, line, polyline, use")];
        const paintValues = [];
        for (const part of parts) {
          const style = getComputedStyle(part);
          for (const name of ["fill", "stroke"]) {
            const value = String(style[name] || "").trim().toLowerCase().replace(/\s+/g, "");
            if (value && !["none", "transparent", "rgba(0,0,0,0)"].includes(value) && !value.startsWith("url(")) paintValues.push(value);
          }
        }
        const hasComplexPaint = !!svg.querySelector("linearGradient, radialGradient, pattern, filter, mask, image, foreignObject")
          || parts.some((part) => /url\s*\(/i.test(`${part.getAttribute("fill") || ""} ${part.getAttribute("stroke") || ""} ${part.getAttribute("style") || ""}`));
        const monochrome = !hasComplexPaint && new Set(paintValues).size <= 1;
        svg.classList.toggle("grx-header-icon-monochrome", monochrome);
        svg.classList.toggle("grx-header-icon-colored", !monochrome);
      });
      // Keep Goodreads' native unread counter markup and positioning. Styling a number
      // descendant as a second badge created a duplicate layered counter on book/search pages.
    });
  }

  function alignNavbar() {
    if (!root.hasAttribute("data-grx-theme")) return;
    findBars().forEach(styleIconButtons);
    markPortalPanels();
  }

  // ---------- surface + contrast repair ----------
  // Goodreads has many legacy panels with hard-coded white backgrounds and dark text. This pass
  // reads computed styles on what is actually on screen, repaints white surfaces with the theme
  // surface, and fixes any text whose contrast against its real background is too low. Working
  // from computed colors means it needs no knowledge of Goodreads' class names.
  const REPAIR_TAGS = "div,section,article,aside,header,footer,nav,main,ul,ol,li,table,thead,tbody,tr,td,th,form,fieldset,p,span,a,label,h1,h2,h3,h4,h5,h6,dt,dd,small,b,strong,em,i,cite,blockquote,button,legend,caption";
  const ZONE = ".grx-preserve-native-colors";
  const REPAIR_SKIP = "#grx-host,.grx-logo-link,.grx-icon-btn,.grx-browse-tools,.grx-browse-generated-table,.bookCover,.bookImage,.coverImage,[class*='BookCover' i],[class*='coverImage' i],[class*='BookCard__cover' i],[class*='BookCard__image' i],[data-testid*='bookCover' i],img,svg,video,canvas,iframe,input,select,textarea,option,[class*='staticStar'],[class*='RatingStar']";
  const FIX_PROPS = ["background-color", "color", "-webkit-text-fill-color", "border-color", "opacity"];
  const originals = new WeakMap();
  let lastRepair = 0, repairTimer = 0;

  function parseColor(str) {
    let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(str || "");
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4]) };
    m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(str || "");
    if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4]) };
    return null;
  }
  const lin = (v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const lum = (c) => .2126 * lin(c.r) + .7152 * lin(c.g) + .0722 * lin(c.b);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
  const css = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

  function themeTokens() {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none";
    root.appendChild(probe);
    const read = (prop, v) => { probe.style.setProperty(prop, `var(${v})`); return parseColor(getComputedStyle(probe).getPropertyValue(prop)); };
    const t = {
      bg: read("background-color", "--grx-bg"), bg2: read("background-color", "--grx-bg2"),
      bg3: read("background-color", "--grx-bg3"), fg: read("color", "--grx-fg"), link: read("color", "--grx-link"),
      border: read("border-top-color", "--grx-border")
    };
    probe.remove();
    return t.bg && t.bg2 && t.fg ? { ...t, bg3: t.bg3 || t.bg2, link: t.link || t.fg, border: t.border || t.bg3 || t.bg2 } : null;
  }

  function setFix(el, prop, value) {
    let saved = originals.get(el);
    if (!saved) { saved = {}; originals.set(el, saved); }
    if (!(prop in saved)) saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
    el.style.setProperty(prop, value, "important");
    el.setAttribute("data-grx-fix", "");
  }
  function resetRepairs() {
    document.querySelectorAll("[data-grx-fix]").forEach((el) => {
      const saved = originals.get(el) || {};
      FIX_PROPS.forEach((prop) => {
        if (prop in saved && saved[prop][0]) el.style.setProperty(prop, saved[prop][0], saved[prop][1]);
        else el.style.removeProperty(prop);
      });
      el.removeAttribute("data-grx-fix");
    });
  }
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());

  function repairPass() {
    lastRepair = Date.now();
    if (!root.hasAttribute("data-grx-theme") || !document.body) return;
    const T = themeTokens();
    if (!T) return;
    const dark = lum(T.bg) < .3;
    const vh = window.innerHeight;
    const effective = new Map();
    const bgOf = (el) => {
      if (!el || el === root) return T.bg;
      if (effective.has(el)) return effective.get(el);
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      let out;
      if (c && c.a > .85) out = c;
      else if (cs.backgroundImage !== "none") out = null;
      else out = bgOf(el.parentElement);
      effective.set(el, out);
      return out;
    };
    let seen = 0, past = 0;
    for (const el of document.body.querySelectorAll(REPAIR_TAGS)) {
      if (++seen > 6000) break;
      const r = el.getBoundingClientRect();
      // Document order is mostly top-to-bottom, so stop once we are well past the screen.
      if (r.top > vh + 1200) { if (++past > 60) break; continue; }
      past = 0;
      if (!r.width || !r.height || r.bottom < -1200) continue;
      if (el.matches(REPAIR_SKIP) || el.closest(REPAIR_SKIP)) continue;
      const cs = getComputedStyle(el);
      // Native "similar books" / editions shelves keep their own backgrounds, but their text must
      // still be readable on the theme, so they only get the text fix below.
      const inZone = el.matches(ZONE) || !!el.closest(ZONE);
      // 1) Hard-coded white/cream panels become the theme surface.
      const bg = inZone ? null : parseColor(cs.backgroundColor);
      if (bg && bg.a > .85 && cs.backgroundImage === "none") {
        const L = lum(bg);
        if (L > .8 && (dark || L > .93)) {
          const surface = dark ? T.bg2 : T.bg3;
          setFix(el, "background-color", css(surface));
          effective.set(el, surface);
        }
      }
      // Light divider lines (cell borders, rules) become the theme border color.
      const edges = ["Top", "Right", "Bottom", "Left"].map((e) => ({ w: parseFloat(cs[`border${e}Width`]), c: parseColor(cs[`border${e}Color`]), s: cs[`border${e}Style`] }));
      if (!inZone && edges.some((e) => e.w > 0 && e.s !== "none" && e.c && e.c.a > .3 && lum(e.c) > (dark ? .6 : .93))) {
        setFix(el, "border-color", css(T.border));
      }
      // 2) Text that cannot be read against its real background gets a readable color.
      if (!hasOwnText(el)) continue;
      const under = bgOf(el);
      // What is painted is -webkit-text-fill-color when it is set, and the element's own opacity fades it.
      const fg0 = parseColor(cs.webkitTextFillColor) || parseColor(cs.color);
      if (!under || !fg0 || fg0.a < .3) continue;
      const own = Math.min(1, fg0.a * (parseFloat(cs.opacity) || 1));
      const fg = { r: under.r + (fg0.r - under.r) * own, g: under.g + (fg0.g - under.g) * own, b: under.b + (fg0.b - under.b) * own };
      if (ratio(fg, under) >= 4.5) continue;
      if (parseFloat(cs.opacity) < .95) setFix(el, "opacity", "1");
      const pick = (el.matches("a") ? [T.link, T.fg] : [T.fg, T.link]).find((c) => ratio(c, under) >= 4.5)
        || (lum(under) > .4 ? { r: 20, g: 20, b: 20 } : { r: 245, g: 245, b: 245 });
      setFix(el, "color", css(pick));
      setFix(el, "-webkit-text-fill-color", css(pick));
    }
  }


  // Work is batched: at most one pass per 150 ms however busy the page is.
  function scheduleEnhance() {
    if (enhanceTimer) return;
    enhanceTimer = setTimeout(() => {
      enhanceTimer = 0;
      preserveNativeControlColors();
      requestAnimationFrame(() => {
        alignNavbar();
        // The repair pass reads many styles, so it runs at most about three times a second.
        const wait = 350 - (Date.now() - lastRepair);
        if (wait <= 0) repairPass();
        else if (!repairTimer) repairTimer = setTimeout(() => { repairTimer = 0; repairPass(); }, wait);
      });
    }, 150);
  }
  function preserveNativeControlColors() {
    document.querySelectorAll(LOGO_SELECTORS).forEach((logo) => {
      logo.classList.add("grx-logo-link");
      markNativeArtwork(logo);
      const link = logo.matches("a") ? logo : logo.closest("a");
      if (link) link.classList.add("grx-logo-link");
    });
    // Some Goodreads header versions render the logo as a plain home link without
    // a stable logo class. Preserve only img/SVG artwork and theme its text wrapper.
    // The suffix has to be added to each header selector. Appending it once to the whole comma
    // list only qualified the last selector and made the header elements themselves match,
    // which tagged the entire bar as "the logo".
    const homeLinks = HEADER_SELECTORS.split(",").map((h) => h.trim())
      .flatMap((h) => [`${h} a[href="/"]`, `${h} a[href="https://www.goodreads.com/"]`]).join(",");
    document.querySelectorAll(homeLinks).forEach((link) => {
      if (link.querySelector('img, svg, [class*="logo" i]') || /goodreads/i.test(link.getAttribute('aria-label') || link.title || '')) {
        link.classList.add("grx-logo-link");
        markNativeArtwork(link);
      }
    });
  }
  preserveNativeControlColors();
  new MutationObserver(scheduleEnhance).observe(document.documentElement, { childList: true, subtree: true });
  // Dropdowns usually open by toggling a class, aria-expanded or style, with no nodes added, so those
  // changes (and clicks/hovers on the header) also schedule a re-tag of the panels.
  new MutationObserver(scheduleEnhance).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["aria-expanded", "hidden", "style"] });
  ["click", "mouseover", "focusin"].forEach((ev) => document.addEventListener(ev, (e) => {
    if (e.target && e.target.closest && e.target.closest(".grx-bar, [role='menu'], [role='dialog'], [aria-haspopup]")) scheduleEnhance();
  }, { passive: true, capture: true }));
  window.addEventListener("resize", scheduleEnhance, { passive: true });
  window.addEventListener("load", scheduleEnhance);
  window.addEventListener("scroll", scheduleEnhance, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleEnhance);

  // ---------- hidden elements ----------
  function applyHidden(list) {
    let st = document.getElementById("grx-hidden");
    if (!st) { st = document.createElement("style"); st.id = "grx-hidden"; root.appendChild(st); }
    st.textContent = (list || []).map((s) => `${s}{display:none !important}`).join("\n");
  }

  // ---------- home page flag ----------
  // Keep the native Goodreads home and navigation. The enhanced catalogue only
  // replaces the shelf content area on My Books, never the whole site.
  const isLibraryRoute = () => /^\/review\/list(?:\/|$)/.test(location.pathname);
  const isLandingRoute = () => location.pathname === "/" || location.pathname === "/home";
  const wantsHome = (s) =>
    (isLibraryRoute() || isLandingRoute()) && s.libraryHome !== false && !/[?&]grx=off(?:&|$)/.test(location.search);
  const browseRouteType = () => {
    const p = location.pathname;
    if (/^\/genres?(?:\/|$)/i.test(p)) return "genre";
    if (/^\/shelf\/show\//i.test(p)) return "shelf";
    if (/^\/list\/show\//i.test(p)) return "list";
    return "";
  };
  // Explicitly tag Goodreads discovery pages so their legacy cards and text get
  // theme-aware contrast without forcing a replacement grid or changing order.
  const discoveryRouteType = () => {
    const p = location.pathname.toLowerCase();
    if (/choice.?awards|best-books-20\d{2}|goodreads-choice/.test(p)) return "awards";
    if (/new[_-]?releases?|popular_by_date|coming[_-]?soon/.test(p)) return "releases";
    if (/^\/book\/popular(?:\/|$)/.test(p)) return "popular";
    if (/^\/genres?(?:\/|$)/.test(p)) return "genres";
    if (/^\/browse(?:\/|$)|^\/explore(?:\/|$)/.test(p)) return "browse";
    if (/^\/list\/show\//.test(p)) return "lists";
    return "";
  };
  function syncThemeClasses(theme) {
    const names = ["theme-fiction", "theme-dark-academia", "theme-thriller", "theme-mystical", "theme-aurora", "theme-storybook", "theme-custom"];
    root.classList.remove(...names);
    if (document.body) document.body.classList.remove(...names);
    if (theme && theme !== "off") {
      const c = `theme-${theme}`;
      root.classList.add(c);
      if (document.body) document.body.classList.add(c);
    }
  }

  // ---------- apply settings ----------
  function apply(s) {
    settings = { ...DEFAULTS, ...(s || {}) };
    OVERRIDES.forEach((p) => root.style.removeProperty(p));
    syncThemeClasses(settings.theme);
    const browseType = browseRouteType();
    if (browseType) root.setAttribute("data-grx-browse-route", browseType); else root.removeAttribute("data-grx-browse-route");
    if (/^\/search(?:\/|$)/i.test(location.pathname)) root.setAttribute("data-grx-search", ""); else root.removeAttribute("data-grx-search");
    const discoveryType = discoveryRouteType();
    if (discoveryType) root.setAttribute("data-grx-discovery-page", discoveryType); else root.removeAttribute("data-grx-discovery-page");
    if (/^\/book\/show\//.test(location.pathname)) root.setAttribute("data-grx-book-page", ""); else root.removeAttribute("data-grx-book-page");
    if (/^\/review\/list(?:\/|$)/.test(location.pathname)) root.setAttribute("data-grx-books-page", ""); else root.removeAttribute("data-grx-books-page");
    if (/^\/user\//.test(location.pathname) || /^\/friend\//.test(location.pathname)) root.setAttribute("data-grx-profile-page", ""); else root.removeAttribute("data-grx-profile-page");
    const profileEditRoute = /(?:^\/user\/(?:edit|settings|profile)|^\/account\/(?:edit|profile)|^\/settings\/(?:profile|account)|^\/profile\/edit)/i.test(location.pathname);
    if (profileEditRoute) root.setAttribute("data-grx-profile-edit", ""); else root.removeAttribute("data-grx-profile-edit");
    root.style.removeProperty("color-scheme");
    applyHidden(settings.hidden);
    root.setAttribute("data-grx-declutter", settings.declutter ? "on" : "off");
    root.setAttribute("data-grx-tint", settings.tint ? "on" : "off");
    if (wantsHome(settings)) root.setAttribute("data-grx-home", ""); else root.removeAttribute("data-grx-home");

    if (settings.theme === "off") {
      root.removeAttribute("data-grx-theme");
      root.removeAttribute("data-grx-deco");
      resetRepairs();
      scheduleEnhance();
      return;
    }
    root.setAttribute("data-grx-theme", settings.theme);
    root.setAttribute("data-grx-deco", settings.deco === false ? "off" : "on");
    if (settings.theme === "custom" && settings.custom) {
      root.style.setProperty("color-scheme", luminance(settings.custom.bg) > .42 ? "light" : "dark");
      root.style.setProperty("--grx-bg", settings.custom.bg);
      root.style.setProperty("--grx-fg", accessibleForeground(settings.custom.fg, settings.custom.bg));
      root.style.setProperty("--grx-accent", settings.custom.accent);
      root.style.setProperty("--grx-accent-fg", readable(settings.custom.accent));
      root.style.setProperty("--grx-link", contrast(settings.custom.accent, settings.custom.bg) >= 4.5 ? settings.custom.accent : readable(settings.custom.bg));
    } else {
      const themeAccent = {
        fiction: "#1f6068", "dark-academia": "#b8924f", thriller: "#d1121b",
        mystical: "#d9b25f", aurora: "#ff6a3d", storybook: "#d9482f"
      }[settings.theme];
      const accent = settings.accent || themeAccent;
      if (accent) {
        root.style.setProperty("--grx-accent-fg", readable(accent));
        if (settings.accent) root.style.setProperty("--grx-accent", settings.accent);
      }
    }
    repairThemeContrast(settings);
    syncThemeClasses(settings.theme);
    loadFonts();
    resetRepairs();
    scheduleEnhance();
  }

  function update(s) {
    apply(s);
    try { localStorage.setItem(CACHE, JSON.stringify(s)); } catch (_) {}
    tintBookPage();
    if (globalThis.__grxRouteChanged) globalThis.__grxRouteChanged();
  }

  // Apply the cached settings synchronously to avoid a flash of the default look.
  try {
    const cached = localStorage.getItem(CACHE);
    if (cached) apply(JSON.parse(cached));
    else apply(DEFAULTS);
  } catch (_) { apply(DEFAULTS); }

  api.storage.local.get(KEY).then((r) => update(r[KEY] || DEFAULTS));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) update(changes[KEY].newValue || DEFAULTS);
  });

  // ---------- cover tint on book pages ----------
  let tinted = "";
  async function tintBookPage() {
    const onBook = /^\/book\/show\//.test(location.pathname);
    if (!onBook || !settings.tint || settings.theme === "off") {
      root.removeAttribute("data-grx-cover"); tinted = ""; return;
    }
    const meta = document.querySelector('meta[property="og:image"]');
    const src = meta && meta.content;
    if (!src || src === tinted) return;
    tinted = src;
    try {
      const res = await api.runtime.sendMessage({ type: "grx-colors", urls: [src] });
      const c = res && res[src];
      if (!c) return;
      root.style.setProperty("--grx-cover-1", c[0]);
      root.style.setProperty("--grx-cover-2", c[1]);
      root.setAttribute("data-grx-cover", "");
    } catch (_) {}
  }
  document.addEventListener("DOMContentLoaded", () => { syncThemeClasses(settings.theme); apply(settings); tintBookPage(); });
  // Goodreads swaps pages without reloading in places, so re-check when the address changes.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    apply(settings);
    tinted = "";
    tintBookPage();
    if (globalThis.__grxRouteChanged) globalThis.__grxRouteChanged();
  }, 1000);

  // ---------- "Hide an element" picker ----------
  function selectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== root) {
      let part = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift("#" + CSS.escape(node.id));
      } else {
        const cls = [...node.classList].filter((c) => !/\d/.test(c) && !c.startsWith("grx")).slice(0, 2);
        if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
        const same = [...node.parentNode.children].filter((n) => n.matches(part));
        if (same.length > 1) part += `:nth-child(${[...node.parentNode.children].indexOf(node) + 1})`;
        parts.unshift(part);
      }
      try {
        if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
      } catch (_) {}
      node = node.parentNode;
    }
    return parts.join(" > ");
  }

  function startPicker() {
    if (document.getElementById("grx-pick-hud")) return;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ff4d6d;background:rgba(255,77,109,.18);transition:all .05s";
    const hud = document.createElement("div");
    hud.id = "grx-pick-hud";
    hud.textContent = "Click what you want to hide.  Up arrow: pick the parent.  Esc: cancel.";
    hud.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#17151c;color:#fff;font:14px system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.5)";
    document.body.append(box, hud);
    let target = null;

    const place = () => {
      if (!target) return;
      const r = target.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    };
    const move = (e) => {
      if (e.target === hud || e.target === box) return;
      target = e.target; place();
    };
    const done = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      box.remove(); hud.remove();
    };
    const click = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!target) return done();
      const sel = selectorFor(target);
      done();
      const cur = (await api.storage.local.get(KEY))[KEY] || settings;
      const hidden = [...new Set([...(cur.hidden || []), sel])];
      await api.storage.local.set({ [KEY]: { ...DEFAULTS, ...cur, hidden } });
    };
    const key = (e) => {
      if (e.key === "Escape") done();
      if (e.key === "ArrowUp" && target && target.parentElement && target.parentElement !== document.body) {
        e.preventDefault(); target = target.parentElement; place();
      }
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "grx-pick") startPicker();
  });
})();
