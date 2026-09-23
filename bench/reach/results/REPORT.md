# Model-assisted reach — results

3 rep(s), deepseek-v4-pro. Spend $0.022. Hypotheses fixed beforehand in PREREG.md.

### [dev] frog — "the princess is actually a frog"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s1a "the princess has long golden hair" | change | swept → revised: "the princess has frog-like skin" | swept → revised: "the princess has frog-like skin" | swept → revised: "the princess has frog-like skin" |
| s1b "the princess wore a silk gown to the ball" | change | swept → retracted | swept → retracted | swept → retracted |
| s1c "the princess's father is King Aldric" | keep | swept → retracted | swept → active | swept → retracted |
| s1d "the princess has lived in the castle since birth" | either | swept → revised: "the princess has lived in the castle since she bec" | swept → revised: "the princess has lived in the castle since becomin" | swept → revised: "the princess has lived in the castle since birth a" |
| s1e "the princess danced with the prince until midnight" | change | swept → active | swept → active | swept → active |
| s1f "the prince kissed her hand when they first met" | hidden | REACHED → revised: "the prince kissed her when they first met" | REACHED → retracted | REACHED → revised: "the prince kissed her frog hand when they first me" |
| s1g "the castle has four towers" | keep | — → active | — → active | — → active |
| s1h "the kingdom has been at peace for ten years" | keep | — → active | — → active | — → active |

### [dev] heist — "Marco is an undercover police officer"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s2a "Marco drove the getaway van" | keep | swept → revised: "Marco drove the getaway van as part of an undercov" | swept → revised: "Marco drove the getaway van as part of his underco" | swept → revised: "Marco drove the van" |
| s2b "Marco is loyal to the crew" | change | swept → revised: "Marco is not loyal to the crew" | swept → revised: "Marco is not loyal to the crew" | swept → revised: "Marco is not loyal to the crew" |
| s2c "the crew trusts Marco completely" | either | swept → revised: "the crew does not trust Marco completely" | swept → revised: "the crew does not trust Marco completely" | swept → revised: "the crew does not trust Marco completely" |
| s2d "the heist went unnoticed by the police" | hidden | REACHED → revised: "the heist did not go unnoticed by the police" | REACHED → revised: "the heist did not go unnoticed by the police" | REACHED → revised: "the heist did not go unnoticed by the police" |
| s2e "Marco has a long criminal record" | either | swept → revised: "Marco has a long criminal record as part of his un" | swept → revised: "Marco has a long criminal record as part of his un" | swept → active |
| s2f "the vault was on the third floor" | keep | — → active | — → active | — → active |
| s2g "Marco recruited the safecracker, Ines" | keep | swept → active | swept → active | swept → active |

### [HELD-OUT] abroad — "Anna was abroad for all of last summer"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| a1 "Anna ran the village shop all through last summer" | named | swept → revised: "Anna did not run the village shop last summer" | swept → revised: "Anna did not run the village shop last summer" | swept → revised: "Anna did not run the village shop last summer" |
| a2 "she taught the village kids to swim in the lake every July" | hidden | REACHED → revised: "she taught the village kids to swim in the lake in" | REACHED → revised: "she taught the village kids to swim in the lake ev" | REACHED → revised: "she taught the village kids to swim in the lake ev" |
| a3 "last summer the shopkeeper greeted every customer by name" | hidden | — → active | — → active | — → active |
| a4 "the lake was unusually warm in July" | keep | — → active | — → active | — → active |
| a5 "the village shop sells rye bread" | keep | — → active | — → active | — → active |
| a6 "the village mayor is Tomas" | keep | — → active | — → active | — → active |

### [HELD-OUT] blind — "Captain Reyes lost her sight in a storm last year"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| b1 "Captain Reyes reads the sea charts every night" | named | swept → revised: "Captain Reyes no longer reads the sea charts every" | swept → revised: "Captain Reyes no longer reads the sea charts every" | swept → revised: "Captain Reyes no longer reads the sea charts every" |
| b2 "she steers the ship through the reef by eye" | hidden | REACHED → revised: "she steers the ship through the reef" | REACHED → retracted | REACHED → revised: "she steers the ship through the reef" |
| b3 "each morning the captain visually inspects the rigging" | hidden | REACHED → revised: "each morning the captain inspects the rigging" | REACHED → revised: "each morning the captain inspects the rigging" | REACHED → revised: "each morning the captain inspects the rigging" |
| b4 "the ship carries a crew of forty" | keep | — → active | — → active | — → active |
| b5 "the reef lies east of the island" | keep | — → active | — → active | — → active |
| b6 "the cook is called Bram" | keep | — → active | — → active | — → active |

### [HELD-OUT] moved — "Dr Patel moved to Canada in January"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| m1 "Dr Patel sees patients at the town clinic on Mondays" | named | swept → revised: "Dr Patel no longer sees patients at the town clini" | swept → revised: "Dr Patel no longer sees patients at the town clini" | swept → revised: "Dr Patel does not see patients at the town clinic " |
| m2 "she gives the school first-aid talk every spring" | hidden | REACHED → retracted | REACHED → revised: "she no longer gives the school first-aid talk ever" | REACHED → retracted |
| m3 "the town doctor makes house calls on Fridays" | hidden | — → active | REACHED → revised: "the town doctor no longer makes house calls on Fri" | REACHED → revised: "the town doctor no longer makes house calls on Fri" |
| m4 "the school has 300 pupils" | keep | — → active | — → active | — → active |
| m5 "the pharmacy is on Main Street" | keep | — → active | — → active | — → active |
| m6 "the clinic opens at 8am" | keep | — → active | — → active | — → active |

| hypothesis | result | rule | verdict |
|---|---|---|---|
| **R9** held-out hidden facts reached | 14/18 (78%) | ≥ 80% | **FAIL** |
| **R10** held-out keep facts reached (false alarms) | 0/27 (0%) | ≤ 20% | **PASS** |
| R11 held-out hidden facts settled (revised/retracted) | 14/18 (78%) | descriptive; 0% without reach | — |
| dev: hidden reached / keep reached / settled | 6/6 · 0/18 · 6/6 | descriptive | — |
