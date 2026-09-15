/**
 * The 50 sentences become one note.
 *
 * ONE NOTE, NOT FIFTY, and the arithmetic is the reason. Fifty index lines is
 * ~1,400 tokens on every round — worse than the thing being replaced. And a
 * 280-character sentence has no title and no description worth writing, so
 * auto-generating fifty retrieval keys would produce fifty bad ones, which
 * poisons the one mechanism the whole design depends on: the model deciding
 * from a line whether a note is worth opening.
 *
 * THE LEGACY KEY IS LEFT IN PLACE for a release. The desktop's rule, and the
 * right one: copying is recoverable, deleting is not. A later migration removes
 * it once this has run everywhere.
 *
 * IDEMPOTENT, and the marker is the presence of the note rather than a flag of
 * its own — the shape `migrateLegacyMemoryMd` uses. A flag is a second thing
 * that can be wrong; the note either exists or it does not.
 */

import { api } from "../shared/browser-api";
import { saveNote, readNote, type Note } from "./notes";

const LEGACY_KEY = "atlarix.memory.v1";
export const MIGRATED_NOTE = "about-me";

interface LegacyFact {
  id: string;
  text: string;
  createdAt: number;
}

function isLegacyFact(v: unknown): v is LegacyFact {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return typeof f.id === "string" && typeof f.text === "string";
}

/**
 * Run once, on the first index read of a session.
 *
 * NEVER THROWS. It runs on a path that leads to building a prompt; a corrupt
 * legacy value must cost the user nothing worse than an empty notes section.
 */
export async function migrateLegacyFacts(): Promise<Note | null> {
  try {
    if (await readNote(MIGRATED_NOTE)) return null;

    const bag = await api().storage.local.get<Record<string, unknown>>(
      LEGACY_KEY,
    );
    const raw = (bag?.[LEGACY_KEY] as { facts?: unknown })?.facts;
    if (!Array.isArray(raw)) return null;

    // Oldest first, as stored — the order the user said them in, which is the
    // only ordering that carries any meaning.
    const facts = raw.filter(isLegacyFact);
    if (facts.length === 0) return null;

    return await saveNote({
      name: MIGRATED_NOTE,
      title: "About me",
      description:
        "things the user has told Atlarix about themselves (migrated)",
      type: "user",
      body: facts.map((f) => `- ${f.text}`).join("\n"),
    });
  } catch {
    return null;
  }
}
