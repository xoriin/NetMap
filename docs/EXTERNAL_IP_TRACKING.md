# External IP tracking

Open **IPAM → External IPs** to manage provider-assigned public addresses. External records remain
separate from internal subnets, discovery, reservations, and DHCP data, while using the same
`ipam_write` permission model.

## Managed allocations

An external allocation can be entered in whichever form the provider supplied:

- Arbitrary range: `8.8.8.10-8.8.8.13`
- CIDR: `8.8.8.0/29`

An allocation records its provider, cloud service/area, account or circuit reference, region, and purpose. NetMap preserves and displays the normalized form, then derives in-use, reserved, available, and utilization totals from its actual boundaries.

Each allocation can also use a user-selected asset icon. The picker shares the application icon catalogue, including installed custom packs, and the chosen mark appears in the allocation tier of the tree. Provider brand icons remain managed separately in Cloud provider administration.

The External IPs page is organised as **Provider → Service/area → Allocation → IP address**. Providers remain the main organisational point, while services such as Amazon EC2, AWS Lambda, Azure Virtual Machines, or Azure Functions keep different parts of a cloud estate distinct. Provider and service groups open initially; allocations stay collapsed except for single-address `/32` and `/128` records. Rows can be expanded either by clicking the row or its chevron.

Search covers provider, service, allocation, account, region, CIDR/range, address, owner, and status. The status filter, count badges, and utilization column provide a compact overview without removing access to individual addresses. Allocation maintenance is grouped under its **Actions** menu; address-level Edit or Assign actions remain directly available.

Each address row can also be deleted independently. For an address inside a larger CIDR or range, NetMap splits the allocation around that address so every neighbouring IP remains managed. Any tracking record for the deleted address is removed, but a linked Inventory device is retained. Deleting an allocation's final address also removes the now-empty allocation, and the confirmation dialog states this before proceeding.

- Explicit ranges include both entered endpoints.
- IPv4 network and broadcast addresses are excluded only for CIDR prefixes up to `/30`.
- Cloud-issued single addresses may be recorded as `/32` or `/128` allocations and are created automatically when an address does not belong to an existing managed range.
- `/31` and IPv6 allocations treat every represented address as usable.
- Allocations cannot overlap and are limited to 65,536 addresses so address browsing remains bounded.
- Expanding an allocation opens its paged address list. Select an available address to add its label, status, owner, tags, and notes, and optionally link it to an Inventory device.

## Cloud assets

An external address can optionally reference an Inventory device. Linked devices appear under
**Inventory → Cloud assets**, grouped Provider → Device → Address. This is a view of the shared
Inventory device record, not a second asset database; editing or deleting the External IP tracking
record does not silently delete the device.

Only publicly routable addresses are accepted. Private, loopback, link-local, multicast, and unspecified ranges belong in the normal internal IPAM workspace instead.

## Permissions

All authenticated users who can view IPAM can read external address data. Creating, editing, and deleting allocations or assignments uses the existing IPAM write permission (`ipam_write`). Deleting an allocation also removes its contained assignments; NetMap asks for confirmation first.
