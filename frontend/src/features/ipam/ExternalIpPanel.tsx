import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Globe2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  api,
  type CloudProviderOption,
  type Device,
  type DevicePayload,
  type ExternalIpAddress,
  type ExternalIpAddressPayload,
  type ExternalLocation,
  type ExternalProviderAccount,
} from "../../api/client";
import { DashStat } from "../../components/DashStat";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { PickOrCreate, type PickOrCreateOption } from "../../components/PickOrCreate";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useApiQuery } from "../../hooks/useApiQuery";
import { DeviceForm } from "../devices/DeviceForm";
import { createDeviceWithReservationConfirmation } from "../devices/createDevice";

/** Hierarchy is a lens on the register, never a prerequisite for entering an address. */
type GroupBy = "location" | "provider" | "status" | "none";
type StatusFilter = "all" | ExternalIpAddress["status"];

/** Only existing `nm-status--*` variants — an invented name renders an unstyled pill in silence. */
const STATUS_PILL: Record<ExternalIpAddress["status"], string> = {
  in_use: "online",
  reserved: "paused",
  available: "unknown",
};

const STATUS_LABEL: Record<ExternalIpAddress["status"], string> = {
  in_use: "In use",
  reserved: "Reserved",
  available: "Available",
};

const UNASSIGNED = "Unassigned";
const NO_ACCOUNT = "No account";

/** Mirrors `EXTERNAL_MAX_ADDRESSES_PER_ADD` in `services/external_addresses.py`. */
const MAX_ADDRESSES_PER_ADD = 256;

const EMPTY_FORM: ExternalIpAddressPayload = {
  ip_address: "",
  location_id: null,
  device_id: null,
  status: "in_use",
  label: null,
  url: null,
  owner: null,
  tags: null,
  notes: null,
};

type LocationDraft = {
  provider_id: number | null;
  /** `"new"` means "create an account from `account_name`" — a fresh install has none. */
  account_id: number | "new" | null;
  account_name: string;
  name: string;
  region: string;
};

const EMPTY_LOCATION_DRAFT: LocationDraft = {
  provider_id: null, account_id: null, account_name: "", name: "", region: "",
};

function nullable(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

// ── Client-side address counting ──────────────────────────────────────────────
// A deliberate mirror of `count_address_input` in
// `backend/app/services/external_addresses.py`: same three input shapes, same
// usable-address rule (IPv4 /30 and shorter drop network + broadcast, IPv6
// /126 and shorter drop the subnet-router anycast), same cap. It exists only to
// drive the live hint and the disabled state — the server stays the authority,
// so anything this cannot confidently parse reports `unknown` and lets the
// request through rather than blocking a half-typed address.

export type AddressInputCount =
  | { kind: "ok"; count: number }
  | { kind: "error"; message: string }
  | { kind: "unknown" };

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** Expands `::` compression and a trailing dotted-quad into exactly eight groups. */
function ipv6Groups(text: string): string[] | null {
  if (text.includes("%")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const flatten = (chunk: string): string[] | null => {
    if (chunk === "") return [];
    const pieces = chunk.split(":");
    const out: string[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const embedded = parseIpv4(piece);
        if (embedded === null) return null;
        out.push(((embedded >> 16n) & 0xffffn).toString(16), (embedded & 0xffffn).toString(16));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        out.push(piece);
      }
    }
    return out;
  };
  const head = flatten(halves[0]);
  const tail = halves.length === 2 ? flatten(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    return [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  return head.length === 8 ? head : null;
}

function parseIp(text: string): { value: bigint; version: 4 | 6 } | null {
  if (text.includes(":")) {
    const groups = ipv6Groups(text);
    if (groups === null) return null;
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16));
    return { value, version: 6 };
  }
  const value = parseIpv4(text);
  return value === null ? null : { value, version: 4 };
}

function capped(count: bigint): AddressInputCount {
  if (count > BigInt(MAX_ADDRESSES_PER_ADD)) {
    return {
      kind: "error",
      message: `too large — ${count.toLocaleString("en-US")} addresses, limit is ${MAX_ADDRESSES_PER_ADD}`,
    };
  }
  return { kind: "ok", count: Number(count) };
}

/** Counts a bare address, a CIDR, or a `start-end` range without materialising them. */
export function countAddressInput(raw: string): AddressInputCount {
  const text = raw.trim();
  if (!text) return { kind: "unknown" };

  const dash = text.indexOf("-");
  if (dash !== -1) {
    const start = parseIp(text.slice(0, dash).trim());
    const end = parseIp(text.slice(dash + 1).trim());
    if (!start || !end) return { kind: "unknown" };
    if (start.version !== end.version) return { kind: "error", message: "Start and end must be the same IP version" };
    if (end.value < start.value) return { kind: "error", message: "End address must not be before the start address" };
    return capped(end.value - start.value + 1n);
  }

  const slash = text.indexOf("/");
  const parsed = parseIp((slash === -1 ? text : text.slice(0, slash)).trim());
  if (!parsed) return { kind: "unknown" };
  const bits = parsed.version === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const suffix = text.slice(slash + 1).trim();
    if (!/^\d{1,3}$/.test(suffix)) return { kind: "unknown" };
    prefix = Number(suffix);
    if (prefix > bits) return { kind: "unknown" };
  }
  const total = 1n << BigInt(bits - prefix);
  if (parsed.version === 4 && prefix <= 30) return capped(total - 2n);
  if (parsed.version === 6 && prefix < 127) return capped(total - 1n);
  return capped(total);
}

/** Sorts 1.2.3.4 before 1.2.3.40 and keeps IPv6 stable-but-lexical. */
function addressSortKey(ip: string) {
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    return parts.map((part) => part.padStart(3, "0")).join(".");
  }
  return ip;
}

function deviceLabel(address: ExternalIpAddress) {
  const device = address.device;
  if (!device) return null;
  return device.display_name || device.hostname || device.ip_address;
}

function splitTags(tags: string | null) {
  return (tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

/** One flat, scannable register of public addresses with a Group-by lens over it. */
export function ExternalIpPanel({
  accessToken,
  canWrite,
  canManageProviders: _canManageProviders = false,
  canCreateDevice = false,
  onDeviceChange,
}: {
  accessToken: string;
  canWrite: boolean;
  canManageProviders?: boolean;
  canCreateDevice?: boolean;
  onDeviceChange?: (device: Device) => void;
}) {
  const toast = useToast();
  const confirmAction = useConfirm();

  const query = useApiQuery(async () => {
    const [addresses, locations, accounts, cloudProviders, graph, migration] = await Promise.all([
      api.listExternalAddresses(accessToken),
      api.listExternalLocations(accessToken),
      api.listExternalAccounts(accessToken),
      api.listCloudProviders(accessToken),
      api.topologyGraph(accessToken).catch(() => ({ devices: [], relationships: [] })),
      api.getExternalMigrationReport(accessToken).catch(() => null),
    ]);
    return { addresses, locations, accounts, cloudProviders, devices: graph.devices, migration };
  }, [accessToken]);

  const addresses = useMemo(() => query.data?.addresses ?? [], [query.data]);
  const locations = useMemo<ExternalLocation[]>(() => query.data?.locations ?? [], [query.data]);
  const accounts = useMemo<ExternalProviderAccount[]>(() => query.data?.accounts ?? [], [query.data]);
  const cloudProviders = useMemo<CloudProviderOption[]>(() => query.data?.cloudProviders ?? [], [query.data]);
  const inventoryDevices = useMemo(() => query.data?.devices ?? [], [query.data]);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("location");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [migrationDismissed, setMigrationDismissed] = useState(false);

  // Address modal. Its busy/error state is its own: the inline location block and
  // the standalone location editor each carry theirs, so no two surfaces can
  // disable or blame one another.
  const [editing, setEditing] = useState<ExternalIpAddress | "new" | null>(null);
  const [form, setForm] = useState<ExternalIpAddressPayload>(EMPTY_FORM);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [statusTouched, setStatusTouched] = useState(false);
  const [addToInventory, setAddToInventory] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  // Inline "+ Create location…" block, rendered inside the address modal.
  const [locationDraftOpen, setLocationDraftOpen] = useState(false);
  const [locationDraft, setLocationDraft] = useState<LocationDraft>(EMPTY_LOCATION_DRAFT);
  const [locationDraftBusy, setLocationDraftBusy] = useState(false);
  const [locationDraftError, setLocationDraftError] = useState<string | null>(null);

  // Standalone editor for an existing location, reached from a group header.
  const [locationEditor, setLocationEditor] = useState<ExternalLocation | null>(null);
  const [locationEditorForm, setLocationEditorForm] = useState<Omit<ExternalLocation, "id">>({ account_id: null, name: "", region: "" });
  const [locationEditorBusy, setLocationEditorBusy] = useState(false);
  const [locationEditorError, setLocationEditorError] = useState<string | null>(null);

  // "Also add to Inventory and Monitoring" hands the saved address to the normal
  // device form, then links the device back onto the address.
  const [deviceSeed, setDeviceSeed] = useState<Partial<Device> | null>(null);
  const [seededAddressId, setSeededAddressId] = useState<number | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const deviceMetadataQuery = useApiQuery(
    deviceSeed === null ? null : async () => {
      const [groups, sites, snmpProfiles, deviceTypes] = await Promise.all([
        api.topologyGroups(accessToken).catch(() => []),
        api.sites(accessToken).catch(() => []),
        api.listSnmpProfiles(accessToken).catch(() => []),
        api.listDeviceTypes(accessToken).catch(() => []),
      ]);
      return { groups, sites, snmpProfiles, deviceTypes };
    },
    [accessToken, deviceSeed !== null],
  );

  const locationById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const providerById = useMemo(() => new Map(cloudProviders.map((provider) => [provider.id, provider])), [cloudProviders]);

  const providerNameFor = (locationId: number | null) => {
    if (locationId === null) return UNASSIGNED;
    const accountId = locationById.get(locationId)?.account_id ?? null;
    const account = accountId === null ? null : accountById.get(accountId);
    if (!account) return UNASSIGNED;
    const provider = account.provider_id === null ? null : providerById.get(account.provider_id);
    return provider?.name ?? UNASSIGNED;
  };

  const accountLabel = (account: ExternalProviderAccount) => {
    const provider = account.provider_id === null ? null : providerById.get(account.provider_id);
    const providerName = provider?.name ?? "No provider";
    return account.name ? `${providerName} / ${account.name}` : providerName;
  };

  /** Locations are grouped under their provider/account in the picker. */
  const locationOptions = useMemo<PickOrCreateOption[]>(() => {
    const groupFor = (location: ExternalLocation) => {
      const account = location.account_id === null ? null : accountById.get(location.account_id);
      return account ? accountLabel(account) : NO_ACCOUNT;
    };
    return locations
      .map((location) => ({ location, group: groupFor(location) }))
      // `PickOrCreate` clusters by group in first-appearance order, so the input
      // order decides the rendered group order — sort here or the menu comes out
      // in whatever order the API happened to return. Ungrouped sinks last.
      .sort((a, b) => {
        if (a.group !== b.group) {
          if (a.group === NO_ACCOUNT) return 1;
          if (b.group === NO_ACCOUNT) return -1;
          return a.group.localeCompare(b.group);
        }
        return a.location.name.localeCompare(b.location.name);
      })
      .map(({ location, group }) => ({
        id: location.id,
        label: location.region ? `${location.name} · ${location.region}` : location.name,
        group,
      }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations, accountById, providerById]);

  /**
   * Every account, labelled with its provider. The draft's Provider select does
   * not filter this list: provider is a property of an *account*, so a provider
   * chosen here can only be honoured while an account is being created. Filtering
   * by it instead made the select look like it also applied to the location, and
   * a provider picked against "No account" was then silently dropped.
   */
  /**
   * "Name · region", the same shape the Location picker uses, so the column and
   * the picker read as one vocabulary. `null` means the address has no location.
   */
  const locationCellLabel = (address: ExternalIpAddress) => {
    const location = address.location_id === null ? null : locationById.get(address.location_id);
    if (!location) return null;
    return location.region ? `${location.name} · ${location.region}` : location.name;
  };

  const draftAccounts = useMemo(
    () => [...accounts].sort((a, b) => accountLabel(a).localeCompare(accountLabel(b))),
    [accounts, providerById],
  );

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const filtered = useMemo(() => addresses.filter((address) => {
    if (statusFilter !== "all" && address.status !== statusFilter) return false;
    if (!normalizedSearch) return true;
    const location = address.location_id === null ? null : locationById.get(address.location_id);
    return [
      address.ip_address, address.label, address.owner, address.tags, address.notes,
      deviceLabel(address), location?.name, location?.region,
      providerNameFor(address.location_id),
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedSearch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [addresses, statusFilter, normalizedSearch, locationById, accountById, providerById]);

  /** The lens: one bucketing pass over the flat register. */
  const groups = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => addressSortKey(a.ip_address).localeCompare(addressSortKey(b.ip_address)));
    if (groupBy === "none") {
      return sorted.length ? [{ key: "all", name: "", location: null as ExternalLocation | null, addresses: sorted }] : [];
    }
    const buckets = new Map<string, { key: string; name: string; location: ExternalLocation | null; addresses: ExternalIpAddress[] }>();
    for (const address of sorted) {
      let key: string;
      let name: string;
      let location: ExternalLocation | null = null;
      if (groupBy === "location") {
        location = address.location_id === null ? null : locationById.get(address.location_id) ?? null;
        key = `location:${address.location_id ?? "none"}`;
        name = location?.name ?? UNASSIGNED;
      } else if (groupBy === "provider") {
        name = providerNameFor(address.location_id);
        key = `provider:${name}`;
      } else {
        name = STATUS_LABEL[address.status];
        key = `status:${address.status}`;
      }
      const bucket = buckets.get(key) ?? { key, name, location, addresses: [] };
      bucket.addresses.push(address);
      buckets.set(key, bucket);
    }

    // A location with no addresses still has to be reachable. Creation happens
    // inline in the address modal and commits immediately, so an abandoned draft
    // is a real row — without an empty group to carry Edit/Delete it would be an
    // invisible record the user cannot manage. Only under the location lens: the
    // other lenses bucket by a property of the addresses themselves, which an
    // address-less location does not have. A status filter is an address filter,
    // so it hides them; a search still finds them by name or region.
    if (groupBy === "location" && statusFilter === "all") {
      for (const location of locations) {
        const key = `location:${location.id}`;
        if (buckets.has(key)) continue;
        if (normalizedSearch && ![location.name, location.region].filter(Boolean).join(" ")
          .toLocaleLowerCase().includes(normalizedSearch)) continue;
        buckets.set(key, { key, name: location.name, location, addresses: [] });
      }
    }

    return [...buckets.values()].sort((a, b) => {
      // Unassigned always sinks to the bottom; it is a bucket, not a place.
      if (a.name === UNASSIGNED) return 1;
      if (b.name === UNASSIGNED) return -1;
      return a.name.localeCompare(b.name);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, groupBy, statusFilter, normalizedSearch, locations, locationById, accountById, providerById]);

  const inUseCount = addresses.filter((address) => address.status === "in_use").length;
  const availableCount = addresses.filter((address) => address.status === "available").length;
  const migration = migrationDismissed ? null : query.data?.migration ?? null;
  const filtersActive = Boolean(searchTerm) || statusFilter !== "all";

  const isNew = editing === "new";
  // Only the add path accepts a range; editing addresses exactly one row.
  const parsedInput = useMemo(
    () => (isNew ? countAddressInput(form.ip_address) : ({ kind: "unknown" } as AddressInputCount)),
    [isNew, form.ip_address],
  );
  const plannedCount = parsedInput.kind === "ok" ? parsedInput.count : 1;
  /** Purpose, device, URL and owner are meaningless spread across 254 rows. */
  const isRange = plannedCount > 1;

  // The range default: a block you have just claimed is free until you say otherwise.
  useEffect(() => {
    if (!isNew || statusTouched) return;
    const next: ExternalIpAddress["status"] = isRange ? "available" : "in_use";
    setForm((current) => (current.status === next ? current : { ...current, status: next }));
  }, [isNew, isRange, statusTouched]);

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function resetAddressModal() {
    setDetailsOpen(false);
    setStatusTouched(false);
    setAddToInventory(false);
    setAddressError(null);
    setLocationDraftOpen(false);
    setLocationDraft(EMPTY_LOCATION_DRAFT);
    setLocationDraftError(null);
  }

  function openAdd() {
    setForm({ ...EMPTY_FORM });
    resetAddressModal();
    setEditing("new");
  }

  function openEdit(address: ExternalIpAddress) {
    setForm({
      ip_address: address.ip_address, location_id: address.location_id, device_id: address.device_id,
      status: address.status, label: address.label, url: address.url,
      owner: address.owner, tags: address.tags, notes: address.notes,
    });
    resetAddressModal();
    setDetailsOpen(Boolean(address.owner || address.url || address.tags || address.notes));
    setEditing(address);
  }

  function closeAddressModal() {
    setEditing(null);
    resetAddressModal();
  }

  /**
   * Only what actually changed. `ExternalIpAddressPayload` types every field as
   * mandatory-but-nullable while the backend treats them as optional, so a full
   * payload would null out fields the user never touched.
   */
  function diffPatch(next: ExternalIpAddressPayload, previous: ExternalIpAddress) {
    const patch: Partial<ExternalIpAddressPayload> = {};
    for (const field of Object.keys(next) as (keyof ExternalIpAddressPayload)[]) {
      if (next[field] !== previous[field]) (patch[field] as unknown) = next[field];
    }
    return patch;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (parsedInput.kind === "error") return;
    setAddressBusy(true); setAddressError(null);
    const cleaned: ExternalIpAddressPayload = {
      ...form,
      ip_address: form.ip_address.trim(),
      label: nullable(form.label), url: nullable(form.url),
      owner: nullable(form.owner), tags: nullable(form.tags), notes: nullable(form.notes),
      // The per-address fields were hidden once this became a range; do not
      // silently stamp a leftover value onto every row.
      ...(isRange ? { label: null, url: null, owner: null, device_id: null } : {}),
    };
    try {
      if (editing === "new") {
        const created = await api.createExternalAddresses(accessToken, cleaned);
        toast.success(created.length === 1 ? "External IP tracked" : `${created.length} external IPs tracked`);
        if (addToInventory && created.length === 1) {
          const address = created[0];
          setSeededAddressId(address.id);
          setDeviceSeed({
            display_name: address.label,
            hostname: null,
            ip_address: address.ip_address,
            tags: splitTags(address.tags),
            notes: address.notes,
            monitoring_paused: false,
          });
        }
      } else if (editing) {
        const patch = diffPatch(cleaned, editing);
        if (Object.keys(patch).length > 0) await api.updateExternalAddress(accessToken, editing.id, patch);
        toast.success("External IP updated");
      }
      closeAddressModal();
      await query.reload();
    } catch (error) {
      setAddressError(error instanceof Error ? error.message : "Failed to save external IP");
    } finally { setAddressBusy(false); }
  }

  /**
   * Releasing a decommissioned address in one click. `label` is optional now, so
   * this can clear it — the shipped form made it mandatory, which is what stopped
   * users freeing an address at all.
   */
  async function markAvailable() {
    if (!editing || editing === "new") return;
    setAddressBusy(true); setAddressError(null);
    try {
      await api.updateExternalAddress(accessToken, editing.id, { status: "available", device_id: null, label: null });
      closeAddressModal();
      await query.reload();
      toast.success("Address marked available");
    } catch (error) {
      setAddressError(error instanceof Error ? error.message : "Failed to mark this address available");
    } finally { setAddressBusy(false); }
  }

  function openLocationDraft() {
    // No provider is pre-selected: guessing one is how the shipped version made
    // the hierarchy feel mandatory.
    setLocationDraft({ ...EMPTY_LOCATION_DRAFT });
    setLocationDraftError(null);
    setLocationDraftOpen(true);
  }

  /**
   * Creates the account (when asked for) and the location without leaving the
   * address modal, then selects the result. This is the only caller of
   * `saveExternalAccount` in the app — a fresh install has no accounts, so this
   * path is what makes provider/account reachable at all.
   */
  async function saveLocationDraft() {
    const name = locationDraft.name.trim();
    if (!name) { setLocationDraftError("Give the location a name"); return; }
    const wantsAccount = locationDraft.account_id === "new";
    const accountName = locationDraft.account_name.trim();
    if (wantsAccount && !accountName) { setLocationDraftError("Give the account a name"); return; }
    setLocationDraftBusy(true); setLocationDraftError(null);
    try {
      const accountId = wantsAccount
        ? (await api.saveExternalAccount(accessToken, { provider_id: locationDraft.provider_id, name: accountName })).id
        : locationDraft.account_id;
      const created = await api.saveExternalLocation(accessToken, {
        account_id: typeof accountId === "number" ? accountId : null,
        name,
        region: nullable(locationDraft.region),
      });
      await query.reload();
      setForm((current) => ({ ...current, location_id: created.id }));
      setLocationDraftOpen(false);
      setLocationDraft(EMPTY_LOCATION_DRAFT);
      toast.success("Location added");
    } catch (error) {
      setLocationDraftError(error instanceof Error ? error.message : "Failed to create location");
    } finally { setLocationDraftBusy(false); }
  }

  function openLocationEditor(location: ExternalLocation) {
    setLocationEditorForm({ account_id: location.account_id, name: location.name, region: location.region });
    setLocationEditorError(null);
    setLocationEditor(location);
  }

  async function saveLocationEditor(event: FormEvent) {
    event.preventDefault();
    if (!locationEditor) return;
    setLocationEditorBusy(true); setLocationEditorError(null);
    try {
      await api.saveExternalLocation(
        accessToken,
        { ...locationEditorForm, name: locationEditorForm.name.trim(), region: nullable(locationEditorForm.region) },
        locationEditor.id,
      );
      setLocationEditor(null);
      await query.reload();
      toast.success("Location updated");
    } catch (error) {
      setLocationEditorError(error instanceof Error ? error.message : "Failed to save location");
    } finally { setLocationEditorBusy(false); }
  }

  /**
   * The only way to remove a location. The backend refuses one that still holds
   * addresses (409, "Move or remove this location's addresses first"), so that
   * message is surfaced rather than swallowed — the guard lives there, not here.
   */
  async function removeLocation(location: ExternalLocation) {
    if (!await confirmAction({
      title: "Delete location",
      message: `Delete ${location.name}?`,
      confirmLabel: "Delete",
    })) return;
    try {
      await api.deleteExternalLocation(accessToken, location.id);
      await query.reload();
      toast.success("Location deleted");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to delete location"); }
  }

  async function createInventoryDevice(payload: DevicePayload) {
    setDeviceBusy(true);
    try {
      const created = await createDeviceWithReservationConfirmation(accessToken, payload, confirmAction);
      if (!created) return;
      // Link the address to the device it just produced — that link is what shows
      // the device alongside the address in this register.
      if (seededAddressId !== null) {
        await api.updateExternalAddress(accessToken, seededAddressId, { device_id: created.id });
        setSeededAddressId(null);
      }
      onDeviceChange?.(created);
      setDeviceSeed(null);
      await query.reload();
      toast.success("Device added to Inventory and linked to this address");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create device");
    } finally { setDeviceBusy(false); }
  }

  async function remove(address: ExternalIpAddress) {
    if (!await confirmAction({
      title: "Delete external IP",
      message: `Stop tracking ${address.ip_address}?`,
      confirmLabel: "Delete",
    })) return;
    try {
      await api.deleteExternalAddress(accessToken, address.id);
      await query.reload();
      toast.success("External IP deleted");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to delete external IP"); }
  }

  async function dismissMigration() {
    setMigrationDismissed(true);
    try { await api.dismissExternalMigrationReport(accessToken); }
    catch { /* The notice is advisory; a failed dismiss must not interrupt the page. */ }
  }

  if (query.isLoading) return <WorkspaceSkeleton />;
  if (query.error) return <section className="nm-app-panel external-ip-panel"><div className="external-ip-empty external-ip-error">{query.error}</div></section>;

  // Location is the one grouping key that is not also a column. Under the other
  // lenses the rows would carry no location at all, so it is promoted to a real
  // column there rather than left implied by a group header that is not shown.
  const showLocationColumn = groupBy !== "location";
  const columnCount = showLocationColumn ? 8 : 7;

  const countHint = parsedInput.kind === "ok"
    ? `${parsedInput.count.toLocaleString("en-US")} address${parsedInput.count === 1 ? "" : "es"}`
    : parsedInput.kind === "error" ? parsedInput.message : null;

  const primaryLabel = editing !== "new"
    ? (addressBusy ? "Saving…" : "Save")
    : addressBusy ? "Adding…"
      : isRange ? `Add ${plannedCount.toLocaleString("en-US")} addresses` : "Add address";

  return (
    <div className="external-ip-workspace">
      <div className="dash-stats dash-stats--fill ipam-stats nm-summary-band">
        <DashStat label="Addresses" value={addresses.length} sub="public IPs tracked" icon={<Globe2 size={20} />} accent="teal" />
        <DashStat label="In use" value={inUseCount} sub="assigned to something" icon={<Globe2 size={20} />} accent="blue" />
        <DashStat label="Available" value={availableCount} sub="free to hand out" icon={<Globe2 size={20} />} accent="green" />
        <DashStat label="Locations" value={locations.length} sub="places addresses live" icon={<Globe2 size={20} />} accent="purple" />
      </div>

      {migration && (migration.declined.length > 0 || (migration.skipped?.length ?? 0) > 0) && (
        <div className="dash-alert dash-alert--overview-bar dash-alert--changes external-ip-migration-notice" role="status">
          <span className="dash-alert-dot dash-alert-dot--amber" aria-hidden="true" />
          {migration.declined.length > 0 && (
            <>
              <strong>
                {migration.declined.map((decline) => `${decline.cidr} at ${decline.location}`).join(", ")}
                {migration.declined.length === 1 ? " wasn't" : " weren't"} expanded
              </strong>
              <span className="dash-alert-tag">
                {migration.declined.reduce((sum, decline) => sum + decline.kept, 0)} tracked addresses kept
              </span>
            </>
          )}
          {(migration.skipped?.length ?? 0) > 0 && (
            <strong>
              {migration.skipped!.map((skip) => `${skip.cidr || "(blank)"} at ${skip.location} (${skip.reason})`).join(", ")}
              {" couldn't be read"}
            </strong>
          )}
          {migration.declined.length > 0 && (
            <span className="external-ip-migration-hint">Re-add a smaller range if you want to track free addresses here.</span>
          )}
          <button type="button" className="dash-alert-dismiss" aria-label="Dismiss migration notice" onClick={() => void dismissMigration()}>&times;</button>
        </div>
      )}

      <section className="nm-app-panel external-ip-panel">
        <header className="nm-app-panel-header ipam-panel-header external-ip-panel-header">
          <span className="ipam-panel-identity">
            <span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>
            <span className="ipam-panel-title-wrap">
              <span className="ipam-panel-title">External IPs</span>
              <span className="ipam-panel-meta">{filtered.length} of {addresses.length} address{addresses.length === 1 ? "" : "es"}</span>
            </span>
          </span>
          <div className="external-ip-panel-actions">
            <div className="external-ip-header-controls">
              <div className="nm-search nm-search--toolbar external-ip-search">
                <Search size={14} className="nm-search-icon" aria-hidden="true" />
                <input className="nm-input" type="search" aria-label="Search external IPs" placeholder="Search addresses, purpose, device, owner or tags…" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
              </div>
              <label className="external-ip-status-filter"><span>Status</span>
                <select className="nm-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                  <option value="all">All</option>
                  <option value="in_use">In use</option>
                  <option value="reserved">Reserved</option>
                  <option value="available">Available</option>
                </select>
              </label>
              <label className="external-ip-status-filter"><span>Group by</span>
                <select className="nm-select" value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
                  <option value="location">Location</option>
                  <option value="provider">Provider</option>
                  <option value="status">Status</option>
                  <option value="none">Nothing</option>
                </select>
              </label>
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={!filtersActive} onClick={() => { setSearchTerm(""); setStatusFilter("all"); }}>Clear filters</button>
            </div>
            {canWrite && <button className="nm-btn nm-btn--sm nm-btn--primary" type="button" onClick={openAdd}><Plus size={14} /> Add external IP</button>}
          </div>
        </header>

        {/* `groups`, not `filtered`: an install with no addresses can still have
            empty locations to manage, and they render as their own group rows. */}
        {groups.length === 0 && addresses.length === 0 ? (
          <div className="external-ip-empty">
            <p>No external IPs tracked yet.</p>
            {canWrite && <button className="nm-btn nm-btn--primary" type="button" onClick={openAdd}><Plus size={14} /> Add external IP</button>}
          </div>
        ) : groups.length === 0 ? (
          <div className="external-ip-empty">No external IPs match these filters.</div>
        ) : (
          <div className="nm-table-wrap external-ip-table-wrap">
            <table className="nm-table nm-table--selectable external-ip-table">
              <colgroup>
                <col className="external-ip-col-address" />
                {showLocationColumn && <col className="external-ip-col-location" />}
                <col className="external-ip-col-purpose" />
                <col className="external-ip-col-device" />
                <col className="external-ip-col-status" />
                <col className="external-ip-col-owner" />
                <col className="external-ip-col-tags" />
                <col className="external-ip-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>Address</th>{showLocationColumn && <th>Location</th>}<th>Purpose</th><th>Device</th><th>Status</th><th>Owner</th><th>Tags</th>
                  <th className="external-ip-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isCollapsed = collapsed.has(group.key);
                  const free = group.addresses.filter((address) => address.status === "available").length;
                  const showHeader = groupBy !== "none";
                  return (
                    <Fragment key={group.key}>
                      {showHeader && (
                        <tr className="external-ip-group-row" aria-expanded={!isCollapsed} onClick={() => toggleGroup(group.key)}>
                          <td colSpan={columnCount - 1}>
                            <span className="external-ip-group-cell">
                              <button type="button" className="external-ip-tree-toggle" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.name}`} onClick={(event) => { event.stopPropagation(); toggleGroup(group.key); }}>
                                {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                              </button>
                              <span className="external-ip-group-name">{group.name}</span>
                              <span className="external-ip-count-badge">{group.addresses.length} address{group.addresses.length === 1 ? "" : "es"}</span>
                              <span className="external-ip-count-badge">{free} free</span>
                            </span>
                          </td>
                          <td className="external-ip-actions" onClick={(event) => event.stopPropagation()}>
                            {/* New locations are created where you need one — inside the
                                address modal. These manage the ones that already exist,
                                including the empty ones that have no addresses to show. */}
                            {canWrite && groupBy === "location" && group.location && (
                              <span className="nm-table-actions">
                                <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => openLocationEditor(group.location!)}>Edit location</button>
                                <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void removeLocation(group.location!)}>Delete location</button>
                              </span>
                            )}
                          </td>
                        </tr>
                      )}

                      {!isCollapsed && group.addresses.map((address, index) => {
                        // Parity is emitted per group: the rows are a flattened hierarchy, so
                        // :nth-child would band across group boundaries.
                        const alt = index % 2 === 1 ? " is-alt" : "";
                        const tags = splitTags(address.tags);
                        const device = deviceLabel(address);
                        return (
                          <tr key={address.id} className={`external-ip-address-row external-ip-address-row--${address.status}`} onClick={() => canWrite && openEdit(address)}>
                            <td className={`nm-table-mono external-ip-address-cell${alt}`}>{address.ip_address}</td>
                            {showLocationColumn && (
                              <td className={alt.trim()}>
                                {locationCellLabel(address) ?? <span className="external-ip-muted">{UNASSIGNED}</span>}
                              </td>
                            )}
                            <td className={`external-ip-purpose-cell${alt}`}>
                              {address.label || <span className="external-ip-muted">—</span>}
                              {address.url && <a className="external-ip-url" href={address.url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>Open</a>}
                            </td>
                            <td className={alt.trim()}>{device ?? <span className="external-ip-muted">—</span>}</td>
                            <td className={alt.trim()}>
                              <span className={`nm-status nm-status--${STATUS_PILL[address.status]}`}>{STATUS_LABEL[address.status]}</span>
                            </td>
                            <td className={alt.trim()}>{address.owner || <span className="external-ip-muted">—</span>}</td>
                            <td className={alt.trim()}>
                              {tags.length === 0 ? <span className="external-ip-muted">—</span> : <span className="external-ip-tag-list">{tags.map((tag) => <span className="external-ip-tag" key={tag}>{tag}</span>)}</span>}
                            </td>
                            <td className={`external-ip-actions${alt}`} onClick={(event) => event.stopPropagation()}>
                              {canWrite && (
                                <span className="nm-table-actions">
                                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => openEdit(address)}><Pencil size={13} /> Edit</button>
                                  <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void remove(address)}><Trash2 size={13} /> Delete</button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <Modal
          size="lg"
          title={isNew ? "Add external IP" : `Edit ${editing.ip_address}`}
          titleIcon={<span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>}
          onCancel={closeAddressModal}
          footer={
            <>
              {!isNew && (
                <button
                  type="button"
                  className="nm-btn nm-btn--sm nm-btn--secondary external-ip-footer-lead"
                  disabled={addressBusy}
                  onClick={() => void markAvailable()}
                >
                  Mark available
                </button>
              )}
              {isNew && canCreateDevice && !isRange && (
                <div className="external-ip-footer-lead external-ip-inventory-toggle">
                  <span>Also add to Inventory and Monitoring</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={addToInventory}
                    aria-label="Also add to Inventory and Monitoring"
                    className={`external-ip-device-switch${addToInventory ? " is-on" : ""}`}
                    onClick={() => setAddToInventory((enabled) => !enabled)}
                  >
                    <span />
                  </button>
                </div>
              )}
              <ModalFooterActions
                onCancel={closeAddressModal}
                primaryLabel={primaryLabel}
                primaryDisabled={addressBusy || parsedInput.kind === "error"}
                formId="external-address-form"
              />
            </>
          }
        >
          <form id="external-address-form" className="modal-form external-ip-form" onSubmit={(event) => void save(event)}>
            <div className="nm-form-row">
              <label>{isNew ? "Address or range" : "Address"}
                <input
                  className="nm-input"
                  autoFocus
                  required
                  value={form.ip_address}
                  onChange={(event) => setForm({ ...form, ip_address: event.target.value })}
                  placeholder="203.0.113.7"
                />
                {isNew && (
                  <small className={`external-ip-count-hint${parsedInput.kind === "error" ? " external-ip-count-hint--over" : ""}`}>
                    {countHint ?? "One address, a CIDR, or a start–end range."}
                  </small>
                )}
              </label>
              <label>Location
                <PickOrCreate
                  ariaLabel="Location"
                  value={form.location_id}
                  options={locationOptions}
                  emptyLabel={UNASSIGNED}
                  createLabel="Create location…"
                  disabled={locationDraftOpen}
                  onChange={(id) => setForm((current) => ({ ...current, location_id: id }))}
                  onCreateRequested={openLocationDraft}
                />
              </label>
            </div>

            {locationDraftOpen && (
              // Inline, inside this same modal — a second Modal would put the
              // hierarchy back in front of the address. Enter is captured here so
              // it creates the location instead of submitting the address form,
              // and no field is `required`, which would block that outer submit.
              <div
                className="external-ip-inline-create"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (!locationDraftBusy) void saveLocationDraft();
                }}
              >
                <div className="external-ip-inline-create-head">
                  <strong>New location</strong>
                  <button type="button" className="nm-btn nm-btn--sm" onClick={() => { setLocationDraftOpen(false); setLocationDraftError(null); }}>Cancel</button>
                </div>
                <label>Account
                  <select
                    className="nm-select"
                    value={locationDraft.account_id === "new" ? "new" : locationDraft.account_id ?? ""}
                    onChange={(event) => setLocationDraft((draft) => ({
                      ...draft,
                      account_id: event.target.value === "new" ? "new" : event.target.value ? Number(event.target.value) : null,
                      // Provider only reaches the API through a newly created account,
                      // so it is cleared whenever no account is being created.
                      provider_id: event.target.value === "new" ? draft.provider_id : null,
                    }))}
                  >
                    <option value="">{NO_ACCOUNT}</option>
                    {draftAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
                    <option value="new">New account…</option>
                  </select>
                </label>
                {/* Provider lives here, not beside Account: it is stored on the account
                    row, so it can only be honoured while one is being created. Offered
                    against an existing account or "No account" it had nowhere to go and
                    was discarded on save without saying so. */}
                {locationDraft.account_id === "new" && (
                  <div className="nm-form-row">
                    <label>Account name
                      <input
                        className="nm-input"
                        maxLength={120}
                        value={locationDraft.account_name}
                        onChange={(event) => setLocationDraft((draft) => ({ ...draft, account_name: event.target.value }))}
                        placeholder="Production subscription"
                      />
                    </label>
                    <label>Provider
                      <select
                        className="nm-select"
                        value={locationDraft.provider_id ?? ""}
                        onChange={(event) => setLocationDraft((draft) => ({
                          ...draft,
                          provider_id: event.target.value ? Number(event.target.value) : null,
                        }))}
                      >
                        <option value="">No provider</option>
                        {/* `CloudProviderOption.id` is optional — a provider without one
                            cannot be referenced by an account, so it is not offered. */}
                        {cloudProviders.filter((provider) => typeof provider.id === "number").map((provider) => (
                          <option key={provider.id} value={provider.id as number}>{provider.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                <div className="nm-form-row">
                  <label>Name
                    <input
                      className="nm-input"
                      maxLength={120}
                      value={locationDraft.name}
                      onChange={(event) => setLocationDraft((draft) => ({ ...draft, name: event.target.value }))}
                      placeholder="Main datacentre"
                    />
                  </label>
                  <label>Region
                    <input
                      className="nm-input"
                      maxLength={120}
                      value={locationDraft.region}
                      onChange={(event) => setLocationDraft((draft) => ({ ...draft, region: event.target.value }))}
                      placeholder="eu-west-1"
                    />
                  </label>
                </div>
                {locationDraftError && <p className="modal-error" role="alert">{locationDraftError}</p>}
                <div className="external-ip-inline-create-actions">
                  <button
                    type="button"
                    className="nm-btn nm-btn--sm nm-btn--primary"
                    disabled={locationDraftBusy || !locationDraft.name.trim()}
                    onClick={() => void saveLocationDraft()}
                  >
                    {locationDraftBusy ? "Creating…" : "Create location"}
                  </button>
                </div>
              </div>
            )}

            <div className="nm-form-row">
              <label>Status
                <select
                  className="nm-select"
                  value={form.status}
                  onChange={(event) => { setStatusTouched(true); setForm({ ...form, status: event.target.value as ExternalIpAddress["status"] }); }}
                >
                  <option value="in_use">In use</option>
                  <option value="reserved">Reserved</option>
                  <option value="available">Available</option>
                </select>
              </label>
              {!isRange && (
                <label>Device
                  <select className="nm-select" value={form.device_id ?? ""} onChange={(event) => setForm({ ...form, device_id: event.target.value ? Number(event.target.value) : null })}>
                    <option value="">Not linked</option>
                    {inventoryDevices.map((device) => <option key={device.id} value={device.id}>{device.display_name || device.hostname || device.ip_address}</option>)}
                  </select>
                </label>
              )}
            </div>

            {!isRange && (
              <label>Purpose
                <input className="nm-input" value={form.label ?? ""} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="Public web endpoint" />
              </label>
            )}

            <button type="button" className="external-ip-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
              <span>
                <strong>More details</strong>
                <small>{isRange ? "Tags and notes for every address in the range." : "Owner, URL, tags and notes."}</small>
              </span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>

            {detailsOpen && (
              <div className="external-ip-details-section">
                {!isRange && (
                  <div className="nm-form-row">
                    <label>Owner<input className="nm-input" value={form.owner ?? ""} onChange={(event) => setForm({ ...form, owner: event.target.value })} placeholder="Team or customer" /></label>
                    <label>URL<input className="nm-input" type="url" value={form.url ?? ""} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://example.com" /></label>
                  </div>
                )}
                <label>Tags<input className="nm-input" value={form.tags ?? ""} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="production, wan" /></label>
                <label>Notes<textarea className="nm-input" rows={3} value={form.notes ?? ""} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              </div>
            )}

            {addressError && <p className="modal-error" role="alert">{addressError}</p>}
          </form>
        </Modal>
      )}

      {locationEditor && (
        <Modal
          title={`Edit ${locationEditor.name}`}
          titleIcon={<span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>}
          onCancel={() => setLocationEditor(null)}
          footer={<ModalFooterActions onCancel={() => setLocationEditor(null)} primaryLabel={locationEditorBusy ? "Saving…" : "Save"} primaryDisabled={locationEditorBusy} formId="external-location-form" />}
        >
          <form id="external-location-form" className="modal-form external-ip-form" onSubmit={(event) => void saveLocationEditor(event)}>
            <label>Provider account
              <select className="nm-select" value={locationEditorForm.account_id ?? ""} onChange={(event) => setLocationEditorForm({ ...locationEditorForm, account_id: event.target.value ? Number(event.target.value) : null })}>
                <option value="">{NO_ACCOUNT}</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
              </select>
            </label>
            <label>Location name<input className="nm-input" required maxLength={120} value={locationEditorForm.name} onChange={(event) => setLocationEditorForm({ ...locationEditorForm, name: event.target.value })} placeholder="Main datacentre or Central US" /></label>
            <label>Region<input className="nm-input" maxLength={120} value={locationEditorForm.region ?? ""} onChange={(event) => setLocationEditorForm({ ...locationEditorForm, region: event.target.value })} /></label>
            {locationEditorError && <p className="modal-error" role="alert">{locationEditorError}</p>}
          </form>
        </Modal>
      )}

      {deviceSeed && deviceMetadataQuery.data && (
        <DeviceForm
          busy={deviceBusy}
          device={null}
          cloneSource={null}
          initialValues={deviceSeed}
          deviceTypes={deviceMetadataQuery.data.deviceTypes}
          groups={deviceMetadataQuery.data.groups}
          snmpProfiles={deviceMetadataQuery.data.snmpProfiles}
          sites={deviceMetadataQuery.data.sites}
          onCancel={() => { setDeviceSeed(null); setSeededAddressId(null); }}
          onSubmit={createInventoryDevice}
        />
      )}
    </div>
  );
}
