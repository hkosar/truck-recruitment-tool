/* ============================================================================
   main.js — remaining action handlers, live-patch helpers, and boot.
   ============================================================================ */

let newBatchSeq = 1;

/* ---- targeted patches (avoid full re-render mid text/slider input) ---- */
function patchBuilder() {
  const b = state.builder, s = builderSearch(b), matches = searchMatches(s), mset = new Set(matches);
  const map = document.getElementById("b-map");
  if (map) map.innerHTML = mapCore(builderPins(s, mset), s.geo) + mapCount(matches.length) + mapLegend(true);
  const prev = document.getElementById("b-preview");
  if (prev) prev.innerHTML = builderPreview(matches);
  const fc = document.getElementById("b-foot-count");
  if (fc) fc.textContent = matches.length;
}
function patchList() {
  const b = DB.batches.find(x => x.id === state.activeBatchId);
  const el = document.getElementById("wl-body");
  if (el && b) el.innerHTML = state.list.view === "map" ? workingMap(b, workingRows(b.id)) : workingTable(b, workingRows(b.id));
}

/* ---- auth ---- */
ACT.gotoAuth = (d) => { state.screen = d.view; render(); };
ACT.signIn = () => { state.session = { userId: "u_manager", remember: true }; state.screen = "dashboard"; render(); };
ACT.demoLogin = (d) => {
  const u = DB.userById[d.uid]; state.session = { userId: u.id, remember: true };
  const eff = (state.overrides.userStatus[u.id] && state.overrides.userStatus[u.id].status) || u.status;
  state.screen = (u.role === "guest" && eff !== "approved") ? "guest" : "dashboard"; render();
};
ACT.doRegister = () => { state.session = { userId: "u_guest1", remember: true }; state.screen = "guest"; render(); };
ACT.doForgot = () => { state.screen = "login"; toast("Password reset link sent", "mail"); };
ACT.logout = () => { state.session = null; state.menu = null; state.screen = "login"; render(); };

/* ---- batches ---- */
ACT.newBatch = () => { state.builder = newBuilder(); state.screen = "builder"; render(); };
ACT.openBatch = (d) => {
  state.activeBatchId = d.id || d.to; state.selection = {};
  state.list = { status: "all", q: "", view: "list", insurance: "any", size: "any", sort: "name" };
  state.screen = "workingList"; state.menu = null; render();
};
ACT.batchMenu = (d, e, t) => {
  const r = t.getBoundingClientRect();
  openMenu({ type: "batchMenu", id: d.id, x: Math.max(10, Math.min(r.right - 190, window.innerWidth - 200)), y: r.bottom + 6 });
};
ACT.renameBatch = (d) => openModal({ type: "rename", id: d.id });
ACT.confirmRename = (d) => { const v = document.getElementById("rename-input").value.trim(); const b = DB.batches.find(x => x.id === d.id); if (b && v) b.name = v; closeModal(); toast("Batch renamed"); };
ACT.deleteBatch = (d) => openModal({ type: "del", id: d.id });
ACT.confirmDelete = (d) => {
  const i = DB.batches.findIndex(x => x.id === d.id); if (i >= 0) DB.batches.splice(i, 1);
  for (let k = DB.batchCarriers.length - 1; k >= 0; k--) if (DB.batchCarriers[k].batch_id === d.id) DB.batchCarriers.splice(k, 1);
  state.screen = "dashboard"; closeModal(); toast("Batch deleted");
};
ACT.refreshBatch = (d) => {
  const b = DB.batches.find(x => x.id === d.id); if (!b) return;
  const have = new Set(batchMembers(b.id).map(m => m.dot));
  const fresh = searchMatches(b.search).filter(c => !have.has(c.dot)).slice(0, b.new_since || 0);
  fresh.forEach(c => DB.batchCarriers.push({ id: "bc_" + (bcSeq++), batch_id: b.id, dot: c.dot, status: "new", status_by: null, status_at: NOW_MS, added_at: NOW_MS, via_refresh: true, onboarded_at: null }));
  b.new_since = 0; b.last_refreshed = NOW_MS; state.menu = null;
  openModal({ type: "refresh", added: fresh.length });
};
ACT.grabBatch = () => {
  const b = state.builder, s = builderSearch(b), matches = searchMatches(s);
  const name = (b.name || "").trim() || (b.geoMode === "radius" ? b.anchorCity + " Aggregates" : PRESET_ROUTES[b.routeKey].label);
  const id = "b_u" + (newBatchSeq++);
  DB.batches.push({ id, name, desc: "Created just now.", created_by: state.session.userId, snapshot_at: NOW_MS, last_refreshed: NOW_MS, search: s, snapshot_count: matches.length, new_since: 0 });
  matches.forEach(c => DB.batchCarriers.push({ id: "bc_" + (bcSeq++), batch_id: id, dot: c.dot, status: "new", status_by: null, status_at: NOW_MS, added_at: NOW_MS, via_refresh: false, onboarded_at: null }));
  state.activeBatchId = id; state.selection = {};
  state.list = { status: "all", q: "", view: "list", insurance: "any", size: "any", sort: "name" };
  state.screen = "workingList"; toast('Grabbed ' + matches.length + ' carriers into "' + name + '"', "layers");
};

/* ---- builder controls ---- */
ACT.bMode = (d) => { state.builder.geoMode = d.m; render(); };
ACT.bAnchorType = (d) => { state.builder.anchorType = d.t; render(); };
ACT.bAnchorCity = (d) => { const c = cityOf(d.value); state.builder.anchorCity = c.name; state.builder.anchorLng = c.lng; state.builder.anchorLat = c.lat; patchBuilder(); };
ACT.bRoute = (d) => { state.builder.routeKey = d.value; patchBuilder(); };
ACT.bRadius = (d) => { state.builder.radiusMi = +d.value; patchBuilder(); };
ACT.bBuffer = (d) => { state.builder.bufferMi = +d.value; patchBuilder(); };
ACT.bWideNet = (d) => { state.builder.wideNet = d.value; patchBuilder(); };
ACT.bAddTerm = (d) => { const v = (d.v || "").trim(); if (v) state.builder.matchTerms.push(v); state.focus = "#b-term-input"; render(); };
ACT.bRmTerm = (d) => { state.builder.matchTerms.splice(+d.i, 1); render(); };
ACT.bSize = (d) => { state.builder.size = d.value; patchBuilder(); };
ACT.bInsurance = (d) => { state.builder.insuranceMin = +d.value; render(); };
ACT.bKeepBelow = (d) => { state.builder.keepBelow = d.value; patchBuilder(); };
ACT.bForHire = (d) => { state.builder.forHire = d.value; patchBuilder(); };
ACT.bActive = (d) => { state.builder.activeOnly = d.value; patchBuilder(); };
ACT.bAuth = (d) => { state.builder.authorizedOnly = d.value; patchBuilder(); };
ACT.bInterstate = (d) => { state.builder.interstateOnly = d.value; patchBuilder(); };
ACT.bSafety = (d) => { state.builder.excludeSafety = d.value; patchBuilder(); };

/* ---- working list ---- */
ACT.listStatus = (d) => { state.list.status = d.s; render(); };
ACT.listView = (d) => { state.list.view = d.v; render(); };
ACT.listSearch = (d) => { state.list.q = d.value; patchList(); };
ACT.listInsurance = (d) => { state.list.insurance = d.value; render(); };
ACT.listSize = (d) => { state.list.size = d.value; render(); };
ACT.listSort = (d) => { state.list.sort = d.value; render(); };
ACT.selRow = (d) => { state.selection[d.dot] = d.value; render(); };
ACT.selAll = (d) => {
  const b = DB.batches.find(x => x.id === state.activeBatchId);
  workingRows(b.id).filter(r => !r.dnc).forEach(r => state.selection[r.c.dot] = d.value);
  render();
};
ACT.clearSel = () => { state.selection = {}; render(); };
ACT.bulkStatus = (d) => {
  const dots = Object.keys(state.selection).filter(k => state.selection[k]);
  dots.forEach(dot => { if (!effDnc(dot)) state.overrides.status[state.activeBatchId + ":" + dot] = d.s; });
  state.selection = {}; toast(dots.length + " carriers → " + STATUS[d.s].label);
};
ACT.genContact = () => {
  const dots = Object.keys(state.selection).filter(k => state.selection[k] && !effDnc(k));
  if (!dots.length) { toast("No contactable carriers selected", "alert"); return; }
  openModal({ type: "contact", dots });
};
ACT.rowStatus = (d) => {
  if (d.value === "dnc") { openModal({ type: "dnc", dot: d.dot }); return; }
  state.overrides.status[d.batch + ":" + d.dot] = d.value; toast('Status → ' + STATUS[d.value].label);
};

/* ---- carrier profile ---- */
ACT.openCarrier = (d) => { state.activeCarrierDot = +d.dot; state.profileFromBatch = d.from || null; state.profileTab = "overview"; state.screen = "profile"; state.menu = null; render(); };
ACT.openBatchCarrier = (d) => { state.profileFromBatch = d.batch; state.activeCarrierDot = +d.dot; state.profileTab = "overview"; state.screen = "profile"; render(); };
ACT.profileTab = (d) => { state.profileTab = d.t; render(); };
ACT.toggleDnc = (d) => { if (effDnc(d.dot)) openModal({ type: "undnc", dot: d.dot }); else openModal({ type: "dnc", dot: d.dot }); };
ACT.confirmDnc = (d) => { state.overrides.dnc[d.dot] = true; closeModal(); toast("Do Not Call set — suppressed in every batch", "lock"); };
ACT.confirmUndnc = (d) => { state.overrides.dnc[d.dot] = false; closeModal(); toast("Do Not Call cleared"); };
ACT.sendOnboard = (d) => openModal({ type: "onboard", dot: d.dot });
ACT.confirmOnboard = (d) => { state.overrides.onboarded[d.dot] = NOW_MS; closeModal(); toast("Sent USDOT " + d.dot + " to onboarding", "arrowR"); };
ACT.logCall = (d) => openModal({ type: "log", dot: d.dot, batch: d.batch || null });
function saveLog() {
  const m = state.modal, dispo = val("log-dispo"), notes = val("log-notes"), next = val("log-next");
  const statusEl = document.getElementById("log-status");
  state.overrides.logs.push({ id: "cl_" + (clSeq++), dot: +m.dot, batch_id: m.batch || null, user_id: state.session.userId, at: NOW_MS, disposition: dispo, notes, next_steps: next, callback_at: dispo === "callback" ? NOW_MS + DAY : null });
  if (m.batch && statusEl && statusEl.value) state.overrides.status[m.batch + ":" + m.dot] = statusEl.value;
  closeModal(); toast("Call logged", "phone");
}
ACT.submitLog = () => saveLog();
ACT.submitLogBtn = () => saveLog();
function val(id) { const el = document.getElementById(id); return el ? el.value : ""; }

/* ---- users admin ---- */
ACT.approveUser = (d) => openModal({ type: "approve", uid: d.uid });
ACT.confirmApprove = (d) => {
  const r = document.querySelector('input[name=approle]:checked');
  const role = r ? r.value : "edit";
  state.overrides.userStatus[d.uid] = { status: "approved", role };
  closeModal(); toast(DB.userById[d.uid].name.split(" ")[0] + " approved as " + ROLE_LABEL[role], "usercheck");
};
ACT.rejectUser = (d) => { state.overrides.userStatus[d.uid] = { status: "suspended", role: "guest" }; toast("Account rejected"); };
ACT.setRole = (d) => {
  const u = DB.userById[d.uid], cur = state.overrides.userStatus[d.uid];
  const status = cur ? cur.status : u.status;
  state.overrides.userStatus[d.uid] = { status: status === "pending" ? "approved" : status, role: d.value };
  toast("Role updated to " + ROLE_LABEL[d.value]);
};
ACT.suspendUser = (d) => {
  const u = DB.userById[d.uid], cur = state.overrides.userStatus[d.uid];
  const status = cur ? cur.status : u.status, role = cur ? cur.role : u.role;
  state.overrides.userStatus[d.uid] = { status: status === "suspended" ? "approved" : "suspended", role };
  render();
};

/* ---- generic ---- */
ACT.toast = (d) => toast(d.msg, d.ic);
ACT.userMenu = (d, e, t) => { const r = t.getBoundingClientRect(); openMenu({ type: "userMenu", x: r.left, y: Math.max(10, r.top - 112) }); };

/* ---- boot ---- */
window.ACT = ACT;
mount();
render();
