// The free (non-keyed) games the panel offers. `script` is a direct public loadstring that works today;
// `soon: true` games show a disabled button until their script is deployed.
module.exports = [
  { key: "mm2",      name: "Murder Mystery 2", emoji: "🔪", script: "https://eccohub.xyz/mm2.lua" },
  { key: "amber",    name: "Amber Alert",      emoji: "🚨", script: "https://eccohub.xyz/amber_alert.lua" },
  { key: "universal",name: "Universal",        emoji: "🌐", script: "https://eccohub.xyz/universal.lua" },
  { key: "verity",   name: "Survive Verity (Area 51)", emoji: "🧪", soon: true },
];
