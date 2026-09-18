# Static caption background

Final asset: `images/overlaybackground-static.png`.
Consumers: `popout.html` and `test-static-captions.html`, displayed at 1920 × 760 px.
Created using the built-in imagegen tool; the old background asset is retained.

The thin frame leaves the author, caption text and page indicators clear. The scoreboard divider is drawn by CSS at y=640 rather than embedded in the bitmap, so it matches the 640 px caption area and 120 px scoreboard strip precisely. The existing scoreboard supplies the darker strip.

## Initial edit prompt

Use case: precise-object-edit
Asset type: production background bitmap for an arcade caption overlay.
Input image 1 is the EDIT TARGET: the old dark metallic cyan-accented overlay frame. Redesign its geometry to fit the new layout. Input image 2 is a LAYOUT REFERENCE ONLY: the current browser preview. Do not include the screenshot, OBS interface, text, scores, stars, icons, or any preview controls in the output.
Output: one flat opaque background image, exactly 1920 x 760 pixels (48:19 wide aspect ratio), edge-to-edge, front-facing.
Primary change: retain the understated dark graphite sci-fi metal and restrained cool cyan accents of image 1, but REMOVE all large angled cutouts, inset frames, thick internal borders, glowing streaks and diagonal decorations that intrude into live content.
Layout in output-pixel coordinates:
- Caption area: x=0..1920, y=0..640. This must be a single large, uninterrupted near-black charcoal reading surface, nearly uniform and very low contrast. It supports a small author row at x=80..1840 y=38..120, two very large text lines at x=80..1840 y=130..570, and page indicators at y=590..620. These are safe areas; draw no inner frames, dividing lines, ornaments, or visible texture across them.
- Scoreboard strip: x=0..1920, y=640..760, the bottom 15.79% of the image. A clean quiet horizontal dark band, distinctly but subtly darker than the caption surface, with one subdued thin straight horizontal separator exactly at y=640. Completely open space for centered scores and stars stretching either side. No individual score boxes.
- Only outermost 12 pixels at left/right and 16 pixels at top/bottom may contain modest gunmetal edge bevels, tiny cyan corner accents and subtle structural detailing. Symmetric, minimal, premium arcade instrument-panel aesthetic. Keep corner geometry tiny; no large notches. No ornament behind the author row or footer.
Preserve: the original image's dark metallic atmosphere, clean high contrast support for white captions, and restrained cyan accent palette. Improve fit and calmness.
No text, lettering, labels, numbers, logos, stars, people, objects, transparent holes, watermark, or explanatory diagram. Do not render the layout measurements. Deliver ONLY the finished empty background asset.

## Final refinement prompt

Use case: precise-object-edit.
Edit target: the attached newly generated dark sci-fi background panel.
Make one targeted change: REMOVE the entire internal cyan horizontal divider and the darker bottom compartment. Fill the ENTIRE interior inside the outer frame with one continuous uniform near-black graphite surface matching the large upper reading area. No visible division anywhere across the interior. The web page will draw its own precisely positioned scoreboard separator and shading.
Preserve the existing extremely thin outer gunmetal frame, tiny cyan corner details, dark palette, wide 48:19 aspect ratio and minimal style. Keep all border decoration confined to the outermost edge and leave the center completely empty, including the bottom. No internal horizontal line, internal border, nested frame, text, numbers, icons, labels, stars, or logos.
This is an empty background asset for display at 1920 x 760 pixels; output that resolution if possible. Do not add any content.
