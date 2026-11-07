# FA Nexus

![Foundry VTT v14](https://img.shields.io/badge/Foundry%20VTT-v14-green)
![Version](https://img.shields.io/badge/version-0.6.x-orange)
![Status](https://img.shields.io/badge/status-Beta-yellow)

FA Nexus is the all-in-one hub for Forgotten Adventures—bringing *fully featured mapmaking capabilities* and *advanced token management inside* Foundry VTT as well as other QoL improvements.

## Freemium Model
### Free Content & Features

- **Advanced Token and Asset placement tools** - backed by the free section of the *Forgotten Adventures library* and available instantly via cloud with no extra setup or cost.
- This includes *over 141 000 Mapmaking Assets & over 1390 Unique topdown Tokens* available for free.
- **Elevation based Drop Shadows** - Customize drop shadow alpha, blur, dilation, angle, and distance for Asset placements.
- **Layer Manager** - Right sidebar tab with a list of all tiles within a scene, right under the 'Scenes' button. Supports v14 level-aware groups, visibility/lock toggles, selection sync, drag-and-drop ordering, and `F2` inline rename for tile labels.
- Custom Tokens & Assets support - Bring your own content to FA Nexus interface & Tools.
- **Flatten & Scene Export** - Merge tiles or export scenes for the current viewed level or all scene levels, with background/middle/foreground split support, custom output names, and selectable save folders.
- **Scene Groups** - Group Tiles, Walls, Lights, Sounds, and Regions, then move, rotate, and scale them together on the canvas.
- **Prefabs (Experimental)** - Save Scene Groups to a local Prefab library shared by every world, place them in any Scene and on any Level, and exchange them as files.
- Smart Search, Folders, and Bookmarks
- Pixel Perfect tiles selection

### Premium content - [Patreon Premium tier or higher](https://www.patreon.com/forgottenadventures/membership)
- **Content unlocks** - All Token Color variants, Premium Tokens, and Premium Assets

### Pro tools - [Patreon Pro tier](https://www.patreon.com/forgottenadventures/membership)
Pro includes everything in Premium, plus:
- **Texture painting** - Brush and fill tools with height-map masking and blend modes for rapid terrain blending.
- **Tile Masking** - Mask compatible tiles through the premium Texture Painting editor, clear masks from Tile Config or Layer Manager, and remove parts of a tile image directly in Foundry.
- **Paths** - Place or freehand draw curved paths with optional Foundry Walls & Drop Shadow support.
- **Building tool** - Draw outer and inner walls, place doors, windows, openings, and secret doors, fill each room, and commit a Building with its Foundry Walls, doors, and Region. A committed Building can be moved, rotated, scaled, and reopened for editing.



⚠️ **Beta notice:** Expect occasional rough edges, placeholder copy, and the odd gremlin. Please keep the feedback coming so we can polish the experience quickly. We also plan on implementing more features so if you have a specific feature request drop that into issues too!

<img width="1998" height="908" alt="image" src="https://github.com/user-attachments/assets/7c292296-b9f4-4ed9-a1bb-c3470fdca7ad" />

---

## Tokens Tab
- **Click-to-place workflow:** Click once to start placement, then drop tokens directly onto the canvas. Sticky mode keeps the placement cursor active for batch drops.
- **Multi-select randomizer:** Select several tokens and let Nexus randomize which one lands next.
- **Random Color on Placement:** Randomize colors of selected Token(s) on drop.
- **Place Token As:** Choose an existing actor from your world or compendium to place token as that actor.
- **Level-aware placement:** Token placement targets the currently viewed v14 scene level and uses that level's bottom elevation for new token drops.
- **Hit point presets:** Use the actor default, roll a formula, apply a percentage, add a ±variance, or enter a custom value—even per placement session.
- **Grid savvy:** Snap to grid, rotate, mirror, or randomize facing before every drop.
- **Super Wildcards:** Combine the systems above for "super" wildcard placement. For example, multi-select NPCs, enable "Random Color on Placement", choose a "Commoner" statblock as "Place Token As", enable random rotation/flip, and start placing. Each click can drop a random NPC with random color and random rotation.

[token_placement_v2.webm](https://github.com/user-attachments/assets/28af5e4e-2d7e-445d-a04c-715613291bee)

---

## Assets Tab
- **Same placement magic:** Sticky mode, random rotation, mirroring, scaling, and grid snapping work just like the Tokens tab—plus randomized scale offsets for organic placement.
- **Scatter brush placement:** Spray selected assets with density, spray deviation, and spacing controls; merge stamps into a single scatter tile per elevation (flatten if you go wild on counts).
- **Elevation on the fly:** Use `Alt` + scroll, `Alt` + `[` / `]`, or `Alt` + `Up` / `Down` to nudge placement elevation. The default step is `0.01`, with `Ctrl/Cmd` for `0.001` and `Shift` for `0.1`.
- **Shadow presets per elevation:** Customize drop shadow alpha, blur, dilation, angle, and distance for each elevation level. Save up to five presets and reapply them with a click.
- **Shadow Only mode:** Keep the generated FA shadow while hiding the source artwork, useful for contact shadows, subtle depth, and hand-placed shadow passes.
- **Multi-select randomizer:** Select several assets and let Nexus randomize which one lands next. Combine with random rotation and scale!

Scatter preview:
![20260128_1327_Foundry_Virtual_Tabletop_WhK9zqaxAr](https://github.com/user-attachments/assets/4bce8052-427f-4e03-9fe9-cc50cae40462)

Single placement preview:
![20260128_1329_Foundry_Virtual_Tabletop_jca134gVYv](https://github.com/user-attachments/assets/8e67a407-8c67-493d-930e-a95ca9cf8c9f)

---

## Texture Painting *(Pro tier)*
- **Height-map masking:** Paint only the raised or recessed parts of a texture with a live preview window.
- **Tile Masking:** Use the premium Texture Painting editor to mask compatible tiles.
- **Blend modes:** Paint texture layers as Normal, Overlay, Soft Light, Multiply, Screen, or Add to blend dirt, moss, water, scorch marks, highlights, color passes, and similar details into the scene underneath.
- **Brush controls:** Adjust size, tip size, density, spray deviation, spacing, and opacity for finer control.
- **Fill & mask tools:** Flood fill, rectangle, ellipse, polygonal lasso with arc segments (Shift+click) all support snap-to-grid for precise coverage.
- **Solid color mode:** Paint with a flat color for shadows and overlays.
- **Eraser mode**: Brush & fill tools support Eraser mode too.
- **Texture transforms:** Adjust opacity, scale, rotation, and UV offset mid-session without leaving the tool.
- **Texture swap:** Simply select a different texture from the main window to swap textures during editing.
- **Save as Tile**: Once you are happy with the masked texture, press Ctrl+S to save as Foundry Tile!


![20260128_1340_Foundry_Virtual_Tabletop_xW4LveO7Y6](https://github.com/user-attachments/assets/441078a0-587a-496a-a5e3-5fc96d85a5c9)

---

## Building Tool *(Pro tier)*
The Building Tool works on the Building that is on the canvas: open, edit, cancel, and commit it again after it has been moved, rotated, or scaled. The preview shows exactly what Commit writes, its Foundry Walls and doors included.
- **Workspaces:** Tool Options are organized into Outer Walls, Inner Walls, Portals, Fill Textures, and Edit Geometry.
- **Outer shapes:** Draw a Rectangle, Ellipse, or Polygon (Shift+click for curved sides) and add it to or subtract it from the Building. Staged placement lets a shape be moved, resized, rotated, or point-edited before it is accepted, and Room Construction keeps the walls between rooms.
- **Inner walls and dividers:** Draw poly-lines or smooth splines; split, join, and convert segments between straight and curved. Sticky Joints keep connected walls together while one is reshaped.
- **Fill per room:** Each enclosed room can take its own texture, scale, rotation, offset, opacity, and color, or follow the Building's Fill.
- **Portals:** Doors, Windows with sill, glass, and frame, framed Openings, and Seamless Secret Doors that look like the wall they are cut from. A portal can be converted to another kind, fitted to its artwork's width, and given its own behavior, sound, timing, and initial state.
- **Wall behavior:** Solid, Terrain, Invisible, and Ethereal presets or a custom combination, for the whole Building, one wall path, or single segments.
- **Edit Geometry:** Move vertices and curve handles of the committed shape, with the session's own Undo and Redo.
- **Clean output:** Walls, Fill, and Sills are committed as named Tiles (for example "Ground Floor - Building 1 - Walls"). A committed Building renders and works for every user without the premium editor.
- **Leaving with unsaved changes:** Closing FA Nexus or opening another tab asks Commit, Discard, or Continue Editing.
- **Buildings from 0.5.3:** They open in the new editor and stay untouched until a change is committed, which upgrades them.

[Building_Tool_Preview](https://github.com/user-attachments/assets/d256ad1c-c5d4-468d-90f4-40c6fc1127bf)

---

## Path Placement *(Pro tier)*
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

## Level-aware Layer Manager
- **Right sidebar tab:** Layer Manager tab sits under Scenes and lists all tiles in the scene.
- **v14 level groups:** Each level shows dedicated `<level> Background` and `<level> Foreground` groups for the special ground/foreground bands.
- **Parent Level:** Tiles visible on multiple levels can store which v14 level owns them, so grouping, band sorting, flatten/deconstruct, and editing target the intended level. Single-level tiles can usually stay on `Auto / Unset`.
- **Preview rows:** Active Asset Placement, Scatter, Path, Texture Painting, Building, and Building Fill sessions appear as preview rows that can be drag-and-dropped before commit.
- **Search and chip filters:** Filter by type/status, use `OR` and `NOT`, or prefix a term with `-` to exclude results like `-scatter`.
- **Visibility, lock, and bulk actions:** Toggle visibility/lock per group or row, and bulk lock/delete selected layers.
- **Inline rename:** Press `F2` to rename a row. This stores a display-only tile name and falls back to the computed label when cleared.
- **Folders:** Organize dense stacks into Folders inside an elevation group without changing Elevation; Folders can be nested, hidden, locked, flattened, or promoted to their own elevation.
- **Nested elevation groups:** Collapse groups, create nested subgroups, give groups custom names, and move whole groups to a new elevation.
- **Drag-and-drop reordering:** Reorder layers between elevation groups directly from the manager.
- **Selection controls:** Canvas selection syncs with Layer Manager, all elevations are selectable by default, and `Skip Filtered` limits selection to currently visible search/filter matches.
- **Context menus:** Layers and groups expose rename, elevation change, lock/unlock, flatten, Foundry `Edit`, and FA `Nexus Edit` actions where applicable.
- **Help and diagnostics:** Built-in help, per-group counts, persistent collapse state, and precise elevation formatting make dense scenes easier to manage.

<img width="863" height="852" alt="image" src="https://github.com/user-attachments/assets/56364fea-7db8-449d-b012-62b1139cb287" />

---

## Scene Groups
- **Live groups:** Group selected Tiles, Walls, Lights, Sounds, and Regions in the Scene Groups window. Groups can be renamed, nested, collapsed, hidden, locked, ungrouped, or deleted, and every member still works as a normal Foundry object.
- **Group transforms:** Move, rotate, and uniformly scale a selected group on the canvas with live previews, snapping, adjustable pivots, and one Undo step.
- **Copy, paste, duplicate:** Copies are staged for placement, also across Levels and Scenes.
- **Optional:** "Enable Scene Groups" in the module settings switches them off. Groups already in a Scene are kept, and copy and paste of Buildings and Paths keeps working.

---

## Prefabs (Experimental)
Prefabs are experimental: how they are saved and placed may change in a later version. "Enable Prefabs (Experimental)" in the module settings switches them off. They need Scene Groups.

- **Local Prefab library:** Save one or more Scene Groups as a Prefab by dragging them into the Prefabs tab or with "Save as Prefab…". The library is shared by every world of the installation.
- **Stays editable:** Buildings, Paths, Textures, and Scatter inside a placed Prefab can still be edited with Nexus Edit.
- **Staged placement:** Move, resize, rotate, and mirror a Prefab before Accept, with grid snapping and a choice between its pixel size and the Scene's grid. Accept is one Undo step; Cancel writes nothing.
- **Anywhere:** Place Prefabs in Scenes with another grid size and on another Level, and exchange them with Export Prefab and Import Prefab.

[SceneGroupsPrefabs_Preview](https://github.com/user-attachments/assets/dde5debe-41fc-4c08-a6e4-a93744250043)

---

## Flatten & Scene Export
- **Gameplay stays live:** Flatten turns the selection into one picture per depth band (ground, middle, foreground). Its Walls, doors, windows, Lights, Sounds, and Regions keep working, and Deconstruct brings back the original layers, Buildings and Paths still editable.
- **Layer Manager access:** The Flatten button lives at the bottom of the Layer Manager, and flattening is also available from the Tile HUD or Layer Manager right-click context menu.
- **Output name:** Set a custom base name before flattening or exporting.
- **Output folder:** Choose where generated files are uploaded; flatten and export remember separate last-used folders.
- **Predictable generated paths:** Generated flatten files are organized into scene-owned folders, and the dialog shows the effective upload destination before saving.
- **Output snap:** Round results to half or full grid squares for clean snapping.
- **Live bounds preview:** See output bounds while adjusting the flatten region.
- **Padding adjust:** Add or trim padding and watch the bounds update live.
- **Persistent settings:** Options like PPI and quality are remembered.
- **Smart deconstruct:** Moved flattened tiles deconstruct in their new position, and source flattened tiles keep their own deconstruct data so they can be deconstructed separately later.
- **Chunking:** Large flattened tiles are split automatically and stitched at runtime for better performance.
- **Level export:** Export or flatten the current viewed level, or run every scene level in sequence. Split output uses background, middle, and foreground band suffixes.

<img width="409" height="819" alt="image" src="https://github.com/user-attachments/assets/9f176bb7-c08b-4ec7-859c-e36b07b2b685" />

---

## Generated Cleanup
- **Generated Cleanup tool:** Scan FA Nexus generated masks and flattened outputs for unused or missing files from module settings.
- **Manual cleanup workflow:** Foundry does not allow automatic deletions here, so Nexus can only back up and mark unused files for manual removal.

---

## Smart Search, Folders, and Bookmarks
- **Weighted matching:** Nexus boosts likely hits so `fir` gives you fir trees before fireballs.
- **Exact and negative terms:** Wrap a term in quotes to match exactly like `"orc"`, or prefix with `-` to hide unwanted results. Combine statements with parentheses for more complex filters.
- **Docked folder filters:** Browse folders in every content tab, including Building wall paths and fill textures. Turn off **Include subfolders** to show only files directly inside the selected folder; folder counts follow the selected mode. Ctrl+Click combines folders, and Alt+Click excludes a folder and its subfolders. The mode stays with each tab's folder selection and saved bookmarks.
- **Bookmark anything:** Save your favorite combinations of search terms and folder filters for Tokens, Assets, Textures, or Paths. Bookmarks show in a toolbar, overflow gracefully, and can be dragged to reorder.
- **Search memory:** Each tab remembers its last query and folder state, so hopping between views doesn’t wipe your work.

[search-folders-bookmarks_v2.webm](https://github.com/user-attachments/assets/e56417b2-509b-42b4-b285-b6955211790f)

---

## Quality of Life & Performance
- **Restyled tool panels:** Collapsible sections remember their state, controls are denser and clearer, and each active tool includes contextual help.
- **Unified undo/redo:** `Ctrl+Z` / `Ctrl+Y` across Paths, Textures, Building, and Scatter sessions.
- **Session guardrails:** Leaving an editor never drops work silently. Texture and Path sessions are saved when you switch tabs or close the window, and the Building Tool asks whether to Commit, Discard, or Continue Editing. `Esc` or Cancel asks before discarding in every editor, and tool panels have explicit Commit/Undo/Redo/Cancel buttons.
- **Precise controls:** Slider values are remembered, right-click resets to default, numeric inputs stay in sync, and randomization ranges use explicit `Min` / `Max` controls.
- **Overhead-aware FA tiles:** Paths, masked textures, buildings, scatter tiles, and chunked flatten tiles can participate in Foundry's native overhead occlusion when marked `Overhead`.
- **FA Nexus Tile Config tab:** Tile Config exposes Parent Level, HSBC, mask clearing, and shadow settings for supported tiles.
- **Pixel-perfect selection:** Precise tile hit detection respects transparent areas.
- **Performance-first browsing:** One-time indexing and virtualized grids keep massive libraries snappy.
- **Background cloud preload:** The cloud asset catalog starts loading after startup so Nexus often opens without waiting on a blocking cloud overlay.
- **Placement prefetcher:** Random placement queues downloads ahead of time to reduce empty or late tile drops.
- **Edit existing tiles:** Right click a supported tile and choose `Edit <tile> in FA Nexus` from the tile controls.
- **Forge VTT/S3 path support:** Forge VTT and S3 browsing/download paths are supported, with hosted-environment testing still ongoing. Please report anything odd.

---

## Installation
1. Open **Add-on Modules** in Foundry VTT.
2. Click **Install Module**.
3. Paste the FA Nexus manifest URL:
   ```
   https://github.com/Forgotten-Adventures/FA-Nexus/releases/latest/download/module.json
   ```
4. Click **Install**, then enable **FA Nexus** in your world.

---

## Getting Started
1. Launch a world in Foundry v14 and enable FA Nexus.
2. Click the **FA Nexus** button above the player list to open the window.
3. Pick a tab (`Tokens`, `Assets`, and more if unlocked) and start browsing.
4. Use the search bar, folder filters, and bookmarks to home in on what you need.
5. Click an item, or multi-select several, and start placing.
6. Visit **Module Settings -> FA Nexus** to toggle pixel-perfect tile selection, elevation behavior, cache paths, shadow quality, generated cleanup, and more.

Patreon supporter? Connect Patreon inside the app. Premium unlocks the premium Tokens, Assets, and Token Color variants; Pro also unlocks Texture Painting, Paths, and the Building Tool.

---

## Requirements & Compatibility
- **Foundry VTT:** v14 only. FA Nexus 0.5 and later do not run on Foundry v13.
- **Token system mappings:** Updated actor type mappings include Call of Cthulhu 7th Edition, Cyberpunk RED, Alien RPG, Forbidden Lands, Starfinder, World of Darkness 5th Edition/VTM5e, and Daggerheart.
- **Internet connection:** Needed for cloud content and Patreon validation.
- **Patreon Premium tier or higher:** Required for premium Tokens and Assets.
- **Patreon Pro tier:** Required for the Pro tools: Texture Painting, Tile Masking, Paths, and the Building Tool.
- **The Forge:** FA Nexus works on The Forge, but mapmaking there is slow. Every asset Nexus places, and every Flatten picture, Texture mask, and Prefab it makes, is uploaded to your Forge Assets Library, and those uploads take a long time. We recommend building maps in a local Foundry installation and moving the finished world to The Forge. If you build on The Forge, turn on **Use Direct URLs for Free Cloud Content** in the module settings: free assets then load from the FA cloud without being uploaded. Premium assets and generated files are still uploaded.

---

Spotted a bug or have a feature request? Open an issue on [GitHub](https://github.com/Forgotten-Adventures/FA-Nexus/issues) or join us on the [Forgotten Adventures Discord](https://discord.gg/forgottenadventures).

**Made with ❤ by the Forgotten Adventures team.**
