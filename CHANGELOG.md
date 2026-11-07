# Change Log

All notable changes to this project will be documented in this file.

## [0.6.2] - 2026-11-07

Compared with 0.5.3.

### Added
- **Rebuilt Building Tool:**
    - The Building Tool has been rebuilt.
    - Tool Options are organized into workspaces: Outer Walls, Inner Walls, Portals, Fill Textures, and Edit Geometry.
    - With Staged placement switched on (Shift+E), a new outer shape is held before it is accepted, so it can be moved, resized, rotated, or point-edited first. With the new Room Construction switch on, a shape added onto the Building keeps a wall along its edge and becomes a room of its own instead of merging into the existing outline; "Inner Only" adds room walls inside the outline without enlarging it, and Subtract trims the inner walls it cuts.
    - Inner Walls and the new Fill Dividers can be drawn as smooth splines as well as poly-lines, and can be split, joined, and converted between straight and curved segments. Sticky Joints keep connected walls together while one of them is reshaped.
    - Fill is managed per room: each enclosed room can take its own texture, scale, rotation, offset, opacity, and color, or follow the Building's Fill.
    - Portals add Seamless Secret Doors, which look like the wall they are cut from, alongside Doors, Windows, and Openings. A portal can be converted to another kind, fitted to its artwork's width, and given its own behavior, sound, timing, and initial state.
    - Wall behavior can be set with the Solid, Terrain, Invisible, and Ethereal presets or a custom combination, for the whole Building, one wall path, or single segments.
    - Edit Shapes is now Edit Geometry, which moves the vertices and curve handles of the committed shape.
    - Commit writes the Walls, Fill, and Sills as separate named Tiles (for example "Ground Floor - Building 1 - Walls") instead of 0.5.3's combined foreground and background Tiles. A Commit that fails leaves the Building as it was and says why.
    - Closing FA Nexus or opening another tab while a Building has unsaved changes asks: Commit, Discard, or Continue Editing. When a staged shape or a Commit in progress stops the way out, a message says why.
    - Buildings made with 0.5.3 open in the new editor. They are left untouched until a change is committed, which upgrades them. A 0.5.3 Building the new editor cannot rebuild exactly (rotated, resized, missing its Walls, or in a Scene Group) is left as it is, and Nexus Edit says why in plain words.

- **Moving, Rotating, and Scaling Every Nexus Layer:**
    - Every FA Nexus layer (Buildings, Paths, Scatter, Textures, and flattened sections) can now be moved, rotated, and scaled with Foundry's own Tile tools and in Scene Groups, and keeps working afterwards: Nexus Edit reopens a moved, rotated, or scaled Building, Path, Texture, or Scatter where it now is. 0.5.3 hid the rotate and resize handles for Buildings, Paths, Scatter, and masked flattened sections, and moving a Building moved only its Tile.
    - A Building moved or rotated with Foundry's tools, a 0.5.3 Building included, takes its Fill, door and window frames, Inner Walls, Foundry Walls, and Region with it; in 0.5.3 only its Tile moved. It stays on the grid: it snaps by its walls and turns about the nearest grid corner or square center, so a quarter turn keeps its walls on grid lines.
    - A Path takes its texture, shadows, and Foundry Walls with it. It snaps by the points it was drawn with and turns about the nearest grid corner or square center.
    - Scatter Tiles keep their instances, shadows, and color adjustments, also after a reload and in Nexus Edit.
    - A Building's Tile sheet no longer changes Scale X/Y or Image; it says where to do it instead (Scene Groups' Flip Horizontally / Flip Vertically, or Outer Walls in the Building editor).
    - A Building, Path, or flattened section is saved in steps after a move or turn. A new move or turn started before that has finished is refused with a message ("This Building is still saving its last change. Try again in a moment."); on a slow host such as The Forge, quick edits one after another could leave a Building broken until it settled.

- **Scene Groups:**
    - Added a dedicated Scene Groups window for creating live groups from selected Tiles, Walls, Lights, Sounds, and Regions.
    - Groups can be renamed, nested, reparented, collapsed, hidden, locked, ungrouped, or deleted while normal Foundry interaction remains available for individual members.
    - Selected groups can be moved, rotated, and uniformly scaled directly on the canvas with a live preview, snapping, an adjustable pivot, and one Undo step for each change.
    - Layer Manager rows can select either an individual member, its direct group, or its root group.
    - Scene Groups can be switched off with the world setting "Enable Scene Groups". Switched off, the Scene Groups window, its button and the selection mode are gone, every layer is selected on its own, and Prefabs are off as well. Groups already in a Scene are kept. Copy and paste of Buildings and Paths keeps working.

- **Prefabs (Experimental):**
    - Prefabs are marked experimental (a note in their tab) and can be switched off with the world setting "Enable Prefabs (Experimental)". They need Scene Groups.
    - Added a Prefabs tab and a local Prefab library that is shared by every world of the installation. One or more Scene Groups are saved as a Prefab by dragging them into the tab or with "Save as Prefab…" in the group's menu.
    - A Prefab keeps its Tiles, Walls, Lights, Sounds, and Regions together with their grouping. Buildings, Paths, Textures, and Scatter inside it stay editable after it is placed.
    - Clicking a Prefab stages it on the canvas, where it can be moved, resized, rotated, and mirrored, with grid snapping and a choice between its original pixel size and the size that matches the Scene's grid. Accept creates everything as one Undo step; Cancel writes nothing.
    - Prefabs can be placed into Scenes with another grid size and onto another Level, renamed, deleted, and exchanged as files with Export Prefab and Import Prefab. "Prepare required assets" fetches the artwork a Prefab needs before it is placed.
    - Copy and paste and Duplicate for Scene Groups use the same staged placement, also across Levels and Scenes.
    - The Prefab library, Import Prefab, and saving a group whose artwork FA Nexus generated (a flattened picture or a mask) also work with The Forge's Assets Library.

- **Layer Manager Folders:**
    - Added Folders inside elevation groups for organizing dense Tile stacks without changing any Tile's Elevation.
    - Folders can wrap the current selection, contain nested folders, and be renamed, collapsed, reordered, hidden, locked, removed, flattened, or promoted to their own elevation.
    - Preview rows of active Asset, Scatter, Path, Texture, and Building sessions can also be placed into folders before commit.

- **Feature Area Controls:**
    - Added separate world settings for enabling the Tokens and Mapmaking workspaces, including token-only and mapmaking-only setups. [Issue #52](https://github.com/Forgotten-Adventures/FA-Nexus/issues/52)
    - A switched-off area does not load its tabs or canvas tools when the world starts.
    - With Mapmaking switched off, a map made with the mapmaking tools is not drawn as it was saved. The setting says so, and the Gamemaster is told once for each Scene that has such layers. The Scene itself is not changed.

- **Level Membership for New Layers:**
    - Added a "New layers appear on" world setting. "Every Level" (the default) keeps the existing behavior: a layer made with the FA Nexus tools is shown from every Level, so an upper storey shows the storey below. "Only their own Level" gives new Assets, Scatter, Textures, Paths, and Buildings Foundry's own Level membership for the Level they are placed on, so they are drawn there only.
    - The setting applies to new layers. Existing layers keep their membership until it is changed in their Tile configuration.
    - The setting is listed in the Mapmaking section of the FA Nexus settings.
    - When a layer is moved in the Layer Manager to an Elevation of another Level, a layer that belongs only to its own Level moves to that Level, and a layer shown on every Level stays on every Level.

- **Path Wall Behavior:**
    - Paths with "Foundry Walls" can now choose what those Walls block: Solid, Terrain, Invisible, or Ethereal, using the same presets as Building walls. An Invisible fence or railing blocks movement and lets sight, light, and sound through.
    - The choice is saved with each Path and can be changed later through Nexus Edit.

### Changed
- **Flatten:**
    - Flattening a selection now keeps ground, middle, and foreground apart, one picture each, as the split option of Flatten Level already could. Before, a selection became one Tile, which baked a Building's floor and walls together.
    - Selecting any part of a Building or Path for Flatten includes all of it.
    - A Scene Group selected with Direct Group or Root Group selection counts for Flatten: its visible Tiles, those of its nested groups included, are flattened. Its Walls and other non-Tile members are left as they are.
    - Deconstruct now also works after a flattened Tile was rotated or resized; 0.5.3 asked to reset its size and rotation first. Everything comes back at the section's current position, rotation, and size, together with the Scene Groups and Layer Manager Folders it held. Flattened Tiles with a mask can now be resized too, and their masks follow.
    - The pictures of a flattened section, with the Walls, doors, and Regions it keeps, move, rotate, and scale as one, and are deleted with one question and one Undo step. A section that holds Foundry Walls snaps by a wall end and turns about the nearest grid corner or square center.
    - A resize or rotation a flattened Tile cannot follow exactly is refused before anything changes, with a message.
    - The Deconstruct question now says how many pictures the section has, that their files stay on disk, and that Generated Cleanup lists flattened files no Scene uses any more.
    - "Nexus Edit" is no longer offered for a flattened picture, which has no editor of its own; the menu says so and points to Apply Mask and Deconstruct.
    - Flatten and export do not start while an editing session or a staged Prefab placement is open, and say so.
    - Deleting a masked or flattened Tile now marks its generated files for Generated Cleanup.

- **Cross-Level Door Proxies:**
    - Door and window artwork from other Levels, which FA Nexus shows through openings, now takes elevated sight and opaque floors into account before it is drawn. It can be switched off with the world setting "Cross-Level Door Proxies (Experimental)" (on by default). [Issue #57](https://github.com/Forgotten-Adventures/FA-Nexus/issues/57)

- **Foundry-Native Behavior:**
    - Removed the FA Nexus Token Eye Level override, its Token Config control, and the world setting "Overwrite Token Eye Level"; token vision uses Foundry's own behavior. [Issue #56](https://github.com/Forgotten-Adventures/FA-Nexus/issues/56)
    - FA Nexus no longer replaces Foundry's texture loading or its Region refresh.
    - Picking Tiles on the canvas while the Layer Manager is in use follows Foundry's own Foreground switch again. 0.5.3 let background and foreground Tiles be picked together whatever that switch was set to.
    - Configure Settings has a new section, "Changes to Foundry behaviour". It holds the existing switches for near-ground tiles under tokens and pixel-perfect tile selection, the new Cross-Level Door Proxies switch, and two new switches: "Wait for Nexus layers when a Scene is drawn" and "Overlay and Soft Light blend modes". All are on by default; switch one off if it gets in the way of a system or another module.

- **Editor Sessions:**
    - Closing the FA Nexus window during a Texture or Path session now saves the session; in 0.5.3 the work was lost. If the save fails, the window stays open and says why.
    - Switching Scenes is refused while an editor session holds uncommitted work.
    - Keys typed into a search box, name field, or number box, including Escape, are no longer passed to the active editor.
    - Escape or Cancel in a Scatter session now asks the same question as the other editors ("Discard the current scatter edits?" with Discard and Keep Editing), and the button that saves an edited Scatter is called Commit, as in the other editors, instead of Apply.
    - Cancel and Escape in the Path editor wait while a Commit is still saving ("This Path is still being saved. Wait until it has finished."); on a slow host they could remove the Path's Foundry Walls.

- **Deleting Buildings and Paths:**
    - Deleting a Building or Path, with the Delete key or from the Layer Manager, asks once and removes its generated parts with it; one Ctrl+Z brings all of it back.

- **Asset Editing:**
    - Nexus Edit on a placed Asset now updates its Tile in place instead of replacing it, keeping its Scene Group membership, opacity, hidden and locked state, and data from other modules, with a single Undo step.

- **Premium Editors:**
    - The Path, Texture, and Building editors now carry the number of the FA Nexus release they belong to (0.6.2) instead of their own numbers (0.5.3 used Path `0.0.101`, Texture `0.0.87`, and Building `0.0.111`). Building editor `0.0.111` is replaced by the rebuilt Building Tool.
    - The rebuilt Building Tool drops these 0.5.3 controls: the disabled "Freehand Lasso (Coming soon)", Wall Tension, Show Width Tangents, and Fill scale/rotation randomization.

- **Patreon Premium and Pro Tiers:**
    - Follows Forgotten Adventures' Patreon split of 2026-10-26. The Premium tier unlocks premium Tokens and Assets; the Pro tier adds the Pro tools: Texture Painting, Tile Masking, Paths, and the Building Tool. Nexus now calls them Pro tools.
    - Premium cards unlock only for an active (or payment-declined) paid tier. A connected Free member now sees them locked, and a click explains that the tier doesn't include premium downloads. Files already downloaded stay usable.
    - A member whose tier doesn't include the Pro tools gets a clear Pro message when starting a tool, and the Textures, Paths, and Building tabs then show a notice with an upgrade link. A member who downgrades while an editor is open keeps the editor and stays connected. Nexus Edit on a Building, Path or Texture without the Pro tools says so in those words instead of reporting a missing Patreon state.

### Fixed
- **The Forge and Hosted Storage:**
    - On The Forge, the Path, Texture, and Building editors now follow the Tool Options you see: Snap to Grid, snap density, F1 Help, Asset Shadows, mask reloading, and Layer Manager previews no longer act on a hidden second copy of FA Nexus.
    - On The Forge, Flatten and Export no longer stop with "Unable to check existing outputs" when FA Nexus can't read your Forge account ID (EU servers); Forge storage is used directly. [Issue #60](https://github.com/Forgotten-Adventures/FA-Nexus/issues/60)
    - A cloud Token or Asset that Foundry fails to store is no longer placed from a guessed path; FA Nexus says it could not store the file.
    - On The Forge, Buildings and shadowed Assets no longer log a shadow error while their artwork is still loading from Forge's servers.

- **Texture Painting & Tile Masking:**
    - Resizing a masked Texture Tile with Foundry's handles now scales its texture with the Tile, as the resize preview shows; before, the texture went back to its old size inside the resized mask on release.
    - Reopening a moved, rotated, or resized Texture or Mask Tile now keeps its position, size, rotation, flips, and texture scale, rotation, and offset.
    - Painting or drawing a shape past the edge of an existing Texture layer or Tile mask now grows the mask instead of being cut off at its old edge.
    - Copied and pasted masked Tiles now draw correctly in Foundry v14.
    - Color adjustments on FA Nexus layers are no longer lost when a layer redraws.
    - Saving a painted Texture or a Tile mask now shows one confirmation instead of also showing Foundry's upload message with the generated file name, and a mask upload that fails stops the save with an error.
    - Redo after erasing part of a new Tile mask no longer hides the whole Tile and no longer saves an empty mask.
    - A new Texture layer can no longer be committed before anything is painted; before, changing an option such as Elevation was enough, and Commit made an empty Tile the size of the Scene.
    - After Nexus Edit on a Texture layer, clicks and the hiding of Tokens beneath it follow its new artwork at once; before, that needed a Scene reload.

- **Paths:**
    - Quick HSBC in the Tile sheet now says when a tile has several paths, and that saving it replaces the colour adjustments of the individual paths.
    - A Path dragged with Foundry's Tiles tool now takes its Foundry Walls with it; before, the Walls stayed where the Path was drawn.
    - Dragging Path points no longer stutters.
    - Foundry Walls created by a Path now belong to the Level the Path is drawn on, so a fence on one floor no longer blocks the floors above and below.
    - Editing a Path again now replaces its previous Walls instead of leaving them behind, and Undo no longer leaves a Path and its Walls out of step.
    - Commit followed at once by a tab switch no longer saves a Path twice.
    - Cancelling a Path edit in which a path was reshaped and then split or deleted no longer removes that Path's Foundry Walls.
    - A Path's Tension set back to 0 in an edit is now saved; before, the path kept its previous Tension.
    - Undo in the Path editor and splitting a path now keep the path's color adjustments.
    - "Shadow only" set for one path of a Tile with several paths now hides that path's artwork after Commit.
    - A closed Path no longer gets a tiny extra Wall at its first point, and a two-point Path with Close Loop on no longer gets Walls on top of each other.

- **Asset Placement, Scatter & Shadows:**
    - Editing an existing asset, Path or Texture with Nexus Edit no longer changes the settings for new ones: the next new layer started with the edited layer's scale, rotation, flips and shadow, whether the edit was committed or cancelled. Brush, density and spacing settings are still remembered.
    - Placements made in quick succession no longer get in each other's way, and an Asset edit that fails leaves the Tile as it was.
    - Flatten waits for Asset shadows to finish drawing, so the picture matches what is on screen.
    - An Asset standing off the grid is no longer snapped to the grid when its edit is saved without moving it.
    - Cancel now discards Scatter edits, and a stroke redone during a Scatter edit is kept when it is committed.
    - Erasing every instance while editing a Scatter no longer deletes its Tile at once: Undo and Cancel keep working, and Commit deletes the Tile as a step Foundry's Undo can take back.
    - A drop shadow switched on in the Tile configuration can be undone, and saving an unchanged Tile configuration no longer rewrites shadows.

- **Layer Manager:**
    - An Elevation range typed with the larger number first no longer makes every tile unselectable; the range lies between the two numbers.
    - A preview row moved in the Layer Manager during Nexus Edit is now saved at its new place on Commit, also when nothing else was changed.
    - Moving or reordering layers in the Layer Manager keeps the selection and the scroll position.
    - Hiding a layer in the Layer Manager can be undone with Ctrl+Z.
    - A Layer Manager menu action that fails now says why.

- **Flatten, Deconstruct & Generated Cleanup:**
    - Flatten, Deconstruct and Export now end with one message that counts what was done ("Flattened 4 layers into 2 pictures.", "Restored 4 layers.", "Level export complete. 2 pictures saved to <folder>.") instead of a Foundry upload message for every file.
    - The Flatten / Export Level dialog now counts the tiles of the chosen scope. With "All scene levels" it names the visible layers that are in no picture, says what keeps each out (the Level that has its elevation does not show it, or is not its Parent Level) and what to change.
    - Fixed freezes when opening the Flatten dialog and when opening or using the FA Nexus tab of the Tile sheet.
    - A Deconstruct that fails partway now leaves the Scene as it was.
    - Deconstructing a section flattened with an earlier version now links every Building part back to its own Building: door frames, windows, Fills, inner walls and the Building's Foundry Walls could point at another restored Tile.
    - Flattened pictures are now written on the Scene's pixel grid, so they are no longer drawn slightly soft at 100% zoom.
    - Deconstruct now says when a mask painted on a flattened picture will be discarded.

- **Tokens:**
    - Placing a one-square token as a Tiny or Small Actor (a compendium creature or an Actor of the world) no longer turns the Actor into a Medium creature.

- **Window & Authentication State:**
    - Minimizing the FA Nexus window through the Foundry header no longer saves the minimized dimensions as the next expanded window size.
    - After connecting Patreon, the open tab unlocks its items at once, without switching tabs.
    - A premium download your Patreon tier doesn't include no longer disconnects Patreon; only an expired or invalid login does, and a missing premium file now says it isn't available.
    - Saving or closing a Tile's configuration right after it opens no longer shows an error in Foundry 14.370.
    - Opening FA Nexus again while its window is still closing no longer leaves an empty window.

- **Levels:**
    - Switching Levels works again in Foundry 14.370; before, FA Nexus kept the Level already in view. Earlier v14 builds still wait for Nexus layers when a Level is switched. [Issue #61](https://github.com/Forgotten-Adventures/FA-Nexus/issues/61)

- **Performance:**
    - Custom Tile artwork that is off screen is no longer drawn, and painted masks and Tile outlines use much less GPU memory.
    - Reduced per-frame work for shadows, wall occlusion, and Tile hover on Scenes with many custom Tiles.

- **Interface:**
    - A library tab with no source enabled now says so and names where sources are enabled, instead of "No results found".
    - The FA Nexus tab of the Tile sheet now says which Level's band a tile lies in when its Parent Level is another Level, and what to change, instead of calling a chosen Parent Level unresolved.
    - Tool Options section headings are readable with Foundry's light color scheme.
    - Escape now closes the color-variant panel without closing the FA Nexus window.
    - A search typed just before switching tabs is now kept for the tab it was typed in instead of being replaced by the other tab's search.
    - The Layer Manager's sidebar button now reads "Layer Manager" instead of "FA-NEXUS.LayerManager", and its eye buttons and the source checkboxes have names for tooltips and screen readers.

## [0.5.3] - 2026-06-09

### Added
- **Premium Feature Access Disclaimer:**
    - Added a premium feature disclaimer above the Texture Painting, Paths, and Building Tool grids for unauthenticated users, clarifying the Adventurer tier requirement and Patreon connection step.

### Fixed
- **Token Eye Level:**
    - The overwrite eye-level setting now uses a point 0.5 units below the top of the token cube instead of the exact cube top, avoiding ceiling-boundary line-of-sight edge cases.

- **Token Placement:**
    - Detached FA Nexus windows can now place uncached cloud tokens without handing Foundry the raw catalog path.
    - Cloud token previews and color-variant placement now wait for the resolved local or CDN image path instead of falling back to non-image folder data.

- **Cloud Asset Catalog:**
    - Clearing or reindexing the cloud asset cache now invalidates the shared asset catalog and warm cache, so asset grids refresh without stale cloud entries.
    - Foreground cloud asset loads now cancel stale background warmup work and seed the warm cache from the loaded records.

- **Exploration Image Canvas Crash:**
    - Hiding the viewed v14 level background now preserves Foundry's required background slot with a transparent texture, preventing fog/exploration visibility overlays from crashing canvas draw with `baseTexture` errors. [Issue #50](https://github.com/Forgotten-Adventures/FA-Nexus/issues/50)

- **Building Doors & Portals:**
    - Portal texture flips no longer try to sync native door meshes for inactive v14 levels.
    - Animated door and window proxies now use correct sort value, preventing bleeding over higher level backgrounds.

- **Layer Manager:**
    - Renamed v14 tiles now show their saved Tile Config name in the Layer Manager even when Foundry stores it on the tile source data, fixing flattened tiles and Door Frame layers falling back to generated filenames or asset names.

- **Flatten & Scene Export:**
    - Flatten/export output checks now treat missing generated data folders as empty folders with an overwrite-safety warning, instead of preventing the export.
    - Fixed some overly-strict metadata coupling that could prevent flattening in certain situations.
    - Fixed some noisy debug logs.
    - S3 flatten output paths now resolve through the configured bucket and endpoint, and saved flatten metadata is updated with the path Foundry actually returns.

## [0.5.2] - 2026-05-22

### Added
- **Building Tool Portal Texture Flips:**
    - Door and window portal textures now have separate `Flip Horizontal` and `Flip Vertical` controls.

### Changed
- **Scatter Rendering Performance:**
    - Large scatter tiles now use cached single or chunked render textures instead of keeping every scatter stamp live all the time.
    - Scatter tiles now refresh visible live sprites while panning and zooming, reducing canvas work while preserving interaction and pixel selection behavior.
    - Scatter shadow generation can reuse the runtime scatter cache and falls back to chunked shadow stamps when needed, improving heavy-scene stability and reducing redundant shadow rendering.
    - Scatter overhead proxies now filter at the container level to reduce overhead rendering work.

- **Building Composite Tiles:**
    - Building window sills are now managed as their own linked composite tile instead of being folded into the background composite.

### Fixed
- Premium editor loading after update
- Cached token records with stale display names, creature sizes, creature types, or grid dimensions now correct themselves more reliably during Nexus browsing.
- Building portal gap rendering now uses exact gap bounds instead of extra render bleed, reducing small over-cuts around generated door/window openings.
- Texture Painting previews now apply Texture Opacity to the texture content instead of the masked preview layer, so semi-transparent previews match committed masked tiles.
- Asset Placement & Scatter tool options panel no longer jumps to the top when adjsuting shadow offset & sliders

## [0.5.1] - 2026-05-07

This is the Foundry v14 transition release. FA Nexus now targets Foundry VTT v14 and is not backwards compatible with Foundry v13.

### Added
- **Foundry v14 Support:**
    - Updated FA Nexus for the current Foundry VTT v14 runtime, with compatibility work across Asset Placement, Tokens, Layer Manager, Paths, Texture Painting, Buildings, flatten/deconstruct workflows, scene transitions, detached windows, and level-aware tile ordering.
    - FA Nexus tools now understand v14 scene levels, keep tile ordering predictable, preserve important v14 tile data, and behave more reliably in Levels-style scenes.

- **Tile Masking:**
    - Compatible tiles can now be masked with FA Nexus through the premium Texture Painting editor, bringing mask editing beyond texture-painting output and letting you remove parts of a tile image directly.
    - The Tile HUD can now open FA Nexus mask editing for compatible tiles.
    - Added FA Nexus mask clearing from Tile Config and Layer Manager context actions.

- **Shadow Only Mode:**
    - Added a `Shadow Only` option to Drop Shadow controls so placed or edited tiles can keep their generated FA shadow while hiding the source artwork.
    - Shadow-only tiles are also marked in Layer Manager so they are easy to identify after placement, including through searches for `shadow`.

- **Composite Building Tiles & Regions:**
    - Building commits now produce foreground/background composite tiles instead of separate tiles for every generated building element.
    - Outer and inner walls, portal frames, and static windows are combined into a foreground tile, while fills and window sills are combined into a background tile.
    - Disconnected building islands are kept separate, so one committed building can still produce clean per-island background and foreground output.
    - Building commits now create Foundry Regions from generated outer walls when region geometry is available, with predefined `Define Surface` and `Suppress Weather` behaviors.

- **Level-aware Flatten & Scene Export:**
    - Flatten and scene export can now target the current viewed level or all scene levels.
    - The dialog now makes the action explicit: flatten into scene tiles or export image files.
    - Outputs can be split into level background, middle, and foreground images/tiles, with an option to merge middle elevations into the background or foreground output.
    - Flattened tiles track level membership more safely, so deconstructing them restores content to the intended level.

- **FA Nexus Tile Config Controls:** 
    - Added 'FA Nexus' tab to Tile Config with options for 'Parent Level', HSBC, clearing masks, and Shadow toggles/settings.
    - `Parent Level` tells FA Nexus which v14 level owns a tile when that tile is visible on multiple levels. FA Nexus uses it for level-aware Layer Manager grouping, ground/foreground band sorting, flatten/deconstruct behavior, and opening the tile on the intended level for editing.
    - Tiles that only belong to one level can usually leave `Parent Level` on `Auto / Unset`; FA Nexus auto-populates it based on which level the tile was placed.
    - Shadow settings in Tile Config now preview live before being applied.

- **Texture Painting Blend Modes:**
    - Texture Painting now supports blend modes for painted texture layers, including Normal, Overlay, Soft Light, Multiply, Screen, and Add.
    - Blend modes let texture work such as dirt, moss, water, scorch marks, highlights, and color passes blend into the scene underneath instead of only rendering as normal opaque texture layers.

- **Paths Improvements:**
    - All editable paths within a session have visible control points and throughline in 'Edit shapes' mode so you can identify which paths can be edited. The throughline hides while a control point is being moved so the edited path stays easier to see.
    - Control point visuals have also been adjusted for better visibility.
    - Older FA paths made before v0.3 now migrate to Paths v2 when used in v14, and the legacy path editor has been retired.

- **Grid Sorting:**
    - Asset, Token, Texture, Path, and Building Fill grids now include a persistent sort toggle for `Newest` or `Category` order.
    - The Solid Color texture remains pinned at the top of texture grids regardless of the active sort mode.

- **Layer Manager Level Actions:**
    - Current-level boundary markers in Layer Manager can now select all tiles in the viewed level band.
    - Right-clicking a current-level boundary marker toggles visibility for tiles outside the viewed level band, making level isolation faster while working in v14 scenes.

- **Token Eye Level Controls:**
    - Added an FA Nexus `Eye Level Height` field to Token Config vision settings for per-token v14 line-of-sight testing.
    - Added a world setting that can use a higher default eye level based on the top of a token's v14 Size Z cube instead of Foundry's mid-height default.
    - This helps avoid default midpoint eye-level cases where tokens at different elevations cannot see each other as expected.

### Changed
- **Keep Ground Props Under Tokens:** 
    - Reworked `Shift BG & Tile Elevation Down` into `Keep Ground Props Under Tokens`.
    - Tiles within the first 1 elevation unit of a level now stay under tokens on that same level without changing token elevation or shifting the level background and foreground planes.
    Example: on a level that starts at 10, tiles placed from 10.000 to 10.999 stay under tokens at elev 10. Normally tile even at 10.001 would be rendered above tokens.

- **Level-aware Placement and Editing:**
    - Asset Placement, Token Placement, Paths, Texture Painting, Buildings, and Building Fill now respect the currently viewed v14 level more consistently when starting sessions and committing tiles.
    - FA Nexus now blocks level switching while an Asset, Path, Texture, or Building session is active so previews and commits do not drift to a different level mid-session.
    - Editing FA Nexus tiles from the canvas or Layer Manager now switches to the tile's Parent Level when needed before opening the editor.

- **Token Placement:** 
    - Token placement now targets the currently viewed v14 level and uses that level's bottom elevation as the elevation of the placed token.
    - Token placement and prototype updates now set v14 Size Z/depth from the token footprint so large, huge, and gargantuan tokens get matching vertical size by default.
    - Actor type mappings were updated for Call of Cthulhu 7th Edition, Cyberpunk RED, Alien RPG, Forbidden Lands, Starfinder, World of Darkness 5th Edition/VTM5e, and Daggerheart.
    - Daggerheart actor creation now uses the system's expected actor type and applies token size after actor creation, so oversized FA tokens become the matching Daggerheart size.

- **Building Tool Portals:**
    - Door/window selection previews now show the selected portal, or the default portal when no specific portal is selected.
    - Portal texture pickers now use the shared Nexus grid with search, hover previews, better sizing, better performance, and clearer portal labels.
    - Door, window, frame, sill, and glass previews now size small and explicit grid-width portal textures more accurately.
    - Animated door/window portal visuals and shadows now stay in sync on visible non-current v14 levels.

- **Texture and Path Selection Feedback:**
    - Launching Texture Painting or Paths from an asset card now visibly selects the active card in the grid.
    - Changing the Solid Color texture swatch now updates the active Texture Painting session immediately instead of waiting for a new session.

- **Shadow Rendering:**
    - Drop-shadow rendering now chunks large shadow layers and keeps per-tile alpha/blur settings, improving stability and performance on heavy or roughened scenes.

- **Level-aware Layer Manager, Placement, and Editing:**
    - Level background/foreground markers are scoped to the current viewed level.
    - Each level gets dedicated `<level> Background` and `<level> Foreground` folders for tiles within the level's special ground/foreground bands; when a tile is visible on multiple levels, `Parent Level` decides which level owns those folders/bands.
    - 'Preview' layer of the current placement/premium editor session now appears in the expected position and can be drag-and-dropped to adjust current placement elevation and ordering.
    - Active Asset Placement, Scatter, Path, Texture Painting, Building, and Building Fill previews now appear as selectable Layer Manager rows; multi-preview rows such as Paths and Scatter are numbered.
    - Dragging tiles or preview rows through level-aware Layer Manager groups now updates elevation, sort order, placement level, and level membership together.
    - Tile context actions now include FA Nexus mask editing/clearing and Tile Config access where available.
    - Layer Manager preserves its scroll position during preview reordering and uses a single expand/collapse-all button for visible groups.
    - Selecting, toggling visibility, and locking multiple tiles is much more performant.

### Fixed
- Define Surface region changes now refresh Foundry's occlusion surfaces immediately.
- Building edit cleanup now more reliably removes linked generated walls, fills, and tiles without leaving orphaned tiles or duplicate delete noise.
- Building sessions now anchor fill elevation, placement level, and preview ordering from the selected tile or current viewed level more consistently.
- Committed masked textures now render correctly immediately after placement without requiring players looking at the placement spot to refresh the canvas.
- Expected auth probes, local-inventory checks, import repair messages, preview updates, rollback notes, and mask cleanup paths now log at lower severity so real errors are easier to spot.

### Technical Notes
- Texture rendering, mask handling, tile payload creation, level membership, scene transition readiness, and canvas readiness code were split into smaller internal modules to support the v14 runtime more reliably.
- Content source, Forge/S3 folder browsing, local inventory, and download path handling now fail more visibly when configuration or permissions are wrong, making setup problems easier to diagnose.

## [0.4.0] - 2026-04-08

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
