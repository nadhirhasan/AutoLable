/* Swish Annotator front end: project / image list, canvas box editor, import, Claude auto-label, export. */
"use strict";

const COLORS = ["#ff7a2f", "#3ddc97", "#4d9de0", "#ef5b5b", "#b07bdf", "#42d4f4", "#f032e6", "#bfef45", "#ffd166"];
const ROW_H = 60;               // image list row height (virtual list)
const HANDLE = 7;               // resize handle half-size, screen px
const CLICK_PX = 4;             // a press that moves less than this is a click, screen px
const SAVE_DELAY_MS = 700;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const enc = encodeURIComponent;
const color = (c) => COLORS[c % COLORS.length];
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

const S = {
  projects: [], project: null, images: [], byName: {},
  filter: "all", search: "", view: [],
  idx: -1, name: null, img: null, boxes: [], status: null, loadToken: 0,
  sel: -1, hover: -1, activeClass: 0, tool: "draw", showBoxes: true,
  scale: 1, ox: 0, oy: 0, fitScale: 1,
  undo: [], redo: [], dirty: false, saveTimer: null, saving: null,
  drag: null, mouse: null, spaceDown: false,
  jobs: {}, pollTimer: null, lastSoftRefresh: 0,
  videoFiles: [], imageFiles: [],
  picked: new Set(), anchor: null, confirmResolve: null,
  mode: "home", projSearch: "", projSort: "updated", menuFor: null, lastHomeRefresh: 0,
};

/* ------------------------------------------------------------------ api / ui helpers */
async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 3500);
}

function openModal(id) {
  if (!S.project && !["newProjectModal", "renameModal"].includes(id)) { toast("Open a project first"); return; }
  const prep = { importModal: prepImport, autoModal: prepAuto, classesModal: prepClasses, exportModal: prepExport }[id];
  if (prep) prep();
  $("#" + id).classList.add("open");
}
const closeModals = () => {
  $$(".modal.open").forEach((m) => m.classList.remove("open"));
  if (S.confirmResolve) { S.confirmResolve(false); S.confirmResolve = null; }
};
const modalOpen = () => !!$(".modal.open");

/* ------------------------------------------------------------------ pages / routing */
// #/ = projects home, #/p/<name> = annotation page, #/p/<name>/import|export = open that dialog on arrival
function setMode(m) {
  S.mode = m;
  document.body.classList.toggle("mode-home", m === "home");
  document.body.classList.toggle("mode-editor", m === "editor");
  document.title = m === "editor" && S.project ? `${S.project.name} · Swish Annotator` : "Swish Annotator";
}

async function route() {
  closeMenu();
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(import|export))?$/);
  if (m) await showEditor(decodeURIComponent(m[1]), m[2]);
  else await showHome();
}

async function showHome() {
  await save();
  closeModals();
  S.picked.clear();
  setMode("home");
  await refreshHome();
}

async function showEditor(name, action) {
  setMode("editor");
  resizeCanvas();
  if (!S.project || S.project.name !== name) {
    S.filter = "all"; S.search = ""; S.picked.clear(); $("#search").value = "";
    $$("#filters .chip").forEach((c) => c.classList.toggle("active", c.dataset.filter === "all"));
    try { await loadProject(name); }
    catch (e) { toast(`Could not open ${name}: ${e.message}`, "err"); location.hash = "#/"; return; }
  } else { fit(); drawListRows(); }
  setMode("editor");
  $("#projName").textContent = name;
  if (action) {
    history.replaceState(null, "", `#/p/${enc(name)}`);
    openModal(`${action}Modal`);
  }
}

/* ------------------------------------------------------------------ home: project cards */
async function refreshHome() {
  try {
    S.projects = await api("GET", "/api/projects");
    S.lastHomeRefresh = Date.now();
  } catch (e) { toast(`Server not reachable: ${e.message}`, "err"); return; }
  renderHome();
}
async function refreshHomeIfShown() { if (S.mode === "home") await refreshHome(); }

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function renderHome() {
  const q = S.projSearch;
  let list = S.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.classes.some((c) => c.toLowerCase().includes(q)));
  const by = {
    updated: (a, b) => (b.updated || 0) - (a.updated || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    images: (a, b) => b.images - a.images,
    todo: (a, b) => (b.counts.unlabeled + b.counts.auto) - (a.counts.unlabeled + a.counts.auto),
  }[S.projSort];
  list = list.slice().sort(by);
  const tot = S.projects.reduce((a, p) => a + p.images, 0);
  $("#homeSummary").textContent = S.projects.length
    ? `${S.projects.length} project${S.projects.length === 1 ? "" : "s"} · ${tot} images`
    : "No projects yet. Create one to start labeling.";
  const runWord = { import: "Importing", autolabel: "Claude labeling", export: "Exporting" };
  const card = (p) => {
    const c = p.counts, done = (c.reviewed || 0) + (c.imported || 0), total = p.images || 0;
    const pct = (n) => (total ? (100 * n) / total : 0);
    return `<div class="card" tabindex="0" data-name="${esc(p.name)}">
      <div class="cover">
        ${p.cover ? `<img loading="lazy" alt="" src="/api/projects/${enc(p.name)}/thumbs/${enc(p.cover)}">` : `<div class="cover-empty">No images yet</div>`}
        ${p.job ? `<span class="run-badge">${runWord[p.job.kind] || "Running"} ${p.job.done}${p.job.total ? "/" + p.job.total : ""}</span>` : ""}
        <button class="card-menu-btn" data-menu="${esc(p.name)}" title="Project actions" aria-label="Project actions">⋯</button>
      </div>
      <div class="card-body">
        <div class="card-title" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="card-meta">${total} image${total === 1 ? "" : "s"} · changed ${ago(p.updated)}</div>
        <div class="pbar" title="${done} done · ${c.auto} to review · ${c.unlabeled} to do">
          <span class="ok" style="width:${pct(done)}%"></span><span class="warn" style="width:${pct(c.auto)}%"></span></div>
        <div class="legend"><span><i class="dot st-reviewed"></i>${done} done</span>
          <span><i class="dot st-auto"></i>${c.auto} review</span><span><i class="dot st-unlabeled"></i>${c.unlabeled} to do</span></div>
        <div class="chips">${p.classes.map((n, i) => `<span class="cchip" style="--c:${color(i)}">${esc(n)}</span>`).join("")}</div>
      </div></div>`;
  };
  $("#cards").innerHTML = `<div class="card new-card" tabindex="0" id="newCard"><div class="plus">＋</div><b>New project</b>
      <p class="muted">Pick the classes, import a video, images or a folder, then let Claude pre-label.</p></div>`
    + list.map(card).join("")
    + (S.projects.length && !list.length ? `<div class="home-empty">No project matches “${esc(q)}”.</div>` : "");
}

function openMenu(name, btn) {
  S.menuFor = name;
  const m = $("#cardMenu"), r = btn.getBoundingClientRect();
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  m.style.top = `${r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
}
function closeMenu() { $("#cardMenu").hidden = true; S.menuFor = null; }

async function menuAction(act, name) {
  closeMenu();
  const p = S.projects.find((x) => x.name === name);
  if (!p) return;
  if (act === "open") location.hash = `#/p/${enc(name)}`;
  if (act === "import") location.hash = `#/p/${enc(name)}/import`;
  if (act === "export") location.hash = `#/p/${enc(name)}/export`;
  if (act === "rename") { S.renaming = name; $("#rnName").value = name; openModal("renameModal"); setTimeout(() => $("#rnName").select(), 30); }
  if (act === "delete") await deleteProject(p);
}

async function renameProject() {
  const old = S.renaming, name = $("#rnName").value.trim();
  if (!old || !name) return;
  try {
    const r = await api("POST", `/api/projects/${enc(old)}/rename`, { new_name: name });
    closeModals();
    if (S.project?.name === old) forgetProject();         // reopened fresh under the new name
    toast(r.name === old ? "Name unchanged" : `Renamed to ${r.name}`, "ok");
    await refreshHome();
  } catch (e) { toast(e.message, "err"); }
}

function forgetProject() {     // the open project was renamed / deleted: drop everything the editor held for it
  clearTimeout(S.saveTimer);
  Object.assign(S, { project: null, name: null, img: null, boxes: [], status: null, idx: -1, sel: -1, hover: -1,
                     dirty: false, undo: [], redo: [], images: [], byName: {}, view: [] });
  S.picked.clear();
  S.loadToken++;               // an image still loading for the old project is ignored
}

async function deleteProject(p) {
  if (!await confirmDialog({ title: `Delete project "${p.name}"?`, typeName: p.name, ok: "Delete project",
    body: `${p.images} images, all labels, Claude's answers, uploaded videos and the default export inside the project folder are deleted.\nAn export written to another folder is kept. This can't be undone.` })) return;
  try {
    await api("DELETE", `/api/projects/${enc(p.name)}`);
    if (S.project?.name === p.name) forgetProject();
    toast(`Project ${p.name} deleted`, "ok");
    await refreshHome();
  } catch (e) { toast(e.message, "err"); }
}

async function loadProject(name, keepName) {
  await save();
  const p = await api("GET", `/api/projects/${enc(name)}`);
  S.project = p;
  setImages(p.image_list);
  S.activeClass = clamp(S.activeClass, 0, p.classes.length - 1);
  renderClasses();
  applyFilter(keepName);
  const i = keepName ? S.view.indexOf(keepName) : -1;
  if (S.view.length) await openImage(i >= 0 ? i : 0);
  else { S.name = null; S.img = null; S.boxes = []; showEmpty(true); render(); renderBoxes(); }
}

async function softRefresh() {         // statuses / counts changed in the background (jobs)
  if (!S.project) return;
  const p = await api("GET", `/api/projects/${enc(S.project.name)}`);
  S.project = p;
  setImages(p.image_list);
  applyFilter(S.name, true);
  if (S.name && !S.dirty && S.byName[S.name] && S.byName[S.name].status !== S.status) await reloadLabels();
}

function setImages(list) {
  S.images = list;
  S.byName = Object.fromEntries(list.map((im) => [im.name, im]));
  renderStats();
}

function counts() {
  const c = { all: S.images.length, unlabeled: 0, auto: 0, done: 0 };
  for (const im of S.images) {
    if (im.status === "unlabeled") c.unlabeled++;
    else if (im.status === "auto") c.auto++;
    else c.done++;
  }
  return c;
}

function renderStats() {
  const c = counts();
  $("#cAll").textContent = c.all; $("#cTodo").textContent = c.unlabeled;
  $("#cAuto").textContent = c.auto; $("#cDone").textContent = c.done;
  $("#stats").textContent = S.project ? `${c.all} images · ${c.done} done · ${c.auto} to review · ${c.unlabeled} to do` : "";
}

/* ------------------------------------------------------------------ filtered list (virtual) */
function matches(im) {
  const f = S.filter;
  const okF = f === "all" || (f === "done" ? (im.status === "reviewed" || im.status === "imported") : im.status === f);
  return okF && (!S.search || im.name.toLowerCase().includes(S.search));
}

function applyFilter(keepName, keepScroll) {
  // the open image stays in the list even when it no longer matches, until you move on
  S.view = S.images.filter((im) => matches(im) || im.name === keepName).map((im) => im.name);
  for (const n of [...S.picked]) if (!S.byName[n]) S.picked.delete(n);
  renderBulk();
  S.idx = keepName ? S.view.indexOf(keepName) : -1;
  renderList(keepScroll);
  updatePos();
}

function renderList(keepScroll) {
  const list = $("#imageList");
  let inner = list.firstElementChild;
  if (!inner) { inner = document.createElement("div"); inner.style.position = "relative"; list.appendChild(inner); }
  inner.style.height = `${S.view.length * ROW_H}px`;
  if (!keepScroll && S.idx >= 0) scrollListTo(S.idx);
  drawListRows();
}

function drawListRows() {
  const list = $("#imageList");
  const inner = list.firstElementChild;
  if (!inner) return;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 6);
  const last = Math.min(S.view.length, first + Math.ceil(list.clientHeight / ROW_H) + 12);
  const pname = enc(S.project?.name || "");
  let html = "";
  for (let i = first; i < last; i++) {
    const im = S.byName[S.view[i]];
    if (!im) continue;
    const label = { unlabeled: "to do", auto: "review", reviewed: "done", imported: "imported" }[im.status];
    const picked = S.picked.has(im.name);
    html += `<div class="item ${i === S.idx ? "active" : ""} ${picked ? "picked" : ""}" data-i="${i}" style="position:absolute;left:0;right:0;top:${i * ROW_H}px;height:${ROW_H - 2}px">
      <div class="thumb"><img loading="lazy" src="/api/projects/${pname}/thumbs/${enc(im.name)}" alt="">
      <input type="checkbox" class="pick" ${picked ? "checked" : ""} title="Select (Ctrl+click)"></div>
      <div class="meta"><div class="name" title="${esc(im.name)}">${esc(im.name)}</div>
      <div class="sub"><span class="dot st-${im.status}"></span>${label} · ${im.n} box${im.n === 1 ? "" : "es"}</div></div></div>`;
  }
  inner.innerHTML = html;
  list.classList.toggle("picking", S.picked.size > 0);
}

function scrollListTo(i) {
  const list = $("#imageList");
  const top = i * ROW_H;
  if (top < list.scrollTop || top + ROW_H > list.scrollTop + list.clientHeight)
    list.scrollTop = top - list.clientHeight / 2 + ROW_H / 2;
}

function updatePos() {
  $("#imgPos").textContent = S.idx >= 0 ? `${S.idx + 1} / ${S.view.length}` : `– / ${S.view.length}`;
}

/* ------------------------------------------------------------------ open / save images */
function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("image failed to load"));
    im.src = url;
  });
}

async function openImage(i) {
  if (i < 0 || i >= S.view.length) return;
  await save();
  const token = ++S.loadToken;
  const name = S.view[i];
  const pname = enc(S.project.name);
  try {
    const [lab, img] = await Promise.all([
      api("GET", `/api/projects/${pname}/labels/${enc(name)}`),
      loadImg(`/api/projects/${pname}/images/${enc(name)}`),
    ]);
    if (token !== S.loadToken) return;
    S.idx = i; S.name = name; S.img = img;
    S.boxes = lab.boxes; S.status = lab.status;
    S.sel = -1; S.hover = -1; S.undo = []; S.redo = []; S.dirty = false;
    showEmpty(false);
    fit();
    renderBoxes(); renderStatus(); drawListRows(); scrollListTo(i); updatePos();
    $("#saveState").textContent = "";
    const nxt = S.view[i + 1];                      // warm the cache for the next image
    if (nxt) new Image().src = `/api/projects/${pname}/images/${enc(nxt)}`;
  } catch (e) { toast(`Could not open ${name}: ${e.message}`, "err"); }
}

async function reloadLabels() {
  const lab = await api("GET", `/api/projects/${enc(S.project.name)}/labels/${enc(S.name)}`);
  S.boxes = lab.boxes; S.status = lab.status; S.sel = -1; S.undo = []; S.redo = [];
  renderBoxes(); renderStatus(); render();
}

function markDirty() {
  S.dirty = true;
  $("#saveState").textContent = "● unsaved";
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save(status) {
  clearTimeout(S.saveTimer);
  if (S.saving) await S.saving;
  if (!S.name || (!S.dirty && !status)) return;
  // a hand-edited image that was still "to do" becomes "review", so a Claude "to do" run never overwrites it
  const st = status || (S.status === "unlabeled" ? "auto" : undefined);
  const name = S.name, boxes = S.boxes.map((b) => ({ ...b }));
  S.dirty = false;
  S.saving = api("PUT", `/api/projects/${enc(S.project.name)}/labels/${enc(name)}`, { boxes, status: st })
    .then((r) => {
      const im = S.byName[name];
      if (im) { im.n = r.n; im.status = r.status; }
      if (name === S.name) { S.status = r.status; renderStatus(); $("#saveState").textContent = "saved ✓"; }
      renderStats(); drawListRows();
    })
    .catch((e) => { S.dirty = true; toast(`Save failed: ${e.message}`, "err"); $("#saveState").textContent = "● save failed"; })
    .finally(() => { S.saving = null; });
  await S.saving;
}

async function go(delta) {
  const i = S.idx + delta;
  if (i >= 0 && i < S.view.length) await openImage(i);
}

async function reviewAndNext() {
  if (!S.name) return;
  const nextName = S.view[S.idx + 1];
  S.dirty = true;
  await save("reviewed");
  applyFilter(nextName || S.name, false);
  const i = nextName ? S.view.indexOf(nextName) : S.view.indexOf(S.name);
  if (nextName && i >= 0) await openImage(i);
  else { toast("Last image in this list ✓", "ok"); drawListRows(); }
}

function renderStatus() {
  const b = $("#statusBadge");
  const label = { unlabeled: "To do", auto: "Needs review", reviewed: "Reviewed", imported: "Imported" }[S.status] || "";
  b.className = `badge ${S.status || ""}`;
  b.textContent = label;
}

function showEmpty(on) { $("#empty").hidden = !on; }

/* ------------------------------------------------------------------ edit history */
function snapshot() { return JSON.stringify(S.boxes); }
function pushUndo(snap) { S.undo.push(snap); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
function commit(snap) { if (snap !== snapshot()) { pushUndo(snap); markDirty(); } renderBoxes(); render(); }
function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot()); S.boxes = JSON.parse(S.undo.pop()); keepSel(); markDirty(); renderBoxes(); render();
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot()); S.boxes = JSON.parse(S.redo.pop()); keepSel(); markDirty(); renderBoxes(); render();
}
function keepSel() { if (S.sel >= S.boxes.length) S.sel = -1; }

/* ------------------------------------------------------------------ canvas: view */
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function fit() {
  if (!S.img) return;
  const r = canvas.getBoundingClientRect();
  const pad = 16;
  S.fitScale = Math.min((r.width - 2 * pad) / S.img.naturalWidth, (r.height - 2 * pad) / S.img.naturalHeight);
  S.scale = S.fitScale;
  S.ox = (r.width - S.img.naturalWidth * S.scale) / 2;
  S.oy = (r.height - S.img.naturalHeight * S.scale) / 2;
  render();
}

function zoomAt(factor, sx, sy) {
  if (!S.img) return;
  const ns = clamp(S.scale * factor, S.fitScale * 0.3, 40);
  S.ox = sx - (sx - S.ox) * (ns / S.scale);
  S.oy = sy - (sy - S.oy) * (ns / S.scale);
  S.scale = ns;
  render();
}

const W = () => S.img.naturalWidth, H = () => S.img.naturalHeight;
const toScreen = (b) => ({ x1: S.ox + b.x1 * W() * S.scale, y1: S.oy + b.y1 * H() * S.scale,
                           x2: S.ox + b.x2 * W() * S.scale, y2: S.oy + b.y2 * H() * S.scale });
const toNorm = (sx, sy) => ({ x: (sx - S.ox) / (S.scale * W()), y: (sy - S.oy) / (S.scale * H()) });

/* ------------------------------------------------------------------ canvas: drawing */
function render() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  $("#zoomLabel").textContent = S.img ? `${Math.round(S.scale * 100)}%` : "";
  if (!S.img || !S.project) return;
  ctx.imageSmoothingEnabled = S.scale < 2;
  ctx.drawImage(S.img, S.ox, S.oy, W() * S.scale, H() * S.scale);
  const names = S.project.classes.map((c) => c.name);

  if (S.showBoxes) {
    S.boxes.forEach((b, i) => {
      const s = toScreen(b), c = color(b.c), selected = i === S.sel, hov = i === S.hover;
      ctx.lineWidth = selected ? 2.5 : 2;
      ctx.strokeStyle = c;
      if (selected || hov) { ctx.fillStyle = c + (selected ? "33" : "1f"); ctx.fillRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1); }
      ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
      // label tag
      const text = names[b.c] ?? `#${b.c}`;
      ctx.font = "600 11px Segoe UI, sans-serif";
      const tw = ctx.measureText(text).width + 8;
      const ty = s.y1 - 16 >= 0 ? s.y1 - 16 : s.y1;
      ctx.fillStyle = c;
      ctx.fillRect(s.x1 - (selected ? 1.25 : 1), ty, tw, 16);
      ctx.fillStyle = "#111";
      ctx.fillText(text, s.x1 + 3, ty + 12);
      if (selected) handles(s).forEach(([, hx, hy]) => {
        ctx.fillStyle = "#fff"; ctx.fillRect(hx - HANDLE / 1.4, hy - HANDLE / 1.4, HANDLE * 1.43, HANDLE * 1.43);
        ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.strokeRect(hx - HANDLE / 1.4, hy - HANDLE / 1.4, HANDLE * 1.43, HANDLE * 1.43);
      });
    });
  }

  const d = S.drag;
  if (d && d.type === "draw" && d.moved) {
    const x1 = Math.min(d.sx, d.cx), y1 = Math.min(d.sy, d.cy);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = color(S.activeClass); ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
    ctx.fillStyle = color(S.activeClass) + "22";
    ctx.fillRect(x1, y1, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
    ctx.setLineDash([]);
  }

  // crosshair guides help to place tight box edges
  if (S.mouse && S.tool === "draw" && (!d || d.type === "draw") && !S.spaceDown) {
    const { x, y } = S.mouse;
    ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(r.width, y + .5); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, r.height); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function handles(s) {
  const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
  return [["nw", s.x1, s.y1], ["n", mx, s.y1], ["ne", s.x2, s.y1], ["e", s.x2, my],
          ["se", s.x2, s.y2], ["s", mx, s.y2], ["sw", s.x1, s.y2], ["w", s.x1, my]];
}

/* ------------------------------------------------------------------ canvas: hit tests */
function handleAt(i, x, y) {
  if (i < 0 || !S.boxes[i]) return null;
  const h = handles(toScreen(S.boxes[i])).find(([, hx, hy]) => Math.abs(x - hx) <= HANDLE + 2 && Math.abs(y - hy) <= HANDLE + 2);
  return h ? h[0] : null;
}
function inside(i, x, y) {
  if (i < 0 || !S.boxes[i]) return false;
  const s = toScreen(S.boxes[i]);
  return x >= s.x1 && x <= s.x2 && y >= s.y1 && y <= s.y2;
}
function boxAt(x, y) {           // smallest box under the point (a ball inside a person box wins)
  let best = -1, area = Infinity;
  S.boxes.forEach((b, i) => {
    if (inside(i, x, y)) { const a = (b.x2 - b.x1) * (b.y2 - b.y1); if (a < area) { area = a; best = i; } }
  });
  return best;
}
const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

/* ------------------------------------------------------------------ canvas: mouse */
function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("mousedown", (e) => {
  if (!S.img) return;
  const { x, y } = pos(e);
  const snap = snapshot();
  if (e.button === 1 || e.button === 2 || S.spaceDown) {
    S.drag = { type: "pan", sx: x, sy: y, ox: S.ox, oy: S.oy }; canvas.style.cursor = "grabbing"; return;
  }
  if (e.button !== 0) return;
  const h = S.showBoxes ? handleAt(S.sel, x, y) : null;
  if (h) { S.drag = { type: "resize", h, snap }; return; }
  if (S.tool === "draw") {
    if (S.showBoxes && !e.shiftKey && inside(S.sel, x, y)) { S.drag = { type: "move", sx: x, sy: y, orig: { ...S.boxes[S.sel] }, snap }; return; }
    S.drag = { type: "draw", sx: x, sy: y, cx: x, cy: y, moved: false, snap };
  } else {
    const i = S.showBoxes ? (inside(S.sel, x, y) ? S.sel : boxAt(x, y)) : -1;
    if (i >= 0) { S.sel = i; renderBoxes(); S.drag = { type: "move", sx: x, sy: y, orig: { ...S.boxes[i] }, snap }; render(); }
    else S.drag = { type: "pan", sx: x, sy: y, ox: S.ox, oy: S.oy, click: true };
  }
});

window.addEventListener("mousemove", (e) => {
  if (!S.img) return;
  const { x, y } = pos(e);
  const r = canvas.getBoundingClientRect();
  const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  S.mouse = over ? { x, y } : null;
  const d = S.drag;
  if (over) {
    const n = toNorm(x, y);
    $("#coords").textContent = n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1
      ? `${Math.round(n.x * W())}, ${Math.round(n.y * H())} px` : "";
  }
  if (!d) {
    if (over) {
      const h = S.showBoxes ? handleAt(S.sel, x, y) : null;
      canvas.style.cursor = S.spaceDown ? "grab" : h ? CURSORS[h]
        : (S.showBoxes && inside(S.sel, x, y)) ? "move"
        : S.tool === "draw" ? "crosshair" : (S.showBoxes && boxAt(x, y) >= 0 ? "pointer" : "grab");
      const hv = S.showBoxes ? boxAt(x, y) : -1;
      if (hv !== S.hover) { S.hover = hv; }
      render();
    }
    return;
  }
  if (d.type === "pan") { S.ox = d.ox + x - d.sx; S.oy = d.oy + y - d.sy; if (Math.hypot(x - d.sx, y - d.sy) > CLICK_PX) d.click = false; render(); return; }
  if (d.type === "draw") { d.cx = x; d.cy = y; if (Math.hypot(x - d.sx, y - d.sy) > CLICK_PX) d.moved = true; render(); return; }
  const b = S.boxes[S.sel];
  if (!b) return;
  if (d.type === "move") {
    const dx = (x - d.sx) / (S.scale * W()), dy = (y - d.sy) / (S.scale * H());
    const w = d.orig.x2 - d.orig.x1, hh = d.orig.y2 - d.orig.y1;
    b.x1 = clamp(d.orig.x1 + dx, 0, 1 - w); b.x2 = b.x1 + w;
    b.y1 = clamp(d.orig.y1 + dy, 0, 1 - hh); b.y2 = b.y1 + hh;
  } else if (d.type === "resize") {
    const n = toNorm(x, y), nx = clamp(n.x, 0, 1), ny = clamp(n.y, 0, 1);
    if (d.h.includes("w")) b.x1 = nx; if (d.h.includes("e")) b.x2 = nx;
    if (d.h.includes("n")) b.y1 = ny; if (d.h.includes("s")) b.y2 = ny;
  }
  render();
});

window.addEventListener("mouseup", () => {
  const d = S.drag;
  if (!d) return;
  S.drag = null;
  canvas.style.cursor = "";
  if (d.type === "pan") {
    if (d.click) { S.sel = -1; renderBoxes(); render(); }
    return;
  }
  if (d.type === "draw") {
    if (d.moved) {
      const a = toNorm(Math.min(d.sx, d.cx), Math.min(d.sy, d.cy)), b = toNorm(Math.max(d.sx, d.cx), Math.max(d.sy, d.cy));
      const box = { c: S.activeClass, x1: clamp(a.x, 0, 1), y1: clamp(a.y, 0, 1), x2: clamp(b.x, 0, 1), y2: clamp(b.y, 0, 1) };
      if (box.x2 > box.x1 && box.y2 > box.y1) { S.boxes.push(box); S.sel = S.boxes.length - 1; commit(d.snap); }
      else render();
    } else {
      S.sel = S.showBoxes ? boxAt(d.sx, d.sy) : -1;       // a plain click selects
      renderBoxes(); render();
    }
    return;
  }
  const b = S.boxes[S.sel];
  if (b) {
    [b.x1, b.x2] = [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)];
    [b.y1, b.y2] = [Math.min(b.y1, b.y2), Math.max(b.y1, b.y2)];
    if (b.x2 - b.x1 <= 0 || b.y2 - b.y1 <= 0) S.boxes.splice(S.sel, 1), (S.sel = -1);
  }
  commit(d.snap);
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const { x, y } = pos(e);
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, x, y);
}, { passive: false });
canvas.addEventListener("mouseleave", () => { S.mouse = null; S.hover = -1; $("#coords").textContent = ""; render(); });

/* ------------------------------------------------------------------ side panels */
function renderClasses() {
  if (!S.project) return;
  const n = Array(S.project.classes.length).fill(0);
  S.boxes.forEach((b) => { if (n[b.c] !== undefined) n[b.c]++; });
  $("#classList").innerHTML = S.project.classes.map((c, i) => `
    <div class="cls ${i === S.activeClass ? "active" : ""}" data-c="${i}" title="${esc(c.description || "")}">
      <span class="key">${i < 9 ? i + 1 : ""}</span><span class="sw" style="background:${color(i)}"></span>
      <span>${esc(c.name)}</span><span class="cnt">${n[i] || ""}</span></div>`).join("");
}

function renderBoxes() {
  renderClasses();
  const names = S.project ? S.project.classes : [];
  $("#boxCount").textContent = S.boxes.length ? `${S.boxes.length}` : "";
  $("#boxList").innerHTML = S.boxes.length ? S.boxes.map((b, i) => `
    <div class="boxrow ${i === S.sel ? "sel" : ""}" data-i="${i}">
      <span class="sw" style="background:${color(b.c)}"></span>
      <select data-i="${i}">${names.map((c, k) => `<option value="${k}" ${k === b.c ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <button class="del" data-i="${i}" title="Delete (Del)">✕</button></div>`).join("")
    : `<div class="box-empty">${S.img ? "No boxes yet. Drag on the image to draw one, or press L for Claude." : ""}</div>`;
}

function setActiveClass(c) {
  if (!S.project || c < 0 || c >= S.project.classes.length) return;
  S.activeClass = c;
  if (S.sel >= 0 && S.boxes[S.sel] && S.boxes[S.sel].c !== c) {
    const snap = snapshot(); S.boxes[S.sel].c = c; commit(snap);
  } else { renderClasses(); render(); }
}

function deleteSelected() {
  if (S.sel < 0) return;
  const snap = snapshot(); S.boxes.splice(S.sel, 1); S.sel = -1; commit(snap);
}

function setTool(t) {
  S.tool = t;
  $("#toolDraw").classList.toggle("active", t === "draw");
  $("#toolSelect").classList.toggle("active", t === "select");
  render();
}

async function copyPrevious() {
  if (S.idx <= 0) { toast("No previous image in this list"); return; }
  const prev = S.view[S.idx - 1];
  const lab = await api("GET", `/api/projects/${enc(S.project.name)}/labels/${enc(prev)}`);
  const snap = snapshot();
  S.boxes = lab.boxes; S.sel = -1; commit(snap);
  toast(`Copied ${lab.boxes.length} boxes from ${prev}`);
}

function clearBoxes() {
  if (!S.boxes.length) return;
  const snap = snapshot(); S.boxes = []; S.sel = -1; commit(snap);
}

/* ------------------------------------------------------------------ keyboard */
window.addEventListener("keydown", async (e) => {
  if (e.key === "Escape" && modalOpen()) { closeModals(); return; }
  if (e.key === "Escape" && S.menuFor) { closeMenu(); return; }
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (modalOpen() || ["input", "textarea", "select"].includes(tag)) return;
  if (S.mode !== "editor") return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === " ") { S.spaceDown = true; canvas.style.cursor = "grab"; e.preventDefault(); return; }
  if (ctrl && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === "s") { e.preventDefault(); S.dirty = true; await save(); return; }
  if (ctrl && k === "Delete") { e.preventDefault(); await deleteCurrentImage(); return; }
  if (ctrl) return;
  if (/^[1-9]$/.test(k)) { setActiveClass(Number(k) - 1); return; }
  if (S.sel >= 0 && k.startsWith("Arrow")) {           // nudge the selected box by screen pixels
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) / S.scale;
    const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
    const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
    const b = S.boxes[S.sel], snap = snapshot(), w = b.x2 - b.x1, h = b.y2 - b.y1;
    b.x1 = clamp(b.x1 + dx / W(), 0, 1 - w); b.x2 = b.x1 + w;
    b.y1 = clamp(b.y1 + dy / H(), 0, 1 - h); b.y2 = b.y1 + h;
    commit(snap); return;
  }
  switch (k) {
    case "Delete": case "Backspace": e.preventDefault(); e.shiftKey ? clearBoxes() : deleteSelected(); break;
    case "Enter": e.preventDefault(); await reviewAndNext(); break;
    case "a": case "A": case "ArrowLeft": await go(-1); break;
    case "d": case "D": case "ArrowRight": await go(1); break;
    case "ArrowUp": await go(-1); break;
    case "ArrowDown": await go(1); break;
    case "Escape": S.sel = -1; S.drag = null; renderBoxes(); render(); break;
    case "Tab": e.preventDefault(); if (S.boxes.length) { S.sel = (S.sel + (e.shiftKey ? -1 + S.boxes.length : 1)) % S.boxes.length; renderBoxes(); render(); } break;
    case "f": case "F": fit(); break;
    case "h": case "H": toggleBoxes(); break;
    case "b": case "B": setTool("draw"); break;
    case "v": case "V": setTool("select"); break;
    case "l": case "L": await autoLabelCurrent(); break;
    case "p": case "P": await copyPrevious(); break;
    case "+": case "=": zoomCenter(1.25); break;
    case "-": zoomCenter(0.8); break;
  }
});
window.addEventListener("keyup", (e) => { if (e.key === " ") { S.spaceDown = false; canvas.style.cursor = ""; render(); } });

function zoomCenter(f) { const r = canvas.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }
function toggleBoxes() { S.showBoxes = !S.showBoxes; $("#toggleBoxes").classList.toggle("active", !S.showBoxes); render(); }

/* ------------------------------------------------------------------ jobs */
function trackJob(job) {
  if (!job) return;
  S.jobs[job.id] = job;
  renderJobs();
  if (!S.pollTimer) S.pollTimer = setInterval(pollJobs, 1000);
}

async function pollJobs() {
  const running = Object.values(S.jobs).filter((j) => j.state === "running");
  if (!running.length) { clearInterval(S.pollTimer); S.pollTimer = null; return; }
  for (const j of running) {
    try {
      const info = await api("GET", `/api/jobs/${j.id}`);
      S.jobs[j.id] = info;
      if (info.state !== "running") onJobFinished(info);
    } catch (e) { j.state = "error"; j.message = e.message; }
  }
  renderJobs();
  if (S.mode === "home" && Date.now() - S.lastHomeRefresh > 2000) refreshHome();
  if (S.mode === "editor" && running.some((j) => j.project === S.project?.name) && Date.now() - S.lastSoftRefresh > 3000) {
    S.lastSoftRefresh = Date.now();
    softRefresh().catch(() => {});
  }
}

async function onJobFinished(j) {
  const what = { import: "Import", autolabel: "Auto-label", export: "Export" }[j.kind];
  if (j.state === "done") toast(`${what} finished: ${j.done} ok${j.failed ? `, ${j.failed} failed (${j.errors?.[0] || ""})` : ""}`, j.failed ? "err" : "ok");
  else if (j.state === "error") toast(`${what} failed: ${j.message}`, "err");
  else toast(`${what} cancelled`);
  if (j.errors?.length) console.warn(`${what} errors`, j.errors);
  if (j.kind === "export" && j.result) showExportResult(j.result);
  if (S.mode === "home") await refreshHome();
  else if (j.project === S.project?.name) {
    if (j.kind === "import" && !S.name) await loadProject(j.project);
    else await softRefresh();
  }
  setTimeout(() => { delete S.jobs[j.id]; renderJobs(); }, 8000);
}

function renderJobs() {
  $("#jobs").innerHTML = Object.values(S.jobs).map((j) => {
    const what = { import: "Importing", autolabel: "Claude labeling", export: "Exporting" }[j.kind];
    const pct = j.total ? Math.round(100 * (j.done + j.failed) / j.total) : (j.state === "running" ? 5 : 100);
    const title = [j.message, ...(j.errors || [])].filter(Boolean).join("\n");
    return `<div class="job ${j.state}" title="${esc(title)}"><span>${what} ${j.done}${j.total ? "/" + j.total : ""}${j.failed ? ` · ${j.failed}✕` : ""}</span>
      <div class="bar"><div style="width:${pct}%"></div></div>
      ${j.state === "running" ? `<button data-cancel="${j.id}" title="Cancel">✕</button>` : `<button data-dismiss="${j.id}">✓</button>`}</div>`;
  }).join("");
}

async function autoLabelCurrent() {
  if (!S.name) return;
  if ((S.status === "reviewed" || S.status === "imported") && !await confirmDialog({
    title: "Replace reviewed boxes?", body: "This image is already reviewed. Replace its boxes with Claude's?", ok: "Replace" })) return;
  S.dirty && await save();
  try {
    const r = await api("POST", `/api/projects/${enc(S.project.name)}/autolabel`, { scope: "list", names: [S.name] });
    trackJob(r.job);
    toast("Claude is labeling this image…");
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------------ import modal */
function prepImport() { $("#uploadProgress").hidden = true; }

function activeTab() { return $("#importTabs .tab.active").dataset.tab; }

function wireDrop(zoneId, inputId, pickId, chosenId, key, exts) {
  const zone = $(zoneId), input = $(inputId);
  const take = (files) => {
    S[key] = [...files].filter((f) => exts.test(f.name));
    $(chosenId).textContent = S[key].length ? `${S[key].length} file(s): ${S[key].slice(0, 3).map((f) => f.name).join(", ")}${S[key].length > 3 ? "…" : ""}` : "nothing chosen";
  };
  $(pickId).addEventListener("click", (e) => { e.preventDefault(); input.click(); });
  input.addEventListener("change", () => take(input.files));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); take(e.dataTransfer.files); });
}

function upload(files, fields, onProgress) {
  return new Promise((res, rej) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, v));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${enc(S.project.name)}/import/upload`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch (_) {}
      xhr.status < 300 ? res(j) : rej(new Error(j.detail || xhr.statusText));
    };
    xhr.onerror = () => rej(new Error("upload failed"));
    xhr.send(fd);
  });
}

function setProgress(frac, text) {
  const p = $("#uploadProgress");
  p.hidden = false;
  p.querySelector("div").style.width = `${Math.round(frac * 100)}%`;
  p.querySelector("span").textContent = text;
}

function videoOpts() {
  return { every_s: Number($("#everyS").value) || 0, start_s: Number($("#startS").value) || 0,
           end_s: Number($("#endS").value) || 0, max_frames: Number($("#maxFrames").value) || 0 };
}

async function doImport() {
  const tab = activeTab(), pname = enc(S.project.name);
  const btn = $("#importGo");
  btn.disabled = true;
  try {
    if (tab === "tabVideo") {
      const path = $("#videoPath").value.trim();
      if (S.videoFiles.length) {
        const r = await upload(S.videoFiles, videoOpts(), (f) => setProgress(f, `Uploading ${Math.round(f * 100)}%`));
        trackJob(r.job);
      } else if (path) {
        const r = await api("POST", `/api/projects/${pname}/import/path`, { path, ...videoOpts() });
        trackJob(r.job);
      } else { toast("Choose a video or type its path"); return; }
      toast("Splitting the video into frames…");
    } else if (tab === "tabImages") {
      const files = S.imageFiles;
      if (!files.length) { toast("Choose some images"); return; }
      const CHUNK = 40;
      for (let i = 0; i < files.length; i += CHUNK) {
        const part = files.slice(i, i + CHUNK);
        await upload(part, {}, (f) => setProgress((i + f * part.length) / files.length, `Uploading ${Math.min(i + CHUNK, files.length)} / ${files.length}`));
      }
      toast(`Imported ${files.length} images`, "ok");
      S.imageFiles = []; $("#imageChosen").textContent = "jpg, png, webp, bmp";
      await loadProject(S.project.name, S.name);
    } else {
      const path = $("#folderPath").value.trim();
      if (!path) { toast("Type a folder path"); return; }
      const r = await api("POST", `/api/projects/${pname}/import/path`, {
        path, ...videoOpts(), recursive: $("#folderRecursive").checked,
        labels: $("#folderLabels").checked, videos: $("#folderVideos").checked,
      });
      trackJob(r.job);
      toast("Importing…");
    }
    S.videoFiles = []; $("#videoChosen").textContent = "mp4, avi, mov, mkv…";
    closeModals();
  } catch (e) { toast(e.message, "err"); }
  finally { btn.disabled = false; }
}

/* ------------------------------------------------------------------ auto-label modal */
function prepAuto() {
  const c = counts(), s = S.project.settings;
  $("#asTodo").textContent = `(${c.unlabeled})`;
  $("#asNotRev").textContent = `(${c.unlabeled + c.auto})`;
  $("#asFiltered").textContent = `(${filteredForClaude().length})`;
  $("#asBackend").value = s.backend || "claude_code";
  $("#asModel").value = s.model; $("#asEffort").value = s.effort; $("#asWorkers").value = s.workers;
  $("#asScene").value = s.scene || ""; $("#asHint").value = s.hint || "";
  backendNote();
}
function backendNote() {
  $("#asBackendNote").textContent = $("#asBackend").value === "claude_code"
    ? "Runs `claude -p` with your Claude Code login (any API key in the environment is ignored). Counts against your plan's usage limits: the run stops at the limit and “Images still to do” continues later. Keep parallel requests at 2–3."
    : "Needs ANTHROPIC_API_KEY set in the terminal that started the annotator; billed per token.";
}
const filteredForClaude = () => S.view.filter((n) => ["unlabeled", "auto"].includes(S.byName[n]?.status));

async function doAuto() {
  const scope = $("input[name=scope]:checked").value;
  const settings = { backend: $("#asBackend").value, model: $("#asModel").value, effort: $("#asEffort").value, workers: Number($("#asWorkers").value) || 4,
                     scene: $("#asScene").value, hint: $("#asHint").value };
  let body = { scope, settings };
  if (scope === "filtered") body = { scope: "list", names: filteredForClaude(), settings };
  if (scope === "current") {
    if (!S.name) return;
    body = { scope: "list", names: [S.name], settings };
  }
  try {
    await save();
    const r = await api("POST", `/api/projects/${enc(S.project.name)}/autolabel`, body);
    S.project.settings = { ...S.project.settings, ...settings };
    trackJob(r.job);
    closeModals();
    toast(`Claude is labeling ${r.job.total} image(s)…`);
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------------ classes modal */
let classDraft = [];
function prepClasses() {
  classDraft = S.project.classes.map((c, i) => ({ name: c.name, description: c.description || "", src: i }));
  drawClassEditor();
}
function drawClassEditor() {
  $("#classEditor").innerHTML = classDraft.map((c, i) => `
    <div class="crow" data-i="${i}">
      <span class="idx" style="color:${color(i)}">${i}</span>
      <input data-f="name" value="${esc(c.name)}" placeholder="name">
      <textarea data-f="description" placeholder="What counts as this class (sent to Claude)">${esc(c.description)}</textarea>
      <div class="ops"><button data-op="up" title="Move up">▲</button><button data-op="down" title="Move down">▼</button>
        <button data-op="rm" class="rm" title="Delete class">✕</button></div></div>`).join("");
}
async function saveClasses() {
  const list = classDraft.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name);
  const removed = S.project.classes.filter((_, i) => !list.some((c) => c.src === i)).map((c) => c.name);
  if (removed.length && !await confirmDialog({ title: "Delete classes?",
    body: `Delete class(es) ${removed.join(", ")} and all their boxes in every image? This can't be undone.` })) return;
  try {
    await save();
    await api("PUT", `/api/projects/${enc(S.project.name)}/classes`, { classes: list });
    closeModals();
    toast("Classes saved", "ok");
    await loadProject(S.project.name, S.name);
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------------ export modal */
function prepExport() {
  const c = S.images.reduce((a, im) => (a[im.status] = (a[im.status] || 0) + 1, a), {});
  $("#exOut").value ||= S.project.default_export;
  $("#exAutoN").textContent = c.auto || 0;
  const upd = () => { $("#exN").textContent = (c.reviewed || 0) + (c.imported || 0) + ($("#exAuto").checked ? (c.auto || 0) : 0); };
  $("#exAuto").onchange = upd; upd();
  $("#exportResult").hidden = true;
}
async function doExport() {
  try {
    await save();
    const r = await api("POST", `/api/projects/${enc(S.project.name)}/export`, {
      out: $("#exOut").value, val: (Number($("#exVal").value) || 0) / 100, test: (Number($("#exTest").value) || 0) / 100,
      group_s: Number($("#exGroup").value) || 0, include_auto: $("#exAuto").checked,
    });
    trackJob(r.job);
    $("#exportResult").hidden = false;
    $("#exportResult").innerHTML = "Exporting…";
  } catch (e) { toast(e.message, "err"); }
}
function showExportResult(res) {
  if (!$("#exportModal").classList.contains("open")) openModal("exportModal");
  const el = $("#exportResult");
  const classes = S.project.classes.map((c) => c.name);
  const rows = Object.entries(res.counts).map(([split, v]) =>
    `<tr><td>${split}${split === "test" && res.mirrored_test ? " (copy of valid)" : ""}</td><td>${v.images}</td>${classes.map((c) => `<td>${v.boxes[c] || 0}</td>`).join("")}</tr>`).join("");
  el.hidden = false;
  el.innerHTML = `<b>Saved to</b> <code>${esc(res.out)}</code>
    <table><tr><th>split</th><th>images</th>${classes.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows}</table>
    <div>Train YOLO (yolo26):</div><pre>${esc(res.yolo)}</pre>
    <div>Train RF-DETR:</div><pre>${esc(res.rfdetr)}</pre>`;
}


/* ------------------------------------------------------------------ confirm dialog */
function confirmDialog({ title, body, ok = "Delete", danger = true, typeName = "" }) {
  if (S.confirmResolve) S.confirmResolve(false);
  $("#cfTitle").textContent = title;
  $("#cfBody").textContent = body;
  $("#cfOk").textContent = ok;
  $("#cfOk").className = `btn ${danger ? "danger" : "primary"}`;
  $("#cfTypeWrap").hidden = !typeName;
  $("#cfTypeName").textContent = typeName;
  $("#cfType").value = "";
  $("#cfOk").disabled = !!typeName;
  $("#confirmModal").classList.add("open");
  setTimeout(() => (typeName ? $("#cfType") : $("#cfOk")).focus(), 30);
  return new Promise((res) => { S.confirmResolve = res; });
}
function finishConfirm(v) {
  const res = S.confirmResolve;
  S.confirmResolve = null;
  $("#confirmModal").classList.remove("open");
  if (res) res(v);
}

/* ------------------------------------------------------------------ selection + delete */
function togglePick(name) {
  if (!name) return;
  S.picked.has(name) ? S.picked.delete(name) : S.picked.add(name);
  renderBulk(); drawListRows();
}
function pickRange(a, b) {
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
  for (let i = lo; i <= hi; i++) if (S.view[i]) S.picked.add(S.view[i]);
  renderBulk(); drawListRows();
}
function renderBulk() {
  const n = S.picked.size;
  $("#bulkbar").hidden = n === 0;
  $("#pickedN").textContent = n;
  const all = $("#pickAll");
  all.checked = n > 0 && S.view.length > 0 && S.view.every((v) => S.picked.has(v));
  all.indeterminate = n > 0 && !all.checked;
}

function nextSurvivor(removed) {   // the image to show after `removed` names disappear from the list
  const gone = new Set(removed);
  for (let i = S.idx + 1; i < S.view.length; i++) if (!gone.has(S.view[i])) return S.view[i];
  for (let i = S.idx - 1; i >= 0; i--) if (!gone.has(S.view[i])) return S.view[i];
  return null;
}

async function bulkAction(action) {
  const names = S.view.filter((n) => S.picked.has(n)).concat([...S.picked].filter((n) => !S.view.includes(n)));
  if (!names.length) return;
  const pname = enc(S.project.name), many = `${names.length} image${names.length === 1 ? "" : "s"}`;
  try {
    if (action === "autolabel") {
      const done = names.filter((n) => ["reviewed", "imported"].includes(S.byName[n]?.status)).length;
      if (done && !await confirmDialog({ title: "Replace reviewed boxes?", ok: "Auto-label all",
        body: `${done} of the ${many} are already reviewed. Claude will replace their boxes too.` })) return;
      await save();
      const r = await api("POST", `/api/projects/${pname}/autolabel`, { scope: "list", names });
      trackJob(r.job);
      toast(`Claude is labeling ${many}…`);
    } else if (action === "reviewed") {
      await save();
      await api("POST", `/api/projects/${pname}/images/bulk`, { names, action });
      toast(`Marked ${many} reviewed`, "ok");
      await softRefresh();
    } else if (action === "reset") {
      if (!await confirmDialog({ title: `Reset ${many}?`, ok: "Reset",
        body: `Removes all boxes from the ${many} and puts them back to "To do". This can't be undone.` })) return;
      if (names.includes(S.name)) S.dirty = false;
      await api("POST", `/api/projects/${pname}/images/bulk`, { names, action });
      toast(`Reset ${many}`, "ok");
      await softRefresh();
      if (names.includes(S.name)) await reloadLabels();
    } else if (action === "delete") {
      if (!await confirmDialog({ title: `Delete ${many}?`,
        body: `The ${many} and their labels are removed from the project. This can't be undone.` })) return;
      const keep = names.includes(S.name) ? nextSurvivor(names) : S.name;
      if (names.includes(S.name)) S.dirty = false;
      await api("POST", `/api/projects/${pname}/images/bulk`, { names, action });
      toast(`Deleted ${many}`, "ok");
      S.picked.clear();
      await loadProject(S.project.name, keep);
      await refreshHomeIfShown();
      return;
    }
    S.picked.clear(); renderBulk(); drawListRows();
  } catch (e) { toast(e.message, "err"); }
}

async function deleteCurrentImage() {
  if (!S.name) return;
  const name = S.name;
  if (!await confirmDialog({ title: "Delete this image?",
    body: `${name} and its labels are removed from the project. This can't be undone.` })) return;
  try {
    const keep = nextSurvivor([name]);
    S.dirty = false;
    await api("DELETE", `/api/projects/${enc(S.project.name)}/images/${enc(name)}`);
    S.picked.delete(name);
    toast(`Deleted ${name}`, "ok");
    await loadProject(S.project.name, keep);
    await refreshHomeIfShown();
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------------ misc */
function localStorageGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

async function createProject() {
  const name = $("#npName").value.trim();
  const preset = $("#npPreset").value;
  const classes = (preset === "custom" ? $("#npCustom").value : preset).split(",").map((s) => s.trim()).filter(Boolean);
  if (!name) { toast("Give the project a name"); return; }
  if (!classes.length) { toast("Give at least one class"); return; }
  try {
    const p = await api("POST", "/api/projects", { name, classes });
    closeModals();
    toast(`Project ${p.name} created. Import some media next.`, "ok");
    location.hash = `#/p/${enc(p.name)}/import`;
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $$("[data-modal]").forEach((b) => b.addEventListener("click", () => openModal(b.dataset.modal)));
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
  $$(".modal").forEach((m) => m.addEventListener("mousedown", (e) => { if (e.target === m) closeModals(); }));
  const newProject = () => { $("#npName").value = ""; openModal("newProjectModal"); setTimeout(() => $("#npName").focus(), 50); };
  $("#newProjectBtn").onclick = newProject;
  $("#cards").addEventListener("click", (e) => {
    const mb = e.target.closest("[data-menu]");
    if (mb) { e.stopPropagation(); S.menuFor === mb.dataset.menu ? closeMenu() : openMenu(mb.dataset.menu, mb); return; }
    if (e.target.closest("#newCard")) { newProject(); return; }
    const c = e.target.closest(".card[data-name]");
    if (c) location.hash = `#/p/${enc(c.dataset.name)}`;
  });
  $("#cards").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.closest("[data-menu]")) return;
    if (e.target.id === "newCard") newProject();
    else if (e.target.dataset.name) location.hash = `#/p/${enc(e.target.dataset.name)}`;
  });
  $("#cardMenu").addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) menuAction(b.dataset.act, S.menuFor); });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#cardMenu, [data-menu]")) closeMenu(); });
  $("#homeView").addEventListener("scroll", closeMenu);
  let ps; $("#projSearch").addEventListener("input", (e) => { clearTimeout(ps); ps = setTimeout(() => { S.projSearch = e.target.value.trim().toLowerCase(); renderHome(); }, 120); });
  $("#projSort").value = S.projSort = localStorageGet("swish.sort") || "updated";
  $("#projSort").onchange = (e) => { S.projSort = e.target.value; localStorageSet("swish.sort", S.projSort); renderHome(); };
  $("#rnGo").onclick = renameProject;
  $("#rnName").addEventListener("keydown", (e) => e.key === "Enter" && renameProject());
  window.addEventListener("hashchange", route);
  $("#npPreset").onchange = () => { $("#npCustomWrap").hidden = $("#npPreset").value !== "custom"; };
  $("#npCreate").onclick = createProject;
  $("#npName").addEventListener("keydown", (e) => e.key === "Enter" && createProject());

  const refilter = async () => {           // keep the open image if it matches, else jump to the first match
    const cur = S.byName[S.name];
    applyFilter(cur && matches(cur) ? S.name : null);
    if (S.idx < 0 && S.view.length) await openImage(0);
  };
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    $$("#filters .chip").forEach((c) => c.classList.toggle("active", c === b));
    S.filter = b.dataset.filter; refilter();
  });
  let st; $("#search").addEventListener("input", (e) => { clearTimeout(st); st = setTimeout(() => { S.search = e.target.value.trim().toLowerCase(); refilter(); }, 150); });
  $("#imageList").addEventListener("scroll", drawListRows);
  $("#imageList").addEventListener("click", (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const i = Number(it.dataset.i);
    if (e.target.classList.contains("pick") || e.ctrlKey || e.metaKey) { togglePick(S.view[i]); S.anchor = i; }
    else if (e.shiftKey) pickRange(S.anchor ?? Math.max(S.idx, 0), i);
    else openImage(i);
  });
  $("#pickAll").onchange = (e) => { S.picked = e.target.checked ? new Set(S.view) : new Set(); renderBulk(); drawListRows(); };
  $("#pickClear").onclick = () => { S.picked.clear(); renderBulk(); drawListRows(); };
  $("#bulkbar").addEventListener("click", (e) => { const b = e.target.closest("[data-bulk]"); if (b) bulkAction(b.dataset.bulk); });
  $("#deleteImageBtn").onclick = deleteCurrentImage;
  $("#cfOk").onclick = () => finishConfirm(true);
  $("#cfCancel").onclick = () => finishConfirm(false);
  $("#cfType").addEventListener("input", () => { $("#cfOk").disabled = $("#cfType").value.trim() !== $("#cfTypeName").textContent; });
  $("#cfType").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("#cfOk").disabled) finishConfirm(true); });

  $("#toolDraw").onclick = () => setTool("draw");
  $("#toolSelect").onclick = () => setTool("select");
  $("#zoomIn").onclick = () => zoomCenter(1.25);
  $("#zoomOut").onclick = () => zoomCenter(0.8);
  $("#zoomFit").onclick = fit;
  $("#toggleBoxes").onclick = toggleBoxes;
  $("#prevBtn").onclick = () => go(-1);
  $("#nextBtn").onclick = () => go(1);
  $("#reviewBtn").onclick = reviewAndNext;
  $("#autoOneBtn").onclick = autoLabelCurrent;
  $("#copyPrevBtn").onclick = copyPrevious;
  $("#clearBtn").onclick = clearBoxes;

  $("#classList").addEventListener("click", (e) => { const c = e.target.closest(".cls"); if (c) setActiveClass(Number(c.dataset.c)); });
  $("#boxList").addEventListener("click", (e) => {
    const del = e.target.closest(".del");
    if (del) { S.sel = Number(del.dataset.i); deleteSelected(); return; }
    const row = e.target.closest(".boxrow");
    if (row && e.target.tagName !== "SELECT") { S.sel = Number(row.dataset.i); renderBoxes(); render(); }
  });
  $("#boxList").addEventListener("change", (e) => {
    if (e.target.tagName !== "SELECT") return;
    const i = Number(e.target.dataset.i), snap = snapshot();
    S.boxes[i].c = Number(e.target.value); S.sel = i; commit(snap); e.target.blur();
  });
  $("#boxList").addEventListener("mouseover", (e) => { const r = e.target.closest(".boxrow"); const h = r ? Number(r.dataset.i) : -1; if (h !== S.hover) { S.hover = h; render(); } });

  $("#importTabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab"); if (!t) return;
    $$("#importTabs .tab").forEach((x) => x.classList.toggle("active", x === t));
    $$("#importModal .tab-body").forEach((b) => (b.hidden = b.id !== t.dataset.tab));
  });
  wireDrop("#videoDrop", "#videoFiles", "#videoPick", "#videoChosen", "videoFiles", /\.(mp4|avi|mov|mkv|m4v|webm)$/i);
  wireDrop("#imageDrop", "#imageFiles", "#imagePick", "#imageChosen", "imageFiles", /\.(jpe?g|png|webp|bmp)$/i);
  $("#importGo").onclick = doImport;
  $("#autoGo").onclick = doAuto;
  $("#asBackend").onchange = backendNote;

  $("#addClass").onclick = () => { classDraft.push({ name: "", description: "", src: null }); drawClassEditor(); };
  $("#classEditor").addEventListener("input", (e) => { const r = e.target.closest(".crow"); if (r && e.target.dataset.f) classDraft[Number(r.dataset.i)][e.target.dataset.f] = e.target.value; });
  $("#classEditor").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const i = Number(b.closest(".crow").dataset.i);
    if (b.dataset.op === "rm") classDraft.splice(i, 1);
    if (b.dataset.op === "up" && i > 0) [classDraft[i - 1], classDraft[i]] = [classDraft[i], classDraft[i - 1]];
    if (b.dataset.op === "down" && i < classDraft.length - 1) [classDraft[i + 1], classDraft[i]] = [classDraft[i], classDraft[i + 1]];
    drawClassEditor();
  });
  $("#saveClasses").onclick = saveClasses;
  $("#exportGo").onclick = doExport;

  $("#jobs").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-cancel]"), d = e.target.closest("[data-dismiss]");
    if (c) await api("POST", `/api/jobs/${c.dataset.cancel}/cancel`).catch(() => {});
    if (d) { delete S.jobs[d.dataset.dismiss]; renderJobs(); }
  });

  window.addEventListener("resize", () => { resizeCanvas(); drawListRows(); });
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { save(); e.preventDefault(); e.returnValue = ""; } });
}

(async function init() {
  wire();
  resizeCanvas();
  renderBoxes();
  try {
    (await api("GET", "/api/jobs")).filter((j) => j.state === "running").forEach(trackJob);
  } catch (e) { toast(`Server not reachable: ${e.message}`, "err"); }
  await route();
})();
