export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Public origin of this deployment, used to build report URLs for the routine.
export function baseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${proto}://${host}`;
}
