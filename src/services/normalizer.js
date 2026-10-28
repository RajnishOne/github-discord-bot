import crypto from 'node:crypto';

/**
 * Normalizes GitHub App Webhook events and GitHub Polling API events
 * into a single unified event structure with a deterministic deduplication key.
 */
export class EventNormalizer {
  /**
   * Normalizes an inbound GitHub Webhook
   * @param {string} eventName - e.g. "push", "release", "pull_request", "issues", "watch", "star", "fork", "issue_comment", "pull_request_review", "pull_request_review_comment"
   * @param {object} payload - Webhook JSON body
   */
  static normalizeWebhook(eventName, payload) {
    const repository = payload.repository?.full_name || 'unknown/repository';
    const actor = {
      name: payload.sender?.login || 'unknown',
      avatarUrl: payload.sender?.avatar_url || '',
      url: payload.sender?.html_url || ''
    };

    switch (eventName) {
      case 'release': {
        const release = payload.release || {};
        const tag = release.tag_name || `rel-${release.id}`;
        const action = payload.action || 'published';
        const isPrerelease = Boolean(release.prerelease);
        const releaseType = isPrerelease ? 'Prerelease' : 'Release';

        return {
          dedupKey: `${repository}:release:${release.id || tag}`,
          repository,
          source: 'webhook',
          sourceEventId: String(release.id || tag),
          category: 'release',
          action,
          title: `🚀 ${releaseType} ${tag}: ${release.name || tag} (${action})`,
          description: release.body ? truncate(release.body, 280) : 'No release notes provided.',
          url: release.html_url || `https://github.com/${repository}/releases`,
          actor,
          timestamp: release.published_at || new Date().toISOString(),
          meta: { tag, isPrerelease }
        };
      }

      case 'pull_request': {
        const pr = payload.pull_request || {};
        const action = payload.action || 'opened';
        const isMerged = Boolean(pr.merged) || action === 'closed' && payload.pull_request?.merged_at;
        const displayAction = isMerged ? 'merged' : action;
        const branchInfo = `${pr.head?.ref || 'feature'} → ${pr.base?.ref || 'main'}`;

        return {
          dedupKey: `${repository}:pr:${pr.number}:${displayAction}`,
          repository,
          source: 'webhook',
          sourceEventId: String(pr.id || pr.number),
          category: 'pull_request',
          action: displayAction,
          title: `🔀 PR #${pr.number}: ${pr.title} (${displayAction})`,
          description: `Branches: \`${branchInfo}\`\n${pr.body ? truncate(pr.body, 240) : `Pull request ${displayAction} by ${actor.name}.`}`,
          url: pr.html_url || `https://github.com/${repository}/pull/${pr.number}`,
          actor,
          timestamp: pr.updated_at || pr.created_at || new Date().toISOString(),
          meta: { number: pr.number, branchInfo, isMerged }
        };
      }

      case 'issues': {
        const issue = payload.issue || {};
        // Do not treat pull requests as ordinary issues
        if (issue.pull_request) {
          return null;
        }

        const action = payload.action || 'opened';
        let extraInfo = '';
        if (action === 'assigned' && payload.assignee) {
          extraInfo = `Assigned to @${payload.assignee.login}.`;
        } else if (action === 'labeled' && payload.label) {
          extraInfo = `Labeled with \`${payload.label.name}\`.`;
        } else if (issue.body) {
          extraInfo = truncate(issue.body, 260);
        }

        return {
          dedupKey: `${repository}:issue:${issue.number}:${action}`,
          repository,
          source: 'webhook',
          sourceEventId: String(issue.id || issue.number),
          category: 'issue',
          action,
          title: `🐛 Issue #${issue.number}: ${issue.title} (${action})`,
          description: extraInfo || `Issue ${action} by ${actor.name}.`,
          url: issue.html_url || `https://github.com/${repository}/issues/${issue.number}`,
          actor,
          timestamp: issue.updated_at || issue.created_at || new Date().toISOString(),
          meta: { number: issue.number }
        };
      }

      case 'issue_comment': {
        const action = payload.action || 'created';
        // Avoid notifications for edited or deleted comments by default
        if (action !== 'created') {
          return null;
        }

        const comment = payload.comment || {};
        const issue = payload.issue || {};
        const isPR = Boolean(issue.pull_request);
        const itemType = isPR ? 'PR' : 'Issue';

        return {
          dedupKey: `${repository}:comment:${comment.id}`,
          repository,
          source: 'webhook',
          sourceEventId: String(comment.id),
          category: 'comment',
          action: 'created',
          title: `💬 New comment on ${itemType} #${issue.number}: ${issue.title}`,
          description: comment.body ? truncate(comment.body, 280) : 'New comment submitted.',
          url: comment.html_url || issue.html_url,
          actor,
          timestamp: comment.created_at || new Date().toISOString(),
          meta: { issueNumber: issue.number, isPR }
        };
      }

      case 'pull_request_review': {
        const action = payload.action || 'submitted';
        if (action !== 'submitted') {
          return null;
        }

        const review = payload.review || {};
        const pr = payload.pull_request || {};
        const state = (review.state || 'commented').toLowerCase();

        let stateLabel = 'Reviewed';
        if (state === 'approved') stateLabel = 'Approved ✅';
        else if (state === 'changes_requested') stateLabel = 'Changes Requested ⚠️';
        else stateLabel = 'Commented 💬';

        return {
          dedupKey: `${repository}:review:${review.id}`,
          repository,
          source: 'webhook',
          sourceEventId: String(review.id),
          category: 'review',
          action: state,
          title: `👀 PR #${pr.number} Review: ${stateLabel}`,
          description: review.body ? truncate(review.body, 280) : `Review state: ${state} by ${actor.name}.`,
          url: review.html_url || pr.html_url,
          actor,
          timestamp: review.submitted_at || new Date().toISOString(),
          meta: { prNumber: pr.number, state }
        };
      }

      case 'pull_request_review_comment': {
        const action = payload.action || 'created';
        if (action !== 'created') {
          return null;
        }

        const comment = payload.comment || {};
        const pr = payload.pull_request || {};

        return {
          dedupKey: `${repository}:review_comment:${comment.id}`,
          repository,
          source: 'webhook',
          sourceEventId: String(comment.id),
          category: 'review',
          action: 'commented_diff',
          title: `💬 Diff review comment on PR #${pr.number}: ${pr.title}`,
          description: comment.body ? truncate(comment.body, 280) : 'Inline code review comment.',
          url: comment.html_url || pr.html_url,
          actor,
          timestamp: comment.created_at || new Date().toISOString(),
          meta: { prNumber: pr.number }
        };
      }

      case 'watch':
      case 'star': {
        const action = payload.action || 'started';
        const isStarred = action === 'started' || action === 'created';
        const actionText = isStarred ? 'starred' : 'unstarred';

        return {
          dedupKey: `${repository}:star:${actor.name}:${actionText}`,
          repository,
          source: 'webhook',
          sourceEventId: `star-${actor.name}-${actionText}`,
          category: 'star',
          action: actionText,
          title: `${isStarred ? '⭐ Starred' : '☆ Unstarred'} by ${actor.name}`,
          description: `${actor.name} ${actionText} ${repository}`,
          url: `https://github.com/${repository}`,
          actor,
          timestamp: new Date().toISOString()
        };
      }

      case 'fork': {
        const forkee = payload.forkee || {};
        return {
          dedupKey: `${repository}:fork:${forkee.full_name || actor.name}`,
          repository,
          source: 'webhook',
          sourceEventId: String(forkee.id || actor.name),
          category: 'fork',
          action: 'forked',
          title: `🍴 Forked by ${actor.name}`,
          description: `Forked to ${forkee.full_name || `${actor.name}/${repository.split('/')[1]}`}`,
          url: forkee.html_url || `https://github.com/${repository}`,
          actor,
          timestamp: forkee.created_at || new Date().toISOString()
        };
      }

      case 'push': {
        const ref = payload.ref || 'refs/heads/main';
        const branch = ref.replace('refs/heads/', '');
        const headSha = payload.head_commit?.id || payload.after || 'unknown';
        const shortSha = headSha.substring(0, 7);
        const commitsCount = payload.commits ? payload.commits.length : 1;
        const commitMsg = payload.head_commit?.message || 'New commit(s)';

        return {
          dedupKey: `${repository}:push:${headSha}`,
          repository,
          source: 'webhook',
          sourceEventId: headSha,
          category: 'push',
          action: 'pushed',
          title: `💻 Pushed ${commitsCount} commit(s) to ${branch} [${shortSha}]`,
          description: truncate(commitMsg, 280),
          url: payload.compare || payload.head_commit?.url || `https://github.com/${repository}/commit/${headSha}`,
          actor,
          timestamp: payload.head_commit?.timestamp || new Date().toISOString()
        };
      }

      default:
        return null;
    }
  }

  /**
   * Normalizes an event from GitHub's Polling Public Events API
   * @param {object} event - GitHub Event Object from /repos/{owner}/{repo}/events
   */
  static normalizePollingEvent(event, repositoryName) {
    const repository = repositoryName || event.repo?.name || 'unknown/repository';
    const actor = {
      name: event.actor?.login || 'unknown',
      avatarUrl: event.actor?.avatar_url || '',
      url: `https://github.com/${event.actor?.login || ''}`
    };

    const type = event.type;
    const payload = event.payload || {};
    const timestamp = event.created_at || new Date().toISOString();

    switch (type) {
      case 'ReleaseEvent': {
        const release = payload.release || {};
        const tag = release.tag_name || `rel-${release.id}`;
        const action = payload.action || 'published';
        const isPrerelease = Boolean(release.prerelease);

        return {
          dedupKey: `${repository}:release:${release.id || tag}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'release',
          action,
          title: `🚀 ${isPrerelease ? 'Prerelease' : 'Release'} ${tag}: ${release.name || tag} (${action})`,
          description: release.body ? truncate(release.body, 280) : 'No release notes provided.',
          url: release.html_url || `https://github.com/${repository}/releases`,
          actor,
          timestamp,
          meta: { tag, isPrerelease }
        };
      }

      case 'PullRequestEvent': {
        const pr = payload.pull_request || {};
        const action = payload.action || 'opened';
        const isMerged = Boolean(pr.merged) || action === 'closed' && pr.merged_at;
        const displayAction = isMerged ? 'merged' : action;

        return {
          dedupKey: `${repository}:pr:${pr.number}:${displayAction}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'pull_request',
          action: displayAction,
          title: `🔀 PR #${pr.number}: ${pr.title} (${displayAction})`,
          description: pr.body ? truncate(pr.body, 280) : `Pull request ${displayAction} by ${actor.name}.`,
          url: pr.html_url || `https://github.com/${repository}/pull/${pr.number}`,
          actor,
          timestamp,
          meta: { number: pr.number, isMerged }
        };
      }

      case 'IssuesEvent': {
        const issue = payload.issue || {};
        if (issue.pull_request) return null;

        const action = payload.action || 'opened';
        return {
          dedupKey: `${repository}:issue:${issue.number}:${action}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'issue',
          action,
          title: `🐛 Issue #${issue.number}: ${issue.title} (${action})`,
          description: issue.body ? truncate(issue.body, 280) : `Issue ${action} by ${actor.name}.`,
          url: issue.html_url || `https://github.com/${repository}/issues/${issue.number}`,
          actor,
          timestamp,
          meta: { number: issue.number }
        };
      }

      case 'IssueCommentEvent': {
        const action = payload.action || 'created';
        if (action !== 'created') return null;

        const comment = payload.comment || {};
        const issue = payload.issue || {};
        const isPR = Boolean(issue.pull_request);

        return {
          dedupKey: `${repository}:comment:${comment.id}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'comment',
          action: 'created',
          title: `💬 New comment on ${isPR ? 'PR' : 'Issue'} #${issue.number}: ${issue.title}`,
          description: comment.body ? truncate(comment.body, 280) : 'New comment submitted.',
          url: comment.html_url || issue.html_url,
          actor,
          timestamp,
          meta: { issueNumber: issue.number, isPR }
        };
      }

      case 'PullRequestReviewEvent': {
        const review = payload.review || {};
        const pr = payload.pull_request || {};
        const state = (review.state || 'commented').toLowerCase();

        return {
          dedupKey: `${repository}:review:${review.id}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'review',
          action: state,
          title: `👀 PR #${pr.number} Review: ${state.toUpperCase()}`,
          description: review.body ? truncate(review.body, 280) : `Review state: ${state} by ${actor.name}.`,
          url: review.html_url || pr.html_url,
          actor,
          timestamp,
          meta: { prNumber: pr.number, state }
        };
      }

      case 'WatchEvent': {
        return {
          dedupKey: `${repository}:star:${actor.name}:starred`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'star',
          action: 'starred',
          title: `⭐ Starred by ${actor.name}`,
          description: `${actor.name} starred ${repository}`,
          url: `https://github.com/${repository}`,
          actor,
          timestamp
        };
      }

      case 'ForkEvent': {
        const forkee = payload.forkee || {};
        return {
          dedupKey: `${repository}:fork:${forkee.full_name || actor.name}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'fork',
          action: 'forked',
          title: `🍴 Forked by ${actor.name}`,
          description: `Forked to ${forkee.full_name || `${actor.name}/${repository.split('/')[1]}`}`,
          url: forkee.html_url || `https://github.com/${repository}`,
          actor,
          timestamp
        };
      }

      case 'PushEvent': {
        const ref = payload.ref || 'refs/heads/main';
        const branch = ref.replace('refs/heads/', '');
        const headSha = payload.head || payload.commits?.[payload.commits.length - 1]?.sha || String(event.id);
        const shortSha = headSha.substring(0, 7);
        const commitsCount = payload.size || (payload.commits ? payload.commits.length : 1);
        const commitMsg = payload.commits?.[0]?.message || 'New commit(s)';

        return {
          dedupKey: `${repository}:push:${headSha}`,
          repository,
          source: 'polling',
          sourceEventId: String(event.id),
          category: 'push',
          action: 'pushed',
          title: `💻 Pushed ${commitsCount} commit(s) to ${branch} [${shortSha}]`,
          description: truncate(commitMsg, 280),
          url: `https://github.com/${repository}/commit/${headSha}`,
          actor,
          timestamp
        };
      }

      default:
        return null;
    }
  }

  /**
   * Verifies GitHub Webhook HMAC sha256 signature against exact raw body bytes
   */
  static verifyWebhookSignature(payloadBody, signatureHeader, secret) {
    if (!secret || !signatureHeader) {
      return false;
    }
    const hmac = crypto.createHmac('sha256', secret);
    const digest = `sha256=${hmac.update(payloadBody).digest('hex')}`;
    try {
      return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
    } catch {
      return false;
    }
  }
}

function truncate(str, maxLen = 280) {
  if (!str) return '';
  const clean = str.replace(/[\r\n]+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}
