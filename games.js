// Every game the hub supports. Free games run straight from the universal loader; paid games need a key
// (whitelist through JNKIE). `soon: true` marks one as not out yet.
module.exports = [
  { key: "dahood",   name: "Da Hood",          paid: true, place: 2788229376 },
  { key: "hoodc",    name: "Hood Customs",     paid: true, place: 9825515356 },
  { key: "mm2",      name: "Murder Mystery 2", freemium: true },
  { key: "ftf",      name: "Flee the Facility", place: 893973440, freemium: true },
  { key: "amber",    name: "Amber Alert" },
  { key: "verity",   name: "Survive Verity (Area 51)", place: 74716719697996 },
  { key: "eternity", name: "Project Eternity", place: 108438460215241 },
  { key: "closing",  name: "Closing Shift", place: 118297934142609 },
  { key: "sols",     name: "Sol's RNG", place: 15532962292 },
];
