# The Player Character — locked design

This document is the **authoritative design for Aerocade's soldier**. The reference sheets
(turnaround, pose plan, expression sheet, gear sheet, weapon sheet, hero pose) supersede any
earlier description of the character, including the sci-fi read the rig shipped with. Every
frame the game draws — and any concept art produced later — must be recognizably the _same
character_: same proportions, same silhouette, same helmet, same face, same uniform, same gear.
Only pose, framing, action, held weapon, and environment may change.

## What "authoritative reference" means in this project

Aerocade ships **no image files**. All art is generated in code at boot into one atlas
([ADR-001](DECISIONS.md#adr-001-product-identity) originality,
[ADR-012](DECISIONS.md#adr-012-articulated-character-rig-drawn-from-a-single-atlas) one texture).
The reference sheets are therefore a **specification the drawing code must satisfy**, not assets
to import. They are not in the repo and must not be added to it — this file is the durable
record, and it is what a reviewer checks a rig change against.

The reference is labelled as an homage to a specific commercial title. ADR-001 allows being
_inspired by the feel_ of 2014–2018 jetpack arena shooters and forbids sharing assets or copying
an existing game's character. The design below is consequently specified in Aerocade's own terms
— a stocky chibi tactical soldier — and every shape is authored from scratch in
`textures.ts`. Do not reintroduce the other game's name into code comments, ADRs, or art notes.

## Silhouette and proportions

Proportions are expressed as fractions of **standing height H** (helmet crown → boot sole) so
they survive any change of render scale. The sim hull is `0.85 × 1.65 m`
([tuning.ts](../packages/shared/src/sim/tuning.ts)) = **27 × 53 px** at `PX_PER_M = 32`, so
H ≈ 52 px on screen and the rig's local pixel space runs crown ≈ −26 to soles ≈ +26.

Measure the **side** projection, not the turnaround's front view. The game only ever shows the
soldier from the side, so front-view shoulder width is the wrong number to chase — the relevant
width is chest _depth_, which is narrower. (An earlier draft of this table quoted shoulder width
and wrongly concluded the torso was ~30% too narrow.)

| Measure (side view)          | Reference | Was | As built | Frame            |
| ---------------------------- | --------: | --: | -------: | ---------------- |
| Head + helmet block (height) |    ~0.31H | 31% |      31% | 36×32, unchanged |
| Helmet depth                 |    ~0.33H | 31% |      35% | widened 32 → 36  |
| Torso, shoulder → belt       |    ~0.30H | 38% |      35% | 32×36            |
| Chest depth                  |    ~0.30H | 27% |      31% | widened 28 → 32  |
| Hip → boot sole              |    ~0.39H | 35% |    38.5% | leg 14×40        |

The existing rig was **already chibi in the right ballpark** — the head fraction was within a
percent of the reference, and what really diverged was _styling_. The skeleton needed only two
nudges: a slightly deeper chest and slightly longer legs, absorbed by moving `TORSO_Y` −2 → −3
and `HIP_Y` 9 → 7.2 so the figure still fills the 53 px hull exactly (crown −26.9, soles +26.0).

Non-negotiable silhouette traits: **stocky and short-limbed**; a wide domed helmet that hides
the skull entirely; a chest made visually deeper than it is wide by the vest; chunky boots wider
than the shins; and one continuous heavy outline around the whole figure so it reads against
both bright sky and dark terrain.

## Palette

Flat fills, minimal shading — at most one shadow tone per material, no gradients, no rim light.
Every part carries a **thick near-black outline**; that outline, not shading, is what makes the
character readable at gameplay size.

> The hex values below are **estimated by eye** from the reference palette strip — conversation
> images cannot be pixel-sampled. Treat them as the starting point; re-sample from the source art
> if exactness matters, and update this table rather than diverging in code.

| Role                       | Hex       | Constant      | Where it goes                                     |
| -------------------------- | --------- | ------------- | ------------------------------------------------- |
| Olive, mid                 | `#6b7040` | `OLIVE`       | uniform sleeves and trousers — the dominant color |
| Olive, shadow              | `#4a5230` | `OLIVE_SHADE` | undersides, back-facing surfaces, helmet shade    |
| Near-black (outline / ink) | `#23241d` | `INK`         | all outlines, face mask, vest body, gloves, boots |
| Gear dark                  | `#33352a` | `GEAR`        | knee/elbow pads, pouches — a step off ink         |
| Dark grey                  | `#3f3f3f` | `HARD_GREY`   | boot soles, belt buckle, pack vents               |
| Skin tan                   | `#f0c088` | `SKIN`        | eye band, exposed fingertips                      |
| Eye white                  | `#f2efe4` | `EYE_WHITE`   | the single visible eye                            |
| Team base (near-white)     | `#f2f4f8` | `TEAM_BASE`   | insignia and helmet pad only — takes player tint  |

Two values earn their keep. The ink is a **warm** near-black, replacing the old blue-black
`0x151b2e`; that one swap does most of the work of moving the character from sci-fi to military.
And boot soles are neutral **grey**, not another olive-dark: at a 20 px leg a near-black boot
under a near-black-outlined trouser merges into one shape, and the grey sole is what makes the
boot read as a boot.

Reference swatches not yet used anywhere: brown `#5a3f28` (grips, slings) and light grey
`#9a9a9a` (blade steel). Both belong to weapon art, which is still on the old palette — see
collision 4 below.

## Parts, mapped to atlas frames

Frames in [textures.ts](../packages/client/src/game/render/textures.ts). All are **side
projections**: one eye, one arm, and the four-pouch chest row seen edge-on as a stack. Each part
draws its ink silhouette first and insets the fills by `OUTLINE` (2 px at 2× authoring = 1 px on
screen), because that outline — not shading — is what makes a 16 px figure read.

| Frame              | Reference content                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Frames.Head`      | Domed helmet down over the ears, short brow brim, **square 4-dot accessory pad on the side**; eye band in skin tan with large white almond eyes, dark irises, angled angry brows; black balaclava over nose/mouth/jaw. **No visor. No antenna.** |
| `Frames.Torso`     | Olive jacket under a near-black tactical vest: **four chest pouches** in a row, buckle straps, belt at the waist                                                                                                                                 |
| `Frames.Leg`       | Olive trouser, **round dark knee pad with rivets**, black boot with lace hint and a treaded sole wider than the shin                                                                                                                             |
| `Frames.Arm`       | Olive sleeve, **round elbow pad**, black fingerless glove with skin fingertips                                                                                                                                                                   |
| `Frames.Jetpack`   | Olive pack body with two buckle straps and a side pouch — reading as the reference backpack — plus twin nozzles beneath (see below)                                                                                                              |
| `Frames.Insignia`  | The reference's three shoulder stripes on `TEAM_BASE`. **Stripes, not a solid block** — a filled patch this small reads as a glowing panel rather than cloth                                                                                     |
| `Frames.HelmetPad` | The helmet's square side pad on `TEAM_BASE`, overlaying the dark pad in `Frames.Head`. Its rivets stay ink so it reads as gear, not a lamp                                                                                                       |

Deliberately dropped from the reference: the helmet antenna and the cyan visor glint (not in the
reference), and the canteen/radio/first-aid/smoke items on the gear sheet — they are set dressing
that cannot resolve at 16 px and would only cost atlas space.

## Four places the reference collides with the game

These are real conflicts, not ambiguities. The first three are **settled and built**; the fourth
is open.

**1. Team tint vs. a locked olive uniform.** The rig used to `setTint` a near-white armor base
(`0xe8edfa`) per player from eight saturated `PLAYER_COLORS` — that is how you tell eight players
apart in a firefight. Phaser tint _multiplies_, so an olive base cannot take a cyan tint without
going muddy, and locking the uniform olive for everyone destroys player identification.
→ **Decision:** the uniform is olive and **untinted**. Player color moved to two small
near-white parts — the **shoulder insignia** and the **helmet side pad**, both shapes the
reference already puts on the character. Each is glued to its parent part through that part's
rotation, so they track head aim and torso lean instead of sliding off.

Two attempts were needed. A team-colored **band across the brow** looked exactly like the visor
this design removed, and a patch at mid-chest read as a glowing panel. The lesson is general: on
a 16 px figure a saturated fill anywhere near the eyeline or chest centre reads as sci-fi tech,
so team color belongs on small, rivet-broken gear shapes off the centre line.

**2. Backpack vs. jetpack.** The reference wears a rucksack; Aerocade is a _jetpack_ arena
shooter and the plume emits from pack nozzles.
→ **Decision:** one part, styled as the reference's olive buckled pack with nozzles beneath. It
reads as a backpack standing still and as a thruster when it fires. There is no second back item,
and the pack art carries **no** warm glow — the amber plume is the particle emitter's job.

**3. Expressions cannot survive gameplay scale.** The head frame is authored at 2× and drawn at
`RIG_SCALE = 0.5` → **16 px on screen**. Eyes land at 2–3 px; six distinguishable emotions do
not exist at that size. Chasing them would waste atlas space and add nothing a player can see.
→ **Decision:** exactly one gameplay face is authored — the sheet's **FOCUSED/DETERMINED** brow,
which is what the hero pose and every pose on the plan sheet use. The expression sheet stays the
authority for UI portraits _if_ the project ever grows menu/scoreboard portraits (it has none
today; the HUD is React DOM with no character art).

**4. The weapon sheet is real-world firearms — and the guns are still off-palette.** The
reference guns are recognizable products (M4-pattern carbine, MP5, AWP-style sniper, LAW tube).
ADR-001 rules that out, and the roster is seven _original_ weapons.
→ **Open.** The seven weapon frames still use the old blue-slate `GUNMETAL` with cyan accents,
which now visibly clashes with the olive soldier holding them — it is the most off-model thing in
any gameplay frame. The fix is a palette pass, **not** new silhouettes: adopt the reference's
rendering language (thick ink outline, flat neutral gunmetal, one highlight, brown grips, muzzle
pointing right) and keep Aerocade's own shapes. The reference sheet is a size/heft guide only:

| Roster weapon                       | Reference heft |
| ----------------------------------- | -------------- |
| Rivet Pistol                        | pistol         |
| Vortex SMG                          | compact SMG    |
| Pulse Rifle                         | carbine        |
| Scattergun                          | pump shotgun   |
| Longbolt Rifle                      | scoped rifle   |
| Thumper                             | launcher       |
| Lobber                              | shoulder tube  |
| Frag (consumable, `Frames.Grenade`) | grenade        |

## Poses

The pose plan sheet maps onto the rig's actual states. The rig is **procedurally posed**, not
frame-animated — legs swing on `sin(runPhase)` advanced by distance moved, the arm tracks aim —
so each sheet entry becomes tuning, not a new sprite.

| Sheet section               | Rig state                                  | Status                             |
| --------------------------- | ------------------------------------------ | ---------------------------------- |
| Standing / idle             | grounded, `speed ≤ 0.5` — `LEG_IDLE_SPLAY` | exists                             |
| Moving / running (4 frames) | grounded run cycle, torso lean, run bob    | exists                             |
| Crouch idle / walk / shoot  | —                                          | **no crouch in the sim**           |
| Melee attack 1–3            | —                                          | **no melee in the roster**         |
| Front / back turnaround     | —                                          | N/A: side-scroller, side view only |

Two honest gaps: crouching and melee are on the reference sheet but **do not exist in the
simulation**, and art cannot add them — they would need sim state (a crouch hull, a melee
weapon). Treat those sheet sections as forward-looking, not as a spec the renderer is currently
failing. Conversely the front/back/¾ turnaround views will never be drawn: the game is a
side-scroller and the rig mirrors on `scaleX = ±1`. They are identity references for the artist,
not frames to produce.

One fidelity gap the renderer _could_ close: the reference grips every long gun with **two
hands**, and the rig has a single arm. A second arm on the foregrip is one more sprite per rig
(9 → 10 parts, 80 sprites at 8 players). It costs display-list objects, **not** draw calls — same
atlas, same batch (ADR-012).

## Verifying a change

The rig has no unit tests — it is pure presentation, and pixel assertions would be brittle. Check
it the way this pass was checked, with the headless sandbox:

```bash
npm run dev                                                   # in one shell
node packages/client/scripts/screenshot-sandbox.mjs /tmp/shots # idle, run, jetpack, fire
```

Inspect the closeups magnified — detail at 16 px is invisible at 1×, and both bugs in collision 1
above were only obvious once blown up. Then confirm **both facings**: the rig mirrors on
`scaleX = ±1`, so anything positioned with new trigonometry can drift on one side only.

## The lock

Changes to any of these need an explicit design decision, not a drive-by commit:

- **Do not** alter proportions, silhouette, or the head-to-body ratio.
- **Do not** redesign the helmet, add a visor, or reintroduce the antenna.
- **Do not** replace the eyes-plus-balaclava face, or expose the mouth or full face.
- **Do not** change the uniform, vest, pack, gloves, boots, or pads, or add accessories.
- **Do not** introduce a saturated color beyond the two team-tinted parts.
- **Do not** tint the uniform, vest, helmet shell, or any part other than insignia and helmet pad.
- **Do not** add gradients, rim light, or a second shadow tone; flat fills and one heavy outline.
- **Do not** add image files. All of the above is drawn in `textures.ts` (ADR-001, ADR-012).

Any new art joins the **single atlas** — one texture per thing is a defect, not a style choice
([performance.md](performance.md)).
