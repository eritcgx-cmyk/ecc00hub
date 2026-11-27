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
  { key: "sols",     name: "Sol's RNG", place: 15532962292, freemium: true },
  { key: "last_letter", name: "Last Letter", place: 129866685202296 },
  { key: "chessduels", name: "RoChess", place: 89083628291452 },
  { key: "catboy",   name: "Raise A Catboy", place: 129852792970565 },
  { key: "freedraw", name: "Free Draw", place: 1547610457, freemium: true },
  { key: "hyperdraw", name: "Hyper Draw", place: 118868556321211, freemium: true },
  { key: "gakuran",  name: "Gakuran", paid: true, place: 128736949265057 },
];
