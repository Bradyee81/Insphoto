// Small response helpers shared by every route.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...CORS, ...init.headers },
  });
}

export function notFound(message = "not found"): Response {
  return json({ error: message }, { status: 404 });
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function unauthorized(message = "unauthorized"): Response {
  return json({ error: message }, { status: 401 });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
