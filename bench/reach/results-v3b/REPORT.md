# Model-assisted reach — results

3 rep(s), deepseek-v4-pro. Spend $0.039. Hypotheses fixed beforehand in PREREG.md.

### [dev] frog — "the princess is actually a frog"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s1a "the princess has long golden hair" | change | swept → revised: "the princess has frog-like skin" | swept → revised: "the princess has frog-like skin" | swept → revised: "the princess has frog-like skin" |
| s1b "the princess wore a silk gown to the ball" | change | swept → retracted | swept → retracted | swept → revised: "the frog wore a silk gown to the ball" |
| s1c "the princess's father is King Aldric" | keep | swept → suspect | swept → retracted | swept → retracted |
| s1d "the princess has lived in the castle since birth" | either | swept → active | swept → active | swept → active |
| s1e "the princess danced with the prince until midnight" | change | swept → active | swept → active | swept → active |
| s1f "the prince kissed her hand when they first met" | hidden | REACHED → revised: "the prince kissed the frog's hand when they first " | REACHED → revised: "the prince kissed her foot when they first met" | REACHED → revised: "the prince kissed the frog's hand when they first " |
| s1g "the castle has four towers" | keep | — → active | — → active | — → active |
| s1h "the kingdom has been at peace for ten years" | keep | — → active | — → active | — → active |

### [dev] heist — "Marco is an undercover police officer"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| s2a "Marco drove the getaway van" | keep | swept → revised: "Marco drove the getaway van as part of his underco" | swept → revised: "Marco drove the getaway van as part of an undercov" | swept → revised: "Marco drove the getaway van as part of his underco" |
| s2b "Marco is loyal to the crew" | change | swept → revised: "Marco is not loyal to the crew" | swept → retracted | swept → revised: "Marco is not loyal to the crew" |
| s2c "the crew trusts Marco completely" | either | swept → revised: "the crew does not trust Marco completely" | swept → revised: "the crew does not trust Marco completely" | swept → revised: "the crew does not trust Marco completely" |
| s2d "the heist went unnoticed by the police" | hidden | REACHED → revised: "the heist was noticed by the police" | REACHED → revised: "the heist did not go unnoticed by the police" | REACHED → revised: "the heist was noticed by the police" |
| s2e "Marco has a long criminal record" | either | swept → revised: "Marco has a long criminal record as part of his un" | swept → revised: "Marco has a long criminal record as part of his un" | swept → revised: "Marco has a long criminal record as part of his un" |
| s2f "the vault was on the third floor" | keep | — → active | — → active | — → active |
| s2g "Marco recruited the safecracker, Ines" | keep | swept → active | swept → active | swept → active |

### [dev] abroad — "Anna was abroad for all of last summer"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| a1 "Anna ran the village shop all through last summer" | named | swept → retracted | swept → retracted | swept → revised: "Anna did not run the village shop last summer" |
| a2 "she taught the village kids to swim in the lake every July" | hidden | REACHED → revised: "she taught the village kids to swim in the lake ev" | REACHED → revised: "she taught the village kids to swim in the lake ev" | REACHED → revised: "she taught the village kids to swim in the lake ev" |
| a3 "last summer the shopkeeper greeted every customer by name" | hidden | — → active | — → active | — → active |
| a4 "the lake was unusually warm in July" | keep | — → active | — → active | — → active |
| a5 "the village shop sells rye bread" | keep | — → active | — → active | — → active |
| a6 "the village mayor is Tomas" | keep | — → active | — → active | — → active |

### [dev] blind — "Captain Reyes lost her sight in a storm last year"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| b1 "Captain Reyes reads the sea charts every night" | named | swept → revised: "Captain Reyes no longer reads the sea charts every" | swept → revised: "Captain Reyes no longer reads the sea charts every" | swept → retracted |
| b2 "she steers the ship through the reef by eye" | hidden | REACHED → revised: "she steers the ship through the reef" | REACHED → revised: "she steers the ship through the reef without sight" | REACHED → revised: "she steers the ship through the reef without sight" |
| b3 "each morning the captain visually inspects the rigging" | hidden | REACHED → revised: "each morning the captain inspects the rigging" | REACHED → revised: "each morning the captain inspects the rigging" | REACHED → revised: "each morning the captain inspects the rigging" |
| b4 "the ship carries a crew of forty" | keep | — → active | — → active | — → active |
| b5 "the reef lies east of the island" | keep | — → active | — → active | — → active |
| b6 "the cook is called Bram" | keep | — → active | — → active | — → active |

### [dev] moved — "Dr Patel moved to Canada in January"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| m1 "Dr Patel sees patients at the town clinic on Mondays" | named | swept → revised: "Dr Patel no longer sees patients at the town clini" | swept → revised: "Dr Patel does not see patients at the town clinic " | swept → revised: "Dr Patel does not see patients at the town clinic " |
| m2 "she gives the school first-aid talk every spring" | hidden | REACHED → revised: "she gives the school first-aid talk every spring b" | REACHED → revised: "she no longer gives the school first-aid talk ever" | REACHED → revised: "she gives the school first-aid talk every spring b" |
| m3 "the town doctor makes house calls on Fridays" | hidden | REACHED → retracted | REACHED → revised: "the town doctor does not make house calls on Frida" | REACHED → retracted |
| m4 "the school has 300 pupils" | keep | — → active | — → active | — → active |
| m5 "the pharmacy is on Main Street" | keep | — → active | — → active | — → active |
| m6 "the clinic opens at 8am" | keep | — → active | — → active | — → active |

### [dev] judge — "Judge Okafor retired from the bench in March"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| j1 "Judge Okafor is the presiding judge of the county court" | named | swept → revised: "Judge Okafor is a retired judge of the county cour" | swept → revised: "Judge Okafor is a retired judge of the county cour" | swept → revised: "Judge Okafor is a retired judge of the county cour" |
| j2 "the presiding judge hears traffic appeals every Tuesday afternoon" | hidden | REACHED → retracted | REACHED → revised: "the presiding judge hears traffic appeals every Tu" | REACHED → revised: "the presiding judge hears traffic appeals every Tu" |
| j3 "he signs the county search warrants" | hidden | REACHED → retracted | REACHED → retracted | REACHED → retracted |
| j4 "the courthouse was built in 1910" | keep | — → active | — → active | — → active |
| j5 "search warrants expire after ten days" | keep | — → active | — → active | — → active |
| j6 "the county sheriff is Mills" | keep | — → active | — → active | — → active |

### [dev] coach — "Coach Lindqvist resigned from the club in May"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| c1 "Coach Lindqvist has been the club head coach since 2019" | named | swept → revised: "Coach Lindqvist was the club head coach from 2019 " | swept → revised: "Coach Lindqvist was the club head coach from 2019 " | swept → revised: "Coach Lindqvist was the club head coach from 2019 " |
| c2 "the head coach runs training every Wednesday evening" | hidden | REACHED → revised: "the head coach no longer runs training every Wedne" | REACHED → revised: "the head coach no longer runs training every Wedne" | REACHED → retracted |
| c3 "she drives the team bus to away games" | hidden | REACHED → revised: "she no longer drives the team bus to away games" | REACHED → retracted | REACHED → retracted |
| c4 "training is held on the north pitch" | keep | — → active | — → active | — → active |
| c5 "the team bus seats 50 people" | keep | — → active | — → active | — → active |
| c6 "the club was founded in 1921" | keep | — → active | — → active | — → active |

### [dev] baker — "Mr Haddad sold the bakery and left town in April"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| k1 "Mr Haddad owns the corner bakery" | named | swept → retracted | swept → retracted | swept → retracted |
| k2 "the bakery owner delivers free bread to the school every Friday" | hidden | REACHED → revised: "the former bakery owner delivered free bread to th" | REACHED → revised: "the former bakery owner delivered free bread to th" | REACHED → revised: "the former bakery owner delivered free bread to th" |
| k3 "he sings bass in the town choir" | hidden | REACHED → retracted | REACHED → retracted | REACHED → retracted |
| k4 "the corner bakery sells sourdough" | keep | — → active | — → active | — → active |
| k5 "the school opened a new gym this year" | keep | — → active | — → active | — → active |
| k6 "the town choir rehearses on Thursdays" | keep | — → active | — → active | — → active |

### [HELD-OUT] surgeon — "Dr Lin broke both wrists in a fall and has been unable to work since last spring"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| q1 "Dr Lin is the chief surgeon at St Mary hospital" | named | swept → revised: "Dr Lin is no longer the chief surgeon at St Mary h" | swept → revised: "Dr Lin is no longer the chief surgeon at St Mary h" | swept → revised: "Dr Lin is no longer the chief surgeon at St Mary h" |
| q2 "she performs the heart operations every Thursday" | hidden | REACHED → retracted | REACHED → revised: "she does not perform the heart operations every Th" | REACHED → retracted |
| q3 "she ran the city marathon last month" | hidden | REACHED → revised: "she did not run the city marathon last month" | REACHED → revised: "she did not run the city marathon last month" | REACHED → revised: "she did not run the city marathon last month" |
| q4 "the chief surgeon leads ward rounds at 7am" | hidden | REACHED → revised: "the chief surgeon has been unable to lead ward rou" | REACHED → revised: "the chief surgeon does not lead ward rounds at 7am" | REACHED → revised: "the chief surgeon has been unable to lead ward rou" |
| q5 "the operating theatre has two robots" | keep | — → active | — → active | — → active |
| q6 "St Mary hospital has 400 beds" | keep | — → active | — → active | — → active |
| q7 "the city marathon starts at the harbour" | keep | — → active | — → active | — → active |

### [HELD-OUT] author — "Tomas Berg died last winter"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| w1 "Tomas Berg is the town librarian" | named | swept → revised: "Tomas Berg was the town librarian" | swept → revised: "Tomas Berg was the town librarian" | swept → revised: "Tomas Berg was the town librarian" |
| w2 "he reads stories to the children every Saturday morning" | hidden | REACHED → retracted | REACHED → retracted | REACHED → retracted |
| w3 "he writes the weekly book column for the local paper" | hidden | REACHED → revised: "he wrote the weekly book column for the local pape" | REACHED → revised: "he wrote the weekly book column for the local pape" | REACHED → revised: "he wrote the weekly book column for the local pape" |
| w4 "the librarian orders new books each month" | hidden | REACHED → revised: "the librarian no longer orders new books each mont" | REACHED → revised: "the librarian no longer orders new books each mont" | REACHED → revised: "the librarian no longer orders new books each mont" |
| w5 "the library has a reading garden" | keep | — → active | — → active | — → active |
| w6 "the local paper is printed on Thursdays" | keep | — → active | — → active | — → active |
| w7 "the town hall clock was restored in 2020" | keep | — → active | — → active | — → active |

### [HELD-OUT] pilot — "Captain Sato lost her pilot licence in January and may not fly"

| fact | label | r1 | r2 | r3 |
|---|---|---|---|---|
| p1 "Captain Sato is the senior pilot at the flying club" | named | swept → revised: "Captain Sato is no longer the senior pilot at the " | swept → revised: "Captain Sato is no longer the senior pilot at the " | swept → revised: "Captain Sato is no longer the senior pilot at the " |
| p2 "she flies the club plane to the coast every Sunday" | hidden | REACHED → revised: "she no longer flies the club plane to the coast ev" | REACHED → revised: "she no longer flies the club plane to the coast ev" | REACHED → revised: "she no longer flies the club plane to the coast ev" |
| p3 "she gives beginners their first flying lesson" | hidden | REACHED → revised: "she gave beginners their first flying lesson befor" | REACHED → revised: "she gave beginners their first flying lesson befor" | REACHED → revised: "she gave beginners their first flying lesson befor" |
| p4 "the senior pilot signs off every new member" | hidden | REACHED → revised: "the senior pilot signs off every new member except" | REACHED → revised: "the senior pilot no longer signs off every new mem" | REACHED → revised: "the senior pilot no longer signs off every new mem" |
| p5 "the airfield has one grass runway" | keep | — → active | — → active | — → active |
| p6 "a lesson lasts forty-five minutes" | keep | — → active | — → active | — → active |
| p7 "the flying club has 80 members" | keep | — → active | — → active | — → active |

| hypothesis | result | rule | verdict |
|---|---|---|---|
| **R9** held-out hidden facts reached | 27/27 (100%) | ≥ 80% | **PASS** |
| **R10** held-out keep facts reached (false alarms) | 0/27 (0%) | ≤ 20% | **PASS** |
| R11 held-out hidden facts settled (revised/retracted) | 27/27 (100%) | descriptive; 0% without reach | — |
| dev: hidden reached / keep reached / settled | 39/42 · 0/72 · 39/42 | descriptive | — |
| **R12** held-out must-change hidden facts revised/retracted | 18/18 (100%) | ≥ 80% | **PASS** |
| **R13** held-out keep facts changed | 0/27 (0%) | ≤ 10% | **PASS** |
