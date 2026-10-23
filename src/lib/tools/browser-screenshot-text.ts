import type { ToolMetadata } from "./registry";

/**
 * The screenshot sentences of `browser_inspect`, named so a model that cannot
 * take an image in a tool result gets the tool without them (resolve-toolset).
 * Visual guidance says WHEN looking helps; it is not a prohibition.
 */
export const BROWSER_SCREENSHOT_SENTENCE =
  '"screenshot" returns the actual image (thousands of tokens): use it when you need to see what a text report cannot carry, such as images, charts, icons or exact styling. ';
export const BROWSER_MODE_DESCRIPTION =
  'Omit for the default read (content + refs in one call). "visual"/"design" describe how it looks, in text; "console"/"network" for runtime errors';
export const BROWSER_MODE_SCREENSHOT_CLAUSE =
  '; "screenshot" when you need to see the image itself';

/**
 * `browser_inspect` for a model whose tool results cannot carry an image: no
 * "screenshot" mode and no sentence about it. A screenshot it took would come
 * back as "this model cannot view images", a paid round trip for nothing.
 */
export function browserInspectWithoutScreenshot(meta: ToolMetadata): ToolMetadata {
  const params = meta.parameters as {
    properties: Record<string, { enum?: string[]; description?: string }>;
  };
  const mode = params.properties.mode;
  return {
    ...meta,
    description: meta.description.replace(BROWSER_SCREENSHOT_SENTENCE, ""),
    parameters: {
      ...meta.parameters,
      properties: {
        ...params.properties,
        mode: {
          ...mode,
          enum: (mode.enum ?? []).filter((m) => m !== "screenshot"),
          description: BROWSER_MODE_DESCRIPTION + ".",
        },
      },
    },
  };
}
