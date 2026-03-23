import { atom } from "jotai";

/** Set to a feature id (e.g. "blueprint") to start that Shepherd tour from a ? button */
export const tourFeatureRequestAtom = atom<string | null>(null);
