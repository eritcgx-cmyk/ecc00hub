// Every game the hub supports. Free games run straight from the universal loader; paid games need a key
// (whitelist through JNKIE). `soon: true` shows the game as coming soon with a disabled button.
module.exports = [
  { key: "dahood",   name: "Da Hood",          emoji: "🔫", paid: true, place: 2788229376 },
  { key: "hoodc",    name: "Hood Customs",     emoji: "🎯", paid: true, place: 9825515356 },
  { key: "mm2",      name: "Murder Mystery 2", emoji: "🔪" },
  { key: "amber",    name: "Amber Alert",      emoji: "🚨" },
  { key: "universal",name: "Universal",        emoji: "🌐" },
  { key: "verity",   name: "Survive Verity (Area 51)", emoji: "🧪", place: 74716719697996 },
];
