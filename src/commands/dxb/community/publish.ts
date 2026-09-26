// _______________This Code was generated using GenAI tool : Codify, Please check for accuracy_______________
import { execSync as exec } from 'node:child_process';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { Duration, sleep } from '@salesforce/kit';
import { Connection } from 'jsforce';
import colors from '@colors/colors';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('dxb', 'community.publish');

// Terminal Status values on BackgroundOperation that stop the poll loop.
const TERMINAL_STATUSES = ['Completed', 'Complete', 'Error'];

type BackgroundOperationRecord = {
  Id: string;
  Status: string;
};

type PollResult = {
  status: string | undefined;
  timedOut: boolean;
};

export type CommunityPublishJobResult = {
  name: string;
  jobId?: string;
  status?: string;
  timedOut: boolean;
  elapsedMs: number;
};

export type CommunityPublishResult = {
  success: boolean;
  jobs: CommunityPublishJobResult[];
};

export default class CommunityPublish extends SfCommand<CommunityPublishResult> {
  public static readonly summary = messages.getMessage('summary');

  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    name: Flags.string({ char: 'n', summary: messages.getMessage('flags.name.summary'), multiple: true }),
    poll: Flags.boolean({
      char: 'w',
      summary: messages.getMessage('flags.poll.summary'),
      default: false,
    }),
    'poll-interval': Flags.duration({
      unit: 'seconds',
      char: 'i',
      summary: messages.getMessage('flags.poll-interval.summary'),
      defaultValue: 5,
      min: 1,
    }),
    'poll-timeout': Flags.duration({
      unit: 'seconds',
      char: 'o',
      summary: messages.getMessage('flags.poll-timeout.summary'),
      defaultValue: 600,
      min: 1,
    }),
  };

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  public static readonly requiresProject = true;

  public async run(): Promise<CommunityPublishResult> {
    const { flags } = await this.parse(CommunityPublish);
    const name = flags.name;
    const username = flags['target-org']?.getUsername();
    const poll = flags.poll;
    const pollInterval = flags['poll-interval'] as Duration;
    const pollTimeout = flags['poll-timeout'] as Duration;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const connection = flags['target-org']!.getConnection();

    const overallStart = Date.now();
    this.styledHeader(messages.getMessage('header.title'));
    this.logHuman(messages.getMessage('info.publishing', [username ?? 'target org']));
    this.logHuman('');

    const communityNames = name ?? this.getLiveCommunityNames(username);
    const jobs: CommunityPublishJobResult[] = [];
    let hasFailure = false;

    for (const elem of communityNames) {
      // Publish jobs run sequentially and (when polling) wait for one job to reach a terminal
      // Status before the next one is submitted, to avoid publish locking errors on the org.
      // eslint-disable-next-line no-await-in-loop
      const job = await this.publishOne(elem, username, poll, connection, pollInterval, pollTimeout);
      jobs.push(job);
      if (job.timedOut || job.status === 'Error') {
        hasFailure = true;
      }
    }

    this.renderPublishResultsTable(jobs);

    const overallStatusLabel = hasFailure ? 'Failed' : 'Succeeded';
    const overallStatusColor = hasFailure ? colors.red : colors.green;
    this.logHuman('');
    this.logHuman(`${messages.getMessage('label.status')} ${colors.bold(overallStatusColor(overallStatusLabel))}`);
    this.logHuman(`${messages.getMessage('label.elapsed')} ${this.formatElapsed(Date.now() - overallStart)}`);

    return { success: !hasFailure, jobs };
  }

  /**
   * Queries all "Live" Network (community) names on the target org. Used when --name is not
   * supplied, so that every live community gets published.
   */
  private getLiveCommunityNames(username: string | undefined): string[] {
    const allcommunities = JSON.parse(
      exec(
        `sf data query --query "SELECT Name FROM Network WHERE Status = 'Live'" --result-format json --target-org ${username}`
      ).toString()
    );
    const records: Array<{ Name: string }> = allcommunities?.result?.records ?? [];
    return records.map((r) => r.Name);
  }

  /**
   * Submits the publish job for a single community and, when polling is enabled, waits for the
   * resulting BackgroundOperation record to reach a terminal Status before returning. Renders a
   * sequential stage checklist (spinner per stage) plus a Status/Elapsed Time summary, similar to
   * the "sf project retrieve start" output.
   */
  private async publishOne(
    communityName: string,
    username: string | undefined,
    poll: boolean,
    connection: Connection,
    pollInterval: Duration,
    pollTimeout: Duration
  ): Promise<CommunityPublishJobResult> {
    const overallStart = Date.now();
    this.logHuman(colors.bold(communityName));

    let stageStart = Date.now();
    this.spinner.start(messages.getMessage('spinner.start.preparing'));
    const command = `sf community publish --name "${communityName}" --target-org ${username} --json`;
    this.spinner.stop(`${messages.getMessage('spinner.stop.preparing')} ${this.formatElapsed(Date.now() - stageStart)}`);

    stageStart = Date.now();
    this.spinner.start(messages.getMessage('spinner.start.sending'));
    const raw = exec(command).toString();
    const parsed = JSON.parse(raw);
    const result = parsed?.result ?? {};
    const jobId: string | undefined = result.jobId;
    this.spinner.stop(`${messages.getMessage('spinner.stop.sending')} ${this.formatElapsed(Date.now() - stageStart)}`);
    this.logHuman(colors.dim(messages.getMessage('log.publishSubmitted', [communityName, jobId ?? 'unknown'])));

    const job: CommunityPublishJobResult = {
      name: communityName,
      jobId,
      status: result.status,
      timedOut: false,
      elapsedMs: 0,
    };

    if (poll && jobId) {
      stageStart = Date.now();
      this.spinner.start(messages.getMessage('spinner.start.waiting'));
      const pollResult = await this.pollBackgroundOperation(connection, jobId, pollInterval, pollTimeout);
      job.status = pollResult.status;
      job.timedOut = pollResult.timedOut;

      const waitLabel = pollResult.timedOut
        ? messages.getMessage('spinner.stop.waiting.timeout')
        : pollResult.status === 'Error'
        ? messages.getMessage('spinner.stop.waiting.error')
        : messages.getMessage('spinner.stop.waiting.complete');
      this.spinner.stop(`${waitLabel} ${this.formatElapsed(Date.now() - stageStart)}`);

      if (pollResult.timedOut) {
        this.warn(messages.getMessage('warning.pollTimeout', [communityName, jobId]));
      } else if (pollResult.status === 'Error') {
        this.warn(messages.getMessage('warning.pollError', [communityName, jobId]));
      }
    }

    job.elapsedMs = Date.now() - overallStart;
    const statusLabel = job.timedOut ? 'Timed Out' : job.status === 'Error' ? 'Failed' : 'Succeeded';
    const statusColor = job.timedOut ? colors.yellow : job.status === 'Error' ? colors.red : colors.green;
    this.logHuman('');
    this.logHuman(`${messages.getMessage('label.status')} ${colors.bold(statusColor(statusLabel))}`);
    this.logHuman(`${messages.getMessage('label.elapsed')} ${this.formatElapsed(job.elapsedMs)}`);
    this.logHuman('');

    return job;
  }

  /**
   * Polls the BackgroundOperation record for the given jobId at the given interval until its
   * Status reaches a terminal value (Completed/Complete or Error), or until the overall timeout
   * elapses, whichever happens first. The current status is streamed onto the active spinner
   * instead of printing a new log line per poll, to keep the output uncluttered.
   */
  private async pollBackgroundOperation(
    connection: Connection,
    jobId: string,
    interval: Duration,
    timeout: Duration
  ): Promise<PollResult> {
    const deadline = Date.now() + timeout.milliseconds;
    let status: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await connection.query<BackgroundOperationRecord>(
        `SELECT Id, Status FROM BackgroundOperation WHERE Id = '${jobId}'`
      );
      status = result.records?.[0]?.Status;
      this.spinner.status = messages.getMessage('spinner.status.polling', [status ?? 'Unknown']);

      if (status && TERMINAL_STATUSES.includes(status)) {
        return { status, timedOut: false };
      }
      if (Date.now() >= deadline) {
        return { status, timedOut: true };
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(interval);
    }
  }

  /**
   * Renders the final "Publish Results" summary table, one row per community, with a colored
   * Result column (green Succeeded / red Failed / yellow Timed Out).
   */
  private renderPublishResultsTable(jobs: CommunityPublishJobResult[]): void {
    this.logHuman('');
    this.table(
      jobs.map((job) => ({
        Name: job.name,
        JobId: job.jobId ?? '-',
        Status: job.status ?? '-',
        Result: this.formatResult(job),
      })),
      {
        Name: { header: 'NAME' },
        JobId: { header: 'JOB ID' },
        Status: { header: 'STATUS' },
        Result: { header: 'RESULT' },
      }
    );
  }

  /**
   * Formats a job's outcome as a colored label for display in the results table.
   */
  private formatResult(job: CommunityPublishJobResult): string {
    if (job.timedOut) {
      return colors.yellow('Timed Out');
    }
    if (job.status === 'Error') {
      return colors.red('Failed');
    }
    return colors.green('Succeeded');
  }

  /**
   * Formats a millisecond duration the same way "sf project retrieve start" does: plain
   * milliseconds under one second, otherwise seconds with two decimals (e.g. "4ms", "1.34s").
   */
  private formatElapsed(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  }

  /**
   * Logs a human-readable progress/status line, but only when --json is not in effect. The
   * command's return value (CommunityPublishResult) is what gets emitted as JSON output by the
   * SfCommand framework, so these narrative lines must be suppressed to keep --json output
   * clean and parseable (this.log() itself is not auto-suppressed by SfCommand, unlike
   * this.spinner/this.table/this.styledHeader).
   */
  private logHuman(message: string): void {
    if (!this.jsonEnabled()) {
      this.log(message);
    }
  }
}
// __________________________GenAI: Generated code ends here______________________________