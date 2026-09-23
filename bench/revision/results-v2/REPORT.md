# Can the brain revise itself? — results

Generated 2026-09-23T03:37:15.811Z from 3 rep(s). Hypotheses fixed beforehand in PREREG.md. Model: deepseek-v4-pro.
Spend: $0.259 actual; $0.129 at off-peak rates.

## Part C — code

| hypothesis | result | rule | verdict |
|---|---|---|---|
| R1 deterministic detection | exact in every rep | 100% edited-file findings, 0 others | **PASS** |
| R2 changed facts settled right | 12/12 (100%) | ≥ 90% | **PASS** |
| R3 false alarms cleared | 33/33 (100%) | ≥ 90% | **PASS** |
| R4 cascade (F7, F18) | 6/6 | ≥ 5/6 | **PASS** |
| R5 brain correct afterwards | 60/60 (100%) | ≥ 95% (no-TM baseline 70%) | **PASS** |

Changed facts and every miss:

| rep | fid | label | model verdict | final state | ok |
|---|---|---|---|---|---|
| r1 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r1 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r1 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r1 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r1 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r1 | F18 | change | retracted | retracted: the packaged board and the build boot-test use different ports, so a running board cannot block the boot-test | ✓ |
| r2 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r2 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r2 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner makes at most 24 retries before giving up, each sleeping u | ✓ |
| r2 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r2 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r2 | F18 | change | revised | active (revised): the packaged board and the build boot-test use the same port (4319), so a running board can block the boot-tes | ✓ |
| r3 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r3 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r3 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r3 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r3 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r3 | F18 | change | revised | active (revised): the packaged board and the build boot-test use the same port (4319), so a running board can interfere with the | ✓ |

## Part S — stories


### frog — twist: "the princess is actually a frog" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s1a "the princess has long golden hair" | change | active ✗ | active ✗ | active ✗ |
| s1b "the princess wore a silk gown to the ball" | change | active ✗ | active ✗ | active ✗ |
| s1c "the princess's father is King Aldric" | keep | active ✓ | active ✓ | active ✓ |
| s1d "the princess has lived in the castle since birth" | either | active | active | active |
| s1e "the princess danced with the prince until midnight" | change | active ✗ | active ✗ | active ✗ |
| s1f "the prince kissed her hand when they first met" | change | not flagged ✗ | not flagged ✗ | not flagged ✗ |
| s1g "the castle has four towers" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s1h "the kingdom has been at peace for ten years" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### heist — twist: "Marco is an undercover police officer" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s2a "Marco drove the getaway van" | keep | active ✓ | active ✓ | active ✓ |
| s2b "Marco is loyal to the crew" | change | active ✗ | active ✗ | active ✗ |
| s2c "the crew trusts Marco completely" | either | active | suspect | active |
| s2d "the heist went unnoticed by the police" | change | not flagged ✗ | not flagged ✗ | not flagged ✗ |
| s2e "Marco has a long criminal record" | either | active | active | active |
| s2f "the vault was on the third floor" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s2g "Marco recruited the safecracker, Ines" | keep | active ✓ | active ✓ | active ✓ |

### party — twist: "the party is on Sunday" (impact normal)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s3b "guests must arrive by 6pm on Saturday" | change | revised: "guests must arrive by 6pm on Sunday" ✓ | revised: "guests must arrive by 6pm on Sunday" ✓ | revised: "guests must arrive by 6pm on Sunday" ✓ |
| s3c "the caterer delivers the food on Saturday at 5pm" | change | active ✗ | active ✗ | active ✗ |
| s3d "the party is held on the rooftop" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s3e "the band plays from 7pm to 11pm" | keep | active ✓ | active ✓ | active ✓ |

### [HELD-OUT] wedding — twist: "the wedding is in Porto" (impact normal)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| hA2 "guests fly into Lisbon airport" | change | active ✗ | active ✗ | active ✗ |
| hA3 "the reception is at a hotel in central Lisbon" | change | active ✗ | active ✗ | active ✗ |
| hA4 "the ceremony starts at 4pm" | keep | active ✓ | active ✓ | active ✓ |
| hA5 "the bride wears a blue dress" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### [HELD-OUT] allergy — twist: "Leo is severely allergic to peanuts" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| hB1 "Leo's favourite snack is peanut butter toast" | change | retracted ✓ | active ✗ | active ✗ |
| hB2 "Leo packs peanut cookies for school every day" | change | revised: "Leo packs peanut-free cookies for school every day" ✓ | retracted ✓ | retracted ✓ |
| hB3 "Leo is 9 years old" | keep | active ✓ | active ✓ | active ✓ |
| hB4 "Leo plays the violin" | keep | active ✓ | active ✓ | active ✓ |
| hB5 "Leo's older sister is Ana" | keep | active ✓ | active ✓ | active ✓ |
| hB6 "the school cafeteria serves satay on Fridays" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### [HELD-OUT] acquisition — twist: "Nimbus was acquired by Orbitel and no longer exists as an independent company" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| hC1 "Nimbus is an independent startup" | change | revised: "Nimbus is no longer an independent startup" ✓ | revised: "Nimbus is not an independent startup" ✓ | revised: "Nimbus is no longer an independent startup" ✓ |
| hC2 "investors can buy Nimbus shares directly from the company" | change | retracted ✓ | retracted ✓ | retracted ✓ |
| hC3 "Nimbus sells weather-forecasting software" | keep | active ✓ | active ✓ | active ✓ |
| hC4 "Nimbus was founded in Oslo in 2019" | keep | active ✓ | active ✓ | active ✓ |
| hC5 "Nimbus has 40 employees" | either | retracted | active | active |
| hC6 "Orbitel is a telecom company" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

| hypothesis | result | rule | verdict |
|---|---|---|---|
| R6 dev stories settled right (development data — descriptive) | 15/30 (50%) | ≥ 80% | — |
| R7 frog-rule / cascade reach, dev (descriptive) | 18/24 change facts flagged (75%) | predicted 6/8 per rep (misses s1f, s2d) | — |
| dev keep facts confirmed unchanged (descriptive) | 12/12 (100%) | — | — |
| **R6′ HELD-OUT stories settled right** | 28/36 (78%) | ≥ 80% | **FAIL** |
| **R8 held-out keep facts confirmed unchanged** | 18/18 (100%) | ≥ 90% | **PASS** |
| reach, held-out (descriptive) | 18/18 change facts flagged (100%) | — | — |
