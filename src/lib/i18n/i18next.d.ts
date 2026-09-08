/**
 * Make a wrong translation key a COMPILE error, not a runtime surprise.
 *
 * This is the primary guard for the whole migration, and it is nearly free: with
 * `resources` pointing at the English catalogs, `t("settings.titl")` fails
 * `npm run check:ts`, which is already the first step in CI. The alternative —
 * noticing at runtime that a label rendered as "settings.titl" — depends on
 * somebody opening that screen in that locale.
 *
 * `defaultNS` matches the runtime init, so `t("save")` resolves against `common`
 * and `t("settings:title")` against `settings`, exactly as at runtime. If the two
 * ever disagree the types describe an app that does not exist.
 */
import type { EN_RESOURCES } from "./index";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof EN_RESOURCES;
    returnNull: false;
  }
}
