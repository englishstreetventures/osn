---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

Couples on Gold can seed their checklist from a starter checklist: about twenty
neutral planning tasks, each due a set time before the wedding date.

An owner or editor previews the starter from the checklist and picks what to
add; applying it again adds nothing twice. Seeded tasks record the template,
the item and their offset from the wedding date, and while open they follow the
wedding date when it changes in Settings. A completed task, or one whose date
the couple set, stays where it is. A seeded task the couple deletes is not
brought back by a later apply unless they pick it. Without a wedding date the
tasks are added without due dates, and the preview asks for the date.

Migration `0086_task_templates.sql` adds the provenance columns and a unique
index to `tasks`, and the `task_template_dismissals` table.
