# CDK Diff Viewer

!!! warning "Experimental"
    This feature is experimental and may change in future releases. Feedback and bug reports are welcome.

The CDK Diff Viewer is a self-contained HTML page generated during the pipeline's Review stage. It provides a consolidated view of all CloudFormation stack diffs across your entire LZA environment, replacing the need to download and inspect individual `.diff` files from S3.

## How it works

When the approval stage is enabled (`enableApprovalStage: true` in the installer), the pipeline's `pre-approval` action:

1. Collects all `.diff` files produced during the Bootstrap stage from S3
2. Runs the diff viewer generator to produce a single `diff-viewer.html` file
3. Uploads the HTML file to the pipeline S3 bucket alongside the raw diffs

The HTML file is entirely self-contained with no external dependencies. All diff content is embedded as a gzip-compressed base64 blob and decompressed client-side.

## Accessing the diff viewer

After the pipeline reaches the Review stage, download the HTML file from S3:

```bash
aws s3 cp s3://<pipeline-bucket>/AWSAccelerator-Pipel/Diffs/<execution-id>/diff-viewer.html ./diff-viewer.html
open diff-viewer.html
```

The S3 path and a download command are printed in the CodeBuild logs for the `pre-approval` action.

## Features

### Stack navigation

Stacks are grouped by section (Logging, Security, NetworkVpc, etc.) in a collapsible sidebar. Click a section header to expand or collapse it. Click a stack name to view its diff.

### Filtering and search

Use the **Filter** button to show stacks by status:

- **Unreviewed** (default) — stacks you haven't reviewed yet
- **Changed** — stacks with meaningful resource changes
- **Unchanged** — stacks with no differences
- **Reviewed** — stacks you've marked as reviewed
- **All** — every stack

The search bar filters by stack name or section name.

### Review tracking

Each stack has a checkbox to mark it as reviewed. Reviewed stacks appear with strikethrough text and reduced opacity. Unchanged stacks are automatically marked as reviewed on load.

### Impact report

Click **CloudFormation Diff Summary** at the top of the sidebar to view an impact report that includes:

- Total resource creates, modifies, and deletes
- High-risk resource changes (VPCs, Transit Gateways, Security Groups, NAT Gateways, Route Tables, Network Firewall, etc.) with counts and affected stacks
- Resource type breakdown with toggleable filters
- Paginated stack table with search and reviewed/unreviewed filtering
- Affected accounts and regions summary

### Color-coded diffs

Diff content is color-coded for readability:

- **Red** — removals (`[-]`) and deleted resources
- **Blue** — additions (`[+]`) and new resources
- **Yellow** — modifications (`[~]`)

IAM Statement Changes tables are also colorized, including continuation rows that belong to a removal or addition block.

Both dark and light themes are available (toggle with the ☀️/🌙 button). Colors are chosen to be accessible for color vision deficiency (red/blue pairing).

## Noise filtering

The diff viewer automatically filters out common no-op changes that appear on every pipeline run but represent no functional difference:

| Change type | Description |
|---|---|
| Lambda S3Key | Asset hash changes when Lambda code is rebuilt. The S3Key diff alone doesn't indicate what changed in the function code, making it low-signal noise in the review. |
| CustomResource uuid | UUID rotation on `AWS::CloudFormation::CustomResource` and `Custom::*` resources. Triggers a custom resource invocation but doesn't change behavior. |

Stacks where **all** changes are noise are marked as unchanged and auto-reviewed. The impact report also excludes these from its counts.

!!! note
    The noise filter operates on the CDK diff output format. If CDK changes its diff output structure in a future version, the filter patterns may need updating.

## Local usage

You can generate the diff viewer locally without running the full pipeline. After synthesizing your stacks:

```bash
cd source/packages/@aws-accelerator/accelerator

# Collect diff files from cdk.out
mkdir -p rawDiff
find cdk.out -name "*.diff" -print0 | xargs -0 -J {} cp {} rawDiff/

# Generate the viewer
yarn run ts-node --cwdMode --transpile-only generate-diff-viewer-cli.ts rawDiff diff-viewer.html
open diff-viewer.html
```

The CLI accepts two arguments: the directory containing `.diff` files and the output HTML file path.

## Limitations

- **Review state is not persisted.** Checked/reviewed stacks are tracked in memory only. Closing or refreshing the HTML file resets all review progress. Unchanged stacks are automatically re-marked on load.
- **Lambda S3Key diffs are hidden, not removed.** The noise filter marks stacks as "unchanged" when the only modifications are Lambda S3Key or CustomResource uuid changes. The raw diff content is still viewable if you click the stack — the filter only affects the changed/unchanged classification and the impact report counts.
- **Large HTML file size.** For environments with 3000+ stacks, the generated HTML file can be 30–50 MB due to the embedded compressed diff blob. Most modern browsers handle this without issue, but opening on low-memory devices may be slow.
- **No cross-file diff comparison.** The viewer shows diffs from a single pipeline execution. It does not compare diffs across multiple executions or show historical trends.
- **ANSI code parsing is best-effort.** The color-coding relies on CDK's current ANSI output format. Mismatched or non-standard ANSI sequences may result in unstyled or incorrectly styled lines. Truncated diff output may produce unclosed color spans.
- **Impact report property detection is limited.** The resource change parser captures properties from lines with box-drawing characters (`└─`, `├─`, `│`). Inline diff sections (e.g., `@@ -19,20 +19,6 @@` blocks) are not parsed for individual property names.
- **Browser compatibility.** The viewer requires a browser that supports `DecompressionStream` (gzip). This includes Chrome 80+, Edge 80+, Firefox 113+, and Safari 16.4+. Internet Explorer is not supported.
