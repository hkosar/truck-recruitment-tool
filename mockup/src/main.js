/* ============================================================================
   main.js — v2 action handlers, live patches, boot.
   ============================================================================ */

let newBatchSeq = 1, laneSeq = 1;
const LIST_DEFAULT = () => ({ status:"all", q:"", view:"list", insurance:"any", size:"any", contact:"any", warnings:false, sort:"name" });
function addAct(batchId, type, payload, body) { state.overrides.activity.push({ id: "a_" + (actSeq++), batch_id: batchId, type, actor_id: state.session.userId, at: NOW_MS, payload: payload || {}, body: body || null }); }

/* ---- live patches (avoid re-render mid slider) ---- */
function patchWiz() {
  const w = state.wizard, zones = wizardZones(w), s = Object.assign({}, wizardSearch(w), { zones }), matches = searchMatches(s);
  const holder = document.getElementById("wiz-map-holder");
  if (holder) {
    const h = +(holder.getAttribute("data-h") || 430);
    const pins = matches.slice(0, 400).map(c => ({ lng:c.lng, lat:c.lat, r:3.5, warn:warningsFor(c).length>0, title:c.legal_name }));
    holder.innerHTML = mapBox("builder", pins, zones, mapCount(matches.length) + mapLegend([["var(--accent)","Matches filters"],["var(--crit)","Has a warning flag"]]), h);
    const svg = holder.querySelector("svg"); if (svg && state.mapView.builder) svg.setAttribute("viewBox", state.mapView.builder);
  }
  const fc = document.getElementById("b-foot-count"); if (fc) fc.textContent = matches.length;
  const gb = document.getElementById("wz-grab-n"); if (gb) gb.textContent = matches.length;
  const cov = document.getElementById("wiz-cov");
  if (cov) {
    const wp = matches.filter(c => c.phone || c.cell).length, we = matches.filter(c => c.email).length, t1 = matches.filter(c => c.tier === 1).length;
    cov.innerHTML = stat("Matches", matches.length, "accent") + stat("With phone", wp) + stat("With email", we, we ? "" : "crit") + stat("Sand & gravel", t1, "good");
  }
}
function patchList() { const b = DB.batches.find(x => x.id === state.activeBatchId), el = document.getElementById("wl-body"); if (el && b) el.innerHTML = state.list.view === "map" ? workingMap(b, workingRows(b.id)) : workingTable(b, workingRows(b.id)); }

/* ---- auth ---- */
ACT.gotoAuth = (d) => { state.screen = d.view; render(); };
ACT.signIn = () => { state.session = { userId:"u_manager", remember:true }; state.screen = "dashboard"; render(); };
ACT.demoLogin = (d) => { const u = DB.userById[d.uid]; state.session = { userId:u.id, remember:true }; const eff = (state.overrides.userStatus[u.id] && state.overrides.userStatus[u.id].status) || u.status; state.screen = (u.role==="guest" && eff!=="approved") ? "guest" : "dashboard"; render(); };
ACT.doRegister = () => { state.session = { userId:"u_guest1", remember:true }; state.screen = "guest"; render(); };
ACT.doForgot = () => { state.screen = "login"; toast("Password reset link sent", "mail"); };
ACT.logout = () => { state.session = null; state.menu = null; state.screen = "login"; render(); };
ACT.reservedTab = (d) => toast(d.label + " — coming in a later phase", "clock");
ACT.userMenu = (d, e, t) => { const r = t.getBoundingClientRect(); openMenu({ type:"userMenu", x:r.left, y:Math.max(10, r.top - 112) }); };
ACT.toast = (d) => toast(d.msg, d.ic);

/* ---- batches ---- */
ACT.newBatch = () => { state.wizard = newWizard(); state.screen = "builder"; render(); };
ACT.openBatch = (d) => { state.activeBatchId = d.id || d.to; state.selection = {}; state.list = LIST_DEFAULT(); state.feedOpen = false; state.screen = "workingList"; state.menu = null; render(); };
ACT.batchMenu = (d, e, t) => { const r = t.getBoundingClientRect(); openMenu({ type:"batchMenu", id:d.id, x:Math.max(10, Math.min(r.right-190, window.innerWidth-200)), y:r.bottom+6 }); };
ACT.renameBatch = (d) => openModal({ type:"rename", id:d.id });
ACT.confirmRename = (d) => { const v = document.getElementById("rename-input").value.trim(); const b = DB.batches.find(x => x.id === d.id); if (b && v) b.name = v; closeModal(); toast("Batch renamed"); };
ACT.deleteBatch = (d) => openModal({ type:"del", id:d.id });
ACT.confirmDelete = (d) => { const i = DB.batches.findIndex(x => x.id === d.id); if (i>=0) DB.batches.splice(i,1); for (let k=DB.batchCarriers.length-1;k>=0;k--) if (DB.batchCarriers[k].batch_id===d.id) DB.batchCarriers.splice(k,1); state.screen="dashboard"; closeModal(); toast("Batch deleted"); };
ACT.refreshBatch = (d) => {
  const b = DB.batches.find(x => x.id === d.id); if (!b) return;
  const have = new Set(batchMembers(b.id).map(m => m.dot));
  const fresh = searchMatches(Object.assign({ zones:b.zones }, b.search)).filter(c => !have.has(c.dot)).slice(0, b.new_since || 0);
  fresh.forEach(c => DB.batchCarriers.push({ id:"bc_"+(bcSeq++), batch_id:b.id, dot:c.dot, status:"new", status_by:null, status_at:NOW_MS, added_at:NOW_MS, via_refresh:true, promoted_at:null }));
  b.new_since = 0; b.last_refreshed = NOW_MS; addAct(b.id, "refresh", { added:fresh.length }); state.menu = null;
  openModal({ type:"refresh", added:fresh.length });
};
ACT.toggleFeed = () => { state.feedOpen = !state.feedOpen; render(); };
ACT.postComment = (d) => { const v = (d.v||"").trim(); if (v) { addAct(state.activeBatchId, "comment", {}, v); toast("Comment posted"); } render(); };
ACT.postCommentBtn = () => { const el = document.getElementById("feed-comment"); const v = el ? el.value.trim() : ""; if (v) { addAct(state.activeBatchId, "comment", {}, v); toast("Comment posted"); render(); } };

/* ---- maps (F29/F30) ---- */
ACT.mapZoom = (d) => mapZoomAt(d.id, +d.f);
ACT.mapReset = (d) => { delete state.mapView[d.id]; const el = document.querySelector('.map[data-mapid="' + d.id + '"] svg'); if (el) el.setAttribute("viewBox", "0 0 640 520"); };
ACT.dashToggleJob = (d) => {
  const on = !state.dashJobs[d.id];
  if (on) state.dashJobs[d.id] = true; else delete state.dashJobs[d.id];
  render();
  if (on) { const b = DB.batches.find(x => x.id === d.id); if (b) { const bb = zoneBBox(b.zones); zoomToBox("dash", bb[0], bb[1], bb[2], bb[3], 40); } }
};
ACT.dashZoomJob = (d) => { const b = DB.batches.find(x => x.id === d.id); if (b) { state.dashJobs[d.id] = true; render(); const bb = zoneBBox(b.zones); zoomToBox("dash", bb[0], bb[1], bb[2], bb[3], 40); } };

/* ---- New Search control panel ---- */
ACT.wzAddLane = (d) => {
  const id = "lz" + (laneSeq++);
  if (d.t === "radius") { const c0 = cityOf("Austin"); state.wizard.editing = { id, type:"radius", label:"", anchorKind:"city", anchor:"Austin", anchorLng:c0.lng, anchorLat:c0.lat, radiusMi:50 }; }
  else { state.wizard.editing = corridorLane(id, "Austin", "Waco", 35, ""); }
  render();
};
ACT.wzEditLane = (d) => { const w = state.wizard; const lane = w.lanes.find(z => z.id === d.id); if (lane) { w.editing = Object.assign({}, lane); w.lanes = w.lanes.filter(z => z.id !== d.id); } render(); };
ACT.wzRmLane = (d) => { state.wizard.lanes = state.wizard.lanes.filter(z => z.id !== d.id); render(); };
ACT.wzAnchorKind = (d) => { state.wizard.editing.anchorKind = d.t; render(); };
ACT.wzAnchorCity = (d) => { const e = state.wizard.editing, c0 = cityOf(d.value); e.anchor = d.value; e.anchorLng = c0.lng; e.anchorLat = c0.lat; render(); };
ACT.wzRadius = (d) => { state.wizard.editing.radiusMi = +d.value; patchWiz(); };
ACT.wzOrigin = (d) => { const e = state.wizard.editing; Object.assign(e, corridorLane(e.id, d.value, e.dest, e.bufferMi, e.label)); render(); };
ACT.wzDest = (d) => { const e = state.wizard.editing; Object.assign(e, corridorLane(e.id, e.origin, d.value, e.bufferMi, e.label)); render(); };
ACT.wzBuffer = (d) => { state.wizard.editing.bufferMi = +d.value; patchWiz(); };
ACT.wzSaveLane = () => { const w = state.wizard; if (w.editing) { if (!w.editing.label) w.editing.label = w.editing.type === "radius" ? "Material — " + w.editing.anchor : "Material — " + w.editing.origin + "→" + w.editing.dest; w.lanes.push(w.editing); w.editing = null; } render(); };
ACT.wzCancelLane = () => { state.wizard.editing = null; render(); };
ACT.wzFlag = (d) => { const fl = state.wizard.cargo.flags, i = fl.indexOf(d.f); if (i>=0) fl.splice(i,1); else fl.push(d.f); render(); };
ACT.wzOtherEnabled = (d) => { state.wizard.cargo.other.enabled = d.value; render(); };
ACT.wzOtherSearch = (d) => { state.wizard.cargo.q = d.value; state.focus = "#wz-osearch"; render(); };
ACT.wzOther = (d) => { const o = state.wizard.cargo.other, v = d.v; o.include = o.include.filter(x => x !== v); o.exclude = o.exclude.filter(x => x !== v); if (d.m === "inc") o.include.push(v); else o.exclude.push(v); render(); };
ACT.wzSuggest = (d) => { const o = state.wizard.cargo.other; DB.cargoOtherValues.forEach(v => { if (v.group === d.g && !o.include.includes(v.value)) o.include.push(v.value); }); toast('Included all "' + d.g + '" values'); render(); };
ACT.wzInsurance = (d) => { state.wizard.filters.insuranceMin = +d.value; render(); };
ACT.wzKeepBelow = (d) => { state.wizard.filters.keepBelow = d.value; patchWiz(); };
ACT.wzSize = (d) => { state.wizard.filters.size = d.value; render(); };
ACT.wzFilter = (d) => { state.wizard.filters[d.k] = d.value; render(); };
ACT.wzGrab = () => {
  const w = state.wizard; if (!w.lanes.length) { toast("Add at least one lane", "alert"); return; }
  const s = wizardSearch(w), matches = searchMatches(s);
  const name = w.name.trim() || (w.lanes[0].type === "radius" ? w.lanes[0].anchor + " Aggregates" : "New Recruitment Batch");
  const id = "b_u" + (newBatchSeq++);
  DB.batches.push({ id, name, customer:w.customer||"—", job:w.job||"—", created_by:state.session.userId, snapshot_at:NOW_MS, last_refreshed:NOW_MS, zones:w.lanes, search:{ cargo:w.cargo, forHire:w.filters.forHire, activeOnly:w.filters.activeOnly, insuranceMin:+w.filters.insuranceMin, keepBelow:w.filters.keepBelow }, snapshot_count:matches.length, new_since:0 });
  matches.forEach(c => DB.batchCarriers.push({ id:"bc_"+(bcSeq++), batch_id:id, dot:c.dot, status:"new", status_by:null, status_at:NOW_MS, added_at:NOW_MS, via_refresh:false, promoted_at:null }));
  addAct(id, "batch_created", { name }); addAct(id, "members_added", { count: matches.length });
  state.activeBatchId = id; state.selection = {}; state.list = LIST_DEFAULT(); state.feedOpen = false; state.screen = "workingList";
  toast('Grabbed ' + matches.length + ' carriers into "' + name + '"', "layers");
};

/* ---- working list ---- */
ACT.listStatus = (d) => { state.list.status = d.s; state.list.warnings = false; render(); };
ACT.listWarnings = () => { state.list.warnings = !state.list.warnings; state.list.status = "all"; render(); };
ACT.listView = (d) => { state.list.view = d.v; render(); };
ACT.listSearch = (d) => { state.list.q = d.value; patchList(); };
ACT.listInsurance = (d) => { state.list.insurance = d.value; render(); };
ACT.listContact = (d) => { state.list.contact = d.value; render(); };
ACT.listSort = (d) => { state.list.sort = d.value; render(); };
ACT.selRow = (d) => { state.selection[d.dot] = d.value; render(); };
ACT.selAll = (d) => { const b = DB.batches.find(x => x.id === state.activeBatchId); workingRows(b.id).filter(r => !r.dnc).forEach(r => state.selection[r.c.dot] = d.value); render(); };
ACT.clearSel = () => { state.selection = {}; render(); };
ACT.bulkStatus = (d) => { const dots = Object.keys(state.selection).filter(k => state.selection[k]); dots.forEach(dot => { if (!effDnc(dot)) state.overrides.status[state.activeBatchId + ":" + dot] = d.s; }); addAct(state.activeBatchId, "bulk_status_change", { count:dots.length, to:d.s }); state.selection = {}; toast(dots.length + " carriers → " + STATUS[d.s].label); };
ACT.genContact = () => { const dots = Object.keys(state.selection).filter(k => state.selection[k] && !effDnc(k)); if (!dots.length) { toast("No contactable carriers selected", "alert"); return; } openModal({ type:"contact", dots, batch:state.activeBatchId }); };
ACT.exportSheet = (d) => { if (d.batch) addAct(d.batch, "export", { kind: d.kind === "csv" ? "CSV" : "call", count: (state.modal && state.modal.dots ? state.modal.dots.length : 0) }); toast(d.kind === "csv" ? "Exported CSV" : "Call sheet ready", d.kind === "csv" ? "download" : "printer"); };
ACT.rowStatus = (d) => { if (d.value === "dnc") { openModal({ type:"dnc", dot:d.dot }); return; } state.overrides.status[d.batch + ":" + d.dot] = d.value; addAct(d.batch, "status_change", { dot:+d.dot, to:d.value }); toast("Status → " + STATUS[d.value].label); };

/* ---- carrier profile ---- */
ACT.openCarrier = (d) => { state.activeCarrierDot = +d.dot; state.profileFromBatch = d.from || null; state.screen = "profile"; state.menu = null; render(); };
ACT.openBatchCarrier = (d) => { state.profileFromBatch = d.batch; state.activeCarrierDot = +d.dot; state.screen = "profile"; render(); };
ACT.profVariant = (d) => { state.profileVariant = d.v; render(); };
ACT.promote = (d) => openModal({ type:"promote", dot:d.dot });
ACT.confirmPromote = (d) => { state.overrides.promoted[d.dot] = NOW_MS; if (state.profileFromBatch) addAct(state.profileFromBatch, "promoted", { dot:+d.dot }); closeModal(); toast("Marked as promoted — add USDOT " + d.dot + " to your tools", "arrowR"); };
ACT.toggleDnc = (d) => { if (effDnc(d.dot)) openModal({ type:"undnc", dot:d.dot }); else openModal({ type:"dnc", dot:d.dot }); };
ACT.confirmDnc = (d) => { state.overrides.dnc[d.dot] = true; if (state.activeBatchId || state.profileFromBatch) addAct(state.profileFromBatch || state.activeBatchId, "dnc_set", { dot:+d.dot }); closeModal(); toast("Do Not Call set — suppressed everywhere", "lock"); };
ACT.confirmUndnc = (d) => { state.overrides.dnc[d.dot] = false; closeModal(); toast("Do Not Call cleared"); };
ACT.logCall = (d) => openModal({ type:"log", dot:d.dot, batch:d.batch || null, channel:d.channel || "call" });
ACT.logChannel = (d) => openModal({ type:"log", dot:d.dot, batch:d.batch || null, channel:d.channel });
ACT.submitLogBtn = () => {
  const m = state.modal, dispo = val("log-dispo"), notes = val("log-notes"), next = val("log-next"), st = document.getElementById("log-status");
  state.overrides.logs.push({ id:"cl_"+(clSeq++), dot:+m.dot, batch_id:m.batch||null, user_id:state.session.userId, at:NOW_MS, channel:m.channel||"call", disposition:dispo, notes, next_steps:next, callback_at:null });
  if (m.batch && st && st.value) { state.overrides.status[m.batch + ":" + m.dot] = st.value; addAct(m.batch, "status_change", { dot:+m.dot, to:st.value }); }
  closeModal(); toast(CHANNEL[m.channel||"call"].label + " logged", CHANNEL[m.channel||"call"].ic);
};
function val(id) { const el = document.getElementById(id); return el ? el.value : ""; }

/* ---- users ---- */
ACT.approveUser = (d) => openModal({ type:"approve", uid:d.uid });
ACT.confirmApprove = (d) => { const r = document.querySelector('input[name=approle]:checked'), role = r ? r.value : "edit"; state.overrides.userStatus[d.uid] = { status:"approved", role }; closeModal(); toast(DB.userById[d.uid].name.split(" ")[0] + " approved as " + ROLE_LABEL[role], "usercheck"); };
ACT.rejectUser = (d) => { state.overrides.userStatus[d.uid] = { status:"suspended", role:"guest" }; toast("Account rejected"); };
ACT.setRole = (d) => { const u = DB.userById[d.uid], cur2 = state.overrides.userStatus[d.uid], status = cur2 ? cur2.status : u.status; state.overrides.userStatus[d.uid] = { status: status === "pending" ? "approved" : status, role:d.value }; toast("Role updated to " + ROLE_LABEL[d.value]); };
ACT.suspendUser = (d) => { const u = DB.userById[d.uid], cur2 = state.overrides.userStatus[d.uid], status = cur2 ? cur2.status : u.status, role = cur2 ? cur2.role : u.role; state.overrides.userStatus[d.uid] = { status: status === "suspended" ? "approved" : "suspended", role }; render(); };

/* ---- boot ---- */
window.ACT = ACT;
mount();
render();
