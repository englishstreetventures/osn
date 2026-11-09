---
"@shared/ui": patch
---

`DropdownMenu`'s default separator draws only its 1px hairline. It renders as an `<hr>`, which kept preflight's 1px top border in the panel's ink, and that border covered the hairline in pulse's menus; Musubi's menus look the same as before, because its base styles already painted that border in the hairline colour. In a contrast theme, which replaces the fill with the page colour, the separator draws its top border, so the line still shows there. The accent separator cire's menus draw is unchanged.
