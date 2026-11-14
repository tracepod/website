// Current Tracepod open-source release. Used by the .astro pages.
// Markdown docs cannot import this, so they hold the version as plain text;
// `npm run check:versions` fails the build if any of them drift.
export const OSS_VERSION = 'v0.2.10';
export const OSS_VERSION_BARE = OSS_VERSION.replace(/^v/, '');
