import { describe, expect, it } from 'vitest';
import {
  isResultKind,
  isRuleId,
  isWaivableKind,
  k8sWorkloadKindFromInput,
  RESULT_KINDS,
  targetTypeFromInput,
  WAIVABLE_KINDS,
  WORKLOAD_KINDS,
  workerClassFromInput,
  workloadKindFromInput,
  workloadKindRank,
} from '../../src/core/index.js';

describe('the eight result kinds', () => {
  it('are exactly these words, in this order', () => {
    expect([...RESULT_KINDS]).toEqual([
      'PASS',
      'FAIL',
      'WARN',
      'UNRESOLVED',
      'VERSION-DEPENDENT',
      'NOT EVALUATED',
      'N/A',
      'WAIVED',
    ]);
  });

  it('is a closed set', () => {
    for (const k of RESULT_KINDS) expect(isResultKind(k)).toBe(true);
    for (const bad of [
      'pass',
      'PASSED',
      'OK',
      'NOT_EVALUATED',
      '',
      'constructor',
      'toString',
      5,
      null,
      undefined,
    ]) {
      expect(isResultKind(bad)).toBe(false);
    }
  });

  it('lets a waiver wrap every kind except PASS, N/A and WAIVED', () => {
    expect([...WAIVABLE_KINDS]).toEqual([
      'FAIL',
      'WARN',
      'UNRESOLVED',
      'VERSION-DEPENDENT',
      'NOT EVALUATED',
    ]);
    for (const k of ['PASS', 'N/A', 'WAIVED']) expect(isWaivableKind(k)).toBe(false);
  });

  it('knows the four rules', () => {
    for (const r of ['T1', 'T2', 'T3', 'T4']) expect(isRuleId(r)).toBe(true);
    for (const r of ['T5', 't1', '', 'T1 ']) expect(isRuleId(r)).toBe(false);
  });
});

describe('fixed vocabularies', () => {
  it('has the Kubernetes kinds with bare Pod, then event source mapping', () => {
    expect([...WORKLOAD_KINDS]).toEqual([
      'Deployment',
      'StatefulSet',
      'DaemonSet',
      'Pod',
      'event source mapping',
    ]);
  });

  it('matches a kind word exactly and returns the constant, never the input', () => {
    expect(k8sWorkloadKindFromInput('Deployment')).toBe('Deployment');
    expect(k8sWorkloadKindFromInput('Pod')).toBe('Pod');
    for (const bad of [
      'deployment',
      'Deployment ',
      'Job',
      'CronJob',
      'ReplicaSet',
      'PASS',
      '',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(k8sWorkloadKindFromInput(bad)).toBeUndefined();
    }
    expect(workloadKindFromInput('event source mapping')).toBe('event source mapping');
    expect(k8sWorkloadKindFromInput('event source mapping')).toBeUndefined();
  });

  it('matches target types and worker classes exactly', () => {
    expect(targetTypeFromInput('ip')).toBe('ip');
    expect(targetTypeFromInput('IP')).toBeUndefined();
    expect(workerClassFromInput('gthread')).toBe('gthread');
    expect(workerClassFromInput('uvicorn.workers.UvicornWorker')).toBeUndefined();
    expect(workerClassFromInput('sync ')).toBeUndefined();
  });

  it('ranks kinds in the report order, unknown last', () => {
    expect(workloadKindRank('Deployment')).toBeLessThan(workloadKindRank('StatefulSet'));
    expect(workloadKindRank('Pod')).toBeLessThan(workloadKindRank('event source mapping'));
    expect(workloadKindRank(undefined)).toBeGreaterThan(workloadKindRank('event source mapping'));
  });
});
