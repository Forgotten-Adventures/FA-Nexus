# Change Log

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-04-07

### Added
- **Re-coloring for Assets, Paths, Textures, and Buildings:** 
    - Added Hue, Saturation, Brightness & Contrast color grading controls for Asset placement/scatter, Paths, Texture Painting, and Building walls/fills/portals.

- **Tool Options Panel Re-styling:**
    - Added collapsible panel sections with remembered collapse state per tool, so recurring workflows can stay compact.
    - Added a contextual help button/window for active tools, including a quick summary, panel areas, notes, and shortcuts.
    - Moved shared session controls such as `Snap to Grid` and snap density into a denser footer layout, freeing more room for actual tool settings.
    - Sliders, toggles, numeric inputs, and tooltips now use a cleaner and more consistent presentation, including better hover/focus treatment and clearer inline labels across specialized controls such as shadows, offsets, and flip/random settings.
    - Scale/rotation randomization now uses explicit `Min`/`Max` range controls in the panel instead of a single strength value, and Portal options were rebuilt to match the new grouped/collapsible panel style.

- **Layer Manager v2:** Significant expansion of the Layer Manager with stronger organization, editing, and navigation tools.
    - Rows can now be renamed inline with `F2`; the override is stored as a display-only tile name and falls back to the computed label when cleared.
    - Layers now support search and chip filtering. Search supports `OR` and `NOT`; `NOT` can also be used as `-` before a word, for example `-scatter` filters out all `scatter` tiles from the layer list.
    - All elevations (foreground/non-foreground) are selectable by default when Layer Manager is open; `Ignore Foreground Toggle` was removed.
    - Added `Skip Filtered` selection option (on by default), meaning only layers matching the current filter/search can be selected on the canvas.
    - Added type/status chips, bulk lock/delete actions, drag-and-drop reordering between elevation groups, and inline badges for special layer states such as HSBC.
    - Elevation groups can now be collapsed, given custom names, and moved to a new elevation.
    - Added optional nested elevation grouping with recursive subgroups (on by default), persistent collapse state, and automatic expansion to reveal selected canvas layers.
    - Added a context menu for layers and groups with rename, elevation change, lock/unlock, flatten, Foundry `Edit`, and FA `Nexus Edit` actions where applicable.
    - Added a help button and contextual help window in the header.
    - Added collapsible `Selection Options` section, per-group counts, and four-decimal elevation formatting for more precise layer organization.

- **Flatten Improvements & Scene Export:** 
    - Flatten and scene export dialogs now let you set an output name and pick the upload folder before saving generated images, while remembering the last-used flatten and export folders separately. [Feature Request #35](https://github.com/Forgotten-Adventures/FA-Nexus/issues/35)
    - Generated flatten/export filenames are sanitized to `.webp`, and split/chunked outputs now use deterministic suffixes for foreground/background and row/column chunks.
    - Flattened tile outputs now default to `fa-nexus-assets/__generated/flattened/<world>/<scene>`; `<world>/<scene>` is prepended even for custom output folders, and the flatten dialog shows the effective upload folder so scene-owned generated files land in predictable locations.
    - Deconstructing a flattened tile now preserves nested flattened metadata, so restored child flattened tiles keep their own deconstruct data.

- **Flatten & Mask File Cleanup Tool:** 
    - Added `Generated Cleanup` tool in module settings to scan FA Nexus generated outputs (Masks & Flattened images), report unused or missing files, and optionally back up then mark unused files for manual cleanup. Foundry blocks automatic file deletions so deleting has to be done manually.
    - Similarly to flattened tiles, masks are now generated into `fa-nexus-assets/__generated/masks/<world>/<scene>` so scene-owned generated files land in predictable locations.

- **Overhead Proxy Pipeline:**
    - FA-rendered tiles set as `Overhead` now use a shared custom overhead proxy pipeline so masked textures, paths, building overlays, scatter tiles, and chunked flatten tiles can participate in native overhead occlusion handling. (Use sparingly, as this can consume more VRAM/GPU.)

- **Shadow Quality Controls:** 
    - Added a new world-level `Shadow Quality` setting for FA asset drop shadows, with `Low`, `Medium`, `High`, and `Ultra` caps for shadow render textures.
    - The drop-shadow offset max for asset placement can now be adjusted (Max 512px, was hard set to 40px before).

- **Asset Placement & Scatter Preview Improvements:** 
    - Scatter brush now shows live ghost stamps inside the brush plus spacing markers, so density, deviation, spacing, and random transforms can be previewed before painting.
    - Hovering or focusing the Asset Placement tool-options panel now temporarily anchors the preview to the viewport center so slider adjustments stay visible without freezing the preview manually. (You can still manually freeze the preview in a desired spot with `Space`.)

- **Path Splitting:**
    - Paths can now be split in 'Edit Shapes' mode by hovering a point and hitting 'X' shortcut. 

- **Building Tool Improvements:**
    - Building tool now shows a width/height grid measurement of the drawn shape next to the cursor. [Feature Request #34](https://github.com/Forgotten-Adventures/FA-Nexus/issues/34)
    - `Edit Shapes` now supports `per-segment` editing of outer/inner walls. Left click selects the whole shape, right click selects a specific segment for editing, and you can now adjust texture, wall transforms, color, and shadow on a per-segment basis. You can `Reset Segment` with a button at the bottom of the `Wall Transform` section. [Feature Request #38](https://github.com/Forgotten-Adventures/FA-Nexus/issues/38)

- **Token Placement Actor Type Detection:**
    - `Place Token As -> Create New` now detects the available actor types for the active game system and surfaces them directly in Tool Options.
    - Added an `Auto` actor type choice plus a manual `New Actor Type` override when creating actors from token drops.
    - Actor creation now tries the selected/detected system-appropriate type first, then falls back through other valid actor types before using the minimal actor-creation path. This should improve compatibility with systems that are not explicitly added yet.
    - Added `Rolemaster Unified` system detection [Based on PR #36](https://github.com/Forgotten-Adventures/FA-Nexus/pull/36)

### Changed
- Streamlined local/cloud catalog orchestration.
- Updated local folder index persistence so large asset and token libraries can be reindexed safely as content changes.
- Simplified cloud sync and download retry handling and tightened asset tab reload/cancellation behavior.
- Cloud Assets catalog now preloads in the background after startup, so Nexus opens without showing the cloud loading overlay if the preload finishes before the first opening of the Nexus.
- Token cloud catalog loading now uses abortable requests, keeps loader state in sync with known cloud totals, and preserves local results when cloud refresh only partially fails.
- Asset Placement now stores separate scale, rotation, and flip/random transform presets for single placement versus Scatter mode, migrating existing placement transforms into scatter defaults on first use.
- Elevation controls across Asset Placement, Paths, Texture Painting, and Building editing no longer rely on `Alt+Scroll` alone. All four tools and Layer Manager now support direct elevation nudging with `Alt+[ / ]` and `Alt+Up / Down`, and use finer step sizes of `0.01` by default, `0.001` with `Ctrl/Cmd`, and `0.1` with `Shift`.  Tools also include manual `Elevation` numeric inputs in `Transform` section of the options panel.

### Fixed
- Premium entitlement refreshes now ignore stale responses so an older auth result cannot overwrite a newer ready or error state.
- Token cloud sync/list failures no longer collapse into a silent empty-success path during Nexus browsing.
- Building and path tile deletion now queue linked Foundry wall cleanup per scene so cascade deletes no longer race each other and spam transient `Wall "... does not exist!"` errors.
- Outer building wall tiles now restore hover/selection state correctly after exiting Edit mode without requiring the tile to be nudged first.
- Creating FA custom tiles no longer re-triggers duplicate PIXI `BaseTexture` and `Texture` cache-id warnings when the source art is already cached.
- Texture commits now avoid the extra Canvas2D crop readback that triggered Chrome `willReadFrequently` warnings during mask saves.
- Rotated building, path, scatter, and generic tile shadows now stay aligned to the source tile instead of drifting when the source art is rotated.
- Texture editor undo history now stores alpha-only region patches with byte-budget trimming instead of full extracted mask canvases, reducing memory pressure on large file-mask sessions.
- Texture Painting now remembers brush/fill opacity plus texture scale, rotation, and offset settings between editing sessions.
- Tile flattening now allows a single visible tile, and both tile flatten and scene flatten/export skip tiles hidden via Foundry or the FA Nexus Layer Manager. [Issue #33](https://github.com/Forgotten-Adventures/FA-Nexus/issues/33)
- Building wall meshing no longer throws on degenerate centerline inputs that short-circuit before full geometry creation.
- Masked texture overlay teardown now fully restores the original mesh texture, material texture, and shader sampler bindings.
- Reused asset cards no longer accumulate duplicate click handlers.
- Token drag preview failures now restore hover suppression, actor highlighting, and window transparency instead of leaving the UI in a stuck state.
- Content source keys now normalize single trailing slashes, cloud text search now matches tags correctly, and content source dialog saves no longer leave folder/cloud settings partially persisted on failure.
- Token and asset local-download inventory lookups no longer collide on identical filenames across separate storage roots.
- Patreon OAuth polling now tolerates initial `400` and `401` auth-check responses for the first five polling attempts so newly authorized or newly upgraded users are not failed before backend state propagates.
- Shadow-layer scene-rectangle expansion now uses safer fallback bounds and avoids invalid/empty-doc extents, reducing unnecessary oversized render targets and stabilizing shadow rebuild performance on large scenes.
- Layer Manager selection filtering and tile interactivity now refresh correctly after exiting Path, Texture Painting, and Building edit sessions or after editor interaction locks are released.
- Numeric tool-option inputs now resync cleanly on Enter/invalid commits, and Asset Scatter numeric fields no longer treat empty or boolean values as valid input.
- Asset placement `Shift+Wheel` scaling now respects scroll direction on macOS external mice by falling back to `deltaX` when the OS remaps wheel input. [Issue #42](https://github.com/Forgotten-Adventures/FA-Nexus/issues/42) [PR #44](https://github.com/Forgotten-Adventures/FA-Nexus/pull/44)


## [0.3.38] - 2026-01-29
### Fixed
- Layer Manager panel is now only visible to GMs
- 'Inner Wall' scale in 'Building tool' being set to '25'

## [0.3.1 - 0.3.37] - 2026-01-27
### Changed
- Tool Options sliders no longer respond to plain scroll (except Subgrid Density) to avoid scroll interference; use Ctrl+wheel, drag, or type a value and commit with Enter/blur.

### Fixed
- 'Edit Path/Texture/Building' behaving  all kinds of weird because of some stuff introduced for 'Layer Manager'
- Path control points now render above ohter tiles in the scene so they are no longer blocked visually if you have tiles above higher elevation
- Cloud assets grids now refresh after delta manifest updates without requiring a full reindex.
- Cloud assets with identical filenames but different folder paths no longer collapse into a single entry.
- Other small fixes
- Flatten Tiles from v0.2 not displaying properly

### Known Bug
- 'Inner Wall' scale in Building tool being set to '25' in some instances.


## [0.3.0] - 2026-01-25

### Added
- **Layer Manager (MVP):** Right Sidebar tab with a list of all tiles within a scene, right under the 'Scenes' button.
    - Tiles are grouped by 'Elevation'
    - Per Layer/Elevation visibility & lock toggles
    - Elevation adjustments of selected tiles with 'Alt+Scroll wheel' (+Shift/Ctrl modifiers)
    - Selection sync between Layer Manager & canvas
    - Multi selection with Ctrl/Shift click
    - Canvas selevation range & selection limits -  set min/max, skip hidden/locked & 'Ignore foreground toggle' , selection box on canvas as well as 'Ctrl+A' will respect these canvas selection settings.
    - Visual 'Foreground starts at Elev <x>' marker as well as 'Scene Backround' and 'Scene Foreground'
    - Asset placement & premium editors start with elevation set to the highest currently selected tile.

- **Paths v2:** Significant rework of 'Paths' Editor 
    - Multiple paths can be drawn in a single session even at separate elevations, each with separate textures and settings. 'Edit Shapes' allows for any adn all adjustments to already placed paths within a sesssion.
    - *Foundry Walls* toggle, spawns Foundr walls that follow center point of placed path (can be set per-path within same session)
    - *Draw mode* - Freehand drawing instead of 'Curve' point & click option to draw paths, Drawn paths are simplified for optimization.
    - *Merge on Commit* toggle, merges all paths within a session at the same elevetion into a single tile (instead of each path being separate tile)
    - Double clicking now ends current path being placed - *Close Loop* is now a toggle.

- **Asset Scatter Brush:** Quickly scatter selected assets onto a canvas.
    - Options for size/density/spray diviation & spacing
    - Respects random scale, rotation and flips
    - Supports scattering assets in a single session at multiple elevations.
    - Scattered Assets are commited as a single 'Scatter' Tile per elevation. 

    *Warning* - Scatter tiles even tho appear as one tile still draw each scattered asset individually they are not one image, so if you 'overdo it' and spray thousands of assets in a single session, consider flattening said tile for better performance. 

- **Texture Painting Improvements**  
    - *Height Map Texture Painting* - With this option enabled, each texture generates a 'height map', which allows you to only paint certain portions of said texture based on their 'height'. This is fully customizable with a handy 'Preview' window which shows you what exactly you'll be painting.
    For example if you have a brick texture with a grout, you can set the height map in a way where you only paint the bricks while rest of the texture (grout between the bricks) stays transparent, so if you had for example a sandy background already placed, that sandy background will fill that grout instead of whatever the texture had there originally.
    - *Brush settings* - Instead of just one default brush option, you can now customize not only scale, but tip size, density, spray deviation & spacing of the brush, giving you much finer control over how the brush behaves. 
    - Polygon Lasso now supports 'Arc' segments with Shift click. 
    - *Solid Color painting* - option to paint with a solid color instead of a texture, allows you to paint in manual shadows for example. 

- **Flatten Improvements & Scene Export** 
    - New 'Flatten' Button at the bottom of 'Layer Manager'
    - *Output Snap* - Rounds the resulting tile to half or full grid squares for clean snapping.
    - Live output bounds preview
    - *Padding Adjust* - add or trim padding, adjusting the output bounds.
    - Persistent options (PPI, Quality etc.)
    - *Deconstruct offset respect* - if you move a flattned tile, it will deconstruct in new position isntead of snapping back where it was constructer.
    - *Chunking* - Large flattened tiles are split automatically in the background and 'stitched' together at runtime for better performance. You can see the split lines if you have debug enabled in the mod settings.
    - *Export/Flatten Scene* - You can export or flatten the whole scene (cropped to the scene bounds without padding) - accessible in bottom of layers manager with no tiles selected. Option to split by scene foreground elevation (produces separate background/foreground tiles/exports) as well as optional 'Chunking'.  Export exports the full scene image(s) to fa-nexus-assets/exports, scene background & foreground are included in the resulting images.

- **Undo/Redo:** Unified per-session history with `Ctrl+Z`/`Ctrl+Y (or Ctrl+Shift+Z)` in Paths Editor, Texture Painting, Building & Assets Scatter tools. 

- **Session UX unification:**
    - Auto-commit on tab change or nexus close
    - Slider values and settings in tool options are remembered, sliders can be right clicked to return to default value
    - All sliders now have an input value box where you can type in the desired value [#21](https://github.com/Forgotten-Adventures/FA-Nexus/issues/21)
    - Undo/Redo/Commit/Cancel buttons added to the panel
    - Cancel/Discard on ESC or 'Cancel' button press - with 'Are you sure' confirmation popup (double ESC to quickly cancel)

- **Shadowdark system support** Added system detection support for 'Shadowdark RPG' so Tokens can be used. (Thanks to [matteobarbieri](https://github.com/matteobarbieri) for PR! )

### Fixed
- Hidden tiles no longer render drop shadows. [#17](https://github.com/Forgotten-Adventures/FA-Nexus/issues/17)
- Path node selection no longer fails when width tangents are hidden and the node is very narrow. [#14](https://github.com/Forgotten-Adventures/FA-Nexus/issues/14)
- Patreon auth expiry now disconnects cleanly instead of leaving a stale session. [#26](https://github.com/Forgotten-Adventures/FA-Nexus/issues/26)
- "Shift BG & Tile Elevation Down" now re-applies the background render offset after Levels (and similar modules) update background elevation.
- Paths editor polish: Shadow offset step is now 0.01, "Wall Shadow" is labeled "Path Shadow".
- Textures tab includes Texture_Overlays from !Effects.
- Fixes for issues [#19](https://github.com/Forgotten-Adventures/FA-Nexus/issues/19) & [#28](https://github.com/Forgotten-Adventures/FA-Nexus/issues/28)

## [0.2.0] - 2025-12-14

### Added
- **Building Tool:** Construct building footprints with help of rectangle, elipse and polygon shapes (with arcs support) and inner walls that auto-generate foundry walls, place textured doors, windows and gaps and preview the full structure in real-time before committing. Supports texture assignment per wall, adjsutable floor texture, automatic shadow generation matching asset elevation rules and multiple buildings in one session that get separated on commit. 
- **Subgrid Density** slider for 'Snap to Grid' — choose from full, 1/2 , 1/3 , 1/4 , 1/5 grid snapping options. 
- **Direct URLs for free cloud content** option in module settings, when enabled, free cloud tokens and assets will be loaded directly from the public URL instead of being downloaded and cached locally - saving storage space.
- **Restricted player access** to FA Nexus and it's module settings. [#3](https://github.com/Forgotten-Adventures/FA-Nexus/issues/3)
- **Floating Launcher** option in module settings, when enabled,the Nexus Launcher button floats freely and can be dragged anywhere on screen isntead of being docked above the players list.
- **S3 bucket support:** Source selector now properly saves S3 buckets as valid content sources. Also added S3 support for 'Cloud Download Folder(s)' [#12](https://github.com/Forgotten-Adventures/FA-Nexus/issues/12)
- **Compendium filtering for Place Token As:** Filter which compendiums appear in actor suggestions to avoid duplicates across SRD, homebrew, and official modules. [#2](https://github.com/Forgotten-Adventures/FA-Nexus/issues/2)

### Changed
- Reworked "Keep Tokens Above Tile Elevations" to shift tile render elevation down by 1 for all tiles below elevation 1, leaving tokens and visual FX unmodified.
- Scene background is pushed down to elevation -5 while the feature is enabled to prevent it from obscuring shifted tiles.
- **Asset Drop Shadow** - Enabled by default.
- **Paths Shadows** - Smoother blur and consistency across all zoom levels.
- **Paths Width Tangents** - Width Tangents are hidden by default, can be activated with a tickbox in the tool panel, they also ignore 'snap to grid' setting.
- **Paths Thumbnails** - Paths & Walls are displayed in wide aspect ration, significantly improving selection at a glance.

### Fixed
- Tile render ordering is now more compatible with Sequencer/JB2A/Automated Animations or other modules relying on placing stuff above tokens since tokens are no longer repositioned.
- Keyboard nudging (WASD/Arrow Keys) no longer floors tile elevation to 0 when dz is unchanged, preserving fractional elevations.
- Foundry VTT zoom no longer stops at 0.2 on large scenes when FA Nexus is active. [#6](https://github.com/Forgotten-Adventures/FA-Nexus/issues/6)
- Pixel-perfect selection no longer captures color-fill tiles across the entire canvas [#7](https://github.com/Forgotten-Adventures/FA-Nexus/issues/7)
- Random Color on Placement now works correctly with local tokens instead of erroring about uncached images. [#8](https://github.com/Forgotten-Adventures/FA-Nexus/issues/8)
- Added an option to not modify actor size when applying artwork from differently-sized creatures through 'Update Actor Token'. [#11](https://github.com/Forgotten-Adventures/FA-Nexus/issues/11)
- "Place Token As" now preserves prototype token settings (e.g. Append Incrementing number & Prepend random adjective) instead of ignoring custom configurations. Also added these 2 options into the Token Placement options so they can be set when 'Placing Token As' [#9](https://github.com/Forgotten-Adventures/FA-Nexus/issues/9)

## [0.1.3] - 2025-11-01

### Added
- Tile flattening workflow exposed on the tile HUD. Merges selected tiles into a single baked image, saves undo metadata, and adds a dedicated dialog for resolution/quality choices plus deconstruction support. [#1](https://github.com/Forgotten-Adventures/FA-Nexus/issues/1)

### Fixed
- Assets tab card helper now resolves local texture/path file locations consistently. [#1](https://github.com/Forgotten-Adventures/FA-Nexus/issues/1)
- Updated premium texture and path editors to resolve module assets via Foundry's routed base path in an effort to fix bundle loading when the module runs from subdirectories. [#4](https://github.com/Forgotten-Adventures/FA-Nexus/issues/4)
- Pixel-perfect tile selection no longer blocks Foundry's native resize handle for standard assets; FA path and texture tiles keep their handles hidden to avoid unsupported scaling. [#5](https://github.com/Forgotten-Adventures/FA-Nexus/issues/5)

## [0.1.2] - 2025-10-29

### Added
- Premium paths now supports elevation based shadows with shadow geometry editing (Shift+click inserts points, Alt+click deletes), dedicated path shadow scale, offset, blur, opacity and dialation sliders, and adds saved presets.

### Changed
- Texture painting and Path placement remembers elevation between uses.


## [0.1.1] - 2025-10-26

### Added
- Asset Placement can now re-open and edit existing FA tiles
- Added per-asset shadow controls ( dilation/spread & offset), blur & opacity still per elevation.
- Press `Space` during placement to pin the asset preview in place while you tweak shadows, flips, scale, etc.

### Changed
- Alt+Ctrl/Cmd now nudges elevation in 0.01 increments (Shift still applies the coarse ×5 boost) across asset placement, premium path editing, and premium texture painting; scrolling text now displays hundredths to make micro-adjustments visible.
- Ctrl/Cmd+Shift+Wheel rotates assets in 1° steps (15° remains the default), keeping visual tweaks consistent with the tool-option hints.
- The tool-options controller and placement overlay were tuned to avoid jumpy reflows, ensuring the expanded shadow UI and randomization controls stay in sync with pointer gestures.

### Fixed
- Tile pixel selection ignores tiles at 0 opacity zero, preventing “ghost” hits.
- Asset shadow previews clamp offset handles to the circular gizmo, stopping wild swings when testing large spreads.
- Clamped max spread/offset inputs so extreme values no longer break the shared shadow compositor or cause layout flicker when reopening the tool panel.

## [0.1.0] - 2025-09-04

Initial public release.
