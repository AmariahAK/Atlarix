/**
 * "Where did you hear about Atlarix?" — the single attribution question that
 * analytics cannot answer on its own.
 *
 * PostHog auto-captures `$referrer`/UTM on the website, but the chain dies at
 * the installer download: nothing connects a `.dmg` back to the tweet, the
 * hackathon, or the friend who recommended it. Word of mouth is invisible to
 * every automatic method, and for a tool like this it's usually the biggest
 * bucket. Self-report is the only instrument that reaches it.
 *
 * Preset options rather than free text on purpose — free text returns a hundred
 * spellings of "YouTube" and can't be grouped without manual cleanup.
 */

export const PEERPUSH_REVIEW_URL = "https://peerpush.com/p/atlarix";

export interface AcquisitionSource {
  /** Stored value. Stable — changing one orphans the answers already collected. */
  id: string;
  label: string;
}

export const ACQUISITION_SOURCES: readonly AcquisitionSource[] = [
  { id: "github", label: "GitHub" },
  { id: "vibecodinglist", label: "VibeCodingList" },
  { id: "peerpush", label: "PeerPush" },
  { id: "devpost", label: "Devpost / a hackathon" },
  { id: "reddit_hn", label: "Reddit or Hacker News" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "youtube", label: "YouTube" },
  { id: "friend", label: "A friend or colleague" },
  { id: "other", label: "Other" },
] as const;

export const OTHER_SOURCE_ID = "other";

/** Max length for the free-text "Other" detail — a label, not an essay. */
export const ACQUISITION_DETAIL_MAX = 120;

export function acquisitionLabel(id: string): string {
  return ACQUISITION_SOURCES.find((s) => s.id === id)?.label ?? id;
}
