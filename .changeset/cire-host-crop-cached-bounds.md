---
"@cire/host": patch
---

The crop editor's drag check reads image bounds the editor already holds, worked out from the image's natural size and transform and refreshed whenever the image pans or zooms and when the window resizes. The crop box opens, and a saved crop reopens, over the image once cropperjs has sized and centred it, including while the modal is still animating open and for a picture the page has already loaded. A two-finger pinch zooms the image without tilting it.
