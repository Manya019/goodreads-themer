// Goodreads Glass Theme: interactive My Books catalogue embedded in Goodreads.
// Reads your shelves from Goodreads using your own logged-in session (the same pages you'd
// open by hand), caches them locally, and draws a visual library. Read-only: anything you
// change (ratings, shelves, reviews) is done on the real Goodreads page, which opens themed.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  const KEY = "grx", BOOKS = "grx_books";

  let host = null, shadow = null, mounted = false, docKeyHandler = null, nativeContentRoot = null;
  const hiddenNativeNodes = new Set();
  const S = { books: [], uid: "", fetchedAt: 0, loading: false, error: "", progress: 0, socialFeed: [] };
  const isShelfRoute = () => /^\/review\/list(?:\/|$)/.test(location.pathname);
  const isLandingRoute = () => location.pathname === "/" || location.pathname === "/home";
  const isNativeBrowseRoute = () => /^\/genres?(?:\/|$)|^\/shelf\/show\/|^\/list\/show\//i.test(location.pathname);
  const ui = { q: "", shelf: "all", sort: "added", min: 0, limit: 60, open: null, hero: 0,
    section: isShelfRoute() ? "library" : "catalog", view: "grid", browseView: "blocks" };
  const colors = new Map();

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ck = (u) => (u || "").replace(/\._S[XY]\d+_/, "");
  const bigCover = (u) => (u || "").replace(/\._S[XY]\d+_(?=\.)/, "._SX318_");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  const SHELF_LABEL = { read: "Read", "to-read": "Want to read", "currently-reading": "Reading" };
  const label = (s) => SHELF_LABEL[s] || s;
  const stars = (n) => `${n}/5`;

  // ---------- parsing Goodreads' shelf table ----------
  function parseDate(s) {
    if (!s || /not set/i.test(s)) return 0;
    const t = Date.parse(s.replace(/,/g, ""));
    return Number.isNaN(t) ? 0 : t;
  }

  function parseShelfHTML(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    for (const tr of doc.querySelectorAll("tr.bookalike")) {
      const cell = (c) => tr.querySelector(`td.field.${c} .value`);
      const txt = (c) => (cell(c)?.textContent || "").replace(/\s+/g, " ").trim();
      const a = tr.querySelector("td.field.title a[href*='/book/show/']");
      if (!a) continue;
      const bookId = (a.getAttribute("href").match(/\/book\/show\/(\d+)/) || [])[1];
      const reviewId = (tr.id || "").replace("review_", "");
      const series = a.querySelector("span")?.textContent.trim() || "";
      const title = (a.getAttribute("title") || a.textContent).replace(/\s+/g, " ").trim().replace(series, "").trim() || a.textContent.trim();

      let author = txt("author").replace(/\*/g, "").trim();
      if (author.includes(",")) author = author.split(",").reverse().map((x) => x.trim()).join(" ");

      let rating = 0;
      const rEl = tr.querySelector("td.field.rating [data-rating]");
      if (rEl) rating = parseInt(rEl.getAttribute("data-rating"), 10) || 0;
      else rating = tr.querySelectorAll("td.field.rating .staticStar.p10").length;

      const shelves = [...tr.querySelectorAll("td.field.shelves a.shelfLink")].map((x) => x.textContent.trim());
      const review = txt("review").replace(/\[edit\]/g, "").replace(/\.\.\.more\s*$/, "…").trim();
      out.push({
        id: reviewId || bookId, bookId, title, series, author,
        cover: tr.querySelector("td.field.cover img")?.getAttribute("src") || "",
        avg: parseFloat(txt("avg_rating")) || 0,
        rating,
        pages: parseInt(txt("num_pages").replace(/[^\d]/g, ""), 10) || 0,
        added: parseDate(txt("date_added")),
        read: parseDate(txt("date_read")),
        started: parseDate(txt("date_started")),
        shelves, review,
      });
    }
    return out;
  }

  // ---------- fetching ----------
  const signedOut = (res) => /sign_?in|ap\/signin/i.test(res.url);

  async function findUid(settings) {
    if (settings.userId) return String(settings.userId).replace(/\D.*/, "");
    for (const a of document.querySelectorAll("header a[href], nav a[href], .siteHeader a[href], [class*='Header'] a[href]")) {
      const m = (a.getAttribute("href") || "").match(/\/(?:review\/list|user\/show)\/(\d+)/);
      if (m) return m[1];
    }
    try {
      const r = await fetch("/review/list?ref=nav_mybooks", { credentials: "include" });
      if (signedOut(r)) { const e = new Error("signed-out"); e.code = "signed-out"; throw e; }
      const m = r.url.match(/\/review\/list\/(\d+)/);
      if (m) return m[1];
    } catch (e) { if (e.code) throw e; }
    return "";
  }

  async function fetchAll(uid) {
    let all = [];
    const seen = new Set();
    for (let page = 1; page <= 40; page++) {
      const url = `/review/list/${uid}?shelf=%23ALL%23&per_page=100&page=${page}&view=table&sort=date_added&order=d`;
      const res = await fetch(url, { credentials: "include" });
      if (signedOut(res)) { const e = new Error("signed-out"); e.code = "signed-out"; throw e; }
      if (!res.ok) throw new Error("Goodreads answered with HTTP " + res.status);
      const rows = parseShelfHTML(await res.text()).filter((b) => !seen.has(b.id));
      if (!rows.length) break;
      rows.forEach((b) => seen.add(b.id));
      all = all.concat(rows);
      S.progress = all.length; renderStatus();
      if (rows.length < 100) break;
      await sleep(400);
    }
    return all;
  }

  async function refresh() {
    if (S.loading) return;
    S.loading = true; S.error = ""; S.progress = 0; renderStatus();
    try {
      const settings = (await api.storage.local.get(KEY))[KEY] || {};
      // Resolve the currently signed-in account on refresh instead of trusting a
      // cached user ID, which could belong to a previous browser session.
      const uid = settings.userId ? String(settings.userId).replace(/\D/g, "") : await findUid(settings);
      if (!uid) throw Object.assign(new Error("no-uid"), { code: "no-uid" });
      const books = await fetchAll(uid);
      if (!books.length) throw Object.assign(new Error("empty"), { code: "empty" });
      S.books = books; S.uid = uid; S.fetchedAt = Date.now();
      await api.storage.local.set({ [BOOKS]: { books, uid, fetchedAt: S.fetchedAt } });
    } catch (e) {
      S.error = e.code || e.message || "unknown";
    }
    S.loading = false;
    renderAll();
  }

  // ---------- cover colors (computed by the background worker) ----------
  const pending = new Set();
  let flushTimer = null;
  function wantColor(src) {
    if (!src || colors.has(ck(src))) return;
    pending.add(src);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 60);
  }
  async function flush() {
    const urls = [...pending].slice(0, 24);
    urls.forEach((u) => pending.delete(u));
    try {
      const res = await api.runtime.sendMessage({ type: "grx-colors", urls });
      for (const [u, c] of Object.entries(res || {})) { colors.set(ck(u), c); paint(ck(u)); }
    } catch (_) {}
    if (pending.size) flushTimer = setTimeout(flush, 60);
  }
  function paint(key) {
    const c = colors.get(key);
    if (!c || !shadow || root.getAttribute("data-grx-tint") === "off") return;
    shadow.querySelectorAll("[data-ck]").forEach((el) => {
      if (el.dataset.ck !== key) return;
      el.style.setProperty("--tint", c[0]);
      el.style.setProperty("--tint2", c[1]);
      el.classList.add("tinted");
    });
  }
  let io = null;
  function observeCards() {
    if (!shadow) return;
    if (root.getAttribute("data-grx-tint") === "off") {
      shadow.querySelectorAll("[data-ck]").forEach((el) => { el.style.removeProperty("--tint"); el.style.removeProperty("--tint2"); el.classList.remove("tinted"); });
      return;
    }
    if (!io) io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) { wantColor(e.target.dataset.src); io.unobserve(e.target); }
    }, { rootMargin: "400px" });
    shadow.querySelectorAll("[data-ck]").forEach((el) => {
      if (colors.has(el.dataset.ck)) paint(el.dataset.ck); else io.observe(el);
    });
  }

  // ---------- derived data ----------
  const onShelf = (b, s) => b.shelves.includes(s);
  function sortBooks(list, how) {
    const l = [...list];
    const by = {
      added: null,
      read: (a, b) => b.read - a.read,
      rating: (a, b) => b.rating - a.rating || b.avg - a.avg,
      avg: (a, b) => b.avg - a.avg,
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => a.author.localeCompare(b.author),
    }[how];
    return by ? l.sort(by) : l;
  }
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    let l = S.books.filter((b) => (ui.shelf === "all" || onShelf(b, ui.shelf)) && b.rating >= ui.min);
    if (q) l = l.filter((b) => `${b.title} ${b.series} ${b.author} ${b.shelves.join(" ")}`.toLowerCase().includes(q));
    return sortBooks(l, ui.sort);
  }
  function shelfChips() {
    const counts = {};
    S.books.forEach((b) => b.shelves.forEach((s) => (counts[s] = (counts[s] || 0) + 1)));
    const core = ["currently-reading", "to-read", "read"].filter((s) => counts[s]);
    const custom = Object.keys(counts).filter((s) => !SHELF_LABEL[s]).sort((a, b) => counts[b] - counts[a]).slice(0, 8);
    return [["all", "All", S.books.length], ...[...core, ...custom].map((s) => [s, label(s), counts[s]])];
  }

  // ---------- templates ----------
  const card = (b, cls = "") => `
    <a class="card ${cls}" href="/book/show/${esc(b.bookId)}" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}" aria-label="Open book page for ${esc(b.title)} by ${esc(b.author)}">
      <img loading="lazy" src="${esc(bigCover(b.cover))}" alt="Cover of ${esc(b.title)}">
      <span class="shade"></span>
      <span class="meta"><b>${esc(b.title)}</b><i>${esc(b.author)}</i></span>
      ${b.rating ? `<span class="rate" aria-label="${b.rating} stars">${"★".repeat(b.rating)}</span>` : ""}
    </a>`;

  const shelfBadges = (b) => b.shelves.slice(0, 3).map((s) =>
    `<button class="shelf-tag ${ui.shelf === s ? "selected" : ""}" data-shelf="${esc(s)}" title="Filter by ${esc(label(s))}">${esc(label(s))}</button>`).join("") || `<span class="shelf-tag muted-tag">Unsorted</span>`;

  // Catalogue blocks keep the title, author, shelf, and rating visible rather than
  // hiding all useful context behind hover-only cover tiles.
  const catalogueCard = (b) => `
    <article class="book-block" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}">
      <a class="book-cover" href="/book/show/${esc(b.bookId)}" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}" aria-label="Open book page for ${esc(b.title)}">
        <img loading="lazy" src="${esc(bigCover(b.cover))}" alt="Cover of ${esc(b.title)}">
        <span class="cover-wash"></span>
        ${b.rating ? `<span class="cover-rating" aria-label="Your rating: ${b.rating} out of 5">${b.rating}/5</span>` : ""}
      </a>
      <div class="book-copy">
        <a class="book-title" href="/book/show/${esc(b.bookId)}">${esc(b.title)}</a>
        ${b.series ? `<p class="book-series">${esc(b.series.replace(/[()]/g, ""))}</p>` : ""}
        <p class="book-author">${esc(b.author)}</p>
        <div class="book-tags">${shelfBadges(b)}</div>
        <div class="book-facts"><span>${b.pages ? `${b.pages} pages` : "Page count unknown"}</span><span>${b.avg ? `${b.avg.toFixed(2)} ★ on Goodreads` : "Not rated by readers"}</span></div>
        <div class="book-actions"><a href="/book/show/${esc(b.bookId)}">View book</a><a href="/review/edit/${esc(b.id)}">Edit rating or review</a></div>
      </div>
    </article>`;

  const row = (title, books) => !books.length ? "" : `
    <section class="row">
      <div class="row-head"><h2>${esc(title)}</h2><span class="count">${books.length}</span>
        <span class="arrows"><button data-dir="-1" aria-label="Scroll left">‹</button><button data-dir="1" aria-label="Scroll right">›</button></span></div>
      <div class="track">${books.slice(0, 40).map((b) => card(b)).join("")}</div>
    </section>`;

  function heroHTML() {
    const cur = S.books.filter((b) => onShelf(b, "currently-reading"));
    let list = cur, tag = "Currently reading";
    if (!cur.length) { list = sortBooks(S.books.filter((b) => onShelf(b, "read") && b.read), "read"); tag = "Last finished"; }
    if (!list.length) list = S.books.slice(0, 1), tag = "Latest addition";
    if (!list.length) return "";
    const b = list[ui.hero % list.length];
    const facts = [
      b.avg ? `${b.avg.toFixed(2)} average` : "",
      b.pages ? `${b.pages} pages` : "",
      b.started ? `Started ${fmtDate(b.started)}` : (b.read ? `Finished ${fmtDate(b.read)}` : ""),
    ].filter(Boolean);
    return `
      <div class="hero-bg" style="background-image:url('${esc(bigCover(b.cover))}')"></div>
      <div class="in wrap">
        <div class="hero-text">
          <p class="tag">${tag}${list.length > 1 ? ` <span class="dots">${list.map((_, i) => `<button data-hero="${i}" class="${i === ui.hero % list.length ? "on" : ""}" aria-label="Book ${i + 1}"></button>`).join("")}</span>` : ""}</p>
          <h1>${esc(b.title)}</h1>
          ${b.series ? `<p class="series">${esc(b.series.replace(/[()]/g, ""))}</p>` : ""}
          <p class="by">${esc(b.author)}</p>
          <p class="facts">${facts.map(esc).join("<span class='sep'></span>")}</p>
          <p class="cta"><a class="btn" href="/book/show/${esc(b.bookId)}">View book</a></p>
        </div>
        <a class="hero-cover card" href="/book/show/${esc(b.bookId)}" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}" aria-label="Open book page for ${esc(b.title)}">
          <img src="${esc(bigCover(b.cover))}" alt=""></a>
      </div>`;
  }

  function statsHTML() {
    const read = S.books.filter((b) => onShelf(b, "read"));
    const y0 = new Date(new Date().getFullYear(), 0, 1).getTime();
    const thisYear = read.filter((b) => b.read >= y0).length;
    const rated = S.books.filter((b) => b.rating);
    const avg = rated.length ? (rated.reduce((a, b) => a + b.rating, 0) / rated.length).toFixed(2) : "";
    const pages = read.reduce((a, b) => a + b.pages, 0);
    const items = [
      [read.length, "books read"],
      thisYear ? [thisYear, `read in ${new Date().getFullYear()}`] : null,
      avg ? [avg, "your average rating"] : null,
      pages ? [pages.toLocaleString(), "pages read"] : null,
      [S.books.filter((b) => onShelf(b, "to-read")).length, "waiting on the shelf"],
    ].filter(Boolean);
    return `<div class="wrap stats">${items.map(([n, l]) => `<div><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
  }

  function rowsHTML() {
    const b = S.books;
    const next = b.filter((x) => onShelf(x, "to-read"));
    const done = sortBooks(b.filter((x) => onShelf(x, "read") && x.read), "read");
    const loved = sortBooks(b.filter((x) => x.rating === 5), "read");
    return row("Up next", next) + row("Recently finished", done) + row("Five stars", loved);
  }

  function navHTML() {
    const active = isShelfRoute() ? "library" : ui.section;
    return `
      <div class="reader-nav-wrap"><nav class="reader-nav" aria-label="Reading views">
        <button class="reader-nav-button ${active === "catalog" ? "active" : ""}" data-section="catalog" aria-current="${active === "catalog" ? "page" : "false"}">Catalogue</button>
        <button class="reader-nav-button ${active === "feed" ? "active" : ""}" data-section="feed" aria-current="${active === "feed" ? "page" : "false"}">Reading feed</button>
        <a class="reader-nav-link ${active === "library" ? "active" : ""}" href="/review/list">My Books</a>
        <button class="reader-nav-sync" data-refresh type="button">Sync</button>
      </nav></div>`;
  }

  function catalogueHomeHTML() {
    return `<section class="home-catalogue">
      <section class="hero">${heroHTML()}</section>
      ${statsHTML()}
      <div class="wrap home-rows">${rowsHTML()}</div>
      ${allHTML()}
    </section>`;
  }

  function allHTML() {
    const list = filtered();
    const chips = shelfChips().map(([id, name, n]) =>
      `<button class="chip ${ui.shelf === id ? "on" : ""}" data-shelf="${esc(id)}">${esc(name)} <small>${n}</small></button>`).join("");
    const sortOptions = [["added", "Recently added"], ["read", "Date finished"], ["rating", "Your rating"], ["avg", "Reader rating"], ["title", "Title A to Z"], ["author", "Author"]]
      .map(([v, n]) => `<option value="${v}" ${ui.sort === v ? "selected" : ""}>${n}</option>`).join("");
    const ratingOptions = [[0, "Any rating"], [3, "3+ stars"], [4, "4+ stars"], [5, "5 stars"]]
      .map(([v, n]) => `<option value="${v}" ${ui.min === v ? "selected" : ""}>${n}</option>`).join("");
    const tableRows = list.slice(0, ui.limit).map((b) => `
      <tr class="book-row">
        <td><div class="table-book"><a class="table-cover" href="/book/show/${esc(b.bookId)}" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}"><img loading="lazy" src="${esc(bigCover(b.cover))}" alt="Cover of ${esc(b.title)}"></a>
          <div><a class="table-title" href="/book/show/${esc(b.bookId)}">${esc(b.title)}</a>${b.series ? `<span class="table-series">${esc(b.series.replace(/[()]/g, ""))}</span>` : ""}<span class="table-sub">${esc(b.author)}</span></div></div></td>
        <td><div class="book-tags">${shelfBadges(b)}</div></td>
        <td><span class="table-rating ${b.rating ? "rated" : ""}">${b.rating ? `${"★".repeat(b.rating)}<small>${b.rating}/5</small>` : "Not rated"}</span></td>
        <td>${b.avg ? b.avg.toFixed(2) : '<span class="muted">n/a</span>'}</td>
        <td>${b.pages || '<span class="muted">n/a</span>'}</td>
        <td>${fmtDate(b.read || b.added) || '<span class="muted">Not set</span>'}</td>
        <td><div class="table-actions"><a href="/book/show/${esc(b.bookId)}" title="Open book page">Open</a><a href="/review/edit/${esc(b.id)}" title="Edit on Goodreads">Edit</a></div></td>
      </tr>`).join("");

    return `
      <div class="wrap library-wrap">
        <div class="library-heading">
          <div><p class="eyebrow">${ui.section === "catalog" ? "YOUR READING CATALOGUE" : "YOUR SHELVES"}</p><h1>${ui.q ? "Search results" : ui.section === "catalog" ? "Browse your catalogue" : "My Books"}</h1><p class="section-note">Your books, organised in one place. Shelf and review changes remain on Goodreads.</p></div>
          <div class="library-count"><strong>${list.length.toLocaleString()}</strong><span>${list.length === 1 ? "book" : "books"} shown</span></div>
        </div>
        <div class="catalogue-panel glass-panel">
          <div class="toolbar">
            <div class="toolbar-search"><label for="q">Search your books</label><div class="search-controls"><input id="q" type="search" value="${esc(ui.q)}" placeholder="Title, author, series, or shelf" autocomplete="off"><button class="sync-button" type="button" data-refresh>Sync shelves</button></div></div>
            <div class="chips">${chips}</div>
            <div class="ctl">
              <label>Sort <select data-sort aria-label="Sort books">${sortOptions}</select></label>
              <label>Rating <select data-min aria-label="Minimum rating">${ratingOptions}</select></label>
              <div class="view-switch" role="group" aria-label="Catalogue layout">
                <button data-view="grid" class="${ui.view === "grid" ? "on" : ""}" aria-pressed="${ui.view === "grid"}">Blocks</button>
                <button data-view="table" class="${ui.view === "table" ? "on" : ""}" aria-pressed="${ui.view === "table"}">Table</button>
              </div>
            </div>
          </div>
          ${list.length ? (ui.view === "table" ? `
            <div class="table-wrap"><table class="book-table"><thead><tr><th>Book</th><th>Shelves</th><th>Your rating</th><th>Reader avg.</th><th>Pages</th><th>Date</th><th>Actions</th></tr></thead><tbody>${tableRows}</tbody></table></div>` :
            `<div class="catalogue-grid">${list.slice(0, ui.limit).map(catalogueCard).join("")}</div>`) : S.loading ?
            `<div class="empty-state loading-state"><span class="loading-rule"></span><h2>Loading your shelves</h2><p>Fetching your books from Goodreads.</p></div>` :
            `<div class="empty-state"><span class="empty-mark" aria-hidden="true">—</span><h2>Nothing on this shelf yet</h2><p>Try another shelf, lower the rating filter, or clear your search.</p><button class="btn ghost" data-shelf="all">Show all books</button></div>`}
          ${list.length > ui.limit ? `<p class="more"><button class="btn ghost" data-more>Show more books <span>(${list.length - ui.limit} remaining)</span></button></p>` : ""}
        </div>
      </div>`;
  }

  function collectNativeFeed() {
    // Try to reuse Goodreads' own home activity feed when the underlying page has it.
    // Content is reduced to text and ordinary links, never cloned as raw HTML.
    if (location.pathname !== "/") return [];
    const selectors = ["article", "[class*='update' i]", "[class*='activity' i]", "[class*='feed' i]", "#updates", ".updates"];
    const nodes = [...new Set(selectors.flatMap((sel) => [...document.querySelectorAll(sel)]))]
      .filter((el) => el.id !== "grx-host" && !el.closest("#grx-host"));
    const candidates = [];
    for (const el of nodes) {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length < 45 || text.length > 900) continue;
      const links = [...el.querySelectorAll("a[href]")];
      const rel = links.find((a) => /\/(?:user\/show|review\/show|book\/show|updates?)(?:\/|\?|$)/i.test(a.getAttribute("href") || ""));
      if (!rel) continue;
      const href = rel.href;
      if (!href || !href.startsWith(location.origin)) continue;
      const img = el.querySelector("img[src]");
      candidates.push({ text, href, linkText: (rel.textContent || "").trim(), image: img?.src || "" });
    }
    const seen = new Set();
    return candidates.sort((a, b) => a.text.length - b.text.length).filter((x) => {
      const key = x.text.slice(0, 140);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 16);
  }

  function activityEvents() {
    const events = [];
    for (const b of S.books) {
      if (b.read) events.push({ time: b.read, type: "finished", phrase: "Finished reading", b });
      else if (b.started) events.push({ time: b.started, type: "started", phrase: "Started reading", b });
      if (b.added) events.push({ time: b.added, type: "added", phrase: b.shelves.includes("to-read") ? "Added to Want to Read" : "Added to the library", b });
    }
    return events.sort((a, b) => b.time - a.time).slice(0, 24);
  }

  function feedHTML() {
    const realFeed = S.socialFeed.length > 0;
    const events = activityEvents();
    const reels = realFeed ? S.socialFeed.map((item, i) => `
      <a class="reel-card social-reel" href="${esc(item.href)}" aria-label="Open Goodreads community update ${i + 1}">
        ${item.image ? `<img loading="lazy" src="${esc(item.image)}" alt="">` : `<span class="reel-art"></span>`}
        <span class="reel-shade"></span><span class="reel-content"><small>GOODREADS COMMUNITY</small><b>${esc(item.linkText || "Community update")}</b><span>${esc(item.text)}</span><em>Open update</em></span>
      </a>`).join("") : events.slice(0, 16).map((event) => {
        const b = event.b;
        return `<a class="reel-card" href="/book/show/${esc(b.bookId)}" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}">
          <img loading="lazy" src="${esc(bigCover(b.cover))}" alt="Cover of ${esc(b.title)}"><span class="reel-shade"></span>
          <span class="reel-content"><small>${esc(fmtDate(event.time))} · YOUR READING JOURNAL</small><b>${esc(b.title)}</b><span>${esc(event.phrase)}${b.author ? ` by ${esc(b.author)}` : ""}</span><em>View book</em></span>
        </a>`;
      }).join("");

    const timeline = realFeed ? S.socialFeed.slice(0, 12).map((item) => `
      <article class="activity-item social-item">
        ${item.image ? `<img class="activity-thumb" loading="lazy" src="${esc(item.image)}" alt="">` : `<div class="activity-placeholder"></div>`}
        <div class="activity-content"><span class="activity-kind">GOODREADS COMMUNITY</span><p>${esc(item.text)}</p><a class="activity-link" href="${esc(item.href)}">Open update</a></div>
      </article>`).join("") : events.slice(0, 12).map((event) => {
        const b = event.b;
        return `<article class="activity-item" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}">
          <a class="activity-cover" href="/book/show/${esc(b.bookId)}"><img loading="lazy" src="${esc(bigCover(b.cover))}" alt="Cover of ${esc(b.title)}"></a>
          <div class="activity-content"><span class="activity-kind">${esc(fmtDate(event.time))} · YOUR READING JOURNAL</span><p>${esc(event.phrase)} <a class="inline-book" href="/book/show/${esc(b.bookId)}">${esc(b.title)}</a></p><span class="activity-author">${esc(b.author)}${b.rating ? ` · rated ${b.rating}/5` : ""}</span><div class="activity-actions"><a href="/book/show/${esc(b.bookId)}">View book</a><a href="/review/edit/${esc(b.id)}">Edit review</a></div></div>
        </article>`;
      }).join("");

    return `
      <section class="feed-area wrap">
        <div class="feed-intro"><div><p class="eyebrow">THE READING COMMONS</p><h2>${realFeed ? "From the Goodreads community" : "Your reading journal"}</h2><p>${realFeed ? "A visual stream of updates already available on your Goodreads home page." : "A visual timeline of finishes, starts, and additions from your Goodreads shelves."}</p></div><button class="text-action" data-refresh type="button">Sync activity</button></div>
        <section class="reel-section" aria-label="Horizontal reading and community feed">
          <div class="reel-head"><div><h3>${realFeed ? "Selected community updates" : "Recent reading moments"}</h3><p>${realFeed ? "Browse horizontally, then open the original Goodreads update." : "Book covers and activity pulled from your own synced shelves."}</p></div><div class="arrows"><button type="button" data-dir="-1" aria-label="Scroll feed left">‹</button><button type="button" data-dir="1" aria-label="Scroll feed right">›</button></div></div>
          <div class="reel-track" aria-label="Scrollable feed cards">${reels || `<div class="empty-state"><h2>No updates yet</h2><p>Reload this page after your Goodreads activity feed is available.</p></div>`}</div>
        </section>
        <div class="feed-layout"><div class="feed-stream" aria-label="Reading activity timeline"><div class="timeline-heading"><h3>Recent activity</h3><span>${timeline ? (realFeed ? S.socialFeed.length : events.length) : 0} updates</span></div>${timeline || `<div class="empty-state"><h2>Your shelves are quiet for now</h2><p>Once Goodreads returns your books, recent reading activity will appear here.</p></div>`}</div>
          <aside class="feed-aside glass-panel"><p class="eyebrow">READING AT A GLANCE</p><h3>Every book leaves a trace.</h3><p>Your reading history stays connected to your Goodreads account.</p><div class="aside-stat"><strong>${S.books.filter((b) => onShelf(b, "currently-reading")).length}</strong><span>currently reading</span></div><div class="aside-stat"><strong>${S.books.filter((b) => onShelf(b, "to-read")).length}</strong><span>on the waiting shelf</span></div><a class="btn" href="/review/list">Open My Books</a></aside>
        </div>
      </section>`;
  }

  function drawerHTML() {
    const b = S.books.find((x) => String(x.id) === String(ui.open));
    if (!b) return "";
    return `
      <button class="drawer-close" data-close aria-label="Close book details">×</button>
      <p class="eyebrow drawer-eyebrow">BOOK DETAILS</p>
      <div class="d-cover card" data-ck="${esc(ck(b.cover))}" data-src="${esc(b.cover)}"><img src="${esc(bigCover(b.cover))}" alt="Cover of ${esc(b.title)}"></div>
      <h2>${esc(b.title)}</h2>
      ${b.series ? `<p class="series">${esc(b.series.replace(/[()]/g, ""))}</p>` : ""}
      <p class="by">${esc(b.author)}</p>
      <dl>
        ${b.rating ? `<dt>Your rating</dt><dd class="gold">${stars(b.rating)}</dd>` : `<dt>Your rating</dt><dd>Not rated</dd>`}
        ${b.avg ? `<dt>Goodreads average</dt><dd>${b.avg.toFixed(2)}</dd>` : ""}
        ${b.pages ? `<dt>Pages</dt><dd>${b.pages}</dd>` : ""}
        ${b.started ? `<dt>Started</dt><dd>${fmtDate(b.started)}</dd>` : ""}
        ${b.read ? `<dt>Finished</dt><dd>${fmtDate(b.read)}</dd>` : ""}
        ${b.added ? `<dt>Added</dt><dd>${fmtDate(b.added)}</dd>` : ""}
      </dl>
      <div class="drawer-shelves"><span class="drawer-label">On your shelves</span><p class="chips">${b.shelves.map((s) => `<button class="chip" data-shelf-go="${esc(s)}">${esc(label(s))}</button>`).join("") || `<span class="muted">No shelves detected</span>`}</p></div>
      ${b.review ? `<div class="review-snippet"><span class="drawer-label">Your review</span><blockquote>${esc(b.review.slice(0, 600))}</blockquote></div>` : ""}
      <div class="cta drawer-actions"><a class="btn" href="/book/show/${esc(b.bookId)}">View book page</a>
        <a class="btn ghost" href="/review/edit/${esc(b.id)}">Edit rating or review <span>↗</span></a></div>
      <p class="native-note">Reading changes sync through your Goodreads account. Editing opens Goodreads' own form.</p>`;
  }

  function statusHTML() {
    if (S.loading) return `<span class="spin"></span> Reading your shelves${S.progress ? ` (${S.progress} books so far)` : ""}…`;
    const msg = {
      "signed-out": `You're not signed in. <a href="/user/sign_in">Sign in to Goodreads</a>, then come back.`,
      "no-uid": `Couldn't tell which account is yours. Add your Goodreads user number in the extension popup (it's the number in your profile address).`,
      empty: `Goodreads returned no books. If your library is private or empty, this page has nothing to show. You can add your user number in the extension popup.`,
    }[S.error];
    if (S.error) return `<span class="err">${msg || "Couldn't load your library: " + esc(S.error)}</span> <a href="/?grx=off">Open the original home page</a>`;
    if (S.fetchedAt) return `${S.books.length} books · from Goodreads user ${esc(S.uid)} · updated ${new Date(S.fetchedAt).toLocaleString()}`;
    return "";
  }

  // ---------- rendering ----------
  const $ = (sel) => shadow.querySelector(sel);
  function renderStatus() {
    const el = $("#status"); if (el) el.innerHTML = S.books.length || S.loading ? statusHTML() : "";
    const big = $("#loading");
    if (big) big.innerHTML = S.books.length ? "" : `<p class="bigstatus">${statusHTML()}</p>`;
  }

  function renderMain() {
    const all = $("#all");
    if (!all) return;
    all.hidden = false;
    all.innerHTML = ui.section === "feed" ? feedHTML() : (ui.section === "catalog" ? catalogueHomeHTML() : allHTML());
    const nav = $(".reader-nav");
    if (nav) {
      nav.querySelectorAll("[data-section]").forEach((el) => {
        const active = el.dataset.section === ui.section;
        el.classList.toggle("active", active);
        el.setAttribute("aria-current", active ? "page" : "false");
      });
      nav.querySelectorAll(".reader-nav-link").forEach((el) => el.classList.toggle("active", isShelfRoute() && ui.section === "library"));
    }
    renderStatus();
    observeCards();
  }
  function renderAll() { renderMain(); renderDrawer(); }
  function renderAllOnly() { renderMain(); }
  function renderDrawer() {
    const d = $("#drawer");
    const current = S.books.find((b) => String(b.id) === String(ui.open));
    if (current) { d.dataset.ck = ck(current.cover); d.dataset.src = current.cover || ""; }
    else { delete d.dataset.ck; delete d.dataset.src; }
    d.innerHTML = drawerHTML();
    shadow.host.toggleAttribute("data-drawer", !!ui.open);
    d.classList.toggle("open", !!ui.open);
    $("#scrim").classList.toggle("open", !!ui.open);
    observeCards();
  }

  // ---------- shell ----------
  function mount() {
    if (mounted || !document.body) return;
    mounted = true;
    // Capture the existing Goodreads activity before the native center column is hidden.
    if (isLandingRoute() && !S.socialFeed.length) S.socialFeed = collectNativeFeed();
    host = document.createElement("div");
    host.id = "grx-host";
    // Goodreads keeps its own global header and navigation. Mount only inside
    // the main content column so the shelf catalogue replaces the old list area.
    const target = document.querySelector("#mainContentContainer .mainContent")
      || document.querySelector(".mainContentContainer .mainContent")
      || document.querySelector("#pageContent .mainContent")
      || document.querySelector(".mainContent")
      || document.querySelector("#mainContent")
      || document.querySelector("main")
      || document.body;
    nativeContentRoot = target;
    target.prepend(host);
    if (target !== document.body) {
      [...target.children].forEach((child) => {
        if (child === host || child.id === "grx-host") return;
        child.classList.add("grx-native-content-hidden");
        hiddenNativeNodes.add(child);
      });
    }
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="app embedded-catalogue">
        ${navHTML()}
        <main><section id="all" class="all"></section><div id="loading" class="wrap"></div></main>
        <footer class="foot wrap"><span id="status"></span><span class="foot-note">Your Goodreads account remains the source of truth.</span></footer>
        <div id="scrim" class="scrim" data-close></div>
        <aside id="drawer" class="drawer" role="dialog" aria-label="Book details" aria-modal="true"></aside>
      </div>`;
    shadow.host.setAttribute("data-theme", root.getAttribute("data-grx-theme") || "off");
    wire();
    // Show the cached library immediately, then refresh in the background.
    api.storage.local.get([BOOKS, KEY, "grx_view"]).then((r) => {
      ui.view = r.grx_view === "table" ? "table" : "grid";
      const c = r[BOOKS];
      if (c && c.books) { S.books = c.books; S.uid = c.uid; S.fetchedAt = c.fetchedAt; }
      if (r[KEY] && r[KEY].userId) S.uid = String(r[KEY].userId).replace(/\D.*/, "");
      renderAll();
      const stale = !c || Date.now() - (c.fetchedAt || 0) > 10 * 60 * 1000;
      if (stale) refresh();
    });
  }

  function unmount() {
    if (docKeyHandler) document.removeEventListener("keydown", docKeyHandler);
    docKeyHandler = null;
    if (io) { io.disconnect(); io = null; }
    hiddenNativeNodes.forEach((node) => node.classList.remove("grx-native-content-hidden"));
    hiddenNativeNodes.clear();
    nativeContentRoot = null;
    if (host) host.remove();
    host = shadow = null; mounted = false;
  }

  function wire() {
    shadow.addEventListener("click", (e) => {
      const t = e.target.closest("[data-section],[data-view],[data-open],[data-dir],[data-shelf],[data-shelf-go],[data-more],[data-refresh],[data-close],[data-hero]");
      if (!t) return;
      if (t.dataset.section) {
        ui.section = t.dataset.section;
        ui.q = ""; ui.shelf = "all"; ui.limit = 60; ui.open = null;
        renderDrawer(); renderMain();
        const search = $("#q"); if (search) search.value = "";
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      else if (t.dataset.view) { ui.view = t.dataset.view === "table" ? "table" : "grid"; api.storage.local.set({ grx_view: ui.view }); renderAllOnly(); }
      else if (t.dataset.open) {
        e.preventDefault();
        const book = S.books.find((b) => String(b.id) === String(t.dataset.open));
        if (book && book.bookId) location.href = `/book/show/${encodeURIComponent(book.bookId)}`;
      }
      else if (t.dataset.dir) {
        const section = t.closest(".reel-section");
        const tr = section ? section.querySelector(".reel-track") : t.closest(".row")?.querySelector(".track");
        if (tr) tr.scrollBy({ left: tr.clientWidth * 0.8 * +t.dataset.dir, behavior: "smooth" });
      }
      else if (t.dataset.shelf) { ui.shelf = t.dataset.shelf; ui.limit = 60; ui.section = isLandingRoute() ? "catalog" : "library"; renderMain(); }
      else if (t.hasAttribute("data-shelf-go")) { ui.shelf = t.dataset.shelfGo; ui.limit = 60; ui.section = "library"; ui.open = null; renderDrawer(); renderMain(); $("#all").scrollIntoView({ behavior: "smooth" }); }
      else if (t.hasAttribute("data-more")) { ui.limit += 60; renderAllOnly(); }
      else if (t.hasAttribute("data-refresh")) { refresh(); }
      else if (t.hasAttribute("data-close")) { ui.open = null; renderDrawer(); }
      else if (t.dataset.hero !== undefined) { ui.hero = +t.dataset.hero; renderMain(); }
    });
    shadow.addEventListener("change", (e) => {
      if (e.target.matches("[data-sort]")) { ui.sort = e.target.value; renderAllOnly(); }
      if (e.target.matches("[data-min]")) { ui.min = +e.target.value; renderAllOnly(); }
    });
    shadow.addEventListener("input", (e) => {
      if (!e.target.matches("#q")) return;
      ui.q = e.target.value;
      ui.limit = 60;
      const cursor = e.target.selectionStart;
      renderMain();
      const next = $("#q");
      if (next) { next.focus(); try { next.setSelectionRange(cursor, cursor); } catch (_) {} }
    });
    docKeyHandler = (e) => { if (e.key === "Escape" && ui.open && mounted) { ui.open = null; renderDrawer(); } };
    document.addEventListener("keydown", docKeyHandler);
  }

  // ---------- styles (isolated from Goodreads' CSS; colors come from the active theme) ----------
  const CSS = `
  :host { all: initial; display: block; width: 100%; min-width: 0;
    --bg: var(--grx-bg, #16141a); --bg2: var(--grx-bg2, #1e1b24); --bg3: var(--grx-bg3, #28242f);
    --fg: var(--grx-fg, #eae6ef); --muted: var(--grx-muted, #a39dad); --line: var(--grx-border, #37323f);
    --accent: var(--grx-accent, #d9b25f); --accent-fg: var(--grx-accent-fg, #1a1030);
    --head: var(--grx-head, Georgia, "Times New Roman", serif); --body: var(--grx-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif);
    --r: var(--grx-radius, 8px); --cr: var(--grx-card-radius, var(--r));
    --cshadow: var(--grx-cover-shadow, 0 8px 22px rgba(0,0,0,.45));
    color: var(--fg); font: 16px/1.5 var(--body); }
  *, *::before, *::after { box-sizing: border-box; }
  a { color: var(--accent); }
  button { font: inherit; color: inherit; cursor: pointer; }
  [hidden] { display: none !important; }
  .app { min-height: auto; width: 100%; background-color: transparent; background-image: none;
    background-size: var(--grx-bg-size, auto); background-attachment: fixed; }
  .wrap { width: min(1240px, 100% - 48px); margin-inline: auto; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--grx-header-bg, var(--bg)) 78%, transparent);
    backdrop-filter: blur(24px) saturate(140%); -webkit-backdrop-filter: blur(24px) saturate(140%); border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); box-shadow: 0 8px 30px rgba(0,0,0,.08); }
  .bar { display: flex; align-items: center; gap: 20px; padding: 10px 0; flex-wrap: wrap; }
  .brand { display: grid; grid-template-columns: 25px auto; grid-template-rows: 1fr 1fr; align-items: center; column-gap: 7px; font: 600 23px/1 var(--head); color: var(--grx-header-fg, var(--fg)); text-decoration: none; margin-right: 3px; white-space: nowrap; }
  .brand-mark { grid-row: 1 / span 2; display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 50%; color: var(--accent); font-size: 15px; }
  .brand small { margin-top: 4px; color: var(--muted); font: 500 8px/1 var(--body); letter-spacing: .12em; text-transform: uppercase; }
  nav { display: flex; align-items: center; gap: 5px; }
  .nav-link { display: inline-flex; align-items: center; justify-content: center; padding: 9px 10px; border: 1px solid transparent; border-radius: 999px; background: none; color: var(--grx-header-fg, var(--fg)); text-decoration: none; opacity: .8; font: 500 12px/1.2 var(--body); white-space: nowrap; }
  .nav-link:hover, .nav-link.active { opacity: 1; color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); border-color: color-mix(in srgb, var(--accent) 25%, transparent); }
  .search { flex: 1; min-width: 190px; position: relative; display: flex; align-items: center; gap: 9px; padding: 0 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--line) 85%, transparent); background: color-mix(in srgb, var(--bg3) 65%, transparent); color: var(--muted); }
  #q { flex: 1; min-width: 0; max-width: 460px; padding: 9px 0; border: 0; outline: none; background: transparent; color: var(--fg); font: 12px var(--body); }
  #q:focus { outline: none; }
  #web { font-size: 11px; white-space: nowrap; }
  .acts { display: flex; gap: 10px; align-items: center; }
  .acts a { color: var(--grx-header-fg, var(--fg)); text-decoration: none; opacity: .75; font-size: 11px; white-space: nowrap; }
  .acts button { background: color-mix(in srgb, var(--bg2) 65%, transparent); border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px;
    color: var(--grx-header-fg, var(--fg)); font-size: 11px; backdrop-filter: blur(12px); }
  .acts button:hover { border-color: var(--accent); color: var(--accent); }

  /* hero */
  .hero { position: relative; overflow: hidden; --tint: var(--bg3); }
  .hero-bg { position: absolute; inset: -80px; background-size: cover; background-position: center;
    filter: blur(52px) saturate(1.35); opacity: .6; transform: scale(1.1); }
  .hero::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(180deg, color-mix(in srgb, var(--tint) 22%, transparent) 0%, transparent 35%, var(--bg) 98%); }
  .hero .in { position: relative; z-index: 1; display: grid; grid-template-columns: 1fr minmax(180px, 250px); gap: 48px;
    align-items: center; padding: 64px 0 72px; min-height: 440px; }
  .hero .tag { margin: 0 0 14px; color: var(--accent); font-size: 15px; letter-spacing: .02em; display: flex; align-items: center; gap: 12px; }
  .dots { display: inline-flex; gap: 6px; }
  .dots button { width: 9px; height: 9px; padding: 0; border-radius: 50%; border: 1px solid var(--accent); background: none; }
  .dots button.on { background: var(--accent); }
  .hero h1 { margin: 0; font: 600 clamp(36px, 5.4vw, 68px)/1.02 var(--head); text-wrap: balance; }
  .series { margin: 10px 0 0; color: var(--muted); font-style: italic; }
  .by { margin: 12px 0 0; font-size: 20px; color: var(--muted); }
  .facts { margin: 22px 0 0; color: var(--fg); font-size: 15px; display: flex; flex-wrap: wrap; gap: 8px 0; align-items: center; }
  .sep { width: 1px; height: 14px; background: var(--line); margin: 0 14px; }
  .cta { margin: 28px 0 0; display: flex; gap: 12px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 11px 22px; border-radius: var(--r); border: 1px solid var(--accent);
    background: var(--accent); color: var(--accent-fg); text-decoration: none; font-weight: 600; font-size: 15px; }
  .btn.ghost { background: transparent; color: var(--accent); }
  .btn:hover { filter: brightness(1.1); }
  .hero-cover { width: 100%; aspect-ratio: 2/3; justify-self: end; }

  /* stats */
  .stats { display: flex; flex-wrap: wrap; gap: 0; padding: 4px 0 18px; }
  .stats div { padding: 4px 34px 4px 0; margin-right: 34px; border-right: 1px solid var(--line); }
  .stats div:last-child { border-right: 0; }
  .stats b { display: block; font: 600 30px/1.1 var(--head); }
  .stats span { color: var(--muted); font-size: 14px; }

  /* rows & grid */
  .row { margin: 30px 0 6px; }
  .row-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
  .row-head h2 { margin: 0; font: 600 28px/1.1 var(--head); }
  .count { color: var(--muted); font-size: 14px; }
  .arrows { margin-left: auto; display: flex; gap: 8px; }
  .arrows button { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--line); background: var(--bg2); font-size: 20px; line-height: 1; }
  .arrows button:hover { border-color: var(--accent); color: var(--accent); }
  .track { display: flex; gap: 18px; overflow-x: auto; padding: 8px 4px 26px; scroll-snap-type: x proximity; scrollbar-width: none; }
  .track::-webkit-scrollbar { display: none; }
  .track .card { flex: 0 0 176px; height: 264px; scroll-snap-align: start; }
  .all { padding: 34px 0 40px; }
  .toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 14px; margin-bottom: 20px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg2); font-size: 14px; }
  .chip small { color: var(--muted); margin-left: 4px; }
  .chip:hover { border-color: var(--accent); }
  .chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .chip.on small { color: inherit; opacity: .75; }
  .ctl { display: flex; gap: 16px; align-items: center; color: var(--muted); font-size: 14px; }
  select { margin-left: 6px; padding: 6px 8px; border-radius: var(--r); border: 1px solid var(--line); background: var(--bg2); color: var(--fg); font: inherit; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 22px 18px; }
  .grid .card { width: 100%; aspect-ratio: 2/3; }
  .empty { color: var(--muted); padding: 30px 0; }
  .more { text-align: center; margin: 28px 0 0; }

  /* Editorial catalogue blocks and dense table share the same cover-derived wash. */
  .library-wrap { padding-top: 34px; padding-bottom: 48px; }
  .library-heading { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin: 0 0 24px; }
  .library-heading h1 { font: 600 clamp(32px, 4vw, 50px)/1.05 var(--head); margin: 2px 0 8px; letter-spacing: -.025em; }
  .eyebrow { margin: 0; color: var(--accent); font: 600 10px/1.5 var(--body); letter-spacing: .18em; text-transform: uppercase; }
  .section-note { margin: 0; color: var(--muted); font-size: 14px; }
  .library-count { display: flex; flex-direction: column; text-align: right; padding: 8px 0 4px 24px; border-left: 1px solid var(--line); white-space: nowrap; }
  .library-count strong { font: 600 28px/1 var(--head); }
  .library-count span { color: var(--muted); font-size: 12px; }
  .glass-panel { background: color-mix(in srgb, var(--bg2) 78%, transparent); border: 1px solid color-mix(in srgb, var(--line) 80%, transparent); border-radius: calc(var(--r) + 10px); box-shadow: 0 16px 48px rgba(0,0,0,.12); backdrop-filter: blur(22px) saturate(125%); }
  .catalogue-panel { padding: 18px; }
  .catalogue-panel .toolbar { align-items: start; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
  .catalogue-panel .chips { max-width: 100%; }
  .ctl { flex-wrap: wrap; justify-content: end; }
  .view-switch { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--bg) 72%, transparent); }
  .view-switch button { border: 0; border-radius: 999px; background: transparent; color: var(--muted); padding: 7px 11px; font-size: 12px; white-space: nowrap; }
  .view-switch button.on { background: color-mix(in srgb, var(--accent) 22%, var(--bg2)); color: var(--fg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent); }
  .catalogue-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 286px), 1fr)); gap: 14px; padding-top: 18px; }
  .book-block { --tint: var(--bg3); display: grid; grid-template-columns: 104px minmax(0,1fr); align-items: stretch; gap: 15px; min-width: 0; padding: 12px; border: 1px solid color-mix(in srgb, var(--line) 82%, transparent); border-radius: calc(var(--r) + 8px); background: linear-gradient(120deg, color-mix(in srgb, var(--tint) 18%, transparent), color-mix(in srgb, var(--bg2) 92%, transparent) 42%); box-shadow: 0 5px 18px rgba(0,0,0,.08); backdrop-filter: blur(18px); transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
  .book-block:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--tint) 74%, var(--line)); box-shadow: 0 15px 34px color-mix(in srgb, var(--tint) 15%, transparent); }
  .book-cover { position: relative; align-self: start; display: block; width: 100%; aspect-ratio: 2/3; overflow: hidden; padding: 0; border: 0; border-radius: calc(var(--r) + 2px); background: var(--tint); box-shadow: var(--cshadow); text-decoration: none; }
  .book-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .cover-wash { position: absolute; inset: 40% 0 0; background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--tint) 68%, #000)); pointer-events: none; }
  .cover-rating { position: absolute; left: 6px; bottom: 5px; max-width: calc(100% - 12px); color: #ffe1a2; font-size: 10px; letter-spacing: 1px; text-shadow: 0 1px 4px #000; }
  .book-copy { min-width: 0; display: flex; flex-direction: column; align-items: start; padding: 2px 0 1px; }
  .book-title { display: -webkit-box; max-width: 100%; padding: 0; border: 0; background: none; color: var(--fg); text-align: left; font: 600 18px/1.12 var(--head); overflow: hidden; -webkit-line-clamp: 3; -webkit-box-orient: vertical; text-decoration: none; }
  .book-title:hover, .table-title:hover, .inline-book:hover { color: var(--accent); }
  .book-series { max-width: 100%; margin: 5px 0 0; color: var(--muted); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .book-author { margin: 6px 0 10px; color: var(--muted); font-size: 12px; line-height: 1.3; }
  .book-tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .shelf-tag { display: inline-block; padding: 3px 7px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--fg); font-size: 10px; line-height: 1.2; cursor: pointer; }
  button.shelf-tag:hover, button.shelf-tag.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .muted-tag { color: var(--muted); }
  .book-facts { display: grid; gap: 3px; margin-top: auto; padding: 12px 0 8px; color: var(--muted); font-size: 10px; }
  .book-actions { width: 100%; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 4px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
  .book-actions a, .quiet-action { padding: 0; border: 0; background: none; color: var(--accent); font-size: 11px; text-decoration: none; }
  .quiet-action { color: var(--muted); }
  .table-wrap { width: 100%; overflow: auto; padding-top: 14px; }
  .book-table { width: 100%; border-collapse: separate; border-spacing: 0; font: 13px/1.4 var(--body); }
  .book-table th { position: sticky; top: 0; z-index: 1; padding: 12px 10px; background: color-mix(in srgb, var(--bg2) 94%, transparent); color: var(--muted); text-align: left; font: 600 10px/1.2 var(--body); letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; backdrop-filter: blur(16px); }
  .book-table td { padding: 10px; border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent); color: var(--fg); vertical-align: middle; white-space: nowrap; }
  .book-table tr:hover td { background: color-mix(in srgb, var(--tint, var(--accent)) 7%, transparent); }
  .table-book { display: flex; align-items: center; gap: 11px; min-width: 220px; white-space: normal; }
  .table-cover { display: block; flex: none; width: 35px; height: 52px; padding: 0; overflow: hidden; border: 0; border-radius: 5px; background: var(--bg3); text-decoration: none; }
  .table-cover img { width: 100%; height: 100%; object-fit: cover; }
  .table-book > div { display: grid; gap: 3px; }
  .table-title { display: block; max-width: 310px; padding: 0; border: 0; background: none; color: var(--fg); text-align: left; font: 600 14px/1.2 var(--head); white-space: normal; text-decoration: none; }
  .table-series, .table-sub { display: block; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
  .table-rating { color: var(--muted); font-size: 11px; }
  .table-rating.rated { color: #d5a955; letter-spacing: .5px; }
  .table-rating small { margin-left: 5px; color: var(--muted); letter-spacing: 0; }
  .table-actions { display: flex; gap: 8px; align-items: center; }
  .table-actions button { border: 0; background: none; color: var(--accent); letter-spacing: 2px; }
  .table-actions a { color: var(--muted); font-size: 11px; text-decoration: none; }
  .muted { color: var(--muted); }
  .empty-state { display: grid; justify-items: center; padding: 60px 18px; text-align: center; color: var(--muted); }
  .empty-state h2 { margin: 10px 0 5px; color: var(--fg); font: 600 26px/1.1 var(--head); }
  .empty-state p { max-width: 380px; margin: 0 0 18px; font-size: 13px; }
  .empty-mark { color: var(--accent); font-size: 28px; }

  /* Scrollable feed with glass surfaces and restrained, book-specific color. */
  .feed-area { padding: 36px 0 58px; }
  .feed-intro { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
  .feed-intro h2 { margin: 4px 0 4px; font: 600 clamp(26px, 3.6vw, 38px)/1.1 var(--head); }
  .feed-intro p:not(.eyebrow) { margin: 0; color: var(--muted); font-size: 13px; }
  .text-action { border: 0; background: none; color: var(--accent); font: inherit; font-size: 12px; white-space: nowrap; }
  .feed-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 18px; align-items: start; }
  .feed-stream { display: grid; gap: 10px; max-height: 740px; overflow-y: auto; overscroll-behavior: contain; padding: 2px 8px 2px 2px; scrollbar-color: var(--line) transparent; }
  .activity-item { --tint: var(--bg3); min-width: 0; display: grid; grid-template-columns: 25px 52px minmax(0,1fr); align-items: start; gap: 12px; padding: 14px; border: 1px solid color-mix(in srgb, var(--line) 76%, transparent); border-radius: calc(var(--r) + 8px); background: linear-gradient(105deg, color-mix(in srgb, var(--tint) 14%, transparent), color-mix(in srgb, var(--bg2) 90%, transparent)); backdrop-filter: blur(18px); }
  .activity-marker { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-size: 11px; }
  .activity-cover, .activity-thumb, .activity-placeholder { display: grid; place-items: center; width: 52px; height: 74px; padding: 0; border: 0; border-radius: 4px; overflow: hidden; background: var(--tint); color: var(--accent); }
  .activity-cover img { width: 100%; height: 100%; object-fit: cover; }
  .social-item { grid-template-columns: 52px minmax(0,1fr); }
  .social-item > .activity-thumb { grid-column: 1; width: 52px; height: 70px; object-fit: cover; }
  .social-item .activity-content { grid-column: 2; min-width: 0; overflow-wrap: anywhere; }
  .activity-placeholder { font-size: 24px; }
  .activity-content { min-width: 0; }
  .activity-kind { color: var(--accent); font: 600 9px/1.4 var(--body); letter-spacing: .13em; }
  .activity-content p { margin: 4px 0 5px; font-size: 14px; line-height: 1.4; }
  .inline-book { padding: 0; border: 0; background: none; color: var(--fg); font-weight: 600; font-family: var(--head); text-align: left; }
  .activity-author { color: var(--muted); font-size: 11px; }
  .activity-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
  .activity-actions button, .activity-actions a, .activity-link { padding: 0; border: 0; background: none; color: var(--accent); font-size: 11px; text-decoration: none; }
  .activity-aside, .feed-aside { position: sticky; top: 94px; padding: 20px; }
  .feed-aside h3 { margin: 9px 0; font: 600 25px/1.08 var(--head); }
  .feed-aside > p:not(.eyebrow) { color: var(--muted); font-size: 12px; }
  .aside-stat { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; padding: 12px 0; border-top: 1px solid var(--line); }
  .aside-stat strong { color: var(--accent); font: 600 24px/1 var(--head); }
  .aside-stat span { color: var(--muted); font-size: 11px; text-align: right; }
  .feed-aside .btn { margin-top: 10px; padding: 9px 12px; font-size: 12px; }
  .social-item .activity-thumb { height: 70px; }

  /* cards: cover fills the card, a wash of the cover's own color rises from below */
  .card { position: relative; display: block; padding: 0; border: 0; overflow: hidden; text-align: left;
    border-radius: var(--cr); background: var(--tint, var(--bg3)); box-shadow: var(--cshadow);
    transition: transform .18s ease, box-shadow .18s ease; }
  .card img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .card .shade { position: absolute; inset: 0; opacity: 0; transition: opacity .18s ease;
    background: linear-gradient(to top, color-mix(in srgb, var(--tint, #000) 82%, #000) 0%, transparent 62%); }
  .card .meta { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px; opacity: 0; transform: translateY(6px);
    transition: opacity .18s ease, transform .18s ease; color: #fff; text-shadow: 0 1px 8px rgba(0,0,0,.6); }
  .card .meta b { display: block; font: 600 16px/1.2 var(--head); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card .meta i { display: block; font-style: normal; font-size: 13px; opacity: .85; margin-top: 3px; }
  .card .rate { position: absolute; top: 8px; right: 8px; padding: 2px 7px; border-radius: 999px; font-size: 11px; letter-spacing: 1px;
    background: rgba(0,0,0,.55); color: #ffd36b; opacity: 0; transition: opacity .18s ease; }
  .card:hover, .card:focus-visible { transform: translateY(-6px); box-shadow: 0 22px 44px -14px var(--tint, #000), var(--cshadow); }
  .card:hover .shade, .card:hover .meta, .card:hover .rate,
  .card:focus-visible .shade, .card:focus-visible .meta, .card:focus-visible .rate { opacity: 1; transform: none; }
  .hero-cover:hover { transform: none; }

  /* drawer */
  .scrim { position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.5); opacity: 0; pointer-events: none; transition: opacity .2s; }
  .scrim.open { opacity: 1; pointer-events: auto; }
  .drawer { position: fixed; z-index: 31; top: 0; right: 0; bottom: 0; width: min(460px, 100vw); overflow-y: auto; padding: 38px 30px 48px;
    transform: translateX(105%); transition: transform .26s cubic-bezier(.2,.8,.2,1); --tint: var(--bg3);
    background: linear-gradient(150deg, color-mix(in srgb, var(--tint) 25%, var(--bg2)) 0%, color-mix(in srgb, var(--bg2) 96%, transparent) 48%), var(--bg2); border-left: 1px solid var(--line); box-shadow: -20px 0 60px rgba(0,0,0,.18); backdrop-filter: blur(28px); }
  .drawer.open { transform: none; }
  .drawer-close { position: sticky; top: 0; float: right; z-index: 2; width: 35px; height: 35px; border: 1px solid var(--line); border-radius: 50%; background: color-mix(in srgb, var(--bg2) 86%, transparent); color: var(--muted); font-size: 24px; line-height: 1; backdrop-filter: blur(12px); }
  .drawer-eyebrow { clear: both; padding-top: 18px; }
  .drawer h2 { margin: 22px 0 0; font: 600 32px/1.08 var(--head); }
  .d-cover { width: 180px; aspect-ratio: 2/3; }
  .drawer dl { display: grid; grid-template-columns: minmax(82px, auto) 1fr; gap: 7px 18px; margin: 22px 0; padding: 16px 0; border-block: 1px solid var(--line); font-size: 13px; }
  .drawer dt { color: var(--muted); } .drawer dd { margin: 0; } .gold { color: #ffd36b; letter-spacing: 2px; }
  .drawer-label { display: block; color: var(--muted); font: 600 9px/1.5 var(--body); letter-spacing: .14em; text-transform: uppercase; }
  .drawer-shelves { margin: 18px 0; } .drawer-shelves .chips { margin-top: 8px; }
  .review-snippet { margin: 20px 0; padding: 15px; border: 1px solid var(--line); border-radius: var(--r); background: color-mix(in srgb, var(--bg3) 45%, transparent); }
  .drawer blockquote { margin: 8px 0 0; padding: 4px 0 4px 13px; border-left: 2px solid var(--accent); color: var(--muted); font-size: 13px; font-style: italic; }
  .drawer .chips { margin: 0 0 6px; }
  .drawer-actions { display: grid; grid-template-columns: 1fr; gap: 9px; }
  .drawer-actions .btn { display: flex; justify-content: space-between; align-items: center; }
  .native-note { margin-top: 14px; color: var(--muted); font-size: 11px; }

  .bigstatus { padding: 90px 0; font-size: 18px; color: var(--muted); }
  .foot { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 22px 0 32px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); }
  .foot-note { opacity: .7; }
  .err { color: #ff8a80; }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: sp .8s linear infinite; vertical-align: -2px; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @media (max-width: 1000px) {
    .bar { gap: 10px; } .brand { font-size: 20px; } nav { gap: 2px; } .nav-link { padding: 8px; }
    .search { order: 5; flex-basis: 100%; } .search #q { max-width: none; }
    .feed-layout { grid-template-columns: minmax(0,1fr) 220px; }
  }
  @media (max-width: 760px) {
    .wrap { width: min(100% - 28px, 1240px); }
    .hero .in { grid-template-columns: 1fr; padding: 36px 0 44px; } .hero-cover { max-width: 150px; justify-self: start; order: -1; }
    .bar { gap: 8px; } nav { order: 4; width: 100%; overflow-x: auto; padding-bottom: 2px; } .nav-link { flex: none; }
    .acts { margin-left: auto; } .acts a { display: none; }
    .track .card { flex-basis: 140px; height: 210px; }
    .feed-layout { grid-template-columns: minmax(0,1fr); } .feed-aside { position: static; }
    .library-heading { align-items: start; } .library-count { padding-left: 14px; }
    .catalogue-panel { padding: 12px; } .catalogue-panel .toolbar { gap: 12px; }
    .catalogue-panel .ctl { justify-content: start; width: 100%; }
    .catalogue-grid { grid-template-columns: 1fr; gap: 10px; }
    .book-block { grid-template-columns: 88px minmax(0,1fr); gap: 12px; padding: 10px; }
    .book-title { font-size: 17px; }
    .activity-item { grid-template-columns: 20px 44px minmax(0,1fr); gap: 9px; padding: 11px; }
    .activity-cover, .activity-placeholder { width: 44px; height: 64px; }
    .social-item { grid-template-columns: 44px minmax(0,1fr); }
    .social-item > .activity-thumb { width: 44px; height: 64px; }
    .feed-intro { align-items: start; }
  }
  @media (max-width: 760px) {
    .reader-nav-wrap { width: calc(100% - 20px); margin-bottom: 12px; }
    .reader-nav { width: 100%; border-radius: 16px; justify-content: stretch; }
    .reader-nav :is(.reader-nav-button, .reader-nav-link) { flex: 1 1 auto; padding-inline: 10px; }
    .reader-nav .reader-nav-sync { margin-left: 0; }
    .reel-section { padding: 13px; border-radius: 17px; }
    .reel-card { flex-basis: 174px; height: 270px; }
    .reel-head { align-items: start; }
    .reel-head .arrows { align-self: start; }
    .feed-layout { grid-template-columns: minmax(0,1fr); }
    .feed-aside { position: static; }
  }
  @media (max-width: 420px) {
    .library-count { display: none; } .brand small { display: none; } .brand { grid-template-rows: 1fr; }
    .view-switch { margin-left: auto; } .book-facts { font-size: 9px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

  /* Native / neutral appearance when the user disables the site-wide theme. */
  :host([data-theme="off"]) { --bg: #f5f2eb; --bg2: #fffdf8; --bg3: #ece7dc; --fg: #302b24; --muted: #756d61; --line: #d8d0c2; --accent: #32756f; --accent-fg: #ffffff; --head: Georgia, "Times New Roman", serif; --body: Arial, Helvetica, sans-serif; --r: 8px; --cr: 8px; --cshadow: 0 6px 16px rgba(35,28,20,.12); }
  :host([data-theme="off"]) .top { background: rgba(255,253,248,.82); }
  :host([data-theme="off"]) .hero-bg { opacity: .25; filter: blur(48px) saturate(.8); }
  :host([data-theme="off"]) .hero::after { background: linear-gradient(180deg, rgba(245,242,235,.05), #f5f2eb 98%); }


  /* Goodreads-local view switcher: glass, compact, and visually separate from the native site menu. */
  .reader-nav-wrap { position: relative; z-index: 12; width: min(1320px, 100% - 34px); margin: 8px auto 18px; }
  .reader-nav { position: sticky; top: 8px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px; width: max-content; max-width: 100%; margin: 0 auto; padding: 5px; border: 1px solid color-mix(in srgb, var(--line) 82%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--bg2) 78%, transparent); box-shadow: 0 10px 30px rgba(0,0,0,.08); backdrop-filter: blur(24px) saturate(145%); -webkit-backdrop-filter: blur(24px) saturate(145%); }
  .reader-nav :is(.reader-nav-button, .reader-nav-link, .reader-nav-sync) { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 8px 15px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--fg); text-decoration: none; white-space: nowrap; font: 600 12px/1.1 var(--body); cursor: pointer; transition: background .18s ease, color .18s ease, border-color .18s ease, transform .18s ease; }
  .reader-nav :is(.reader-nav-button, .reader-nav-link, .reader-nav-sync):hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--fg); }
  .reader-nav :is(.reader-nav-button.active, .reader-nav-link.active) { border-color: color-mix(in srgb, var(--accent) 58%, transparent); background: var(--accent); color: var(--accent-fg); box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 20%, transparent); }
  .reader-nav .reader-nav-sync { margin-left: 4px; border-color: var(--line); color: var(--muted); }
  .reader-nav .reader-nav-sync:hover { color: var(--fg); }
  .home-catalogue { width: 100%; margin: 0 auto; }
  .home-catalogue > .hero { margin: 0; border-radius: 18px; isolation: isolate; }
  .home-catalogue > .stats { width: min(1240px, 100% - 48px); margin: 0 auto 28px; }
  .home-catalogue .home-rows { width: min(1240px, 100% - 48px); margin: 0 auto 22px; }

  /* A restrained, Apple Books-like horizontal reel for native Goodreads activity and reading events. */
  .reel-section { margin: 26px 0 34px; padding: 20px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--line) 78%, transparent); border-radius: 22px; background: color-mix(in srgb, var(--bg2) 72%, transparent); box-shadow: 0 16px 42px rgba(0,0,0,.075); backdrop-filter: blur(22px) saturate(135%); -webkit-backdrop-filter: blur(22px) saturate(135%); }
  .reel-head { display: flex; align-items: end; gap: 18px; margin-bottom: 14px; }
  .reel-head h3 { margin: 0 0 4px; font: 500 clamp(21px, 2.6vw, 29px)/1.12 var(--head); letter-spacing: -.015em; }
  .reel-head p { max-width: 68ch; margin: 0; color: var(--muted); font: 12px/1.5 var(--body); }
  .reel-head .arrows { align-self: center; }
  .reel-track { display: flex; align-items: stretch; gap: 15px; overflow-x: auto; overflow-y: hidden; padding: 7px 2px 16px; scroll-snap-type: x mandatory; scroll-behavior: smooth; overscroll-behavior-x: contain; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .reel-track::-webkit-scrollbar { height: 6px; }
  .reel-track::-webkit-scrollbar-track { background: transparent; }
  .reel-track::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .reel-card { position: relative; isolation: isolate; display: block; flex: 0 0 clamp(178px, 19vw, 224px); height: 304px; min-width: 0; overflow: hidden; scroll-snap-align: start; border: 1px solid color-mix(in srgb, var(--line) 74%, transparent); border-radius: 17px; background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 28%, var(--bg3)), var(--bg2)); box-shadow: 0 9px 24px rgba(0,0,0,.15); color: #fff !important; text-decoration: none !important; transition: transform .22s ease, border-color .22s ease, box-shadow .22s ease; }
  .reel-card img, .reel-card .reel-art { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
  .reel-card .reel-art { background: radial-gradient(circle at 72% 17%, color-mix(in srgb, var(--accent) 56%, transparent), transparent 34%), radial-gradient(circle at 20% 80%, color-mix(in srgb, var(--fg) 22%, transparent), transparent 28%), linear-gradient(145deg, var(--bg3), var(--tint, var(--accent)), var(--bg)); }
  .reel-shade { position: absolute; z-index: 1; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.02) 15%, rgba(0,0,0,.14) 40%, rgba(0,0,0,.88) 100%); transition: background .2s ease; }
  .reel-content { position: absolute; z-index: 2; inset: auto 0 0; display: grid; gap: 7px; padding: 16px; color: #fff !important; text-shadow: 0 2px 14px rgba(0,0,0,.55); }
  .reel-content :is(small, b, span, em) { color: #fff !important; }
  .reel-content small { font: 600 8px/1.35 var(--body); letter-spacing: .12em; opacity: .82; text-transform: uppercase; }
  .reel-content b { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; font: 500 21px/1.05 var(--head); }
  .reel-content span { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; font: 11px/1.45 var(--body); opacity: .9; }
  .reel-content em { width: max-content; margin-top: 4px; padding: 5px 9px; border: 1px solid rgba(255,255,255,.42); border-radius: 999px; background: rgba(15,14,16,.25); font: normal 600 9px/1.2 var(--body); backdrop-filter: blur(10px); }
  .reel-card:hover, .reel-card:focus-visible { transform: translateY(-4px); border-color: color-mix(in srgb, var(--accent) 70%, transparent); box-shadow: 0 18px 38px rgba(0,0,0,.23); }
  .reel-card:hover .reel-shade, .reel-card:focus-visible .reel-shade { background: linear-gradient(180deg, rgba(0,0,0,.02) 8%, rgba(0,0,0,.2) 30%, rgba(0,0,0,.92) 100%); }
  .social-reel .reel-content { gap: 8px; }
  .feed-area .timeline-heading { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
  .feed-area .timeline-heading h3 { font: 500 24px/1.1 var(--head); margin: 0; }
  .feed-area .timeline-heading span { color: var(--muted); font: 11px var(--body); }

  .embedded-catalogue { padding: 16px 0 26px; }
  .embedded-catalogue .library-wrap { max-width: 1320px; width: min(100% - 34px, 1320px); margin-inline: auto; }
  .embedded-catalogue .toolbar-search { flex: 1 1 250px; min-width: min(100%, 230px); display: grid; gap: 5px; }
  .embedded-catalogue .toolbar-search label { color: var(--muted); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  .embedded-catalogue .search-controls { display: flex; gap: 8px; align-items: center; min-width: 0; }
  .embedded-catalogue .toolbar-search input { width: 100%; min-width: 0; min-height: 40px; padding: 9px 13px; border-radius: 999px; border: 1px solid var(--line); background: color-mix(in srgb, var(--bg3) 82%, transparent); color: var(--fg); font: inherit; outline-offset: 3px; }
  .embedded-catalogue .sync-button { flex: none; min-height: 40px; padding: 8px 13px; border-radius: 999px; border: 1px solid var(--line); background: color-mix(in srgb, var(--bg2) 78%, transparent); color: var(--fg); font-size: 12px; font-weight: 600; }
  .embedded-catalogue .sync-button:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg2)); }
  .embedded-catalogue .toolbar-search input::placeholder { color: var(--muted); opacity: 1; }
  .embedded-catalogue .toolbar-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  .embedded-catalogue .library-heading { align-items: end; gap: 18px; margin: 8px auto 20px; }
  .embedded-catalogue .library-heading h1 { font-family: var(--head); font-weight: 500; letter-spacing: -.025em; line-height: 1.12; }
  .embedded-catalogue .section-note { max-width: 62ch; }
  .embedded-catalogue .catalogue-panel { border-radius: 18px; border: 1px solid color-mix(in srgb, var(--line) 76%, transparent); background: color-mix(in srgb, var(--bg2) 86%, transparent); box-shadow: 0 12px 40px rgba(0,0,0,.09); backdrop-filter: blur(22px) saturate(125%); -webkit-backdrop-filter: blur(22px) saturate(125%); }
  .embedded-catalogue .catalogue-panel .toolbar { position: sticky; top: 68px; z-index: 6; padding: 12px; margin: -6px -6px 12px; border-radius: 14px; background: color-mix(in srgb, var(--bg2) 92%, transparent); backdrop-filter: blur(22px) saturate(135%); -webkit-backdrop-filter: blur(22px) saturate(135%); box-shadow: 0 8px 24px rgba(0,0,0,.07); }
  .embedded-catalogue .catalogue-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 16px; }
  .embedded-catalogue .book-block { border-radius: 14px; overflow: hidden; background: color-mix(in srgb, var(--bg2) 76%, var(--tint, transparent)); border: 1px solid color-mix(in srgb, var(--line) 76%, transparent); box-shadow: 0 6px 24px rgba(0,0,0,.055); transition: transform .22s ease, border-color .22s ease, box-shadow .22s ease; }
  .embedded-catalogue .book-block:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 14px 36px rgba(0,0,0,.12); }
  .embedded-catalogue .loading-rule { display: block; width: 110px; height: 3px; margin: 0 auto 20px; border-radius: 999px; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: grx-pulse 1.2s ease-in-out infinite; }
  @keyframes grx-pulse { 0%,100% { opacity: .35; transform: scaleX(.65); } 50% { opacity: 1; transform: scaleX(1); } }
  .embedded-catalogue .book-cover { border-radius: 8px; }
  .embedded-catalogue .book-title { line-height: 1.25; text-align: left; }
  .embedded-catalogue .book-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .embedded-catalogue .book-actions a, .embedded-catalogue .book-actions button { min-height: 32px; padding: 7px 10px; border-radius: 999px; border: 1px solid var(--line); text-decoration: none; color: var(--fg); background: color-mix(in srgb, var(--bg3) 72%, transparent); font-size: 12px; }
  .embedded-catalogue .book-actions a:hover, .embedded-catalogue .book-actions button:hover { border-color: var(--accent); }
  .embedded-catalogue .chips, .embedded-catalogue .ctl { align-items: center; }
  .embedded-catalogue .chip, .embedded-catalogue .shelf-tag, .embedded-catalogue .view-switch button, .embedded-catalogue select { color: var(--fg); }
  .embedded-catalogue .table-wrap { overflow: auto; overscroll-behavior-x: contain; border-radius: 12px; scrollbar-color: var(--line) transparent; }
  .embedded-catalogue .book-table { min-width: 760px; }
  .embedded-catalogue .book-table tbody tr { transition: background-color .18s ease; }
  .embedded-catalogue .book-table tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .embedded-catalogue .foot { padding-top: 18px; margin-top: 16px; }
  @media (prefers-reduced-motion: no-preference) {
    .embedded-catalogue .book-block { animation: grx-enter .42s both; }
    .embedded-catalogue .book-block:nth-child(3n + 2) { animation-delay: 35ms; }
    .embedded-catalogue .book-block:nth-child(3n + 3) { animation-delay: 70ms; }
  }
  @keyframes grx-enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  /* per-theme character */
  :host([data-theme="thriller"]) .hero h1, :host([data-theme="thriller"]) .row-head h2 { text-transform: uppercase; letter-spacing: .01em; }
  :host([data-theme="thriller"]) .hero-bg { filter: grayscale(.7) blur(44px); opacity: .5; }
  :host([data-theme="thriller"]) .card { box-shadow: 6px 6px 0 var(--accent); }
  :host([data-theme="thriller"]) .top { border-bottom: 3px solid var(--accent); }
  :host([data-theme="aurora"]) .hero h1 { font-size: clamp(44px, 7vw, 92px); font-weight: 400; letter-spacing: -.02em; }
  :host([data-theme="aurora"]) .hero-bg { opacity: .75; }
  :host([data-theme="aurora"]) .track .card { height: 300px; flex-basis: 190px; }
  :host([data-theme="aurora"]) .card { box-shadow: 0 26px 60px -22px var(--tint, #ff6a3d); }
  :host([data-theme="aurora"]) .card .shade, :host([data-theme="aurora"]) .card .meta { opacity: 1; transform: none; }
  :host([data-theme="storybook"]) .top { background: #243b42; border-bottom: 4px solid var(--accent); backdrop-filter: none; }
  :host([data-theme="storybook"]) .card { border: 3px solid #1f3238; box-shadow: 5px 5px 0 #1f3238; }
  :host([data-theme="storybook"]) .btn { border: 2px solid #1f3238; box-shadow: 3px 3px 0 #1f3238; }
  :host([data-theme="storybook"]) .hero-bg, :host([data-theme="fiction"]) .hero-bg { opacity: .28; }
  :host([data-theme="storybook"]) .stats b { color: var(--accent); }
  :host([data-theme="mystical"]) .hero h1 { text-shadow: 0 0 26px rgba(217,178,95,.4); letter-spacing: .02em; }
  :host([data-theme="mystical"]) .row-head h2::after { content: ""; display: inline-block; width: 60px; height: 1px; margin-left: 14px; vertical-align: middle; background: var(--accent); opacity: .7; }
  :host([data-theme="dark-academia"]) .row-head h2 { font-style: italic; font-weight: 500; }
  :host([data-theme="dark-academia"]) .hero .tag::before { content: ""; width: 34px; height: 1px; background: var(--accent); }
  `;


  // ---------- native Goodreads genre/shelf/profile/book enhancements ----------
  const BROWSE_VIEW_KEY = "grx_browse_view";
  let nativeObserver = null, nativeEnhanceQueued = false, browseViewLoading = false;
  let savedBrowseView = "";

  function paintBrowseButtons(view) {
    document.querySelectorAll("[data-grx-browse-mode]").forEach((button) => {
      const active = button.dataset.grxBrowseMode === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  function setBrowseView(view, persist = true) {
    ui.browseView = view === "table" ? "table" : "blocks";
    root.setAttribute("data-grx-browse-view", ui.browseView);
    paintBrowseButtons(ui.browseView);
    if (persist && savedBrowseView !== ui.browseView) {
      savedBrowseView = ui.browseView;
      api.storage.local.set({ [BROWSE_VIEW_KEY]: ui.browseView });
    }
  }

  function addBrowseToolbar(target) {
    if (!target || target.querySelector(":scope > .grx-browse-tools")) return;
    const bar = document.createElement("div");
    bar.className = "grx-browse-tools";
    bar.innerHTML = `<div class="grx-browse-tools-copy"><strong>Browse books</strong><span>Change how this Goodreads collection is displayed.</span></div><div class="grx-browse-switch" role="group" aria-label="Book browse layout"><button type="button" data-grx-browse-mode="blocks">Blocks</button><button type="button" data-grx-browse-mode="table">Table</button></div>`;
    const heading = target.querySelector("h1, h2, [class*='heading' i], [class*='title' i]");
    if (heading && heading.parentElement && heading.parentElement.parentElement === target) heading.parentElement.insertAdjacentElement("afterend", bar);
    else target.prepend(bar);
  }

  function markNativeBookGrid(target) {
    if (!target) return;
    const anchors = [...target.querySelectorAll('a[href*="/book/show/"]')]
      .filter((a) => !a.closest("#grx-host, .grx-browse-generated-table") && (a.querySelector("img") || (a.href && /\/book\/show\//.test(a.href))));
    const cards = [];
    for (const a of anchors) {
      let node = a.closest(".elementList, .bookBox, .cover, .bookCover, li, [class*='BookCard' i], [class*='bookCard' i], [class*='book-card' i]");
      if (!node || node === target || node.matches("header, nav")) {
        node = a;
        for (let i = 0; i < 3 && node.parentElement && node.parentElement !== target; i++) {
          const parent = node.parentElement;
          const txt = (parent.innerText || "").trim();
          if (parent.querySelector("img") && txt.length < 520) node = parent; else break;
        }
      }
      if (node && node !== target && !node.closest("#grx-host")) {
        node.classList.add("grx-browse-card");
        cards.push(node);
      }
    }
    // Prefer the narrowest existing Goodreads list/grid containing several book cards.
    const uniqueCards = [...new Set(cards)];
    const possible = [...target.querySelectorAll(".coverRow, .elementList, .bigBox, .gr-box, #browseResults, [class*='genre' i], [class*='browse' i], [class*='results' i], [class*='bookshelf' i], [class*='shelf' i], ul, ol, section, div")]
      .filter((el) => !el.closest("#grx-host, .grx-browse-generated-table, .grx-browse-tools") && el.querySelectorAll(".grx-browse-card").length >= 4 && el.clientHeight > 0);
    possible.sort((a, b) => a.querySelectorAll(".grx-browse-card").length - b.querySelectorAll(".grx-browse-card").length);
    const container = possible[0] || (uniqueCards.length >= 4 ? uniqueCards[0].parentElement : null);
    if (container && container !== target && uniqueCards.length >= 4) {
      container.classList.add("grx-browse-grid");
      container.setAttribute("data-grx-browse-grid", "");
    }
  }

  function renderNativeBrowseTable(target) {
    const container = target?.querySelector("[data-grx-browse-grid]");
    const existing = target?.querySelector(":scope > .grx-browse-generated-table, .grx-browse-generated-table");
    if (root.getAttribute("data-grx-browse-view") !== "table" || !container) {
      container?.classList.remove("grx-browse-native-hidden");
      existing?.remove();
      return;
    }
    container.classList.add("grx-browse-native-hidden");
    const books = new Map();
    for (const a of container.querySelectorAll('a[href*="/book/show/"]')) {
      const href = new URL(a.getAttribute("href"), location.origin).pathname;
      const holder = a.closest(".grx-browse-card") || a.parentElement;
      const img = holder?.querySelector("img") || a.querySelector("img");
      const lines = (holder?.innerText || a.innerText || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
      const title = (a.getAttribute("title") || a.innerText || img?.alt || "").replace(/^cover of\s*/i, "").trim();
      const details = lines.filter((line) => line.toLowerCase() !== title.toLowerCase() && !/^[★☆\s0-5.]+$/.test(line));
      const rating = (holder?.innerText || "").match(/\b([0-5](?:\.\d+)?)\s*(?:out of 5|stars?)\b/i)?.[1] || "";
      if (!books.has(href)) books.set(href, { href, title, author: details[0] || "", image: img?.src || "", rating });
      else {
        const row = books.get(href);
        if (!row.title && title) row.title = title;
        if (!row.author && details[0]) row.author = details[0];
        if (!row.image && img?.src) row.image = img.src;
        if (!row.rating && rating) row.rating = rating;
      }
    }
    if (books.size < 2) { container.classList.remove("grx-browse-native-hidden"); return; }
    const rows = [...books.values()].map((b) => `<tr><td><a class="grx-browse-table-book" href="${esc(b.href)}">${b.image ? `<img src="${esc(b.image)}" alt="">` : ""}<span>${esc(b.title || "Untitled book")}</span></a></td><td>${esc(b.author || "Not listed")}</td><td>${esc(b.rating ? `${b.rating}/5` : "Not rated")}</td><td><a class="grx-browse-open" href="${esc(b.href)}">Open book</a></td></tr>`).join("");
    const tableHTML = `<table><thead><tr><th>Book</th><th>Author</th><th>Rating</th><th>Page</th></tr></thead><tbody>${rows}</tbody></table>`;
    if (!existing) {
      const box = document.createElement("div");
      box.className = "grx-browse-generated-table";
      box.innerHTML = tableHTML;
      container.insertAdjacentElement("afterend", box);
    } else if (existing.innerHTML !== tableHTML) {
      existing.innerHTML = tableHTML;
    }
  }

  function enhanceBrowseRoute() {
    if (!isNativeBrowseRoute()) {
      document.querySelectorAll(".grx-browse-tools").forEach((el) => el.remove());
      root.removeAttribute("data-grx-browse-view");
      return;
    }
    const target = document.querySelector("#mainContentContainer .mainContent, .mainContentContainer .mainContent, #pageContent .mainContent, .mainContent, #mainContent, main") || document.body;
    addBrowseToolbar(target);
    markNativeBookGrid(target);
    renderNativeBrowseTable(target);
    if (!root.hasAttribute("data-grx-browse-view") && !browseViewLoading) {
      browseViewLoading = true;
      api.storage.local.get(BROWSE_VIEW_KEY).then((r) => {
        browseViewLoading = false;
        savedBrowseView = r[BROWSE_VIEW_KEY] || "blocks";
        setBrowseView(savedBrowseView, false);
        markNativeBookGrid(target);
        renderNativeBrowseTable(target);
      });
    } else if (root.hasAttribute("data-grx-browse-view")) {
      ui.browseView = root.getAttribute("data-grx-browse-view") === "table" ? "table" : "blocks";
      paintBrowseButtons(ui.browseView);
    }
  }

  function enhanceNativePages() {
    if (!document.body) return;

    // Only mark native shelf sections for theme-safe color/visibility rules. Do not
    // move recommendation blocks, rebuild grids, or change Goodreads' content order.
    const active = new Set();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],.h2Container,.h3Container,[class*="sectionTitle" i]')];
    const patterns = [
      { re: /more\s+editions|editions(?:\s+and\s+formats)?|available\s+editions/i, cls: 'grx-theme-editions' },
      { re: /readers\s+also\s+(?:enjoyed|liked)|similar\s+books|related\s+books|you\s+may\s+also\s+like|book\s+recommendations|recommended\s+reads/i, cls: 'grx-theme-recommendations' },
      { re: /other\s+books|more\s+books|books\s+by\s+this\s+author|books\s+in\s+this\s+series|more\s+like\s+this/i, cls: 'grx-theme-other-books' }
    ];

    for (const heading of headings) {
      const title = (heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim();
      const match = patterns.find((item) => item.re.test(title));
      if (!match) continue;

      let section = null;
      let candidate = heading;
      for (let depth = 0; depth < 8 && candidate && candidate !== document.body; depth++, candidate = candidate.parentElement) {
        if (candidate.closest('#grx-host')) break;
        const count = candidate.querySelectorAll ? candidate.querySelectorAll('a[href*="/book/show/"]').length : 0;
        const textLength = (candidate.innerText || '').trim().length;
        if (count >= 2 && count <= 100 && textLength < 18000
          && !candidate.matches('body, main, #mainContentContainer, #pageContent, .mainContent')) {
          section = candidate;
          break;
        }
      }
      if (!section) continue;
      section.classList.add('grx-theme-bookshelf', match.cls, 'grx-preserve-native-colors');
      section.querySelectorAll('*').forEach((element) => element.classList.add('grx-preserve-native-colors'));
      active.add(section);
    }

    // Remove only our temporary marker classes from sections that have disappeared
    // or changed during Goodreads client-side navigation. Never remove native classes.
    document.querySelectorAll('.grx-theme-bookshelf').forEach((section) => {
      if (active.has(section)) return;
      section.classList.remove('grx-theme-bookshelf', 'grx-theme-editions', 'grx-theme-recommendations', 'grx-theme-other-books', 'grx-preserve-native-colors');
      section.querySelectorAll('.grx-preserve-native-colors').forEach((element) => element.classList.remove('grx-preserve-native-colors'));
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-grx-browse-mode]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    setBrowseView(button.dataset.grxBrowseMode);
    enhanceBrowseRoute();
  }, true);

  api.storage.local.get(BROWSE_VIEW_KEY).then((r) => { savedBrowseView = r[BROWSE_VIEW_KEY] || "blocks"; ui.browseView = savedBrowseView; });
  document.addEventListener("DOMContentLoaded", enhanceNativePages);
  if (document.readyState !== "loading") enhanceNativePages();
  function scheduleNativeEnhance() {
    if (nativeEnhanceQueued) return;
    nativeEnhanceQueued = true;
    setTimeout(() => { nativeEnhanceQueued = false; enhanceNativePages(); }, 420);
  }
  if (document.body && !nativeObserver) {
    nativeObserver = new MutationObserver(scheduleNativeEnhance);
    nativeObserver.observe(document.body, { childList: true, subtree: true });
  } else document.addEventListener("DOMContentLoaded", () => {
    if (!nativeObserver && document.body) { nativeObserver = new MutationObserver(scheduleNativeEnhance); nativeObserver.observe(document.body, { childList: true, subtree: true }); }
  });

  // ---------- lifecycle ----------
  function sync() {
    const want = root.hasAttribute("data-grx-home");
    if (want && !mounted) mount();
    else if (!want && mounted) unmount();
    if (host) host.setAttribute("data-theme", root.getAttribute("data-grx-theme") || "off");
    if (mounted) observeCards();
    enhanceNativePages();
  }
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-grx-home", "data-grx-theme", "data-grx-tint"] });
  document.addEventListener("DOMContentLoaded", sync);
  if (document.readyState !== "loading") sync();

  let observedPath = location.pathname;
  function routeChanged() {
    if (location.pathname === observedPath) { enhanceNativePages(); return; }
    observedPath = location.pathname;
    ui.section = isShelfRoute() ? "library" : "catalog";
    sync();
    if (mounted) {
      if (isLandingRoute() && !S.socialFeed.length) S.socialFeed = collectNativeFeed();
      renderMain();
    }
    enhanceNativePages();
  }
  globalThis.__grxRouteChanged = routeChanged;
  setInterval(routeChanged, 700);

  // exposed for testing only
  globalThis.__grxLibrary = { parseShelfHTML };
})();
