# FA Nexus

![Foundry VTT v13](https://img.shields.io/badge/Foundry%20VTT-v13+-green)
![Version](https://img.shields.io/badge/version-0.1.0-orange)
![Status](https://img.shields.io/badge/status-Beta-yellow)

FA Nexus is the new all-in-one content hub for Forgotten Adventures inside Foundry VTT. It brings tokens, assets, premium texture tools, and path editing into a single streamlined window. Launch the app from the FA Nexus button above the player list and dive straight into the full catalog of free Forgotten Adventures content—no manual setup required.

> ⚠️ **Beta notice:** v0.1.0 is our first public release. Expect occasional rough edges, placeholder copy, and the odd gremlin. Please keep the feedback coming so we can polish the experience quickly.

<img width="2045" height="1187" alt="image" src="https://github.com/user-attachments/assets/fac89a77-4980-4854-b3e7-a34ed56bf6c1" />

---

## Highlights at a Glance
- **Day-one library access:** Instantly browse the full Forgotten Adventures free catalog alongside your local folders, with cloud downloads keeping their original structure.
- **Smarter discovery:** Weighted search, exclusive or negative terms, grouped queries, and bookmarkable folder filters help you build personal collections per tab.
- **Pixel-perfect selection:** Precise tile hit detection respects transparent areas.
- **Responsive placement:** Click-to-place with sticky mode, multi-select randomization, rotation/scale controls, grid snapping and more tuned for both tokens and assets.
- **Elevation based Drop Shadow:** Elevation-based drop shadows for assets, bring new depth to your scenes!
- **Lightning-fast grids:** One-time indexing, virtualized scrolling, hover previews, and a thumbnail size slider keep browsing fluid even on massive scenes.
- **Cloud + local harmony:** Cloud Downloads keep the full folder structure, smart de-duplication and high-quality cloud thumbnails for matched local files, local folders stay in sync with folder filters & bookmarks.
- **Premium unlocks:** Subscribers at Adventurer ($7) or higher get access to Premium Tokens & Assets as well as texture painting and path editors, plus future premium features.
- **Texture painting studio *(Adventurer tier $7+)*:** Premium supporters unlock brush and fill tools with live transforms for rapid terrain blending.
- **Path editor toolkit *(Adventurer tier $7+)*:** Build splines with per-point width, texture flips/offsets, and feathered fades once authenticated.

---

## Smart Search, Folders, and Bookmarks
- **Weighted matching:** Nexus boosts likely hits so “fir” gives you fir trees before fireballs.
- **Exact and negative terms:** Wrap a term in quotes to match exactly like `"orc"`, or prefix with `-` to hide unwanted results. Combine statements with parentheses for more complex filters.
- **Docked folder filters:** See and filter by our Folder Structure. Pick inclusion and exclusion folders with multi-select.
- **Bookmark anything:** Save your favorite combinations of search terms and folder filters for Tokens, Assets, Textures, or Paths. Bookmarks show in a toolbar, overflow gracefully, and can be dragged to reorder.
- **Search memory:** Each tab remembers its last query and folder state, so hopping between views doesn’t wipe your work.

---

## Tokens Tab
- **Click-to-place workflow:** Click once to start placement, then drop tokens directly onto the canvas. Sticky mode keeps the placement cursor active for batch drops.
- **Multi-select randomizer:** Select several tokens and let Nexus randomize which one lands next.
- **Radom Color on Placement:** Randomize colors of selected Token(s) on drop.
- **Place Token As:** Choose an existing actor from your world or compendium to place token as that actor.
- **Hit point presets:** Use the actor default, roll a formula, apply a percentage, add a ±variance, or enter a custom value—even per placement session.
- **Grid savvy:** Snap to grid, rotate, mirror, or randomize facing before every drop.
- **Super Wildcards:** Combination of the systems above allow you to essentially havea "super" wildcard placement. e.g. Multiselect All our NPCs, Activate "Random Color on Placement", choose "Commoner" statblock as "Place Token As" , activate random rotation and flip & start placing!  You'll get a random NPC with random color and random rotation with each click!

---

## Assets Tab
- **Same placement magic:** Sticky mode, random rotation, mirroring, scaling, and grid snapping work just like the Tokens tab—plus randomized scale offsets for organic placement.
- **Elevation on the fly:** Hold `Alt` + scroll to bump placement elevation by 0.1 increments. Decimal elevations keep assets layered without jumping ahead of tokens (override in settings if you prefer Foundry defaults).
- **Shadow presets per elevation:** Customize drop shadow alpha, blur, dilation, angle, and distance for each elevation level. Save up to five presets and reapply them with a click.
- **Multi-select randomizer:** Select several assets and let Nexus randomize which one lands next. Combine with random rotation and scale!

---

## Premium Texture Painting *(Adventurer tier $7+)*
- **Brush-based painting:** Freehand grungy brushes with adjustable size & opacity.
- **Fill & mask tools:** Flood fill, rectangle, ellipse, polygonal lasso all support snap-to-grid for precise coverage.
- **Eraser mode**: Brush & fill tools support Eraser mode too.
- **Texture transforms:** Adjust opacity, scale, rotation, and UV offset mid-session without leaving the tool.
- **Texture swap:** Simply select a different texture from the main window to swap textures during editing.
- **Save as Tile**: Once you are happywith the masked texture, press S to save as Foundry Tile!

---

## Premium Path Editing *(Adventurer tier $7+)*
- **Make it curve:** Drop control points to form smooth curves, adjust tension, support snap to grid.
- **Path Texture controls:** Set scale, opacity, flip and offsets on the fly.
- **Feathered endings:** Taper opacity, shrink width on both ends independently for natural blends.
- **Per-point width control:** Pinch or bulge individual points for finer width adjustments.
- **Instant interactivity cleanup:** Cancel or stop sessions to release canvas locks and restore default tile interaction automatically.
- **Texture swap:** Simply select a different texture from the main window to swap textures during editing.
- **Save as Tile**: Once you are happywith the masked texture, press S to save as Foundry Tile!

---

## Quality of Life & Performance
- **One-time indexing:** On your first launch Nexus indexes cloud + local content, so later sessions pop open quickly.
- **Virtualized grids:** Only visible cards render, keeping framerates stable on massive libraries.
- **Placement prefetcher:** Random placement queues download ahead of time so you never drop an empty tile.
- **Edit existing textures & paths:** Right click the tile and select "Edit <tile> in FA Nexus" on the right side
- **Forge VTT compatible:** Works in Forge environments—testing is ongoing, so please report anything odd.
- **Offline awareness:** Cloud sync pauses politely when no connection is detected instead of spamming retries.

---

## Installation
1. Open **Add-on Modules** in Foundry VTT.
2. Click **Install Module**.
3. Paste the FA Nexus manifest URL:
   ```
   https://raw.githubusercontent.com/Forgotten-Adventures/FA-Nexus/main/module.json
   ```
4. Click **Install**, then enable **FA Nexus** in your world.

Prefer manual installs? Download the latest release ZIP from `https://github.com/Forgotten-Adventures/FA-Nexus`, unzip it into `FoundryVTT/Data/modules/`, and restart Foundry.

---

## Getting Started
1. Launch a world in Foundry v13+ and enable FA Nexus.
2. Click the **FA Nexus** button above the player list to open the window.
3. Pick a tab (Tokens, Assets, Textures, Paths) and start browsing.
4. Use the search bar, folder filter, and bookmarks to home in on what you need.
5. Click an item (or multi-select) and start placing!
6. Visit **Module Settings → FA Nexus** to toggle pixel-perfect tile selection, elevation behavior, cache paths, and more.

Premium supporter? Authenticate with Patreon inside the app to unlock texture painting, path editing, and premium catalog entries.

---

## Requirements & Compatibility
- **Foundry VTT:** v13 or later.
- **Systems tested:** (Needed for Tokens, limited testing atm) D&D 5e, Pathfinder 1e/2e, DSA5/The Dark Eye, Black Flag, Daggerheart 
- **Internet connection:** Needed for cloud content and Patreon validation.
- **Patreon Adventurer tier ($7+):** Required for premium textures, paths, and locked assets.

---

Spotted a bug or have a feature request? Open an issue on [GitHub](https://github.com/Forgotten-Adventures/FA-Nexus/issues) or join us on the [Forgotten Adventures Discord](https://discord.gg/forgottenadventures).

**Made with ❤ by the Forgotten Adventures team.**
