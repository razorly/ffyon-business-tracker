import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFits, assertLocal, capture, installDesktopFixture } from "./features-browser.js";

const url = process.env.FFYON_TIME_OFF_URL;

// Every date hangs off the Saturday before next spring's clock change, so the week away always spans it
// and nothing here is ever in the past.
const DAY_MS = 86_400_000;
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function dates() {
  const clockChange = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 31));
  clockChange.setUTCDate(31 - clockChange.getUTCDay()); // the last Sunday of March
  const base = clockChange.getTime() - DAY_MS;
  const at = offset => new Date(base + offset * DAY_MS);
  return {
    clockChange: clockChange.toISOString().slice(0, 10),
    iso: offset => at(offset).toISOString().slice(0, 10),
    // "Sat 27 Mar 2027": the year is always said, because it is never this year.
    plain: offset => `${SHORT_DAYS[at(offset).getUTCDay()]} ${at(offset).getUTCDate()} ${SHORT_MONTHS[at(offset).getUTCMonth()]} ${at(offset).getUTCFullYear()}`,
    show: offset => `Show ${LONG_DAYS[at(offset).getUTCDay()]} ${at(offset).getUTCDate()} ${LONG_MONTHS[at(offset).getUTCMonth()]} ${at(offset).getUTCFullYear()}`,
  };
}
const pressed = locator => locator.getAttribute("aria-pressed");
const copy = value => structuredClone(value);

async function run() {
  assertLocal(url);
  const { chromium } = createRequire(import.meta.url)(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const output = resolve("test-results/time-off-browser");
  await mkdir(output, { recursive: true });
  const evidence = [];
  try {
    // Every theme and width runs even when one fails, so one failure doesn't hide the state of the others.
    const failures = [];
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
      try { evidence.push(await flow(browser, theme, width, output)); }
      catch (error) { failures.push(error); evidence.push({ theme, width, failed: String(error.message).split("\n")[0] }); }
    }
    await writeFile(resolve(output, "evidence.json"), JSON.stringify({ evidence, limitation: "Browser IPC/SQLite fixture; native WebView2 unverified. Booking capacity is covered by the real API bridge suite. The settings write behind \"Every week\" is answered by this suite, not the shared fixture." }, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `Time off failed at ${failures.length} of ${evidence.length} theme and width combinations: ${failures.map(error => String(error.message).split("\n")[0]).join(" | ")}`);
  } finally { await browser.close(); }
}

async function flow(browser, theme, width, output) {
  const wide = width >= 640;
  const { iso, plain, show, clockChange } = dates();
  const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: "America/Los_Angeles" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // She works Monday to Saturday. Website bookings are off in light and on in dark, so "Every week" is
  // checked against both: it must send back whichever it found.
  const bookingEnabled = theme === "dark";
  const openingHours = [1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, open: "09:00", close: "17:00" }));
  const records = { clients: [], appointments: [], services: [], blocks: [], settings: { booking_enabled: bookingEnabled, timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, opening_hours: copy(openingHours), admin_notifications_enabled: false, admin_notification_email: "", revision: 1 } };
  await page.addInitScript(theme => localStorage.setItem("ffyon-theme", theme), theme);
  const fixture = await installDesktopFixture(page, records);
  // The shared fixture does not answer the settings write, so it is answered here and kept for the assertions.
  const settingsWrites = [];
  await page.exposeBinding("__timeOffSettingsWrite", (_source, args) => {
    settingsWrites.push(copy(args));
    const { operation_id: _operation, ...saved } = args.body;
    records.settings = { ...saved, revision: records.settings.revision + 1 };
    return { ok: true };
  });
  await page.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === "admin_request" && args?.operation === "settings" ? window.__timeOffSettingsWrite(args) : invoke(command, args);
  });
  const blockWrites = method => fixture.mutations.filter(item => item.operation === "blocks" && item.method === method);
  const appointmentWrites = () => fixture.mutations.filter(item => item.operation === "appointments").length;
  const until = async (condition, message) => {
    const deadline = Date.now() + 15_000;
    while (!await condition()) { assert.ok(Date.now() < deadline, message); await page.waitForTimeout(40); }
  };
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);

    // ---------- Settings → When I work ----------
    await page.locator('nav a[title="Settings"]').click();
    await page.getByRole("navigation", { name: "Settings sections", exact: true }).getByRole("link", { name: /^When I work/ }).click();
    const card = page.locator("main").getByRole("heading", { name: "Time off", exact: true }).locator("../../..");
    await card.getByText("No upcoming time off.", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Add time off", exact: true }).click();
    // The dialog that adds time off and the one that shows a block's details share the title "Time off".
    const dialog = page.getByRole("dialog", { name: "Time off", exact: true });
    const kinds = dialog.getByRole("group", { name: "What kind of time off", exact: true });
    const kind = name => kinds.getByRole("button", { name, exact: true });
    const add = dialog.getByRole("button", { name: "Add time off", exact: true });
    const reasons = dialog.getByRole("group", { name: "What's it for? (optional)", exact: true });
    const confirm = page.getByRole("dialog", { name: "Remove time off?", exact: true });

    // Whole days: a week away across the spring clock change.
    assert.equal(await pressed(kind("Whole days")), "true", "Time off opens on whole days");
    assert.ok(iso(0) < clockChange && clockChange < iso(6), "The week away must span the clock change");
    await dialog.getByLabel("First day off", { exact: true }).fill(iso(0));
    assert.equal(await dialog.getByLabel("Last day off", { exact: true }).inputValue(), iso(0), "The last day follows a later first day");
    await dialog.getByLabel("Last day off", { exact: true }).fill(iso(-1));
    await dialog.getByRole("alert").filter({ hasText: "The last day off can't be before the first." }).waitFor();
    assert.equal(await add.isDisabled(), true);
    await dialog.getByLabel("Last day off", { exact: true }).fill(iso(6));
    await dialog.getByText(/^7 days off\./).waitFor();
    await reasons.getByRole("button", { name: "Something else", exact: true }).click();
    await dialog.getByLabel("What's it for?", { exact: true }).fill("A week away");
    await dialog.getByText("It shows in your diary as “A week away”.", { exact: false }).waitFor();
    for (const label of ["From", "To", "Date", "Duration (minutes)"]) assert.equal(await dialog.getByLabel(label, { exact: true }).count(), 0, `Whole days ask for no ${label}`);
    await capture(page, output, `time-off-${theme}-${width}.png`);
    await add.click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Time off added", { exact: true }).first().waitFor();
    await card.getByRole("button", { name: "Remove A week away", exact: true }).waitFor();
    assert.equal(await card.getByText("A week away", { exact: true }).count(), 1, "A week away is one period, not seven rows");
    assert.equal(await card.getByText(`${plain(0)} to ${plain(6)}`, { exact: true }).count(), 1);
    const week = blockWrites("POST")[0].body;
    assert.deepEqual([week.date, week.start_time, week.end_date, week.end_time, week.label], [iso(0), "00:00", iso(6), "23:59", "A week away"]);
    assert.equal("duration_min" in week, false);
    assert.equal(records.blocks.length, 7);
    assert.deepEqual(records.blocks.map(block => block.date), Array.from({ length: 7 }, (_, index) => iso(index)), "Every local day is covered, the clock-change day included");
    const weekBlocks = records.blocks.map(block => block.id);

    // A few hours, chosen with the keyboard, with a finish that can't come before the start.
    await card.getByRole("button", { name: "Add time off", exact: true }).click();
    await kind("A few hours").focus();
    await page.keyboard.press("Enter");
    assert.equal(await pressed(kind("A few hours")), "true");
    assert.equal(await pressed(kind("Whole days")), "false");
    for (const label of ["First day off", "Last day off"]) assert.equal(await dialog.getByLabel(label, { exact: true }).count(), 0);
    await dialog.getByLabel("Date", { exact: true }).fill(iso(9));
    await dialog.getByLabel("From", { exact: true }).fill("13:00");
    assert.equal(await dialog.getByLabel("To", { exact: true }).inputValue(), "14:00", "Moving the start keeps the finish after it");
    await dialog.getByLabel("To", { exact: true }).fill("12:00");
    assert.equal(await add.isDisabled(), true);
    await dialog.getByRole("alert").filter({ hasText: "The finish time must be after the start time." }).waitFor();
    await dialog.getByLabel("To", { exact: true }).fill("14:00");
    await reasons.getByRole("button", { name: "Holiday", exact: true }).click();
    await reasons.getByRole("button", { name: "Appointment", exact: true }).click();
    assert.deepEqual([await pressed(reasons.getByRole("button", { name: "Holiday", exact: true })), await pressed(reasons.getByRole("button", { name: "Appointment", exact: true }))], ["false", "true"], "One reason at a time");
    assert.equal(await dialog.getByLabel("What's it for?", { exact: true }).count(), 0);
    await assertFits(page);
    await add.click();
    await dialog.waitFor({ state: "hidden" });
    await card.getByRole("button", { name: "Remove Appointment", exact: true }).waitFor();
    assert.equal(await card.getByText(`${plain(9)}, 1pm to 2pm`, { exact: true }).count(), 1);
    const hours = blockWrites("POST")[1].body;
    assert.deepEqual([hours.date, hours.start_time, hours.end_date, hours.end_time, hours.label], [iso(9), "13:00", iso(9), "14:00", "Appointment"]);
    assert.equal("duration_min" in hours, false);
    assert.equal(records.blocks.length, 8);

    // Removing asks first. "Keep it" removes nothing; "Remove" removes the whole period in one request.
    await card.getByRole("button", { name: "Remove A week away", exact: true }).click();
    await confirm.getByText("A week away", { exact: true }).waitFor();
    await confirm.getByText(`${plain(0)} to ${plain(6)}`, { exact: true }).waitFor();
    await confirm.getByText("People will be able to book this time again.", { exact: true }).waitFor();
    await capture(page, output, `remove-time-off-${theme}-${width}.png`);
    await confirm.getByRole("button", { name: "Keep it", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    assert.equal(blockWrites("DELETE").length, 0);
    assert.equal(records.blocks.length, 8);
    await card.getByRole("button", { name: "Remove A week away", exact: true }).click();
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await card.getByText("A week away", { exact: true }).waitFor({ state: "hidden" });
    await page.getByText("Time off removed", { exact: true }).first().waitFor();
    assert.equal(blockWrites("DELETE").length, 1);
    const removedWeek = blockWrites("DELETE")[0].body;
    assert.equal(removedWeek.period_id, week.id);
    assert.deepEqual(removedWeek.blocks.map(block => [block.id, block.revision]).sort(), weekBlocks.map(id => [id, 1]).sort(), "The delete names every day of the period");
    assert.equal(records.blocks.length, 1);
    assert.equal(records.blocks[0].label, "Appointment");

    // ---------- Diary ----------
    await page.locator('nav a[title="Diary"]').click();
    await page.getByRole("heading", { name: "Diary", exact: true }).waitFor();
    const diary = page.locator("main");
    const view = name => page.getByRole("group", { name: "View", exact: true }).getByRole("button", { name, exact: true });
    const goTo = page.getByLabel("Go to date", { exact: true });
    const timeOffButton = page.locator("h1").locator("xpath=../..").getByRole("button", { name: "Time off", exact: true });
    const details = dialog; // same title, opened from a block
    const closeDetails = () => details.getByRole("button", { name: "Close", exact: true }).last().click();
    // A wide window shows the week as an hour grid; a phone shows one day as a list.
    assert.equal(await pressed(view(wide ? "Week" : "Day")), "true");
    await goTo.fill(iso(9));
    if (wide) await until(async () => await page.locator('[role="presentation"]').count() === 7, "The week grid has seven day columns");
    else assert.equal(await page.locator('[role="presentation"]').count(), 0, "A phone has no hour grid");

    // Time off added in Settings is in the diary, and opens its details when clicked.
    const appointmentBlock = diary.getByRole("button", { name: /Appointment/ });
    await appointmentBlock.waitFor();
    assert.equal(await appointmentBlock.count(), 1);
    assert.match(await appointmentBlock.innerText(), /1pm to 2pm/);
    if (!wide) assert.match(await appointmentBlock.innerText(), /Time off/);
    await appointmentBlock.click();
    await details.getByText("Appointment", { exact: true }).waitFor();
    await details.getByText(`${plain(9)}, 1pm to 2pm`, { exact: true }).waitFor();
    await details.getByText("Nobody can book online in this time.", { exact: true }).waitFor();
    assert.equal(await details.getByRole("button", { name: "Remove time off", exact: true }).isEnabled(), true);
    await assertFits(page);
    await closeDetails();
    await details.waitFor({ state: "hidden" });
    assert.equal(blockWrites("DELETE").length, 1, "Looking at time off removes nothing");

    // The Diary's "Time off" button starts on the day being looked at and lists what is already booked off.
    await goTo.fill(iso(16));
    await timeOffButton.click();
    assert.equal(await pressed(kind("Whole days")), "true");
    assert.equal(await dialog.getByLabel("First day off", { exact: true }).inputValue(), iso(16));
    assert.equal(await dialog.getByLabel("Last day off", { exact: true }).inputValue(), iso(16));
    const booked = dialog.getByRole("region", { name: "Booked time off", exact: true });
    await booked.getByRole("button", { name: "Remove Appointment", exact: true }).waitFor();
    assert.equal(await booked.getByText(`${plain(9)}, 1pm to 2pm`, { exact: true }).count(), 1);
    // Each kind keeps what was typed into it while she looks at another.
    await dialog.getByLabel("Last day off", { exact: true }).fill(iso(17));
    await dialog.getByText(/^2 days off\./).waitFor();
    await reasons.getByRole("button", { name: "Something else", exact: true }).click();
    await dialog.getByLabel("What's it for?", { exact: true }).fill("Schedule holiday");
    await kind("A few hours").click();
    assert.equal(await dialog.getByLabel("Date", { exact: true }).inputValue(), iso(16));
    await dialog.getByLabel("From", { exact: true }).fill("14:15");
    assert.equal(await dialog.getByLabel("To", { exact: true }).inputValue(), "15:15");
    await kind("Every week").click();
    await dialog.getByRole("group", { name: "Days you don't work", exact: true }).waitFor();
    assert.equal(await reasons.count(), 0, "The working week has no reason to give");
    assert.equal(await add.count(), 0);
    await assertFits(page);
    await kind("Whole days").click();
    assert.deepEqual([await dialog.getByLabel("First day off", { exact: true }).inputValue(), await dialog.getByLabel("Last day off", { exact: true }).inputValue(), await dialog.getByLabel("What's it for?", { exact: true }).inputValue()], [iso(16), iso(17), "Schedule holiday"]);
    await kind("A few hours").click();
    assert.deepEqual([await dialog.getByLabel("From", { exact: true }).inputValue(), await dialog.getByLabel("To", { exact: true }).inputValue()], ["14:15", "15:15"]);
    await kind("Whole days").click();
    await capture(page, output, `schedule-time-off-${theme}-${width}.png`);
    const appointmentsBefore = appointmentWrites();
    await add.click();
    await dialog.waitFor({ state: "hidden" });
    // The diary shows it straight away, as whole days, without a booking or a client being made.
    const holiday = diary.getByRole("button", { name: /Schedule holiday/ });
    await holiday.first().waitFor();
    const holidayWrite = blockWrites("POST")[2].body;
    assert.deepEqual([holidayWrite.date, holidayWrite.start_time, holidayWrite.end_date, holidayWrite.end_time, holidayWrite.label], [iso(16), "00:00", iso(17), "23:59", "Schedule holiday"]);
    assert.equal("duration_min" in holidayWrite, false);
    assert.equal(appointmentWrites(), appointmentsBefore);
    assert.equal(records.clients.length, 0);
    assert.equal(records.blocks.length, 3);
    if (wide) {
      // Named once per day in the "All day" row above the hours.
      assert.equal(await holiday.count(), 2);
      await diary.getByText("All day", { exact: true }).waitFor();
      assert.equal(await diary.getByRole("button", { name: "Schedule holiday", exact: true }).count(), 2);
    } else {
      assert.equal(await holiday.count(), 1);
      assert.match(await holiday.innerText(), /All day/);
      await view("Week").click();
      await until(async () => await holiday.count() === 2, "The phone week list names the holiday on both days");
      await assertFits(page);
      await view("Day").click();
      await until(async () => await holiday.count() === 1, "Back to one day");
    }
    await capture(page, output, `diary-time-off-${theme}-${width}.png`);
    await holiday.first().click();
    await details.getByText("Schedule holiday", { exact: true }).waitFor();
    await details.getByText(`${plain(16)} to ${plain(17)}`, { exact: true }).waitFor();
    await details.getByText("Removing it frees all 2 days.", { exact: false }).waitFor();
    await capture(page, output, `time-off-details-${theme}-${width}.png`);
    await closeDetails();
    await details.waitFor({ state: "hidden" });

    // Booking is only booking now: no "Time off" tab. It still knows the day is taken.
    await page.getByRole("button", { name: "Book", exact: true }).click();
    const booking = page.getByRole("dialog", { name: "New appointment", exact: true });
    // The form fills in once its details have loaded.
    await until(async () => await booking.getByRole("button", { name: "Book appointment", exact: true }).isEnabled(), "The booking form loads");
    assert.equal(await booking.getByLabel("Date", { exact: true }).inputValue(), iso(16));
    assert.equal(await booking.getByRole("tab").count(), 0);
    assert.equal(await booking.getByRole("button", { name: /time off/i }).count(), 0, "Time off is no longer part of the booking form");
    assert.equal(await page.getByRole("dialog").count(), 1);
    await booking.getByText("Nothing free on this day.", { exact: true }).waitFor();
    await booking.getByRole("button", { name: "Other time", exact: true }).click();
    await booking.getByLabel("Start", { exact: true }).fill("14:15");
    await booking.getByRole("status").filter({ hasText: "This overlaps your time off (Schedule holiday)." }).waitFor();
    await assertFits(page);
    await booking.getByRole("button", { name: "Close", exact: true }).click();
    await booking.waitFor({ state: "hidden" });
    assert.equal(appointmentWrites(), appointmentsBefore);

    // A few hours from the Diary, with no reason given: it is simply "Time off".
    await timeOffButton.click();
    await kind("A few hours").click();
    await dialog.getByLabel("Date", { exact: true }).fill(iso(18));
    await dialog.getByLabel("From", { exact: true }).fill("14:15");
    assert.equal(await dialog.getByLabel("To", { exact: true }).inputValue(), "15:15");
    await dialog.getByText("It shows in your diary as “Time off”.", { exact: false }).waitFor();
    await capture(page, output, `diary-few-hours-${theme}-${width}.png`);
    await add.click();
    await dialog.waitFor({ state: "hidden" });
    const afternoon = blockWrites("POST")[3].body;
    assert.deepEqual([afternoon.date, afternoon.start_time, afternoon.end_date, afternoon.end_time, afternoon.label], [iso(18), "14:15", iso(18), "15:15", "Time off"]);
    assert.equal(records.blocks.length, 4);
    if (!wide) {
      await page.getByRole("button", { name: show(18), exact: true }).click();
      assert.equal(await pressed(page.getByRole("button", { name: show(18), exact: true })), "true");
    }
    const afternoonBlock = diary.getByRole("button", { name: /Time off.*2\.15pm to 3\.15pm/ });
    await afternoonBlock.waitFor();
    assert.equal(await afternoonBlock.count(), 1);
    await afternoonBlock.click();
    await details.getByText(`${plain(18)}, 2.15pm to 3.15pm`, { exact: true }).waitFor();
    assert.equal(await details.getByText("Removing it frees all", { exact: false }).count(), 0);
    await closeDetails();
    await details.waitFor({ state: "hidden" });

    // It can be removed from the list inside the Diary's dialog, and the diary behind follows.
    await timeOffButton.click();
    await booked.getByRole("button", { name: "Remove Time off", exact: true }).click();
    await confirm.getByText(`${plain(18)}, 2.15pm to 3.15pm`, { exact: true }).waitFor();
    await assertFits(page);
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await booked.getByRole("button", { name: "Remove Time off", exact: true }).waitFor({ state: "hidden" });
    await booked.getByRole("button", { name: "Remove Schedule holiday", exact: true }).waitFor();
    assert.equal(blockWrites("DELETE").length, 2);
    const removedAfternoon = blockWrites("DELETE")[1].body;
    assert.equal(removedAfternoon.period_id, afternoon.id);
    assert.equal(removedAfternoon.blocks.length, 1);
    assert.equal(records.blocks.some(block => block.label === "Time off"), false);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await afternoonBlock.count(), 0);

    // An empty time in the diary still starts a booking for that day and time, never time off.
    await view("Day").click();
    await goTo.fill(iso(35));
    if (wide) await page.locator('[role="presentation"]').first().click({ position: { x: 30, y: 145 } });
    else await diary.getByRole("button", { name: /^Free 9am to 5pm/ }).click();
    await until(async () => await booking.getByRole("button", { name: "Book appointment", exact: true }).isEnabled(), "The booking form loads");
    assert.equal(await booking.getByLabel("Date", { exact: true }).inputValue(), iso(35));
    // 145px below 9am in a 64px hour is 11.15am, which is not a half-hour slot, so the time box shows it.
    if (wide) assert.equal(await booking.getByLabel("Start", { exact: true }).inputValue(), "11:15");
    else assert.equal(await pressed(booking.getByRole("button", { name: "9am", exact: true })), "true");
    assert.equal(await booking.getByRole("tab").count(), 0);
    await booking.getByRole("button", { name: "Close", exact: true }).click();
    await booking.waitFor({ state: "hidden" });

    // ---------- Every week: the days she never works ----------
    await goTo.fill(iso(18));
    const closed = wide ? diary.getByText("Closed", { exact: true }) : diary.getByText("You don't usually work Wednesdays. Nothing booked.", { exact: true });
    if (wide) { await view("Week").click(); await until(async () => await closed.count() === 1, "Only Sunday is closed to begin with"); }
    else assert.equal(await closed.count(), 0);
    const blockWritesBefore = fixture.mutations.filter(item => item.operation === "blocks").length;
    await timeOffButton.click();
    await kind("Every week").click();
    const daysOff = dialog.getByRole("group", { name: "Days you don't work", exact: true });
    const dayOff = name => daysOff.getByRole("button", { name: `${name} off`, exact: true });
    const offNow = async () => { const off = []; for (const name of [...LONG_DAYS.slice(1), LONG_DAYS[0]]) if (await pressed(dayOff(name)) === "true") off.push(name); return off; };
    const save = dialog.getByRole("button", { name: "Save working days", exact: true });
    await daysOff.waitFor();
    assert.equal(await daysOff.getByRole("button").count(), 7);
    assert.deepEqual(await offNow(), ["Sunday"]);
    await dialog.getByText("You work Monday, Tuesday, Wednesday, Thursday, Friday and Saturday. Off every Sunday.", { exact: true }).waitFor();
    assert.equal(await save.isDisabled(), true, "Nothing to save until a day changes");
    await dayOff("Wednesday").click();
    assert.deepEqual(await offNow(), ["Wednesday", "Sunday"]);
    await dialog.getByText("You work Monday, Tuesday, Thursday, Friday and Saturday. Off every Wednesday and Sunday.", { exact: true }).waitFor();
    assert.equal(await save.isEnabled(), true);
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await until(async () => (await offNow()).join() === "Sunday", "Reset puts the saved week back");
    assert.equal(await save.isDisabled(), true);
    // No working day at all: refused while the website takes bookings, allowed with a warning when it does not.
    for (const name of LONG_DAYS.slice(1)) await dayOff(name).click();
    await dialog.getByText("You'd have no working days at all.", { exact: true }).waitFor();
    if (bookingEnabled) {
      await dialog.getByRole("alert").filter({ hasText: "Keep at least one working day while the website is taking bookings." }).waitFor();
      assert.equal(await save.isDisabled(), true);
    } else {
      await dialog.getByRole("alert").filter({ hasText: "With no working days, the website can't offer any times." }).waitFor();
      assert.equal(await save.isEnabled(), true);
    }
    await assertFits(page);
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await until(async () => (await offNow()).join() === "Sunday", "Reset puts the saved week back");
    await dayOff("Wednesday").click();
    await dayOff("Saturday").click();
    await dialog.getByText("You work Monday, Tuesday, Thursday and Friday. Off every Wednesday, Saturday and Sunday.", { exact: true }).waitFor();
    await capture(page, output, `working-week-${theme}-${width}.png`);
    assert.equal(settingsWrites.length, 0);
    await save.click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Working days saved", { exact: true }).first().waitFor();
    assert.equal(settingsWrites.length, 1);
    const [{ method, body: savedWeek }] = settingsWrites;
    assert.equal(method, "PUT");
    assert.equal(savedWeek.booking_enabled, bookingEnabled, "Saving working days must leave website bookings as they were");
    assert.deepEqual(savedWeek.opening_hours, openingHours.filter(item => item.weekday !== 3 && item.weekday !== 6), "Only the chosen weekdays are dropped; the others keep their hours");
    assert.deepEqual([savedWeek.timezone, savedWeek.slot_minutes, savedWeek.horizon_days, savedWeek.revision], ["Europe/London", 30, 90, 1]);
    assert.deepEqual([savedWeek.admin_notifications_enabled, savedWeek.admin_notification_email], [false, ""], "Other settings travel with it unchanged");
    assert.equal(fixture.mutations.filter(item => item.operation === "blocks").length, blockWritesBefore, "A working week is not saved as time off");
    assert.deepEqual(records.blocks.map(block => block.label).sort(), ["Appointment", "Schedule holiday", "Schedule holiday"]);
    // The diary and the dialog both read the new week.
    if (wide) await until(async () => await closed.count() === 3, "Wednesday, Saturday and Sunday read as closed");
    else await closed.waitFor();
    await capture(page, output, `diary-working-week-${theme}-${width}.png`);
    await timeOffButton.click();
    await kind("Every week").click();
    await daysOff.waitFor();
    assert.deepEqual(await offNow(), ["Wednesday", "Saturday", "Sunday"]);
    assert.equal(await save.isDisabled(), true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(settingsWrites.length, 1);

    // ---------- Removing from a block's own details ----------
    // The whole holiday goes in one request, the details close, and the diary behind is usable again.
    if (!wide) await page.getByRole("button", { name: show(16), exact: true }).click();
    const holidayBlocks = records.blocks.filter(block => block.label === "Schedule holiday").map(block => block.id);
    assert.equal(holidayBlocks.length, 2);
    await holiday.first().click();
    await details.getByRole("button", { name: "Remove time off", exact: true }).click();
    await confirm.getByText("Schedule holiday", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 2, "The question sits on top of the details");
    await confirm.getByRole("button", { name: "Keep it", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    assert.equal(await details.isVisible(), true);
    assert.equal(blockWrites("DELETE").length, 2);
    await details.getByRole("button", { name: "Remove time off", exact: true }).click();
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await details.waitFor({ state: "hidden" });
    await until(async () => await holiday.count() === 0, "The removed holiday leaves the diary");
    assert.equal(blockWrites("DELETE").length, 3);
    const removedHoliday = blockWrites("DELETE")[2].body;
    assert.equal(removedHoliday.period_id, holidayWrite.id);
    assert.deepEqual(removedHoliday.blocks.map(block => block.id).sort(), holidayBlocks.sort());
    assert.deepEqual(records.blocks.map(block => block.label), ["Appointment"]);
    // Both dialogs close together here. Whatever they made inert while open has to be handed back.
    assert.equal(await page.getByRole("dialog").count(), 0);
    const stillInert = await page.evaluate(() => [...document.querySelectorAll("[inert]")].map(element => `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`));
    assert.deepEqual(stillInert, [], "After removing time off from its details the app behind must be usable again, not left inert");
    await page.getByRole("button", { name: "Book", exact: true }).click({ timeout: 5000 });
    await until(async () => await booking.getByRole("button", { name: "Book appointment", exact: true }).isEnabled(), "The booking form loads");
    await booking.getByRole("button", { name: "Close", exact: true }).click();
    await booking.waitFor({ state: "hidden" });

    assert.deepEqual(errors, []);
    return { theme, width, diary: wide ? "week grid" : "agenda", weekAcrossClockChange: true, onePeriodShown: true, invalidEndRejected: true, wholePeriodRemovedAfterConfirmation: true, keepItRemovesNothing: true, fewHoursAndWholeDaysSendBlocks: true, settingsTimeOffShownInDiary: true, diaryTimeOffStartsOnSelectedDate: true, kindDraftsPreserved: true, keyboardKindChoice: true, diaryRefreshesWithoutAppointmentOrClient: true, blockOpensDetails: true, removedFromDialogListAndFromDetails: true, bookingHasNoTimeOffTabAndWarnsOfClash: true, emptySlotBooksSelectedDateAndTime: true, everyWeekKeepsBookingEnabled: bookingEnabled, everyWeekDropsOnlyChosenWeekdays: true, pageErrors: errors };
  } catch (error) { await page.screenshot({ path: resolve(output, `failure-${theme}-${width}.png`), fullPage: true }).catch(() => {}); throw error; }
  finally { fixture.close(); await page.close(); }
}

if (url) await run();
