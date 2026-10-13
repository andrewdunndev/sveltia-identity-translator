// Standalone entry: the Worker configured from the editors.yml next to
// wrangler.toml. A consumer that depends on this package as a library
// writes the same two lines against its own editors.yml.

import editors from "../editors.yml";
import { createWorker } from "./worker";

export default createWorker({ editors });
