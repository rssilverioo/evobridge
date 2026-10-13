/** Product identity in one place, so a rename touches a single file. */
export const BRAND = {
  name: 'EvoBridge',
  tagline: 'The simplest open-source bridge between Evolution Go and Chatwoot.',
  // Set when the public repository exists (NEXT_PUBLIC_REPO_URL at build time).
  repoUrl: process.env.NEXT_PUBLIC_REPO_URL ?? 'https://github.com/rssilverioo/evobridge',
  docsUrl: `${process.env.NEXT_PUBLIC_REPO_URL ?? 'https://github.com/rssilverioo/evobridge'}#readme`,
};
