// mushrooms.js — harvestable mushroom species catalog.
// Shared by world.js (placement + visuals of the decorative mushroom props) and
// main.js/progress.js (contract generation + harvest matching), so both sides
// always agree on what species exist without duplicating the list.
export const MUSHROOM_SPECIES = [
  { id:'azure',  name:'Azure Cap',    icon:'🔵', color:0x6ad0ff, emissive:0x2288bb },
  { id:'rose',   name:'Rose Bloom',   icon:'🌸', color:0xff9adf, emissive:0xaa3388 },
  { id:'amber',  name:'Amber Puff',   icon:'🟡', color:0xffcf5a, emissive:0xcc8a15 },
  { id:'violet', name:'Violet Shroom',icon:'🟣', color:0xb47aff, emissive:0x6a2fa8 },
];
export const SPECIES_BY_ID = Object.fromEntries(MUSHROOM_SPECIES.map(s=>[s.id, s]));
export function hexCss(n){ return '#'+n.toString(16).padStart(6,'0'); }
