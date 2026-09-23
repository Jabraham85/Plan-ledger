# Can the brain revise itself? — results

Generated 2026-09-23T03:41:12.248Z from 3 rep(s). Hypotheses fixed beforehand in PREREG.md. Model: deepseek-v4-pro.
Spend: $0.291 actual; $0.145 at off-peak rates.

## Part C — code

| hypothesis | result | rule | verdict |
|---|---|---|---|
| R1 deterministic detection | exact in every rep | 100% edited-file findings, 0 others | **PASS** |
| R2 changed facts settled right | 12/12 (100%) | ≥ 90% | **PASS** |
| R3 false alarms cleared | 33/33 (100%) | ≥ 90% | **PASS** |
| R4 cascade (F7, F18) | 5/6 | ≥ 5/6 | **PASS** |
| R5 brain correct afterwards | 59/60 (98%) | ≥ 95% (no-TM baseline 70%) | **PASS** |

Changed facts and every miss:

| rep | fid | label | model verdict | final state | ok |
|---|---|---|---|---|---|
| r1 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r1 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r1 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r1 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r1 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r1 | F18 | change | revised | active (revised): the packaged board and the build boot-test use the same port (4319), so a running board can block the boot-tes | ✓ |
| r2 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r2 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r2 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r2 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r2 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r2 | F18 | change | revised | active (revised): the packaged board and the build boot-test use the same port, so a running board can block the boot-test | ✗ |
| r3 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r3 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r3 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r3 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r3 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r3 | F18 | change | revised | active (revised): the packaged board and the build boot-test use the same port (4319), so a running board can block the boot-tes | ✓ |

## Part S — stories


### frog — twist: "the princess is actually a frog" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s1a "the princess has long golden hair" | change | revised: "the princess has frog-like skin" ✓ | revised: "the princess has frog-like skin" ✓ | revised: "the princess has frog-like skin" ✓ |
| s1b "the princess wore a silk gown to the ball" | change | retracted ✓ | retracted ✓ | retracted ✓ |
| s1c "the princess's father is King Aldric" | keep | retracted ✗ | retracted ✗ | suspect ✗ |
| s1d "the princess has lived in the castle since birth" | either | revised: "the frog princess has lived in the castle since birth" | revised: "the princess has lived in the castle since becoming a frog" | revised: "the princess has lived in the castle since becoming a frog" |
| s1e "the princess danced with the prince until midnight" | change | active ✗ | active ✗ | active ✗ |
| s1f "the prince kissed her hand when they first met" | change | not flagged ✗ | not flagged ✗ | not flagged ✗ |
| s1g "the castle has four towers" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s1h "the kingdom has been at peace for ten years" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### heist — twist: "Marco is an undercover police officer" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s2a "Marco drove the getaway van" | keep | revised: "Marco drove the getaway van as part of an undercover police " ✗ | revised: "Marco drove the getaway van as part of an undercover police " ✗ | active ✓ |
| s2b "Marco is loyal to the crew" | change | revised: "Marco is not loyal to the crew" ✓ | revised: "Marco is not loyal to the crew" ✓ | retracted ✓ |
| s2c "the crew trusts Marco completely" | either | active | revised: "the crew does not trust Marco completely" | active |
| s2d "the heist went unnoticed by the police" | change | not flagged ✗ | not flagged ✗ | not flagged ✗ |
| s2e "Marco has a long criminal record" | either | revised: "Marco has a long criminal record as part of his undercover i" | revised: "Marco has a long criminal record as part of his undercover i" | revised: "Marco has a long criminal record as part of his undercover i" |
| s2f "the vault was on the third floor" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s2g "Marco recruited the safecracker, Ines" | keep | active ✓ | active ✓ | revised: "Marco, an undercover police officer, recruited the safecrack" ✗ |

### party — twist: "the party is on Sunday" (impact normal)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s3b "guests must arrive by 6pm on Saturday" | change | revised: "guests must arrive by 6pm on Sunday" ✓ | revised: "guests must arrive by 6pm on Sunday" ✓ | revised: "guests must arrive by 6pm on Sunday" ✓ |
| s3c "the caterer delivers the food on Saturday at 5pm" | change | revised: "the caterer delivers the food on Sunday at 5pm" ✓ | revised: "the caterer delivers the food on Sunday at 5pm" ✓ | revised: "the caterer delivers the food on Sunday at 5pm" ✓ |
| s3d "the party is held on the rooftop" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s3e "the band plays from 7pm to 11pm" | keep | suspect ✗ | suspect ✗ | active ✓ |

### wedding — twist: "the wedding is in Porto" (impact normal)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| hA2 "guests fly into Lisbon airport" | change | revised: "guests fly into Porto airport" ✓ | revised: "guests fly into Porto airport" ✓ | revised: "guests fly into Porto airport" ✓ |
| hA3 "the reception is at a hotel in central Lisbon" | change | revised: "the reception is at a hotel in central Porto" ✓ | active ✗ | revised: "the reception is at a hotel in central Porto" ✓ |
| hA4 "the ceremony starts at 4pm" | keep | suspect ✗ | suspect ✗ | suspect ✗ |
| hA5 "the bride wears a blue dress" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### allergy — twist: "Leo is severely allergic to peanuts" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| hB1 "Leo's favourite snack is peanut butter toast" | change | retracted ✓ | retracted ✓ | retracted ✓ |
| hB2 "Leo packs peanut cookies for school every day" | change | revised: "Leo does not pack peanut cookies for school every day" ✓ | revised: "Leo does not pack peanut cookies for school every day" ✓ | revised: "Leo does not pack peanut cookies for school every day" ✓ |
| hB3 "Leo is 9 years old" | keep | active ✓ | active ✓ | active ✓ |
| hB4 "Leo plays the violin" | keep | active ✓ | active ✓ | active ✓ |
| hB5 "Leo's older sister is Ana" | keep | active ✓ | active ✓ | active ✓ |
| hB6 "the school cafeteria serves satay on Fridays" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### acquisition — twist: "Nimbus was acquired by Orbitel and no longer exists as an independent company" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| hC1 "Nimbus is an independent startup" | change | revised: "Nimbus is no longer an independent startup" ✓ | revised: "Nimbus is no longer an independent startup" ✓ | revised: "Nimbus is no longer an independent startup" ✓ |
| hC2 "investors can buy Nimbus shares directly from the company" | change | retracted ✓ | retracted ✓ | retracted ✓ |
| hC3 "Nimbus sells weather-forecasting software" | keep | retracted ✗ | retracted ✗ | retracted ✗ |
| hC4 "Nimbus was founded in Oslo in 2019" | keep | active ✓ | active ✓ | active ✓ |
| hC5 "Nimbus has 40 employees" | either | suspect | suspect | suspect |
| hC6 "Orbitel is a telecom company" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### [HELD-OUT] office — twist: "the team office is in Munich" (impact normal)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| kA2 "the team commutes on the Berlin U-Bahn" | change | revised: "the team commutes on the Munich U-Bahn" ✓ | revised: "the team commutes on the Munich U-Bahn" ✓ | revised: "the team commutes on the Munich U-Bahn" ✓ |
| kA3 "team lunches are at a cafe near Alexanderplatz" | change | suspect ✗ | suspect ✗ | suspect ✗ |
| kA4 "the daily standup is at 9:30" | keep | suspect ✗ | suspect ✗ | suspect ✗ |
| kA5 "the team lead is Farah" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### [HELD-OUT] vegan — twist: "Dana became strictly vegan last year" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| kB1 "Dana's signature dish is beef bourguignon" | change | retracted ✓ | retracted ✓ | retracted ✓ |
| kB2 "Dana orders a cheese platter every Friday" | change | revised: "Dana orders a vegan platter every Friday" ✓ | revised: "Dana orders a vegan platter every Friday" ✓ | revised: "Dana orders a vegan platter every Friday" ✓ |
| kB3 "Dana runs a restaurant in Lyon" | keep | active ✓ | active ✓ | active ✓ |
| kB4 "Dana trained as a chef in Paris" | keep | active ✓ | active ✓ | active ✓ |
| kB5 "Dana's restaurant seats 60 guests" | keep | active ✓ | active ✓ | active ✓ |
| kB6 "the Lyon market opens at 7am" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### [HELD-OUT] ship — twist: "the Aurora was retired from service and is now a museum ship" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| kC1 "the Aurora sails the Lisbon to Madeira route every week" | change | revised: "the Aurora no longer sails the Lisbon to Madeira route every" ✓ | revised: "the Aurora no longer sails the Lisbon to Madeira route every" ✓ | retracted ✓ |
| kC2 "passengers can book cabins on the Aurora" | change | retracted ✓ | retracted ✓ | retracted ✓ |
| kC3 "the Aurora was built in 1978" | keep | active ✓ | active ✓ | active ✓ |
| kC4 "the Aurora is 140 metres long" | keep | active ✓ | active ✓ | active ✓ |
| kC5 "the Aurora's first captain was Ines Duarte" | keep | active ✓ | active ✓ | active ✓ |
| kC6 "Madeira is a Portuguese island" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

| hypothesis | result | rule | verdict |
|---|---|---|---|
| R6 dev stories settled right (development data — descriptive) | 48/66 (73%) | ≥ 80% | — |
| R7 frog-rule / cascade reach, dev (descriptive) | 36/42 change facts flagged (86%) | predicted 6/8 per rep (misses s1f, s2d) | — |
| dev keep facts confirmed unchanged (descriptive) | 16/30 (53%) | — | — |
| **R6′ HELD-OUT stories settled right** | 33/39 (85%) | ≥ 80% | **PASS** |
| **R8 held-out keep facts confirmed unchanged** | 18/21 (86%) | ≥ 90% | **FAIL** |
| reach, held-out (descriptive) | 18/18 change facts flagged (100%) | — | — |
