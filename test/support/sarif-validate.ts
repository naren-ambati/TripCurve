// A hand-written validator for the subset of SARIF 2.1.0 that tripcurve emits.
//
// Why this and not the official JSON Schema: the schema file in oasis-tcs/sarif-spec is published under the
// OASIS IPR Policy (RF on RAND), which is not a standard permissive licence, and a full JSON Schema
// validator would be a new dependency. So tripcurve keeps no copy of the schema and checks the properties it
// emits against the specification text instead. The maintainer may later choose to vendor the official schema.
//
// Every check cites the section of "Static Analysis Results Interchange Format (SARIF) Version 2.1.0,
// Errata 01" (OASIS Standard, https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/
// sarif-v2.1.0-errata01-os-complete.html) it comes from, with the words quoted from that page. Read
// 2026-11-12 (read-only lookup). `validateSarif` returns the problems found; an empty list means the
// document is valid for the subset below. The subset is: version, runs, originalUriBaseIds, tool.driver (name,
// version, rules with id, shortDescription, help), results (ruleId, ruleIndex, level, message, locations with
// physicalLocation, artifactLocation.uri and uriBaseId, region.startLine and startColumn, suppressions with kind,
// status, justification) and `properties` bags.
//
// Closed property sets (review of B7, m1): the spec lets any object carry `properties` and nothing else beyond
// its own named properties, so a misspelt key (`levle`, `rulez`, `startLineX`) is simply an unknown property that
// a schema-less check would let through, and a consumer would silently ignore the thing that was meant. For every
// object type tripcurve writes, `ALLOWED` lists the properties it may carry; any other key is a problem here.
// `level` is also required on every result: the spec's default for an absent level depends on `kind`, and a
// reader that gates on level must never have to guess.

type Problems = string[];
type Obj = Record<string, unknown>;

/** The properties each object type tripcurve writes may carry (a closed set). Open: only the `properties` bags. */
const ALLOWED = {
  log: ['version', 'runs', 'properties'],
  run: ['tool', 'originalUriBaseIds', 'results', 'properties'],
  tool: ['driver'],
  driver: ['name', 'version', 'rules'],
  rule: ['id', 'shortDescription', 'help'],
  message: ['text', 'markdown'],
  result: ['ruleId', 'ruleIndex', 'level', 'message', 'locations', 'suppressions', 'properties'],
  location: ['physicalLocation'],
  physicalLocation: ['artifactLocation', 'region'],
  artifactLocation: ['uri', 'uriBaseId'],
  baseLocation: ['uri', 'uriBaseId', 'description'],
  region: ['startLine', 'startColumn'],
  suppression: ['kind', 'status', 'justification', 'properties'],
} as const;

function closed(v: Obj, type: keyof typeof ALLOWED, at: string, out: Problems): void {
  const allowed: readonly string[] = ALLOWED[type];
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) {
      out.push(`${at}.${key}: not a property tripcurve writes on a ${type} (closed property set)`);
    }
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Two array elements are equal when their JSON is equal (3.7.3, which defers to the JSON Schema `uniqueItems` rule). */
function duplicates(items: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * 3.4.3 uri property: "a string containing a URI [RFC3986]"; a relative reference "SHALL NOT begin with two
 * slash characters" and "SHALL NOT begin with a single slash character (an 'absolute-path' reference ...)".
 * RFC 3986 allows only unreserved characters, sub-delims, ':' '@' '/' and percent-encoded octets in a path
 * (3.3, pchar), and 4.2 bars a colon in the first segment of a relative-path reference.
 */
function checkUri(uri: unknown, at: string, out: Problems): void {
  // (the base id is checked by checkArtifactLocation)
  if (typeof uri !== 'string') {
    out.push(`${at}: uri must be a string (3.4.3)`);
    return;
  }
  if (uri === '') {
    out.push(`${at}: uri must not be empty (3.4.3)`);
    return;
  }
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(uri)) {
    out.push(`${at}: uri has a character RFC 3986 does not allow unencoded (3.4.3)`);
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(uri))
    out.push(`${at}: uri has a malformed percent-encoding (3.4.3)`);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  if (scheme === null) {
    if (uri.startsWith('/')) {
      out.push(`${at}: a relative uri must not begin with a slash (3.4.3)`);
    }
  } else if (scheme[1]?.toLowerCase() !== 'file') {
    // tripcurve writes a relative reference, or a file: URI for an absolute root. RFC 3986 4.2 (read 2026-11-12):
    // "A path segment that contains a colon character (e.g., "this:that") cannot be used as the first segment of
    // a relative-path reference, as it would be mistaken for a scheme name."
    out.push(`${at}: uri has a scheme or a colon in its first segment (RFC 3986 4.2, colon)`);
  }
}

function checkMultiformat(v: unknown, at: string, out: Problems): void {
  // 3.12.3 text property: "A multiformatMessageString object SHALL contain a property named text whose value
  // is a non-empty string containing a plain text representation of the message."
  if (!isObj(v)) {
    out.push(`${at}: must be an object (3.12)`);
    return;
  }
  if (!isNonEmptyString(v.text)) out.push(`${at}.text: must be a non-empty string (3.12.3)`);
  // 3.12.4 markdown property: a non-empty string; tripcurve writes plain text only.
  if (v.markdown !== undefined && !isNonEmptyString(v.markdown)) {
    out.push(`${at}.markdown: must be a non-empty string (3.12.4)`);
  }
  closed(v, 'message', at, out);
}

/**
 * 3.4.4 uriBaseId property: "If this artifactLocation object describes a top-level artifact and the value of its
 * uri property (3.4.3) is a relative reference, the artifactLocation object SHOULD contain a property named
 * uriBaseId"; "If the uri property contains an absolute URI, the uriBaseId property SHALL be absent." tripcurve
 * always writes the base for a relative reference, and the base must be one the run declares in
 * originalUriBaseIds (3.14.14).
 */
function checkArtifactLocation(
  artifact: Obj,
  at: string,
  bases: ReadonlySet<string>,
  out: Problems,
  requireBase: boolean,
): void {
  checkUri(artifact.uri, `${at}.uri`, out);
  const relative =
    typeof artifact.uri === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(artifact.uri);
  if (artifact.uriBaseId !== undefined) {
    if (typeof artifact.uriBaseId !== 'string') {
      out.push(`${at}.uriBaseId: must be a string (3.4.4)`);
    } else if (!relative) {
      out.push(`${at}.uriBaseId: must be absent when the uri is an absolute URI (3.4.4)`);
    } else if (!bases.has(artifact.uriBaseId)) {
      out.push(
        `${at}.uriBaseId: ${JSON.stringify(artifact.uriBaseId)} is not in originalUriBaseIds (3.14.14)`,
      );
    }
  } else if (relative && requireBase) {
    out.push(`${at}.uriBaseId: a relative uri needs its uriBaseId (3.4.4, 3.14.14)`);
  }
}

/**
 * 3.11.6 (a plain text message): an embedded link is `[link text](destination)`, and "Literal square brackets ("
 * [ " and " ] ") in the link text of a plain text message SHALL be escaped with a backslash"; the backslash is
 * itself escaped as `\\` (the grammar's "escaped link character"). 3.11.5: "the characters " { " and " } " SHALL be
 * represented by the character sequences " {{ " and " }} "". tripcurve's messages quote input, so a bracket or a
 * brace that is not written as one of those sequences could let input form a link or a placeholder. Read left to
 * right, a backslash takes the next character with it, and a brace pairs with the one after it.
 */
function checkMessageEscapes(text: string, at: string, out: Problems): void {
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '{' || c === '}') {
      if (text[i + 1] === c) i += 1;
      else out.push(`${at}: an unescaped ${c} (3.11.5)`);
    } else if (c === '[' || c === ']') {
      out.push(`${at}: an unescaped ${c} in a plain text message (3.11.6)`);
    }
  }
}

function checkProperties(v: unknown, at: string, out: Problems): void {
  // 3.8.1: "every object defined in this document MAY contain a property named properties whose value is a
  // property bag", and a property bag "is an object".
  if (v !== undefined && !isObj(v)) out.push(`${at}.properties: must be an object (3.8.1)`);
}

function checkRule(rule: unknown, at: string, out: Problems): string | undefined {
  if (!isObj(rule)) {
    out.push(`${at}: must be an object (3.19.23)`);
    return undefined;
  }
  // 3.49.3 id property: "A reportingDescriptor object SHALL contain a property named id whose value is a string."
  if (!isNonEmptyString(rule.id)) out.push(`${at}.id: must be a non-empty string (3.49.3)`);
  // 3.49.12 shortDescription and 3.49.13 help are multiformatMessageString objects (3.12).
  if (rule.shortDescription !== undefined) {
    checkMultiformat(rule.shortDescription, `${at}.shortDescription`, out);
  }
  if (rule.help !== undefined) checkMultiformat(rule.help, `${at}.help`, out);
  closed(rule, 'rule', at, out);
  checkProperties(rule.properties, at, out);
  return isNonEmptyString(rule.id) ? rule.id : undefined;
}

function checkLocation(loc: unknown, at: string, bases: ReadonlySet<string>, out: Problems): void {
  if (!isObj(loc)) {
    out.push(`${at}: must be an object (3.28)`);
    return;
  }
  // 3.28.3: "If physical location information is available and the logicalLocations property (3.28.4) is
  // absent or empty, physicalLocation SHALL be present."
  closed(loc, 'location', at, out);
  const physical = loc.physicalLocation;
  if (!isObj(physical)) {
    out.push(`${at}.physicalLocation: must be an object (3.28.3)`);
    return;
  }
  // 3.29.2 Constraints: "Either the artifactLocation property (3.29.3), the address property (3.29.6), or both
  // SHALL be present." tripcurve never writes an address.
  const artifact = physical.artifactLocation;
  if (!isObj(artifact)) {
    out.push(`${at}.physicalLocation.artifactLocation: must be an object (3.29.2)`);
  } else {
    closed(artifact, 'artifactLocation', `${at}.physicalLocation.artifactLocation`, out);
    checkArtifactLocation(artifact, `${at}.physicalLocation.artifactLocation`, bases, out, true);
  }
  closed(physical, 'physicalLocation', `${at}.physicalLocation`, out);
  if (physical.region !== undefined) {
    const region = physical.region;
    if (!isObj(region)) {
      out.push(`${at}.physicalLocation.region: must be an object (3.30)`);
    } else if (
      // 3.30.5 startLine property: "a positive integer equal to the line number of the line containing the first
      // character in the region."
      typeof region.startLine !== 'number' ||
      !Number.isInteger(region.startLine) ||
      region.startLine < 1
    ) {
      out.push(`${at}.physicalLocation.region.startLine: must be an integer of 1 or more (3.30.5)`);
    }
    if (isObj(region)) {
      // 3.30.6 startColumn property: "a positive integer equal to the column number of the first character in the region."
      if (region.startColumn !== undefined && !isPositiveInt(region.startColumn)) {
        out.push(
          `${at}.physicalLocation.region.startColumn: must be an integer of 1 or more (3.30.6)`,
        );
      }
      closed(region, 'region', `${at}.physicalLocation.region`, out);
    }
  }
}

function checkSuppression(s: unknown, at: string, out: Problems): void {
  if (!isObj(s)) {
    out.push(`${at}: must be an object (3.35)`);
    return;
  }
  // 3.35.2 kind property: "A suppression object SHALL contain a property named kind whose value is a string with
  // one of the following values": "inSource", "external".
  if (s.kind !== 'inSource' && s.kind !== 'external') {
    out.push(`${at}.kind: must be "inSource" or "external" (3.35.2)`);
  }
  // 3.35.3 status property: "accepted", "underReview" or "rejected".
  if (
    s.status !== undefined &&
    s.status !== 'accepted' &&
    s.status !== 'underReview' &&
    s.status !== 'rejected'
  ) {
    out.push(`${at}.status: must be "accepted", "underReview" or "rejected" (3.35.3)`);
  }
  // 3.35.6 justification property: "a user-supplied string that explains why the result was suppressed."
  if (s.justification !== undefined && typeof s.justification !== 'string') {
    out.push(`${at}.justification: must be a string (3.35.6)`);
  }
  closed(s, 'suppression', at, out);
  checkProperties(s.properties, at, out);
}

function checkResult(
  result: unknown,
  at: string,
  ruleList: readonly string[],
  bases: ReadonlySet<string>,
  out: Problems,
): void {
  const ruleIds = new Set(ruleList);
  if (!isObj(result)) {
    out.push(`${at}: must be an object (3.27)`);
    return;
  }
  // 3.27.5 ruleId property: "a hierarchical string (3.5.4) whose leading components specify the stable
  // identifier of the rule". tripcurve always writes one, and it must be a rule the driver describes (3.27.6:
  // the rule is described by "a reportingDescriptor object (3.49)" of the tool).
  if (typeof result.ruleId !== 'string') {
    out.push(`${at}.ruleId: must be a string (3.27.5)`);
  } else if (!ruleIds.has(result.ruleId)) {
    out.push(`${at}.ruleId: ${JSON.stringify(result.ruleId)} is not in tool.driver.rules (3.27.6)`);
  }
  // 3.27.6 ruleIndex property: "the array index (3.7.4) of theDescriptor within theComponent.ruleDescriptors";
  // a non-negative integer, and the descriptor at that index must be the rule named by ruleId.
  if (result.ruleIndex !== undefined) {
    if (
      typeof result.ruleIndex !== 'number' ||
      !Number.isInteger(result.ruleIndex) ||
      result.ruleIndex < 0
    ) {
      out.push(`${at}.ruleIndex: must be an integer of 0 or more (3.27.6)`);
    } else if (ruleList[result.ruleIndex] !== result.ruleId) {
      out.push(
        `${at}.ruleIndex: ${result.ruleIndex} is not the index of rule ${JSON.stringify(result.ruleId)} (3.27.6)`,
      );
    }
  }
  closed(result, 'result', at, out);
  // 3.27.10 level property: "If present, the level property SHALL have one of the following values":
  // "warning", "error", "note", "none". tripcurve requires it (see the header): a gate must never guess.
  if (result.level === undefined)
    out.push(`${at}.level: tripcurve always writes a level (3.27.10)`);
  if (
    result.level !== undefined &&
    result.level !== 'warning' &&
    result.level !== 'error' &&
    result.level !== 'note' &&
    result.level !== 'none'
  ) {
    out.push(`${at}.level: must be "warning", "error", "note" or "none" (3.27.10)`);
  }
  // 3.27.11 message property: "A result object SHALL contain a property named message whose value is a message
  // object (3.11)"; 3.11.8: text is "a non-empty string containing a plain text message".
  if (!isObj(result.message)) {
    out.push(`${at}.message: must be an object (3.27.11)`);
  } else {
    if (!isNonEmptyString(result.message.text)) {
      out.push(`${at}.message.text: must be a non-empty string (3.11.8)`);
    } else {
      checkMessageEscapes(result.message.text, `${at}.message.text`, out);
    }
    // 3.11.9 markdown property: "a non-empty string containing a formatted message"; tripcurve writes none.
    if (result.message.markdown !== undefined && !isNonEmptyString(result.message.markdown)) {
      out.push(`${at}.message.markdown: must be a non-empty string (3.11.9)`);
    }
    closed(result.message, 'message', `${at}.message`, out);
  }
  // 3.27.12 locations property: "an array of zero or more location objects (3.28)".
  if (result.locations !== undefined) {
    if (!Array.isArray(result.locations)) out.push(`${at}.locations: must be an array (3.27.12)`);
    else
      result.locations.forEach((l, i) => {
        checkLocation(l, `${at}.locations[${i}]`, bases, out);
      });
  }
  // 3.27.23 suppressions property: "an array of zero or more unique (3.7.3) suppression objects (3.35)".
  if (result.suppressions !== undefined) {
    if (!Array.isArray(result.suppressions)) {
      out.push(`${at}.suppressions: must be an array (3.27.23)`);
    } else {
      result.suppressions.forEach((s, i) => {
        checkSuppression(s, `${at}.suppressions[${i}]`, out);
      });
      if (duplicates(result.suppressions))
        out.push(`${at}.suppressions: elements must be unique (3.27.23)`);
    }
  }
  checkProperties(result.properties, at, out);
}

function checkRun(run: unknown, at: string, out: Problems): void {
  if (!isObj(run)) {
    out.push(`${at}: must be an object (3.14)`);
    return;
  }
  const ruleList: string[] = [];
  closed(run, 'run', at, out);
  const bases = new Set<string>();
  // 3.14.14 originalUriBaseIds property: "an object each of whose property names designates a URI base id and each of
  // whose property values is an artifactLocation object"; "If the artifactLocation object's uri property is a
  // relative reference, its uriBaseId property SHALL be present."
  if (run.originalUriBaseIds !== undefined) {
    if (!isObj(run.originalUriBaseIds)) {
      out.push(`${at}.originalUriBaseIds: must be an object (3.14.14)`);
    } else {
      for (const [id, base] of Object.entries(run.originalUriBaseIds)) {
        bases.add(id);
        const where = `${at}.originalUriBaseIds.${id}`;
        if (!isObj(base)) {
          out.push(`${where}: must be an artifactLocation object (3.14.14)`);
          continue;
        }
        closed(base, 'baseLocation', where, out);
        if (base.uri !== undefined)
          checkArtifactLocation(
            base,
            where,
            new Set(Object.keys(run.originalUriBaseIds)),
            out,
            true,
          );
        if (base.description !== undefined)
          checkMultiformat(base.description, `${where}.description`, out);
      }
    }
  }
  // 3.14.6 tool property: "A run object SHALL contain a property named tool whose value is a tool object (3.18)".
  if (!isObj(run.tool)) {
    out.push(`${at}.tool: must be an object (3.14.6)`);
  } else if (!isObj(run.tool.driver)) {
    // 3.18.2 driver property: "A tool object SHALL contain a property named driver whose value is a toolComponent object".
    out.push(`${at}.tool.driver: must be an object (3.18.2)`);
  } else {
    const driver = run.tool.driver;
    closed(run.tool, 'tool', `${at}.tool`, out);
    closed(driver, 'driver', `${at}.tool.driver`, out);
    // 3.19.8 name property: "A toolComponent object SHALL contain a property named name".
    if (!isNonEmptyString(driver.name))
      out.push(`${at}.tool.driver.name: must be a non-empty string (3.19.8)`);
    if (driver.version !== undefined && typeof driver.version !== 'string') {
      out.push(`${at}.tool.driver.version: must be a string (3.19.13)`);
    }
    // 3.19.23 rules property: "an array of zero or more unique (3.7.3) reportingDescriptor objects (3.49)".
    if (driver.rules !== undefined) {
      if (!Array.isArray(driver.rules)) {
        out.push(`${at}.tool.driver.rules: must be an array (3.19.23)`);
      } else {
        driver.rules.forEach((r, i) => {
          const id = checkRule(r, `${at}.tool.driver.rules[${i}]`, out);
          if (id !== undefined) {
            // The spec lets ids repeat (3.19.23); tripcurve's rules are distinct, so a repeat is a defect here.
            if (ruleList.includes(id))
              out.push(`${at}.tool.driver.rules[${i}].id: ${id} is listed twice`);
          }
          ruleList.push(id ?? '');
        });
      }
    }
  }
  // 3.14.23 results property: "an array of zero or more result objects (3.27)"; tripcurve always writes it.
  if (!Array.isArray(run.results)) {
    out.push(`${at}.results: must be an array (3.14.23)`);
  } else {
    run.results.forEach((r, i) => {
      checkResult(r, `${at}.results[${i}]`, ruleList, bases, out);
    });
  }
  checkProperties(run.properties, at, out);
}

/** The problems found in a SARIF document, as text; an empty list means it is valid for the subset. */
export function validateSarif(doc: unknown): string[] {
  const out: Problems = [];
  if (!isObj(doc)) return ['the log must be an object (3.13)'];
  // 3.13.2 version property: "This string SHALL have the value "2.1.0"."
  if (doc.version !== '2.1.0') out.push('version: must be the string "2.1.0" (3.13.2)');
  // 3.13.4 runs property: "an array of zero or more run objects (3.14)", "an array with at least one element"
  // unless the producer found no data; tripcurve always has a run.
  if (!Array.isArray(doc.runs) || doc.runs.length === 0) {
    out.push('runs: must be an array with at least one run (3.13.4)');
  } else {
    doc.runs.forEach((run, i) => {
      checkRun(run, `runs[${i}]`, out);
    });
  }
  closed(doc, 'log', '$', out);
  checkProperties(doc.properties, '$', out);
  return out;
}
