import { dbQuery } from "@lib/db/client";

export async function recordTransaction(
  customerId: string,
  amountCents: number,
  chargeId: string,
) {
  await dbQuery(
    "INSERT INTO transactions (customer, amount, charge) VALUES (?, ?, ?)",
    [customerId, amountCents, chargeId],
  );
}

export async function findTransaction(transactionId: string) {
  const rows = await dbQuery("SELECT * FROM transactions WHERE id = ?", [
    transactionId,
  ]);
  return rows[0] ?? null;
}
