---
"@cire/api": patch
---

Link preview, the registry image copy and the picker thumbnails refuse these destinations as well as the private, loopback, link-local and multicast ranges. IPv4: `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24` and `203.0.113.0/24`. IPv6: an address in `::ffff:0:0/96`, `::/96` or the well-known NAT64 prefix `64:ff9b::/96` is checked against the IPv4 rules; any other address outside global unicast `2000::/3` is refused, and so are `2001::/23` (Teredo included), `2002::/16` (6to4), `2001:db8::/32` and `3fff::/20` inside it.
