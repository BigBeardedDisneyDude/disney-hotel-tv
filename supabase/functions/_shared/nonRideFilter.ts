// Non-ride filter for collect-waits, mirroring waits-core.js's NON_RIDE_PATTERNS
// (used by waittimes.html / wdwwait.html). There's no build step to actually
// share the file between the browser JS and this Deno function, so keep the
// two pattern lists in sync by hand — if you edit one, edit the other.
//
// Filters shows, meet-and-greets, walkthroughs, etc. out of what gets written
// to wait_times, so the predictor's historical data isn't polluted by rows
// that never had a real standby wait. KEEP_OVERRIDES lists the handful of
// show/transport-style attractions the ride predictors (predict.html /
// wdwpredict.html) deliberately model with real baseline curves — they would
// otherwise match a pattern below and get dropped. Cross-checked against both
// predictors' full ride rosters on 2026-09-12; nothing in the dl/dca/hs
// rosters matches any pattern, so only mk/epcot/ak need overrides.

export const NON_RIDE_PATTERNS: RegExp[] = [
  /\bmeet\b/i, /sing-?along/i, /\bon stage\b/i, /stunt spectacular/i,
  /\bmusical\b/i, /\bconcert\b/i, /clubhouse live/i, /disney jr\./i,
  /mickey mouse clubhouse/i, /turtle talk/i, /philharmagic/i,
  /\bshort film\b/i, /film festival/i, /film spotlight/i, /animated short/i,
  /circle-?vision/i, /\bcinema\b/i, /\bgallery\b/i, /hall of presidents/i,
  /great moments with mr\.? lincoln/i, /a magical life/i,
  /carousel of progress/i, /country bear/i, /festival of the lion king/i,
  /\blion king\b/i, /feathered friends in flight/i,
  /for the first time in forever/i, /the big blue/i,
  /beauty and the beast/i, /\bzootopia\b/i, /better zoogether/i,
  /enchanted tales with belle/i, /shootin['’]/i, /exposition/i,
  /\btheat(er|re)\b/i, /celebrity spotlight/i, /red carpet dreams/i,
  /walt disney presents/i, /animation academy/i, /sorcerer'?s workshop/i,
  /bakery tour/i, /awesome planet/i, /\bexhibits?\b/i,
  /conservation station/i, /wilderness explorers/i, /\btrails?\b/i,
  /\bwalkthrough\b/i, /\btreehouse\b/i, /tree of life/i, /journey of water/i,
  /\baquarium\b/i, /games of pixar pier/i, /main street vehicles/i,
  /\bminnie'?s house\b/i, /\bmickey'?s house\b/i, /world of color/i,
  /laugh floor/i, /pirate'?s adventure/i, /soak station/i,
  /cinderella castle/i,
];

const KEEP_OVERRIDES: Record<string, string[]> = {
  mk: [
    "Walt Disney's Carousel of Progress",
    "Mickey's PhilharMagic",
    'Country Bear Musical Jamboree',
    'Swiss Family Treehouse',
    'Monsters, Inc. Laugh Floor',
  ],
  epcot: [
    'Turtle Talk With Crush',
    'Canada Far and Wide in Circle-Vision 360',
  ],
  ak: [
    'Zootopia: Better Zoogether!',
    "Bluey's Wild World at Conservation Station",
  ],
};

const KEEP_SETS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(KEEP_OVERRIDES).map(([park, names]) => [park, new Set(names)])
);

export function isRide(name: string, park: string): boolean {
  if (KEEP_SETS[park]?.has(name)) return true;
  for (const pattern of NON_RIDE_PATTERNS) {
    if (pattern.test(name)) return false;
  }
  return true;
}
