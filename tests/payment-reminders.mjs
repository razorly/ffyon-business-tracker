import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identifier = path.join(root, "src/lib/payment-reminders.ts");
const source = await readFile(identifier, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  fileName: identifier,
}).outputText;
const normalize = (value) => JSON.parse(JSON.stringify(value));
const seenKey = (device = "device-one") => `ffyon-payment-reminders-seen:${device}`;
const appointment = (overrides = {}) => ({
  id: 101,
  remote_id: "fixture-remote-booking",
  date: "2026-10-01",
  time_confirmed: 1,
  start_time: "10:00",
  duration_min: 45,
  status: "confirmed",
  transaction_id: null,
  price_pence: 2200,
  client_name: "Private Customer Name",
  account_email: "private@example.invalid",
  visit_address: "Private street address",
  visit_postcode: "SW1A 1AA",
  service_name: "Private service label",
  ...overrides,
});

async function application({ storage = new Map(), ...options } = {}) {
  assert.equal(typeof vm.SourceTextModule, "function", "Run with node --experimental-vm-modules --test tests/payment-reminders.mjs");
  const calls = [];
  const errors = [];
  const state = {
    desktop: true,
    access: { state: "online", device_id: "device-one" },
    granted: true,
    requestedPermission: "granted",
    permissionRequests: 0,
    permissionChecks: 0,
    accessChecks: 0,
    ...options,
  };
  const localStorage = {
    getItem: (key) => {
      if (state.storageUnavailable) throw new Error("Fixture storage unavailable");
      return storage.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (state.storageUnavailable) throw new Error("Fixture storage unavailable");
      storage.set(key, value);
    },
  };
  const context = vm.createContext({
    localStorage,
    console: { error: (...args) => errors.push(args) },
  });
  const mocks = {
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        calls.push({ command, args: normalize(args) });
        assert.equal(command, "notify_payment_confirmation", "Reminders must not perform database, website or email mutations");
        return state.invoke ? state.invoke(command, args) : null;
      },
    },
    "./access": {
      isDesktop: () => state.desktop,
      getAccessStatus: async () => {
        state.accessChecks++;
        return state.getAccess ? state.getAccess() : state.access;
      },
    },
    "@tauri-apps/plugin-notification": {
      isPermissionGranted: async () => {
        state.permissionChecks++;
        return state.isPermissionGranted ? state.isPermissionGranted() : state.granted;
      },
      requestPermission: async () => {
        state.permissionRequests++;
        return state.requestPermission ? state.requestPermission() : state.requestedPermission;
      },
    },
  };
  const modules = new Map();
  const linker = async (specifier) => {
    assert.ok(mocks[specifier], `Unexpected reminder dependency: ${specifier}`);
    if (!modules.has(specifier)) {
      const exports = mocks[specifier];
      modules.set(specifier, new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: specifier }));
    }
    return modules.get(specifier);
  };
  const module = new vm.SourceTextModule(compiled, {
    context,
    identifier,
    async importModuleDynamically(specifier) {
      const dependency = await linker(specifier);
      if (dependency.status === "unlinked") await dependency.link(linker);
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    },
  });
  await module.link(linker);
  await module.evaluate();
  return { app: module.namespace, state, storage, calls, errors };
}

test("payment reminders send once across repeated refreshes, concurrent calls and restarts", async () => {
  const fixture = await application();
  const row = appointment();
  const results = await Promise.all([
    fixture.app.notifyPaymentConfirmations([row], () => true),
    fixture.app.notifyPaymentConfirmations([row], () => true),
  ]);
  assert.deepEqual(results, ["sent", "idle"]);
  assert.equal(fixture.calls.length, 1);
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "idle");
  assert.equal(fixture.calls.length, 1);
  const restarted = await application({ storage: fixture.storage });
  assert.equal(await restarted.app.notifyPaymentConfirmations([row], () => true), "idle");
  assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.state.permissionChecks, 0);
});

test("payment reminder deduplication is isolated by approved device and stable remote identity", async () => {
  const fixture = await application();
  const row = appointment();
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(await fixture.app.notifyPaymentConfirmations([appointment({ id: 999 })], () => true), "idle");
  fixture.state.access = { state: "offline", device_id: "device-two" };
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(fixture.calls.length, 2);
  assert.ok(fixture.storage.has(seenKey("device-one")));
  assert.ok(fixture.storage.has(seenKey("device-two")));
  fixture.state.access = { state: "online", device_id: "device-one" };
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "idle");
});

test("new and rescheduled appointments trigger count-only notifications without customer details", async () => {
  const fixture = await application();
  const original = appointment();
  assert.equal(await fixture.app.notifyPaymentConfirmations([original], () => true), "sent");
  const added = appointment({ id: 102, remote_id: null, start_time: "12:00" });
  assert.equal(await fixture.app.notifyPaymentConfirmations([original, added], () => true), "sent");
  assert.equal(await fixture.app.notifyPaymentConfirmations([appointment({ start_time: "11:00" }), added], () => true), "sent");
  assert.deepEqual(fixture.calls, [
    { command: "notify_payment_confirmation", args: { count: 1 } },
    { command: "notify_payment_confirmation", args: { count: 2 } },
    { command: "notify_payment_confirmation", args: { count: 2 } },
  ]);
  const persisted = [...fixture.storage.values()].join(" ");
  for (const privateValue of [original.client_name, original.account_email, original.visit_address, original.visit_postcode, original.service_name]) {
    assert.equal(JSON.stringify(fixture.calls).includes(privateValue), false);
    assert.equal(persisted.includes(privateValue), false);
  }
});

test("completed reminders are pruned and undoing payment can alert again", async () => {
  const fixture = await application();
  const row = appointment();
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(await fixture.app.notifyPaymentConfirmations([], () => true), "idle");
  assert.deepEqual(JSON.parse(fixture.storage.get(seenKey())), []);
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(fixture.calls.length, 2);
});

test("denied notification permission is requested once per session and never marks reminders seen", async () => {
  const fixture = await application({ granted: false, requestedPermission: "denied" });
  const row = appointment();
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "blocked");
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "blocked");
  assert.equal(fixture.state.permissionRequests, 1);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.storage.has(seenKey()), false);
  fixture.state.granted = true;
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(fixture.state.permissionRequests, 1);
  assert.ok(fixture.storage.has(seenKey()));
  const restarted = await application({ storage: new Map(), granted: false, requestedPermission: "denied" });
  assert.equal(await restarted.app.notifyPaymentConfirmations([row], () => true), "blocked");
  assert.equal(restarted.state.permissionRequests, 1);
});

test("native notification rejection leaves the reminder unseen and subsequent refresh retries", async () => {
  let attempts = 0;
  const fixture = await application({ invoke: async () => {
    if (++attempts === 1) throw new Error("Fixture native delivery rejected");
    return null;
  } });
  const row = appointment();
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "error");
  assert.equal(fixture.storage.has(seenKey()), false);
  assert.equal(fixture.errors.length, 1);
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(attempts, 2);
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "idle");
  assert.equal(attempts, 2);
});

test("locked, unidentified, non-desktop and cancelled reminder sessions cannot notify", async () => {
  const row = appointment();
  for (const access of [
    { state: "locked", device_id: "device-one" },
    { state: "checking", device_id: "device-one" },
    { state: "online", device_id: null },
  ]) {
    const fixture = await application({ access });
    assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => true), "idle");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.state.permissionChecks, 0);
    assert.equal(fixture.storage.size, 0);
  }
  const nonDesktop = await application({ desktop: false });
  assert.equal(await nonDesktop.app.notifyPaymentConfirmations([row], () => true), "idle");
  assert.equal(nonDesktop.state.accessChecks, 0);
  const cancelled = await application();
  assert.equal(await cancelled.app.notifyPaymentConfirmations([row], () => false), "idle");
  assert.equal(cancelled.state.accessChecks, 0);
  assert.equal(cancelled.calls.length, 0);
});

test("cancellation after async access or permission work prevents notification delivery", async () => {
  const row = appointment();
  let current = true;
  const afterAccess = await application({ getAccess: async () => {
    current = false;
    return { state: "online", device_id: "device-one" };
  } });
  assert.equal(await afterAccess.app.notifyPaymentConfirmations([row], () => current), "idle");
  assert.equal(afterAccess.state.permissionChecks, 0);
  assert.equal(afterAccess.calls.length, 0);
  current = true;
  const afterPermission = await application({ granted: false, requestPermission: async () => {
    current = false;
    return "granted";
  } });
  assert.equal(await afterPermission.app.notifyPaymentConfirmations([row], () => current), "idle");
  assert.equal(afterPermission.state.permissionRequests, 1);
  assert.equal(afterPermission.calls.length, 0);
  assert.equal(afterPermission.storage.has(seenKey()), false);
});

test("payment reminder preference defaults on and persisted off/on controls the current predicate", async () => {
  const fixture = await application();
  const row = appointment();
  const current = () => fixture.app.readPaymentRemindersEnabled();
  assert.equal(current(), true);
  fixture.app.writePaymentRemindersEnabled(false);
  assert.equal(current(), false);
  assert.equal(fixture.storage.get("ffyon-payment-reminders"), "off");
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], current), "idle");
  assert.equal(fixture.calls.length, 0);
  const restarted = await application({ storage: fixture.storage });
  assert.equal(restarted.app.readPaymentRemindersEnabled(), false);
  fixture.app.writePaymentRemindersEnabled(true);
  assert.equal(current(), true);
  assert.equal(fixture.storage.get("ffyon-payment-reminders"), "on");
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], current), "sent");
});

test("cancelling during permission lookup does not consume an unshown permission prompt", async () => {
  let current = true;
  let cancelLookup = true;
  const fixture = await application({ granted: false, isPermissionGranted: async () => {
    if (cancelLookup) current = false;
    return false;
  } });
  const row = appointment();
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => current), "idle");
  assert.equal(fixture.state.permissionRequests, 0);
  current = true;
  cancelLookup = false;
  assert.equal(await fixture.app.notifyPaymentConfirmations([row], () => current), "sent");
  assert.equal(fixture.state.permissionRequests, 1);
  assert.equal(fixture.calls.length, 1);
});

test("damaged or unavailable bookkeeping cannot crash reminders or defeat in-session deduplication", async () => {
  const damaged = await application({ storage: new Map([[seenKey(), "not valid JSON"]]) });
  const row = appointment();
  assert.equal(await damaged.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.ok(Array.isArray(JSON.parse(damaged.storage.get(seenKey()))));
  const unavailable = await application({ storageUnavailable: true });
  assert.equal(unavailable.app.readPaymentRemindersEnabled(), true);
  assert.equal(await unavailable.app.notifyPaymentConfirmations([row], () => true), "sent");
  assert.equal(await unavailable.app.notifyPaymentConfirmations([row], () => true), "idle");
  assert.equal(unavailable.calls.length, 1);
  unavailable.app.writePaymentRemindersEnabled(false);
  assert.equal(unavailable.app.readPaymentRemindersEnabled(), false, "Disabled reminders must stay disabled for the session without storage");
  unavailable.app.writePaymentRemindersEnabled(true);
  assert.equal(unavailable.app.readPaymentRemindersEnabled(), true);
  assert.equal(unavailable.storage.size, 0);
});
