---
"@cire/db": patch
---

The dev seed imports again on a database whose seating chart the seating-plans migration moved: its tables take the seed's plan when that plan exists and the event's selected plan otherwise, and each seat takes its table's plan. Before, every cire dev deploy failed at the seed with "seating table plan is not a plan of its event".
