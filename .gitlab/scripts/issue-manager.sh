#!/bin/bash
set -e

FINDINGS_FILE="filtered-findings.json"
GITLAB_API="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
SCAN_DATE=$(date -u +"%Y-%m-%d")

# Resolve assignee GitLab user ID from username
VULN_ASSIGNEE="${VULN_ASSIGNEE:?VULN_ASSIGNEE CI variable must be set}"
ASSIGNEE_ID=$(curl -s --header "PRIVATE-TOKEN: ${VULN_SCAN_TOKEN}" \
  "${GITLAB_API}/members/all?query=${VULN_ASSIGNEE}" | jq -r --arg u "$VULN_ASSIGNEE" '.[] | select(.username == $u) | .id // empty' | head -1)

if [ -n "$ASSIGNEE_ID" ]; then
  echo "Resolved assignee: ${VULN_ASSIGNEE} -> user ID ${ASSIGNEE_ID}"
else
  echo "WARNING: Could not resolve user ${VULN_ASSIGNEE}, issues will be unassigned"
fi

if [ ! -f "$FINDINGS_FILE" ]; then
  echo "No findings file found"
  exit 0
fi

TOTAL_FINDINGS=$(jq 'length' "$FINDINGS_FILE")
echo "Processing $TOTAL_FINDINGS unique CVE+Package combinations..."

if [ "$TOTAL_FINDINGS" -eq 0 ]; then
  echo "No vulnerabilities found"
  exit 0
fi

# Process each unique CVE+Package combination
jq -c '.[]' "$FINDINGS_FILE" | while read -r vuln; do
  CVE_ID=$(echo "$vuln" | jq -r '.cve')
  PKG_NAME=$(echo "$vuln" | jq -r '.package')
  SEVERITY=$(echo "$vuln" | jq -r '.severity')
  TITLE=$(echo "$vuln" | jq -r '.title')
  FIXED_VER=$(echo "$vuln" | jq -r '.fixedVersion // "N/A"')
  VERSIONS=$(echo "$vuln" | jq -r '.versions | join(", ")')

  echo "Processing: $CVE_ID - $PKG_NAME"

  # Search for existing open issue with this CVE+Package
  SEARCH_RESPONSE=$(curl -s --header "PRIVATE-TOKEN: ${VULN_SCAN_TOKEN}" \
    "${GITLAB_API}/issues?labels=CVE&state=opened&search=${CVE_ID}")

  echo "  Search response type: $(echo "$SEARCH_RESPONSE" | jq -r 'type')"

  # Check if response is an array and find matching issue
  EXISTING_ISSUE=""
  if echo "$SEARCH_RESPONSE" | jq -e 'type == "array"' > /dev/null 2>&1; then
    EXISTING_ISSUE=$(echo "$SEARCH_RESPONSE" | jq -r --arg cve "$CVE_ID" --arg pkg "$PKG_NAME" '[.[] | select(.title | contains($cve) and contains($pkg))] | first | .iid // empty')
  else
    echo "  WARNING: Unexpected API response: $(echo "$SEARCH_RESPONSE" | head -c 200)"
  fi

  if [ -n "$EXISTING_ISSUE" ]; then
    echo "  Found existing issue #$EXISTING_ISSUE, adding comment..."

    COMMENT_BODY="Still present in daily vulnerability scan on **${SCAN_DATE}**

- Package: \`${PKG_NAME}\`
- Affected Versions: \`${VERSIONS}\`
- Fixed Version: \`${FIXED_VER}\`
- Severity: **${SEVERITY}**"

    curl -s --request POST --header "PRIVATE-TOKEN: ${VULN_SCAN_TOKEN}" \
      --header "Content-Type: application/json" \
      --data "$(jq -n --arg body "$COMMENT_BODY" '{body: $body}')" \
      "${GITLAB_API}/issues/${EXISTING_ISSUE}/notes" > /dev/null

    echo "  Updated issue #$EXISTING_ISSUE"
  else
    echo "  Creating new issue..."
    CLEAN_TITLE=$(echo "$TITLE" | sed "s/^${PKG_NAME}: //g; s/^${PKG_NAME}: //g")
    ISSUE_TITLE="[${SEVERITY}] ${CVE_ID} - ${PKG_NAME}: ${CLEAN_TITLE}"
    ISSUE_DESC="| Field | Value |
|-------|-------|
| **CVE** | \`${CVE_ID}\` |
| **Package** | \`${PKG_NAME}\` |
| **Severity** | ${SEVERITY} |
| **Affected Versions** | ${VERSIONS} |
| **Fixed Version** | \`${FIXED_VER}\` |

### Description
${CLEAN_TITLE}

### Remediation
Update \`${PKG_NAME}\` to version \`${FIXED_VER}\` or later.

---
_Detected by daily vulnerability scan on ${SCAN_DATE} · [Pipeline](${CI_PIPELINE_URL:-})_"

    CREATE_RESPONSE=$(curl -s --request POST --header "PRIVATE-TOKEN: ${VULN_SCAN_TOKEN}" \
      --header "Content-Type: application/json" \
      --data "$(jq -n \
        --arg title "$ISSUE_TITLE" \
        --arg desc "$ISSUE_DESC" \
        '{title: $title, description: $desc, labels: ["CVE", "automated"]} | if $aid != "" then .assignee_ids = [($aid | tonumber)] else . end' \
        --arg aid "${ASSIGNEE_ID:-}")" \
      "${GITLAB_API}/issues")

    if echo "$CREATE_RESPONSE" | jq -e '.iid' > /dev/null 2>&1; then
      echo "  Created issue #$(echo "$CREATE_RESPONSE" | jq -r '.iid')"
    else
      echo "  ERROR creating issue: $(echo "$CREATE_RESPONSE" | head -c 300)"
    fi
  fi
done

echo "Issue management complete"
