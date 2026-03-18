/**
 * Slack API helpers — used by workforce tools and Workspace Context.
 */

export async function fetchUnreadMentions(accessToken: string): Promise<string[]> {
  const res = await fetch("https://slack.com/api/users.conversations?limit=50&exclude_archived=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { ok?: boolean; channels?: Array<{ id: string; name?: string; num_unread?: number }> };
  if (!data.ok || !data.channels?.length) return [];
  const withUnread = data.channels.filter((c) => (c.num_unread ?? 0) > 0);
  return withUnread.slice(0, 10).map((c) => `#${c.name ?? c.id} (${c.num_unread} unread)`);
}

export async function fetchChannelInfo(accessToken: string, channelId: string): Promise<{ name?: string; messages?: string[] }> {
  const infoRes = await fetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) return {};
  const info = (await infoRes.json()) as { ok?: boolean; channel?: { name?: string } };
  const name = info.channel?.name;
  const historyRes = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=20`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!historyRes.ok) return { name };
  const hist = (await historyRes.json()) as { ok?: boolean; messages?: Array<{ text?: string }> };
  const messages = hist.ok && hist.messages ? hist.messages.map((m) => m.text ?? "").filter(Boolean) : [];
  return { name, messages };
}

export async function postMessage(accessToken: string, channelId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ channel: channelId, text }),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: !!data.ok, error: data.error };
}
