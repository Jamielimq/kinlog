// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// onchain/ is the Anchor workspace (Rust sources + multi-GB target/); nothing in it belongs in the app bundle.
config.resolver.blockList = [...config.resolver.blockList, /[\\/]onchain[\\/].*/];

module.exports = config;
