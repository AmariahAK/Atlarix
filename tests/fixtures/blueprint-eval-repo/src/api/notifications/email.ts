import { renderTemplate } from "./templates";
import { smtpSend } from "@lib/http/smtp";

export async function sendEmailNotification(to: string, template: string, vars: Record<string, string>) {
  const html = renderTemplate(template, vars);
  return smtpSend(to, html);
}
