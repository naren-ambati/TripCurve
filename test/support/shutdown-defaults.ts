// The shutdown-chain fields (bolt B4) of a hand-built ResolvedWorkload: a documented 30 s grace
// period, no in-process drain, and no known ceiling. Tests of T1 spread this in; tests of T2 and T3
// override the fields they are about.
import { defaultSource, makeSourcedValue } from '../../src/core/index.js';
import type { ResolvedWorkload } from '../../src/resolve/index.js';

export function shutdownDefaults(): Pick<ResolvedWorkload, 'grace' | 'inProcessDrain' | 'ceiling'> {
  return {
    grace: makeSourcedValue({
      value: 30,
      unit: 's',
      source: defaultSource({
        citation: 'Kubernetes terminationGracePeriodSeconds',
        basisText: 'documented',
      }),
      basis: 'documented',
    }),
    inProcessDrain: { state: 'none' },
    ceiling: {
      state: 'unresolved',
      reason: 'no graceful-timeout ceiling known for a Node server',
      declare: ['declare longest_request_s for this workload in tripcurve.yaml'],
    },
  };
}
