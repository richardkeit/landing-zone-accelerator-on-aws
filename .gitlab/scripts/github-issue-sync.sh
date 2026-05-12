#!/bin/bash
# GitHub-to-GitLab Issue Sync
# Mirrors issues from awslabs/landing-zone-accelerator-on-aws (GitHub)
# into the internal GitLab project.
#
# Required CI variable: SYNC_TOKEN (GitLab API token, masked+protected)
# Optional: GITHUB_TOKEN - raises GitHub rate limit from 60/hr to 5000/hr
#           GITHUB_SYNC_ASSIGNEE - GitLab username to auto-assign mirrored issues (triage owner)
#           GITHUB_SYNC_MAX_ISSUES - per-run ceiling (default 200, max 2000)
#           GITHUB_SYNC_RESUME_FROM - only process issues with number <= this value (backfill cursor)
set -euo pipefail

readonly GITHUB_OWNER="${GITHUB_SYNC_OWNER:-awslabs}"
readonly GITHUB_REPO="${GITHUB_SYNC_REPO:-landing-zone-accelerator-on-aws}"
readonly GITHUB_API="https://api.github.com"
readonly GITLAB_API="${CI_API_V4_URL:-https://gitlab.aws.dev/api/v4}/projects/${CI_PROJECT_ID:-11925}"
readonly MIRROR_LABEL="GitHub Issue"
readonly MAX_ISSUES_DEFAULT=200
readonly MAX_ISSUES_CEILING=2000
readonly PAGE_SIZE=100
readonly SUMMARY_FILE="github-sync-summary.json"
readonly FAILED_FILE="failed-items.json"
SYNC_DATE="$(date -u +"%Y-%m-%d")"
readonly SYNC_DATE
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
readonly STARTED_AT
readonly USER_AGENT="LZA-GitHub-Sync"

MAX_ISSUES="${GITHUB_SYNC_MAX_ISSUES:-$MAX_ISSUES_DEFAULT}"
if [[ ! "$MAX_ISSUES" =~ ^[0-9]+$ ]] || [ "$MAX_ISSUES" -lt 1 ] || [ "$MAX_ISSUES" -gt "$MAX_ISSUES_CEILING" ]; then
  echo "ERROR: GITHUB_SYNC_MAX_ISSUES must be an integer in [1, ${MAX_ISSUES_CEILING}]; got '${GITHUB_SYNC_MAX_ISSUES:-}'" >&2
  exit 2
fi
readonly MAX_ISSUES

RESUME_FROM="${GITHUB_SYNC_RESUME_FROM:-}"
if [ -n "$RESUME_FROM" ] && ! [[ "$RESUME_FROM" =~ ^[0-9]+$ ]]; then
  echo "ERROR: GITHUB_SYNC_RESUME_FROM must be a positive integer; got '${RESUME_FROM}'" >&2
  exit 2
fi
readonly RESUME_FROM

declare -i cnt_fetched=0 cnt_prs_filtered=0 cnt_issues_considered=0
declare -i cnt_created=0 cnt_existing=0
declare -i cnt_comments_mirrored=0 cnt_comments_present=0
declare -i cnt_failures_initial=0 cnt_failures_after_retry=0
created_iids=()
updated_iids=()
lowest_processed=""
highest_processed=""

log_info()  { echo "INFO: $*" >&2; }
log_warn()  { echo "WARN: $*" >&2; }
log_error() { echo "ERROR: $*" >&2; }

write_summary_and_banner() {
  local finished_at
  finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local suggested_next="null"
  if [ -n "$lowest_processed" ]; then
    suggested_next=$((lowest_processed - 1))
  fi

  # Build failed_items from file
  local failed_json="[]"
  if [ -f "$FAILED_FILE" ]; then
    failed_json=$(cat "$FAILED_FILE")
  fi

  jq -n \
    --arg run_id "${CI_PIPELINE_ID:-local}" \
    --arg run_url "${CI_PIPELINE_URL:-}" \
    --arg started "$STARTED_AT" \
    --arg finished "$finished_at" \
    --arg gh_repo "${GITHUB_OWNER}/${GITHUB_REPO}" \
    --arg gl_project "${CI_PROJECT_PATH:-landing-zone-accelerator/landing-zone-accelerator-on-aws}" \
    --argjson max_issues "$MAX_ISSUES" \
    --arg resume_from "${RESUME_FROM:-null}" \
    --arg lowest "${lowest_processed:-null}" \
    --arg highest "${highest_processed:-null}" \
    --argjson suggested "$suggested_next" \
    --argjson fetched "$cnt_fetched" \
    --argjson prs "$cnt_prs_filtered" \
    --argjson considered "$cnt_issues_considered" \
    --argjson created "$cnt_created" \
    --argjson existing "$cnt_existing" \
    --argjson comments_new "$cnt_comments_mirrored" \
    --argjson comments_old "$cnt_comments_present" \
    --argjson fail_init "$cnt_failures_initial" \
    --argjson fail_retry "$cnt_failures_after_retry" \
    --argjson created_iids "$(if [ ${#created_iids[@]} -eq 0 ]; then echo '[]'; else printf '%s\n' "${created_iids[@]}" | jq -R 'tonumber' | jq -s '.'; fi)" \
    --argjson updated_iids "$(if [ ${#updated_iids[@]} -eq 0 ]; then echo '[]'; else printf '%s\n' "${updated_iids[@]}" | jq -R 'tonumber' | jq -s '.'; fi)" \
    --argjson failed_items "$failed_json" \
    '{
      run_id: $run_id, run_url: $run_url,
      started_at: $started, finished_at: $finished,
      github_repo: $gh_repo, gitlab_project: $gl_project,
      config: { max_issues: $max_issues, resume_from: (if $resume_from == "null" then null else ($resume_from|tonumber) end) },
      cursor: {
        lowest_github_number_processed: (if $lowest == "null" then null else ($lowest|tonumber) end),
        highest_github_number_processed: (if $highest == "null" then null else ($highest|tonumber) end),
        suggested_next_resume_from: $suggested
      },
      counts: {
        github_items_fetched: $fetched, github_prs_filtered_out: $prs,
        github_issues_considered: $considered,
        mirrors_created: $created, mirrors_found_existing: $existing,
        comments_mirrored: $comments_new, comments_already_present: $comments_old,
        failures_initial: $fail_init, failures_after_retry: $fail_retry
      },
      created_iids: $created_iids, updated_iids: $updated_iids,
      failed_items: $failed_items
    }' > "$SUMMARY_FILE"

  # Banner
  echo "=============================================================="
  echo "  GitHub -> GitLab Sync Summary"
  echo "  run_id:          ${CI_PIPELINE_ID:-local}"
  echo "  run_url:         ${CI_PIPELINE_URL:-n/a}"
  echo "  started / ended: ${STARTED_AT} -> ${finished_at}"
  echo "  max_issues:      ${MAX_ISSUES}"
  echo "  resume_from:     ${RESUME_FROM:-<none>}"
  echo "--------------------------------------------------------------"
  echo "  items_fetched:            ${cnt_fetched}"
  echo "  prs_filtered_out:         ${cnt_prs_filtered}"
  echo "  issues_considered:        ${cnt_issues_considered}"
  echo "  mirrors_created:          ${cnt_created}"
  echo "  mirrors_found_existing:   ${cnt_existing}"
  echo "  comments_mirrored:        ${cnt_comments_mirrored}"
  echo "  comments_already_present: ${cnt_comments_present}"
  echo "  failures_initial:         ${cnt_failures_initial}"
  echo "  failures_after_retry:     ${cnt_failures_after_retry}"
  echo "--------------------------------------------------------------"
  echo "  cursor.lowest_processed:  ${lowest_processed:-null}"
  echo "  cursor.highest_processed: ${highest_processed:-null}"
  echo ""
  if [ -n "$lowest_processed" ]; then
    echo "  NEXT MANUAL RUN:"
    echo "    GITHUB_SYNC_ALLOW_MANUAL=true"
    echo "    GITHUB_SYNC_RESUME_FROM=${suggested_next}"
    echo "    GITHUB_SYNC_MAX_ISSUES=<your_choice>"
  else
    echo "  No further resume required (no items processed OR all caught up)."
  fi
  echo "=============================================================="
  echo "SUMMARY_JSON_BEGIN"
  cat "$SUMMARY_FILE"
  echo ""
  echo "SUMMARY_JSON_END"
}
trap write_summary_and_banner EXIT

ASSIGNEE_ID=""

validate_config() {
  if [ -z "${SYNC_TOKEN:-}" ]; then
    log_error "SYNC_TOKEN CI variable must be set"
    exit 2
  fi
}

gitlab_api() {
  local attempt max_attempts=3 response http_code
  for attempt in $(seq 1 $max_attempts); do
    response=$(curl -s -w '\n%{http_code}' -H @- "$@" <<< "PRIVATE-TOKEN: ${SYNC_TOKEN}")
    http_code=$(echo "$response" | tail -1)
    response=$(echo "$response" | sed '$d')

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      echo "$response"
      return 0
    fi

    # Retry on 5xx or 429
    if [ "$http_code" -ge 500 ] || [ "$http_code" -eq 429 ]; then
      local backoff=$(( 10 * attempt * attempt ))
      log_warn "GitLab HTTP ${http_code}, retrying in ${backoff}s (attempt ${attempt}/${max_attempts})"
      sleep "$backoff"
      continue
    fi

    # Non-retryable error
    log_warn "GitLab API HTTP ${http_code}: $(echo "$response" | head -c 200)"
    return 1
  done

  log_warn "GitLab API exhausted retries"
  return 1
}

github_api() {
  # NOTE: GITHUB_TOKEN must be a masked CI variable. Do not enable set -x in this function.
  local attempt max_attempts=3 response http_code headers_file
  headers_file=$(mktemp)

  for attempt in $(seq 1 $max_attempts); do
    local auth_header=()
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      auth_header=(--header "Authorization: Bearer ${GITHUB_TOKEN}")
    fi

    response=$(curl -s -w '\n%{http_code}' \
      -D "$headers_file" \
      --header "Accept: application/vnd.github.v3+json" \
      --header "User-Agent: ${USER_AGENT}" \
      "${auth_header[@]}" \
      "$@")
    http_code=$(echo "$response" | tail -1)
    response=$(echo "$response" | sed '$d')

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      rm -f "$headers_file"
      echo "$response"
      return 0
    fi

    if [ "$http_code" -eq 403 ] || [ "$http_code" -eq 429 ]; then
      local reset_epoch sleep_time
      reset_epoch=$(grep -i 'x-ratelimit-reset' "$headers_file" | tr -d '\r' | awk '{print $2}' || echo "")
      if [ -n "$reset_epoch" ]; then
        sleep_time=$(( reset_epoch - $(date +%s) + 5 ))
        [ "$sleep_time" -lt 5 ] && sleep_time=5
        [ "$sleep_time" -gt 900 ] && sleep_time=900
      else
        sleep_time=$(( 30 * attempt ))
      fi
      log_warn "GitHub rate limited (HTTP ${http_code}), sleeping ${sleep_time}s (attempt ${attempt}/${max_attempts})"
      sleep "$sleep_time"
      continue
    fi

    if [ "$http_code" -ge 500 ]; then
      local backoff=$(( 10 * attempt ))
      log_warn "GitHub HTTP ${http_code}, retrying in ${backoff}s (attempt ${attempt}/${max_attempts})"
      sleep "$backoff"
      continue
    fi

    rm -f "$headers_file"
    log_warn "GitHub API HTTP ${http_code}: $(echo "$response" | head -c 200)"
    return 1
  done

  rm -f "$headers_file"
  log_warn "GitHub API exhausted retries"
  return 1
}

fetch_recent_github_issues() {
  local collected="[]" page=1 batch filtered

  log_info "fetch: starting (MAX_ISSUES=${MAX_ISSUES}, RESUME_FROM=${RESUME_FROM:-<none>})"
  log_info "fetch: URL=${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues"

  while [ "$(echo "$collected" | jq 'length')" -lt "$MAX_ISSUES" ]; do
    if ! batch=$(github_api "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues?state=all&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}"); then
      log_warn "github page ${page}: API call failed"
      break
    fi

    if ! echo "$batch" | jq -e 'type == "array"' > /dev/null 2>&1; then
      log_warn "github page ${page}: response is not a JSON array, skipping"
      break
    fi

    if [ "$(echo "$batch" | jq 'length')" -eq 0 ]; then
      break
    fi

    local raw_count pr_count resume_count
    raw_count=$(echo "$batch" | jq 'length')

    filtered=$(echo "$batch" | jq '[.[] | select(.pull_request == null)]')
    pr_count=$(( raw_count - $(echo "$filtered" | jq 'length') ))
    cnt_prs_filtered=$(( cnt_prs_filtered + pr_count ))

    if [ -n "$RESUME_FROM" ]; then
      filtered=$(echo "$filtered" | jq --argjson r "$RESUME_FROM" '[.[] | select(.number <= $r)]')
    fi
    resume_count=$(echo "$filtered" | jq 'length')

    log_info "github page ${page} returned ${raw_count} items (after PR filter: $(( raw_count - pr_count )); after resume filter: ${resume_count})"

    collected=$(echo "$collected" "$filtered" | jq -s '.[0] + .[1]')
    cnt_fetched=$(( cnt_fetched + raw_count ))
    page=$(( page + 1 ))

    if [ "$raw_count" -lt "$PAGE_SIZE" ]; then
      break
    fi
  done

  # Write counters to temp file (survives subshell)
  echo "${cnt_fetched} ${cnt_prs_filtered}" > /tmp/github-sync-fetch-counters

  # Trim to MAX_ISSUES
  echo "$collected" | jq --argjson m "$MAX_ISSUES" '.[:$m]'
}

find_existing_mirror() {
  local gh_number=$1
  local search_term="[GitHub #${gh_number}] "
  local encoded_search
  encoded_search=$(printf '%s' "$search_term" | jq -sRr @uri)

  local response iid

  response=$(gitlab_api "${GITLAB_API}/issues?labels=$(printf '%s' "$MIRROR_LABEL" | jq -sRr @uri)&state=all&search=${encoded_search}&in=title&per_page=20") || true
  if [ -n "$response" ]; then
    iid=$(echo "$response" | jq -r --arg prefix "[GitHub #${gh_number}] " \
      '[.[] | select(.title | startswith($prefix))] | sort_by(.iid) | first | .iid // empty')
    if [ -n "$iid" ]; then
      echo "$iid"
      return 0
    fi
  fi

  # Fallback: search for GitHub URL in description (catches manual copies)
  local gh_url="github.com/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${gh_number}"
  local encoded_url
  encoded_url=$(printf '%s' "$gh_url" | jq -sRr @uri)
  response=$(gitlab_api "${GITLAB_API}/issues?state=all&search=${encoded_url}&in=description&per_page=20") || return 1

  iid=$(echo "$response" | jq -r --arg url "$gh_url" \
    '[.[] | select(.description != null and (.description | contains($url)))] | sort_by(.iid) | first | .iid // empty')

  if [ -n "$iid" ]; then
    log_info "gh#${gh_number} -> found manual mirror gl#${iid}, auto-tagging"
    local current_title
    current_title=$(echo "$response" | jq -r --arg url "$gh_url" \
      '[.[] | select(.description != null and (.description | contains($url)))] | sort_by(.iid) | first | .title // empty')
    local new_title="[GitHub #${gh_number}] ${current_title}"
    gitlab_api --request PUT \
      --header "Content-Type: application/json" \
      --data "$(jq -n --arg title "$new_title" --arg labels "$MIRROR_LABEL" '{title: $title, add_labels: $labels}')" \
      "${GITLAB_API}/issues/${iid}" > /dev/null || true
    echo "$iid"
    return 0
  fi
}

format_issue_description() {
  local gh_json=$1
  jq -r --arg pipeline_url "${CI_PIPELINE_URL:-}" --arg sync_date "$SYNC_DATE" '
    def quote_body:
      if . == null or . == "" then "> _No description provided._"
      else split("\n") | map("> " + .) | join("\n")
      end;
    def label_chips:
      if .labels == null or (.labels | length) == 0 then "—"
      else [.labels[].name] | map("`" + . + "`") | join(", ")
      end;

    "<details>\n<summary><strong>Mirrored from GitHub</strong> — <a href=\"\(.html_url)\">#\(.number)</a> by \(.user.login) · opened \(.created_at)</summary>\n\n" +
    "| Field | Value |\n|-------|-------|\n" +
    "| GitHub issue | [#\(.number)](\(.html_url)) |\n" +
    "| Author | <img src=\"\(.user.avatar_url)\" width=\"16\" height=\"16\" /> [\(.user.login)](\(.user.html_url)) |\n" +
    "| Created | `\(.created_at)` |\n" +
    "| Updated | `\(.updated_at)` |\n" +
    "| State on GitHub | `\(.state)` |\n" +
    "| GitHub labels | \(label_chips) |\n\n" +
    "</details>\n\n---\n\n### Original body\n\n" +
    (.body | quote_body) +
    "\n\n---\n\n*Mirrored from [#\(.number)](\(.html_url)) by the nightly sync · [Pipeline](\($pipeline_url)) · \($sync_date)*"
  ' <<< "$gh_json"
}

format_comment_body() {
  local comment_json=$1
  local body
  body=$(jq -r '
    "> **Mirrored GitHub comment** by <img src=\"\(.user.avatar_url)\" width=\"14\" height=\"14\" /> [\(.user.login)](\(.user.html_url)) · \(.created_at) · [view on GitHub](\(.html_url))\n\n" +
    .body +
    "\n\n<!-- github-comment-id: \(.id) -->"
  ' <<< "$comment_json")

  if ! echo "$body" | grep -q "<!-- github-comment-id:"; then
    log_error "format_comment_body failed post-condition (missing marker)"
    exit 3
  fi
  echo "$body"
}

extract_mirrored_comment_ids() {
  local notes_json=$1
  echo "$notes_json" | jq -r '.[].body // ""' | grep -oE 'github-comment-id: [0-9]+' | awk '{print $2}' | sort -u
}

create_mirror_issue() {
  local gh_json=$1
  local gh_number title description payload response new_iid

  gh_number=$(echo "$gh_json" | jq -r '.number')
  title=$(echo "$gh_json" | jq -r '.title' | tr -d '\000-\037')
  title="[GitHub #${gh_number}] ${title}"
  description=$(format_issue_description "$gh_json")

  payload=$(jq -n \
    --arg title "$title" \
    --arg desc "$description" \
    --arg labels "$MIRROR_LABEL" \
    --arg aid "${ASSIGNEE_ID:-}" \
    '{title: $title, description: $desc, labels: $labels} |
     if $aid != "" then .assignee_ids = [($aid | tonumber)] else . end')

  response=$(gitlab_api --request POST \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "${GITLAB_API}/issues") || return 1

  new_iid=$(echo "$response" | jq -r '.iid // empty')
  if [ -z "$new_iid" ]; then
    log_warn "create_mirror_issue: no iid in response for gh#${gh_number}"
    return 1
  fi
  echo "$new_iid"
}

sync_new_comments() {
  local gitlab_iid=$1 gh_number=$2
  local gh_comments="" gl_notes="" page=1 batch

  while true; do
    batch=$(github_api "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${gh_number}/comments?per_page=${PAGE_SIZE}&page=${page}") || break
    if [ "$(echo "$batch" | jq 'length')" -eq 0 ]; then break; fi
    if [ -z "$gh_comments" ]; then gh_comments="$batch"; else
      gh_comments=$(echo "$gh_comments" "$batch" | jq -s '.[0] + .[1]')
    fi
    page=$(( page + 1 ))
  done
  [ -z "$gh_comments" ] && gh_comments="[]"

  page=1
  while true; do
    batch=$(gitlab_api "${GITLAB_API}/issues/${gitlab_iid}/notes?per_page=${PAGE_SIZE}&page=${page}") || break
    if [ "$(echo "$batch" | jq 'length')" -eq 0 ]; then break; fi
    if [ -z "$gl_notes" ]; then gl_notes="$batch"; else
      gl_notes=$(echo "$gl_notes" "$batch" | jq -s '.[0] + .[1]')
    fi
    page=$(( page + 1 ))
  done
  [ -z "$gl_notes" ] && gl_notes="[]"

  local mirrored_ids
  mirrored_ids=$(extract_mirrored_comment_ids "$gl_notes")

  local total_gh posted_this_issue=0 skipped_this_issue=0
  total_gh=$(echo "$gh_comments" | jq 'length')

  while IFS= read -r comment; do
    local cid
    cid=$(echo "$comment" | jq -r '.id')

    if echo "$mirrored_ids" | grep -qw "$cid"; then
      cnt_comments_present=$(( cnt_comments_present + 1 ))
      skipped_this_issue=$(( skipped_this_issue + 1 ))
      continue
    fi

    local body
    body=$(format_comment_body "$comment")

    local note_payload
    note_payload=$(jq -n --arg body "$body" '{body: $body}')

    if gitlab_api --request POST \
      --header "Content-Type: application/json" \
      --data "$note_payload" \
      "${GITLAB_API}/issues/${gitlab_iid}/notes" > /dev/null; then
      cnt_comments_mirrored=$(( cnt_comments_mirrored + 1 ))
      posted_this_issue=$(( posted_this_issue + 1 ))
    else
      record_failure "create_comment" "$gh_number" "$cid" "$gitlab_iid"
    fi
  done < <(echo "$gh_comments" | jq -c 'sort_by(.created_at) | .[]')

  log_info "gh#${gh_number} gl#${gitlab_iid} comments: total=${total_gh} already_mirrored=${skipped_this_issue} posted=${posted_this_issue}"
}

record_failure() {
  local kind=$1 gh_number=$2 comment_id=${3:-} gitlab_iid=${4:-}
  local entry
  entry=$(jq -n \
    --arg kind "$kind" \
    --argjson gh_number "$gh_number" \
    --arg comment_id "$comment_id" \
    --arg gitlab_iid "$gitlab_iid" \
    --arg error "HTTP failure" \
    --arg ts "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{kind: $kind, github_number: $gh_number, error: $error, attempt: 1, timestamp: $ts} |
     if $comment_id != "" then .github_comment_id = ($comment_id|tonumber) else . end |
     if $gitlab_iid != "" then .gitlab_iid = ($gitlab_iid|tonumber) else . end')

  local current="[]"
  [ -f "$FAILED_FILE" ] && current=$(cat "$FAILED_FILE")
  echo "$current" | jq --argjson e "$entry" '. + [$e]' > "$FAILED_FILE"

  cnt_failures_initial=$(( cnt_failures_initial + 1 ))
  log_warn "failed gh#${gh_number} kind=${kind} error=\"HTTP failure\""
}

retry_failed() {
  if [ ! -f "$FAILED_FILE" ] || [ "$(jq 'length' "$FAILED_FILE")" -eq 0 ]; then
    log_info "no failed items to retry"
    return
  fi

  local count
  count=$(jq 'length' "$FAILED_FILE")
  log_info "retrying ${count} failed items"

  while IFS= read -r item; do
    local kind gh_number
    kind=$(echo "$item" | jq -r '.kind')
    gh_number=$(echo "$item" | jq -r '.github_number')

    case "$kind" in
      create_issue)
        # Re-fetch the issue from GitHub and try again
        local gh_json
        if gh_json=$(github_api "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${gh_number}"); then
          if new_iid=$(create_mirror_issue "$gh_json"); then
            created_iids+=("$new_iid")
            cnt_created=$(( cnt_created + 1 ))
            cnt_failures_initial=$(( cnt_failures_initial - 1 ))
            continue
          fi
        fi
        cnt_failures_after_retry=$(( cnt_failures_after_retry + 1 ))
        ;;
      create_comment)
        local gitlab_iid
        gitlab_iid=$(echo "$item" | jq -r '.gitlab_iid')
        if sync_new_comments "$gitlab_iid" "$gh_number" 2>/dev/null; then
          cnt_failures_initial=$(( cnt_failures_initial - 1 ))
        else
          cnt_failures_after_retry=$(( cnt_failures_after_retry + 1 ))
        fi
        ;;
      *)
        cnt_failures_after_retry=$(( cnt_failures_after_retry + 1 ))
        ;;
    esac
  done < <(jq -c '.[]' "$FAILED_FILE")
}

# ─── Main execution ───────────────────────────────────────────────────────────
validate_config

ASSIGNEE_ID=""
if [ -n "${GITHUB_SYNC_ASSIGNEE:-}" ]; then
  ASSIGNEE_ID=$(gitlab_api "${GITLAB_API}/members/all?query=${GITHUB_SYNC_ASSIGNEE}" | \
    jq -r --arg u "$GITHUB_SYNC_ASSIGNEE" '.[] | select(.username == $u) | .id // empty' | head -1) || true
  if [ -n "$ASSIGNEE_ID" ]; then
    log_info "resolved assignee: ${GITHUB_SYNC_ASSIGNEE} -> user ID ${ASSIGNEE_ID}"
  else
    log_warn "could not resolve assignee '${GITHUB_SYNC_ASSIGNEE}', issues will be unassigned"
  fi
fi

log_info "config max_issues=${MAX_ISSUES}"
log_info "config resume_from=${RESUME_FROM:-<none>}"
log_info "github_repo=${GITHUB_OWNER}/${GITHUB_REPO}"
log_info "gitlab_project=${CI_PROJECT_PATH:-landing-zone-accelerator/landing-zone-accelerator-on-aws}"
log_info "assignee=${GITHUB_SYNC_ASSIGNEE:-<unassigned>}"

echo "[]" > "$FAILED_FILE"

issues=$(fetch_recent_github_issues) || issues="[]"
if ! echo "$issues" | jq -e 'type == "array"' > /dev/null 2>&1; then
  issues="[]"
fi
# Recover counters lost in command substitution subshell
if [ -f /tmp/github-sync-fetch-counters ]; then
  read -r cnt_fetched cnt_prs_filtered < /tmp/github-sync-fetch-counters
  rm -f /tmp/github-sync-fetch-counters
fi
cnt_issues_considered=$(echo "$issues" | jq 'length')

while IFS= read -r gh_issue; do
  gh_number=$(echo "$gh_issue" | jq -r '.number')

  if [ -z "$highest_processed" ] || [ "$gh_number" -gt "$highest_processed" ]; then
    highest_processed=$gh_number
  fi
  if [ -z "$lowest_processed" ] || [ "$gh_number" -lt "$lowest_processed" ]; then
    lowest_processed=$gh_number
  fi

  iid=$(find_existing_mirror "$gh_number" 2>/dev/null) || iid=""

  if [ -z "$iid" ]; then
    log_info "gh#${gh_number} -> creating new mirror"
    if new_iid=$(create_mirror_issue "$gh_issue"); then
      log_info "gh#${gh_number} -> created gl#${new_iid}"
      created_iids+=("$new_iid")
      cnt_created=$(( cnt_created + 1 ))
      sync_new_comments "$new_iid" "$gh_number" || true
    else
      record_failure "create_issue" "$gh_number"
    fi
  else
    log_info "gh#${gh_number} -> existing gl#${iid}"
    cnt_existing=$(( cnt_existing + 1 ))
    sync_new_comments "$iid" "$gh_number" || true
    updated_iids+=("$iid")
  fi
done < <(echo "$issues" | jq -c '.[]')

retry_failed

if [ "$cnt_failures_after_retry" -gt 0 ]; then
  exit 1
fi
exit 0
