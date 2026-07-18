/* ============================================================================
   geo.js — Texas outline, map projection, and distance math.
   All membership tests use real haversine miles on lng/lat; the SVG map is
   only a visualization. Production swaps: geocoder -> carriers.geom, routing
   engine -> corridor polyline, PostGIS ST_DWithin -> these JS tests.
   ============================================================================ */

// Simplified Texas boundary, clockwise [lng, lat]. Recognizable, not survey-grade.
const TX_OUTLINE = [
  [-103.04,36.50],[-100.00,36.50],[-100.00,34.75],[-99.58,34.56],[-99.20,34.21],
  [-98.42,34.16],[-97.95,33.89],[-97.37,33.82],[-96.90,33.87],[-96.31,33.69],
  [-95.62,33.93],[-94.75,33.75],[-94.43,33.64],[-94.04,33.02],[-94.04,31.98],
  [-93.82,31.55],[-93.70,31.05],[-93.60,30.62],[-93.75,30.11],[-93.90,29.80],
  [-94.70,29.42],[-95.10,29.10],[-95.70,28.80],[-96.32,28.44],[-96.78,28.19],
  [-97.12,27.86],[-97.35,27.38],[-97.47,26.82],[-97.20,26.15],[-97.37,25.87],
  [-98.20,26.06],[-99.02,26.39],[-99.44,27.04],[-99.48,27.49],[-100.00,28.05],
  [-100.50,28.66],[-101.06,29.45],[-101.80,29.79],[-102.38,29.79],[-102.68,29.42],
  [-103.16,28.98],[-103.98,29.30],[-104.46,29.92],[-104.92,30.62],[-105.60,31.15],
  [-106.30,31.62],[-106.53,31.79],[-106.62,32.00],[-103.06,32.00],[-103.06,36.50]
];

// Cities: anchors for search + carrier clustering. major=true shows a map label.
const CITIES = [
  { name:"Houston",        lng:-95.37, lat:29.76, major:true },
  { name:"San Antonio",    lng:-98.49, lat:29.42, major:true },
  { name:"Austin",         lng:-97.74, lat:30.27, major:true },
  { name:"Dallas",         lng:-96.80, lat:32.78, major:true },
  { name:"Fort Worth",     lng:-97.33, lat:32.75, major:false },
  { name:"El Paso",        lng:-106.49,lat:31.76, major:true },
  { name:"Midland",        lng:-102.08,lat:32.00, major:true },
  { name:"Odessa",         lng:-102.37,lat:31.85, major:false },
  { name:"Lubbock",        lng:-101.86,lat:33.58, major:true },
  { name:"Laredo",         lng:-99.51, lat:27.51, major:true },
  { name:"Corpus Christi", lng:-97.40, lat:27.80, major:true },
  { name:"Amarillo",       lng:-101.83,lat:35.22, major:true },
  { name:"Waco",           lng:-97.15, lat:31.55, major:false },
  { name:"Beaumont",       lng:-94.10, lat:30.08, major:false }
];

const TX_BOUNDS = { lngMin:-106.75, lngMax:-93.40, latMin:25.70, latMax:36.65 };
const MID_LAT = (TX_BOUNDS.latMin + TX_BOUNDS.latMax) / 2;
const COS_MID = Math.cos(MID_LAT * Math.PI / 180);
const MI_PER_DEG_LAT = 69.0;

/* Build an equirectangular projection fitted to a width×height box. */
function makeProjection(width, height, pad) {
  pad = pad || 14;
  const b = TX_BOUNDS;
  const projW = (b.lngMax - b.lngMin) * COS_MID;
  const projH = (b.latMax - b.latMin);
  const scale = Math.min((width - 2 * pad) / projW, (height - 2 * pad) / projH);
  const offX = (width - projW * scale) / 2;
  const offY = (height - projH * scale) / 2;
  function project(lng, lat) {
    const x = offX + (lng - b.lngMin) * COS_MID * scale;
    const y = offY + (b.latMax - lat) * scale;
    return [x, y];
  }
  return {
    project,
    scale,
    milesToPx: (mi) => (mi / MI_PER_DEG_LAT) * scale,
    pathFor: (pts) => pts.map((p, i) => (i ? "L" : "M") + project(p[0], p[1]).map(n => n.toFixed(1)).join(" ")).join(" ") + "Z"
  };
}

/* Haversine great-circle distance in miles. */
function haversineMiles(lng1, lat1, lng2, lat2) {
  const R = 3958.8, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/* Local flat-plane miles (fast, accurate over TX-scale spans) for corridor math. */
function toPlane(lng, lat) {
  return [ lng * COS_MID * MI_PER_DEG_LAT, lat * MI_PER_DEG_LAT ];
}
function pointToSegMiles(plng, plat, alng, alat, blng, blat) {
  const p = toPlane(plng, plat), a = toPlane(alng, alat), b = toPlane(blng, blat);
  const abx = b[0]-a[0], aby = b[1]-a[1];
  const apx = p[0]-a[0], apy = p[1]-a[1];
  const len2 = abx*abx + aby*aby || 1e-9;
  let t = (apx*abx + apy*aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t*abx, cy = a[1] + t*aby;
  return Math.hypot(p[0]-cx, p[1]-cy);
}
/* Distance from a point to a polyline (route), in miles. */
function pointToRouteMiles(lng, lat, route) {
  let min = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const d = pointToSegMiles(lng, lat, route[i].lng, route[i].lat, route[i+1].lng, route[i+1].lat);
    if (d < min) min = d;
  }
  return min;
}

/* Decorative major-highway polylines [lng,lat] — basemap context (F37). */
const TX_HIGHWAYS = [
  { name:"I-35",  pts:[[-99.51,27.51],[-98.49,29.42],[-97.74,30.27],[-97.15,31.55],[-96.99,32.45],[-96.80,32.78],[-97.13,33.62]] },
  { name:"I-10",  pts:[[-106.49,31.76],[-104.83,30.72],[-102.89,30.42],[-100.87,30.10],[-98.49,29.42],[-96.94,29.70],[-95.37,29.76],[-94.10,30.08]] },
  { name:"I-20",  pts:[[-103.56,31.32],[-102.08,32.00],[-100.42,32.45],[-98.55,32.42],[-97.33,32.75],[-96.80,32.78],[-95.30,32.55],[-94.35,32.50]] },
  { name:"I-45",  pts:[[-96.80,32.78],[-96.46,31.75],[-95.90,30.75],[-95.37,29.76],[-94.88,29.30]] },
  { name:"I-37",  pts:[[-98.49,29.42],[-98.05,28.70],[-97.40,27.80]] },
  { name:"I-27",  pts:[[-101.83,35.22],[-101.86,33.58]] },
  { name:"US-83", pts:[[-99.51,27.51],[-98.20,26.06],[-97.37,25.87]] }
];
