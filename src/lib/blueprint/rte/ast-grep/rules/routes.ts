import { Lang, pattern, type NapiConfig } from "@ast-grep/napi";

export const ROUTE_PATH_CAPTURE = "PATH";
export const ROUTE_METHOD_CAPTURE = "METHOD";

export type RoutePatternSpec = {
  /** HTTP verb for Express/Fastify-style routes; undefined for Next.js export handlers. */
  httpMethod?: string;
  matcher: NapiConfig;
  /** Match captures a string literal route path (Express/Fastify). */
  capturePath: boolean;
  /** Match captures exported handler name (Next.js GET/POST/…). */
  captureMethod: boolean;
};

/** Express/Fastify/Next route handler patterns (TS/JS). */
export function routePatternSpecs(lang: Lang): RoutePatternSpec[] {
  const express = (httpMethod: string, receiver: string) => ({
    httpMethod,
    matcher: pattern(lang, `${receiver}.${httpMethod.toLowerCase()}($PATH, $$$)`),
    capturePath: true,
    captureMethod: false,
  });

  return [
    express("GET", "$APP"),
    express("POST", "$APP"),
    express("PUT", "$APP"),
    express("DELETE", "$APP"),
    express("PATCH", "$APP"),
    express("GET", "$ROUTER"),
    express("POST", "$ROUTER"),
    express("PUT", "$ROUTER"),
    express("DELETE", "$ROUTER"),
    {
      httpMethod: undefined,
      matcher: pattern(lang, "export async function $METHOD($$$) { $$$ }"),
      capturePath: false,
      captureMethod: true,
    },
    {
      httpMethod: undefined,
      matcher: pattern(lang, "export function $METHOD($$$) { $$$ }"),
      capturePath: false,
      captureMethod: true,
    },
  ];
}

const NEXT_HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

export function normalizeRouteHttpMethod(raw: string | undefined): string | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  return NEXT_HTTP_METHODS.has(upper) ? upper : null;
}
