/**
 * How a recorded model reads back to the user.
 *
 * Renderer-safe and free of React on purpose: this is the one line that carries the
 * whole point of storing `provider` beside `model_id`, so it is worth being able to
 * assert directly.
 */

import {
  formatModelApiNameForDisplay,
  formatModelWithProvider,
} from "@/lib/format-openrouter-model-label";
import { ATLARIX_CORE_CATEGORY_LABEL } from "@/shared/compass_product_copy";

/** Atlarix Core's internal provider id, as stored in `edit_stats.provider`. */
const CORE_PROVIDER_ID = "compass";

/**
 * The same model reached two ways has to read as two things.
 *
 * `compass` means the turn ran through Atlarix Core; anything else means the user's
 * own key. Falling back to the picker's own label would render both as
 * "DeepSeek V4 Pro (deepseek)" — Core's synthetic model carries its VENDOR slug for
 * display — which is exactly the distinction this card exists to draw.
 */
export function editStatsModelLabel(row: {
  provider: string;
  modelId: string;
}): string {
  const name = formatModelApiNameForDisplay(row.modelId);
  return row.provider === CORE_PROVIDER_ID
    ? `${name} (${ATLARIX_CORE_CATEGORY_LABEL})`
    : formatModelWithProvider(name, row.provider);
}
