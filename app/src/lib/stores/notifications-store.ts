import {
  Repository,
  isRepositoryWithGitHubRepository,
  RepositoryWithGitHubRepository,
} from '../../models/repository'
import { remote } from 'electron'
import { PullRequest } from '../../models/pull-request'
import { API, APICheckConclusion } from '../api'
import {
  createCombinedCheckFromChecks,
  getLatestCheckRunsByName,
  apiStatusToRefCheck,
  apiCheckRunToRefCheck,
  IRefCheck,
} from '../ci-checks/ci-checks'
import { AccountsStore } from './accounts-store'
import { getCommit } from '../git'
import { GitHubRepository } from '../../models/github-repository'
import { PullRequestCoordinator } from './pull-request-coordinator'
import { Commit } from '../../models/commit'
import {
  AliveStore,
  DesktopAliveEvent,
  IDesktopChecksFailedAliveEvent,
} from './alive-store'
import { setBoolean, getBoolean } from '../local-storage'

type OnChecksFailedCallback = (
  repository: RepositoryWithGitHubRepository,
  pullRequest: PullRequest,
  commitMessage: string,
  commitSha: string,
  checkRuns: ReadonlyArray<IRefCheck>
) => void

/**
 * The localStorage key for whether the user has enabled high-signal
 * notifications.
 */
const NotificationsEnabledKey = 'high-signal-notifications-enabled'

/**
 * This class manages the coordination between Alive events and actual OS-level
 * notifications.
 */
export class NotificationsStore {
  private repository: RepositoryWithGitHubRepository | null = null
  private onChecksFailedCallback: OnChecksFailedCallback | null = null
  private cachedCommits: Map<string, Commit> = new Map()
  private skipCommitShas: Set<string> = new Set()

  public constructor(
    private readonly accountsStore: AccountsStore,
    private readonly aliveStore: AliveStore,
    private readonly pullRequestCoordinator: PullRequestCoordinator
  ) {
    this.aliveStore.setEnabled(this.getNotificationsEnabled())
    this.aliveStore.onAliveEventReceived(this.onAliveEventReceived)
  }

  /** Enables or disables high-signal notifications entirely. */
  public setNotificationsEnabled(enabled: boolean) {
    const previousValue = getBoolean(NotificationsEnabledKey, true)

    if (previousValue === enabled) {
      return
    }

    setBoolean(NotificationsEnabledKey, enabled)
    this.aliveStore.setEnabled(enabled)
  }

  public getNotificationsEnabled() {
    return getBoolean(NotificationsEnabledKey, true)
  }

  private onAliveEventReceived = async (e: DesktopAliveEvent) => {
    switch (e.type) {
      case 'pr-checks-failed':
        return this.handleChecksFailedEvent(e)
    }
  }

  private async handleChecksFailedEvent(event: IDesktopChecksFailedAliveEvent) {
    const repository = this.repository
    if (repository === null) {
      return
    }

    const pullRequests = await this.pullRequestCoordinator.getAllPullRequests(
      repository
    )
    const pullRequest = pullRequests.find(
      pr => pr.pullRequestNumber === event.pull_request_number
    )

    // If the PR is not in cache, it probably means it the checks weren't
    // triggered by a push from Desktop, so we can maybe ignore it?
    if (pullRequest === undefined) {
      return
    }

    const account = await this.getAccountForRepository(
      repository.gitHubRepository
    )

    if (account === null) {
      return
    }

    const commitSHA = event.commit_sha

    if (this.skipCommitShas.has(commitSHA)) {
      return
    }

    const commit =
      this.cachedCommits.get(commitSHA) ??
      (await getCommit(repository, commitSHA))
    if (commit === null) {
      this.skipCommitShas.add(commitSHA)
      return
    }

    this.cachedCommits.set(commitSHA, commit)

    if (!account.emails.map(e => e.email).includes(commit.author.email)) {
      this.skipCommitShas.add(commitSHA)
      return
    }

    const checks = await this.getChecksForRef(repository, pullRequest.head.ref)
    if (checks === null) {
      return
    }

    this.postChecksFailedNotification(
      pullRequest,
      checks,
      commitSHA,
      commit.summary
    )
  }

  /**
   * Makes the store to keep track of the currently selected repository. Only
   * notifications for the currently selected repository will be shown.
   */
  public selectRepository(repository: Repository) {
    this.repository = isRepositoryWithGitHubRepository(repository)
      ? repository
      : null
  }

  private async getAccountForRepository(repository: GitHubRepository) {
    const { endpoint } = repository

    const accounts = await this.accountsStore.getAll()
    return accounts.find(a => a.endpoint === endpoint) ?? null
  }

  private async getAPIForRepository(repository: GitHubRepository) {
    const account = await this.getAccountForRepository(repository)

    if (account === null) {
      return null
    }

    return API.fromAccount(account)
  }

  private postChecksFailedNotification(
    pullRequest: PullRequest,
    checks: ReadonlyArray<IRefCheck>,
    sha: string,
    commitMessage: string
  ) {
    if (this.repository === null) {
      return
    }

    const repository = this.repository

    const numberOfFailedChecks = checks.filter(
      check => check.conclusion === APICheckConclusion.Failure
    ).length

    // Sometimes we could get a checks-failed event for a PR whose checks just
    // got restarted, so we won't get failed checks at that point. In that
    // scenario, just ignore the event and don't show a notification.
    if (numberOfFailedChecks === 0) {
      return
    }

    const pluralChecks =
      numberOfFailedChecks === 1 ? 'check was' : 'checks were'

    const shortSHA = sha.slice(0, 9)
    const title = 'Pull Request checks failed'
    const body = `${pullRequest.title} #${pullRequest.pullRequestNumber} (${shortSHA})\n${numberOfFailedChecks} ${pluralChecks} not successful.`
    const notification = new remote.Notification({
      title,
      body,
    })

    notification.on('click', () => {
      this.onChecksFailedCallback?.(
        repository,
        pullRequest,
        commitMessage,
        sha,
        checks
      )
    })

    notification.show()
  }

  private async getChecksForRef(
    repository: RepositoryWithGitHubRepository,
    ref: string
  ) {
    const { gitHubRepository } = repository
    const { owner, name } = gitHubRepository

    const api = await this.getAPIForRepository(gitHubRepository)

    if (api === null) {
      return null
    }

    const [statuses, checkRuns] = await Promise.all([
      api.fetchCombinedRefStatus(owner.login, name, ref),
      api.fetchRefCheckRuns(owner.login, name, ref),
    ])

    const checks = new Array<IRefCheck>()

    if (statuses === null || checkRuns === null) {
      return null
    }

    if (statuses !== null) {
      checks.push(...statuses.statuses.map(apiStatusToRefCheck))
    }

    if (checkRuns !== null) {
      const latestCheckRunsByName = getLatestCheckRunsByName(
        checkRuns.check_runs
      )
      checks.push(...latestCheckRunsByName.map(apiCheckRunToRefCheck))
    }

    const check = createCombinedCheckFromChecks(checks)

    if (check === null || check.checks.length === 0) {
      return null
    }

    return check.checks
  }

  /** Observe when the user reacted to a "Checks Failed" notification. */
  public onChecksFailedNotification(callback: OnChecksFailedCallback) {
    this.onChecksFailedCallback = callback
  }
}
