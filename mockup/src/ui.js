/* ============================================================================
   ui.js — app state, render loop, event delegation, icons, shared helpers.
   Dependency-free. Full re-render on discrete actions; text/range inputs use
   targeted DOM patches so focus is never lost.
   ============================================================================ */

const state = {
  session: null,               // { userId, remember }
  screen: "login",
  authView: "login",           // login | register | forgot
  registered: false,
  theme: null,                 // null=follow OS; 'light'|'dark' override
  activeBatchId: null,
  activeCarrierDot: null,
  profileFromBatch: null,
  profileTab: "overview",
  profileVariant: "console",    // console | dossier | ledger  (F7 — 3 variants)
  wizard: null,                 // multi-step new-search draft
  builder: null,                // (legacy) working search definition
  list: { status: "all", q: "", view: "list", insurance: "any", size: "any", contact: "any", warnings: false, sort: "name" },
  selection: {},               // dot -> true
  overrides: {                 // mock mutations layered over seed data
    status: {},                // "batchId:dot" -> status
    dnc: {},                   // dot -> bool
    promoted: {},              // dot -> ms  (F23 Mark as Promoted)
    userStatus: {},            // userId -> {status, role}
    logs: [],                  // new contact logs {dot,batch_id,user_id,at,channel,disposition,notes,next_steps}
    activity: [],              // new activity {id,batch_id,type,actor_id,at,payload,body}
    newBatches: []             // batch ids created this session
  },
  modal: null,                 // { type, ...data }
  menu: null,                  // { type, x, y, ...data }
  toasts: [],
  focus: null,                 // selector to focus after render
  feedOpen: false,             // batch activity feed expanded? (F32: collapsed default)
  mapView: {},                 // mapId -> viewBox string (pan/zoom state, survives re-render)
  dashJobs: {}                 // batchId -> true (F30: dashboard map job toggles; empty = empty map)
};

/* F29: map pan/zoom on the SVG viewBox. Base box is 0 0 640 520. */
const MAP_BASE = { x:0, y:0, w:640, h:520 };
function mapVB(id) {
  const s = state.mapView[id];
  if (!s) return { ...MAP_BASE };
  const p = s.split(" ").map(Number);
  return { x:p[0], y:p[1], w:p[2], h:p[3] };
}
function setMapVB(id, vb) {
  const clampW = Math.max(70, Math.min(768, vb.w));
  const k = clampW / vb.w; vb.w = clampW; vb.h = vb.h * k;
  vb.x = Math.max(-160, Math.min(800 - vb.w * 0.2, vb.x));
  vb.y = Math.max(-130, Math.min(650 - vb.h * 0.2, vb.y));
  state.mapView[id] = vb.x.toFixed(1) + " " + vb.y.toFixed(1) + " " + vb.w.toFixed(1) + " " + vb.h.toFixed(1);
  const el = document.querySelector('.map[data-mapid="' + id + '"] svg');
  if (el) el.setAttribute("viewBox", state.mapView[id]);
}
function mapZoomAt(id, factor, fx, fy) {
  const vb = mapVB(id);
  const nw = vb.w / factor, nh = vb.h / factor;
  setMapVB(id, { x: vb.x + (vb.w - nw) * (fx == null ? 0.5 : fx), y: vb.y + (vb.h - nh) * (fy == null ? 0.5 : fy), w: nw, h: nh });
}
function zoomToBox(id, x0, y0, x1, y1, pad) {
  pad = pad == null ? 30 : pad;
  const w = Math.max(60, (x1 - x0) + pad * 2), h = Math.max(50, (y1 - y0) + pad * 2);
  // keep aspect of base (640x520)
  const ar = MAP_BASE.w / MAP_BASE.h; let W = w, H = h;
  if (W / H > ar) H = W / ar; else W = H * ar;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  setMapVB(id, { x: cx - W / 2, y: cy - H / 2, w: W, h: H });
}

/* ------------------------------- icons ------------------------------- */
const ICONS = {
  truck:'<path d="M1 3h14v10H1z"/><path d="M15 6h4l4 4v3h-8z"/><circle cx="5.5" cy="17.5" r="2.2"/><circle cx="18" cy="17.5" r="2.2"/>',
  layers:'<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  search:'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  pin:'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  phone:'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  check:'<polyline points="20 6 9 17 4 12"/>',
  x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  filter:'<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  list:'<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  mapicon:'<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  chevR:'<polyline points="9 18 15 12 9 6"/>',
  chevD:'<polyline points="6 9 12 15 18 9"/>',
  chevL:'<polyline points="15 18 9 12 15 6"/>',
  sun:'<circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
  moon:'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  edit:'<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/>',
  message:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send:'<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  printer:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  alert:'<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  route:'<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 4-4V9"/><path d="M6 16V9"/>',
  arrowR:'<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  eye:'<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  usercheck:'<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
  sliders:'<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  activity:'<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  building:'<path d="M3 21h18"/><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M15 21v-6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6"/><path d="M9 7h2M9 11h2"/>',
  shieldcheck:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11.5 14.5 16 10"/>',
  dots:'<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  nail:'<path d="M7 3h10l-3 4v3l2 2-3 1v3l-1 4-1-4v-3l-3-1 2-2V7z" fill="currentColor" stroke="none"/>',
  external:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  star:'<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  copy:'<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  comment:'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  grip:'<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>'
};
function icon(name, cls) {
  return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + '</svg>';
}

/* ------------------------------- helpers ------------------------------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function cur() { return state.session ? DB.userById[state.session.userId] : null; }
function fmtRel(ms) {
  const d = NOW_MS - ms;
  if (d < 0) { const f = -d; if (f < HOUR) return "in " + Math.max(1, Math.round(f/60000)) + "m"; if (f < DAY) return "in " + Math.round(f/HOUR) + "h"; return "in " + Math.round(f/DAY) + "d"; }
  if (d < 60000) return "just now";
  if (d < HOUR) return Math.round(d/60000) + "m ago";
  if (d < DAY) return Math.round(d/HOUR) + "h ago";
  if (d < 2*DAY) return "yesterday";
  if (d < 7*DAY) return Math.round(d/DAY) + "d ago";
  const dt = new Date(ms), mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return mo[dt.getUTCMonth()] + " " + dt.getUTCDate();
}
/* F36/G14: standardized money format — $X.X MM / $NNN K */
function fmtMoney(n) { if (!n) return "None"; if (n >= 1e6) return "$" + (n/1e6).toFixed(1) + " MM"; if (n >= 1e3) return "$" + Math.round(n/1e3) + " K"; return "$" + n; }
const STATUS = {
  new:{label:"New",cls:"new"}, attempted:{label:"Attempted",cls:"attempted"}, contacted:{label:"Contacted",cls:"contacted"},
  interested:{label:"Interested",cls:"interested"}, not_a_fit:{label:"Not a Fit",cls:"not_a_fit"}, dnc:{label:"Do Not Call",cls:"dnc"}
};
const STATUS_ORDER = ["new","attempted","contacted","interested","not_a_fit"];
const DISPO_LABEL = { no_answer:"No answer", voicemail:"Voicemail", connected:"Connected", callback:"Callback", not_interested:"Not interested", wrong_number:"Wrong number", interested:"Interested", sent:"Sent", replied:"Replied", no_response:"No response", bounced:"Bounced" };
const DISPO_BY_CHANNEL = {
  call: ["connected","no_answer","voicemail","callback","interested","not_interested","wrong_number"],
  text: ["sent","replied","no_response","wrong_number"],
  email:["sent","replied","bounced","no_response"]
};
const CHANNEL = { call:{label:"Call",ic:"phone"}, text:{label:"Text",ic:"message"}, email:{label:"Email",ic:"mail"} };
const ROLE_LABEL = { manager:"Manager", edit:"Editor", view:"Viewer", guest:"Guest" };
function badge(status) { const m = STATUS[status] || STATUS.new; return '<span class="badge ' + m.cls + '"><span class="dot"></span>' + m.label + "</span>"; }
function avatar(u, size) { const s = size || 30; return '<span class="avatar" style="width:'+s+'px;height:'+s+'px;background:'+u.color+';font-size:'+(s*0.4)+'px">' + initials(u.name) + "</span>"; }
function initials(n) { return n.split(/\s+/).slice(0,2).map(w => w[0]).join("").toUpperCase(); }

/* effective (override-aware) accessors */
function effDnc(dot) { return (dot in state.overrides.dnc) ? state.overrides.dnc[dot] : DB.carrierByDot[dot].do_not_contact; }
function effStatus(batchId, dot) { const k = batchId + ":" + dot; if (k in state.overrides.status) return state.overrides.status[k]; const bc = DB.batchCarriers.find(b => b.batch_id === batchId && b.dot === dot); return bc ? bc.status : "new"; }
function batchMembers(batchId) { return DB.batchCarriers.filter(b => b.batch_id === batchId); }
function batchesForDot(dot) { return DB.batchCarriers.filter(b => b.dot === dot).map(b => b.batch_id); }
function logsForDot(dot) {
  const seed = DB.callLogs.filter(l => l.dot === dot);
  const added = state.overrides.logs.filter(l => l.dot === dot);
  return seed.concat(added).sort((a, b) => b.at - a.at);
}
function lastLog(dot) { const l = logsForDot(dot); return l.length ? l[0] : null; }
function effPromoted(dot) { return (dot in state.overrides.promoted) ? state.overrides.promoted[dot] : (DB.batchCarriers.find(b => b.dot === dot && b.promoted_at) ? DB.batchCarriers.find(b => b.dot === dot && b.promoted_at).promoted_at : null); }
function warnListFor(dot) { return warningsFor(DB.carrierByDot[dot]).map(code => ({ code, label: WARN[code].label, tone: WARN[code].tone })); }
function activityForBatch(batchId) {
  const seed = DB.activity.filter(a => a.batch_id === batchId);
  const added = state.overrides.activity.filter(a => a.batch_id === batchId);
  return seed.concat(added).sort((a, b) => b.at - a.at);
}
function statusCounts(batchId) {
  const c = { new:0, attempted:0, contacted:0, interested:0, not_a_fit:0, dnc:0, warnings:0, phone:0, email:0, promoted:0, total:0 };
  batchMembers(batchId).forEach(b => {
    const cr = DB.carrierByDot[b.dot]; c.total++;
    if (effDnc(b.dot)) c.dnc++; else c[effStatus(batchId, b.dot)]++;
    if (warningsFor(cr).length) c.warnings++;
    if (cr.phone || cr.cell) c.phone++;
    if (cr.email) c.email++;
    if (effPromoted(b.dot)) c.promoted++;
  });
  return c;
}

/* ------------------------------- toasts / modal / menu ------------------------------- */
let toastSeq = 0;
function toast(msg, ic) {
  const id = toastSeq++;
  state.toasts.push({ id, msg, ic: ic || "check" });
  render();
  setTimeout(() => { state.toasts = state.toasts.filter(t => t.id !== id); render(); }, 2600);
}
function openModal(m) { state.menu = null; state.modal = m; render(); }
function closeModal() { state.modal = null; render(); }
function openMenu(m) { state.menu = m; render(); }
function closeMenu() { if (state.menu) { state.menu = null; render(); } }

/* ------------------------------- render ------------------------------- */
const ACT = {};   // action handlers, populated across files

function applyTheme() {
  const root = document.documentElement;
  if (state.theme) root.setAttribute("data-theme", state.theme);
  else root.removeAttribute("data-theme");
}
function render() {
  const root = document.getElementById("app");
  applyTheme();
  let html = (typeof SCREENS !== "undefined" && SCREENS[state.screen]) ? SCREENS[state.screen]() : '<div class="empty">…</div>';
  html += overlays();
  root.innerHTML = html;
  // restore pan/zoom state on every map that survives a re-render (F29)
  root.querySelectorAll(".map[data-mapid]").forEach(m => {
    const id = m.getAttribute("data-mapid"), svg = m.querySelector("svg");
    if (svg && state.mapView[id]) svg.setAttribute("viewBox", state.mapView[id]);
  });
  if (state.focus) { const f = root.querySelector(state.focus); if (f) f.focus(); state.focus = null; }
}
function overlays() {
  let h = "";
  if (state.modal && typeof MODALS !== "undefined" && MODALS[state.modal.type]) h += MODALS[state.modal.type](state.modal);
  if (state.menu && typeof MENUS !== "undefined" && MENUS[state.menu.type]) {
    h += '<div class="menu" style="left:' + state.menu.x + 'px;top:' + state.menu.y + 'px">' + MENUS[state.menu.type](state.menu) + "</div>";
  }
  if (state.toasts.length) {
    h += '<div class="toast-wrap">' + state.toasts.map(t => '<div class="toast">' + icon(t.ic) + esc(t.msg) + "</div>").join("") + "</div>";
  }
  return h;
}

/* ------------------------------- events ------------------------------- */
function mount() {
  const root = document.getElementById("app");
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("keydown", onKeydown);
  // F29: interactive maps — wheel zoom (about cursor) + drag pan, no re-render.
  root.addEventListener("wheel", (e) => {
    const m = e.target.closest && e.target.closest('.map[data-mapid]');
    if (!m) return;
    e.preventDefault();
    const id = m.getAttribute("data-mapid"), r = m.getBoundingClientRect();
    mapZoomAt(id, e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  let drag = null;
  root.addEventListener("mousedown", (e) => {
    const m = e.target.closest && e.target.closest('.map[data-mapid]');
    if (!m || e.target.closest(".map-legend, .map-count, .map-tools, .pin, [data-act]")) return;
    const id = m.getAttribute("data-mapid"), r = m.getBoundingClientRect(), vb = mapVB(id);
    drag = { id, sx: e.clientX, sy: e.clientY, vb, pxw: r.width };
    m.classList.add("panning");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const k = drag.vb.w / drag.pxw;
    setMapVB(drag.id, { x: drag.vb.x - (e.clientX - drag.sx) * k, y: drag.vb.y - (e.clientY - drag.sy) * k, w: drag.vb.w, h: drag.vb.h });
  });
  document.addEventListener("mouseup", () => {
    if (drag) { const m = document.querySelector('.map[data-mapid="' + drag.id + '"]'); if (m) m.classList.remove("panning"); drag = null; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (state.menu) closeMenu(); else if (state.modal) closeModal(); }
  });
}
function onClick(e) {
  const t = e.target.closest("[data-act]");
  const inMenu = e.target.closest(".menu");
  if (state.menu && !inMenu && !(t && t.dataset.act === state.menu.type)) closeMenu();
  if (!t) return;
  const act = t.dataset.act;
  // Don't open a row when the click landed on an in-row control (checkbox, status select, buttons).
  if (act === "openCarrier" && e.target.closest("select, input, button, label")) return;
  // Backdrop click closes the modal; clicks inside the modal body do not.
  if (act === "closeModal" && t.classList.contains("scrim") && e.target.closest(".modal")) return;
  if (ACT[act]) { e.preventDefault(); ACT[act]({ ...t.dataset }, e, t); }
}
function onKeydown(e) {
  const t = e.target;
  if (e.key === "Enter" && t.dataset && t.dataset.keyadd) {
    e.preventDefault();
    if (ACT[t.dataset.keyadd]) ACT[t.dataset.keyadd]({ v: t.value });
  }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset && t.dataset.change && ACT[t.dataset.change]) {
    ACT[t.dataset.change]({ ...t.dataset, value: t.type === "checkbox" ? t.checked : t.value }, e, t);
  }
}
function onInput(e) {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.echo) { const el = document.getElementById(t.dataset.echo); if (el) el.textContent = t.dataset.echoFmt === "mi" ? t.value + " mi" : t.value; }
  if (t.dataset.live && ACT[t.dataset.live]) ACT[t.dataset.live]({ ...t.dataset, value: t.value }, e, t);
  if (t.dataset.model) { setModel(t.dataset.model, t.value); }
}
function onSubmit(e) { const t = e.target.closest("[data-submit]"); if (t) { e.preventDefault(); if (ACT[t.dataset.submit]) ACT[t.dataset.submit]({ ...t.dataset }, e, t); } }
function setModel(path, val) { const parts = path.split("."); let o = state; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts[parts.length - 1]] = val; }

/* ------------------------------- generic actions ------------------------------- */
ACT.nav = (d) => { state.screen = d.to; if (d.to !== "profile") state.activeCarrierDot = null; closeMenu(); render(); };
ACT.toggleTheme = () => {
  const isDark = document.documentElement.matches('[data-theme="dark"]') ||
    (!document.documentElement.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  state.theme = isDark ? "light" : "dark"; render();
};
ACT.closeModal = () => closeModal();
ACT.closeMenu = () => closeMenu();
ACT.noop = () => {};
ACT.userMenu = (d, e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu({ type:"userMenu", x: Math.max(10, r.left), y: r.top - 8 - 96 }); };
