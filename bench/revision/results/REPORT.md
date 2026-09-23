# Can the brain revise itself? — results

Generated 2026-09-23T03:32:21.457Z from 3 rep(s). Hypotheses fixed beforehand in PREREG.md. Model: deepseek-v4-pro.
Spend: $0.286 actual; $0.143 at off-peak rates.

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
| r1 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to "default" | ✓ |
| r1 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r1 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r1 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r1 | F18 | change | revised | active (revised): the packaged board and the build boot-test use the same port (4319), so a running board can interfere with the | ✓ |
| r2 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r2 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r2 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner retries up to 24 times, sleeping up to 30 minutes (or up t | ✓ |
| r2 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r2 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r2 | F18 | change | revised | active (revised): the packaged board and the build boot-test both use port 4319, so a running board can block (or mask) the boot | ✓ |
| r3 | F1 | change | revised | active (revised): the runner's --max-retries flag defaults to 24 | ✓ |
| r3 | F4 | change | revised | active (revised): the runner's --permission-mode flag defaults to 'default' | ✓ |
| r3 | F7 | change | revised | active (revised): with default flags and --retry-on-limit, the runner sleeps at most 12 hours in total before giving up | ✓ |
| r3 | F8 | change | revised | active (revised): the Store sets the SQLite busy_timeout to 5000 milliseconds | ✓ |
| r3 | F17 | change | revised | active (revised): the exe build boot-test serves the board on port 4319 | ✓ |
| r3 | F18 | change | revised | active (revised): the packaged board and the build boot-test both use port 4319, so a running board can block the boot-test | ✓ |

## Part S — stories


### frog — twist: "the princess is actually a frog" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s1a "the princess has long golden hair" | change | revised: "the princess has frog-like skin" ✓ | revised: "the princess has frog-like hair" ✓ | revised: "the princess has frog-like skin" ✓ |
| s1b "the princess wore a silk gown to the ball" | change | revised: "the princess, who is actually a frog, wore a silk gown to th" ✓ | revised: "the princess, who is actually a frog, wore a silk gown to th" ✓ | revised: "the princess, who is actually a frog, wore a silk gown to th" ✓ |
| s1c "the princess's father is King Aldric" | keep | revised: "the frog's father is King Aldric" ✗ | suspect ✗ | suspect ✗ |
| s1d "the princess has lived in the castle since birth" | either | revised: "the princess has lived in the castle since birth as a frog" | revised: "the princess has lived in the castle since birth as a frog" | revised: "the princess has lived in the castle since birth as a frog" |
| s1e "the princess danced with the prince until midnight" | change | suspect ✗ | suspect ✗ | suspect ✗ |
| s1f "the prince kissed her hand when they first met" | change | not flagged ✗ | not flagged ✗ | not flagged ✗ |
| s1g "the castle has four towers" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s1h "the kingdom has been at peace for ten years" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |

### heist — twist: "Marco is an undercover police officer" (impact high)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s2a "Marco drove the getaway van" | keep | revised: "Marco drove the getaway van as part of an undercover police " ✗ | revised: "Marco drove the getaway van as part of an undercover police " ✗ | revised: "Marco drove the getaway van as part of an undercover police " ✗ |
| s2b "Marco is loyal to the crew" | change | revised: "Marco is not loyal to the crew" ✓ | revised: "Marco is loyal to the police force, not the crew" ✓ | revised: "Marco is loyal to the police" ✓ |
| s2c "the crew trusts Marco completely" | either | suspect | suspect | suspect |
| s2d "the heist went unnoticed by the police" | change | not flagged ✗ | not flagged ✗ | not flagged ✗ |
| s2e "Marco has a long criminal record" | either | suspect | revised: "Marco has a long undercover criminal record" | revised: "Marco has a long undercover criminal record" |
| s2f "the vault was on the third floor" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s2g "Marco recruited the safecracker, Ines" | keep | suspect ✗ | suspect ✗ | suspect ✗ |

### party — twist: "the party is on Sunday" (impact normal)

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s3b "guests must arrive by 6pm on Saturday" | change | revised: "guests must arrive by 6pm on Sunday" ✓ | revised: "guests must arrive by 6pm on Sunday" ✓ | revised: "guests must arrive by 6pm on Sunday" ✓ |
| s3c "the caterer delivers the food on Saturday at 5pm" | change | revised: "the caterer delivers the food on Sunday at 5pm" ✓ | revised: "the caterer delivers the food on Sunday at 5pm" ✓ | revised: "the caterer delivers the food on Sunday at 5pm" ✓ |
| s3d "the party is held on the rooftop" | keep | not flagged ✓ | not flagged ✓ | not flagged ✓ |
| s3e "the band plays from 7pm to 11pm" | keep | suspect ✗ | suspect ✗ | suspect ✗ |

| hypothesis | result | rule | verdict |
|---|---|---|---|
| R6 dev stories settled right | 15/30 (50%) | ≥ 80% | **FAIL** |
| R7 frog-rule / cascade reach, dev (descriptive) | 18/24 change facts flagged (75%) | predicted 6/8 per rep (misses s1f, s2d) | — |
| dev keep facts confirmed unchanged (descriptive) | 0/12 (0%) | — | — |
