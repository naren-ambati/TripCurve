// Turns reader models into plain, comparable data for expectations. Input text
// is shown quoted with double quotes and a value is followed by `@source`.
import {
  type InputText,
  isInputText,
  isSourcedValue,
  isUnresolved,
  type SourcedValue,
} from '../../src/core/index.js';
import type { K8sContainer, K8sPair, K8sPreStop, Maybe } from '../../src/parse/k8s/model.js';
import { txt, where } from './render.js';

export function val(v: Maybe | InputText | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (isInputText(v)) return JSON.stringify(txt(v));
  if (isUnresolved(v)) return `?${v.reason}`;
  if (!isSourcedValue(v)) throw new Error('not a value');
  return `${shown(v)}@${where(v.source)}`;
}

function shown(v: SourcedValue): string {
  const raw = isInputText(v.value) ? JSON.stringify(txt(v.value)) : String(v.value);
  return v.unit === 's' ? `${raw}s` : raw;
}

export function pairs(list: readonly K8sPair[] | undefined): string[] | undefined {
  return list?.map((p) => `${txt(p.key)}=${val(p.value)}`);
}

export function preStop(p: K8sPreStop | undefined): string | undefined {
  if (p === undefined) return undefined;
  return `${p.form} ${val(p.delay)}`;
}

export function container(c: K8sContainer) {
  const list = (l: K8sContainer['command']): string[] | string | undefined => {
    if (l === undefined) return undefined;
    if (isUnresolved(l)) return `?${l.reason}`;
    return l.items.map((i) => val(i) as string);
  };
  return {
    name: txt(c.name),
    at: where(c.source),
    image: val(c.image),
    command: list(c.command),
    args: list(c.args),
    env: c.env.map((e) => `${txt(e.name)}=${val(e.value)}`),
    envFrom: c.envFromSource === undefined ? undefined : where(c.envFromSource),
    ports: c.ports.map((p) => `${val(p.name) ?? '-'} ${val(p.containerPort) ?? '-'}`),
    preStop: preStop(c.preStop),
  };
}
