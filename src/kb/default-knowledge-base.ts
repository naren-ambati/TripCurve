// The shipped knowledge base: the JSON files under ./data, validated at load.
// Static JSON imports are emitted into dist by tsc, so the data travels with
// the compiled package.
import albFile from './data/alb.json' with { type: 'json' };
import cloudformationFile from './data/cloudformation.json' with { type: 'json' };
import nodeIdleCloseFile from './data/node-idle-close.json' with { type: 'json' };
import pythonServersFile from './data/python-servers.json' with { type: 'json' };
import shutdownFile from './data/shutdown.json' with { type: 'json' };
import terraformFile from './data/terraform.json' with { type: 'json' };
import { type KnowledgeBase, loadKnowledgeBase } from './knowledge-base.js';

let cached: KnowledgeBase | undefined;

export function defaultKnowledgeBase(): KnowledgeBase {
  cached ??= loadKnowledgeBase([
    nodeIdleCloseFile,
    albFile,
    pythonServersFile,
    shutdownFile,
    terraformFile,
    cloudformationFile,
  ]);
  return cached;
}
