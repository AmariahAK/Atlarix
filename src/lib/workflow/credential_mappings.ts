/**
 * Credential Mappings - Minimal manual layer
 * - DATABASE_NODE_PATTERNS: node type → database + ORM (used with n8n node defs)
 * - Env vars & packages: auto from n8n_credential_loader (fetches n8n source)
 */

/** Database node types (by n8n node name) → database + ORM */
export const DATABASE_NODE_PATTERNS: Record<string, { database: string; orm?: string }> = {
  postgres: { database: "PostgreSQL", orm: "Prisma" },
  postgresql: { database: "PostgreSQL", orm: "Prisma" },
  mysql: { database: "MySQL", orm: "Prisma" },
  mongodb: { database: "MongoDB", orm: "Mongoose" },
  mongo: { database: "MongoDB", orm: "Mongoose" },
  redis: { database: "Redis", orm: undefined },
};
