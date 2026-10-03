import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const identifier = path.resolve("src/lib/inbox.tsx");
const compiled = ts.transpileModule(await readFile(identifier, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  fileName: identifier,
}).outputText;
const empty = { conversations: [], unread_count: 0 };
const unread = count => ({ conversations: [], unread_count: count });
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

// Exercise the production provider effects with controlled requests/events.
// No native IPC, website, real timers or email provider is used by this fixture.
async function provider() {
  const slots = [], effects = [], requests = [], timers = new Set();
  const bookingItems = { requests: [], payments: [], error: null };
  const window = new EventTarget(), document = new EventTarget();
  document.visibilityState = "visible";
  let cursor = 0, dirty = true, value, now = 0, activeRequests = 0, maxRequests = 0;
  let access = { state: "online" };
  const state = initial => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
    return [slots[index].value, next => {
      const result = typeof next === "function" ? next(slots[index].value) : next;
      if (!Object.is(result, slots[index].value)) { slots[index].value = result; dirty = true; }
    }];
  };
  const mocks = {
    react: {
      createContext: initial => ({ Provider: "fixture-provider", initial }),
      useContext: context => context.initial,
      useState: state,
      useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; },
      useCallback: (callback, deps) => {
        const index = cursor++;
        if (!same(slots[index]?.deps, deps)) slots[index] = { deps, callback };
        return slots[index].callback;
      },
      useEffect: (effect, deps) => {
        const index = cursor++, previous = slots[index];
        if (!same(previous?.deps, deps)) effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      },
    },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "./db": { listPaymentConfirmations: async () => [] },
    "./data": { useLoad: () => [bookingItems, false] },
    "./sync": { listPendingAppointments: async () => [] },
    "./payment-reminders": { notifyPaymentConfirmations: async () => "idle", readPaymentRemindersEnabled: () => false, writePaymentRemindersEnabled: () => {} },
    "@/components/AccessGate": { useAccess: () => access },
    "./mail": { getMailUnread: () => {
      activeRequests++; maxRequests = Math.max(maxRequests, activeRequests);
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      promise.then(() => { activeRequests--; }, () => { activeRequests--; });
      requests.push({ resolve, reject });
      return promise;
    } },
  };
  const context = vm.createContext({ window, document, Error, Date: class extends Date { static now() { return now; } },
    setInterval: callback => { timers.add(callback); return callback; }, clearInterval: callback => timers.delete(callback) });
  const modules = new Map();
  const source = new vm.SourceTextModule(compiled, { context, identifier });
  await source.link(specifier => {
    assert.ok(mocks[specifier], `Unexpected Inbox dependency ${specifier}`);
    if (!modules.has(specifier)) {
      const exports = mocks[specifier];
      modules.set(specifier, new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, item] of Object.entries(exports)) this.setExport(key, item);
      }, { context, identifier: specifier }));
    }
    return modules.get(specifier);
  });
  await source.evaluate();
  const flush = async () => {
    for (let step = 0; step < 40; step++) {
      if (dirty) {
        dirty = false; cursor = 0;
        value = source.namespace.InboxProvider({ children: null }).props.value;
        while (effects.length) effects.shift()();
      }
      await Promise.resolve();
    }
    assert.equal(dirty, false, "Inbox effects should settle without a render loop");
  };
  await flush();
  return { requests, flush, window, document, get value() { return value; }, get maxRequests() { return maxRequests; },
    advance: milliseconds => { now += milliseconds; },
    interval: () => { for (const callback of timers) callback(); },
    access: next => { access = { state: next }; dirty = true; },
    close: async () => { for (const slot of slots) slot?.cleanup?.(); for (const request of requests) request.resolve(empty); await Promise.resolve(); },
  };
}

test("paired foreground events share one Mail refresh and hidden windows do not poll", async () => {
  const app = await provider();
  try {
    assert.equal(app.requests.length, 1);
    app.requests[0].resolve(empty); await app.flush();
    app.window.dispatchEvent(new Event("focus")); await app.flush();
    app.document.dispatchEvent(new Event("visibilitychange")); await app.flush();
    assert.equal(app.value.mailRevision, 1, "A window restore should cause one list/detail refresh wave");
    assert.equal(app.requests.length, 2, "Paired foreground events must not issue duplicate unread requests");
    app.requests[1].resolve(empty); await app.flush();
    app.document.visibilityState = "hidden"; app.advance(60_000);
    app.interval(); app.document.dispatchEvent(new Event("visibilitychange")); await app.flush();
    assert.equal(app.requests.length, 2);
    app.document.visibilityState = "visible";
    app.document.dispatchEvent(new Event("visibilitychange")); await app.flush();
    assert.equal(app.requests.length, 3, "Returning later must still refresh Mail");
  } finally { await app.close(); }
});

test("refresh bursts wait for unread in flight and keep one fresh follow-up", async () => {
  const app = await provider();
  try {
    for (let index = 0; index < 4; index++) { app.value.refreshMail(); await app.flush(); }
    assert.equal(app.requests.length, 1, "Refreshing while loading must not overlap unread requests");
    app.requests[0].resolve(unread(5)); await app.flush();
    assert.equal(app.requests.length, 2, "An invalidation after mark-read needs one fresh result, not the older in-flight result");
    assert.equal(app.value.mail.unread_count, 0, "A superseded result must not overwrite unread state");
    assert.equal(app.value.mailLoading, true);
    app.requests[1].resolve(unread(2)); await app.flush();
    assert.equal(app.value.mail.unread_count, 2);
    assert.equal(app.value.mailLoading, false);
    assert.equal(app.maxRequests, 1);
  } finally { await app.close(); }
});

test("a superseded unread failure cannot prevent a fresh successful result", async () => {
  const app = await provider();
  try {
    app.value.refreshMail(); await app.flush();
    app.requests[0].reject(new Error("Stale timed-out request")); await app.flush();
    assert.equal(app.requests.length, 2);
    assert.equal(app.value.mailError, null);
    app.requests[1].resolve(unread(1)); await app.flush();
    assert.equal(app.value.mail.unread_count, 1);
    assert.equal(app.value.mailError, null);
    assert.equal(app.maxRequests, 1);
  } finally { await app.close(); }
});

test("going offline prevents queued Mail work and ignores its old response", async () => {
  const app = await provider();
  try {
    app.value.refreshMail(); await app.flush();
    app.access("offline"); await app.flush();
    app.requests[0].resolve(unread(9)); await app.flush();
    assert.equal(app.requests.length, 1);
    assert.equal(app.value.mail.unread_count, 0);
    assert.equal(app.value.mailLoading, false);
    assert.equal(app.value.mailError, "Reconnect to check email.");
    app.access("online"); await app.flush();
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(unread(1)); await app.flush();
    assert.equal(app.value.mail.unread_count, 1);
    assert.equal(app.value.mailError, null);
  } finally { await app.close(); }
});
