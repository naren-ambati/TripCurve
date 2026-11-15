// The text of `--help`.

export const HELP_TEXT = `Usage: tripcurve [options] [path]

Checks that timeouts between infrastructure layers are ordered correctly.
Reads files only; never runs your code, makes network calls or sends data.

Arguments:
  path               directory to check, or - for rendered YAML on stdin
                     (default: .)

Options:
  --explain <rule>   explain T1, T2, T3 or T4, then exit
  --format <format>  human, json or sarif (default: human)
  --config <file>    tripcurve.yaml to use (default: tripcurve.yaml at path)
  --verbose          show the full chain under every result
  --no-color         never use colour (NO_COLOR is also honoured)
  --version          print the version
  --help             print this help

Exit codes: 0 clean or "No failures:", 1 not clean, 2 nothing checked or
usage or config error, 3 internal error.
`;
