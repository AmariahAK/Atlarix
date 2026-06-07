import { sendEmailNotification } from "../../api/notifications/email";
import { refundPayment } from "../../api/payments/refund";

export async function handleEmailJob(payload: any) {
  await sendEmailNotification(payload.to, payload.template, payload.vars);
}

export async function handleRefundJob(payload: any) {
  await refundPayment(payload.transactionId);
}
