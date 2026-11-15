// The explain text of each rule: shipped data, in tripcurve's own words, beside the rule
// ids. Nothing here is input text. A rule's quotes are verbatim from the page and date they name
// (docs/research.md section 1 and 3, docs/lookups-b5.txt, measure/results/2026-11-11-lookups-b4.txt);
// the knowledge-base values `--explain` prints are NOT written here: they are generated from the
// knowledge-base data by subject, so this text cannot drift from it.

import type { RuleId } from '../core/index.js';
import type { KbSubject } from '../kb/index.js';

export interface VendorQuote {
  /** Who said it and where, for example `AWS, Application Load Balancer attributes`. */
  readonly source: string;
  /** When the quote was read: a date `YYYY-MM-DD`, or a span with its source. */
  readonly read: string;
  /** Verbatim; `...` marks a cut. */
  readonly quote: string;
  readonly url: string;
}

export interface ExplainEntry {
  readonly rule: RuleId;
  /** What the rule requires, one sentence. */
  readonly statement: string;
  readonly quotes: readonly VendorQuote[];
  /** The knowledge-base subjects whose entries the rule uses; their values are printed from the data. */
  readonly subjects: readonly KbSubject[];
  /** When the rule does not apply, or cannot decide: one fixed sentence each. */
  readonly notApplicable: readonly string[];
  /** Credit to prior art, printed as written (T4 is never described as new). */
  readonly credit?: readonly string[];
}

/**
 * docs/research.md gives no date for the day each quote was read, only that the sweep ran on 2026-10-29
 * with re-checks through 2026-11-02, so that span is what is printed (not a single day).
 */
const RESEARCH_READ = '2026-10-29 to 2026-11-02, research notes';

export const EXPLAIN_ENTRIES: Readonly<Record<RuleId, ExplainEntry>> = {
  T1: {
    rule: 'T1',
    statement:
      "The app's effective idle close must exceed the load balancer's idle timeout. Equal is a FAIL.",
    quotes: [
      {
        source: 'AWS, Application Load Balancer attributes',
        read: RESEARCH_READ,
        quote:
          'We also recommend that you configure the idle timeout of your application to be larger than the idle timeout configured for the load balancer. Otherwise ... the load balancer sends an HTTP 502 Bad Gateway error to the client.',
        url: 'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html',
      },
    ],
    subjects: [
      'alb-idle-timeout',
      'terraform-lb-idle-timeout',
      'cfn-lb-idle-timeout',
      'node-idle-close',
      'node-keepalive-explicit',
      'node-keepalive-buffer-explicit',
      'node-headers-timeout-trap',
      'gunicorn-keepalive',
      'gunicorn-keepalive-explicit',
      'gunicorn-sync-keepalive',
      'uvicorn-keepalive',
      'uvicorn-keepalive-explicit',
      'gunicorn-setting-precedence',
    ],
    notApplicable: [
      'Not applicable when the server closes every connection after each response (the gunicorn sync worker).',
      'Not checked when no load balancer is found for the workload in the checked files.',
      'A CloudFormation load balancer is read (its idle timeout attribute) but is not yet linked to an Ingress, so T1 does not use it: there is no CloudFormation form in tripcurve.yaml.',
      'UNRESOLVED, never PASS or FAIL, when the load balancer idle timeout or the idle close of the server cannot be established from a file, a declaration or a default with a stated basis; a default whose basis is "to be measured" never supports PASS, and there is no measured evidence for a network load balancer.',
    ],
  },
  T2: {
    rule: 'T2',
    statement:
      'A workload behind a load balancer must delay its shutdown after SIGTERM, with a preStop sleep, an in-process drain or a declared drain, so that endpoint removal can propagate before the server stops. A delay of 0 s is not a drain.',
    quotes: [
      {
        source: 'AWS, EKS Best Practices, Load Balancing',
        read: RESEARCH_READ,
        quote: 'can be a simple Exec handler such as `sleep 10`',
        url: 'https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html',
      },
    ],
    subjects: ['lightship-shutdown-delay'],
    notApplicable: [
      'Not checked when no load balancer is found for the workload in the checked files.',
      'UNRESOLVED, never PASS, when a drain exists but its duration cannot be established, or when the Node source that would show a drain is not linked and no preStop delay is found.',
      'tripcurve checks that a delay exists, not that it is long enough; the propagation allowance is printed as an assumption.',
    ],
  },
  T3: {
    rule: 'T3',
    statement:
      'terminationGracePeriodSeconds must be at least the preStop delay + the in-process drain + L + 1 s, where L is the declared longest_request_s, or else the graceful timeout of the server as a ceiling.',
    quotes: [
      {
        source: 'Kubernetes, container lifecycle hooks',
        read: '2026-11-12',
        quote:
          "The Pod's termination grace period countdown begins before the PreStop hook is executed, ... This grace period applies to the total time it takes for both the PreStop hook to execute and for the Container to stop normally.",
        url: 'https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/',
      },
      {
        source: 'gunicorn, settings reference (graceful_timeout)',
        read: '2026-11-12',
        quote:
          'Workers still alive after the timeout (starting from the receipt of the restart signal) are force killed.',
        url: 'https://gunicorn.org/reference/settings/',
      },
    ],
    subjects: [
      'k8s-grace-period',
      'gunicorn-graceful-timeout',
      'gunicorn-graceful-timeout-explicit',
      'uvicorn-graceful-timeout-explicit',
      'lightship-shutdown-delay',
    ],
    notApplicable: [
      'Not checked when no load balancer is found for the workload in the checked files.',
      'NOT EVALUATED when T2 failed for the workload.',
      'UNRESOLVED, never PASS or FAIL, when no ceiling is known and longest_request_s is not declared, or a drain or hook has a duration that cannot be established.',
      'WARN, the worst case, when only the ceiling is known and the grace period does not cover it.',
    ],
  },
  T4: {
    rule: 'T4',
    statement:
      'The visibility timeout of an SQS queue must be at least 6 x the timeout of the Lambda function that reads it + the batching window of the event source mapping. Equal passes.',
    quotes: [
      {
        source: 'AWS, Lambda developer guide, SQS event source',
        read: '2026-11-12',
        quote:
          "We recommend setting your queue's visibility timeout to six times your Event Function timeout, plus the value of MaximumBatchingWindowInSeconds.",
        url: 'https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html',
      },
    ],
    subjects: [
      'terraform-sqs-visibility',
      'terraform-lambda-timeout',
      'cfn-sqs-visibility',
      'cfn-lambda-timeout',
      'lambda-sqs-batching-window',
    ],
    notApplicable: [
      'Applies to a Lambda event source mapping read from Terraform (HCL, JSON or a plan) or from a SAM or CloudFormation template (YAML or JSON; a SAM SQS event is one mapping).',
      'In Terraform source, the mapping links to a queue and a function by a reference to a resource of the same folder, because Terraform reads every file of a folder as one module; a subfolder, a parent folder and a module block are other modules and are never linked.',
      'A number written as integer arithmetic on literals (60 + (30 * 6)) is read exactly, and the expression is printed beside the result.',
      'FAIL when visibility is below 6 x the function timeout, even when the batching window is not set or not known: a window is 0 s or more, so it can only raise the need.',
      'UNRESOLVED, never PASS or FAIL, when the visibility or the function timeout is not established (a value that is not a literal, a queue or function that cannot be linked, an event source that is not an SQS queue). UNRESOLVED too when visibility covers 6 x the timeout and the batching window is not written or not known: only a PASS needs the window (the assumed 0 s is shown and never gives PASS).',
    ],
    credit: [
      "T4 is not new. It is a credited port of the cdk-nag rule LambdaEventSourceSQSVisibilityTimeout (added 2024-11-01, PR #1813; CDK only, without the batching window) and sits beside cfn-lint rule E3505, \"Validate SQS 'VisibilityTimeout' is greater than a function's 'Timeout'\" (CloudFormation only, with a weaker \">\" threshold). Both as recorded in tripcurve's research notes (checked 2026-10-29 to 2026-11-02).",
      'https://github.com/cdklabs/cdk-nag',
      'https://github.com/aws-cloudformation/cfn-lint',
    ],
  },
};
