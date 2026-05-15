export interface Entity {
  id: string;
}

export type Status = { kind: "ok" } | { kind: "err"; code: number };

export class Repo<T extends Entity> {
  find(id: string): T | undefined {
    return undefined;
  }
}

export function createRepo<T extends Entity>(): Repo<T> {
  return new Repo<T>();
}
