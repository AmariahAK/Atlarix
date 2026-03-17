/**
 * Workforce extensions — v4.0
 * All extensions use Auth0 Token Vault for auth.
 */

export type { WorkforceExtension } from "./types";
export { createWorkforceExtension } from "./create-extension";
export { slackExtension } from "./extensions/slack";
export { googleChatExtension } from "./extensions/google-chat";
export { jiraExtension } from "./extensions/jira";
export { linearExtension } from "./extensions/linear";
export { sentryExtension } from "./extensions/sentry";
export { notionExtension } from "./extensions/notion";
export { googleCalendarExtension } from "./extensions/google-calendar";
export { gitlabExtension } from "./extensions/gitlab";
export { bitbucketExtension } from "./extensions/bitbucket";

import type { WorkforceExtension } from "./types";
import { slackExtension } from "./extensions/slack";
import { googleChatExtension } from "./extensions/google-chat";
import { jiraExtension } from "./extensions/jira";
import { linearExtension } from "./extensions/linear";
import { sentryExtension } from "./extensions/sentry";
import { notionExtension } from "./extensions/notion";
import { googleCalendarExtension } from "./extensions/google-calendar";
import { gitlabExtension } from "./extensions/gitlab";
import { bitbucketExtension } from "./extensions/bitbucket";

const allExtensions: WorkforceExtension[] = [
  slackExtension,
  googleChatExtension,
  jiraExtension,
  linearExtension,
  sentryExtension,
  notionExtension,
  googleCalendarExtension,
  gitlabExtension,
  bitbucketExtension,
];

export function getAllWorkforceExtensions(): WorkforceExtension[] {
  return [...allExtensions];
}

export function getWorkforceExtensionByService(service: string): WorkforceExtension | undefined {
  return allExtensions.find((e) => e.service === service);
}
