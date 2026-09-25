// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// <repo>/onchain is the Anchor workspace (Rust sources + multi-GB target/); nothing in it belongs in the
// app bundle. Anchored to this repo's root so an unrelated "onchain" directory elsewhere is not blocked.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const onchainDir = path.join(__dirname, 'onchain');
config.resolver.blockList = [
  ...config.resolver.blockList,
  new RegExp(`^${escapeRegExp(onchainDir)}[\\\\/].*`),
];

module.exports = config;
