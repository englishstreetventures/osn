---
"@pulse/web": patch
---

The explore page no longer scrolls sideways on a phone. Below 768px the header's brand row wraps to three lines (brand and actions, the search from gutter to gutter, then the tabs) and scrolls with the page instead of pinning; the hero's stats sit under the headline; the gutters are 16px; and the create form's start and end times stack. From 768px up the row stays one line, and the search grows to its 360px cap and gives way first when the row is short. The search field gains an accessible name, the greeting's date wraps on a narrow phone, and "View all" keeps its chevron on its line. The header's tabs and search box no longer fade their focus mark in, and the brand mark's and live dots' pulses hold still under reduced motion.
