// Serves the static HTML/CSS/JS for all three surfaces from an embedded
// string map rather than reading supabase/functions/album/public/** off
// disk at request time. That's not a stylistic choice — a real deploy
// confirmed the public/ directory isn't shipped as loose files at all, only
// whatever the module import graph pulls in. assets/generated.ts is built
// from public/** by scripts/build-assets.js (run before every deploy); see
// that script's header for the full story.

import { ASSETS } from "../assets/generated.ts";

export function readPublic(relPath: string): string {
  const content = ASSETS[relPath];
  if (content === undefined) throw new Error(`Unknown static file: ${relPath}`);
  return content;
}
