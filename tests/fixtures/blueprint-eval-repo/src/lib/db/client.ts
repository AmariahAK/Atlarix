let connected = false;

export async function dbConnect(url: string) {
  connected = true;
  return { url };
}

export async function dbQuery(sql: string, params: unknown[]): Promise<any[]> {
  if (!connected) await dbConnect("sqlite://default");
  return [];
}
