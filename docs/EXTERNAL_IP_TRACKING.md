# External IP tracking

NetMap 1.5 adds external-address tracking to the normal IPAM workspace. Choose **Add subnet → External range** when recording an allocation. External records remain logically separate from internal discovery and DHCP data without requiring a second workspace.

## Managed allocations

An external allocation can be entered in whichever form the provider supplied:

- Arbitrary range: `8.8.8.10-8.8.8.13`
- CIDR: `8.8.8.0/29`

An allocation can record its provider, account/circuit reference, and purpose. NetMap preserves and displays the normalized form, then derives in-use, reserved, available, and utilization totals from its actual boundaries.

- Explicit ranges include both entered endpoints.
- IPv4 network and broadcast addresses are excluded only for CIDR prefixes up to `/30`.
- Allocations must contain at least two usable addresses; single-address and `/32` records are rejected.
- `/31` and IPv6 allocations treat every represented address as usable, while still requiring at least two addresses.
- Allocations cannot overlap and are limited to 65,536 addresses so address browsing remains bounded.
- Selecting an allocation opens its paged address map. Select an available address to add its label, status, owner, service, tags, and notes.

Only publicly routable addresses are accepted. Private, loopback, link-local, multicast, and unspecified ranges belong in the normal internal IPAM workspace instead.

## Permissions

All authenticated users who can view IPAM can read external address data. Creating, editing, and deleting allocations or assignments uses the existing IPAM write permission (`ipam:write`). Deleting an allocation also removes its contained assignments; NetMap asks for confirmation first.
