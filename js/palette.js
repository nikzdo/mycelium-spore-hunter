// palette.js — generative, seeded, art-directed world palettes (replaces the 4-entry THEMES)
/* ---------------------------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   Four hand-authored themes meant every world was one of four looks. The obvious fix — roll a
   colour per element — gives infinite worlds and infinite mud, because nothing relates to
   anything. So the roll happens ONE LEVEL UP: a world rolls a SCHEME (base hue, harmony
   relationship, temperature split, saturation level, contrast, time of day, season, ground
   family) and every element colour is DERIVED from that scheme by fixed relationships.

   THE INVARIANT: no seed ever chooses a colour. Coherence is therefore structural, not lucky —
   a palette cannot come out muddy for a seed nobody tested, because the only thing a seed picks
   is a relationship, and every relationship in here is one we already looked at.

   NO IMPORTS, BY DESIGN. Everything is plain sRGB maths: hex ints, 0-1 sRGB triples, and
   {h,s,l} triples in sRGB. Conversion into the renderer's working space stays exactly where
   item 41 put it — at the world.js boundary, via THREE.SRGBColorSpace and srgbTriple(). Two
   consequences worth keeping: (a) an HSL offset emitted here is a PERCEPTUAL offset, which is
   the whole point of item 41; (b) this module runs under plain `node`, which is how the
   contrast and variety numbers in PORT_NOTES were measured rather than asserted.

   TONE MAPPING CEILING. We render ACES filmic at exposure 1.28, so any additive or emissive
   term at or above 1.0 clips to flat white and throws the hue away. accentIntensity and the
   lightness of every emissive value are capped for that reason (ACCENT_I_MAX / EMISSIVE_L_MAX);
   the DIFFUSE accent is allowed to go brighter, because it goes through the lighting rather
   than straight into the additive term.
--------------------------------------------------------------------------------------------- */

/* ================================ colour maths (pure sRGB) ================================ */

const TAU = Math.PI * 2;
const clamp = (v, a, b)=> v < a ? a : v > b ? b : v;
const clamp01 = (v)=> clamp(v, 0, 1);
const wrap01 = (h)=> ((h % 1) + 1) % 1;
const lerp = (a, b, t)=> a + (b - a) * t;

// circular hue distance, 0 (same) .. 0.5 (opposite)
function hueDist(a, b){ const d = Math.abs(wrap01(a) - wrap01(b)); return d > 0.5 ? 1 - d : d; }
// shortest signed step from a to b
function hueDelta(a, b){ let d = wrap01(b) - wrap01(a); if(d > 0.5) d -= 1; if(d < -0.5) d += 1; return d; }
/* Midpoint along the SHORT arc. For a cool dome top over a warm horizon the short arc runs
   through magenta — which is the band a real sunset actually puts between them. So this is not
   a convenience: it is the reason the three sky bands read as one sky instead of three stripes. */
const hueMid = (a, b)=> wrap01(a + hueDelta(a, b) * 0.5);

/* Signed warm/cool position of a hue: +1 at orange-red, -1 at cyan-blue. This is the number the
   "warm light with cool shadow, or the reverse — never both" rule is measured on. */
const warmth = (h)=> Math.cos(TAU * (wrap01(h) - 0.055));

function h2c(p, q, t){
  if(t < 0) t += 1; if(t > 1) t -= 1;
  if(t < 1/6) return p + (q - p) * 6 * t;
  if(t < 1/2) return q;
  if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}
export function hsl2rgb(h, s, l){
  h = wrap01(h); s = clamp01(s); l = clamp01(l);
  if(s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [h2c(p, q, h + 1/3), h2c(p, q, h), h2c(p, q, h - 1/3)];
}
export function rgb2hsl(r, g, b){
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if(mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if(mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if(mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}
/* sRGB hex int <-> hsl. A hex is what world.js hands to `new THREE.Color(hex)`, which reads the
   number AS sRGB and converts — so every hex emitted here is authored in sRGB, per item 41. */
export function hslHex(h, s, l){
  const [r, g, b] = hsl2rgb(h, s, l);
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}
export function hexHsl(hex){
  return rgb2hsl(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}

/* WCAG relative luminance + contrast ratio. This is the READABILITY metric, not a look knob:
   "can the player see the spore pod against the ground" is a luminance question, and a real
   contrast ratio is the only form of that claim we can put a number on and check.
   lumHSL deliberately goes VIA the 8-bit hex, so the luminance the solver optimises against is
   the luminance of the colour that actually ships — otherwise every floor is met by a hair in
   float and missed by a hair after quantisation. */
const toLin = (c)=> c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
export function relLum(r, g, b){ return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b); }
export const lumHex = (hex)=> {
  return relLum(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
};
export const lumHSL = (h, s, l)=> lumHex(hslHex(h, s, l));
export function contrast(y1, y2){
  const a = Math.max(y1, y2) + 0.05, b = Math.min(y1, y2) + 0.05;
  return a / b;
}

/* Fold ANY hue into a plausibility band, continuously and monotonically.
   This is the mechanism behind "foliage must read as foliage": the harmony relationship is free
   to point the vegetation slot anywhere on the circle, and this maps it into the band the season
   allows. The 0.75 gamma spreads the whole circle across the whole band instead of piling
   far-away hues onto the two edges, so two schemes 180 degrees apart still give visibly
   different greens — they just both give greens. */
function bandProject(h, centre, half, gamma = 0.75){
  const d = hueDelta(centre, h);                     // -0.5 .. 0.5
  const t = Math.pow(Math.abs(d) * 2, gamma);        // 0 .. 1
  return wrap01(centre + Math.sign(d) * half * t);
}

/* Nearest hue to `want` that clears `sep` from every hue in `avoid`. Spirals outward from the
   wanted hue, so the harmony slot is respected as far as it can be and only then given up.
   Exhaustive over a 1/480 grid, which is why the accent separation floor cannot fail: two
   avoided hues always leave a gap of at least half the circle. */
function separateHue(want, avoid, sep){
  let best = wrap01(want), bestScore = -1;
  for(let i = 0; i < 480; i++){
    const step = (i % 2 ? 1 : -1) * Math.ceil(i / 2) / 480;
    const h = wrap01(want + step);
    let m = 1;
    for(const a of avoid) m = Math.min(m, hueDist(h, a));
    if(m >= sep) return h;
    if(m > bestScore){ bestScore = m; best = h; }
  }
  return best;
}

/* ================================ readability floors ================================ */
/* Each floor names a thing the player has to be able to SEE. A palette that hides a spore pod
   against the ground is a bug, not a style. PROP_CREAM and CRITTER_BROWN are read straight off
   entities.js — the mushroom stem colour and the Common critter cap — and together they bracket
   the ground from both sides, which is what pins the ground to a mid-tone in every world. */
export const PROP_CREAM = 0xf2e4c8;
export const CRITTER_BROWN = 0x8a6a42;
const Y_CREAM = lumHex(PROP_CREAM);        // ~0.787
const Y_CRITTER = lumHex(CRITTER_BROWN);   // ~0.159

export const FLOORS = {
  creamVsGround: 1.70,    // cream-stemmed mushrooms and pods must not vanish into the ground
  critterVsGround: 1.35,  // ...and neither may the dark critters and enemies
  grassTipVsGround: 1.35, // the grass layer has to read as a LAYER, not as paint on the terrain
  grassBaseVsGround: 1.15,
  canopyVsSky: 1.50,      // a tree silhouetted against the sky is the readability of a forest
  canopyVsGround: 1.15,   // ...and seen from above it must still separate from the ground
  canopyVsFog: 1.20,      // ...and at the fog line, where the horizon band takes over
  bushVsGround: 1.18,
  rockVsGround: 1.30,     // props against their background: a rock is a landmark you navigate by
  accentVsGround: 1.90,   // crystals are landmarks; they have to pop at 60 m
  accentHueSep: 0.11,     // ...and stay a different HUE from the environment, not just brighter
};
/* The ground luminance window creamVsGround and critterVsGround imply, solved once. It is the
   most load-bearing pair of numbers in the file: THE GROUND IS A MID-TONE IN EVERY WORLD, and
   every other element is then placed relative to it. */
export const Y_GROUND_MIN = FLOORS.critterVsGround * (Y_CRITTER + 0.05) - 0.05;   // ~0.232
export const Y_GROUND_MAX = (Y_CREAM + 0.05) / FLOORS.creamVsGround - 0.05;       // ~0.442

/* Pick the lightness whose luminance is closest to `idealY` while satisfying every constraint.
   `cons` entries are {y, min, dir}: contrast against y at least min, and dir pins which side
   (+1 must be lighter, -1 must be darker). `offs` tests several {dh,ds,dl} variants of the same
   colour at once — that is how all three canopy variants get enforced instead of only their
   centre. A 0.005 grid over L is exhaustive at the precision 8-bit colour can represent, so this
   either returns the best legal answer or -1 to prove there isn't one; nothing gives up quietly. */
function pickL(h, s, idealY, cons, opt = {}){
  const offs = opt.offs || ZERO_OFF;
  const lMax = opt.lMax === undefined ? 0.975 : opt.lMax;
  const lMin = opt.lMin === undefined ? 0.02 : opt.lMin;
  let best = -1, bestErr = Infinity;
  for(let L = lMin; L <= lMax + 1e-9; L += 0.005){
    let ok = true, ysum = 0;
    for(const o of offs){
      const y = lumHSL(wrap01(h + o.dh), clamp01(s + o.ds), clamp01(L + o.dl));
      ysum += y;
      for(const c of cons){
        if(contrast(y, c.y) < c.min){ ok = false; break; }
        if(c.dir === 1 && y < c.y){ ok = false; break; }
        if(c.dir === -1 && y > c.y){ ok = false; break; }
      }
      if(!ok) break;
    }
    if(!ok) continue;
    const err = Math.abs(ysum / offs.length - idealY);
    if(err < bestErr){ bestErr = err; best = L; }
  }
  return best;
}
const ZERO_OFF = [{ dh:0, ds:0, dl:0 }];
/* Same, but drops the LAST constraint rather than returning nothing, so `cons` is ordered
   most-important first. Returns {l, dropped} — a relaxation is reported, never hidden. */
function pickLSoft(h, s, idealY, cons, opt){
  for(let n = cons.length; n > 0; n--){
    const l = pickL(h, s, idealY, cons.slice(0, n), opt);
    if(l >= 0) return { l, dropped: cons.length - n };
  }
  return { l: 0.5, dropped: cons.length };
}

/* ================================ the scheme space ================================ */

/* SEASON picks the foliage plausibility band. This is "foliage reads as foliage" in table form:
   a world can be strange, but it is strange in SATURATION and VALUE, never by putting a blue
   tree on screen — satMul and dry are how blight and drought happen without a hue lie.
   Band centres, in sRGB hue: 0.08 amber, 0.15 olive-yellow, 0.235 chartreuse, 0.305 green,
   0.365 deep green, 0.42 teal-green. That span is deliberately the same span the four authored
   themes already covered (their canopies run 0.07 to 0.44), so nothing here is a new risk. */
const SEASONS = [
  { id:'verdant', w:28, c:0.305, hw:0.045, satMul:1.00, dry:0.10, adj:['Verdant','Emerald','Mossbound','Greenfell'] },
  { id:'deep',    w:13, c:0.365, hw:0.038, satMul:1.02, dry:0.05, adj:['Jade','Thicket','Deepwood','Umbral'] },
  { id:'spring',  w:16, c:0.235, hw:0.045, satMul:1.05, dry:0.08, adj:['Blossom','Quickening','Bright','Greening'] },
  { id:'arid',    w:12, c:0.150, hw:0.035, satMul:0.70, dry:0.58, adj:['Sunbleached','Ochre','Parched','Dustfall'] },
  { id:'autumn',  w:13, c:0.080, hw:0.040, satMul:0.94, dry:0.46, adj:['Ember','Rust','Amber','Kindling'] },
  { id:'boreal',  w:10, c:0.420, hw:0.034, satMul:0.78, dry:0.06, adj:['Boreal','Frostgreen','Hoar','Coldwater'] },
  { id:'blight',  w:8,  c:0.270, hw:0.055, satMul:0.50, dry:0.34, adj:['Blighted','Sallow','Wither','Sickened'] },
];

/* TIME OF DAY drives the value structure — how dark the dome's top band is, how hot the horizon
   burns, how bright the direct light reads. `warm` is the PROBABILITY that the direct light is
   the warm half of the temperature split, not the split itself: golden hour is nearly always
   warm light against cool shade, overcast is usually the reverse. `lightMul` scales ground and
   foliage luminance so a dusk world is genuinely darker, rather than a noon world with an orange
   sky pasted on. NB lightMul is a palette knob and has nothing to do with toneMappingExposure. */
const TIMES = [
  { id:'dawn',     w:12, warm:0.85, topL:0.42, botL:0.72, topS:0.55, horizS:0.72, sunL:0.88, sunS:0.55, hemiL:0.80, lightMul:0.95, noun:['Dawn','First Light','Waking'] },
  { id:'morning',  w:19, warm:0.70, topL:0.47, botL:0.76, topS:0.60, horizS:0.55, sunL:0.90, sunS:0.45, hemiL:0.84, lightMul:1.00, noun:['Morning','Daybreak','Rising'] },
  { id:'noon',     w:19, warm:0.45, topL:0.50, botL:0.80, topS:0.66, horizS:0.42, sunL:0.93, sunS:0.35, hemiL:0.86, lightMul:1.08, noun:['Noon','Zenith','High Sun'] },
  { id:'golden',   w:19, warm:0.94, topL:0.40, botL:0.70, topS:0.62, horizS:0.85, sunL:0.85, sunS:0.70, hemiL:0.78, lightMul:0.98, noun:['Gold','Afternoon','Longlight'] },
  { id:'dusk',     w:14, warm:0.80, topL:0.33, botL:0.62, topS:0.58, horizS:0.80, sunL:0.80, sunS:0.75, hemiL:0.70, lightMul:0.90, noun:['Dusk','Evening','Last Light'] },
  { id:'overcast', w:9,  warm:0.28, topL:0.55, botL:0.72, topS:0.18, horizS:0.16, sunL:0.90, sunS:0.14, hemiL:0.82, lightMul:0.94, noun:['Pall','Overcast','Grey Hour'] },
  { id:'gloaming', w:8,  warm:0.35, topL:0.25, botL:0.50, topS:0.55, horizS:0.55, sunL:0.74, sunS:0.55, hemiL:0.62, lightMul:0.82, noun:['Gloaming','Twilight','Nightfall'] },
];

/* HARMONY is the relationship, and it is the only thing deciding where the vegetation, ground
   and accent hues sit relative to the sky. Slots come back as raw circle positions; the
   plausibility bands fold them afterwards. The accent slot is always the far side of the
   circle from the sky, and is then separated from foliage and soil by separateHue — which is how
   "the accent stays distinguishable" survives every harmony instead of being patched on later. */
const HARMONIES = [
  { id:'analogous', w:30, sMin:0.055, sVar:0.075 },
  { id:'split',     w:26, sMin:0.100, sVar:0.070 },
  { id:'triadic',   w:22, sMin:0.000, sVar:0.045 },
  { id:'mono',      w:22, sMin:0.020, sVar:0.035 },
];
function harmonySlots(id, h0, spread){
  switch(id){
    // neighbours of the sky hue: the calmest, most "one place" reading
    case 'analogous': return { veg: h0 + spread, grd: h0 - spread * 0.7, acc: h0 + 0.5 };
    // both sides of the complement: sky against a warm/cool ground-and-foliage pair
    case 'split':     return { veg: h0 + 0.5 - spread, grd: h0 + 0.5 + spread, acc: h0 + 0.5 };
    case 'triadic':   return { veg: h0 + 1/3 + spread, grd: h0 + 2/3 - spread, acc: h0 + 1/6 };
    // near-monochrome plus ONE accent: the accent is the only saturated hue in the world
    default:          return { veg: h0 + spread, grd: h0 - spread, acc: h0 + 0.45 };
  }
}

/* GROUND FAMILY is the soil. Bare earth is overwhelmingly the honest answer; ash and slate exist
   so an exotic world has somewhere to go that is not "recoloured mud". Both exotics carry a hard
   saturation cap, because a saturated ground competes with the foliage for the eye and the
   foliage has to win — it is most of the screen. */
const GROUNDS = [
  { id:'earth', w:56, c:0.085, hw:0.055, sMin:0.30, sVar:0.22, sCap:0.58, place:['Meadow','Basin','Vale','Wold','Reach'] },
  { id:'ochre', w:18, c:0.115, hw:0.040, sMin:0.38, sVar:0.22, sCap:0.62, place:['Steppe','Shelf','Flats','Downs'] },
  { id:'ash',   w:14, c:0.075, hw:0.090, sMin:0.04, sVar:0.07, sCap:0.13, place:['Barrens','Waste','Cinderfield','Pale'] },
  { id:'slate', w:12, c:0.700, hw:0.110, sMin:0.06, sVar:0.10, sCap:0.18, place:['Hollow','Fen','Undervale','Grave'] },
];

/* Per-instance jitter budgets — what stops a world's forest being one flat green. Applied per
   tree / bush / rock at build time, on top of the canopy VARIANTS below. Hue is capped near
   0.02, roughly half the narrowest season band, so an individual instance can never wander out
   of the band its world established; saturation and value carry most of the variety, which is
   the same trade the season table makes. */
export const JITTER = {
  tree:  { h:0.020, s:0.070, l:0.085 },
  bush:  { h:0.016, s:0.060, l:0.070 },
  grass: { h:0.014, s:0.050, l:0.060 },
  rock:  { h:0.012, s:0.050, l:0.075 },
  trunk: { h:0.014, s:0.060, l:0.065 },
  moss:  { h:0.020, s:0.070, l:0.080 },
  deco:  { h:0.022, s:0.080, l:0.090 },
};

/* ACES at exposure 1.28 clips an additive term at ~1.0 to flat white, throwing the hue away. So
   the EMISSIVE side of an accent is capped in both intensity and lightness — an emissive crystal
   has to stay a colour at full brightness instead of becoming a white blob. The DIFFUSE accent
   is allowed brighter, because it goes through the lighting rather than straight into the add. */
export const ACCENT_I_MAX = 0.85;
const EMISSIVE_L_MAX = 0.72;
const ACCENT_L_MAX = 0.92;

function wpick(rng, arr){
  let t = 0; for(const a of arr) t += a.w;
  let r = rng() * t;
  for(const a of arr){ r -= a.w; if(r <= 0) return a; }
  return arr[arr.length - 1];
}

/* Three tree variants per world: one dominant, two minorities, at FIXED hue/sat/value offsets.
   "Several species in one forest" is therefore structural — the variants cannot drift into
   unrelated colours, and pickL enforces the readability floors on all three at once. */
const CANOPY_VARIANTS = [
  { dh:-0.022, ds: 0.05, dl:-0.055, w:0.30 },
  { dh: 0.000, ds: 0.00, dl: 0.000, w:0.45 },
  { dh: 0.028, ds:-0.06, dl: 0.055, w:0.25 },
];
const CANOPY_OFFS = CANOPY_VARIANTS.map(v=>({ dh:v.dh, ds:v.ds, dl:v.dl }));

/* ================================ the shared solve ================================ */
/* ONE routine solves the ground, grass, canopy, bush, rock and accent for BOTH the generated
   palettes and the four authored ones. That is deliberate: it is the only way the authored
   themes get the new variety and the readability floors without their sky, sun or grass moving,
   and it means there is exactly one place where a floor is enforced. */
function solveWorld(ctx){
  const { folH, folS, soilH, soilS, rockH, rockS, skyY, fogY, lm, contrast: K } = ctx;

  /* --- ground first: everything else is placed relative to it. The dominant ground colour is
     ground VEGETATION (this world is a meadow, not a quarry), so it is a duller, darker relative
     of the grass layer; the bare-soil strata below are where the soil family shows. --- */
  const gndH = wrap01(folH + 0.006);
  const gndS = clamp(folS * 0.80 * (1 - ctx.dry * 0.35), 0.06, 0.72);
  let gndCons = [
    { y: Y_CREAM, min: FLOORS.creamVsGround },
    { y: Y_CRITTER, min: FLOORS.critterVsGround, dir: 1 },
  ];
  // An authored theme's grass is verbatim, so the GROUND is what moves to read against it.
  if(ctx.grassGiven) gndCons = gndCons.concat([
    { y: ctx.grassGiven.tipY, min: FLOORS.grassTipVsGround, dir: -1 },
    { y: ctx.grassGiven.baseY, min: FLOORS.grassBaseVsGround, dir: 1 },
  ]);
  const gndFix = pickLSoft(gndH, gndS, ctx.gndIdealY, gndCons);
  const gndL = gndFix.l, gndY = lumHSL(gndH, gndS, gndL);

  /* --- grass blades. Two base + two tip variants: the shader already blends between them per
     blade (vTint), so this is within-world grass variety at zero cost. The tip is the readable
     half — it is what separates the grass LAYER from the terrain under it. --- */
  let grass = null;
  if(!ctx.grassGiven){
    const tipH = wrap01(folH + 0.020), tipS = clamp01(folS * 1.10);
    /* lMax on the tip: grass that pushes past ~0.80 lightness stops reading as a lit blade and
       starts reading as a white highlight the whole field is wearing. The known-good themes sit
       at a tip/ground ratio near 1.7-2.1, which is what the ideal below targets. */
    const tipL = pickLSoft(tipH, tipS, clamp01(gndY * lerp(1.80, 2.40, K)),
      [{ y: gndY, min: FLOORS.grassTipVsGround, dir: 1 }], { lMax: 0.80 }).l;
    const baseH = wrap01(folH - 0.008), baseS = clamp01(folS * 0.95);
    const baseL = pickLSoft(baseH, baseS, clamp01(gndY * lerp(0.62, 0.44, K)),
      [{ y: gndY, min: FLOORS.grassBaseVsGround, dir: -1 }]).l;
    grass = {
      base: [...hsl2rgb(baseH, baseS, baseL),
             ...hsl2rgb(wrap01(baseH + 0.016), clamp01(baseS * 0.88), clamp01(baseL + 0.025))],
      tip:  [...hsl2rgb(tipH, tipS, tipL),
             ...hsl2rgb(wrap01(tipH + 0.022), clamp01(tipS * 0.86), clamp01(tipL + 0.035))],
    };
  }

  /* --- canopy. Three constraints pull in different directions: a tree must separate from the
     SKY behind it, the GROUND under it, and the FOG band it dissolves into at distance. pickL
     solves all three at once over all three variants and takes whichever side of the sky is the
     smaller move — which is why a twilight world gets pale canopies and a noon world gets dark
     ones, instead of one rule producing black trees at dusk. --- */
  const canH = ctx.canH === undefined ? folH : ctx.canH;
  const canS = ctx.canS === undefined ? clamp(folS * 1.05, 0.12, 0.90) : ctx.canS;
  const canFix = pickLSoft(canH, canS, clamp01(gndY * lerp(0.82, 0.56, K)), [
    { y: skyY, min: FLOORS.canopyVsSky },
    { y: gndY, min: FLOORS.canopyVsGround },
    { y: fogY, min: FLOORS.canopyVsFog },
  /* lMin: A CANOPY IS NEVER EFFECTIVELY BLACK. Every contrast floor here can also be satisfied
     by driving the canopy to near-zero luminance, and at gloaming — where the legal window
     between a dark sky and a bright fog band is narrower than the three variants' own value
     spread — that is the cheapest answer the solver can find. It is also the wrong one: the ink
     outline hull is already black, so a black canopy erases the silhouette it exists to draw.
     Flooring L here makes pickLSoft give up the FOG constraint instead, which is the right
     thing to lose — the fog band is the one that reads at 200 m, not at arm's length. */
  ], { offs: CANOPY_OFFS, lMin: 0.20 });
  const canL = canFix.l;
  const canopyVariants = CANOPY_VARIANTS.map(v=>{
    const h = wrap01(canH + v.dh), s = clamp01(canS + v.ds), l = clamp01(canL + v.dl);
    return { h, s, l, weight: v.w, hex: hslHex(h, s, l) };
  });
  const canY = canopyVariants.reduce((a, v)=> a + lumHSL(v.h, v.s, v.l), 0) / canopyVariants.length;

  const bushH = wrap01(canH - 0.016), bushS = clamp01(canS * 1.02);
  const bushFix = pickLSoft(bushH, bushS, clamp01(canY * 0.82), [{ y: gndY, min: FLOORS.bushVsGround }]);
  const bushL = bushFix.l;

  /* --- rock. THE RULE: rock is a DESATURATED RELATIVE of the soil hue, never an unrelated
     colour — a grey-green rock on grey-green ground reads as the same geology, a blue rock reads
     as a prop somebody forgot to tint. `side` (the lit tier top, most of what you see) carries
     the readability constraint; `base` sits a fixed step below it so the tier's own light-to-dark
     structure, which rockgen bakes into vertex colours, survives the solve. --- */
  const sideS = clamp01(rockS * 0.75);
  const sideFix = pickLSoft(rockH, sideS, clamp01(gndY * 2.0),
    [{ y: gndY, min: FLOORS.rockVsGround, dir: 1 }], { lMax: 0.93 });
  const sideL = sideFix.l, baseL = clamp01(sideL - 0.32), midL = (sideL + baseL) * 0.5;

  /* --- accent: crystals and emissive props. The slot is already the far side of the circle;
     separateHue then guarantees the hue gap from foliage AND soil, and pickL finds the lightness
     that clears the ground. Rotating and solving are both deterministic — no rng after the roll. */
  // +0.005 of margin: hslHex() quantises to 8 bits, which moves a hue by up to ~0.002, and a
  // separation that only holds before rounding is not a separation.
  const accH = separateHue(ctx.accSlot, [folH, soilH, gndH], FLOORS.accentHueSep + 0.005);
  const accS = clamp(ctx.accS, 0.42, 0.94);
  const accFix = pickLSoft(accH, accS, 0.62, [{ y: gndY, min: FLOORS.accentVsGround }], { lMax: ACCENT_L_MAX });
  const accL = accFix.l;

  const soilL = clamp01(gndL + 0.14 + ctx.dry * 0.05);
  const dryH = bandProject(soilH, 0.115, 0.030);
  const terra = {
    grass:   hslHex(gndH, gndS, gndL),
    emerald: hslHex(wrap01(gndH + 0.014), clamp01(gndS * 1.10), clamp01(gndL - 0.13)),
    dry:     hslHex(dryH, clamp01(soilS * 0.95), soilL),
    moss:    hslHex(wrap01(folH - 0.008), clamp01(gndS * 1.05), clamp01(gndL - 0.185)),
    rock:    hslHex(rockH, rockS, clamp01(midL)),
    clear:   hslHex(dryH, clamp01(soilS * 0.82), clamp01(soilL + 0.10)),
    path:    hslHex(wrap01(dryH - 0.012), clamp01(soilS * 0.90), clamp01(soilL + 0.03)),
    // corruption is the ONE colour that must not harmonise: it has to read as "wrong" in every
    // world, so it is pinned dark and violet-cool regardless of the scheme.
    corrupt: hslHex(wrap01(0.74 + ctx.h0 * 0.06), 0.30, 0.16),
  };
  const rock = {
    stone: {
      base: hslHex(rockH, clamp01(rockS * 1.2), baseL),
      side: hslHex(rockH, sideS, sideL),
      tint: hslHex(wrap01(rockH + 0.03), clamp01(rockS * 1.5), midL),
    },
    // basalt is the dark family on purpose — it reads by being darker than the ground, which is
    // the other side of the same contrast floor.
    basalt: {
      base: hslHex(wrap01(rockH + 0.55), clamp01(rockS * 1.1), clamp01(baseL * 0.45)),
      side: hslHex(wrap01(rockH + 0.55), clamp01(rockS * 0.9), clamp01(baseL * 0.45 + 0.24)),
      tint: hslHex(wrap01(accH + 0.02), clamp01(rockS * 1.8), clamp01(baseL * 0.45 + 0.13)),
    },
    chalk: {
      base: hslHex(rockH, clamp01(rockS * 1.1), clamp01(sideL - 0.14)),
      side: hslHex(rockH, clamp01(rockS * 0.55), clamp01(sideL + 0.22)),
      tint: hslHex(wrap01(rockH - 0.02), clamp01(rockS * 1.2), clamp01(sideL + 0.10)),
    },
    // crystal and rot are the ACCENT's geology, so a crystal formation reads as this world's rock
    // that happens to have grown a seam, not as a prop imported from another palette.
    crystal: {
      base: hslHex(accH, clamp01(accS * 0.8), clamp01(accL * 0.36)),
      side: hslHex(accH, clamp01(accS * 0.85), clamp01(accL + 0.06)),
      tint: hslHex(wrap01(accH + 0.09), clamp01(accS * 0.9), clamp01(accL - 0.04)),
    },
    rot: {
      base: hslHex(wrap01(0.76 + ctx.h0 * 0.05), 0.28, 0.14),
      side: hslHex(wrap01(0.78 + ctx.h0 * 0.05), 0.24, 0.38),
      tint: hslHex(wrap01(0.80 + ctx.h0 * 0.05), 0.45, 0.52),
    },
  };

  const trunkH = bandProject(soilH, 0.075, 0.035);
  const trunkS = clamp(soilS * 0.85 + 0.10, 0.10, 0.55);
  const trunkL = clamp01(0.34 * lm - K * 0.04);

  return {
    gndH, gndS, gndL, gndY, canH, canS, canL, canY, terra, rock, grass, canopyVariants,
    accent: hslHex(accH, accS, accL),
    accentEmissive: hslHex(accH, clamp01(accS * 0.9), Math.min(EMISSIVE_L_MAX, accL)),
    accentDark: hslHex(accH, clamp01(accS * 0.7), clamp01(accL * 0.32)),
    accH, accS, accL,
    trunk: hslHex(trunkH, trunkS, trunkL),
    trunkDark: hslHex(trunkH, clamp01(trunkS + 0.05), clamp01(trunkL - 0.12)),
    bush: hslHex(bushH, bushS, bushL),
    bushDeep: hslHex(wrap01(bushH - 0.012), clamp01(bushS + 0.08), clamp01(bushL - 0.14)),
    undergrowth: hslHex(wrap01(folH - 0.020), clamp01(canS * 0.9), clamp01(bushL - 0.08)),
    moss: hslHex(wrap01(folH + 0.010), clamp01(canS * 1.08), clamp01(canL - 0.10)),
    flowers: [-0.07, 0.06, 0.17].map(d=>
      hslHex(wrap01(accH + d), clamp01(accS * 0.92), Math.min(EMISSIVE_L_MAX, accL))),
    relaxed: gndFix.dropped + canFix.dropped + bushFix.dropped + sideFix.dropped + accFix.dropped,
  };
}

/* ================================ generated palettes ================================ */

function rollScheme(rng){
  const harmony = wpick(rng, HARMONIES);
  const season = wpick(rng, SEASONS);
  const tod = wpick(rng, TIMES);
  const ground = wpick(rng, GROUNDS);
  const h0 = rng();
  const spread = harmony.sMin + rng() * harmony.sVar;
  return {
    h0, harmony: harmony.id, spread,
    season: season.id, tod: tod.id, ground: ground.id,
    warmLight: rng() < tod.warm,
    sat: 0.62 + rng() * 0.76,        // global saturation multiplier: muted 0.62 -> vivid 1.38
    contrast: 0.28 + rng() * 0.68,   // value RANGE: low is misty and close, high is graphic
    _season: season, _tod: tod, _ground: ground, _harmony: harmony,
  };
}

function derive(S){
  const T = S._tod, SE = S._season, G = S._ground;
  const slots = harmonySlots(S.harmony, S.h0, S.spread);
  const lm = T.lightMul;
  const satOf = (base)=> clamp01(base * S.sat);

  // foliage: the harmony's vegetation slot folded into the season's plausibility band
  const folH = bandProject(slots.veg, SE.c, SE.hw);
  const folS = clamp(satOf(0.52) * SE.satMul, 0.10, 0.92);
  // soil: the harmony's ground slot folded into the soil family's band
  const soilH = bandProject(slots.grd, G.c, G.hw);
  const soilS = clamp(satOf(G.sMin + G.sVar * 0.5) * (1 - SE.dry * 0.25), 0.02, G.sCap);
  const rockH = wrap01(soilH + 0.012);
  const rockS = clamp(soilS * 0.42, 0.02, 0.17);

  /* --- sky. The dome's top band carries the scheme's base hue; the horizon carries the LIGHT's
     temperature, so warm light means a hot horizon and cool light a cold one. --- */
  /* The ZENITH also gets a plausibility band, for the same reason foliage does: the base hue is
     free to be anything, and a magenta sky directly overhead reads as a bug rather than as a
     mood. 0.615 +/- 0.105 spans deep blue through indigo to violet — the four authored themes'
     zeniths land at 0.55-0.65, so this widens the authored range without leaving it. */
  const skyTopH = bandProject(S.h0, 0.615, 0.105);
  const horizH = S.warmLight ? wrap01(0.045 + S.h0 * 0.075) : wrap01(0.50 + S.h0 * 0.13);
  const skyMidH = hueMid(skyTopH, horizH);
  const topL = clamp01(T.topL * lerp(1.08, 0.90, S.contrast));
  const botL = clamp01(T.botL * lerp(1.02, 0.96, S.contrast));
  const midL = (topL + botL) * 0.5 + 0.03;

  /* item 43: ONE horizon colour. `fog` IS the horizon band — scene.fog, scene.background and the
     dome's lowest band all come from this single value in world.js — and `skyBot` is derived
     FROM it (a touch darker and more saturated) as its immediate neighbour, rather than authored
     separately. That is what makes the reconciliation true by construction instead of by two
     numbers happening to agree. */
  const fogS = clamp01(satOf(T.horizS) * 0.86);
  const fogL = clamp01(botL + 0.045);
  const fog = hslHex(horizH, fogS, fogL);
  const skyBot = hslHex(horizH, clamp01(fogS * 1.14), clamp01(fogL - 0.045));
  const midS = clamp01(satOf(T.topS) * 0.55);
  const skyMid = hslHex(skyMidH, midS, midL);
  const skyTop = hslHex(skyTopH, clamp01(satOf(T.topS)), topL);

  /* --- the light rig. THE TEMPERATURE RULE: direct light and sky fill sit on OPPOSITE sides of
     the warm/cool axis. Both warm flattens everything, because then nothing in the frame tells
     you which surfaces face the light. The split is derived from one boolean, not rolled per
     light, so it cannot come out wrong. --- */
  const sunH = S.warmLight ? wrap01(0.070 + S.h0 * 0.045) : wrap01(0.505 + S.h0 * 0.09);
  const hemiSkyH = S.warmLight ? wrap01(0.560 + S.h0 * 0.075) : wrap01(0.070 + S.h0 * 0.05);
  const sun = hslHex(sunH, clamp01(satOf(T.sunS) * 1.05), T.sunL);
  const hemiSky = hslHex(hemiSkyH, clamp01(satOf(0.55)), T.hemiL);

  const core = solveWorld({
    folH, folS, soilH, soilS, rockH, rockS,
    skyY: lumHex(skyMid), fogY: lumHex(fog),
    lm, contrast: S.contrast, dry: SE.dry, h0: S.h0,
    accSlot: slots.acc, accS: clamp(satOf(0.78), 0.42, 0.94),
    // the ground's WANTED luminance, before the readability window clamps it. Driven by the
    // contrast knob and the hour, which is what keeps ground brightness varying between worlds
    // instead of every world landing on the window's floor.
    gndIdealY: lerp(0.40, 0.24, S.contrast) * lm,
  });

  // ground bounce IS the ground, so it takes the soil hue directly — kept dark so it fills the
  // shadow side without washing it out to the ground colour.
  const hemiGround = hslHex(soilH, clamp01(soilS * 0.8 + 0.06), clamp01(0.28 * lm + 0.02));

  /* distant haze rings: aerial perspective. Each ring is the horizon colour with a little more
     of the dome's hue left in it, so the mountains sit BEHIND the fog rather than on top of it. */
  const mountains = [0, 1, 2].map(i=>{
    const t = (i + 1) / 3.4;
    return hslHex(hueMid(skyTopH, horizH + 0.02), clamp01(lerp(0.34, 0.16, t) * S.sat),
      clamp01(lerp(0.40, 0.70, t) * lm + 0.04));
  });

  const pal = {
    scheme: {
      h0: S.h0, harmony: S.harmony, spread: S.spread, season: S.season, tod: S.tod,
      ground: S.ground, warmLight: S.warmLight, sat: S.sat, contrast: S.contrast,
      folH, soilH, accH: core.accH, tempSplit: warmth(sunH) - warmth(hemiSkyH),
    },
    name: '',
    /* --- every field world.js consumes today, same names, same shapes --- */
    skyTop, skyMid, skyBot, fog, sun, hemiSky, hemiGround,
    grassBase: core.grass.base, grassTip: core.grass.tip,
    /* legacy HSL OFFSETS, kept so the swap is drop-in: world.js's `tint()` and its canopy
       setHSL() line keep working, and still produce a coherent set, because the offset is
       measured off the same authored anchors it was always measured off (0x5fa838's hue 0.2753
       for terrain, 0.30 for the canopy's 0.26+rng()*0.08 band). */
    terraHue: clamp(hueDelta(0.2753, core.gndH), -0.20, 0.20),
    terraSat: clamp(core.gndS - 0.50, -0.35, 0.25),
    canopyHue: clamp(hueDelta(0.30, core.canH), -0.24, 0.24),
    canopySat: core.canS,
    canopyBase: core.canopyVariants[1].hex,
    /* --- new: the variety that did not exist before --- */
    canopyVariants: core.canopyVariants,
    canopyL: [clamp01(core.canL - 0.08), 0.16],   // drop-in for PARAMS.canLMin / canLVar
    trunk: core.trunk, trunkDark: core.trunkDark,
    bush: core.bush, bushDeep: core.bushDeep, undergrowth: core.undergrowth, moss: core.moss,
    terra: core.terra, rock: core.rock, mountains, flowers: core.flowers,
    accent: core.accent, accentEmissive: core.accentEmissive, accentDark: core.accentDark,
    accentIntensity: ACCENT_I_MAX,
    jitter: JITTER,
    // provenance for the numeric proof harness and the dev panel; unused at runtime
    lum: { ground: core.gndY, sky: lumHex(skyMid), fog: lumHex(fog), canopy: core.canY },
    relaxed: core.relaxed,
  };
  pal.name = paletteName(pal);
  return pal;
}

/* ================================ the four authored themes ================================ */
/* Verbatim, and the roll can still land on them (AUTHORED_CHANCE), so no art direction we
   already liked is lost. CHOICE MADE: they are authored entries the roll selects, not seeds fed
   back through the generator — a generator that happened to reproduce them today would stop
   doing so the moment anyone re-tuned a table, which is exactly the guarantee we wanted. */
export const AUTHORED = [
  { name:'Golden Meadow',
    skyTop:0x2a6bc7, skyMid:0x9e8cb8, skyBot:0xffb86b, fog:0xf2c08e,
    sun:0xffe0b0, hemiSky:0xbcd8ff, hemiGround:0x6b4a2f,
    grassBase:[0.30,0.55,0.20, 0.38,0.52,0.24], grassTip:[0.66,0.84,0.34, 0.85,0.80,0.40],
    terraHue:0, terraSat:0, canopyHue:0, canopySat:0.55, canopyBase:0x69b043 },
  { name:'Teal Dusk',
    skyTop:0x1d5f8f, skyMid:0x6f8fae, skyBot:0x7fe0c8, fog:0xa8d8c8,
    sun:0xd8f0e0, hemiSky:0x9fd8e8, hemiGround:0x3f5a4a,
    grassBase:[0.16,0.46,0.34, 0.20,0.44,0.38], grassTip:[0.42,0.78,0.52, 0.62,0.82,0.58],
    terraHue:0.32, terraSat:0.04, canopyHue:0.10, canopySat:0.5, canopyBase:0x3fae7a },
  { name:'Blossom Spring',
    skyTop:0x4a6fd0, skyMid:0xc89cc8, skyBot:0xffc8d8, fog:0xf0c8d0,
    sun:0xffe8d8, hemiSky:0xd8c8ff, hemiGround:0x7a5a5f,
    grassBase:[0.34,0.56,0.26, 0.42,0.54,0.30], grassTip:[0.72,0.86,0.44, 0.88,0.84,0.52],
    terraHue:-0.03, terraSat:0.05, canopyHue:-0.16, canopySat:0.58, canopyBase:0x8fc85a },
  { name:'Ember Autumn',
    skyTop:0x35458f, skyMid:0xb07a8c, skyBot:0xff9a52, fog:0xe8a878,
    sun:0xffc890, hemiSky:0xc8a8c8, hemiGround:0x7a4a2f,
    grassBase:[0.44,0.44,0.16, 0.48,0.40,0.20], grassTip:[0.88,0.70,0.28, 0.92,0.62,0.30],
    terraHue:-0.06, terraSat:0.06, canopyHue:-0.19, canopySat:0.62, canopyBase:0xc8882e },
];
export const AUTHORED_CHANCE = 0.18;   // ~1 world in 5.5 is one of the four known-good looks

/* Fill an authored theme out to the full generated shape. Authored fields are COPIED, never
   recomputed; the new fields are derived from them — canopy hue and soil hue are read back out
   of the authored hexes — and pushed through the same solveWorld(), so the additions cannot
   disagree with the art direction they extend, and they meet the same readability floors. */
function expandAuthored(entry, idx){
  const [canH, canS, canL] = hexHsl(entry.canopyBase);
  const [fogH] = hexHsl(entry.fog);
  const [soilH0, soilS0] = hexHsl(entry.hemiGround);   // the ground bounce IS this theme's soil
  const soilH = soilH0, soilS = clamp(soilS0 * 0.9, 0.03, 0.60);
  const tipY = Math.max(relLum(entry.grassTip[0], entry.grassTip[1], entry.grassTip[2]),
                        relLum(entry.grassTip[3], entry.grassTip[4], entry.grassTip[5]));
  const baseY = Math.min(relLum(entry.grassBase[0], entry.grassBase[1], entry.grassBase[2]),
                         relLum(entry.grassBase[3], entry.grassBase[4], entry.grassBase[5]));
  const sunH = hexHsl(entry.sun)[0], hemiH = hexHsl(entry.hemiSky)[0];
  const core = solveWorld({
    folH: canH, folS: canS, soilH, soilS,
    rockH: wrap01(soilH + 0.012), rockS: clamp(soilS * 0.42, 0.02, 0.17),
    skyY: lumHex(entry.skyMid), fogY: lumHex(entry.fog),
    lm: 1, contrast: 0.5, dry: 0.1, h0: fogH,
    accSlot: wrap01(canH + 0.5), accS: 0.80,
    canH, canS,                        // the canopy HUE is authored; only its value is solved
    gndIdealY: 0.30,
    grassGiven: { tipY, baseY },       // authored grass is verbatim, so the ground moves instead
  });
  return Object.assign({}, entry, {
    scheme: { h0: fogH, harmony:'authored', spread:0, season:'authored', tod:'authored',
      ground:'authored', warmLight: warmth(sunH) > 0, sat:1, contrast:0.5,
      folH: canH, soilH, accH: core.accH, tempSplit: warmth(sunH) - warmth(hemiH),
      authoredIdx: idx },
    canopyVariants: core.canopyVariants,
    canopyL: [clamp01(core.canL - 0.08), 0.16],
    trunk: core.trunk, trunkDark: core.trunkDark,
    bush: core.bush, bushDeep: core.bushDeep, undergrowth: core.undergrowth, moss: core.moss,
    terra: core.terra, rock: core.rock, flowers: core.flowers,
    mountains: [0,1,2].map(i=>{ const t = (i + 1) / 3.4;
      return hslHex(hueMid(hexHsl(entry.skyTop)[0], fogH + 0.02), lerp(0.34, 0.16, t), lerp(0.40, 0.70, t) + 0.04); }),
    accent: core.accent, accentEmissive: core.accentEmissive, accentDark: core.accentDark,
    accentIntensity: ACCENT_I_MAX,
    jitter: JITTER,
    lum: { ground: core.gndY, sky: lumHex(entry.skyMid), fog: lumHex(entry.fog), canopy: core.canY },
    relaxed: core.relaxed,
    authored: true,
  });
}
// Expanded once at module load: an authored theme is a constant, so expanding it per world would
// be work with no possible variation in the answer.
const AUTHORED_FULL = AUTHORED.map(expandAuthored);

/* ================================ public API ================================ */

/* THE entry point. A pure function of the rng stream — no Math.random() — so one seed is one
   palette forever. The authored-or-generated draw happens FIRST, before the scheme roll, so
   adding a knob to derive() cannot reshuffle which worlds are authored. */
export function makePalette(rng){
  if(rng() < AUTHORED_CHANCE){
    const pick = AUTHORED_FULL[(rng() * AUTHORED_FULL.length) | 0];
    // shallow copy + fresh variant objects: world.js is free to mutate what it is handed, and
    // the module-level authored entry must survive being handed out to a hundred worlds.
    return Object.assign({}, pick, { canopyVariants: pick.canopyVariants.map(v=>({ ...v })) });
  }
  return derive(rollScheme(rng));
}

/* Per-instance tint. Returns {h, s, l, hex} in sRGB — NOT a THREE.Color, so this module stays
   import-free and the sRGB->working conversion stays at the single boundary item 41 established:
   `col.setHSL(j.h, j.s, j.l, THREE.SRGBColorSpace)` at the call site, which is the exact call
   world.js already makes for canopies. Pass `out` to reuse one object across a build loop.
   kind: 'tree' | 'bush' | 'grass' | 'rock' | 'trunk' | 'moss' | 'deco'. */
export function jitterFor(palette, kind, rng, out = { h:0, s:0, l:0, hex:0 }){
  const J = (palette.jitter || JITTER)[kind] || JITTER.deco;
  let h, s, l;
  if(kind === 'tree'){
    // VARIANT first, jitter second: the variants are the world's species and the jitter is the
    // individual, so a jittered instance never crosses into another variant's identity.
    const vs = palette.canopyVariants;
    let r = rng(), v = vs[vs.length - 1];
    for(const c of vs){ r -= c.weight; if(r <= 0){ v = c; break; } }
    h = v.h; s = v.s; l = v.l;
  } else {
    const src = kind === 'rock' ? palette.terra.rock
      : kind === 'grass' ? palette.terra.grass
      : kind === 'trunk' ? palette.trunk
      : kind === 'moss' ? palette.moss
      : kind === 'deco' ? palette.accent
      : palette.bush;
    const c = hexHsl(src); h = c[0]; s = c[1]; l = c[2];
  }
  out.h = wrap01(h + (rng() * 2 - 1) * J.h);
  out.s = clamp01(s + (rng() * 2 - 1) * J.s);
  out.l = clamp01(l + (rng() * 2 - 1) * J.l);
  out.hex = hslHex(out.h, out.s, out.l);
  return out;
}

/* One rock formation's {base, side, tint}, jittered off one of the five families. Same shape as
   rockgen.js's ROCK_PAL entries, so it drops into makeStack() unchanged; `family` lets a caller
   force a look (crystal hollows, rot pockets) instead of taking the roll. */
const ROCK_FAMILIES = ['stone', 'stone', 'stone', 'basalt', 'chalk'];
export function rockSetFor(palette, rng, family){
  const key = family || ROCK_FAMILIES[(rng() * ROCK_FAMILIES.length) | 0];
  const src = palette.rock[key] || palette.rock.stone;
  const J = (palette.jitter || JITTER).rock;
  const dh = (rng() * 2 - 1) * J.h, ds = (rng() * 2 - 1) * J.s, dl = (rng() * 2 - 1) * J.l;
  // the three colours shift TOGETHER (one dh/ds/dl for the whole stack), which is why a jittered
  // rock still reads as one rock instead of three unrelated greys stacked up.
  const shift = (hex, dlMul)=>{
    const [h, s, l] = hexHsl(hex);
    return hslHex(wrap01(h + dh), clamp01(s + ds), clamp01(l + dl * dlMul));
  };
  return { family: key, base: shift(src.base, 1), side: shift(src.side, 1), tint: shift(src.tint, 0.6) };
}

/* Evocative zone label for the pause screen, the Tome and the run summary. A pure function of
   the palette, not of the rng, so it can be recomputed from a stored palette — the Tome and the
   world must never disagree about what the place is called. */
export function paletteName(palette){
  if(palette.authored) return palette.name;
  const S = palette.scheme;
  const se = SEASONS.find(x=>x.id === S.season) || SEASONS[0];
  const tt = TIMES.find(x=>x.id === S.tod) || TIMES[0];
  const gg = GROUNDS.find(x=>x.id === S.ground) || GROUNDS[0];
  // one integer hash off the continuous scheme numbers, so two worlds with the same season and
  // hour still tend to get different words without spending another rng draw
  const k = Math.floor(S.h0 * 977 + S.spread * 613 + S.sat * 419 + S.contrast * 271);
  const adj = se.adj[k % se.adj.length];
  // half the worlds name the hour, half name the place — the same variety trick, on grammar
  const noun = (k >> 3) % 2 ? tt.noun[(k >> 4) % tt.noun.length] : gg.place[(k >> 4) % gg.place.length];
  return `${adj} ${noun}`;
}
