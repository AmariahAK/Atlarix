import { handleEmailJob, handleRefundJob } from "./handlers";

const handlers: Record<string, (payload: unknown) => Promise<void>> = {
  email: handleEmailJob,
  refund: handleRefundJob,
};

export async function dispatchJob(jobType: string, payload: unknown) {
  // dynamic dispatch: the callee is computed, not a bare identifier
  await handlers[jobType](payload);
}
