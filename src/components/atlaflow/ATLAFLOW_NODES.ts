/**
 * Atlaflow Node Library - Draggable n8n node types + inferred app nodes
 * Curated set for common use cases; includes all languages Atlarix supports.
 */

export interface AtlaflowNodeDef {
  type: string;
  label: string;
  category: "trigger" | "action" | "data" | "app";
}

export const ATLAFLOW_NODE_LIBRARY: AtlaflowNodeDef[] = [
  // Triggers
  { type: "n8n-nodes-base.webhook", label: "Webhook", category: "trigger" },
  { type: "n8n-nodes-base.manualTrigger", label: "Manual", category: "trigger" },
  { type: "n8n-nodes-base.scheduleTrigger", label: "Schedule", category: "trigger" },

  // Data / Storage
  { type: "n8n-nodes-base.postgres", label: "PostgreSQL", category: "data" },
  { type: "n8n-nodes-base.mySql", label: "MySQL", category: "data" },
  { type: "n8n-nodes-base.mongoDb", label: "MongoDB", category: "data" },
  { type: "n8n-nodes-base.redis", label: "Redis", category: "data" },
  { type: "n8n-nodes-base.supabase", label: "Supabase", category: "data" },

  // Integrations
  { type: "n8n-nodes-base.stripe", label: "Stripe", category: "action" },
  { type: "n8n-nodes-base.openAi", label: "OpenAI", category: "action" },
  { type: "n8n-nodes-base.sendGrid", label: "SendGrid", category: "action" },
  { type: "n8n-nodes-base.twilio", label: "Twilio", category: "action" },
  { type: "n8n-nodes-base.slack", label: "Slack", category: "action" },
  { type: "n8n-nodes-base.notion", label: "Notion", category: "action" },
  { type: "n8n-nodes-base.airtable", label: "Airtable", category: "action" },
  { type: "n8n-nodes-base.discord", label: "Discord", category: "action" },
  { type: "n8n-nodes-base.httpRequest", label: "HTTP Request", category: "action" },

  // Logic
  { type: "n8n-nodes-base.if", label: "If", category: "action" },
  { type: "n8n-nodes-base.switch", label: "Switch", category: "action" },
  { type: "atlaflow.branch", label: "Branch", category: "action" },

  // Inferred app nodes (all languages — so every user is catered for)
  { type: "atlaflow.reactApp", label: "React App", category: "app" },
  { type: "atlaflow.nextApp", label: "Next.js App", category: "app" },
  { type: "atlaflow.vueApp", label: "Vue App", category: "app" },
  { type: "atlaflow.apiServer", label: "API Server", category: "app" },
  { type: "atlaflow.app", label: "App", category: "app" },
  { type: "atlaflow.pythonApp", label: "Python App", category: "app" },
  { type: "atlaflow.pythonApi", label: "FastAPI", category: "app" },
  { type: "atlaflow.djangoApp", label: "Django App", category: "app" },
  { type: "atlaflow.flaskApp", label: "Flask App", category: "app" },
  { type: "atlaflow.goApp", label: "Go App", category: "app" },
  { type: "atlaflow.rustApp", label: "Rust App", category: "app" },
  { type: "atlaflow.rubyApp", label: "Ruby App", category: "app" },
  { type: "atlaflow.javaApp", label: "Java App", category: "app" },
  { type: "atlaflow.phpApp", label: "PHP App", category: "app" },
  { type: "atlaflow.dotnetApp", label: ".NET App", category: "app" },
  { type: "atlaflow.denoApp", label: "Deno App", category: "app" },
  { type: "atlaflow.elixirApp", label: "Elixir App", category: "app" },
];
