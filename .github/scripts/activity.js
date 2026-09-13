#!/usr/bin/env node
/**
 * Rewrites the block between <!-- ACTIVITY:START --> and <!-- ACTIVITY:END --> in
 * README.md with the most recent public GitHub activity.
 *
 * No third-party action involved: one authenticated API call, a formatter, a file write.
 * Exits 0 and leaves the file untouched if nothing changed, so the workflow produces
 * no empty commits.
 *
 * Usage: node .github/scripts/activity.js
 * Env:   GITHUB_TOKEN (optional, raises the rate limit), GH_USERNAME (defaults below)
 *
 * Note the variable is GH_USERNAME, not USERNAME: Windows defines USERNAME itself, so
 * reading it would silently query whoever happens to be logged in.
 */

const fs = require('fs');
const path = require('path');

const USER = process.env.GH_USERNAME || 'PravAl2028';
const README = path.join(process.cwd(), 'README.md');
const START = '<!-- ACTIVITY:START -->';
const END = '<!-- ACTIVITY:END -->';
const MAX_ROWS = 6;

const headers = {
  'Accept': 'application/vnd.github+json',
  'User-Agent': `${USER}-profile-activity`,
};
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

/** Relative time, in the clipped vocabulary a log line wants. */
function ago(iso) {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [604800, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [size, label] of units) {
    if (secs >= size) return `${Math.floor(secs / size)}${label} ago`;
  }
  return 'just now';
}

/** One event -> one line, or null for event types not worth a row. */
function describe(ev) {
  const repo = ev.repo && ev.repo.name ? ev.repo.name.split('/')[1] : null;
  if (!repo) return null;
  const link = `[\`${repo}\`](https://github.com/${ev.repo.name})`;

  switch (ev.type) {
    case 'PushEvent': {
      const n = (ev.payload.commits || []).length || ev.payload.size || 1;
      const head = (ev.payload.commits || [])[0];
      const subject = head && head.message ? head.message.split('\n')[0].slice(0, 72) : null;
      const branch = (ev.payload.ref || '').replace('refs/heads/', '');
      const commits = `${n} commit${n === 1 ? '' : 's'}`;
      return subject
        ? `pushed ${commits} to ${link}${branch ? ` \`${branch}\`` : ''} — ${subject}`
        : `pushed ${commits} to ${link}`;
    }
    case 'CreateEvent':
      if (ev.payload.ref_type === 'repository') return `created ${link}`;
      if (ev.payload.ref_type === 'branch') return `branched \`${ev.payload.ref}\` in ${link}`;
      if (ev.payload.ref_type === 'tag') return `tagged \`${ev.payload.ref}\` in ${link}`;
      return null;
    case 'PullRequestEvent': {
      const pr = ev.payload.pull_request || {};
      const verb = ev.payload.action === 'closed' && pr.merged ? 'merged' : ev.payload.action;
      return `${verb} PR [#${ev.payload.number}](${pr.html_url || '#'}) in ${link}`;
    }
    case 'IssuesEvent': {
      const iss = ev.payload.issue || {};
      return `${ev.payload.action} issue [#${iss.number}](${iss.html_url || '#'}) in ${link}`;
    }
    case 'IssueCommentEvent': {
      const iss = ev.payload.issue || {};
      return `commented on [#${iss.number}](${iss.html_url || '#'}) in ${link}`;
    }
    case 'ReleaseEvent':
      return `released \`${(ev.payload.release || {}).tag_name || '?'}\` of ${link}`;
    case 'WatchEvent':
      return `starred ${link}`;
    case 'ForkEvent':
      return `forked ${link}`;
    case 'PublicEvent':
      return `made ${link} public`;
    case 'MemberEvent':
      return `joined ${link} as a collaborator`;
    default:
      return null;
  }
}

async function main() {
  const res = await fetch(
    `https://api.github.com/users/${USER}/events/public?per_page=100`,
    { headers }
  );
  if (!res.ok) {
    console.error(`GitHub API returned ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const events = await res.json();

  const rows = [];
  const seen = new Set();
  for (const ev of events) {
    const text = describe(ev);
    if (!text) continue;
    // Collapse repeated pushes to the same repo within the same feed.
    const key = `${ev.type}:${ev.repo && ev.repo.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`| \`${ago(ev.created_at)}\` | ${text} |`);
    if (rows.length >= MAX_ROWS) break;
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const block = rows.length
    ? [
        '| when | what |',
        '|---|---|',
        ...rows,
        '',
        `<sub>Rebuilt automatically at ${stamp}. Six most recent distinct public events.</sub>`,
      ].join('\n')
    : `_No public activity in the recent feed. Last checked ${stamp}._`;

  const original = fs.readFileSync(README, 'utf8');
  const si = original.indexOf(START);
  const ei = original.indexOf(END);
  if (si === -1 || ei === -1) {
    console.error(`Markers ${START} / ${END} not found in README.md — nothing to do.`);
    process.exit(1);
  }

  const updated =
    original.slice(0, si + START.length) + '\n' + block + '\n' + original.slice(ei);

  if (updated === original) {
    console.log('Activity block already current — no write.');
    return;
  }
  fs.writeFileSync(README, updated);
  console.log(`Activity block updated with ${rows.length} row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
