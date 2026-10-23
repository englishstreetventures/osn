---
"@cire/api": patch
---

Link preview, the registry image copy and the picker thumbnails refuse more reserved addresses. IPv4: `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24` and `203.0.113.0/24`. IPv6: everything outside global unicast `2000::/3` (the local-use NAT64 prefix `64:ff9b:1::/48` and site-local `fec0::/10` among them), plus `2001::/23` (Teredo included), `2002::/16` (6to4), `2001:db8::/32` and `3fff::/20`. The NAT64 unwrap now applies only to the well-known `64:ff9b::/96`.
