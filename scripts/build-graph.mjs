// build-graph.mjs — natively extract a local repo into a plan's code graph
// (no graphify needed). Usage: node scripts/build-graph.mjs <plan_id> <repo_path>
import { Store, defaultDbPath } from '../src/db.mjs';
import { extractRepo } from '../src/extract.mjs';

const planId = Number(process.argv[2]);
const path = process.argv[3];
if (!planId || !path) { console.error('usage: build-graph.mjs <plan_id> <repo_path>'); process.exit(2); }

const s = new Store(defaultDbPath());
const stats = s.importGraph(planId, extractRepo(path));
console.log(`built native code graph for plan #${planId} from ${path}:`, stats);
s.close();
