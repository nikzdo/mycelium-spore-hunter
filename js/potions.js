// potions.js — consumable backpack items: temporary booster draughts
// Unlike weapons (found + equipped) these stack in the backpack and are drunk on demand.
export const POTIONS = [
  { id:'power',    name:'Power Booster',    icon:'💪', key:'Q', color:0xff5a4a,
    dur:20, mult:1.5, kind:'dmg',
    desc:'+50% blade damage for 20s', stackCap:5 },
  { id:'haste',    name:'Haste Booster',    icon:'🌀', key:'E', color:0x6bd8ff,
    dur:20, mult:1.4, kind:'atkspeed',
    desc:'+40% attack speed for 20s', stackCap:5 },
  { id:'swift',    name:'Swiftness Booster',icon:'💨', key:'R', color:0x9be26e,
    dur:20, mult:1.4, kind:'movespeed',
    desc:'+40% move speed for 20s', stackCap:5 },
  { id:'vitality', name:'Vitality Draught', icon:'❤️', key:'F', color:0xff8a7a,
    heal:0.45, kind:'heal',
    desc:'Instantly heals 45% of max HP', stackCap:5 },
  { id:'fortify',  name:'Fortify Elixir',   icon:'🛡️', key:'G', color:0xd8a6ff,
    dur:20, reduce:0.35, kind:'defense',
    desc:'−35% damage taken for 20s', stackCap:5 },
];
export const POTIONS_BY_ID = Object.fromEntries(POTIONS.map(p => [p.id, p]));
