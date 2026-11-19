---
"@cire/api": patch
---

An account's erasure now answers, as one kept item, the deleted weddings of the person's that the daily purge still holds (a gift disputed, or a purchase or gift pending under 14 days, or a change still writing): "A deleted wedding you owned, kept until a payment or gift for it settles, then erased in Cire's daily clean-up." (or "<n> deleted weddings …"), with `erasedOn` and `requestUrl` null. The soft delete names the profile whose owner seat went as the wedding's deleter; the call that finishes counts the held ones and clears the deleter with every other column that names the person, only once no owner seat of theirs is left. The purge's `wedding purged` log names a wedding's deleter only while the wedding has an owner. Limits: a repeat call after osn-api lost cire's done answer reports nothing kept, and a wedding someone else deleted and then left to the person alone is not counted. The clean-up batch makes one more D1 statement (22).
