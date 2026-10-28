export class PrivateRepositoryError extends Error {
  constructor(message = 'GitHub Discord Bot strictly rejects private repositories.') {
    super(message);
    this.name = 'PrivateRepositoryError';
    this.statusCode = 400;
  }
}

export class RepositoryNotFoundError extends Error {
  constructor(repoName) {
    super(`Repository "${repoName}" was not found on GitHub.`);
    this.name = 'RepositoryNotFoundError';
    this.statusCode = 404;
  }
}

export class GitHubRateLimitError extends Error {
  constructor(message, resetTime, retryAfter) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.statusCode = 429;
    this.resetTime = resetTime;
    this.retryAfter = retryAfter;
  }
}

export class GitHubService {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.token = options.token || null;
    this.userAgent = options.userAgent || 'GitHub-Discord-Bot/1.0';
    this.baseUrl = options.baseUrl || 'https://api.github.com';
  }

  setToken(token) {
    this.token = token;
  }

  getHeaders(customHeaders = {}) {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
      ...customHeaders
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Parses various formats of repository identifier:
   * - "owner/repo"
   * - "https://github.com/owner/repo"
   * - "http://github.com/owner/repo"
   * - "github.com/owner/repo"
   * - "git@github.com:owner/repo.git"
   */
  static parseRepoInput(input) {
    if (!input || typeof input !== 'string') {
      throw new Error('Repository input is required.');
    }

    let cleaned = input.trim();

    // Remove trailing slashes and .git
    cleaned = cleaned.replace(/\.git\/?$/, '').replace(/\/+$/, '');

    // Match URL or git SSH formats
    const urlPattern = /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/;
    const sshPattern = /git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/;
    const shortPattern = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

    let match = cleaned.match(urlPattern) || cleaned.match(sshPattern) || cleaned.match(shortPattern);

    if (!match) {
      throw new Error(`Invalid GitHub repository format: "${input}". Use "owner/repo" or "https://github.com/owner/repo".`);
    }

    const owner = match[1];
    const name = match[2];

    return {
      owner,
      name,
      fullName: `${owner}/${name}`
    };
  }

  /**
   * Verifies that a repository exists and is strictly PUBLIC.
   * Throws PrivateRepositoryError if repository is private.
   */
  async verifyRepository(owner, repo) {
    const url = `${this.baseUrl}/repos/${owner}/${repo}`;
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    const rateLimit = this.extractRateLimitHeaders(response.headers);

    if (response.status === 404) {
      throw new RepositoryNotFoundError(`${owner}/${repo}`);
    }

    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new GitHubRateLimitError(
        `GitHub API rate limit exceeded while verifying ${owner}/${repo}.`,
        rateLimit.reset,
        retryAfter ? parseInt(retryAfter, 10) : null
      );
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${errBody}`);
    }

    const data = await response.json();

    // Strict validation: Reject private repositories
    if (data.private === true || data.visibility === 'private' || data.visibility === 'internal') {
      throw new PrivateRepositoryError(
        `Repository "${owner}/${repo}" is private. GitHub Discord Bot strictly monitors public repositories only.`
      );
    }

    return {
      id: data.id,
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      description: data.description || '',
      stars: data.stargazers_count || 0,
      forks: data.forks_count || 0,
      openIssues: data.open_issues_count || 0,
      defaultBranch: data.default_branch || 'main',
      isPrivate: false,
      rateLimit
    };
  }

  /**
   * Automatically discovers public repositories owned by the authenticated user/installation.
   * Strictly filters out any private repos.
   */
  async discoverOwnedRepositories() {
    if (!this.token) {
      return { repos: [], error: 'Authentication token required to discover owned repositories.' };
    }

    const url = `${this.baseUrl}/user/repos?type=owner&visibility=public&per_page=100&sort=created&direction=desc`;
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to discover user repositories (${response.status}): ${text}`);
    }

    const list = await response.json();
    const publicOwned = list
      .filter(repo => repo.private === false && repo.visibility !== 'private')
      .map(repo => ({
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || '',
        stars: repo.stargazers_count || 0,
        forks: repo.forks_count || 0,
        defaultBranch: repo.default_branch || 'main',
        isPrivate: false,
        createdAt: repo.created_at
      }));

    return { repos: publicOwned, rateLimit: this.extractRateLimitHeaders(response.headers) };
  }

  /**
   * Polls repository events using conditional HTTP requests with ETag.
   * If-None-Match returns 304 Not Modified without full payload.
   */
  async pollRepositoryEvents(repo) {
    const url = `${this.baseUrl}/repos/${repo.owner}/${repo.name}/events?per_page=30`;
    const customHeaders = {};

    if (repo.last_etag) {
      customHeaders['If-None-Match'] = repo.last_etag;
    }

    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: this.getHeaders(customHeaders)
    });

    const rateLimit = this.extractRateLimitHeaders(response.headers);

    // 304 Not Modified: Cache is fresh, 0 new events to parse
    if (response.status === 304) {
      return {
        notModified: true,
        events: [],
        etag: repo.last_etag,
        rateLimit
      };
    }

    if (response.status === 404) {
      return {
        notFound: true,
        events: [],
        rateLimit,
        error: `Repository ${repo.full_name} not found or deleted.`
      };
    }

    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      return {
        rateLimited: true,
        events: [],
        rateLimit,
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : null,
        error: 'Rate limit reached on GitHub API.'
      };
    }

    if (!response.ok) {
      const text = await response.text();
      return {
        failed: true,
        events: [],
        rateLimit,
        error: `GitHub API error (${response.status}): ${text}`
      };
    }

    const newEtag = response.headers.get('etag');
    const rawEvents = await response.json();

    // Filter to only new events beyond last_event_id
    let newEvents = rawEvents;
    if (repo.last_event_id) {
      const index = rawEvents.findIndex(e => String(e.id) === String(repo.last_event_id));
      if (index !== -1) {
        newEvents = rawEvents.slice(0, index);
      }
    }

    const latestEventId = rawEvents.length > 0 ? String(rawEvents[0].id) : repo.last_event_id;

    return {
      notModified: false,
      events: newEvents,
      latestEventId,
      etag: newEtag || repo.last_etag,
      rateLimit
    };
  }

  /**
   * Fetches the current GitHub rate limit allocation.
   */
  async getRateLimitStatus() {
    const url = `${this.baseUrl}/rate_limit`;
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getHeaders()
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      return {
        limit: data.rate.limit,
        remaining: data.rate.remaining,
        reset: data.rate.reset,
        used: data.rate.used
      };
    } catch {
      return null;
    }
  }

  extractRateLimitHeaders(headers) {
    if (!headers) return null;
    const limit = headers.get ? headers.get('x-ratelimit-limit') : headers['x-ratelimit-limit'];
    const remaining = headers.get ? headers.get('x-ratelimit-remaining') : headers['x-ratelimit-remaining'];
    const reset = headers.get ? headers.get('x-ratelimit-reset') : headers['x-ratelimit-reset'];
    const used = headers.get ? headers.get('x-ratelimit-used') : headers['x-ratelimit-used'];

    return {
      limit: limit ? parseInt(limit, 10) : null,
      remaining: remaining ? parseInt(remaining, 10) : null,
      reset: reset ? parseInt(reset, 10) : null,
      used: used ? parseInt(used, 10) : null
    };
  }
}
