export async function smtpSend(to: string, html: string) {
  return { accepted: [to], size: html.length };
}
