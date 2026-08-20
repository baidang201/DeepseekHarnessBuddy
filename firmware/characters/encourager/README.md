# encourager（程序员鼓励师占位角色包）

This is a **placeholder** character pack for the P2-C "程序员鼓励师" load-chain validation. The art is intentionally minimal — simple round stick figures in distinct colours and motions — so the firmware and tooling path can be exercised now, while the real anime assets are produced later.

## What is here

- `manifest.json` — same schema as `firmware/characters/bufo/manifest.json`.
- `sleep.gif`, `idle_*.gif`, `busy.gif`, `attention.gif`, `dizzy.gif`, `celebrate.gif`, `heart.gif` — 96x100 placeholder GIFs, all under 600 KB total.

## Replacing with real anime assets

1. **Prepare the final GIFs**
   - Target resolution: **96x100 pixels** (this is what the firmware expects).
   - Recommended frame counts per state:
     - `sleep`: 1 frame
     - `idle_*.gif`: 4–8 frames each (breathing / blinking variants)
     - `busy`: 2–8 frames
     - `attention`: 4–8 frames
     - `dizzy`: 4–10 frames
     - `celebrate`: 8–20 frames
     - `heart`: 7–15 frames
   - All GIFs should loop (`loop=0`).
   - Keep the whole pack at or below **600 KB** total.

2. **Drop them into this folder**
   - Replace each `.gif` here with your final asset, keeping the same filenames.
   - Update `manifest.json` only if you change filenames, colour values, or the number of idle variants. The schema is:
     ```json
     {
       "name": "encourager",
       "colors": { "body": "...", "bg": "...", "text": "...", "textDim": "...", "ink": "..." },
       "states": {
         "sleep": "sleep.gif",
         "idle": ["idle_0.gif", "idle_1.gif", "idle_2.gif", "idle_3.gif"],
         "busy": "busy.gif",
         "attention": "attention.gif",
         "dizzy": "dizzy.gif",
         "celebrate": "celebrate.gif",
         "heart": "heart.gif"
       }
     }
     ```

3. **Resize / prep helper (optional)**
   - If your source clips are larger or inconsistently cropped, run them through the existing prep tool:
     ```bash
     python3 firmware/tools/prep_character.py firmware/characters/encourager
     ```
   - It will re-crop, resize to 96x100, and rewrite `manifest.json` for you.

4. **Regenerate the placeholder art**
   - To rebuild these crude GIFs after editing colours or motion in the generator:
     ```bash
     python3 firmware/tools/gen_character_gif.py --placeholder \
         --out firmware/characters/encourager
     ```

5. **Validate before merging**
   ```bash
   python3 firmware/tools/validate_character.py firmware/characters/encourager
   ```
   It checks every manifest entry against the files, verifies 96x100, ensures GIFs are decodable, and confirms the total budget.

## How the placeholder was made

The `gen_character_gif.py` script drew the round stick figures using PIL, quantised every state to a shared adaptive palette with Floyd–Steinberg dithering, and wrote looping GIFs with `disposal=2` so frame updates are clean.

See `SUMMARY.md` in this folder for the per-state frame counts, sizes, and budget comparison against `bufo`.
