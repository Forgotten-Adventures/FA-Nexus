# FA Nexus

![Foundry VTT v13](https://img.shields.io/badge/Foundry%20VTT-v13+-green)
![Version](https://img.shields.io/badge/version-0.4.x-orange)
![Status](https://img.shields.io/badge/status-Beta-yellow)

FA Nexus is the all-in-one hub for Forgotten Adventures—bringing *fully featured mapmaking capabilities* and *advanced token management inside* Foundry VTT as well as other QoL improvements.

## Freemium Model
### Free Content & Features

- **Advanced Tokens placement and Assets placement tools** - backed by entire free section of *Forgotten Adventures library* - available instantly via cloud with no extra setup or cost. 
- This includes *over 141 000 Mapmaking Assets & over 1390 Unique topdown Tokens* available for free.
- **Elevation based Drop Shadows** - Customize drop shadow alpha, blur, dilation, angle, and distance for Asset placements.
- **Layer Manager** - Right sidebar tab with a list of all tiles within a scene, right under the 'Scenes' button. Grouped by elevation with visibility/lock toggles, selection sync, Alt+scroll elevation nudges, and `F2` inline rename for tile labels.
- Custom Tokens & Assets support - Bring your own content to FA Nexus interface & Tools.
- **Flatten & Scene Export** -  Merge tiles or export whole scenes with background/foregroudn split support, custom output names, and selectable save folders.
- Smart Search, Folders, and Bookmarks
- Pixel Perfect tiles selection

### Premium content & Features - ([Patreon Adventurer tier ($7) or higher](https://www.patreon.com/forgottenadventures/membership))**
- **Content unlocks** - All Token Color variants, Premium Tokens, Assets, Paths & Textures 
- **Texture painting** - Brush and fill tools with height-map masking for rapid terrain blending.
- **Paths** - Place or freehand draw curved paths with optional Foundry Walls & Drop Shadow support.
- **Building tool** - Draw outer and inner walls, place doors and windows, build entire structures in seconds with automatic shadows, foundry walls and texturing.



⚠️ **Beta notice:** Expect occasional rough edges, placeholder copy, and the odd gremlin. Please keep the feedback coming so we can polish the experience quickly. We also plan on implementing more features so if you have a specific feature request drop that into issues too!

<img width="1998" height="908" alt="image" src="https://github.com/user-attachments/assets/7c292296-b9f4-4ed9-a1bb-c3470fdca7ad" />

---

## Tokens Tab
- **Click-to-place workflow:** Click once to start placement, then drop tokens directly onto the canvas. Sticky mode keeps the placement cursor active for batch drops.
- **Multi-select randomizer:** Select several tokens and let Nexus randomize which one lands next.
- **Radom Color on Placement:** Randomize colors of selected Token(s) on drop.
- **Place Token As:** Choose an existing actor from your world or compendium to place token as that actor.
- **Hit point presets:** Use the actor default, roll a formula, apply a percentage, add a ±variance, or enter a custom value—even per placement session.
- **Grid savvy:** Snap to grid, rotate, mirror, or randomize facing before every drop.
- **Super Wildcards:** Combination of the systems above allow you to essentially havea "super" wildcard placement. e.g. Multiselect All our NPCs, Activate "Random Color on Placement", choose "Commoner" statblock as "Place Token As" , activate random rotation and flip & start placing!  You'll get a random NPC with random color and random rotation with each click!

[token_placement_v2.webm](https://github.com/user-attachments/assets/28af5e4e-2d7e-445d-a04c-715613291bee)

---

## Assets Tab
- **Same placement magic:** Sticky mode, random rotation, mirroring, scaling, and grid snapping work just like the Tokens tab—plus randomized scale offsets for organic placement.
- **Scatter brush placement:** Spray selected assets with density, spray deviation, and spacing controls; merge stamps into a single scatter tile per elevation (flatten if you go wild on counts).
- **Elevation on the fly:** Hold `Alt` + scroll to bump placement elevation by 0.1 increments. Decimal elevations keep assets layered without jumping ahead of tokens (override in settings if you prefer Foundry defaults).
- **Shadow presets per elevation:** Customize drop shadow alpha, blur, dilation, angle, and distance for each elevation level. Save up to five presets and reapply them with a click.
- **Multi-select randomizer:** Select several assets and let Nexus randomize which one lands next. Combine with random rotation and scale!

Scatter preview:
![20260128_1327_Foundry_Virtual_Tabletop_WhK9zqaxAr](https://github.com/user-attachments/assets/4bce8052-427f-4e03-9fe9-cc50cae40462)

Single placement preview:
![20260128_1329_Foundry_Virtual_Tabletop_jca134gVYv](https://github.com/user-attachments/assets/8e67a407-8c67-493d-930e-a95ca9cf8c9f)

---

## Texture Painting *(Adventurer tier $7+)*
- **Height-map masking:** Paint only the raised or recessed parts of a texture with a live preview window.
- **Brush controls:** Adjust size, tip size, density, spray deviation, spacing, and opacity for finer control.
- **Fill & mask tools:** Flood fill, rectangle, ellipse, polygonal lasso with arc segments (Shift+click) all support snap-to-grid for precise coverage.
- **Solid color mode:** Paint with a flat color for shadows and overlays.
- **Eraser mode**: Brush & fill tools support Eraser mode too.
- **Texture transforms:** Adjust opacity, scale, rotation, and UV offset mid-session without leaving the tool.
- **Texture swap:** Simply select a different texture from the main window to swap textures during editing.
- **Save as Tile**: Once you are happy with the masked texture, press Ctrl+S to save as Foundry Tile!


![20260128_1340_Foundry_Virtual_Tabletop_xW4LveO7Y6](https://github.com/user-attachments/assets/441078a0-587a-496a-a5e3-5fc96d85a5c9)

---

## Building Tool *(Adventurer tier $7+)*
- **Rapid structure creation:** Construct building footprints with help of rectangle, elipse and polygon shapes (with arcs support) and inner walls that auto-generate foundry walls.
- **Portals:** Place textured doors, windows and gaps on any wall segment, the tool automatically cuts openings, creates appropriate foundry walls and textures. Doors and windows can even be animated!
- **Texture per surface:** Assign different textures to exterior walls, interior walls, and floor independently.
- **Per-segment editing:** In `Edit Shapes`, left click selects the whole shape, right click selects an individual wall segment for per-segment texture, transform, color, and shadow edits.
- **Automatic shadows:** Structures inherit the same elevation-based shadow system as regular assets for consistent depth.

[Building tool swcs v2.1 - Made with Clipchamp.webm](https://github.com/user-attachments/assets/1032ccf8-575f-4b30-967d-b0f8367bf47f)

---

## Path Placement *(Adventurer tier $7+)*
- **Multi-path sessions:** Draw and edit multiple paths at different elevations before committing.
- **Draw modes:** Point-and-click curves or freehand drawing with simplification; double-click ends a path, Close Loop is a toggle.
- **Foundry walls toggle:** Spawn Foundry walls along the path centerline.
- **Merge on Commit:** Combine paths at the same elevation into a single tile, or keep them separate.
- **Path texture controls:** Adjust scale, opacity, flip, offsets, and color grading on the fly.
- **Path shaping toolkit:** Per-point width control, feathered endings, smooth curve tension, and edit-mode point manipulation.
- **Path splitting:** In `Edit Shapes`, hover a point and press `X` to split a path.
- **Path shadows:** Elevation-based shadows with editable path shadow geometry.
- **Texture swap:** Select a different texture from the main window to swap path materials during editing.

![20260128_1443_Foundry_Virtual_Tabletop_sEjSIgY1KS](https://github.com/user-attachments/assets/e0eb837f-9b1d-4abd-b416-8fd6eab54f4a)

---

## Layer Manager v2
- **Right sidebar tab:** Layer Manager tab sits under Scenes and lists all tiles in the scene.
- **Search and chip filters:** Filter by type/status, use `OR` and `NOT`, or prefix a term with `-` to exclude results like `-scatter`.
- **Visibility, lock, and bulk actions:** Toggle visibility/lock per group or row, and bulk lock/delete selected layers.
- **Inline rename:** Press `F2` to rename a row. This stores a display-only tile name and falls back to the computed label when cleared.
- **Nested elevation groups:** Collapse groups, create nested subgroups, give groups custom names, and move whole groups to a new elevation.
- **Drag-and-drop reordering:** Reorder layers between elevation groups directly from the manager.
- **Selection controls:** Canvas selection syncs with Layer Manager, all elevations are selectable by default, and `Skip Filtered` limits selection to currently visible search/filter matches.
- **Context menus:** Layers and groups expose rename, elevation change, lock/unlock, flatten, Foundry `Edit`, and FA `Nexus Edit` actions where applicable.
- **Help and diagnostics:** Built-in help, per-group counts, persistent collapse state, and precise elevation formatting make dense scenes easier to manage.

<img width="863" height="852" alt="image" src="https://github.com/user-attachments/assets/56364fea-7db8-449d-b012-62b1139cb287" />

---

## Flatten & Scene Export
- **Layer Manager access:** Flatten button lives at the bottom of the Layer Manager. Tile hud or right click context menu in the layer manager.
- **Output name:** Set a custom base name before flattening or exporting.
- **Output folder:** Choose where generated files are uploaded; flatten and export remember separate last-used folders.
- **Predictable generated paths:** Generated flatten files are organized into scene-owned folders, and the dialog shows the effective upload destination before saving.
- **Output snap:** Round results to half or full grid squares for clean snapping.
- **Live bounds preview:** See output bounds while adjusting the flatten region.
- **Padding adjust:** Add or trim padding and watch the bounds update live.
- **Persistent settings:** Options like PPI and quality are remembered.
- **Smart deconstruct:** Moved flattened tiles deconstruct in their new position, and nested flattened metadata is preserved.
- **Chunking:** Large flattened tiles are split automatically and stitched at runtime for better performance.
- **Scene export:** Export or flatten the full scene with optional foreground/background split and deterministic suffixes for multi-part outputs.

<img width="409" height="819" alt="image" src="https://github.com/user-attachments/assets/9f176bb7-c08b-4ec7-859c-e36b07b2b685" />

---

## Generated Cleanup
- **Generated Cleanup tool:** Scan FA Nexus generated masks and flattened outputs for unused or missing files from module settings.
- **Manual cleanup workflow:** Foundry does not allow automatic deletions here, so Nexus can only back up and mark unused files for manual removal.

---

## Smart Search, Folders, and Bookmarks
- **Weighted matching:** Nexus boosts likely hits so `fir` gives you fir trees before fireballs.
- **Exact and negative terms:** Wrap a term in quotes to match exactly like `"orc"`, or prefix with `-` to hide unwanted results. Combine statements with parentheses for more complex filters.
- **Docked folder filters:** See and filter by our Folder Structure. Pick inclusion and exclusion folders with multi-select.
- **Bookmark anything:** Save your favorite combinations of search terms and folder filters for Tokens, Assets, Textures, or Paths. Bookmarks show in a toolbar, overflow gracefully, and can be dragged to reorder.
- **Search memory:** Each tab remembers its last query and folder state, so hopping between views doesn’t wipe your work.

[search-folders-bookmarks_v2.webm](https://github.com/user-attachments/assets/e56417b2-509b-42b4-b285-b6955211790f)

---

## Quality of Life & Performance
- **Restyled tool panels:** Collapsible sections remember their state, controls are denser and clearer, and each active tool includes contextual help.
- **Unified undo/redo:** `Ctrl+Z` / `Ctrl+Y` across Paths, Textures, Building, and Scatter sessions.
- **Session guardrails:** Auto-commit on tab change or app close, `Esc` cancel with confirmation, and explicit Commit/Undo/Redo/Cancel buttons in tool panels.
- **Precise controls:** Slider values are remembered, right-click resets to default, numeric inputs stay in sync, and randomization ranges use explicit `Min` / `Max` controls.
- **Overhead-aware FA tiles:** Paths, masked textures, buildings, scatter tiles, and chunked flatten tiles can participate in Foundry's native overhead occlusion when marked `Overhead`.
- **Pixel-perfect selection:** Precise tile hit detection respects transparent areas.
- **Performance-first browsing:** One-time indexing and virtualized grids keep massive libraries snappy.
- **Background cloud preload:** The cloud asset catalog starts loading after startup so Nexus often opens without waiting on a blocking cloud overlay.
- **Placement prefetcher:** Random placement queues downloads ahead of time so you do not drop an empty tile.
- **Edit existing tiles:** Right click a supported tile and choose `Edit <tile> in FA Nexus` from the tile controls.
- **Forge VTT compatible:** Works in Forge environments. Testing is ongoing, so please report anything odd.

---

## Installation
1. Open **Add-on Modules** in Foundry VTT.
2. Click **Install Module**.
3. Paste the FA Nexus manifest URL:
   ```
   https://raw.githubusercontent.com/Forgotten-Adventures/FA-Nexus/main/module.json
   ```
4. Click **Install**, then enable **FA Nexus** in your world.

---

## Getting Started
1. Launch a world in Foundry v13+ and enable FA Nexus.
2. Click the **FA Nexus** button above the player list to open the window.
3. Pick a tab (`Tokens`, `Assets`, and more if unlocked) and start browsing.
4. Use the search bar, folder filters, and bookmarks to home in on what you need.
5. Click an item, or multi-select several, and start placing.
6. Visit **Module Settings -> FA Nexus** to toggle pixel-perfect tile selection, elevation behavior, cache paths, shadow quality, generated cleanup, and more.

Premium supporter? Authenticate with Patreon inside the app to unlock texture painting, path editing, the building tool, and premium catalog entries.

---

## Requirements & Compatibility
- **Foundry VTT:** v13 or later.
- **Systems tested:** D&D 5e, Pathfinder 1e/2e, DSA5 / The Dark Eye, Black Flag, Daggerheart, Shadowdark RPG, Rolemaster Unified.
- **Internet connection:** Needed for cloud content and Patreon validation.
- **Patreon Adventurer tier ($7+):** Required for premium textures, paths, building tools, and locked assets.

---

Spotted a bug or have a feature request? Open an issue on [GitHub](https://github.com/Forgotten-Adventures/FA-Nexus/issues) or join us on the [Forgotten Adventures Discord](https://discord.gg/forgottenadventures).

**Made with ❤ by the Forgotten Adventures team.**
