import assert from "node:assert/strict";
import test from "node:test";
import { createManagerFetch } from "../manager-fetch.js";
import { createMinimalSyncService } from "../minimal-service.js";
import { SidecarError, createEmptyMinimalSidecar, validateMinimalSidecar } from "../sidecar-settings.js";

const endpoint = "http://192.168.1.20:3000/api/sync/v1";

function memoryStore(config = { endpoint }) {
  let state = { ...createEmptyMinimalSidecar(), config };
  return {
    reads: 0,
    async read() { this.reads += 1; return structuredClone(state); },
    async update(mutator) {
      const candidate = structuredClone(state);
      const result = await mutator(candidate);
      state = validateMinimalSidecar(candidate);
      return result;
    },
    set(next) { state = { ...state, config: next }; },
  };
}

test("the sync state may hold a Manager token beside the endpoint, nothing else", () => {
  const sidecar = createEmptyMinimalSidecar();
  sidecar.config = { endpoint, token: "synthetic-token" };
  assert.deepEqual(validateMinimalSidecar(sidecar), sidecar);
  assert.throws(() => validateMinimalSidecar({ ...sidecar, config: { endpoint, token: "" } }), SidecarError);
  assert.throws(() => validateMinimalSidecar({ ...sidecar, config: { endpoint, password: "x" } }), SidecarError);
});

test("every Manager request carries the token, re-read once when Manager refuses it", async () => {
  const store = memoryStore({ endpoint, token: "old" });
  const seen = [];
  const managerFetch = createManagerFetch({ sidecarStore: store, fetch: async (url, options) => {
    seen.push({ url, token: options.headers?.get?.("X-Manager-Token") ?? null, body: options.body });
    return new Response("{}", { status: seen.at(-1).token === "new" ? 200 : 401 });
  } });

  assert.equal((await managerFetch(`${endpoint}/manifest`)).status, 401);
  assert.deepEqual(seen.map((request) => request.token), ["old"], "an unchanged token is not sent twice");

  store.set({ endpoint, token: "new" });
  const response = await managerFetch(`${endpoint}/characters`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.deepEqual(seen.slice(1).map((request) => [request.token, request.body]), [["old", "{}"], ["new", "{}"]]);

  const reads = store.reads;
  await managerFetch(`${endpoint}/manifest`);
  assert.equal(store.reads, reads, "the token is kept between requests");
});

test("without a token requests go out unchanged", async () => {
  const seen = [];
  const managerFetch = createManagerFetch({ sidecarStore: memoryStore(), fetch: async (url, options) => {
    seen.push(options);
    return new Response("{}");
  } });
  const options = { cache: "no-store" };
  await managerFetch(`${endpoint}/manifest`, options);
  assert.equal(seen[0], options);
});

test("Save with a password signs in once and keeps only the token; a new endpoint drops it", async () => {
  const store = memoryStore({ endpoint: null });
  const requests = [];
  const service = createMinimalSyncService({ sidecarStore: store, fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return JSON.parse(options.body).password === "synthetic pass"
      ? Response.json({ token: "synthetic-token" })
      : Response.json({ error: { code: "manager_wrong_password", message: "Wrong password." } }, { status: 403 });
  } });

  await assert.rejects(service.configure({ endpoint, password: "nope" }), (error) =>
    error.code === "manager_wrong_password" && /Wrong password/.test(error.message));
  assert.deepEqual((await store.read()).config, { endpoint: null }, "a failed sign-in saves nothing");

  assert.deepEqual(await service.configure({ endpoint: `${endpoint}/`, password: "synthetic pass" }),
    { endpoint, configured: true, signedIn: true });
  assert.equal(requests.at(-1).url, "http://192.168.1.20:3000/api/auth/login");
  assert.deepEqual((await store.read()).config, { endpoint, token: "synthetic-token" });
  assert.doesNotMatch(JSON.stringify(await store.read()), /synthetic pass/);

  assert.equal((await service.configure({ endpoint })).signedIn, true, "saving the same endpoint keeps the token");
  const other = "http://192.168.1.21:3000/api/sync/v1";
  assert.deepEqual(await service.configure({ endpoint: other }), { endpoint: other, configured: true, signedIn: false });
  assert.equal(requests.length, 2, "Save without a password never signs in");
});
