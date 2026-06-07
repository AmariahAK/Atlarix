const TEMPLATES: Record<string, string> = {
  welcome: "<h1>Welcome, {{name}}!</h1>",
  receipt: "<p>Receipt for {{amount}}</p>",
};

export function renderTemplate(name: string, vars: Record<string, string>) {
  let html = TEMPLATES[name] ?? "";
  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll("{{" + k + "}}", v);
  }
  return html;
}
