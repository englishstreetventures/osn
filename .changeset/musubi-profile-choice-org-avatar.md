---
"@musubi/social": minor
"@osn/client": minor
"@osn/api": minor
"@osn/auth-ui": patch
---

Musubi chooses profiles, draws avatars and offers organisation actions in one way each.

- `/authorize` is one layout. Every screen that decides leads with the app's client card, the picker included. Its heading is an `AuthHeader` `h2`. One notice slot sits directly above the actions. The actions are one full-width column, with Cancel `secondary` and last. The account screen and the picker choose a profile with the new `ProfileChoice`: radios in bordered rows, the chosen one edged in ink. The picker leaves only on Continue. Allow is offered only while the profile it would post is on screen, and a choice made for one account never stands for another.
- The account menu is the profile switcher. Each profile is a `menuitemradio` row, the active one checked. Choosing another switches to it, and every row is held while the switch runs. The "Switch profile" dialog is gone, and so is `ResponsiveDialogContent`'s `width` prop.
- `ProfileAvatar` and `OrgAvatar` draw every avatar. A person's is a circle and an organisation's a square with 8px corners. Each shows the picture or the initials, never both, and one rule makes the initials. The account menu's 20px circle shows the first initial alone, since two at 12px overflow it.
- `GET /organisations/:handle` answers the caller's own standing, `caller: { role, owner } | null`, and `@osn/client`'s `getOrg` types it. An organisation's page offers Edit to an admin and Delete to the owner. It offers Remove on a member's row to an admin, and on an admin's row too to the owner, never on the reader's own row. A reader whose standing is unknown is offered nothing. A read of the standing that fails, a defect included, is logged and answers `null`.
- `@osn/auth-ui`: comments and `DESIGN.md` name the account menu as Musubi's switcher, and `AuthHeader`'s comment gives what `/authorize` loads for its dialog module, measured from `vite build`.
