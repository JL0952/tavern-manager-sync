// Requests to Manager carry the access token kept in the sync state, which a
// device other than Manager's own computer needs. The token is read once,
// and read again whenever Manager refuses a request for it, since another tab
// or device may have signed in with a new password meanwhile.

export const MANAGER_TOKEN_HEADER = "X-Manager-Token";

export function createManagerFetch({ sidecarStore, fetch: fetchImpl = globalThis.fetch } = {}) {
  let token;

  async function readToken() {
    token = (await sidecarStore.read()).config.token ?? null;
    return token;
  }

  function send(url, options, current) {
    if (!current) return fetchImpl(url, options);
    const headers = new Headers(options.headers);
    headers.set(MANAGER_TOKEN_HEADER, current);
    return fetchImpl(url, { ...options, headers });
  }

  // Manager refuses before reading the body, so a refused request is safe to
  // send again.
  return async function managerFetch(url, options = {}) {
    const used = token === undefined ? await readToken() : token;
    const response = await send(url, options, used);
    if (response.status !== 401) return response;
    const latest = await readToken();
    return latest && latest !== used ? send(url, options, latest) : response;
  };
}
