import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockAddress, setupExternalIps } from "./helpers/external-ip";

/**
 * Workflow coverage for the flat External IP address register.
 *
 * The rework's core promise is that an address can be entered on its own —
 * no provider, no account, no location, no pool. Everything here drives the
 * real page through the real modal rather than asserting on markup shape.
 */

const SYDNEY = { id: 1, account_id: null, name: "Sydney", region: "ap-southeast-2" };
const DUBLIN = { id: 2, account_id: null, name: "Dublin", region: "eu-west-1" };
const FRANKFURT = { id: 3, account_id: null, name: "Frankfurt", region: "eu-central-1" };
// A register with enough locations that the picker list reaches its scroll cap.
const MANY_LOCATIONS = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1, account_id: null, name: `Region ${index + 1}`, region: `zone-${index + 1}`,
}));

function addModal(page: Page) {
  return page.getByRole("dialog", { name: "Add external IP" });
}

function locationTrigger(scope: Locator) {
  return scope.getByRole("button", { name: "Location", exact: true });
}

// ── The core promise ─────────────────────────────────────────────────────────

test("a single external IP can be added with only the address filled", async ({ page }) => {
  const state = await setupExternalIps(page);

  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await expect(dialog).toBeVisible();

  const address = dialog.getByLabel("Address or range");
  await address.fill("203.0.113.7");
  // The live count is the user's confirmation that this is one row, not a block.
  await expect(dialog.getByText("1 address", { exact: true })).toBeVisible();

  // Nothing else is required: Location is still Unassigned and Purpose is empty.
  await expect(locationTrigger(dialog)).toHaveText("Unassigned");
  await expect(dialog.getByLabel("Purpose")).toHaveValue("");

  await dialog.getByRole("button", { name: "Add address" }).click();
  await expect(dialog).toBeHidden();

  expect(state.addressPosts).toHaveLength(1);
  expect(state.addressPosts[0].ip_address).toBe("203.0.113.7");
  expect(state.addressPosts[0].location_id).toBeNull();
  expect(state.addressPosts[0].label).toBeNull();

  const row = page.locator(".external-ip-address-row", { hasText: "203.0.113.7" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".nm-status")).toHaveText("In use");
});

test("a /29 becomes six available rows and hides the per-address fields", async ({ page }) => {
  const state = await setupExternalIps(page);

  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await dialog.getByLabel("Address or range").fill("203.0.113.0/29");

  // Purpose, Device, URL and Owner are meaningless spread across a block, so they go.
  await expect(dialog.getByText("6 addresses", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Purpose")).toHaveCount(0);
  await expect(dialog.getByLabel("Device")).toHaveCount(0);
  await dialog.getByRole("button", { name: /^More details/ }).click();
  await expect(dialog.getByLabel("Owner")).toHaveCount(0);
  await expect(dialog.getByLabel("URL")).toHaveCount(0);
  await expect(dialog.getByLabel("Tags")).toBeVisible();

  // A block you have just claimed is free until you say otherwise.
  await expect(dialog.getByLabel("Status")).toHaveValue("available");

  await dialog.getByRole("button", { name: "Add 6 addresses" }).click();
  await expect(dialog).toBeHidden();

  expect(state.addressPosts).toHaveLength(1);
  expect(state.addressPosts[0].status).toBe("available");
  await expect(page.locator("tr.external-ip-address-row--available")).toHaveCount(6);
  await expect(page.locator(".external-ip-address-row")).toHaveCount(6);
  await expect(page.locator(".external-ip-address-row").first()).toContainText("203.0.113.1");
  await expect(page.locator(".external-ip-address-row").last()).toContainText("203.0.113.6");
});

test("an over-cap range is refused before it can create anything", async ({ page }) => {
  const state = await setupExternalIps(page, { addresses: [mockAddress({ id: 1, ip_address: "203.0.113.10" })] });

  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await dialog.getByLabel("Address or range").fill("203.0.112.0/23");

  // The cap is stated in the hint, in the same place the count normally appears.
  const hint = dialog.locator(".external-ip-count-hint");
  await expect(hint).toHaveText("too large — 510 addresses, limit is 256");
  await expect(hint).toHaveClass(/external-ip-count-hint--over/);

  // ...and the primary action is genuinely unavailable, not merely discouraged.
  const primary = dialog.getByRole("button", { name: "Add address" });
  await expect(primary).toBeDisabled();
  await primary.click({ force: true }).catch(() => undefined);
  await page.keyboard.press("Enter");

  expect(state.addressPosts).toHaveLength(0);
  await expect(page.locator(".external-ip-address-row")).toHaveCount(1);
});

// ── Locations ────────────────────────────────────────────────────────────────

test("a location can be created inline without leaving the address modal", async ({ page }) => {
  const state = await setupExternalIps(page);

  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await dialog.getByLabel("Address or range").fill("198.51.100.5");

  await locationTrigger(dialog).click();
  await dialog.getByRole("button", { name: "Create location…" }).click();

  // The create block is inline — the address modal is still the only dialog on screen.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const inline = dialog.locator(".external-ip-inline-create");
  await expect(inline).toBeVisible();
  await inline.getByLabel("Name").fill("Sydney");
  await inline.getByLabel("Region").fill("ap-southeast-2");
  await inline.getByRole("button", { name: "Create location" }).click();

  await expect(inline).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(state.locationPosts).toHaveLength(1);
  expect(state.locationPosts[0].name).toBe("Sydney");

  // ...and the new location is the one now selected.
  await expect(locationTrigger(dialog)).toHaveText("Sydney · ap-southeast-2");
  await dialog.getByRole("button", { name: "Add address" }).click();
  await expect(dialog).toBeHidden();
  expect(state.addressPosts[0].location_id).toBe(state.locations[0].id);
});

test("addresses with no location live under Unassigned, which sinks below real places", async ({ page }) => {
  await setupExternalIps(page, {
    locations: [SYDNEY],
    addresses: [
      mockAddress({ id: 1, ip_address: "203.0.113.10", location_id: null }),
      mockAddress({ id: 2, ip_address: "203.0.113.11", location_id: 1 }),
    ],
  });

  const groups = page.locator(".external-ip-group-row");
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator(".external-ip-group-name")).toHaveText("Sydney");
  await expect(groups.last().locator(".external-ip-group-name")).toHaveText("Unassigned");

  // The address with no location is the one inside Unassigned, and only it.
  const rows = page.locator("tbody tr");
  const order = await rows.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const unassignedIndex = order.findIndex((text) => text.includes("Unassigned"));
  expect(order[unassignedIndex + 1]).toContain("203.0.113.10");
  await expect(groups.last()).toContainText("1 address");
});

// ── The #42 regression ───────────────────────────────────────────────────────

test("a decommissioned address can be released while Purpose is empty", async ({ page }) => {
  // Reported bug: Purpose was mandatory in the shipped form, so an address whose
  // purpose had been cleared could not be saved — which is exactly the moment a
  // user is trying to free it. Mark available must work from an empty Purpose.
  const state = await setupExternalIps(page, {
    addresses: [mockAddress({ id: 42, ip_address: "203.0.113.42", status: "in_use", label: null, device_id: null })],
  });

  await page.locator(".external-ip-address-row").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit 203.0.113.42" });
  await expect(dialog.getByLabel("Purpose")).toHaveValue("");
  await expect(dialog.getByLabel("Purpose")).not.toHaveAttribute("required", "");

  await dialog.getByRole("button", { name: "Mark available" }).click();
  await expect(dialog).toBeHidden();

  expect(state.addressPatches).toHaveLength(1);
  const [id, patch] = state.addressPatches[0];
  expect(id).toBe(42);
  expect(patch).toEqual({ status: "available", device_id: null, label: null });
  await expect(page.locator("tr.external-ip-address-row--available")).toHaveCount(1);
  await expect(page.locator(".external-ip-address-row .nm-status")).toHaveText("Available");
});

// ── The Group-by lens ────────────────────────────────────────────────────────

test("Group by switches the lens through all four modes", async ({ page }) => {
  await setupExternalIps(page, {
    accounts: [{ id: 1, provider_id: 1, name: "Production" }],
    locations: [{ ...SYDNEY, account_id: 1 }],
    addresses: [
      mockAddress({ id: 1, ip_address: "203.0.113.10", location_id: 1, status: "in_use" }),
      mockAddress({ id: 2, ip_address: "203.0.113.11", location_id: null, status: "available" }),
    ],
  });

  const groupBy = page.getByLabel("Group by");
  const groupNames = page.locator(".external-ip-group-name");

  await expect(groupBy).toHaveValue("location");
  await expect(groupNames).toHaveText(["Sydney", "Unassigned"]);

  await groupBy.selectOption("provider");
  await expect(groupNames).toHaveText(["AWS", "Unassigned"]);

  await groupBy.selectOption("status");
  await expect(groupNames).toHaveText(["Available", "In use"]);

  await groupBy.selectOption("none");
  await expect(page.locator(".external-ip-group-row")).toHaveCount(0);
  await expect(page.locator(".external-ip-address-row")).toHaveCount(2);

  await groupBy.selectOption("location");
  await expect(groupNames).toHaveText(["Sydney", "Unassigned"]);
});

test("the lenses that do not group by location show it as a column instead", async ({ page }) => {
  // Location is the only grouping key that is not also a column, so under Status,
  // Provider and None the rows carried no location at all — the operator could see
  // an address and not where it lives.
  await setupExternalIps(page, {
    accounts: [{ id: 1, provider_id: 1, name: "Production" }],
    locations: [{ ...SYDNEY, account_id: 1 }],
    addresses: [
      mockAddress({ id: 1, ip_address: "203.0.113.10", location_id: 1, status: "in_use" }),
      mockAddress({ id: 2, ip_address: "203.0.113.11", location_id: null, status: "available" }),
    ],
  });

  const groupBy = page.getByLabel("Group by");
  const headers = page.locator(".external-ip-table thead th");
  const locationCell = (ip: string) =>
    page.locator(".external-ip-address-row", { hasText: ip }).locator("td").nth(1);

  // Grouped by location the header carries it, so a column would say it twice.
  await expect(headers).toHaveText(["Address", "Purpose", "Device", "Status", "Owner", "Tags", "Actions"]);

  for (const lens of ["status", "provider", "none"] as const) {
    await groupBy.selectOption(lens);
    await expect(headers).toHaveText(["Address", "Location", "Purpose", "Device", "Status", "Owner", "Tags", "Actions"]);
    // Region included, matching how the Location picker names the same place.
    await expect(locationCell("203.0.113.10")).toHaveText("Sydney · ap-southeast-2");
    await expect(locationCell("203.0.113.11")).toHaveText("Unassigned");
  }

  await groupBy.selectOption("location");
  await expect(headers).toHaveText(["Address", "Purpose", "Device", "Status", "Owner", "Tags", "Actions"]);
});

test("the inline location form only offers Provider where it can be saved", async ({ page }) => {
  // Provider is stored on the *account* row. The draft offered it beside Account,
  // so choosing one against "No account" looked like it applied to the location and
  // was then dropped on save: the POST carried account_id: null and nothing else.
  const state = await setupExternalIps(page, {
    accounts: [{ id: 7, provider_id: 2, name: "Production" }],
    locations: [SYDNEY],
  });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await locationTrigger(dialog).click();
  await dialog.getByRole("button", { name: "Create location…" }).click();

  const draft = dialog.locator(".external-ip-inline-create");
  // By role, not by label text: these selects wrap their own options, so a
  // `<label>`'s text content is "Account" followed by every option in it.
  const account = draft.getByRole("combobox", { name: /^Account/ });
  const provider = draft.getByRole("combobox", { name: /^Provider/ });

  // No account is being created, so there is nowhere to put a provider.
  await expect(account).toHaveValue("");
  await expect(provider).toHaveCount(0);

  // An existing account already has one; it is not the draft's to change.
  await account.selectOption("7");
  await expect(provider).toHaveCount(0);
  // Existing accounts stay listed whatever provider they belong to — the select
  // used to filter them by the draft's own provider, hiding all of them at first.
  await expect(account.locator("option")).toHaveText(["No account", "Azure / Production", "New account…"]);

  // Creating one: now the provider has a row to live on.
  await account.selectOption("new");
  await expect(provider).toBeVisible();
  await provider.selectOption("1");
  await draft.getByRole("textbox", { name: /Account name/ }).fill("Sandbox");
  await draft.getByRole("textbox", { name: /^Name/ }).fill("Perth DC");
  await draft.getByRole("button", { name: "Create location" }).click();

  await expect(locationTrigger(dialog)).toHaveText("Perth DC");
  expect(state.accountPosts).toEqual([{ provider_id: 1, name: "Sandbox" }]);
  expect(state.locationPosts).toHaveLength(1);
  expect(state.locationPosts[0].account_id).toBe(state.accounts.at(-1)!.id);
});

// ── The migration notice ─────────────────────────────────────────────────────

test("the migration notice renders for declined blocks and dismisses for good", async ({ page }) => {
  const state = await setupExternalIps(page, {
    addresses: [mockAddress({ id: 1 })],
    migration: { migrated: 12, declined: [{ cidr: "198.51.100.0/22", location: "Sydney", kept: 4 }] },
  });

  const notice = page.locator(".external-ip-migration-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("198.51.100.0/22 at Sydney");
  await expect(notice).toContainText("4 tracked addresses kept");

  await notice.getByRole("button", { name: "Dismiss migration notice" }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => state.migrationDismissed).toBe(true);
});

test("no migration notice renders when the backend reports nothing", async ({ page }) => {
  await setupExternalIps(page, { addresses: [mockAddress({ id: 1 })], migration: null });
  await expect(page.locator(".external-ip-migration-notice")).toHaveCount(0);
});

// ── PickOrCreate, driven for real ────────────────────────────────────────────
//
// Until now every claim about this component's keyboard and screen-reader
// behaviour came from reading the source. These drive it in a browser.

test("PickOrCreate opens, filters, and pins Unassigned first and Create last", async ({ page }) => {
  await setupExternalIps(page, { locations: [SYDNEY, DUBLIN, FRANKFURT] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  const trigger = locationTrigger(dialog);

  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const listbox = dialog.getByRole("listbox", { name: "Location" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveText([
    "Unassigned", "Dublin · eu-west-1", "Frankfurt · eu-central-1", "Sydney · ap-southeast-2",
  ]);

  // The create action is the last row and deliberately outside the listbox, so the
  // listbox's children are only option rows.
  const create = dialog.getByRole("button", { name: "Create location…" });
  await expect(create).toBeVisible();
  await expect(listbox.getByRole("button")).toHaveCount(0);

  // Opening focuses the filter, and filtering narrows to matching labels only.
  const filter = dialog.getByLabel("Filter Location");
  await expect(filter).toBeFocused();
  await filter.fill("du");
  await expect(listbox.getByRole("option")).toHaveText(["Unassigned", "Dublin · eu-west-1"]);
  await filter.fill("zzz");
  await expect(listbox.getByRole("option")).toHaveText(["Unassigned"]);
  await expect(dialog.getByText("No matches")).toBeVisible();
  await expect(create).toBeVisible();
});

test("PickOrCreate moves the highlight with Up/Down and commits with Enter", async ({ page }) => {
  await setupExternalIps(page, { locations: [SYDNEY, DUBLIN, FRANKFURT] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await locationTrigger(dialog).click();

  const filter = dialog.getByLabel("Filter Location");
  const highlighted = dialog.locator(".nm-pick-row--hl");
  const activeDescendant = () => filter.evaluate((node) => {
    const id = node.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.textContent ?? null : null;
  });

  // Nothing selected yet, so the pinned empty row is where the highlight starts.
  await expect(highlighted).toHaveText("Unassigned");
  expect(await activeDescendant()).toBe("Unassigned");

  await filter.press("ArrowDown");
  await expect(highlighted).toHaveText("Dublin · eu-west-1");
  expect(await activeDescendant()).toBe("Dublin · eu-west-1");

  await filter.press("ArrowDown");
  await expect(highlighted).toHaveText("Frankfurt · eu-central-1");

  await filter.press("ArrowUp");
  await expect(highlighted).toHaveText("Dublin · eu-west-1");

  // Enter commits the highlighted row and closes the menu.
  await filter.press("Enter");
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(locationTrigger(dialog)).toHaveText("Dublin · eu-west-1");
  await expect(locationTrigger(dialog)).toHaveAttribute("aria-expanded", "false");

  // Reopening starts the highlight on the selected row rather than back at the top.
  await locationTrigger(dialog).click();
  await expect(dialog.locator(".nm-pick-row--hl")).toHaveText("Dublin · eu-west-1");
  await expect(dialog.locator(".nm-pick-row--selected")).toHaveText("Dublin · eu-west-1");
});

test("PickOrCreate reaches the create action by keyboard and moves real focus onto it", async ({ page }) => {
  await setupExternalIps(page, { locations: [SYDNEY] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  const trigger = locationTrigger(dialog);

  // The trigger itself opens on ArrowDown, without a mouse.
  await trigger.focus();
  await trigger.press("ArrowDown");
  const filter = dialog.getByLabel("Filter Location");
  await expect(filter).toBeFocused();

  const create = dialog.getByRole("button", { name: "Create location…" });
  await filter.press("ArrowDown"); // Sydney
  await filter.press("ArrowDown"); // create
  await expect(create).toBeFocused();
  await expect(create).toHaveClass(/nm-pick-row--hl/);

  // The create action is not a listbox child, so it must not be announced through
  // aria-activedescendant — real focus is what carries it.
  expect(await filter.getAttribute("aria-activedescendant")).toBeNull();

  // Back up: focus returns to the filter and aria-activedescendant is re-established.
  await create.press("ArrowUp");
  await expect(filter).toBeFocused();
  await expect(dialog.locator(".nm-pick-row--hl")).toHaveText("Sydney · ap-southeast-2");

  // Down again and Enter opens the inline create block.
  await filter.press("ArrowDown");
  await create.press("Enter");
  await expect(dialog.locator(".external-ip-inline-create")).toBeVisible();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
});

test("PickOrCreate closes its menu on Escape and leaves the modal open", async ({ page }) => {
  await setupExternalIps(page, { locations: [SYDNEY] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);

  const trigger = locationTrigger(dialog);
  await trigger.click();
  // Pre-condition: the menu really opened, so a setup regression cannot be
  // mistaken for the behaviour under test.
  await expect(dialog.getByRole("listbox")).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  await dialog.getByLabel("Filter Location").press("Escape");

  // The menu closes, the trigger reports itself collapsed, and — the assertion
  // that catches the real bug — the dialog behind it survives.
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
});

test("Escape in the Location menu does not also close the address modal", async ({ page }) => {
  // Regression guard. `onNavKeyDown` used to call preventDefault() on Escape but
  // never stopPropagation(), and `Modal` listens for Escape on `window`, so one
  // Escape closed the menu AND threw away the half-typed address behind it.
  await setupExternalIps(page, { locations: [SYDNEY] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  const address = dialog.getByLabel("Address or range");
  await address.fill("203.0.113.7");
  await locationTrigger(dialog).click();
  await expect(dialog.getByRole("listbox")).toBeVisible();

  await dialog.getByLabel("Filter Location").press("Escape");

  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // The in-progress form is intact, not just the dialog frame.
  await expect(address).toHaveValue("203.0.113.7");
});

test("the Location filter row is not torn apart by the modal's form styling", async ({ page }) => {
  // Regression guard. The menu is rendered inside `.modal-form`, so
  // `.modal .modal-form label` (a 6px grid) and the 40px
  // `.modal .modal-form input` min-height both applied to the menu's own filter
  // row: it became a two-row grid holding a 40px input in a 28px box, and the
  // input spilled down over the first option.
  await setupExternalIps(page, { locations: [SYDNEY, DUBLIN] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await locationTrigger(dialog).click();

  const row = dialog.locator(".nm-pick-filter");
  const input = dialog.getByLabel("Filter Location");
  const rowBox = (await row.boundingBox())!;
  const inputBox = (await input.boundingBox())!;

  // The input sits within its row rather than overflowing it.
  expect(inputBox.height).toBeLessThanOrEqual(rowBox.height);

  // And the first option begins below the filter row, not underneath it.
  const optionBox = (await dialog.getByRole("option").first().boundingBox())!;
  expect(optionBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height);
});

test("the Location menu is not clipped by the modal's scroll box", async ({ page }) => {
  // Regression guard. `.modal` is `max-height: calc(100vh - 40px); overflow:
  // auto`, so an absolutely positioned menu is clipped by the dialog's scroll
  // box: on a short viewport the create row landed below the fold entirely and
  // nothing was painted at its coordinates. The menu is positioned `fixed` from
  // the trigger rect, whose containing block is the viewport, so it escapes.
  // Playwright's own actionability checks scroll the dialog and would hide this,
  // so the assertion hit-tests the painted pixel directly.
  await page.setViewportSize({ width: 1280, height: 420 });
  // Enough locations to fill the list to its 240px cap, so the menu is taller
  // than the room the dialog leaves below the trigger.
  await setupExternalIps(page, { locations: MANY_LOCATIONS });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  await locationTrigger(dialog).click();

  const painted = await page.evaluate(() => {
    const create = document.querySelector(".nm-pick-row--create") as HTMLElement;
    const box = create.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { inViewport: box.bottom <= window.innerHeight, hit: !!hit && create.contains(hit) };
  });
  expect(painted).toEqual({ inViewport: true, hit: true });

  // Reachable, not merely painted.
  await dialog.getByRole("button", { name: "Create location…" }).click();
  await expect(dialog.getByText("New location", { exact: true })).toBeVisible();
});

test("the Location menu stays anchored to its trigger when the modal scrolls", async ({ page }) => {
  // A `fixed` menu is positioned in viewport coordinates, so it detaches from
  // the trigger unless every scroll that moves the trigger repositions it —
  // including scrolls inside the dialog, which never reach a window-bound
  // bubble-phase listener.
  // Short enough that the dialog genuinely overflows and scrolls.
  await page.setViewportSize({ width: 1280, height: 420 });
  await setupExternalIps(page, { locations: MANY_LOCATIONS });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);
  const trigger = locationTrigger(dialog);
  await trigger.click();

  const gapBefore = (await dialog.locator(".nm-pick-menu").boundingBox())!.y
    - ((await trigger.boundingBox())!.y + (await trigger.boundingBox())!.height);

  await page.locator(".modal").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(async () => {
    const menu = (await dialog.locator(".nm-pick-menu").boundingBox())!;
    const rect = (await trigger.boundingBox())!;
    return Math.round(menu.y - (rect.y + rect.height));
  }).toBe(Math.round(gapBefore));
});

test("clicking outside the Location menu closes it", async ({ page }) => {
  // Regression guard, same origin. `PickOrCreate` dismisses on a document-level
  // mousedown, but `Modal` puts `onMouseDown={(e) => e.stopPropagation()}` on the
  // dialog box, so a bubble-phase document listener never ran. The listener is
  // registered in the capture phase, which runs before the modal can stop it.
  await setupExternalIps(page, { locations: [SYDNEY] });
  await page.getByRole("button", { name: "Add external IP" }).first().click();
  const dialog = addModal(page);

  await locationTrigger(dialog).click();
  await expect(dialog.getByRole("listbox")).toBeVisible();
  await dialog.getByLabel("Address or range").click();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
});
