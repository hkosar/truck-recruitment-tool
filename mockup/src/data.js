/* ============================================================================
   data.js — seeded, deterministic mock dataset (stable across reloads).
   Mirrors the future Supabase schema (see mockup/README.md). Nothing here is
   real; all carriers/contacts are fabricated for the prototype.
   ============================================================================ */

const NOW_MS = Date.parse("2026-07-15T15:00:00Z");
const DAY = 86400000, HOUR = 3600000;

/* mulberry32 — tiny seeded PRNG so the demo data never shifts under you. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260715);
const rnd = (a, b) => a + rng() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

const GEO = ["Lone Star","Brazos","Permian","Hill Country","Trinity","Bluebonnet","Caprock",
  "Guadalupe","Red River","Pecos","Comal","Frio","Balcones","Llano","Nueces","Alamo","Big Bend",
  "Gulf Coast","Panhandle","Rio Grande","San Jacinto","Cross Timbers","Edwards","Blanco","Colorado River"];
const SG_CORE = ["Aggregate","Sand & Gravel","Rock","Materials","Dirt Works","Gravel","Aggregates",
  "Sand Co.","Rock & Sand","Stone","Base Material"];
const T2_CORE = ["Construction","Dump Truck","Excavation","Ready Mix","Concrete","Building Supply","Site Works"];
const T0_CORE = ["Logistics","Refrigerated","Tank Lines","Livestock","Van Lines","Distribution","Freightways"];
const SUFFIX = ["Trucking","Transport","Hauling","Logistics","Carriers","Express","LLC","Inc."];
const SG_OTHER = ["Sand and Gravel","Sand & Gravel","SAND/GRAVEL","Rock & Dirt","Aggregate Hauling","Gravel",
  "Sand, Gravel, Rock","Dirt & Aggregate","Crushed Stone","Fill Dirt / Sand","Sand and gravel hauling",
  "S&G Hauling","Rock, Sand, Base","aggregate / dirt"];
const STREETS = ["Farm to Market Rd","County Rd","Industrial Blvd","Quarry Rd","Old Bastrop Hwy","Pit Rd",
  "Commerce St","Aggregate Way","Loop","Business Park Dr","Ranch Rd","Highway 90"];
const AREA_BY_CITY = { "Houston":"713","San Antonio":"210","Austin":"512","Dallas":"214","Fort Worth":"817",
  "El Paso":"915","Midland":"432","Odessa":"432","Lubbock":"806","Laredo":"956","Corpus Christi":"361",
  "Amarillo":"806","Waco":"254","Beaumont":"409" };
// carrier home-city weights (more carriers around big metros)
const CITY_WEIGHTS = [["Houston",22],["Dallas",18],["Fort Worth",10],["San Antonio",16],["Austin",16],
  ["Midland",12],["Odessa",8],["Corpus Christi",8],["Laredo",7],["Lubbock",6],["Waco",7],["Amarillo",5],
  ["El Paso",5],["Beaumont",5]];
const CITY_PICK = CITY_WEIGHTS.flatMap(([c, w]) => Array(w).fill(c));
const cityOf = (name) => CITIES.find(c => c.name === name);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);

function phone(area) { return "(" + area + ") " + rndInt(200,989) + "-" + String(rndInt(1000,9999)); }
function bipdPick() {
  const r = rng();
  if (r < 0.10) return 0;
  if (r < 0.28) return 500000;
  if (r < 0.45) return 750000;
  if (r < 0.82) return 1000000;
  return 2000000;
}

function makeCarrier(i) {
  const r = rng();
  const tier = r < 0.60 ? 1 : (r < 0.90 ? 2 : 0);
  const cityName = pick(CITY_PICK);
  const c0 = cityOf(cityName);
  const lng = c0.lng + rnd(-0.55, 0.55);
  const lat = c0.lat + rnd(-0.45, 0.45);
  const geo = pick(GEO);
  let legal, cargoOther = null, flags = [];
  if (tier === 1) {
    legal = geo + " " + pick(SG_CORE) + (chance(0.45) ? " " + pick(SUFFIX) : "");
    cargoOther = pick(SG_OTHER);
    flags = ["Commodities Dry Bulk"];
    if (chance(0.6)) flags.push("Construction");
    if (chance(0.4)) flags.push("Building Materials");
  } else if (tier === 2) {
    legal = geo + " " + pick(T2_CORE) + " " + pick(SUFFIX);
    flags = pick([["Commodities Dry Bulk","Construction"], ["Construction","Building Materials"],
                  ["Building Materials"], ["Commodities Dry Bulk"]]);
    if (chance(0.15)) cargoOther = pick(["Base rock","Materials","Construction debris"]);
  } else {
    legal = geo + " " + pick(T0_CORE) + " " + pick(SUFFIX);
    flags = pick([["General Freight"], ["Refrigerated Food"], ["Liquids/Gases"], ["Livestock"],
                  ["Motor Vehicles"], ["General Freight","Building Materials"]]);
  }
  const units = Math.min(90, Math.max(1, Math.round(Math.abs(rnd(-6, 1)) ** 1.7 * 8) + rndInt(1, 4)));
  const dnc = tier !== 0 && chance(0.02);
  const area = AREA_BY_CITY[cityName] || "512";
  const hasEmail = chance(0.22);
  const authority = (function(){ const a = rng(); return a < 0.72 ? "active" : (a < 0.9 ? "pending" : "inactive"); })();
  const bipd = bipdPick();
  const crashes = chance(0.7) ? 0 : rndInt(1, 6);
  const voos = Math.round(rnd(0, 42));
  const rating = (function(){ const a = rng(); return a < 0.55 ? "None" : (a < 0.9 ? "Satisfactory" : "Conditional"); })();
  const concerning = rating === "Conditional" || crashes >= 4 || voos > 34;

  return {
    dot: 1200000 + i * 137 + rndInt(0, 130),
    legal_name: legal,
    dba: chance(0.25) ? geo + " " + pick(["S&G","Aggregates","Hauling","Materials"]) : null,
    tier,
    cargoOther,
    cargoFlags: flags,
    city: cityName, state: "TX",
    zip: String(rndInt(75001, 79999)),
    street: rndInt(100, 9800) + " " + pick(STREETS),
    lng, lat,
    phone: phone(area),
    cell: chance(0.55) ? phone(area) : null,
    email: hasEmail ? (chance(0.5) ? "dispatch@" : "info@") + slug(legal) + ".com" : null,
    fax: chance(0.15) ? phone(area) : null,
    power_units: units,
    drivers: units + rndInt(0, 3),
    classdef: chance(0.82) ? "Authorized For Hire" : (chance(0.5) ? "Private (Property)" : "Exempt For Hire"),
    operation: chance(0.7) ? "Interstate" : "Intrastate (Non-HM)",
    active: chance(0.9),
    mcs150: fmtDate(NOW_MS - rndInt(20, 1400) * DAY),
    entity: "Carrier",
    ins: {
      authority_status: authority,
      authority_type: pick(["Common","Contract","Common"]),
      bipd_on_file: bipd,
      bipd_required: 750000,
      cargo_on_file: chance(0.6) ? 100000 : 0,
      effective: fmtDate(NOW_MS - rndInt(30, 900) * DAY)
    },
    safety: {
      crash_total: crashes,
      inspections_24mo: rndInt(0, 40),
      vehicle_oos_pct: voos,
      driver_oos_pct: Math.round(rnd(0, 22)),
      rating,
      rating_date: fmtDate(NOW_MS - rndInt(60, 1600) * DAY),
      concerning
    },
    inspections: [],
    do_not_contact: dnc,
    dnc_reason: dnc ? pick(["Asked not to be contacted","Retired / sold trucks","Works exclusively w/ competitor"]) : null,
    dnc_by: dnc ? "u_manager" : null,
    dnc_at: dnc ? NOW_MS - rndInt(4, 90) * DAY : null
  };
}

function fmtDate(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth()+1).padStart(2,"0") + "-" + String(d.getUTCDate()).padStart(2,"0");
}

/* ---- build carriers ---- */
const carriers = [];
for (let i = 0; i < 200; i++) carriers.push(makeCarrier(i));
const carrierByDot = {};
carriers.forEach(c => carrierByDot[c.dot] = c);

// A few detailed inspection rows for the first handful of worked carriers.
function seedInspections(c, n) {
  for (let k = 0; k < n; k++) {
    c.inspections.push({
      date: fmtDate(NOW_MS - rndInt(20, 700) * DAY),
      state: "TX",
      level: "Level " + pick(["I","II","III"]),
      result: chance(0.7) ? "Clean" : "OOS",
      violations: chance(0.7) ? 0 : rndInt(1, 4)
    });
  }
}

/* ---- users ---- */
const users = [
  { id:"u_manager", name:"Hunter Kosar",   email:"hunter@twistednail.com", role:"manager", status:"approved", color:"#e8611d", registered: NOW_MS - 120*DAY },
  { id:"u_edit1",   name:"Marisol Vega",   email:"marisol@twistednail.com", role:"edit",    status:"approved", color:"#2f6fed", registered: NOW_MS - 96*DAY },
  { id:"u_edit2",   name:"Dwight Fowler",  email:"dwight@twistednail.com",  role:"edit",    status:"approved", color:"#157f43", registered: NOW_MS - 54*DAY },
  { id:"u_view1",   name:"Priya Nair",     email:"priya@twistednail.com",   role:"view",    status:"approved", color:"#7a5bd0", registered: NOW_MS - 30*DAY },
  { id:"u_guest1",  name:"Cole Ramirez",   email:"cole.r@gmail.com",        role:"guest",   status:"pending",  color:"#b07d10", registered: NOW_MS - 2*DAY },
  { id:"u_guest2",  name:"Tanya Brooks",   email:"tbrooks@haulpro.co",      role:"guest",   status:"pending",  color:"#64748b", registered: NOW_MS - 6*HOUR }
];
const userById = {}; users.forEach(u => userById[u.id] = u);
const WORKERS = ["u_manager","u_edit1","u_edit2"];

/* ---- search matching (single source: drives builder live-count AND batch snapshots) ---- */
function carrierMatchesSearch(c, s) {
  // cargo
  if (s.cargo) {
    const okTier = c.tier === 1 || (s.cargo.wideNet && c.tier === 2);
    if (!okTier) return false;
  }
  // geo
  if (s.geo) {
    if (s.geo.mode === "radius") {
      if (haversineMiles(c.lng, c.lat, s.geo.anchorLng, s.geo.anchorLat) > s.geo.radiusMi) return false;
    } else if (s.geo.mode === "corridor") {
      if (pointToRouteMiles(c.lng, c.lat, s.geo.route) > s.geo.bufferMi) return false;
    }
  }
  if (s.forHire && c.classdef !== "Authorized For Hire") return false;
  if (s.activeOnly && !c.active) return false;
  if (s.authorizedOnly && c.ins.authority_status !== "active") return false;
  if (s.interstateOnly && c.operation !== "Interstate") return false;
  if (s.sizeMin != null && c.power_units < s.sizeMin) return false;
  if (s.sizeMax != null && c.power_units > s.sizeMax) return false;
  if (s.excludeSafety && c.safety.concerning) return false;
  if (s.insuranceMin && !s.keepBelow && c.ins.bipd_on_file < s.insuranceMin) return false;
  return true;
}
function searchMatches(s) { return carriers.filter(c => carrierMatchesSearch(c, s)); }

/* ---- batches (search defs are the source of truth; membership is computed) ---- */
const AUS = cityOf("Austin"), SAT = cityOf("San Antonio"), MID = cityOf("Midland"), DAL = cityOf("Dallas");
const batchDefs = [
  { id:"b_belt", name:"Belt Construction Recruitment", desc:"Trucks for the SH-45 belt widening job.",
    created_by:"u_manager", snapshot_at: NOW_MS - 9*DAY, last_refreshed: NOW_MS - 2*DAY,
    search:{ geo:{mode:"radius", anchor:"Austin, TX", anchorLng:AUS.lng, anchorLat:AUS.lat, radiusMi:55},
             cargo:{wideNet:true}, forHire:true, activeOnly:true, sizeMin:1, sizeMax:200,
             insuranceMin:500000, keepBelow:true } },
  { id:"b_i35", name:"I-35 Corridor: Austin → San Antonio", desc:"Any truck within 40 mi of the run.",
    created_by:"u_edit1", snapshot_at: NOW_MS - 5*DAY, last_refreshed: NOW_MS - 5*DAY,
    search:{ geo:{mode:"corridor", label:"Austin → San Antonio",
             route:[{lng:AUS.lng,lat:AUS.lat},{lng:-98.10,lat:29.89},{lng:SAT.lng,lat:SAT.lat}], bufferMi:40},
             cargo:{wideNet:false}, forHire:true, activeOnly:true } },
  { id:"b_permian", name:"Permian Basin Aggregates", desc:"Frac sand & aggregate haulers, Midland hub.",
    created_by:"u_edit2", snapshot_at: NOW_MS - 14*DAY, last_refreshed: NOW_MS - 1*DAY,
    search:{ geo:{mode:"radius", anchor:"Midland, TX", anchorLng:MID.lng, anchorLat:MID.lat, radiusMi:80},
             cargo:{wideNet:true}, activeOnly:true } },
  { id:"b_dfw", name:"DFW Metroplex · $1MM+", desc:"Well-insured aggregate carriers around Dallas.",
    created_by:"u_manager", snapshot_at: NOW_MS - 20*DAY, last_refreshed: NOW_MS - 7*DAY,
    search:{ geo:{mode:"radius", anchor:"Dallas, TX", anchorLng:DAL.lng, anchorLat:DAL.lat, radiusMi:60},
             cargo:{wideNet:true}, insuranceMin:1000000, keepBelow:false, activeOnly:true } }
];

const STATUS_POOL = ["new","new","new","new","attempted","attempted","contacted","contacted","interested","not_a_fit"];
const batches = [];
const batchCarriers = [];   // {id, batch_id, dot, status, status_by, status_at, added_at, via_refresh, onboarded_at}
const callLogs = [];        // {id, dot, batch_id, user_id, at, disposition, notes, next_steps, callback_at}
let bcSeq = 0, clSeq = 0;

const DISPO = {
  attempted: ["no_answer","voicemail","no_answer"],
  contacted: ["connected","callback","connected"],
  interested:["interested","connected","callback"],
  not_a_fit: ["not_interested","wrong_number"]
};
const NOTE = {
  no_answer:"No answer, no VM set up.", voicemail:"Left voicemail w/ callback #.",
  connected:"Reached dispatcher, walked through the belt job rates.",
  callback:"Owner driving — asked to call back after 5pm.",
  interested:"Interested. Wants the rate sheet emailed + a load count.",
  not_interested:"Full up on committed freight this quarter.",
  wrong_number:"Number disconnected — needs a better contact."
};
const NEXT = { no_answer:"Retry tomorrow AM.", voicemail:"Follow up in 2 days.",
  connected:"Send rate sheet.", callback:"Call back after 5pm Thu.",
  interested:"Send packet, then qualify insurance.", not_interested:"Re-touch next quarter.", wrong_number:"Skip-trace a new number." };

batchDefs.forEach((bd, bi) => {
  const matches = searchMatches(bd.search);
  // cap snapshot size for realism, keep deterministic order
  const cap = [70, 48, 55, 44][bi] || 50;
  const members = matches.slice(0, cap);
  batches.push({
    id: bd.id, name: bd.name, desc: bd.desc, created_by: bd.created_by,
    snapshot_at: bd.snapshot_at, last_refreshed: bd.last_refreshed,
    search: bd.search, snapshot_count: members.length,
    new_since: bi === 2 ? 6 : (bi === 0 ? 3 : 0)   // pretend a refresh would add these
  });
  members.forEach((c, idx) => {
    let status = STATUS_POOL[Math.floor(rng() * STATUS_POOL.length)];
    // first batch is more "worked"
    if (bi === 0 && idx < 22) status = pick(["attempted","contacted","interested","contacted","not_a_fit"]);
    const worker = pick(WORKERS);
    const statusAt = NOW_MS - rndInt(1, 200) * HOUR;
    const bc = {
      id: "bc_" + (bcSeq++), batch_id: bd.id, dot: c.dot, status,
      status_by: status === "new" ? null : worker,
      status_at: status === "new" ? bd.snapshot_at : statusAt,
      added_at: bd.snapshot_at, via_refresh: false,
      onboarded_at: (status === "interested" && chance(0.25)) ? statusAt : null
    };
    batchCarriers.push(bc);
    // call logs for worked carriers
    if (status !== "new" && DISPO[status]) {
      const n = status === "interested" ? rndInt(2, 3) : rndInt(1, 2);
      for (let k = 0; k < n; k++) {
        const disp = pick(DISPO[status]);
        callLogs.push({
          id: "cl_" + (clSeq++), dot: c.dot, batch_id: bd.id, user_id: worker,
          at: statusAt - k * rndInt(6, 60) * HOUR, disposition: disp,
          notes: NOTE[disp], next_steps: NEXT[disp],
          callback_at: disp === "callback" ? NOW_MS + rndInt(4, 40) * HOUR : null
        });
      }
    }
  });
});

// Seed inspection detail on a few carriers that appear in the first batch.
batchCarriers.filter(bc => bc.batch_id === "b_belt").slice(0, 6)
  .forEach(bc => seedInspections(carrierByDot[bc.dot], rndInt(3, 6)));

// Guarantee at least one carrier shared across the two central-TX batches shows
// a cross-batch unified timeline — add a couple of extra logs from the corridor batch.
(function crossBatchDemo() {
  const beltDots = new Set(batchCarriers.filter(b => b.batch_id === "b_belt").map(b => b.dot));
  const shared = batchCarriers.find(b => b.batch_id === "b_i35" && beltDots.has(b.dot));
  if (shared) {
    callLogs.push({ id:"cl_"+(clSeq++), dot: shared.dot, batch_id:"b_i35", user_id:"u_edit1",
      at: NOW_MS - 30*HOUR, disposition:"connected",
      notes:"Also a fit for the I-35 run — same owner, different job.", next_steps:"Coordinate both jobs.", callback_at:null });
  }
})();

const DB = { carriers, carrierByDot, users, userById, batches, batchCarriers, callLogs };
