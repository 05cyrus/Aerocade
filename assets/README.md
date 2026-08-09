# Source assets

Authoring material, not shipped output. Nothing in this folder is loaded by the game at
run time.

| Item                      | Used for                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.png` (6 weapon plates) | Reference for the procedural weapon art in `textures.ts`. Drawn from, never loaded — see [docs/character.md](../docs/character.md).                                           |
| `Free Sounds Pack/`       | Source recordings for the 7 baked weapon clips in `packages/client/public/sfx/`. **Git-ignored** (65 MB of WAVs, and third-party material this repo should not redistribute). |

## Re-baking the audio

```sh
cd packages/client && npm run audio
```

Needs `ffmpeg` and the sample pack present. The baked `public/sfx/*.m4a` files and the
generated `sample-manifest.ts` are **committed**, so an ordinary build and an ordinary
clone need neither. Only re-run this when the sound design changes.

Currently baked: the **7 weapon firing sounds** (30.6 KB total). Every other sound still comes
from the procedural synthesis in `sfx.ts`, and `SfxId.JetLoop` is excluded permanently — a lossy
codec cannot loop seamlessly, and AAC's frame padding turns the jetpack loop into an audible tick
roughly every 1.1 s (ADR-030).

The bake fails rather than shipping a bad clip: it rejects anything not mono, anything with more
than 10 ms of leading silence (a gun that fires late), and anything whose loud part outlasts its
weapon's fire interval (which smears at full auto).

## Licensing

**The terms are not on disk.** Verified, not assumed:

- The folder holds exactly 50 `.wav` files and nothing else — no licence, EULA, readme or
  attribution file came with it.
- All 50 carry no embedded rights metadata at all: `ffprobe` shows empty format tags, and at
  the byte level every file is `RIFF`/`WAVE`/`fmt `/`data` with no `LIST`, `bext` or `iXML`
  chunk to hold a copyright string.
- Timestamps (original 2023–2024 mtimes, one identical ctime) say this arrived as a single
  archive extraction; the archive itself is no longer on the machine.

"A free pack from Fab" is how it was described to this project — it is **not** corroborated by
anything in the files. The absence of a licence file is not evidence of permissive terms; it
means the terms are simply absent.

Before distributing a build publicly, retrieve the pack's actual licence text from wherever it
was downloaded, archive it here, and confirm from that document that it permits (a) modified
derivatives and (b) redistribution inside a game build, plus any attribution string it
requires. The committed `.m4a` files are trimmed, pitched and filtered derivatives — which most
royalty-free terms allow and some attribution-required terms allow only with credit.

If the terms turn out to be unsuitable, the fallback is already in place and complete:
delete `packages/client/public/sfx/`, reset `sample-manifest.ts` to an empty manifest, and
every sound reverts to the procedural synthesis in `sfx.ts` with no other code change. That
is deliberate — see ADR-030.
